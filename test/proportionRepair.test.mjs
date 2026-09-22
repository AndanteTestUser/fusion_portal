import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRepairPrompt,
  clampComparisonPosition,
  comparisonPositionFromClientX,
  normalizedDimensions,
  normalizeSelectionRect,
  stretchedDimensions,
} from '../src/lib/proportionRepair.js';

test('stretchedDimensions keeps width and stretches height by four thirds', () => {
  assert.deepEqual(stretchedDimensions(584, 1000), { width: 584, height: 1333 });
});

test('normalizedDimensions restores the exact original pixel dimensions', () => {
  assert.deepEqual(normalizedDimensions(584, 1000), { width: 584, height: 1000 });
});

test('selection rectangle is normalized and clamped to the image', () => {
  assert.deepEqual(normalizeSelectionRect({ x: 80, y: 90 }, { x: -5, y: 20 }, 100, 100), {
    x: 0, y: 20, width: 80, height: 70,
  });
});

test('comparison pointer position is touch-safe and clamped', () => {
  assert.equal(comparisonPositionFromClientX(75, 25, 100), 50);
  assert.equal(comparisonPositionFromClientX(-20, 0, 100), 0);
  assert.equal(clampComparisonPosition(140), 100);
});

test('repair prompt freezes manually adjusted proportions and scene geometry', () => {
  const prompt = buildRepairPrompt('repair the gray patch');
  assert.match(prompt, /head-to-body proportions exactly/i);
  assert.match(prompt, /Preserve every character identity/);
  assert.match(prompt, /repair the gray patch/);
});

