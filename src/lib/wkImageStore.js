// WK画像(ウェルカム画面から各機能ページへ受け渡す画像)のストア。
//
// 保存方式(APIキーと同じ二段階の発想だが、画像は資格情報ではないため暗号化はしない):
//   - セッション内保存(既定): sessionStorage(fusion_portal_wk_images)。タブを
//     閉じれば消え、手入れの手間が発生しない。
//   - 端末への保存(任意): 画像単位で「永続化」を選んだものだけ、平文のまま
//     localStorage(fusion_portal_wk_images_persisted)にも書き込む。
//
// 1枚のWK画像は基本的に1つの機能ページ(targetPath)に紐づく想定。同じ
// targetPathに対して「チェック済み」の画像は常に1枚だけになるよう、
// setCheckedInList が排他制御する。
//
// GAS(Google Apps Script)中継からの取り込みに関するロジックもここに置く。
// ネットワークI/Oを伴う fetchGasImages 以外は、ブラウザストレージに依存しない
// 純粋関数として実装し、Node上でユニットテストできるようにしている(vault.js と
// 同じ方針)。

export const SESSION_STORAGE_KEY = 'fusion_portal_wk_images';
export const LOCAL_STORAGE_KEY = 'fusion_portal_wk_images_persisted';
export const GAS_CONFIG_STORAGE_KEY = 'fusion_portal_wk_gas_config';

// これより大きい画像は保存前に長辺をこのサイズまで縮小する
// (sessionStorage/localStorageの容量上限を避けるため)。
export const MAX_STORED_DIMENSION = 1600;

let idCounter = 0;
export function generateImageId() {
  idCounter += 1;
  return `wk_${Date.now()}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 純粋なリスト操作(ストレージに依存しない。Node からテスト可能)
// ---------------------------------------------------------------------------

export function addImageToList(list, image) {
  return [...list, image];
}

export function removeImageFromList(list, id) {
  return list.filter((img) => img.id !== id);
}

// checked=true にする場合、同じ targetPath を持つ他の画像は自動的に
// チェックを外す(1機能ページにつき有効な画像は常に1枚だけ)。
export function setCheckedInList(list, id, checked) {
  const target = list.find((img) => img.id === id);
  if (!target) return list;

  return list.map((img) => {
    if (img.id === id) return { ...img, checked };
    if (checked && target.targetPath && img.targetPath === target.targetPath) {
      return { ...img, checked: false };
    }
    return img;
  });
}

// targetPath を変更する。変更後もチェック済みのままなら、移動先の
// targetPath で既にチェックされている他の画像のチェックを外す。
export function setTargetPathInList(list, id, targetPath) {
  const moved = list.map((img) => (img.id === id ? { ...img, targetPath } : img));
  const target = moved.find((img) => img.id === id);
  if (!target || !target.checked || !targetPath) return moved;

  return moved.map((img) =>
    img.id !== id && img.targetPath === targetPath ? { ...img, checked: false } : img
  );
}

export function setPersistedInList(list, id, persisted) {
  return list.map((img) => (img.id === id ? { ...img, persisted } : img));
}

export function getCheckedForPath(list, path) {
  return list.find((img) => img.targetPath === path && img.checked) || null;
}

// GAS から取得した画像を、既存リストへID重複なしで取り込む。
export function mergeGasImages(list, gasImages) {
  const existingIds = new Set(list.map((img) => img.id));
  const additions = gasImages
    .filter((img) => !existingIds.has(img.id))
    .map((img) => ({
      id: img.id,
      dataUrl: img.dataUrl,
      filename: img.filename || '',
      targetPath: img.targetPath || null,
      checked: Boolean(img.checked && img.targetPath),
      persisted: false,
      source: 'gas',
      createdAt: img.createdAt || Date.now(),
    }));
  if (additions.length === 0) return list;

  // GAS由来の画像も、同じ targetPath への重複チェックを避けるため
  // 1件ずつ setCheckedInList と同じ排他ルールを適用する。
  return additions.reduce(
    (acc, img) => (img.checked ? setCheckedInList([...acc, img], img.id, true) : [...acc, img]),
    list
  );
}

// ---------------------------------------------------------------------------
// 画像リサイズ(保存前に長辺を縮小してから dataURL にする)
// ---------------------------------------------------------------------------

export function resizeImageDataUrl(dataUrl, maxDimension = MAX_STORED_DIMENSION, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const longSide = Math.max(img.width, img.height);
      if (longSide <= maxDimension) {
        resolve(dataUrl);
        return;
      }
      const scale = maxDimension / longSide;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = dataUrl;
  });
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// ブラウザストレージとの連携
// ---------------------------------------------------------------------------

function safeReadJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function safeWriteJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

// sessionStorage(実行中の一覧)と localStorage(永続化された画像のみ)を
// マージして読み込む。sessionStorage側に同じIDがあればそちらを優先する
// (実行中の状態のほうが新しいため)。
export function loadWkImages() {
  const sessionList = safeReadJson(sessionStorage, SESSION_STORAGE_KEY) || [];
  const localList = safeReadJson(localStorage, LOCAL_STORAGE_KEY) || [];
  const sessionIds = new Set(sessionList.map((img) => img.id));
  const merged = [...sessionList, ...localList.filter((img) => !sessionIds.has(img.id))];
  return merged;
}

// 常にsessionStorageへ全件、localStorageへ persisted===true の分だけ書き込む。
// 保存に失敗してもアプリの動作(メモリ上のstate)は継続する。
export function saveWkImages(list) {
  safeWriteJson(sessionStorage, SESSION_STORAGE_KEY, list);
  const persisted = list.filter((img) => img.persisted);
  if (persisted.length > 0) {
    safeWriteJson(localStorage, LOCAL_STORAGE_KEY, persisted);
  } else {
    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch (e) {
      // 無視
    }
  }
}

export function loadGasConfig() {
  return safeReadJson(localStorage, GAS_CONFIG_STORAGE_KEY) || { url: '', secret: '' };
}

export function saveGasConfig(config) {
  safeWriteJson(localStorage, GAS_CONFIG_STORAGE_KEY, config);
}

// GAS Web App から未取得の画像一覧を取得する。取得できた画像はGAS側で
// 削除される(consume)ため、同じ画像が二重に取り込まれることはない。
export async function fetchGasImages({ url, secret }) {
  if (!url || !secret) throw new Error('GAS Web AppのURLと共有シークレットを設定してください');

  const endpoint = `${url}${url.includes('?') ? '&' : '?'}action=list&secret=${encodeURIComponent(secret)}`;
  const response = await fetch(endpoint, { method: 'GET' });
  if (!response.ok) throw new Error(`GASへの接続に失敗しました(HTTP ${response.status})`);

  const body = await response.json();
  if (!body.ok) throw new Error(body.error || 'GASからの取得に失敗しました');
  return body.images || [];
}
