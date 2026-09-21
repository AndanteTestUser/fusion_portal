export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.5-sunburst';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';
export const DEFAULT_OPENAI_VISION_MODEL = 'gpt-6-astra';

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

const POINT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
};

const POSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    found: { type: 'boolean' }, confidence: { type: 'number' }, summary: { type: 'string' },
    head: POINT_SCHEMA, torso: POINT_SCHEMA,
    leftShoulder: POINT_SCHEMA, rightShoulder: POINT_SCHEMA,
    leftElbow: POINT_SCHEMA, rightElbow: POINT_SCHEMA,
    leftWrist: POINT_SCHEMA, rightWrist: POINT_SCHEMA,
    occluders: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { description: { type: 'string' }, polygon: { type: 'array', items: POINT_SCHEMA } },
        required: ['description', 'polygon'],
      },
    },
  },
  required: ['found', 'confidence', 'summary', 'head', 'torso', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'occluders'],
};

function normalizePose(value) {
  if (!value || typeof value !== 'object') throw new Error('人物解析の結果を読み取れませんでした');
  const clamp = (n) => Math.max(0, Math.min(1000, Number(n) || 0));
  const point = (p) => ({ x: clamp(p?.x), y: clamp(p?.y) });
  const normalized = {
    found: Boolean(value.found),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    summary: String(value.summary || ''),
    occluders: Array.isArray(value.occluders) ? value.occluders.map((item) => ({
      description: String(item?.description || ''),
      polygon: Array.isArray(item?.polygon) ? item.polygon.map(point) : [],
    })).filter((item) => item.polygon.length >= 3) : [],
  };
  for (const name of ['head', 'torso', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist']) normalized[name] = point(value[name]);
  return normalized;
}

function openAIOutputText(json) {
  for (const output of json.output || []) {
    for (const content of output.content || []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  return json.output_text || '';
}

function analysisImageDataUrl(image) {
  const maxSide = 1024;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const resized = makeCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  resized.getContext('2d').drawImage(image, 0, 0, resized.width, resized.height);
  return resized.toDataURL('image/jpeg', 0.88);
}

export function parseStructuredJson(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('人物解析の結果が空でした');
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(unfenced); } catch { /* try the JSON object inside explanatory text */ }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { /* handled below */ }
  }
  throw new Error('人物解析のJSONが壊れていました。APIへの再送信はしていません');
}

async function providerFetch(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`${label}への接続に失敗しました。通信状態を確認して再実行してください`);
  }
}

export async function analyzePoseWithProvider({ provider, key, image, signal }) {
  if (!key) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Gemini'}のAPIキーを設定してください`);
  const instruction = `Analyze the main reclining or lying person whose arms should be changed to a fully extended overhead banzai pose. Return coordinates normalized from 0 to 1000 relative to the full image. Estimate hidden joints. left/right mean the person's anatomical sides. Identify only foreground people or objects covering this subject or either arm path as occluders, tracing each visible boundary with a tight polygon of 6 to 20 points. Never classify the subject's own body or clothes as an occluder. If no suitable person exists, set found=false. confidence must be 0 to 1.`;
  // Analysis does not need edit-resolution pixels. A smaller JPEG avoids large
  // base64 request bodies that frequently fail in iOS/Safari.
  const imageDataUrl = analysisImageDataUrl(image);

  if (provider === 'openai') {
    const response = await providerFetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_OPENAI_VISION_MODEL,
        input: [{ role: 'user', content: [
          { type: 'input_text', text: instruction },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' },
        ] }],
        text: { format: { type: 'json_schema', name: 'banzai_pose_analysis', strict: true, schema: POSE_SCHEMA } },
      }),
    }, 'OpenAI');
    if (!response.ok) await responseError(response);
    const text = openAIOutputText(await response.json());
    if (!text) throw new Error('OpenAIから人物解析結果が返されませんでした');
    return normalizePose(parseStructuredJson(text));
  }

  const response = await providerFetch(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: instruction },
        { inlineData: { mimeType: 'image/jpeg', data: imageDataUrl.split(',')[1] } },
      ] }],
      generationConfig: {
        responseModalities: ['TEXT'],
        responseMimeType: 'application/json',
        responseSchema: POSE_SCHEMA,
        maxOutputTokens: 4096,
      },
    }),
  }, 'Gemini');
  if (!response.ok) await responseError(response);
  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.filter((part) => part.text).map((part) => part.text).join('');
  if (!text) throw new Error('Geminiから人物解析結果が返されませんでした');
  return normalizePose(parseStructuredJson(text));
}

function fromNormalized(point, image) {
  return { x: point.x * image.width / 1000, y: point.y * image.height / 1000 };
}

export function createAutomaticPlan(image, analysis) {
  if (!analysis?.found) throw new Error('横たわっている対象人物を自動検出できませんでした');
  const landmarks = {};
  for (const name of ['head', 'torso', 'leftShoulder', 'rightShoulder']) landmarks[name] = fromNormalized(analysis[name], image);
  const joints = {};
  for (const name of ['leftElbow', 'rightElbow', 'leftWrist', 'rightWrist']) joints[name] = fromNormalized(analysis[name], image);
  const estimated = estimateBanzaiTargets(landmarks);
  if (!estimated) throw new Error('人物の向きと肩幅を解析できませんでした');
  const margin = Math.max(4, Math.min(image.width, image.height) * 0.015);
  const fit = ({ x, y }) => ({ x: Math.max(margin, Math.min(image.width - margin, x)), y: Math.max(margin, Math.min(image.height - margin, y)) });
  const targets = { leftHand: fit(estimated.leftHand), rightHand: fit(estimated.rightHand) };
  const shoulderWidth = Math.hypot(landmarks.leftShoulder.x - landmarks.rightShoulder.x, landmarks.leftShoulder.y - landmarks.rightShoulder.y);
  const arms = makeCanvas(image.width, image.height);
  const armCtx = arms.getContext('2d');
  armCtx.strokeStyle = 'rgba(255,60,80,1)'; armCtx.fillStyle = 'rgba(255,60,80,1)';
  armCtx.lineWidth = Math.max(image.width / 35, shoulderWidth * 0.58);
  armCtx.lineCap = 'round'; armCtx.lineJoin = 'round';
  for (const side of ['left', 'right']) {
    const shoulder = landmarks[`${side}Shoulder`];
    armCtx.beginPath(); armCtx.moveTo(shoulder.x, shoulder.y); armCtx.lineTo(joints[`${side}Elbow`].x, joints[`${side}Elbow`].y); armCtx.lineTo(joints[`${side}Wrist`].x, joints[`${side}Wrist`].y); armCtx.stroke();
    armCtx.beginPath(); armCtx.moveTo(shoulder.x, shoulder.y); armCtx.lineTo(targets[`${side}Hand`].x, targets[`${side}Hand`].y); armCtx.stroke();
  }
  const occluder = makeCanvas(image.width, image.height);
  const occCtx = occluder.getContext('2d');
  occCtx.fillStyle = 'rgba(255,60,80,1)';
  for (const item of analysis.occluders || []) {
    const polygon = item.polygon.map((point) => fromNormalized(point, image));
    if (polygon.length < 3) continue;
    occCtx.beginPath(); occCtx.moveTo(polygon[0].x, polygon[0].y);
    for (const point of polygon.slice(1)) occCtx.lineTo(point.x, point.y);
    occCtx.closePath(); occCtx.fill();
  }
  return { landmarks, targets, arms, occluder, confidence: analysis.confidence, summary: analysis.summary };
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
