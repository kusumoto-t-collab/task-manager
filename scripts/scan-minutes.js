#!/usr/bin/env node
/**
 * scan-minutes.js
 * PBGH議事録DBを走査し、楠元担当タスクを自動抽出してNotionタスクDBに登録する
 * GitHub Actions から毎朝実行される
 */

const NOTION_TOKEN      = process.env.NOTION_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const PAGE_URL          = process.env.PAGE_URL; // 指定時はこのページのみ再スキャン

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN が設定されていません');
  process.exit(1);
}

const NOTION_BASE      = 'https://api.notion.com';
const NOTION_VERSION   = '2022-06-28';
const MINUTES_DB_ID    = '286a452b-1aab-80a3-a954-ca0067f9f7c6';
const TASK_DB_ID       = '2a5a452b-1aab-80b4-aa40-e5b67f5bfa37';
const KUSUMOTO_USER_ID = '34dd872b-594c-814e-b814-00022734dcdc';

// ========================================
// Notion API ヘルパー
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
  if (!res.ok && res.status !== 200) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text}`);
  }
  return res.json();
}

async function queryDatabase(dbId, filter) {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/v1/databases/${dbId}/query`, body);
    if (!data.results) throw new Error(data.message || JSON.stringify(data));
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function getBlocks(blockId) {
  let results = [];
  let cursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('start_cursor', cursor);
    const data = await notionRequest('GET', `/v1/blocks/${blockId}/children?${params}`);
    if (!data.results) break;
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function getAllBlocksWithMeta(pageId, depth = 0) {
  if (depth > 5) return [];
  const blocks = [];
  const raw = await getBlocks(pageId);
  for (const b of raw) {
    const type = b.type;
    const content = b[type];
    const richText = content?.rich_text || [];
    const text = richText.map(r => r.plain_text).join('').trim();
    const mentionedUserIds = richText
      .filter(r => r.type === 'mention' && r.mention?.type === 'user')
      .map(r => r.mention.user.id);
    const checked = type === 'to_do' ? (content?.checked ?? false) : null;
    blocks.push({ text, type, checked, depth, mentionedUserIds });
    if (b.has_children) {
      const children = await getAllBlocksWithMeta(b.id, depth + 1);
      blocks.push(...children);
    }
  }
  return blocks;
}

// 既存タスクの「出典＋タスク名」一覧を取得（重複登録防止）
async function fetchExistingTaskKeys() {
  const pages = await queryDatabase(TASK_DB_ID);
  const keys = new Set();
  for (const p of pages) {
    const src = (p.properties['出典']?.rich_text || []).map(t => t.plain_text).join('').trim();
    const titleProp = Object.values(p.properties || {}).find(prop => prop.type === 'title');
    const name = titleProp
      ? (titleProp.title || []).map(t => t.plain_text).join('').trim()
      : '';
    if (src && name) keys.add(taskKey(src, name));
  }
  return keys;
}

function taskKey(source, name) {
  return `${source}||${name.replace(/\s/g, '')}`;
}

async function createTask(task) {
  const properties = {
    'タスク名': { title: [{ text: { content: task.name } }] },
    'ステータス': { status: { name: '未着手' } },
    '担当者': { people: [{ id: KUSUMOTO_USER_ID }] },
    '優先度': { select: { name: task.priority } },
    '法人':   { multi_select: [{ name: task.domain }] },
    '出典':   { rich_text: [{ text: { content: task.source } }] },
  };
  if (task.deadline) {
    properties['締切日'] = { date: { start: task.deadline } };
  }
  return notionRequest('POST', '/v1/pages', {
    parent: { database_id: TASK_DB_ID },
    properties,
  });
}

// ========================================
// タスク抽出ロジック（index.html と同一）
// ========================================

const KUSUMOTO_PATTERNS = [/楠元/, /楠本/, /kusumoto/i, /龍矢/];
const ACTION_SECTION_PATTERNS = [
  /アクション/i, /TODO/i, /To[\s-]?Do/i, /対応事項/, /宿題/,
  /Action[\s-]?Item/i, /タスク/, /次回アクション/, /担当/, /やること/,
];

function inferDomain(text) {
  if (/AIme|Shopify|EC|サイト|ローンチ|プロダクト|鎌形|LP|撮影|素材|動画|Prestige|事業計画|配送|倉庫/.test(text)) return 'プロダクト';
  if (/unique|サロン|AITOKYO|内装|是正|工事|中島|翼/.test(text)) return 'unique';
  if (/HD|役員|PBGH|Git|Notion|Slack|向井|権限|リスキリング|AIX|不動産|店舗開発/.test(text)) return 'PBGH';
  if (/採用|給与|労務|契約|総務|LS|顧問|雇用|内定|通知書|覚書|タグマネ/.test(text)) return '総務';
  return 'PBGH';
}

function inferPriority(text) {
  if (/緊急|至急|急ぎ|超重要|最優先|アラート|炎上|遅延|超過/.test(text)) return '高';
  if (/重要|早急|なるべく早く/.test(text)) return '高';
  if (/低優先|いつでも|余裕/.test(text)) return '低';
  return '中';
}

// 締切日の抽出
// 高信頼度のパターンのみ対応：
//   - 完全な日付: 2026/5/21, 2026年5月21日
//   - M/D + 期限マーカー: 「5/21まで」「期限：5/21」「5月21日締切」
// 「明日」「来週」等の相対表現は誤判定リスクが高いため対象外
function parseDeadline(text, baseDate = new Date()) {
  // パターン1: 完全な年月日（最も信頼できる）
  let m = text.match(/(20\d{2})[\/年\-](\d{1,2})[\/月\-](\d{1,2})日?/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidDate(y, mo, d)) return formatDate(y, mo, d);
  }

  // パターン2: M/D（期限マーカーが文中にある場合のみ採用）
  const hasMarker = /(まで|までに|〆切|締切|期限)/.test(text);
  if (!hasMarker) return null;

  m = text.match(/(\d{1,2})[\/月](\d{1,2})日?/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (!isValidDate(2000, mo, d)) return null; // 年は仮で形だけチェック
    const year = baseDate.getFullYear();
    const candidate = new Date(year, mo - 1, d);
    // 30日以上過去なら来年と判断
    const grace = 30 * 86400000;
    if (candidate.getTime() < baseDate.getTime() - grace) {
      return formatDate(year + 1, mo, d);
    }
    return formatDate(year, mo, d);
  }

  return null;
}

