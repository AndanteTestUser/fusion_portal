import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPassphraseVault,
  unlockVaultWithPassphrase,
  addPassphraseWrap,
  savePayloadToVault,
  removeWrapFromVault,
  listWraps,
  VaultError,
  MIN_PASSPHRASE_LENGTH,
} from '../src/lib/vault.js';

const samplePayload = () => ({
  keys: { gemini: 'gemini-secret-key', openai: '' },
  urls: { gemini: '', openai: 'https://example.com/keys' },
});

test('createPassphraseVault + unlockVaultWithPassphrase round-trips the payload', async () => {
  const payload = samplePayload();
  const { vault, dataKeyBytes } = await createPassphraseVault('correct horse battery', payload);

  assert.equal(vault.wraps.length, 1);
  assert.equal(vault.wraps[0].type, 'passphrase');
  assert.equal(dataKeyBytes.length, 32);
  // ストレージに保存される内容は暗号文のみで、平文キーを含んではならない
  const serialized = JSON.stringify(vault);
  assert.ok(!serialized.includes('gemini-secret-key'));

  const { dataKeyBytes: unlockedKey, payload: decrypted } = await unlockVaultWithPassphrase(
    vault,
    'correct horse battery'
  );
  assert.deepEqual(decrypted, payload);
  assert.deepEqual(Array.from(unlockedKey), Array.from(dataKeyBytes));
});

test('unlockVaultWithPassphrase rejects a wrong passphrase', async () => {
  const { vault } = await createPassphraseVault('correct horse battery', samplePayload());
  await assert.rejects(
    () => unlockVaultWithPassphrase(vault, 'wrong passphrase!!'),
    (err) => err instanceof VaultError && err.code === 'WRONG_PASSPHRASE'
  );
});

test('createPassphraseVault rejects short passphrases', async () => {
  await assert.rejects(
    () => createPassphraseVault('short', samplePayload()),
    (err) => err instanceof VaultError && err.code === 'PASSPHRASE_TOO_SHORT'
  );
  assert.ok(MIN_PASSPHRASE_LENGTH >= 10);
});

test('passphrase is normalized with NFKC before deriving the wrapping key', async () => {
  // "ｱ" (半角) と "ア" (全角) は NFKC で同一視される
  const halfWidth = 'password１２３ｱ'; // eslint-disable-line no-irregular-whitespace
  const fullWidthEquivalent = 'password123ア';
  const { vault } = await createPassphraseVault(halfWidth, samplePayload());
  const { payload } = await unlockVaultWithPassphrase(vault, fullWidthEquivalent);
  assert.deepEqual(payload, samplePayload());
});

test('savePayloadToVault re-encrypts without touching existing wraps', async () => {
  const { vault, dataKeyBytes } = await createPassphraseVault('correct horse battery', samplePayload());
  const updatedPayload = { keys: { gemini: 'updated-key', openai: 'openai-key' }, urls: {} };
  const nextVault = await savePayloadToVault(vault, dataKeyBytes, updatedPayload);

  assert.deepEqual(nextVault.wraps, vault.wraps);
  const { payload } = await unlockVaultWithPassphrase(nextVault, 'correct horse battery');
  assert.deepEqual(payload, updatedPayload);
});

test('addPassphraseWrap replaces the previous passphrase wrap (single slot)', async () => {
  const { vault, dataKeyBytes } = await createPassphraseVault('correct horse battery', samplePayload());
  const nextVault = await addPassphraseWrap(vault, dataKeyBytes, 'a brand new passphrase');

  assert.equal(nextVault.wraps.filter((w) => w.type === 'passphrase').length, 1);
  await assert.rejects(() => unlockVaultWithPassphrase(nextVault, 'correct horse battery'));
  const { payload } = await unlockVaultWithPassphrase(nextVault, 'a brand new passphrase');
  assert.deepEqual(payload, samplePayload());
});

test('removeWrapFromVault refuses to remove the last remaining wrap', async () => {
  const { vault } = await createPassphraseVault('correct horse battery', samplePayload());
  assert.equal(listWraps(vault).length, 1);
  assert.throws(
    () => removeWrapFromVault(vault, vault.wraps[0].id),
    (err) => err instanceof VaultError && err.code === 'LAST_WRAP'
  );
});

test('removeWrapFromVault removes a non-last wrap successfully', async () => {
  const { vault: base, dataKeyBytes } = await createPassphraseVault('correct horse battery', samplePayload());
  // 2つ目の解錠方法があるケースをシミュレートするため、ダミーの passkey wrap を追加する
  const withExtraWrap = {
    ...base,
    wraps: [...base.wraps, { id: 'passkey:dummy', type: 'passkey', credentialId: 'dummy', iv: '', wrappedKey: '' }],
  };
  const next = removeWrapFromVault(withExtraWrap, 'passkey:dummy');
  assert.equal(next.wraps.length, 1);
  const { payload } = await unlockVaultWithPassphrase(next, 'correct horse battery');
  assert.deepEqual(payload, samplePayload());
  void dataKeyBytes;
});
