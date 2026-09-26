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
const SETTING_FOLDER_PROPERTY = 'SETTING_FOLDER_ID';
const SETTING_FOLDER_NAME = 'fusion_portal_settings';

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

function getSettingFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty(SETTING_FOLDER_PROPERTY);
  if (id) return DriveApp.getFolderById(id);
  const folders = DriveApp.getFoldersByName(SETTING_FOLDER_NAME);
  if (!folders.hasNext()) throw new Error('fusion_portal_settings folder not found');
  const folder = folders.next();
  if (folders.hasNext()) throw new Error('Multiple settings folders found. Configure SETTING_FOLDER_ID.');
  return folder;
}

function getSettingImageFolder_() {
  const parent = getSettingFolder_();
  const folders = parent.getFoldersByName('images');
  return folders.hasNext() ? folders.next() : parent.createFolder('images');
}

function settingList_() {
  const files = getSettingFolder_().getFiles();
  const settings = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!file.getName().endsWith('.json')) continue;
    try {
      const record = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (record.schemaVersion !== 1 || !record.id) continue;
      settings.push(record);
    } catch (error) {
      // 壊れたレコードだけを除外し、他の設定は表示する。
    }
  }
  settings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jsonResponse_({ ok: true, settings });
}

function settingImage_(id) {
  if (!id) return jsonResponse_({ ok: false, error: 'image id is required' });
  const folder = getSettingImageFolder_();
  const file = DriveApp.getFileById(id);
  const parents = file.getParents();
  let belongsToSettings = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) belongsToSettings = true;
  }
  if (!belongsToSettings) return jsonResponse_({ ok: false, error: 'image not found' });
  const blob = file.getBlob();
  return jsonResponse_({
    ok: true,
    dataUrl: `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`,
  });
}

function saveSettingImage_(dataUrl, name, createdFiles) {
  if (!dataUrl) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('unsupported image format');
  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('image exceeds 8 MiB');
  const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  const file = getSettingImageFolder_().createFile(Utilities.newBlob(bytes, match[1], `${name}.${extension}`));
  createdFiles.push(file);
  return file.getId();
}

function saveSetting_(body) {
  const title = String(body.title || '').trim();
  const text = String(body.text || '');
  const imagePrompt = String(body.imagePrompt || '');
  const requestId = String(body.requestId || '');
  if (!title || title.length > 200 || text.length > 100000 || imagePrompt.length > 20000) {
    throw new Error('invalid setting fields');
  }
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw new Error('invalid requestId');

  const folder = getSettingFolder_();
  const filename = `setting-${requestId}.json`;
  const existing = folder.getFilesByName(filename);
  if (existing.hasNext()) {
    return jsonResponse_({ ok: true, setting: JSON.parse(existing.next().getBlob().getDataAsString('UTF-8')) });
  }

  const createdFiles = [];
  try {
    const baseImageFileId = saveSettingImage_(body.baseImage, `${requestId}-base`, createdFiles);
    const generatedImageFileId = saveSettingImage_(body.generatedImage, `${requestId}-diagram`, createdFiles);
    const setting = {
      schemaVersion: 1,
      id: `setting-${requestId}`,
      title,
      text,
      imagePrompt,
      baseImageFileId,
      generatedImageFileId,
      source: 'portal',
      createdAt: new Date().toISOString(),
    };
    const record = folder.createFile(Utilities.newBlob(JSON.stringify(setting), 'application/json', filename));
    createdFiles.push(record);
    return jsonResponse_({ ok: true, setting });
  } catch (error) {
    createdFiles.forEach((file) => file.setTrashed(true));
    throw error;
  }
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
    if (body.action === 'settings.save') {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try { return saveSetting_(body); }
      finally { lock.releaseLock(); }
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

    if (e.parameter.action === 'settings.list') return settingList_();
    if (e.parameter.action === 'settings.image') return settingImage_(e.parameter.id);
    if (e.parameter.action !== 'list') return jsonResponse_({ ok: false, error: 'unknown action' });

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
