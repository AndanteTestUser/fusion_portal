// 端末内オプション保存(Vault)。
//
// 目的: セッション終了で消えるブラウザの sessionStorage とは別に、望むユーザーだけが
// APIキーを「この端末に限り」永続化できるようにする。localStorage に書き込むのは常に
// 暗号文のみで、平文のAPIキーやURLがそのまま保存されることはない。
//
// 構造:
//   - ランダムな AES-GCM-256 のデータキー(dataKeyBytes, 32byte)を1つ生成し、
//     実際のペイロード { keys, urls } はこのデータキーで暗号化する。
//   - データキー自体は、ユーザーが選んだ「解錠方法」ごとに個別にラップ(暗号化)して
//     保存する。解錠方法は現状2種類:
//       - passphrase: PBKDF2-SHA256(600,000回)で導出した鍵でラップ。1件のみ。
//       - passkey   : WebAuthn プラットフォーム認証器 + PRF 拡張の出力を
//                     HKDF-SHA256 に通した鍵でラップ。複数登録可。
//   - データキーそのものは呼び出し側の useRef 等、メモリ上にのみ保持される想定で、
//     この Vault モジュールが永続化することはない。
//
// このファイルはブラウザ(localStorage / navigator.credentials)と Node.js の両方から
// 呼べるよう、暗号処理そのもの(pure)とストレージ/WebAuthn 連携部分を分けている。
// Node 側のユニットテストは passphrase 経路の pure 関数のみを対象にする
// (WebAuthn は Node に存在しないため)。

export const STORAGE_KEY = 'fusion_portal_vault';
export const MIN_PASSPHRASE_LENGTH = 10;
export const PBKDF2_ITERATIONS = 600000;
export const HKDF_INFO = 'fusion-portal-vault-v1';
const VAULT_VERSION = 1;

export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'VaultError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 環境非依存のユーティリティ
// ---------------------------------------------------------------------------

function getSubtle() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new VaultError('NOT_SUPPORTED', 'この環境では Web Crypto API が利用できません');
  }
  return subtle;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function fromBase64(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const binary = atob(str);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importAesGcmKey(rawBytes) {
  return getSubtle().importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function aesGcmEncrypt(key, plaintextBytes) {
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes)
  );
  return { iv, ciphertext };
}

async function aesGcmDecrypt(key, iv, ciphertextBytes) {
  try {
    return new Uint8Array(await getSubtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertextBytes));
  } catch (e) {
    throw new VaultError('DECRYPT_FAILED', '復号に失敗しました');
  }
}

