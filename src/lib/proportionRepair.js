import { copyCanvas, makeCanvas } from './banzaiPipeline.js';

export const DEFAULT_STRETCH_FACTOR = 4 / 3;
export const PROPORTION_REPAIR_STORAGE_KEY = 'fusion_portal_proportion_repair_session';

export function stretchedDimensions(width, height, factor = DEFAULT_STRETCH_FACTOR) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const safeFactor = Number.isFinite(Number(factor)) && Number(factor) > 0 ? Number(factor) : DEFAULT_STRETCH_FACTOR;
  return { width: w, height: Math.max(1, Math.round(h * safeFactor)) };
}

export function normalizedDimensions(width, height) {
  return {
    width: Math.max(1, Math.round(Number(width) || 0)),
    height: Math.max(1, Math.round(Number(height) || 0)),
  };
}

export function clampComparisonPosition(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, number));
}

export function comparisonPositionFromClientX(clientX, left, width) {
  if (![clientX, left, width].every(Number.isFinite) || width <= 0) return 50;
  return clampComparisonPosition(((clientX - left) / width) * 100);
}

export function normalizeSelectionRect(start, end, width, height) {
  if (!start || !end) return null;
  const x1 = Math.max(0, Math.min(width, Math.min(start.x, end.x)));
  const y1 = Math.max(0, Math.min(height, Math.min(start.y, end.y)));
  const x2 = Math.max(0, Math.min(width, Math.max(start.x, end.x)));
  const y2 = Math.max(0, Math.min(height, Math.max(start.y, end.y)));
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function resizeCanvas(source, width, height) {
  const output = makeCanvas(width, height);
  const context = output.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, output.width, output.height);
  return output;
}

function boundaryColor(canvas, rect) {
  const ctx = canvas.getContext('2d');
  const points = [];
  const step = Math.max(1, Math.floor(Math.min(rect.width, rect.height) / 16));
  const push = (x, y) => {
    const pixel = ctx.getImageData(
      Math.max(0, Math.min(canvas.width - 1, Math.round(x))),
      Math.max(0, Math.min(canvas.height - 1, Math.round(y))),
      1,
      1,
    ).data;
    points.push(pixel);
  };
  for (let x = rect.x; x <= rect.x + rect.width; x += step) {
    push(x, rect.y - 1); push(x, rect.y + rect.height + 1);
  }
  for (let y = rect.y; y <= rect.y + rect.height; y += step) {
    push(rect.x - 1, y); push(rect.x + rect.width + 1, y);
  }
  if (!points.length) return 'rgb(80, 86, 98)';
  const average = [0, 1, 2].map((channel) => Math.round(points.reduce((sum, pixel) => sum + pixel[channel], 0) / points.length));
  return `rgb(${average[0]}, ${average[1]}, ${average[2]})`;
}

