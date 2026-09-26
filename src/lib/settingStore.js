function endpoint(config, action, params = {}) {
  if (!config.url || !config.secret) throw new Error('設定画面で WK画像 (GAS連携) の URL と共有シークレットを設定してください。');
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
  const body = await responseJson(await fetch(endpoint(config, 'settings.list')));
  return Array.isArray(body.settings) ? body.settings : [];
}

export async function getSettingImage(config, id) {
  const body = await responseJson(await fetch(endpoint(config, 'settings.image', { id })));
  return body.dataUrl;
}

export async function saveSetting(config, setting) {
  endpoint(config, 'settings.list'); // 設定不足を送信前に検出する。
  // Apps Script の Web App は JSON Content-Type のプリフライトに応答しない。
  // Content-Type を付けず text/plain として送信し、GAS 側で JSON として読む。
  const response = await fetch(config.url, {
    method: 'POST',
    body: JSON.stringify({ ...setting, action: 'settings.save', secret: config.secret }),
  });
  return (await responseJson(response)).setting;
}
