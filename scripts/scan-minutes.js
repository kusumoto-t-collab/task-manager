#!/usr/bin/env node
/**
 * scan-minutes.js
 * PBGH議事録DBを走査し、楠元担当タスクを自動抽出してNotionタスクDBに登録する
 * GitHub Actions から毎朝実行される
 */

const NOTION_TOKEN      = process.env.NOTION_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

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
    const text = (content?.rich_text || []).map(r => r.plain_text).join('').trim();
    const checked = type === 'to_do' ? (content?.checked ?? false) : null;
    blocks.push({ text, type, checked, depth });
    if (b.has_children) {
      const children = await getAllBlocksWithMeta(b.id, depth + 1);
      blocks.push(...children);
    }
  }
  return blocks;
}

// 既存タスクの出典一覧を取得（重複登録防止）
async function fetchExistingSources() {
  const pages = await queryDatabase(TASK_DB_ID);
  const sources = new Set();
  for (const p of pages) {
    const src = (p.properties['出典']?.rich_text || []).map(t => t.plain_text).join('').trim();
    if (src) sources.add(src);
  }
  return sources;
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

const KUSUMOTO_PATTERNS = [/楠元/, /kusumoto/i, /龍矢/];
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

function cleanTaskName(line) {
  return line
    .replace(/[\s　]*楠元[\s　]*$/g, '')
    .replace(/^楠元[\s　]*[：:]\s*/g, '')
    .replace(/楠元[\s　]*(が|は|も|に|の|さん)/g, '')
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
    const { text, type, checked } = block;

    if (['heading_1', 'heading_2', 'heading_3'].includes(type)) {
      inActionSection = ACTION_SECTION_PATTERNS.some(p => p.test(text));
      continue;
    }

    if (type === 'to_do' && checked === true) continue;

    const isKusumoto = KUSUMOTO_PATTERNS.some(p => p.test(text));
    const isUncheckedTodo = type === 'to_do' && checked === false;
    const inActionBullet = inActionSection &&
      (isUncheckedTodo || ['bulleted_list_item', 'numbered_list_item'].includes(type));

    if (!isKusumoto && !inActionBullet) continue;
    if (!text || text.length < 4) continue;

    const name = cleanTaskName(text);
    if (!name || name.length < 2) continue;

    const key = name.replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    extracted.push({
      name,
      source: sourceName,
      priority: inferPriority(text),
      domain: inferDomain(name),
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

async function main() {
  // 過去25時間以内に作成されたページを対象（1時間のバッファ込み）
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  console.log(`スキャン対象: ${since} 以降に作成された議事録`);

  const [newPages, existingSources] = await Promise.all([
    queryDatabase(MINUTES_DB_ID, {
      timestamp: 'created_time',
      created_time: { on_or_after: since },
    }),
    fetchExistingSources(),
  ]);

  console.log(`新着議事録: ${newPages.length} 件`);

  if (newPages.length === 0) {
    await sendSlack(0, []);
    return;
  }

  const results = [];

  for (const page of newPages) {
    const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
    const title = titleProp
      ? (titleProp.title || []).map(t => t.plain_text).join('').trim()
      : 'タイトルなし';

    console.log(`\n処理中: 「${title}」`);

    // 同じ出典のタスクが既にあればスキップ（重複登録防止）
    if (existingSources.has(title)) {
      console.log(`  → スキップ（処理済み）`);
      results.push({ title, addedCount: 0, skipped: true });
      continue;
    }

    try {
      const blocks = await getAllBlocksWithMeta(page.id);
      const tasks = extractKusumotoTasks(blocks, title);
      console.log(`  → ${tasks.length} 件のタスクを検出`);

      for (const task of tasks) {
        await createTask(task);
        console.log(`    ✓ 追加: ${task.name}`);
        await new Promise(r => setTimeout(r, 350)); // レート制限対策
      }

      results.push({ title, addedCount: tasks.length, skipped: false });
    } catch (e) {
      console.error(`  ✗ エラー: ${e.message}`);
      results.push({ title, addedCount: 0, skipped: false, error: true });
    }
  }

  await sendSlack(newPages.length, results);
  console.log('\n完了');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
