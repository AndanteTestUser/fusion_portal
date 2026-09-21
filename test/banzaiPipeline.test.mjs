import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBanzaiTargets, openAIOutputSize } from '../src/lib/banzaiPipeline.js';

test('targets follow the subject head direction rather than the top of the image', () => {
  const points = {
    head: { x: 70, y: 120 }, torso: { x: 240, y: 120 },
    leftShoulder: { x: 180, y: 90 }, rightShoulder: { x: 180, y: 150 },
  };
  const targets = estimateBanzaiTargets(points);
  assert.ok(targets.leftHand.x < points.head.x);
  assert.ok(targets.rightHand.x < points.head.x);
  assert.equal(targets.leftHand.y, points.leftShoulder.y);
  assert.equal(targets.rightHand.y, points.rightShoulder.y);
});

test('output dimensions preserve common aspect ratios within OpenAI constraints', () => {
  for (const [w, h] of [[1600, 900], [900, 1600], [1024, 1024], [3000, 1000]]) {
    const [outW, outH] = openAIOutputSize(w, h).split('x').map(Number);
    assert.equal(outW % 16, 0);
    assert.equal(outH % 16, 0);
    assert.ok(outW * outH >= 655360);
    assert.ok(Math.abs(outW / outH - w / h) < 0.02);
  }
  assert.throws(() => openAIOutputSize(4000, 800), /縦横比/);
});

test('invalid and incomplete landmarks cannot produce a target', () => {
  assert.equal(estimateBanzaiTargets({}), null);
  assert.equal(estimateBanzaiTargets({
    head: { x: 0, y: 0 }, torso: { x: 0, y: 0 },
    leftShoulder: { x: 1, y: 1 }, rightShoulder: { x: 2, y: 2 },
  }), null);
});
