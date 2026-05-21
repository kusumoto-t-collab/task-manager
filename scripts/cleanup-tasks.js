#!/usr/bin/env node
/**
 * cleanup-tasks.js
 * 既存タスクを一括クリーンアップ：
 *  ・タスク名のスリム化（末尾動詞、括弧書き、コロン区切りの状況を除去）
 *  ・除去した状況・括弧内容をメモ（説明）へ移動
 *  ・出典に紐づく議事録本文から関連文脈を抽出してメモに補強
 *  ・テキストからステータス（進行中／保留／アラート）を推定
 *
 * DRY_RUN=true で変更内容のログのみ。false（デフォルト）で Notion へ反映。
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY_RUN      = process.env.DRY_RUN === 'true';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN が設定されていません');
  process.exit(1);
}

const NOTION_BASE    = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';
const TASK_DB_ID     = '2a5a452b-1aab-80b4-aa40-e5b67f5bfa37';
const MINUTES_DB_ID  = '286a452b-1aab-80a3-a954-ca0067f9f7c6';

// ========================================
// Notion API
// ========================================

async function notionRequest(method, path, body) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

async function queryAll(dbId) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/v1/databases/${dbId}/query`, body);
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function fetchBlocks(blockId) {
  let results = [];
  let cursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const data = await notionRequest('GET', `/v1/blocks/${blockId}/children?${params}`);
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ページ内の全テキストブロック（テキストだけ抽出）
async function getPageText(pageId) {
  const lines = [];
  async function traverse(id, depth = 0) {
    if (depth > 5) return;
    const blocks = await fetchBlocks(id);
    for (const b of blocks) {
      const content = b[b.type];
      const text = (content?.rich_text || []).map(r => r.plain_text).join('').trim();
      if (text) lines.push(text);
      if (b.has_children) await traverse(b.id, depth + 1);
    }
  }
  await traverse(pageId);
  return lines;
}

// ========================================
// ヘルパー
// ========================================

function getTitle(page) {
  const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
  return titleProp ? (titleProp.title || []).map(t => t.plain_text).join('').trim() : '';
}

function getRichText(page, name) {
  return (page.properties[name]?.rich_text || []).map(t => t.plain_text).join('').trim();
}

function getStatus(page) {
  return page.properties['ステータス']?.status?.name || '';
}

// ========================================
// クリーンアップロジック
// ========================================

// タスク名から「：」や「（〜）」で区切られた状況テキストを分離
function splitNameAndContext(name) {
  let core = name;
  const contexts = [];

  // 「：」「:」 で区切られる場合（後半が説明的）
  const colonMatch = core.match(/^(.+?)[：:](.+)$/);
  if (colonMatch && colonMatch[2].length >= 4) {
    core = colonMatch[1].trim();
    contexts.push(colonMatch[2].trim());
  }

  // 括弧書きの中身が長い（10文字以上）場合はメモへ
  core = core.replace(/（([^（）]{10,})）/g, (_, inner) => {
    contexts.push(inner.trim());
    return '';
  }).replace(/\(([^()]{10,})\)/g, (_, inner) => {
    contexts.push(inner.trim());
    return '';
  });

  return { core: core.trim(), contexts };
}

// 末尾の動詞句を除去
function trimVerbs(name) {
  return name
    .replace(/を(?:完了|実施|実行|達成|確認|進行|対応|処理|登録|更新|設定|整理|作成|送付|提出|報告|連絡|依頼|回収|取得|展開|共有|準備|手配|発注|構築|整備|改修|修正|改善)(?:する|させる|行う|します)?$/, '')
    .replace(/の(?:作成|送付|提出|報告|連絡|依頼|展開|共有|準備|手配|発注|確認|登録|更新|設定|整理|回収|取得)$/, '')
    .replace(/(?:する|します|行う|進める|対応する|対応します|行います)$/, '')
    .replace(/[、。\s　]+$/g, '')
    .trim();
}

// テキストからステータスを推定（未着手のみ書き換え対象）
function inferStatus(currentStatus, allText) {
  if (currentStatus !== '未着手' && currentStatus !== '') return null;
  if (/アラート|炎上|遅延|超過|やばい|ヤバい/.test(allText)) return 'アラート';
  if (/進行中|着手中|対応中|稼働中|作業中/.test(allText)) return '進行中';
  if (/保留|ペンディング|pending/i.test(allText)) return '保留';
  return null;
}

// 出典文字列から「日付」「会議名キーワード」を取り出す
// 例: "プロダクト定例（5/19）" → { keyword: "プロダクト定例", date: "5/19" }
function parseSource(source) {
  const dateMatch = source.match(/(\d{1,2})[\/月](\d{1,2})/);
  const date = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}` : null;
  const keyword = source.replace(/[（(].*?[)）]/g, '').trim();
  return { keyword, date };
}

// タスク名から「キーノード」を取り出して議事録テキスト内で検索
function pickKeyNouns(name) {
  // 4文字以上の連続したカタカナ・漢字・英字をキーとして抽出
  const matches = name.match(/[A-Za-z0-9ぁ-んァ-ヴー一-龥]{3,}/g) || [];
  // 助詞・一般名詞を除外
  const stopwords = ['する', 'こと', 'もの', 'ため', '関する', 'について', 'および'];
  return matches.filter(m => !stopwords.includes(m)).slice(0, 4);
}

// 議事録本文から、タスクに関連する文脈行を抽出
function extractRelevantLines(lines, keyNouns) {
  if (keyNouns.length === 0) return [];
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const score = keyNouns.reduce((s, k) => s + (line.includes(k) ? 1 : 0), 0);
    if (score >= 1) {
      // 前後1行を含めて取得
      const around = [];
      if (i > 0 && lines[i-1].length < 200) around.push(lines[i-1]);
      around.push(line);
      if (i < lines.length-1 && lines[i+1].length < 200) around.push(lines[i+1]);
      hits.push({ score, text: around.join(' / ') });
    }
  }
  // スコア順でユニーク化、上位3件
  const seen = new Set();
  return hits
    .sort((a, b) => b.score - a.score)
    .filter(h => { if (seen.has(h.text)) return false; seen.add(h.text); return true; })
    .slice(0, 3)
    .map(h => h.text);
}

// ========================================
// メイン処理
// ========================================

async function main() {
  console.log(`=== タスククリーンアップ${DRY_RUN ? '（DRY RUN）' : ''} ===`);

  console.log('議事録一覧を取得中...');
  const minutes = await queryAll(MINUTES_DB_ID);
  console.log(`議事録: ${minutes.length}件`);

  console.log('タスク一覧を取得中...');
  const tasks = await queryAll(TASK_DB_ID);
  console.log(`タスク: ${tasks.length}件`);

  // 議事録のテキスト本文を遅延ロード用キャッシュ
  const minutesTextCache = new Map();

  async function getMinutesTextFor(sourceText) {
    if (!sourceText) return null;
    const { keyword, date } = parseSource(sourceText);
    // 議事録タイトルを部分一致で検索
    const candidate = minutes.find(p => {
      const title = getTitle(p);
      if (!title) return false;
      if (keyword && title.includes(keyword.slice(0, 4))) {
        if (!date) return true;
        return title.includes(date);
      }
      return false;
    });
    if (!candidate) return null;
    if (minutesTextCache.has(candidate.id)) return minutesTextCache.get(candidate.id);
    try {
      const lines = await getPageText(candidate.id);
      minutesTextCache.set(candidate.id, lines);
      return lines;
    } catch (e) {
      console.warn(`議事録読み込み失敗: ${candidate.id}: ${e.message}`);
      minutesTextCache.set(candidate.id, null);
      return null;
    }
  }

  let changedCount = 0;
  let skippedCount = 0;
  const summary = [];

  for (const task of tasks) {
    const origName   = getTitle(task);
    const origNote   = getRichText(task, '説明');
    const origStatus = getStatus(task);
    const source     = getRichText(task, '出典');

    if (!origName) { skippedCount++; continue; }
    if (origStatus === '完了') { skippedCount++; continue; }

    // 1) 名前のスリム化
    const { core, contexts } = splitNameAndContext(origName);
    const trimmedName = trimVerbs(core);
    const newName = trimmedName || core || origName;

    // 2) メモの構築
    const noteParts = [];
    if (origNote) noteParts.push(origNote);
    for (const c of contexts) {
      if (!noteParts.some(p => p.includes(c))) noteParts.push(c);
    }

    // 3) 議事録本文から関連文脈を抽出
    const minutesLines = await getMinutesTextFor(source);
    let minutesContext = '';
    if (minutesLines && minutesLines.length > 0) {
      const keys = pickKeyNouns(newName);
      const relevant = extractRelevantLines(minutesLines, keys);
      if (relevant.length > 0) {
        minutesContext = relevant.join('\n').slice(0, 400);
        const stamp = `📝 議事録より:\n${minutesContext}`;
        if (!noteParts.some(p => p.includes('議事録より'))) {
          noteParts.push(stamp);
        }
      }
    }

    const newNote = noteParts.join('\n\n').trim();

    // 4) ステータスの推定
    const allText = `${origName} ${origNote} ${minutesContext}`;
    const newStatus = inferStatus(origStatus, allText);

    // 5) 変更が無ければスキップ
    const nameChanged   = newName !== origName;
    const noteChanged   = newNote !== origNote;
    const statusChanged = newStatus && newStatus !== origStatus;

    if (!nameChanged && !noteChanged && !statusChanged) {
      skippedCount++;
      continue;
    }

    changedCount++;
    summary.push({
      id: task.id,
      origName, newName,
      origNote, newNote,
      origStatus, newStatus,
      nameChanged, noteChanged, statusChanged,
    });

    console.log(`\n--- [${changedCount}] ${origName}`);
    if (nameChanged)   console.log(`  名前: ${origName}\n     → ${newName}`);
    if (statusChanged) console.log(`  状態: ${origStatus} → ${newStatus}`);
    if (noteChanged) {
      const oldPrev = (origNote || '(空)').slice(0, 60);
      const newPrev = newNote.slice(0, 120);
      console.log(`  メモ: ${oldPrev}\n     → ${newPrev}`);
    }

    // 6) Notion へ反映（DRY_RUN でなければ）
    if (!DRY_RUN) {
      const properties = {};
      if (nameChanged)   properties['タスク名'] = { title: [{ text: { content: newName } }] };
      if (noteChanged)   properties['説明']     = { rich_text: [{ text: { content: newNote.slice(0, 1900) } }] };
      if (statusChanged) properties['ステータス'] = { status: { name: newStatus } };
      try {
        await notionRequest('PATCH', `/v1/pages/${task.id}`, { properties });
      } catch (e) {
        console.error(`  ❌ 更新失敗: ${e.message}`);
      }
    }
  }

  console.log(`\n=== 結果 ===`);
  console.log(`変更対象: ${changedCount}件 / スキップ: ${skippedCount}件 / 合計: ${tasks.length}件`);
  if (DRY_RUN) console.log('※ DRY RUNのため Notion への反映はしていません');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
