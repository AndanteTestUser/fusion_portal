# 設定ストア（専用 Google Apps Script）

設定ビルダーの登録用 Web App。既存の `WkImageRelay.gs` とは別プロジェクトとして
デプロイする。WK 画像リレーの一時ファイルや `GET` 時の削除処理には触れない。

## セットアップ

1. Apps Script で**新規プロジェクト**を作り、`gas/SettingStore.gs` を `Code.gs` に貼る。
2. スクリプト プロパティ `SETTING_STORE_SECRET` に、WK 画像リレーとは異なる
   ランダムな文字列を設定する。
3. Drive の `fusion_portal_settings` フォルダを使用する。同名フォルダが複数ある
   場合は `SETTING_FOLDER_ID` に対象のフォルダ ID を設定する。
4. Web App として「自分として実行」「全員アクセス」でデプロイする。
5. Fusion Portal の「設定 → 設定ストア (専用 GAS)」に、この Web App の URL と
   `SETTING_STORE_SECRET` を入力し、接続テストで登録済み件数を確認する。

設定の JSON は上記フォルダに、画像はその中の `images` フォルダに保存する。
`GET ?action=list` は一覧を読み、`GET ?action=image&id=...` は画像を読み、
`POST` の `action: save` は新規登録する。一覧取得でファイルを削除しない。

元コードのモック２件は `gas/seed-settings/` の JSON として一度だけ登録済み。
指定された図解画像２件も `images` に保存し、各 JSON の
`generatedImageFileId` から参照する。元コードの `placehold.co` 仮画像は移行しない。

URL とシークレットを知る利用者は、この Web App の保存データを読み書きできる。
Portal の接続情報はこの端末の localStorage に保存される。個人利用向けの方式である。
