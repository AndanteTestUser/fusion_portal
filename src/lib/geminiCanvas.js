export const GEMINI_CANVAS_MODEL = 'gemini-3.1-flash-image';

export function parseTags(raw) {
  return String(raw || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .split(/[,\n]/)
    .map((tag) => tag.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .slice(0, 40);
}

export function buildGeminiCanvasPrompt({
  mode,
  situation,
  style,
  face,
  negative,
  addLightEffects = false,
  clarifyClothing = false,
}) {
  const preserve = [
    '[CRITICAL IMAGE-TO-IMAGE INSTRUCTION]',
    'Preserve the source image composition, camera, framing, aspect ratio, character count, character identity, pose, limb ownership, spatial relationships, contact points, clothing, props, and background unless a change is explicitly requested below.',
    'Treat the image itself as the source of truth. The context text is descriptive and must not override visible geometry.',
    'Do not add, remove, merge, swap, rotate, or reposition characters.',
  ].join('\n');

  const request = mode === 'direct'
    ? [
        'REQUESTED CHANGE: Render every depicted person as an unmistakably adult woman with mature facial proportions and a polished anime illustration finish.',
        'STYLE: mature adult proportions, tall stature, slender build, detailed face, detailed shading, intricate details.',
        'AVOID: childlike proportions, chibi proportions, oversized eyes, round juvenile face, deformed anatomy, flat coloring.',
      ].join('\n')
    : [
        ['IMAGE CONTEXT (reference only)', situation],
        ['REQUESTED STYLE / BODY', style],
        ['REQUESTED FACE / EXPRESSION / QUALITY', face],
        ['AVOID', negative],
      ]
        .map(([label, value]) => [label, String(value || '').trim()])
        .filter(([, value]) => value)
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');

  const optional = [];
  if (addLightEffects) optional.push('OPTIONAL CHANGE: Add subtle abstract glowing light effects without replacing or moving existing objects.');
  if (clarifyClothing) optional.push('OPTIONAL CHANGE: Use clearly adult, non-revealing sleeveless clothing while preserving garment colors and silhouette as closely as possible.');

  return [preserve, request, ...optional].filter(Boolean).join('\n\n');
}

export function sliderPositionFromClientX(clientX, left, width) {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return 50;
  return Math.max(0, Math.min(100, ((clientX - left) / width) * 100));
}

export function getGeminiErrorMessage(status, payload) {
  const detail = payload?.error?.message || payload?.error?.status || '';
  if (status === 401 || status === 403) return 'Gemini APIキーまたは利用権限を確認してください。';
  if (status === 429) return 'Gemini APIの利用上限に達しました。時間を置いて再実行してください。';
  return `${status} ${detail || 'Gemini API通信エラー'}`;
}

export function isRetryableGeminiStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
