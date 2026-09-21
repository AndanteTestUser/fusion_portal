import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addImageToList,
  removeImageFromList,
  setTargetPathInList,
  setPersistedInList,
  getImageToApply,
  mergeGasImages,
} from '../src/lib/wkImageStore.js';

const makeImage = (overrides = {}) => ({
  id: overrides.id || `img-${Math.random()}`,
  dataUrl: 'data:image/jpeg;base64,AAA',
  filename: 'a.jpg',
  targetPath: null,
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

test('setTargetPathInList pins an image and evicts a conflicting one back to the pool', () => {
  const list = [
    makeImage({ id: '1', targetPath: '/generator' }),
    makeImage({ id: '2', targetPath: null }),
  ];
  const next = setTargetPathInList(list, '2', '/generator');
  assert.equal(next.find((img) => img.id === '1').targetPath, null);
  assert.equal(next.find((img) => img.id === '2').targetPath, '/generator');
});

test('setTargetPathInList with null unpins back to the pool', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator' })];
  const next = setTargetPathInList(list, '1', null);
  assert.equal(next[0].targetPath, null);
});

test('setPersistedInList toggles only the matching image', () => {
  const list = [makeImage({ id: '1' }), makeImage({ id: '2' })];
  const next = setPersistedInList(list, '1', true);
  assert.equal(next.find((img) => img.id === '1').persisted, true);
  assert.equal(next.find((img) => img.id === '2').persisted, false);
});

test('getImageToApply prefers an image pinned to the requested path', () => {
  const list = [
    makeImage({ id: '1', targetPath: null, createdAt: 2 }),
    makeImage({ id: '2', targetPath: '/generator', createdAt: 1 }),
  ];
  assert.equal(getImageToApply(list, '/generator').id, '2');
});

test('getImageToApply falls back to the newest pooled (unpinned) image', () => {
  const list = [
    makeImage({ id: '1', targetPath: null }),
    makeImage({ id: '2', targetPath: null }),
  ];
  assert.equal(getImageToApply(list, '/banzai-pose').id, '2');
});

test('getImageToApply returns null when nothing is applicable', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator' })];
  assert.equal(getImageToApply(list, '/banzai-pose'), null);
});

test('mergeGasImages adds only new ids', () => {
  const list = [makeImage({ id: '1' })];
  const gasImages = [
    { id: '1', dataUrl: 'dup' },
    { id: '2', dataUrl: 'new', targetPath: null },
  ];
  const next = mergeGasImages(list, gasImages);
  assert.equal(next.length, 2);
});

test('mergeGasImages pins images that specify a targetPath, evicting conflicts', () => {
  const list = [makeImage({ id: '1', targetPath: '/generator' })];
  const gasImages = [{ id: '2', dataUrl: 'new', targetPath: '/generator' }];
  const next = mergeGasImages(list, gasImages);
  assert.equal(next.find((img) => img.id === '1').targetPath, null);
  assert.equal(next.find((img) => img.id === '2').targetPath, '/generator');
});

test('mergeGasImages adds images without targetPath to the pool', () => {
  const next = mergeGasImages([], [{ id: '1', dataUrl: 'x' }]);
  assert.equal(next[0].targetPath, null);
});