async function deriveKeyFromPassphrase(passphrase, salt, iterations) {
  const normalized = passphrase.normalize('NFKC');
  const keyMaterial = await getSubtle().importKey(
    'raw',
    new TextEncoder().encode(normalized),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return getSubtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveKeyFromPrfOutput(prfOutputBytes) {
  const keyMaterial = await getSubtle().importKey('raw', prfOutputBytes, 'HKDF', false, [
    'deriveKey',
  ]);
  return getSubtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function generateDataKeyBytes() {
  return randomBytes(32);
}

function assertPassphraseLength(passphrase) {
  if (!passphrase || passphrase.normalize('NFKC').length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError(
      'PASSPHRASE_TOO_SHORT',
      `パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上で入力してください`
    );
  }
}

async function encryptPayload(dataKeyBytes, payload) {
  const key = await importAesGcmKey(dataKeyBytes);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const { iv, ciphertext } = await aesGcmEncrypt(key, plaintext);
  return { payloadIv: toBase64(iv), payloadCiphertext: toBase64(ciphertext) };
}

async function decryptPayload(dataKeyBytes, vault) {
  const key = await importAesGcmKey(dataKeyBytes);
  const plaintext = await aesGcmDecrypt(key, fromBase64(vault.payloadIv), fromBase64(vault.payloadCiphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ---------------------------------------------------------------------------
// Pure な Vault 操作(ストレージ・WebAuthn に依存しない。Node からテスト可能)
// ---------------------------------------------------------------------------

// 新規に passphrase のみで保護された Vault を作成する。
export async function createPassphraseVault(passphrase, payload) {
  assertPassphraseLength(passphrase);
  const dataKeyBytes = generateDataKeyBytes();
  const salt = randomBytes(16);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const { iv, ciphertext } = await aesGcmEncrypt(wrappingKey, dataKeyBytes);
  const { payloadIv, payloadCiphertext } = await encryptPayload(dataKeyBytes, payload);

  const vault = {
    v: VAULT_VERSION,
    payloadIv,
    payloadCiphertext,
    prfSalt: null,
    wraps: [
      {
        id: 'passphrase',
        type: 'passphrase',
        salt: toBase64(salt),
        iterations: PBKDF2_ITERATIONS,
        iv: toBase64(iv),
        wrappedKey: toBase64(ciphertext),
      },
    ],
  };
  return { vault, dataKeyBytes };
}

// passphrase で解錠する。成功時は { dataKeyBytes, payload } を返す。
export async function unlockVaultWithPassphrase(vault, passphrase) {
  const wrap = vault.wraps.find((w) => w.type === 'passphrase');
  if (!wrap) throw new VaultError('NO_PASSPHRASE', 'この Vault にはパスフレーズが設定されていません');

  const wrappingKey = await deriveKeyFromPassphrase(passphrase, fromBase64(wrap.salt), wrap.iterations);
  let dataKeyBytes;
  try {
    dataKeyBytes = await aesGcmDecrypt(wrappingKey, fromBase64(wrap.iv), fromBase64(wrap.wrappedKey));
  } catch (e) {
    throw new VaultError('WRONG_PASSPHRASE', 'パスフレーズが正しくありません');
  }
  const payload = await decryptPayload(dataKeyBytes, vault);
  return { dataKeyBytes, payload };
}

// 既存の Vault(既に別の方法で解錠済み = dataKeyBytes を保持している状態)に
// passphrase 解錠方法を追加(既存があれば置き換え)する。
export async function addPassphraseWrap(vault, dataKeyBytes, passphrase) {
  assertPassphraseLength(passphrase);
  const salt = randomBytes(16);
  const wrappingKey = await deriveKeyFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const { iv, ciphertext } = await aesGcmEncrypt(wrappingKey, dataKeyBytes);
  const newWrap = {
    id: 'passphrase',
    type: 'passphrase',
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    iv: toBase64(iv),
    wrappedKey: toBase64(ciphertext),
  };
  const wraps = [...vault.wraps.filter((w) => w.type !== 'passphrase'), newWrap];
  return { ...vault, wraps };
}

// PRF出力から導出した鍵でデータキーをラップし、passkey 解錠方法を追加する。
export async function addPasskeyWrapFromPrf(vault, dataKeyBytes, credentialId, prfOutputBytes) {
  const wrappingKey = await deriveKeyFromPrfOutput(prfOutputBytes);
  const { iv, ciphertext } = await aesGcmEncrypt(wrappingKey, dataKeyBytes);
  const newWrap = {
    id: `passkey:${toBase64(credentialId)}`,
    type: 'passkey',
    credentialId: toBase64(credentialId),
    iv: toBase64(iv),
    wrappedKey: toBase64(ciphertext),
  };
  const wraps = [...vault.wraps.filter((w) => w.id !== newWrap.id), newWrap];
  return { ...vault, wraps };
}

// PRF出力から導出した鍵で該当 passkey wrap を解錠する。
export async function unlockPasskeyWrapFromPrf(vault, credentialId, prfOutputBytes) {
  const credentialIdB64 = toBase64(credentialId);
  const wrap = vault.wraps.find((w) => w.type === 'passkey' && w.credentialId === credentialIdB64);
  if (!wrap) throw new VaultError('UNKNOWN_CREDENTIAL', '登録されていないパスキーです');

  const wrappingKey = await deriveKeyFromPrfOutput(prfOutputBytes);
  let dataKeyBytes;
  try {
    dataKeyBytes = await aesGcmDecrypt(wrappingKey, fromBase64(wrap.iv), fromBase64(wrap.wrappedKey));
  } catch (e) {
    throw new VaultError('WRONG_PASSKEY', 'このパスキーでは解錠できませんでした');
  }
  const payload = await decryptPayload(dataKeyBytes, vault);
  return { dataKeyBytes, payload };
}

// ペイロードを再暗号化して保存する(自動保存用)。ラップ(解錠方法)には触れない。
export async function savePayloadToVault(vault, dataKeyBytes, payload) {
  const { payloadIv, payloadCiphertext } = await encryptPayload(dataKeyBytes, payload);
  return { ...vault, payloadIv, payloadCiphertext };
}

// 解錠方法を1つ削除する。最後の1件は削除できない(Vaultが永久に開けなくなるため)。
export function removeWrapFromVault(vault, wrapId) {
  if (vault.wraps.length <= 1) {
    throw new VaultError('LAST_WRAP', '最後に残った解錠方法は削除できません');
  }
  const wraps = vault.wraps.filter((w) => w.id !== wrapId);
  return { ...vault, wraps };
}

export function listWraps(vault) {
  return vault.wraps.map((w) =>
    w.type === 'passphrase' ? { id: w.id, type: 'passphrase' } : { id: w.id, type: 'passkey' }
  );
}

// ---------------------------------------------------------------------------
// ブラウザの localStorage との連携(暗号文のみを読み書きする)
// ---------------------------------------------------------------------------

export function hasVault() {
  try {
    return localStorage.getItem(STORAGE_KEY) != null;
  } catch (e) {
    return false;
  }
}

export function readVaultFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeVaultToStorage(vault) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
}

export function deleteVaultFromStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // localStorage が使えなくても致命的ではないため無視する
  }
}

// ---------------------------------------------------------------------------
// WebAuthn (passkey + PRF拡張) との連携
// ---------------------------------------------------------------------------

export function isPasskeySupported() {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

// 新しい WebAuthn 認証情報を作成し、PRF拡張の出力を取得する。
// 多くの実装では create() の時点では prf.results が返らず、直後に get() で
// アサーションを取ることで初めて実際のPRF出力が得られるため、その手順を踏む。
async function registerPasskeyCredential(prfSalt) {
  if (!isPasskeySupported()) {
    throw new VaultError('NOT_SUPPORTED', 'この端末はパスキーに対応していません');
  }

  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Fusion Portal' },
        user: { id: randomBytes(16), name: 'fusion-portal-vault', displayName: 'Fusion Portal Vault' },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },
          { alg: -257, type: 'public-key' },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      throw new VaultError('CANCELLED', 'パスキーの登録がキャンセルされました');
    }
    throw new VaultError('NOT_SUPPORTED', 'パスキーを登録できませんでした');
  }

  const createResults = credential.getClientExtensionResults();
  if (!createResults || !createResults.prf || !createResults.prf.enabled) {
    throw new VaultError(
      'PRF_UNSUPPORTED',
      'この端末・ブラウザのパスキーは Vault に必要な機能(PRF拡張)に対応していません'
    );
  }

  let prfOutput = createResults.prf.results && createResults.prf.results.first;
  if (!prfOutput) {
    let assertion;
    try {
      assertion = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ id: credential.rawId, type: 'public-key' }],
          userVerification: 'required',
          extensions: { prf: { eval: { first: prfSalt } } },
        },
      });
    } catch (e) {
      throw new VaultError('PRF_UNSUPPORTED', 'パスキーからPRF出力を取得できませんでした');
    }
    prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
  }

  if (!prfOutput) {
    throw new VaultError(
      'PRF_UNSUPPORTED',
      'この端末・ブラウザのパスキーは Vault に必要な機能(PRF拡張)に対応していません'
    );
  }

  return { credentialId: new Uint8Array(credential.rawId), prfOutput: new Uint8Array(prfOutput) };
}

