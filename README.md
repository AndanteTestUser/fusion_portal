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

## テスト

```bash
npm test
```

`src/lib/vault.js`（端末保存用の暗号化ロジック）のうち、Node上で実行可能な
パスフレーズ経路をユニットテストする。

`dist/` に静的ファイルが出力される。`main` ブランチへの push で GitHub Actions
（`.github/workflows/deploy.yml`）が自動的にビルドし、GitHub Pages へデプロイする。

**初回のみ**、リポジトリの Settings → Pages で Source を「GitHub Actions」に設定する
必要がある（この操作は GitHub 上での手動設定であり、Actions 経由では変更できない）。

## 構成

- `/` : ウェルカムページ。`src/tools.js` の内容からメニューを自動生成する
- `/generator` : AI Image Editor（旧 `index.html` から移植）
- `/settings` : APIキー・Vault の設定画面（ウェルカムページからのみ導線がある）

ルーティングは `HashRouter` を採用している。GitHub Pages は静的ホスティングで
サーバー側のリライトができないため、`BrowserRouter` だと `/generator` への直接
アクセスやリロードで 404 になる。これを避けるための選択。

このアプリはホーム画面に追加してスタンドアロン表示するPWAとしての利用を想定して
おり、その場合ブラウザの戻るボタンは使えない。そのため各画面からの「戻る」操作は
すべて `PortalLayout`（`src/components/PortalLayout.jsx`）が表示するヘッダーの
「‹ ポータル」リンク経由で行う設計にしている（ブラウザの戻る操作には依存しない）。

## 機能画面の追加方法

機能を1つ追加するには `src/tools.js` の配列にエントリを1つ追加するだけでよい。

```js
{
  path: '/my-tool',
  title: '画面のタイトル',
  icon: '🛠️',
  description: '一言説明',
  component: lazy(() => import('./pages/MyToolPage.jsx')),
}
```

この配列から `App.jsx` のルーティングと、ウェルカムページのメニューの両方が
自動的に生成される。`component` は `lazy()` で遅延読み込みし、`PortalLayout` の
`Suspense` でラップされる。

## APIキーについて（二段階の保存方式）

APIキーは2段階で保存される。

1. **セッション内保存（必須・既定）**: 入力したAPIキーは `sessionStorage`
   （`fusion_portal_providers`）に平文で保持され、タブ・アプリを閉じると消える
   （BYOK。個人利用を前提とした簡易的な方式）。
2. **端末への保存（任意・Vault）**: 設定画面から明示的に有効化すると、APIキーを
   この端末に限り暗号化して `localStorage`（`fusion_portal_vault`）へ保存できる。
   保存されるのは常に暗号文のみで、暗号化にはランダムな AES-GCM-256 のデータキーを
   使う。このデータキー自体は、ユーザーが選んだ「解錠方法」（パスフレーズ、または
   パスキー〈WebAuthn + PRF拡張〉）ごとにラップして保存され、平文のままディスクに
   残ることはない。データキーはメモリ上（Reactの ref）にのみ保持され、ページを
   離れる・ロックすることで消える。詳細は `src/lib/vault.js` を参照。

Vaultの暗号処理は Node 上でユニットテスト可能な形（`test/vault.test.mjs`、
`npm test` で実行）にしてある。ただしパスキー（WebAuthn）はNode上に存在しないため
パスフレーズ経路のみを対象にしている。

## 今後の予定（段階的実装）

- GAS（Google Apps Script）を中継バックエンドとして、Notion/Drive のデータ取得を
  委譲する
- OpenAI APIキー入力・モデル選択の追加（単純なプロンプト生成機能のみ両対応、
  パーツ切り貼り編集機能は当面 Gemini 限定）