export function transformSelection(source, rect, transform) {
  if (!rect) return copyCanvas(source);
  const scale = Math.max(0.35, Math.min(1.75, Number(transform.scale) || 1));
  const rotation = (Number(transform.rotation) || 0) * Math.PI / 180;
  const offsetX = Number(transform.offsetX) || 0;
  const offsetY = Number(transform.offsetY) || 0;
  const patch = makeCanvas(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
  patch.getContext('2d').drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, patch.width, patch.height);

  const output = copyCanvas(source);
  const ctx = output.getContext('2d');
  ctx.save();
  ctx.fillStyle = boundaryColor(source, rect);
  ctx.fillRect(rect.x - 2, rect.y - 2, rect.width + 4, rect.height + 4);
  ctx.restore();

  const centerX = rect.x + rect.width / 2 + offsetX;
  const centerY = rect.y + rect.height / 2 + offsetY;
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(patch, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
  ctx.restore();
  return output;
}

export function maskBounds(mask) {
  if (!mask) return null;
  const { width, height } = mask;
  const data = mask.getContext('2d').getImageData(0, 0, width, height).data;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 64) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function createSubjectMask(width, height, subject) {
  const mask = makeCanvas(width, height);
  const ctx = mask.getContext('2d');
  ctx.fillStyle = '#fff';
  for (const region of subject?.regions || []) {
    const polygon = region?.polygon || [];
    if (polygon.length < 3) continue;
    ctx.beginPath();
    polygon.forEach((point, index) => {
      const x = Number(point.x) * width / 1000;
      const y = Number(point.y) * height / 1000;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.fill();
  }
  return mask;
}

function transformedMaskedLayer(layer, bounds, transform) {
  const scaleX = Math.max(0.35, Math.min(1.75, Number(transform.scaleX ?? transform.scale) || 1));
  const scaleY = Math.max(0.35, Math.min(1.75, Number(transform.scaleY ?? transform.scale) || 1));
  const rotation = (Number(transform.rotation) || 0) * Math.PI / 180;
  const centerX = bounds.x + bounds.width / 2 + (Number(transform.offsetX) || 0);
  const centerY = bounds.y + bounds.height / 2 + (Number(transform.offsetY) || 0);
  const output = makeCanvas(layer.width, layer.height);
  const ctx = output.getContext('2d');
  ctx.save(); ctx.translate(centerX, centerY); ctx.rotate(rotation); ctx.scale(scaleX, scaleY);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(layer, bounds.x, bounds.y, bounds.width, bounds.height, -bounds.width / 2, -bounds.height / 2, bounds.width, bounds.height);
  ctx.restore();
  return output;
}

export function transformMask(mask, transform, selectedBounds = null) {
  const bounds = selectedBounds || maskBounds(mask);
  return bounds ? transformedMaskedLayer(mask, bounds, transform) : copyCanvas(mask);
}

export function transformMaskedSelection(source, mask, transform, selectedBounds = null) {
  const bounds = selectedBounds || maskBounds(mask);
  if (!bounds) return copyCanvas(source);

  const selected = copyCanvas(source);
  const selectedCtx = selected.getContext('2d');
  selectedCtx.globalCompositeOperation = 'destination-in';
  selectedCtx.drawImage(mask, 0, 0);
  selectedCtx.globalCompositeOperation = 'source-over';

  const output = copyCanvas(source);
  const fill = makeCanvas(source.width, source.height);
  const fillCtx = fill.getContext('2d');
  fillCtx.fillStyle = boundaryColor(source, bounds);
  fillCtx.fillRect(0, 0, fill.width, fill.height);
  fillCtx.globalCompositeOperation = 'destination-in';
  fillCtx.drawImage(mask, 0, 0);
  output.getContext('2d').drawImage(fill, 0, 0);
  output.getContext('2d').drawImage(transformedMaskedLayer(selected, bounds, transform), 0, 0);
  return output;
}

export function fullSelection(width, height) {
  const mask = makeCanvas(width, height);
  const ctx = mask.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return mask;
}

export function buildRepairPrompt(notes = '') {
  const extra = String(notes || '').trim();
  return [
    'Perform a conservative restoration pass on this exact image.',
    'Repair only visible manual-edit artifacts: flat placeholder patches, seams, jagged cutout edges, halos, interrupted outlines, missing local background, and inconsistent local shading.',
    'Improve line clarity, color blending, texture consistency, and local detail without redesigning the scene.',
    'Preserve the manually adjusted head-to-body proportions exactly. Preserve every character identity, face, expression, hairstyle, clothing, body shape, pose, limb and hand position, contact point, object, effect, background, camera, perspective, framing, crop, and aspect ratio.',
    'Do not add, remove, move, resize, rotate, or reinterpret any subject or object. No text, watermark, border, extra limbs, missing limbs, or altered pose.',
    extra ? `Additional repair target: ${extra}` : '',
  ].filter(Boolean).join('\n');
}

export function canvasToDataUrl(canvas) {
  return canvas?.toDataURL('image/png') || '';
}

export async function dataUrlToCanvas(dataUrl) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    image.src = dataUrl;
  });
  const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsDataURL(file);
  });
}

const DB_NAME = 'fusion_portal_workflows';
const STORE_NAME = 'sessions';

function openSessionDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRepairSession(session) {
  const db = await openSessionDb();
  try {
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(session, PROPORTION_REPAIR_STORAGE_KEY);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function loadRepairSession() {
  const db = await openSessionDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(PROPORTION_REPAIR_STORAGE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