function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function formatDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function cleanTaskName(line) {
  return line
    .replace(/[\s　]*楠元[\s　]*$/g, '')
    .replace(/^楠元[\s　]*[：:]\s*/g, '')
    .replace(/楠元[\s　]*(が|は|も|に|の|さん)/g, '')
    .replace(/[\s　]*楠本[\s　]*$/g, '')        // AI誤字「楠本」
    .replace(/^楠本[\s　]*[：:]\s*/g, '')
    .replace(/楠本[\s　]*(が|は|も|に|の|さん)/g, '')
    .replace(/kusumoto[\s　]*/gi, '')
    .replace(/龍矢[\s　]*/g, '')
    .replace(/^[\[\]☐☑✓✔\s　]+/, '')
    .replace(/^[・\-\*▶→►＞>\s　]+/, '')
    .replace(/[、。\s　]+$/g, '')
    .trim();
}

function extractKusumotoTasks(blocks, sourceName) {
  const extracted = [];
  const seen = new Set();
  let inActionSection = false;

  for (const block of blocks) {
    const { text, type, checked, mentionedUserIds } = block;

    if (['heading_1', 'heading_2', 'heading_3'].includes(type)) {
      inActionSection = ACTION_SECTION_PATTERNS.some(p => p.test(text));
      if (!KUSUMOTO_PATTERNS.some(p => p.test(text))) continue;
      // 見出しに楠元/楠本が含まれる場合は以降でタスクとして処理
    }

    if (type === 'to_do' && checked === true) continue;

    const isMentioned = mentionedUserIds?.includes(KUSUMOTO_USER_ID);
    const isKusumoto = isMentioned || KUSUMOTO_PATTERNS.some(p => p.test(text));
    const isUncheckedTodo = type === 'to_do' && checked === false;
    const inActionBullet = inActionSection &&
      (isUncheckedTodo || ['bulleted_list_item', 'numbered_list_item'].includes(type));

    if (!isKusumoto && !inActionBullet) continue;
    if (!text || text.length < 4) continue;

    let name = cleanTaskName(text);
    if (!name || name.length < 2) continue;
    // 「決定事項：」プレフィックスを除去
    name = name.replace(/^決定事項[：:]\s*/, '').replace(/^アクションアイテム[：:]\s*/, '').trim();
    if (!name || name.length < 2) continue;

    const key = name.replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    const deadline = parseDeadline(text);

    extracted.push({
      name,
      source: sourceName,
      priority: inferPriority(text),
      domain: inferDomain(name),
      deadline,
    });
  }

  return extracted;
}

