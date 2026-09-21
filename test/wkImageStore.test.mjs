import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addImageToList,
  removeImageFromList,
  setCheckedInList,
  setTargetPathInList,
  setPersistedInList,
  getCheckedForPath,
  mergeGasImages,
} from '../src/lib/wkImageStore.js';

const makeImage = (overrides = {}) => ({
  id: overrides.id || `img-${Math.random()}`,
  dataUrl: 'data:image/jpeg;base64,AAA',
  filename: 'a.jpg',
  targetPath: null,
  checked: false,
  persisted: false,
  source: 'upload',
  createdAt: 0,
  ...overrides,
});

test('addImageToList appends without mutating the original list', () => {
  const list = [makeImage({ id: '1' })];
  const next = addImageToList(list, makeImage({ id: '2' }));
  assert.equal(list.length, 1);
  assert.equal(next.length, 2);
});

test('removeImageFromList removes only the matching id', () => {
  const list = [makeImage({ id: '1' }), makeImage({ id: '2' })];
  const next = removeImageFromList(list, '1');
  assert.deepEqual(next.map((img) => img.id), ['2']);
});

test('setCheckedInList enforces one checked image per targetPath', () => {
  const list = [
    makeImage({ id: '1', targetPath: '/generator', checked: true }),
    makeImage({ id: '2', targetPath: '/generator', checked: false }),
    makeImage({ id: '3', targetPath: '/banzai-pose', checked: true }),
  ];

  const next = setCheckedInList(list, '2', true);
  assert.equal(next.find((img) => img.id === '1').checked, false);
  assert.equal(next.find((img) => img.id === '2').checked, true);
  // 別のtargetPathのチェック状態には影響しない
  assert.equal(next.find((img) => img.id === '3').checked, true);
});

test('setCheckedInList allows unchecking without affecting others', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator', checked: true })];
  const next = setCheckedInList(list, '1', false);
  assert.equal(next[0].checked, false);
});

test('setTargetPathInList moves an image and keeps checked state', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator', checked: true })];
  const next = setTargetPathInList(list, '1', '/banzai-pose');
  assert.equal(next[0].targetPath, '/banzai-pose');
  assert.equal(next[0].checked, true);
});

test('setTargetPathInList unchecks a conflicting image already checked at the destination', () => {
  const list = [
    makeImage({ id: '1', targetPath: '/generator', checked: true }),
    makeImage({ id: '2', targetPath: '/banzai-pose', checked: true }),
  ];
  const next = setTargetPathInList(list, '1', '/banzai-pose');
  assert.equal(next.find((img) => img.id === '1').checked, true);
  assert.equal(next.find((img) => img.id === '2').checked, false);
});

test('setPersistedInList toggles only the matching image', () => {
  const list = [makeImage({ id: '1' }), makeImage({ id: '2' })];
  const next = setPersistedInList(list, '1', true);
  assert.equal(next.find((img) => img.id === '1').persisted, true);
  assert.equal(next.find((img) => img.id === '2').persisted, false);
});

test('getCheckedForPath returns the checked image for a path or null', () => {
  const list = [
    makeImage({ id: '1', targetPath: '/generator', checked: false }),
    makeImage({ id: '2', targetPath: '/generator', checked: true }),
  ];
  assert.equal(getCheckedForPath(list, '/generator').id, '2');
  assert.equal(getCheckedForPath(list, '/banzai-pose'), null);
});

test('mergeGasImages adds only new ids and respects per-path exclusivity', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator', checked: true })];
  const gasImages = [
    { id: '1', dataUrl: 'dup', targetPath: '/generator', checked: true },
    { id: '2', dataUrl: 'new', targetPath: '/generator', checked: true },
    { id: '3', dataUrl: 'new2', targetPath: null, checked: false },
  ];
  const next = mergeGasImages(list, gasImages);

  assert.equal(next.length, 3);
  assert.equal(next.find((img) => img.id === '1').checked, false);
  assert.equal(next.find((img) => img.id === '2').checked, true);
  assert.equal(next.find((img) => img.id === '3').targetPath, null);
});

test('mergeGasImages ignores checked=true when targetPath is missing', () => {
  const list = [];
  const gasImages = [{ id: '1', dataUrl: 'x', targetPath: null, checked: true }];
  const next = mergeGasImages(list, gasImages);
  assert.equal(next[0].checked, false);
});
