import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../gas/SettingStore.gs', import.meta.url), 'utf8');
const seeds = [
  'seed-overhang-delta.json',
  'seed-tea-time-trap.json',
].map((name) => JSON.parse(readFileSync(new URL(`../gas/seed-settings/${name}`, import.meta.url), 'utf8')));

function makeScript() {
  const records = seeds.map((record) => ({
    getName: () => `${record.id}.json`,
    getBlob: () => ({ getDataAsString: () => JSON.stringify(record) }),
  }));
  const iterator = (list) => { let index = 0; return { hasNext: () => index < list.length, next: () => list[index++] }; };
  const folder = {
    getFiles: () => iterator(records),
    getFilesByName: (name) => iterator(records.filter((file) => file.getName() === name)),
    createFile: (blob) => {
      const file = { getName: () => blob.name, getBlob: () => ({ getDataAsString: () => blob.text }), setTrashed: () => {} };
      records.push(file);
      return file;
    },
  };
  const context = {
    Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => key === 'SETTING_STORE_SECRET' ? 'test-secret' : 'folder-id' }) },
    DriveApp: { getFolderById: () => folder },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (value) => ({ setMimeType: () => JSON.parse(value) }) },
    Utilities: { newBlob: (text, type, name) => ({ text, type, name }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  };
  vm.runInNewContext(source, context);
  return { context, records };
}

test('migrated records are returned from the Workspace folder, without UI mocks', () => {
  const { context } = makeScript();
  const response = context.doGet({ parameter: { action: 'list', secret: 'test-secret' } });
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.settings, (record) => record.id), ['seed-overhang-delta', 'seed-tea-time-trap']);
  assert.equal(response.settings[0].generatedImageFileId, null);
});

test('a repeated save request returns one record', () => {
  const { context, records } = makeScript();
  const request = { postData: { contents: JSON.stringify({ action: 'save', secret: 'test-secret', requestId: 'repeat-123', title: 'テスト', text: '本文' }) } };
  const first = context.doPost(request);
  const second = context.doPost(request);
  assert.equal(first.ok, true);
  assert.equal(second.setting.id, first.setting.id);
  assert.equal(records.length, seeds.length + 1);
});