// ========================================
// Slack 通知
// ========================================

async function sendSlack(scannedPages, results) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ');
    return;
  }

  const now = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const totalTasks = results.reduce((s, r) => s + r.addedCount, 0);

  let text;
  if (scannedPages === 0) {
    text = `ℹ️ *議事録スキャン完了* | ${now}\n新着議事録はありませんでした`;
  } else {
    const lines = [
      `✅ *議事録スキャン完了* | ${now}`,
      ``,
      `📋 *${scannedPages}件の議事録を確認 → ${totalTasks}件のタスクを追加しました*`,
      ``,
      `📄 処理した議事録：`,
    ];
    for (const r of results) {
      const label = r.skipped ? ' _(スキップ: 処理済み)_' : ` → ${r.addedCount}件追加`;
      lines.push(`• ${r.title}${label}`);
    }
    text = lines.join('\n');
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) console.warn(`Slack通知失敗: ${res.status}`);
}

// ========================================
// メイン処理
// ========================================

function extractPageIdFromUrl(url) {
  // Notion URLの末尾の32文字のID部分を抽出してハイフン区切りに整形
  const match = url.match(/([0-9a-f]{32})(?:[?#]|$)/i);
  if (!match) throw new Error(`URLからページIDを抽出できませんでした: ${url}`);
  const id = match[1];
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

async function main() {
  const manualMode = !!PAGE_URL;

  let targetPages;
  if (manualMode) {
    const pageId = extractPageIdFromUrl(PAGE_URL);
    console.log(`手動モード: 指定ページのみスキャン (${pageId})`);
    const page = await notionRequest('GET', `/v1/pages/${pageId}`);
    targetPages = [page];
  } else {
    // 過去25時間以内に作成されたページを対象（1時間のバッファ込み）
    const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    console.log(`スキャン対象: ${since} 以降に作成された議事録`);
    targetPages = await queryDatabase(MINUTES_DB_ID, {
      timestamp: 'created_time',
      created_time: { on_or_after: since },
    });
  }

  const existingTaskKeys = await fetchExistingTaskKeys();

  console.log(`対象議事録: ${targetPages.length} 件`);

  if (targetPages.length === 0) {
    await sendSlack(0, []);
    return;
  }

  const results = [];

  for (const page of targetPages) {
    const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
    const title = titleProp
      ? (titleProp.title || []).map(t => t.plain_text).join('').trim()
      : 'タイトルなし';

    console.log(`\n処理中: 「${title}」`);

    try {
      const blocks = await getAllBlocksWithMeta(page.id);
      const tasks = extractKusumotoTasks(blocks, title);
      console.log(`  → ${tasks.length} 件のタスクを検出`);

      let addedCount = 0;
      for (const task of tasks) {
        // タスク単位で重複チェック
        if (existingTaskKeys.has(taskKey(task.source, task.name))) {
          console.log(`    - スキップ（既に登録済み）: ${task.name}`);
          continue;
        }
        await createTask(task);
        existingTaskKeys.add(taskKey(task.source, task.name));
        addedCount++;
        console.log(`    ✓ 追加: ${task.name}`);
        await new Promise(r => setTimeout(r, 350)); // レート制限対策
      }

      results.push({ title, addedCount, skipped: false });
    } catch (e) {
      console.error(`  ✗ エラー: ${e.message}`);
      results.push({ title, addedCount: 0, skipped: false, error: true });
    }
  }

  await sendSlack(targetPages.length, results);
  console.log('\n完了');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
