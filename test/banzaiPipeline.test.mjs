import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBanzaiTargets, excludeConnectedOverlap, openAIOutputSize, parseStructuredJson } from '../src/lib/banzaiPipeline.js';

// 5x1 strip: an occluder blob at x=0..2 whose rightmost pixel (x=2) touches
// an arm-mask pixel at x=2..4. The two blobs are unconnected to each other
// within maskData itself; excludeConnectedOverlap should drop the whole
// left-hand blob (x=0,1,2), not just x=2 where the overlap is.
function makeRgba(alphas) {
  const data = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((a, i) => { data[i * 4 + 3] = a; });
  return data;
}

test('excludeConnectedOverlap drops an entire component touching the reference, not just the shared pixel', () => {
  const mask = makeRgba([255, 255, 255, 0, 0]);
  const ref = makeRgba([0, 0, 255, 255, 0]);
  const result = excludeConnectedOverlap(5, 1, mask, ref);
  assert.deepEqual(Array.from(result.filter((_, i) => i % 4 === 3)), [0, 0, 0, 0, 0]);
});

test('excludeConnectedOverlap keeps a component that never touches the reference', () => {
  const mask = makeRgba([255, 255, 0, 0, 0]);
  const ref = makeRgba([0, 0, 0, 255, 255]);
  const result = excludeConnectedOverlap(5, 1, mask, ref);
  assert.deepEqual(Array.from(result.filter((_, i) => i % 4 === 3)), [255, 255, 0, 0, 0]);
});

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

test('parseStructuredJson accepts fenced JSON', () => {
  assert.deepEqual(parseStructuredJson('```json\n{"found":true}\n```'), { found: true });
});

test('parseStructuredJson extracts JSON from explanatory text', () => {
  assert.deepEqual(parseStructuredJson('Result follows:\n{"found":false}\nDone.'), { found: false });
});

test('parseStructuredJson reports malformed output without retrying', () => {
  assert.throws(() => parseStructuredJson('{"found":'), /APIへの再送信はしていません/);
});
