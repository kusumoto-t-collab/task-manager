#!/usr/bin/env node
/**
 * weekly-report.js
 * 楠元タスクDBから先週の振り返りと今週の状況をSlackに通知する
 * GitHub Actions から毎週月曜朝に実行される
 */

const NOTION_TOKEN      = process.env.NOTION_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN が設定されていません');
  process.exit(1);
}

const NOTION_BASE    = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';
const TASK_DB_ID     = '2a5a452b-1aab-80b4-aa40-e5b67f5bfa37';

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

async function queryAllTasks() {
  let results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionRequest('POST', `/v1/databases/${TASK_DB_ID}/query`, body);
    if (!data.results) throw new Error(data.message || JSON.stringify(data));
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ========================================
// ヘルパー
// ========================================

function getTitle(page) {
  const titleProp = Object.values(page.properties || {}).find(p => p.type === 'title');
  return titleProp ? (titleProp.title || []).map(t => t.plain_text).join('').trim() : '';
}

function getStatus(page) {
  return page.properties['ステータス']?.status?.name || '';
}

function getDeadline(page) {
  return page.properties['締切日']?.date?.start || null;
}

function getPriority(page) {
  return page.properties['優先度']?.select?.name || '';
}

function todayJST() {
  const now = new Date();
  // JST = UTC+9
  const jst = new Date(now.getTime() + 9 * 3600000);
  return jst.toISOString().slice(0, 10);
}

// ========================================
// レポート生成
// ========================================

function buildReport(tasks) {
  const today = todayJST();
  const todayDate = new Date(today);
  const weekAgo = new Date(todayDate);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekEnd = new Date(todayDate);
  weekEnd.setDate(weekEnd.getDate() + 7);

  // 先週完了したタスク（last_edited_time が先週内 かつ ステータス=完了）
  const completedLastWeek = tasks.filter(t => {
    if (getStatus(t) !== '完了') return false;
    const edited = new Date(t.last_edited_time);
    return edited >= weekAgo && edited <= todayDate;
  });

  // 現在進行中・未着手
  const active = tasks.filter(t => {
    const s = getStatus(t);
    return s !== '完了' && s !== '保留' && s !== '却下' && s !== '';
  });

  // 期限超過（締切日が今日より前 かつ 未完了）
  const overdue = active.filter(t => {
    const d = getDeadline(t);
    return d && d < today;
  });

  // 今週期限（締切日が今日〜7日後）
  const dueThisWeek = active.filter(t => {
    const d = getDeadline(t);
    return d && d >= today && d <= weekEnd.toISOString().slice(0, 10);
  });

  return { completedLastWeek, active, overdue, dueThisWeek };
}

function formatTaskLine(t) {
  const name = getTitle(t);
  const deadline = getDeadline(t);
  const prio = getPriority(t);
  const parts = [];
  if (prio === '高') parts.push('🔴');
  if (deadline) parts.push(`〆${deadline.slice(5)}`);
  parts.push(name);
  return '  • ' + parts.join(' ');
}

function buildSlackMessage(report) {
  const now = new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric', day: 'numeric',
  });

  const lines = [
    `📊 *週次レポート* | ${now}`,
    ``,
    `✅ *先週完了したタスク*: ${report.completedLastWeek.length}件`,
  ];

  if (report.completedLastWeek.length > 0) {
    const top = report.completedLastWeek.slice(0, 10);
    for (const t of top) {
      lines.push(`  • ${getTitle(t)}`);
    }
    if (report.completedLastWeek.length > 10) {
      lines.push(`  ...他 ${report.completedLastWeek.length - 10} 件`);
    }
  }

  lines.push(``, `📋 *残タスク*: ${report.active.length}件`);

  if (report.overdue.length > 0) {
    lines.push(``, `⚠️ *期限超過*: ${report.overdue.length}件`);
    for (const t of report.overdue.slice(0, 10)) {
      lines.push(formatTaskLine(t));
    }
    if (report.overdue.length > 10) {
      lines.push(`  ...他 ${report.overdue.length - 10} 件`);
    }
  }

  if (report.dueThisWeek.length > 0) {
    lines.push(``, `📅 *今週期限*: ${report.dueThisWeek.length}件`);
    for (const t of report.dueThisWeek.slice(0, 10)) {
      lines.push(formatTaskLine(t));
    }
    if (report.dueThisWeek.length > 10) {
      lines.push(`  ...他 ${report.dueThisWeek.length - 10} 件`);
    }
  }

  return lines.join('\n');
}

async function sendSlack(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ');
    console.log('--- レポート内容 ---');
    console.log(text);
    return;
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
  console.log('週次レポート生成開始');
  const tasks = await queryAllTasks();
  console.log(`タスク総数: ${tasks.length}件`);

  const report = buildReport(tasks);
  console.log(`先週完了: ${report.completedLastWeek.length}件`);
  console.log(`残タスク: ${report.active.length}件`);
  console.log(`期限超過: ${report.overdue.length}件`);
  console.log(`今週期限: ${report.dueThisWeek.length}件`);

  const message = buildSlackMessage(report);
  await sendSlack(message);
  console.log('完了');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
