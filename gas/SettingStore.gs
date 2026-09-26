// Fusion Portal Setting Store - independent Google Apps Script Web App.
// Persistent settings in Drive. No WK image relay or consume behavior.
const SETTING_FOLDER_PROPERTY = 'SETTING_FOLDER_ID';
const SETTING_FOLDER_NAME = 'fusion_portal_settings';

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SETTING_STORE_SECRET');
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
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

function doGet(e) {
  try {
    if (!getSecret_() || e.parameter.secret !== getSecret_()) return jsonResponse_({ ok: false, error: 'unauthorized' });
    if (e.parameter.action === 'list') return settingList_();
    if (e.parameter.action === 'image') return settingImage_(e.parameter.id);
    return jsonResponse_({ ok: false, error: 'unknown action' });
  } catch (error) { return jsonResponse_({ ok: false, error: String(error) }); }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!getSecret_() || body.secret !== getSecret_()) return jsonResponse_({ ok: false, error: 'unauthorized' });
    if (body.action !== 'save') return jsonResponse_({ ok: false, error: 'unknown action' });
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { return saveSetting_(body); }
    finally { lock.releaseLock(); }
  } catch (error) { return jsonResponse_({ ok: false, error: String(error) }); }
}
