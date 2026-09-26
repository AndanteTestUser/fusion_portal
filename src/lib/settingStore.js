const CONFIG_KEY = 'fusion_portal_setting_store_config';

export function loadSettingStoreConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return { url: value.url || '', secret: value.secret || '' };
  } catch { return { url: '', secret: '' }; }
}

export function saveSettingStoreConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: config.url.trim(), secret: config.secret.trim() }));
}

function endpoint(config, action, params = {}) {
  if (!config.url || !config.secret) throw new Error('設定画面で設定ストア専用 GAS の URL とシークレットを設定してください。');
  const url = new URL(config.url);
  url.searchParams.set('action', action);
  url.searchParams.set('secret', config.secret);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function responseJson(response) {
  if (!response.ok) throw new Error(`Google Workspace への接続に失敗しました (HTTP ${response.status})`);
  const body = await response.json();
  if (!body.ok) throw new Error(body.error || 'Google Workspace の処理に失敗しました。');
  return body;
}

export async function listSettings(config) {
  const body = await responseJson(await fetch(endpoint(config, 'list')));
  return Array.isArray(body.settings) ? body.settings : [];
}

export async function getSettingImage(config, id) {
  const body = await responseJson(await fetch(endpoint(config, 'image', { id })));
  return body.dataUrl;
}

export async function saveSetting(config, setting) {
  endpoint(config, 'list'); // 設定不足を送信前に検出する。
  // Apps Script の Web App は JSON Content-Type のプリフライトに応答しない。
  // Content-Type を付けず text/plain として送信し、GAS 側で JSON として読む。
  const response = await fetch(config.url, {
    method: 'POST',
    body: JSON.stringify({ ...setting, action: 'save', secret: config.secret }),
  });
  return (await responseJson(response)).setting;
}
