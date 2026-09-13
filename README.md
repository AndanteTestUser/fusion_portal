# fusion_portal

React + Vite + TailwindCSS による SPA。GitHub Pages でホスティングする。

## セットアップ

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
```

`dist/` に静的ファイルが出力される。`main` ブランチへの push で GitHub Actions
（`.github/workflows/deploy.yml`）が自動的にビルドし、GitHub Pages へデプロイする。

**初回のみ**、リポジトリの Settings → Pages で Source を「GitHub Actions」に設定する
必要がある（この操作は GitHub 上での手動設定であり、Actions 経由では変更できない）。

## 構成

- `/` : ウェルカムページ（今後、機能追加時のメニューになる想定）
- `/generator` : AI Image Editor（旧 `index.html` から移植）

ルーティングは `HashRouter` を採用している。GitHub Pages は静的ホスティングで
サーバー側のリライトができないため、`BrowserRouter` だと `/generator` への直接
アクセスやリロードで 404 になる。これを避けるための選択。

## APIキーについて

Gemini APIキーは個人利用を前提に、画面上部の入力欄からブラウザ内 `sessionStorage`
に保存する方式（BYOK）。タブを閉じると消える。共有・公開利用する場合はこの方式を
見直すこと（詳細は改修仕様書を参照）。

## 今後の予定（段階的実装）

- GAS（Google Apps Script）を中継バックエンドとして、Notion/Drive のデータ取得を
  委譲する
- OpenAI APIキー入力・モデル選択の追加（単純なプロンプト生成機能のみ両対応、
  パーツ切り貼り編集機能は当面 Gemini 限定）
