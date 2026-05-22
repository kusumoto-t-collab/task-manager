# テスト

jsdomで `index.html` を読み込み、新機能の動作を検証します。

## 実行方法

```bash
# 一度だけ jsdom をインストール
npm install --no-save jsdom

# テスト実行
node test/test-features.js
```

## カバー範囲（44ケース）

| カテゴリ | 内容 |
|---------|------|
| UI構造 | グローバルステータスバー・ログタブ・新着バナー・新着フィルター・プログレスバーのDOM存在確認 |
| JS関数 | logActivity / setGlobalStatus / setExtractProgress / showInboxBanner / switchTab 等の定義確認 |
| アクティビティログ | 追加・0件記録・エラー記録・localStorage永続化・描画・CSSクラス・消去・空表示 |
| グローバルステータスバー | processing / ok / error / 非表示の各状態 |
| プログレスバー | 進捗率反映・非表示 |
| 新着通知バナー | 表示・localStorage保存・閉じる |
| 新着フィルター | フィルター切替・カウント表示・viewNewTasks |
| タブ切替 | ログタブ active化・描画・未読バッジ表示/消去 |
| parseQuickInput | 5月末解釈・進行中検出・動詞句除去・メモ分離・全部入り |
| 議事録抽出 | 楠本（誤字）対応・見出し抽出・決定事項プレフィックス除去 |
