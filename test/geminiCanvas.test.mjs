import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeminiCanvasPrompt,
  getGeminiErrorMessage,
  isRetryableGeminiStatus,
  parseTags,
} from '../src/lib/geminiCanvas.js';

test('parseTags accepts comma and newline separated model output', () => {
  assert.deepEqual(parseTags('```text\n2 adult women, overhead view\n- full body\n```'), [
    '2 adult women',
    'overhead view',
    'full body',
  ]);
});

test('specialized prompt treats analysis as context and preserves geometry', () => {
  const prompt = buildGeminiCanvasPrompt({
    mode: 'specialized',
    situation: 'two adults, overhead view',
    style: 'anime illustration',
    face: 'gentle expression',
    negative: 'bad anatomy',
  });
  assert.match(prompt, /image itself as the source of truth/i);
  assert.match(prompt, /Do not add, remove, merge, swap, rotate, or reposition characters/);
  assert.match(prompt, /two adults, overhead view/);
  assert.match(prompt, /anime illustration/);
});

test('optional changes are included only when selected', () => {
  const prompt = buildGeminiCanvasPrompt({ mode: 'direct', addLightEffects: true, clarifyClothing: true });
  assert.match(prompt, /glowing light effects/);
  assert.match(prompt, /non-revealing sleeveless clothing/);
});

test('only transient Gemini statuses are automatically retryable', () => {
  assert.equal(isRetryableGeminiStatus(429), true);
  assert.equal(isRetryableGeminiStatus(503), true);
  assert.equal(isRetryableGeminiStatus(400), false);
  assert.equal(isRetryableGeminiStatus(403), false);
});

test('Gemini auth errors have a user-facing message', () => {
  assert.match(getGeminiErrorMessage(403, {}), /APIキー/);
});
