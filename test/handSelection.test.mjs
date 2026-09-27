import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convexHull,
  handSelectionPolygon,
  nearestHand,
} from '../src/lib/handSelection.js';

test('nearestHand returns the candidate closest to the tap', () => {
  const hands = [
    { center: { x: 20, y: 20 } },
    { center: { x: 80, y: 80 } },
  ];
  assert.equal(nearestHand(hands, { x: 74, y: 76 }, 50), hands[1]);
  assert.equal(nearestHand(hands, { x: 200, y: 200 }, 30), null);
});

test('convexHull drops interior points', () => {
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 5, y: 5 },
  ]);
  assert.equal(hull.length, 4);
});

test('forearm selection extends farther behind the wrist than hand-only selection', () => {
  // Synthetic upright hand: wrist at y=80, fingers toward y=20.
  const points = Array.from({ length: 21 }, (_, i) => ({ x: 50, y: 50 }));
  points[0] = { x: 50, y: 80 };
  points[5] = { x: 38, y: 55 };
  points[9] = { x: 50, y: 52 };
  points[12] = { x: 50, y: 20 };
  points[17] = { x: 62, y: 55 };
  points[4] = { x: 25, y: 45 };
  points[8] = { x: 40, y: 22 };
  points[16] = { x: 60, y: 22 };
  points[20] = { x: 72, y: 40 };

  const hand = { points, center: { x: 50, y: 50 } };
  const handOnly = handSelectionPolygon(hand, 'hand', 100, 140);
  const forearm = handSelectionPolygon(hand, 'hand_forearm', 100, 140);

  const handMaxY = Math.max(...handOnly.map((p) => p.y));
  const forearmMaxY = Math.max(...forearm.map((p) => p.y));
  assert.ok(forearmMaxY > handMaxY + 10);
  assert.ok(forearm.every((p) => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 140));
});
