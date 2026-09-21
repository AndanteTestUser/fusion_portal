// WK画像(ウェルカム画面から各機能ページへ受け渡す画像)のストア。
//
// 保存方式(APIキーと同じ二段階の発想だが、画像は資格情報ではないため暗号化はしない):
//   - セッション内保存(既定): sessionStorage(fusion_portal_wk_images)。タブを
//     閉じれば消え、手入れの手間が発生しない。
//   - 端末への保存(任意): 画像単位で「永続化」を選んだものだけ、平文のまま
//     localStorage(fusion_portal_wk_images_persisted)にも書き込む。
//
// targetPath(nullable)1つだけで状態を表す。「チェック」という別概念は持たない。
//   - targetPath === null: 特定のページに固定されていない「プール」画像。
//     次に開いたどの機能ページにも自動的に反映される(通常はこちら)。
//   - targetPath === "/xxx": そのページ専用に固定された画像(例外的なケース)。
//     同じページに複数固定することはできず、後から固定した方が優先される
//     (setTargetPathInList が古い方を自動的にプールへ戻す)。
// 画像は機能ページへ反映された時点でリストから削除される(使い切り)。
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

// targetPath を設定する。null にすればプールへ戻す(固定解除)。
// 非nullを設定する場合、同じページに既に固定されている他の画像があれば
// そちらは自動的にプール(null)へ戻す(1ページにつき固定できるのは常に1枚)。
export function setTargetPathInList(list, id, targetPath) {
  return list.map((img) => {
    if (img.id === id) return { ...img, targetPath };
    if (targetPath && img.targetPath === targetPath) return { ...img, targetPath: null };
    return img;
  });
}

export function setPersistedInList(list, id, persisted) {
  return list.map((img) => (img.id === id ? { ...img, persisted } : img));
}

// 指定したページへ適用すべき画像を1枚選ぶ。
//   1. そのページに固定(targetPath一致)された画像があればそれを優先
//   2. なければ、プール(targetPath === null)の中で最も新しいものを使う
//   3. どちらもなければ null
export function getImageToApply(list, path) {
  const pinned = list.find((img) => img.targetPath === path);
  if (pinned) return pinned;

  const pooled = list.filter((img) => !img.targetPath);
  return pooled.length > 0 ? pooled[pooled.length - 1] : null;
}

// GAS から取得した画像を、既存リストへID重複なしで取り込む。
// targetPath が指定されていればそのページに固定し、同じページに既に
// 固定されている画像があればプールへ戻す。未指定ならプールに追加される。
export function mergeGasImages(list, gasImages) {
  const existingIds = new Set(list.map((img) => img.id));
  const additions = gasImages
    .filter((img) => !existingIds.has(img.id))
    .map((img) => ({
      id: img.id,
      dataUrl: img.dataUrl,
      filename: img.filename || '',
      targetPath: img.targetPath || null,
      persisted: false,
      source: 'gas',
      createdAt: img.createdAt || Date.now(),
    }));
  if (additions.length === 0) return list;

  return additions.reduce(
    (acc, img) => (img.targetPath ? setTargetPathInList([...acc, img], img.id, img.targetPath) : [...acc, img]),
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

// autoPoll: バックグラウンドで定期的に取り込むかどうか。そもそも手動の
// 「今すぐ取り込む」ボタンで足りるケースが多いため、既定はオフにしている。
export function loadGasConfig() {
  const stored = safeReadJson(localStorage, GAS_CONFIG_STORAGE_KEY);
  return { url: '', secret: '', autoPoll: false, ...stored };
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