async function getPasskeyAssertionPrfOutput(vault) {
  const allowCredentials = vault.wraps
    .filter((w) => w.type === 'passkey')
    .map((w) => ({ id: fromBase64(w.credentialId), type: 'public-key' }));

  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials,
        userVerification: 'required',
        extensions: { prf: { eval: { first: fromBase64(vault.prfSalt) } } },
      },
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      throw new VaultError('CANCELLED', 'パスキーの操作がキャンセルされました');
    }
    throw new VaultError('NOT_SUPPORTED', 'パスキーを利用できませんでした');
  }

  const prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!prfOutput) {
    throw new VaultError('PRF_UNSUPPORTED', 'パスキーからPRF出力を取得できませんでした');
  }
  return { credentialId: new Uint8Array(assertion.rawId), prfOutput: new Uint8Array(prfOutput) };
}

// ---------------------------------------------------------------------------
// 高水準API(SettingsPage から呼び出す想定。ストレージ読み書きまで面倒を見る)
// ---------------------------------------------------------------------------

export async function createVaultWithPassphrase(passphrase, payload) {
  const { vault, dataKeyBytes } = await createPassphraseVault(passphrase, payload);
  writeVaultToStorage(vault);
  return dataKeyBytes;
}

export async function createVaultWithPasskey(payload) {
  const prfSalt = randomBytes(32);
  const { credentialId, prfOutput } = await registerPasskeyCredential(prfSalt);
  const dataKeyBytes = generateDataKeyBytes();
  const { payloadIv, payloadCiphertext } = await encryptPayload(dataKeyBytes, payload);
  let vault = {
    v: VAULT_VERSION,
    payloadIv,
    payloadCiphertext,
    prfSalt: toBase64(prfSalt),
    wraps: [],
  };
  vault = await addPasskeyWrapFromPrf(vault, dataKeyBytes, credentialId, prfOutput);
  writeVaultToStorage(vault);
  return dataKeyBytes;
}

