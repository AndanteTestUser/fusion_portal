import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionCorridorBounds,
  connectionWidthForBounds,
  defaultConnectionAnchor,
  transformPoint,
} from '../src/lib/moveConnection.js';

test('transformPoint applies translation to the attachment point', () => {
  const bounds = { x: 10, y: 20, width: 40, height: 20 };
  const p = { x: 30, y: 30 };
  assert.deepEqual(transformPoint(p, bounds, { x: 15, y: -5 }, 0), { x: 45, y: 25 });
});

test('transformPoint rotates around part center before translation', () => {
  const bounds = { x: 0, y: 0, width: 20, height: 20 };
  const p = transformPoint({ x: 20, y: 10 }, bounds, { x: 5, y: 0 }, 90);
  assert.ok(Math.abs(p.x - 15) < 1e-9);
  assert.ok(Math.abs(p.y - 20) < 1e-9);
});

test('connection corridor covers both attachment endpoints and clamps to canvas', () => {
  const b = connectionCorridorBounds({ x: 5, y: 5 }, { x: 95, y: 70 }, 20, 100, 80);
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
  assert.equal(b.x + b.width, 100);
  assert.equal(b.y + b.height, 80);
});

test('fallback anchor and corridor width are stable', () => {
  const bounds = { x: 20, y: 30, width: 60, height: 40 };
  assert.deepEqual(defaultConnectionAnchor(bounds), { x: 50, y: 50 });
  assert.equal(connectionWidthForBounds(bounds), 16.8);
});
