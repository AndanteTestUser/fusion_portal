// WK Image Relay - Google Apps Script Web App
//
// iOSの共有シート → ショートカット から画像をPOSTし、fusion_portal の
// ウェルカム画面がGETで取り込む中継サーバー。バックエンドを持たない
// fusion_portal (GitHub Pages上の静的SPA) の代わりに、画像の一時置き場として
// Google Drive を使う。
//
// デプロイ手順・iOSショートカットの作り方は gas/README.md を参照。
//
// 事前設定(必須): このプロジェクトの「プロジェクトの設定」→「スクリプト プロパティ」に
//   WK_IMAGE_SECRET = <ショートカット側・fusion_portalの設定画面と共有する任意の文字列>
// を追加しておくこと。シークレットをコードに直接書かないための措置。

const FOLDER_NAME = 'fusion_portal_wk_images';

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('WK_IMAGE_SECRET');
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getFolder_() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

// ショートカットからの画像アップロードを受け取る。
// リクエストボディ(JSON):
//   { secret, dataBase64, mimeType, filename, targetPath? }
//   targetPath: 省略可。省略した場合、fusion_portal側では「次に開いた機能
//   ページへ自動的に反映される」画像として扱われる(通常はこれでよい)。
//   特定の機能ページ専用にしたい場合だけ指定する(例: "/generator")。
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = getSecret_();
    if (!secret || body.secret !== secret) {
      return jsonResponse_({ ok: false, error: 'unauthorized' });
    }
    if (!body.dataBase64) {
      return jsonResponse_({ ok: false, error: 'dataBase64 is required' });
    }

    const mimeType = body.mimeType || 'image/jpeg';
    const filename = body.filename || `wk_${Date.now()}.jpg`;
    const bytes = Utilities.base64Decode(body.dataBase64);
    const blob = Utilities.newBlob(bytes, mimeType, filename);

    const file = getFolder_().createFile(blob);
    file.setDescription(
      JSON.stringify({
        filename,
        targetPath: body.targetPath || null,
      })
    );

    return jsonResponse_({ ok: true, id: file.getId() });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error) });
  }
}

// fusion_portal からの取り込みリクエストに応答する。
// クエリ: ?action=list&secret=...
// 未取得の画像を全て返し、返した画像はDriveから削除する(consume)。
// 同じ画像が二重に取り込まれるのを防ぐための挙動。
function doGet(e) {
  try {
    const secret = getSecret_();
    if (!secret || e.parameter.secret !== secret) {
      return jsonResponse_({ ok: false, error: 'unauthorized' });
    }

    const folder = getFolder_();
    const files = folder.getFiles();
    const images = [];
    const toTrash = [];

    while (files.hasNext()) {
      const file = files.next();
      let meta = {};
      try {
        meta = JSON.parse(file.getDescription() || '{}');
      } catch (parseError) {
        meta = {};
      }

      const blob = file.getBlob();
      const base64 = Utilities.base64Encode(blob.getBytes());
      const mimeType = blob.getContentType() || 'image/jpeg';

      images.push({
        id: file.getId(),
        dataUrl: `data:${mimeType};base64,${base64}`,
        filename: meta.filename || file.getName(),
        targetPath: meta.targetPath || null,
        createdAt: file.getDateCreated().getTime(),
      });
      toTrash.push(file);
    }

    toTrash.forEach((file) => file.setTrashed(true));

    return jsonResponse_({ ok: true, images });
  } catch (error) {
    return jsonResponse_({ ok: false, error: String(error) });
  }
}
