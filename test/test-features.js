// テスト用スクリプト：jsdomでindex.htmlを読み込み、新機能の動作を検証
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

// シリアル化テスト用のlocalStorage
class LocalStorageMock {
  constructor() { this.store = {}; }
  getItem(k) { return this.store[k] ?? null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
  clear() { this.store = {}; }
}

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ❌ ${name}\n     → ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || '失敗'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} 期待:${JSON.stringify(b)} 実際:${JSON.stringify(a)}`); }

(async () => {
  console.log('=== タスク管理ダッシュボード テスト開始 ===\n');

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: 'usable',
    beforeParse(window) {
      window.localStorage = new LocalStorageMock();
      window.sessionStorage = new LocalStorageMock();
      window.fetch = async () => ({ ok: true, json: async () => ({ results: [], has_more: false }) });
      window.crypto = {
        subtle: { digest: async () => new ArrayBuffer(32) },
        getRandomValues: arr => arr,
      };
      window.confirm = () => true;
      window.alert = () => {};
    },
  });
  // 初期描画を待つ
  await new Promise(r => setTimeout(r, 600));

  const { window } = dom;
  const { document } = window;

  // ============ 1. 構造テスト ============
  console.log('\n【1. UI構造】');
  test('グローバルステータスバーがDOMに存在', () => {
    assert(document.getElementById('global-status-bar'), 'global-status-bar 要素なし');
    assert(document.getElementById('gs-icon'), 'gs-icon 要素なし');
    assert(document.getElementById('gs-title'), 'gs-title 要素なし');
    assert(document.getElementById('gs-detail'), 'gs-detail 要素なし');
  });
  test('📋 ログタブのボタンが存在', () => {
    const btn = document.getElementById('tab-log-btn');
    assert(btn, 'tab-log-btn なし');
    assert(btn.textContent.includes('ログ'), 'ログという文字列がない');
  });
  test('ログタブのコンテンツ領域が存在', () => {
    assert(document.getElementById('tab-log'), 'tab-log なし');
    assert(document.getElementById('activity-log-list'), 'activity-log-list なし');
  });
  test('新着通知バナーが存在', () => {
    assert(document.getElementById('inbox-banner'), 'inbox-banner なし');
    assert(document.getElementById('inbox-banner-msg'), 'inbox-banner-msg なし');
  });
  test('🔔 新着タスクフィルターが存在', () => {
    assert(document.getElementById('fc-new-btn'), 'fc-new-btn なし');
    assert(document.getElementById('fc-new'), 'fc-new なし');
  });
  test('議事録URLタブにプログレスバーが存在', () => {
    assert(document.getElementById('extract-progress'), 'extract-progress なし');
    assert(document.getElementById('extract-progress-fill'), 'extract-progress-fill なし');
    assert(document.getElementById('extract-progress-text'), 'extract-progress-text なし');
  });

  // ============ 2. JS関数の存在確認 ============
  console.log('\n【2. JavaScript関数】');
  test('logActivity関数が定義されている', () => {
    assertEq(typeof window.logActivity, 'function', 'logActivity未定義');
  });
  test('setGlobalStatus関数が定義されている', () => {
    assertEq(typeof window.setGlobalStatus, 'function', 'setGlobalStatus未定義');
  });
  test('setExtractProgress関数が定義されている', () => {
    assertEq(typeof window.setExtractProgress, 'function', 'setExtractProgress未定義');
  });
  test('showInboxBanner / dismissInboxBanner / viewNewTasks', () => {
    assertEq(typeof window.showInboxBanner, 'function');
    assertEq(typeof window.dismissInboxBanner, 'function');
    assertEq(typeof window.viewNewTasks, 'function');
  });
  test('renderActivityLog / clearActivityLog', () => {
    assertEq(typeof window.renderActivityLog, 'function');
    assertEq(typeof window.clearActivityLog, 'function');
  });
  test('switchTab関数が定義されている', () => {
    assertEq(typeof window.switchTab, 'function');
  });

  // ============ 3. logActivity 動作（DOMとlocalStorage経由で検証） ============
  console.log('\n【3. アクティビティログ】');
  // まずクリア
  window.localStorage.removeItem('kusumoto-activity-log');
  window.clearActivityLog && window.clearActivityLog();

  test('logActivity呼び出しでlocalStorageに保存される', () => {
    window.logActivity({ type: 'notion-page', title: 'テスト議事録', taskCount: 3, detail: 'タスクA、タスクB' });
    const saved = JSON.parse(window.localStorage.getItem('kusumoto-activity-log') || '[]');
    assert(saved.length >= 1, '保存されてない');
    assertEq(saved[0].title, 'テスト議事録');
    assertEq(saved[0].taskCount, 3);
  });
  test('0件のログも記録される（DOMで確認）', () => {
    window.logActivity({ type: 'notion-page', title: '0件議事録', taskCount: 0 });
    window.renderActivityLog();
    const list = document.getElementById('activity-log-list').innerHTML;
    assert(list.includes('0件議事録'), 'タイトルがDOMにない');
    assert(list.includes('0件（タスクなし）'), '0件表示がない');
  });
  test('エラーログも記録される（entry-errorクラスで確認）', () => {
    window.logActivity({ type: 'notion-page', title: 'エラーページ', taskCount: 0, detail: 'API失敗', isError: true });
    window.renderActivityLog();
    const list = document.getElementById('activity-log-list').innerHTML;
    assert(list.includes('エラーページ'), 'タイトルがDOMにない');
    assert(list.includes('entry-error'), 'エラークラスがない');
    assert(list.includes('API失敗'), 'detail表示がない');
  });
  test('localStorageに3件以上永続化されている', () => {
    const saved = JSON.parse(window.localStorage.getItem('kusumoto-activity-log') || '[]');
    assert(saved.length >= 3, '保存件数が想定より少ない: ' + saved.length);
  });
  test('renderActivityLogでDOMに反映される', () => {
    window.renderActivityLog();
    const list = document.getElementById('activity-log-list');
    assert(list.innerHTML.includes('activity-entry'), 'activity-entryクラスが描画されてない');
  });
  test('カウント別CSSクラスが3種類とも出現する', () => {
    window.localStorage.removeItem('kusumoto-activity-log');
    window.clearActivityLog();
    window.logActivity({ type: 'notion-page', title: 'OK',   taskCount: 5 });
    window.logActivity({ type: 'notion-page', title: 'ZERO', taskCount: 0 });
    window.logActivity({ type: 'notion-page', title: 'ERR',  taskCount: 0, isError: true });
    window.renderActivityLog();
    const html = document.getElementById('activity-log-list').innerHTML;
    assert(html.includes('entry-ok'),    'entry-okクラスがない');
    assert(html.includes('entry-zero'),  'entry-zeroクラスがない');
    assert(html.includes('entry-error'), 'entry-errorクラスがない');
    assert(html.includes('cnt-added'),   'cnt-addedクラスがない');
    assert(html.includes('cnt-zero'),    'cnt-zeroクラスがない');
    assert(html.includes('cnt-err'),     'cnt-errクラスがない');
  });
  test('clearActivityLogで全消去・localStorageも空に', () => {
    window.clearActivityLog();
    const saved = JSON.parse(window.localStorage.getItem('kusumoto-activity-log') || '[]');
    assertEq(saved.length, 0, '消えてない');
  });
  test('空のログだと「ログがありません」と表示される', () => {
    window.renderActivityLog();
    const list = document.getElementById('activity-log-list');
    assert(list.innerHTML.includes('まだ処理ログがありません'), 'empty文言なし');
  });

  // ============ 4. グローバルステータスバー ============
  console.log('\n【4. グローバルステータスバー】');
  test('processing状態で表示される', () => {
    window.setGlobalStatus('処理中', '読み込み中', 'processing');
    const bar = document.getElementById('global-status-bar');
    assert(bar.className.includes('processing'), 'processingクラスがない');
    assertEq(document.getElementById('gs-title').textContent, '処理中');
    assertEq(document.getElementById('gs-detail').textContent, '読み込み中');
  });
  test('ok状態で done-ok クラスが付く', () => {
    window.setGlobalStatus('完了', '3件追加', 'ok');
    const bar = document.getElementById('global-status-bar');
    assert(bar.className.includes('done-ok'), 'done-okクラスがない');
  });
  test('error状態で done-err クラスが付く', () => {
    window.setGlobalStatus('失敗', 'API error', 'error');
    const bar = document.getElementById('global-status-bar');
    assert(bar.className.includes('done-err'), 'done-errクラスがない');
  });
  test('null指定で非表示になる', () => {
    window.setGlobalStatus(null, null, null);
    const bar = document.getElementById('global-status-bar');
    assert(!bar.className.includes('processing'), '残ってる');
    assert(!bar.className.includes('done-ok'), '残ってる');
    assert(!bar.className.includes('done-err'), '残ってる');
  });

  // ============ 5. プログレスバー ============
  console.log('\n【5. プログレスバー】');
  test('setExtractProgress(50, text)で50%表示', () => {
    window.setExtractProgress(50, 'テスト');
    const el = document.getElementById('extract-progress');
    assertEq(el.style.display, 'block');
    assertEq(document.getElementById('extract-progress-fill').style.width, '50%');
    assertEq(document.getElementById('extract-progress-text').textContent, 'テスト');
  });
  test('setExtractProgress(null)で非表示', () => {
    window.setExtractProgress(null);
    assertEq(document.getElementById('extract-progress').style.display, 'none');
  });

  // ============ 6. 新着通知バナー ============
  console.log('\n【6. 新着通知バナー】');
  test('showInboxBannerでバナー表示', () => {
    window.showInboxBanner(5, ['タスクA', 'タスクB']);
    const banner = document.getElementById('inbox-banner');
    assertEq(banner.style.display, 'flex');
    assert(document.getElementById('inbox-banner-msg').innerHTML.includes('5件'), '件数が含まれてない');
  });
  test('localStorageに保存される', () => {
    const saved = window.localStorage.getItem('inbox-notification');
    assert(saved, '保存されてない');
    const parsed = JSON.parse(saved);
    assertEq(parsed.count, 5);
  });
  test('dismissInboxBannerでバナー非表示・localStorage削除', () => {
    window.dismissInboxBanner();
    assertEq(document.getElementById('inbox-banner').style.display, 'none');
    assertEq(window.localStorage.getItem('inbox-notification'), null);
  });

  // ============ 7. 新着フィルター ============
  console.log('\n【7. 新着フィルター】');
  test('新着フィルター: 直接フィルタを切り替えるとラベルが変わる', () => {
    const btn = document.getElementById('fc-new-btn');
    window.setFilter('new', btn);
    const label = document.getElementById('filter-label').textContent;
    assert(label.includes('新着'), 'ラベルが切り替わらない: ' + label);
  });
  test('updateFilterCountsを呼ぶと fc-new に数字が入る', () => {
    window.updateFilterCounts();
    const fcNew = document.getElementById('fc-new').textContent;
    assert(/^\d+$/.test(fcNew), 'fc-newに数字が入ってない: ' + fcNew);
  });
  test('viewNewTasks呼び出しでフィルタラベルが新着に切り替わる', () => {
    // 全タブに戻してから
    const btn = document.getElementById('fc-new-btn');
    window.viewNewTasks();
    const label = document.getElementById('filter-label').textContent;
    assert(label.includes('新着'), 'viewNewTasksでラベル切り替わらない: ' + label);
  });

  // ============ 8. switchTab とログタブ ============
  console.log('\n【8. タブ切替】');
  test('switchTab(log)でログタブがactiveになる', () => {
    window.clearActivityLog();
    window.logActivity({ type: 'notion-page', title: 'タブテスト用', taskCount: 2 });
    const btn = document.getElementById('tab-log-btn');
    window.switchTab('log', btn);
    assert(document.getElementById('tab-log').classList.contains('active'), 'タブがactiveじゃない');
  });
  test('ログタブを開くとログが描画される', () => {
    const list = document.getElementById('activity-log-list');
    assert(list.innerHTML.includes('タブテスト用'), 'ログがレンダリングされてない');
  });
  test('ログを開いた後、未読バッジが消える', () => {
    const btn = document.getElementById('tab-log-btn');
    assert(!btn.textContent.includes('('), 'バッジが残ってる: ' + btn.textContent);
  });
  test('新規ログを追加すると未読バッジが復活する', () => {
    window.logActivity({ type: 'quick-add', title: '新しい操作', taskCount: 1 });
    const btn = document.getElementById('tab-log-btn');
    assert(btn.textContent.includes('('), 'バッジが出てない: ' + btn.textContent);
  });

  // ============ 9. parseQuickInput 改善版 ============
  console.log('\n【9. parseQuickInput（自由記述パース）】');
  test('「5月末まで」→ 2026-05-31 とパースされる', () => {
    const r = window.parseQuickInput('5月末までに PBGHの役員社保加入');
    assert(r, '結果がnull');
    assertEq(r.deadline, '2026-05-31', '5月末の解釈失敗');
  });
  test('「進行中で」→ ステータスが進行中に', () => {
    const r = window.parseQuickInput('PBGHの役員社保加入 進行中で橋本さん待ち');
    assertEq(r.status, '進行中');
  });
  test('「〜を完了する」→ 動詞句が除去される', () => {
    const r = window.parseQuickInput('PBGHの役員の社会保険加入を完了する');
    assert(!r.name.includes('を完了する'), '動詞句が残ってる: ' + r.name);
  });
  test('「〜さん待ちです」→ メモに分離される', () => {
    const r = window.parseQuickInput('PBGHの役員社保加入　橋本さんからの会社情報待ちです');
    assert(r.note && r.note.includes('待ち'), 'メモに分離されてない: note=' + r.note);
  });
  test('全部入り：5月末 + 進行中 + 状況', () => {
    const r = window.parseQuickInput('5月末までに　PBGHの役員の社会保険加入を完了する　進行中で今橋本さんの会社情報待ちです');
    assertEq(r.deadline, '2026-05-31', '期日');
    assertEq(r.status, '進行中', 'ステータス');
    assert(!r.name.includes('5'), '名前に「5」残ってる: ' + r.name);
    assert(!r.name.includes('完了する'), '動詞句残ってる: ' + r.name);
    assert(r.note && r.note.length > 0, 'メモが空');
  });

  // ============ 10. extractKusumotoTasks の楠本対応 ============
  console.log('\n【10. 議事録抽出ロジック（楠本対応）】');
  test('「楠本：タスクXYZ」も検出される', () => {
    const blocks = [
      { text: '楠本：ユニーク融資面談（5/26）参加', type: 'bulleted_list_item', checked: null, depth: 0 }
    ];
    const tasks = window.extractKusumotoTasks(blocks, 'テスト議事録');
    assert(tasks.length >= 1, '楠本パターンが検出されない');
  });
  test('見出しに楠元が含まれてもタスクになる', () => {
    const blocks = [
      { text: 'AITOKYO是正工事 未対応問題 @松井・楠元', type: 'heading_2', checked: null, depth: 0 }
    ];
    const tasks = window.extractKusumotoTasks(blocks, 'テスト議事録');
    assert(tasks.length >= 1, '見出し内の楠元が検出されない');
  });
  test('「決定事項：」プレフィックスが除去される', () => {
    const blocks = [
      { text: '決定事項：日経テレコン契約→反社チェック実施　楠元', type: 'callout', checked: null, depth: 0 }
    ];
    const tasks = window.extractKusumotoTasks(blocks, 'テスト議事録');
    assert(tasks.length >= 1, 'callout の楠元が検出されない');
    assert(!tasks[0].name.startsWith('決定事項'), 'プレフィックスが残ってる: ' + tasks[0].name);
  });

  // ============ 11. parseClaudeOutput（Claude出力貼り付け） ============
  console.log('\n【11. Claude出力 一括パース】');
  test('parseClaudeOutput関数が定義されている', () => {
    assertEq(typeof window.parseClaudeOutput, 'function');
  });
  test('「Claude出力を貼り付け」タブのUI要素が存在', () => {
    assert(document.getElementById('qtab-paste'), 'qtab-paste なし');
    assert(document.getElementById('qtab-paste-btn'), 'qtab-paste-btn なし');
    assert(document.getElementById('paste-input'), 'paste-input なし');
    assert(document.getElementById('paste-stats'), 'paste-stats なし');
  });
  test('チェックボックス付きタスクから抽出', () => {
    const text = '- [ ] 5/26 ユニーク融資面談に参加\n- [ ] 岡田弁護士に社外取締役の相談 高\n- [x] 完了済みタスク';
    const { tasks, stats } = window.parseClaudeOutput(text);
    assert(tasks.length === 2, `期待:2件 実際:${tasks.length}件`);
    assert(stats.completedSkipped >= 1, '完了済みがスキップされてない');
  });
  test('番号リストからも抽出', () => {
    const text = '1. 内定通知書の作成 5/25 緊急 総務\n2. Shopify実装 鎌形と\n3) 反社チェック';
    const { tasks } = window.parseClaudeOutput(text);
    assert(tasks.length === 3, `期待:3件 実際:${tasks.length}件`);
  });
  test('見出し（## や 【】）はスキップされる', () => {
    const text = '## アクションアイテム\n- [ ] 実タスク\n【次回までに】\n- もう一つのタスク';
    const { tasks, stats } = window.parseClaudeOutput(text);
    assertEq(tasks.length, 2, '見出しスキップ後のタスク数');
    assert(stats.headers >= 2, `見出しスキップ数:${stats.headers}`);
  });
  test('Markdownの太字記号が除去される', () => {
    const text = '- **5/26**: ユニーク融資面談';
    const { tasks } = window.parseClaudeOutput(text);
    assert(tasks.length === 1, '抽出されてない');
    assert(!tasks[0].name.includes('**'), '太字記号が残ってる: ' + tasks[0].name);
  });
  test('「楠元：」「楠本：」プレフィックスが除去される', () => {
    const text = '- [ ] 楠元：ユニーク融資面談\n- [ ] 楠本：社外取締役相談';
    const { tasks } = window.parseClaudeOutput(text);
    assertEq(tasks.length, 2);
    assert(!tasks[0].name.startsWith('楠元'), '楠元残ってる: ' + tasks[0].name);
    assert(!tasks[1].name.startsWith('楠本'), '楠本残ってる: ' + tasks[1].name);
  });
  test('期日・優先度・ステータスが各行から抽出される', () => {
    // 全角スペースで状況を区切ったClaude出力スタイル
    const text = '- 5月末までに 反社チェック実施　進行中で橋本さん待ち';
    const { tasks } = window.parseClaudeOutput(text);
    assertEq(tasks.length, 1);
    assertEq(tasks[0].deadline, '2026-05-31', '期日');
    assertEq(tasks[0].status, '進行中', 'ステータス');
    assert(tasks[0].note && tasks[0].note.length > 0, 'メモが空: name=' + tasks[0].name + ' note=' + tasks[0].note);
  });
  test('重複タスクは1件にまとめられる', () => {
    const text = '- タスクA\n- タスクA\n- タスクB';
    const { tasks } = window.parseClaudeOutput(text);
    assertEq(tasks.length, 2);
  });
  test('区切り線（---, ===）はスキップ', () => {
    const text = '- タスクA\n---\n- タスクB\n===\n- タスクC';
    const { tasks } = window.parseClaudeOutput(text);
    assertEq(tasks.length, 3);
  });
  test('updatePastePreviewでDOMに反映される', () => {
    document.getElementById('paste-input').value = '- [ ] テストタスク1\n- [ ] テストタスク2';
    window.updatePastePreview();
    const preview = document.getElementById('quick-preview');
    assertEq(preview.style.display, 'block', 'プレビュー非表示');
    const stats = document.getElementById('paste-stats').textContent;
    assert(stats.includes('2件'), '統計テキストがない: ' + stats);
  });
  test('switchQuickTab(paste)でpasteタブがactive', () => {
    window.switchQuickTab('paste');
    const btn = document.getElementById('qtab-paste-btn');
    assert(btn.classList.contains('active'), 'paste-btn未アクティブ');
    assertEq(document.getElementById('qtab-paste').style.display, 'block');
    assertEq(document.getElementById('qtab-text').style.display, 'none');
    assertEq(document.getElementById('qtab-notion').style.display, 'none');
  });
  test('長文の議事録要約からタスク抽出（総合テスト）', () => {
    const text = `## アクションアイテム
- [ ] 楠元：5/26 ユニーク融資面談に参加 高
- [ ] 楠元：岡田弁護士に社外取締役就任の相談
- [ ] 5月末までに 反社チェック実施 進行中で日経テレコン契約待ち
- [x] 既に完了したタスク

### 期限近め
1. 内定通知書の作成 5/25 緊急 総務
2. Shopify実装の進捗確認 鎌形と一緒に

---
背景：先週からの持ち越し`;
    const { tasks, stats } = window.parseClaudeOutput(text);
    assert(tasks.length === 5, `期待:5件 実際:${tasks.length}件 (${tasks.map(t => t.name).join(' / ')})`);
    assert(stats.completedSkipped >= 1, '完了スキップなし');
    assert(stats.headers >= 2, '見出しスキップ少ない');
    // 期日・優先度が反映されているか
    const facilitation = tasks.find(t => t.name.includes('融資面談'));
    if (facilitation) assertEq(facilitation.priority, '高', '融資面談の優先度');
  });

  // ============ サマリー ============
  console.log('\n' + results.join('\n'));
  console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('テスト実行エラー:', e);
  process.exit(1);
});
