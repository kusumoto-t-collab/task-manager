// 実際のHD役員定例会議（2026/05/22）の構造を再現してテスト
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

class LocalStorageMock {
  constructor() { this.store = {}; }
  getItem(k) { return this.store[k] ?? null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
  clear() { this.store = {}; }
}

(async () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage = new LocalStorageMock();
      window.sessionStorage = new LocalStorageMock();
      window.fetch = async () => ({ ok: true, json: async () => ({ results: [], has_more: false }) });
      window.crypto = { subtle: { digest: async () => new ArrayBuffer(32) }, getRandomValues: a => a };
      window.confirm = () => true;
      window.alert = () => {};
    },
  });
  await new Promise(r => setTimeout(r, 500));

  const { window } = dom;

  // 実際のHD役員定例会議（2026/05/22）の構造を再現
  const blocks = [
    // === AI meeting notes summary section ===
    { text: '資金繰り・融資・事業運営会議', type: 'paragraph', depth: 1 },
    { text: '資金繰りと融資状況', type: 'heading_3', depth: 2 },
    { text: 'PayPay残高は現在約1,300万円', type: 'bulleted_list_item', depth: 2 },
    { text: '5月19日の入金が想定より少なく（600万円想定が399万1,000円）、若干マイナス', type: 'bulleted_list_item', depth: 2 },
    { text: '5月末に約1,800万円の融資入金予定（爽やか信金から1,000万円、オリックスから3,000万円で残高2,200万円引落後、真水800万〜1,800万円）', type: 'bulleted_list_item', depth: 2 },
    { text: 'ユニークの融資面談は5月26日に予定', type: 'bulleted_list_item', depth: 2 },
    { text: '銀行取引と戦略', type: 'heading_3', depth: 2 },
    { text: '複数の金融機関と並行して融資申込中（千葉銀行、爽やか信金、NIC、コア信金）', type: 'bulleted_list_item', depth: 2 },
    { text: 'ユニーク社の事業運営', type: 'heading_3', depth: 2 },
    { text: '5月着地見込みは約8,400万円（当初目標の8,852万円から若干減）', type: 'bulleted_list_item', depth: 2 },
    { text: 'リバディーズからの請求書（想定300万円だが実際は80万円）の確認が必要', type: 'bulleted_list_item', depth: 2 },
    { text: '法務・コンプライアンス', type: 'heading_3', depth: 2 },
    { text: '大川氏紹介案件の反社チェックを実施予定（日経テレコンとClaudeのディープリサーチを使用）', type: 'bulleted_list_item', depth: 2 },
    { text: '岡田弁護士を社外取締役として招聘検討中（月額10万円程度）', type: 'bulleted_list_item', depth: 2 },
    { text: '建設業許可の申請を進行中（先週保険証を提出済み）', type: 'bulleted_list_item', depth: 2 },
    { text: '人事・給与関係', type: 'heading_3', depth: 2 },
    { text: 'アシスタント47名の給与設定を見直し：160時間＋固定残業10時間で22万円に設定', type: 'bulleted_list_item', depth: 2 },
    { text: '中間納税と社会保険料', type: 'heading_3', depth: 2 },
    { text: '中間納税の状況確認が必要（6月に約600万円の可能性）', type: 'bulleted_list_item', depth: 2 },
    { text: '社会保険料の分割払い（3月分約390万円）を継続交渉中', type: 'bulleted_list_item', depth: 2 },
    { text: '戦略的計画', type: 'heading_3', depth: 2 },
    { text: '30億円売上を目標に、翼社長のもとで直営店とブランドシェアオーナーを展開', type: 'bulleted_list_item', depth: 2 },
    { text: 'その他の事業事項', type: 'heading_3', depth: 2 },
    { text: 'i-Tokyo社の5月着地は順調', type: 'bulleted_list_item', depth: 2 },
    { text: 'Shopifyサイトの実装をClaudeを使用して進行中', type: 'bulleted_list_item', depth: 2 },

    // === アクションアイテムセクション ===
    { text: 'アクションアイテム', type: 'heading_3', depth: 2 },
    { text: '向井：融資状況の最終確認と銀行への連絡', type: 'to_do', checked: false, depth: 2 },
    { text: '向井：大川氏のフルネーム情報を収集し、反社チェック実施', type: 'to_do', checked: false, depth: 2 },
    { text: '向井：リバディーズの請求書を確認・提出', type: 'to_do', checked: false, depth: 2 },
    { text: '向井：中間納税の状況を税理士に確認', type: 'to_do', checked: false, depth: 2 },
    { text: '向井：建設業許可の進捗確認', type: 'to_do', checked: false, depth: 2 },
    { text: '楠本：ユニークの融資面談（5月26日）に参加', type: 'to_do', checked: false, depth: 2 },
    { text: '楠本：岡田弁護士に社外取締役就任の相談', type: 'to_do', checked: false, depth: 2 },
    { text: '関羽：アシスタントの契約書を160時間＋固定残業10時間で作成', type: 'to_do', checked: false, depth: 2 },
    { text: 'チーム：日経テレコンの契約確認と反社チェック体制構築', type: 'to_do', checked: false, depth: 2 },
    { text: 'チーム：建築事業のKPI作成（来週まで）', type: 'to_do', checked: false, depth: 2 },
    { text: '翼：30億円達成に向けた詳細計画を作成', type: 'to_do', checked: false, depth: 2 },

    // === 本文：議事録の本体 ===
    { text: '【日時】 2026/05/22（金）15:00〜17:00 ※宮さん参加', type: 'paragraph', depth: 0 },
    { text: '【参加者】 鎌形・橋本・向井・尾形・松井・楠元（宮さん）', type: 'paragraph', depth: 0 },
    { text: '前回（5/15）からの持ち越し（完了確認）', type: 'heading_2', depth: 0 },
    { text: 'AITOKYO融資 1,000万円プロパー進捗 @向井', type: 'bulleted_list_item', depth: 0 },
    { text: '建築案件 利益率分析・PL作成 @向井・松井', type: 'bulleted_list_item', depth: 0 },
    { text: 'リバティ未請求金（約380万）請求書発行 @向井・橋本', type: 'bulleted_list_item', depth: 0 },
    { text: 'Shopifyテーマ実装（5月末80%完成目標） @向井・楠元', type: 'bulleted_list_item', depth: 0 },

    // 議題セクション（深いネストの議論メモが続く）
    { text: '財務・資金繰り', type: 'heading_2', depth: 0 },
    { text: '議題 :（🔴）PBGH 5月CF着地＋6月CF見通し　@向井', type: 'heading_2', depth: 0 },
    { text: '融資状況', type: 'bulleted_list_item', depth: 0 },
    { text: 'AITOYKOの融資　5末までには完了する予定', type: 'bulleted_list_item', depth: 1 },
    { text: '1800万ほど入る予定', type: 'bulleted_list_item', depth: 2 },
    { text: '1000万円＋3000万円入る中で3000万は着金時に2200万円引かれれる予定', type: 'bulleted_list_item', depth: 2 },
    { text: '矢口さんへの対応について', type: 'bulleted_list_item', depth: 1 },
    { text: '融資でおりたぶんは全て返済に当ててもらう流れで対応する', type: 'bulleted_list_item', depth: 2 },

    // 大川氏案件
    { text: '議題 :（🔵）大川氏紹介案件 反社チェック　@松井・橋本', type: 'heading_2', depth: 0 },
    { text: '決定事項：日経テレコン契約→反社チェック実施　楠元', type: 'callout', depth: 0 },

    // AITOKYO是正
    { text: '議題 :（🆕🔴）AITOKYO是正工事 未対応問題　@松井・楠元', type: 'heading_2', depth: 0 },
    { text: 'ゆうけん氏連絡返答なし', type: 'bulleted_list_item', depth: 0 },
    { text: '5/15unique定例で楠元が是正グループ作成・進行握る方針決定', type: 'bulleted_list_item', depth: 0 },

    // AIme
    { text: '議題 :（🟡）プロダクト AIme 7/15販売開始＋7/10ローンチイベント　@橋本・池田・楠元', type: 'heading_2', depth: 0 },
    { text: '販売開始6/15→7/15に延期確定', type: 'bulleted_list_item', depth: 0 },
    { text: 'Shopifyテーマ実装（5月末80%目標）', type: 'bulleted_list_item', depth: 0 },
    { text: '鎌形さんに一度依頼する　アウトプット確認する', type: 'bulleted_list_item', depth: 1 },

    // Transcript的なlong paragraph
    { text: '会議の冒頭、向井から先週の融資状況について報告があった。爽やか信金からの1,000万円の融資は確実に5月末までに着金する予定。千葉銀行については新規取引のため口座開設から始める必要があり、6月末頃の着金見込み。オリックスからの3,000万円融資は手数料2,200万円を引かれて真水で800万円程度になる見込み。', type: 'paragraph', depth: 0 },
  ];

  // sourceName
  const sourceName = 'HD役員定例会議（2026/05/22）';

  console.log('=== 抽出テスト：HD役員定例会議（2026/05/22）===');
  console.log(`入力ブロック数: ${blocks.length}\n`);

  const tasks = window.extractKusumotoTasks(blocks, sourceName);

  console.log(`抽出されたタスク: ${tasks.length} 件\n`);
  tasks.forEach((t, i) => {
    console.log(`[${i + 1}] ${t.name}`);
    console.log(`    優先度:${t.priority} 領域:${t.domain} 期日:${t.deadline || '-'} 信頼度:${t.confidence}`);
    if (t.note) console.log(`    📝 ${t.note}`);
    console.log('');
  });

  // 評価
  console.log('\n=== 評価 ===');
  const kusumotoExplicit = tasks.filter(t => /楠[元本]|融資面談|岡田|反社|是正|Shopify|AIme/.test(t.name));
  const otherAssignees = tasks.filter(t => /^(向井|橋本|鎌形|尾形|松井|中島|池田|宮崎|翼|関羽|あかね|チーム|全員|矢口|大川|岡田)[\s　]*[：:]/.test(t.name));

  console.log(`✓ 楠元関連と思われるタスク: ${kusumotoExplicit.length} 件`);
  console.log(`✗ 他担当者プレフィックスのまま残ったタスク: ${otherAssignees.length} 件`);

  if (otherAssignees.length > 0) {
    console.log('  → 残った他担当者タスク:');
    otherAssignees.forEach(t => console.log(`     ・${t.name}`));
  }

  console.log(`\n結論: ${tasks.length <= 8 ? '✅ 妥当な件数' : '⚠️ まだ多い'}（目標: 3-7件程度）`);
})();
