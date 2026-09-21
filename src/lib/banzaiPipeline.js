export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.5-sunburst';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function copyCanvas(source) {
  const copy = makeCanvas(source.width, source.height);
  copy.getContext('2d').drawImage(source, 0, 0);
  return copy;
}

export function maskHasPaint(mask) {
  const { data } = mask.getContext('2d').getImageData(0, 0, mask.width, mask.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

// The brush canvas stores selected pixels as opaque white. OpenAI expects the
// editable region to be transparent and the protected region to be opaque.
export function toOpenAIMask(selection) {
  const result = makeCanvas(selection.width, selection.height);
  const ctx = result.getContext('2d');
  const pixels = ctx.createImageData(result.width, result.height);
  const selected = selection.getContext('2d').getImageData(0, 0, result.width, result.height).data;
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    pixels.data[i + 3] = 255 - selected[i + 3];
  }
  ctx.putImageData(pixels, 0, 0);
  return result;
}

export function composeSelected(base, generated, selection) {
  const output = copyCanvas(base);
  const generatedCanvas = makeCanvas(base.width, base.height);
  generatedCanvas.getContext('2d').drawImage(generated, 0, 0, base.width, base.height);
  const ctx = generatedCanvas.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(selection, 0, 0);
  output.getContext('2d').drawImage(generatedCanvas, 0, 0);
  return output;
}

export function selectedChangeRatio(before, after, selection) {
  const prior = before.getContext('2d').getImageData(0, 0, before.width, before.height).data;
  const next = after.getContext('2d').getImageData(0, 0, before.width, before.height).data;
  const mask = selection.getContext('2d').getImageData(0, 0, before.width, before.height).data;
  let selected = 0;
  let changed = 0;
  for (let i = 0; i < prior.length; i += 4) {
    if (mask[i + 3] < 128) continue;
    selected++;
    if (Math.abs(prior[i] - next[i]) + Math.abs(prior[i + 1] - next[i + 1]) + Math.abs(prior[i + 2] - next[i + 2]) > 30) changed++;
  }
  return selected ? changed / selected : 0;
}

export function restoreOccluder(edited, original, occluderMask) {
  // Pixel-for-pixel restoration of the front layer in its original coordinates.
  return composeSelected(edited, original, occluderMask);
}

export function estimateBanzaiTargets({ head, leftShoulder, rightShoulder, torso }) {
  if (!head || !leftShoulder || !rightShoulder || !torso) return null;
  const shoulderCenter = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const forward = { x: head.x - torso.x, y: head.y - torso.y };
  const length = Math.hypot(forward.x, forward.y);
  const shoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
  if (length < 0.01 || shoulderWidth < 0.01) return null;
  const direction = { x: forward.x / length, y: forward.y / length };
  const headDistance = Math.hypot(head.x - shoulderCenter.x, head.y - shoulderCenter.y);
  const extension = Math.max(shoulderWidth * 1.6, headDistance + shoulderWidth * 0.65);
  return {
    leftHand: { x: leftShoulder.x + direction.x * extension, y: leftShoulder.y + direction.y * extension },
    rightHand: { x: rightShoulder.x + direction.x * extension, y: rightShoulder.y + direction.y * extension },
  };
}

export function makePoseGuide(image, landmarks, targets) {
  const guide = copyCanvas(image);
  const ctx = guide.getContext('2d');
  const width = Math.max(12, image.width / 90);
  ctx.strokeStyle = '#00ff33'; ctx.fillStyle = '#00ff33';
  ctx.lineWidth = width; ctx.lineCap = 'round';
  for (const [side, hand] of [['left', targets.leftHand], ['right', targets.rightHand]]) {
    const shoulder = landmarks[`${side}Shoulder`];
    ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(hand.x, hand.y, width * 1.2, 0, Math.PI * 2); ctx.fill();
  }
  return guide;
}

export function openAIOutputSize(width, height) {
  const ratio = width / height;
  if (ratio > 3 || ratio < 1 / 3) throw new Error('OpenAIの画像出力に対応する縦横比は1:3から3:1です');
  const longest = 1536;
  let w = ratio >= 1 ? longest : Math.round(longest * ratio / 16) * 16;
  let h = ratio >= 1 ? Math.round(longest / ratio / 16) * 16 : longest;
  if (w * h < 655360) {
    const scale = Math.sqrt(655360 / (w * h));
    w = Math.min(3840, Math.ceil(w * scale / 16) * 16);
    h = Math.min(3840, Math.ceil(h * scale / 16) * 16);
  }
  return `${w}x${h}`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG変換に失敗しました'))), 'image/png')
  );
}

async function responseError(response) {
  let detail = '';
  try {
    const json = await response.json();
    detail = json.error?.message || json.error?.status || '';
  } catch { /* response can be empty */ }
  throw new Error(`${response.status} ${detail || 'API通信エラー'}`);
}

async function decodeBase64Image(data, mimeType = 'image/png') {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('生成画像を読み込めませんでした'));
    image.src = `data:${mimeType};base64,${data}`;
  });
}

export async function editWithProvider({ provider, key, image, selection, guide, prompt, signal }) {
  if (!key) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Gemini'}のAPIキーを設定してください`);
  if (provider === 'openai') {
    const form = new FormData();
    form.append('model', DEFAULT_OPENAI_MODEL);
    form.append('prompt', prompt);
    form.append('size', openAIOutputSize(image.width, image.height));
    form.append('image[]', await canvasToBlob(image), 'source.png');
    if (guide) form.append('image[]', await canvasToBlob(guide), 'pose-guide.png');
    form.append('mask', await canvasToBlob(toOpenAIMask(selection)), 'mask.png');
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal,
    });
    if (!response.ok) await responseError(response);
    const json = await response.json();
    const data = json.data?.[0]?.b64_json;
    if (!data) throw new Error('OpenAIから画像が返されませんでした');
    return decodeBase64Image(data);
  }

  const source = image.toDataURL('image/png').split(',')[1];
  const mask = selection.toDataURL('image/png').split(',')[1];
  const parts = [
    { text: `${prompt}\nThe second image is a selection mask: white pixels identify the only area to change. Keep everything else identical.${guide ? ' The third image is a pose guide; its green lines show the intended arm paths and hand endpoints, and must not appear in the output.' : ''}` },
    { inlineData: { mimeType: 'image/png', data: source } },
    { inlineData: { mimeType: 'image/png', data: mask } },
  ];
  if (guide) parts.push({ inlineData: { mimeType: 'image/png', data: guide.toDataURL('image/png').split(',')[1] } });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal,
    }
  );
  if (!response.ok) await responseError(response);
  const json = await response.json();
  const result = json.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
  if (!result) throw new Error('Geminiから画像が返されませんでした');
  return decodeBase64Image(result.data, result.mimeType);
}