export async function unlockStoredVaultWithPassphrase(passphrase) {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  return unlockVaultWithPassphrase(vault, passphrase);
}

export async function unlockStoredVaultWithPasskey() {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  const { credentialId, prfOutput } = await getPasskeyAssertionPrfOutput(vault);
  return unlockPasskeyWrapFromPrf(vault, credentialId, prfOutput);
}

export async function addPasskeyToStoredVault(dataKeyBytes) {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  const prfSalt = vault.prfSalt ? fromBase64(vault.prfSalt) : randomBytes(32);
  const { credentialId, prfOutput } = await registerPasskeyCredential(prfSalt);
  const next = await addPasskeyWrapFromPrf(
    { ...vault, prfSalt: toBase64(prfSalt) },
    dataKeyBytes,
    credentialId,
    prfOutput
  );
  writeVaultToStorage(next);
}

export async function addPassphraseToStoredVault(dataKeyBytes, passphrase) {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  const next = await addPassphraseWrap(vault, dataKeyBytes, passphrase);
  writeVaultToStorage(next);
}

export function removeWrapFromStoredVault(wrapId) {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  const next = removeWrapFromVault(vault, wrapId);
  writeVaultToStorage(next);
}

export function listStoredWraps() {
  const vault = readVaultFromStorage();
  return vault ? listWraps(vault) : [];
}

export async function autosavePayloadToStoredVault(dataKeyBytes, payload) {
  const vault = readVaultFromStorage();
  if (!vault) throw new VaultError('NO_VAULT', 'Vault が作成されていません');
  const next = await savePayloadToVault(vault, dataKeyBytes, payload);
  writeVaultToStorage(next);
}

export function deleteVault() {
  deleteVaultFromStorage();
}
