import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';

// 元の index.html（vanilla JS 実装）のロジックをそのまま React に移植したもの。
// キャンバス上の一時的な描画状態(座標・切り出し済みキャンバスなど)は再描画の
// トリガーにする必要がないため useRef(可変値)に持たせ、ボタンの見た目や
// モーダルの開閉などUIに反映すべき状態だけ useState にしている。

// パーツを移動した後、元の位置に残る「穴」を示すプレースホルダー色。
// 白は絵の中(肌・服・背景のハイライト等)に自然に出現しやすく、
// AIが「これはマスクなのか本来の絵の一部なのか」を誤認しやすいため、
// 作品内にまず登場しないマゼンタを使い、AIにもプロンプトで明示する。
const MASK_COLOR = '#ff00ff';
const MASK_RGB = { r: 255, g: 0, b: 255 };
// この距離以内の色は「マスク色とみなす」しきい値(RGBユークリッド距離)
const MASK_COLOR_DISTANCE = 60;
// 生成結果のマスク領域に、なおマスク色がこの割合以上残っていたら「未完了」とみなす
const MASK_REMAIN_RATIO_LIMIT = 0.05;
// 未完了時の自動リトライ回数(1回目を含む最大試行回数)
const MAX_GENERATION_ATTEMPTS = 3;

const isMaskColor = (r, g, b) => {
  const dr = r - MASK_RGB.r;
  const dg = g - MASK_RGB.g;
  const db = b - MASK_RGB.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) < MASK_COLOR_DISTANCE;
};

// iOS/Safari 等では概ね縦横の積が約16,777,216px(4096×4096相当)を超えるcanvasは
// 描画に失敗しうるため、それより十分小さい値を安全な上限として長辺を縮小する。
// パノラマ写真やProRAW等、一部の巨大な画像が「読み込んでも反応がない」原因になりうる。
const MAX_IMAGE_DIMENSION = 4096;

// File を読み込み、デコードまで確認した上で HTMLImageElement を返す。
// 対応していない形式(HEIC等)や壊れたデータの場合は、黙って失敗するのではなく
// reject して呼び出し側でエラーメッセージを表示できるようにする。
const readImageFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => resolve({ img, dataUrl: event.target.result });
      img.onerror = () =>
        reject(
          new Error('画像を読み込めませんでした(対応していない形式か、データが壊れている可能性があります)')
        );
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });

// WK画像(dataURL)からデコードまで確認した上で HTMLImageElement を返す。
// readImageFile と異なり File ではなく既にdataURL化された画像を受け取る。
const loadImageElementFromDataUrl = (dataUrl) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('WK画像を読み込めませんでした'));
    img.src = dataUrl;
  });

// 長辺が MAX_IMAGE_DIMENSION を超える画像は、canvasの描画上限を避けるため
// 縮小した canvas を代わりに返す(Image と canvas はどちらも drawImage の
// ソースとして、width/height プロパティを持つ点でも扱いが共通)。
const fitWithinMaxDimension = (img) => {
  const longSide = Math.max(img.width, img.height);
  if (longSide <= MAX_IMAGE_DIMENSION) return img;

  const scale = MAX_IMAGE_DIMENSION / longSide;
  const resizedCanvas = document.createElement('canvas');
  resizedCanvas.width = Math.max(1, Math.round(img.width * scale));
  resizedCanvas.height = Math.max(1, Math.round(img.height * scale));
  resizedCanvas.getContext('2d').drawImage(img, 0, 0, resizedCanvas.width, resizedCanvas.height);
  return resizedCanvas;
};

// 移動・回転後にパーツが実際に配置されているバウンディングボックスを計算する。
// drawPiece/drawPieceImageOnly と同じ変換(元の中心を軸に回転してからオフセットを加える)
// を矩形の4隅に適用し、その外接矩形を返す。
// 「穴」の元の位置だけでなく、パーツの新しい位置の繋ぎ目も信頼範囲に含めるために使う
// (これがないと、パーツを大きく動かすほどAIが繋ぎ目を描き直しても
// compositeTrustedRegionsOnly の段階で無条件に捨てられてしまう)。
const computeMovedBounds = (bounds, offset, rotation) => {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  corners.forEach((p) => {
    const dx = p.x - centerX;
    const dy = p.y - centerY;
    const rx = centerX + dx * cos - dy * sin + offset.x;
    const ry = centerY + dx * sin + dy * cos + offset.y;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  });

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

// 穴(マスク色で塗った範囲)は必ずAIの出力で完全に置き換える。
// 以前は楕円+放射グラデーションで、穴の縁でAIの出力が半透明(約64%)、
// 矩形の四隅ではほぼ0%になり、土台のマゼンタが透けて残っていた。
// solidPad: 穴の矩形+輪郭拡張(最大40px)+余白までを完全に不透明にする範囲
// feather : その外側で元画像へ徐々に戻していく幅
// フェードは ctx.filter(blur) がSafari/iOSで使えないため、薄い矩形の重ね塗りで作る。
const buildTrustMaskCanvas = (width, height, maskBounds) => {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const ctx = maskCanvas.getContext('2d');

  const FEATHER_STEPS = 10;
  const FEATHER_LAYER_ALPHA = 0.18;

  const fillPaddedRect = (b, pad) => {
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    const right = Math.min(width, b.x + b.width + pad);
    const bottom = Math.min(height, b.y + b.height + pad);
    if (right - x <= 0 || bottom - y <= 0) return;
    ctx.fillRect(x, y, right - x, bottom - y);
  };

  maskBounds.forEach((b) => {
    const longSide = Math.max(b.width, b.height);
    const solidPad = Math.max(48, longSide * 0.15);
    const feather = Math.max(24, longSide * 0.25);

    ctx.fillStyle = `rgba(255,255,255,${FEATHER_LAYER_ALPHA})`;
    for (let i = FEATHER_STEPS; i >= 1; i--) {
      fillPaddedRect(b, solidPad + (feather * i) / FEATHER_STEPS);
    }

    ctx.fillStyle = 'rgba(255,255,255,1)';
    fillPaddedRect(b, solidPad);
  });

  return maskCanvas;
};

// AIの生成結果のうち、実際に穴があった場所とその周辺(信頼範囲)だけを採用し、
// それ以外は送信時の画像(=ユーザーが配置した通りのもの)をそのまま使う。
// 最後に、移動したパーツ自体のピクセルを常に最優先で上書きする。
const compositeTrustedRegionsOnly = (aiImg, baseCanvas, maskBounds, piecesLayer) => {
  const width = baseCanvas.width;
  const height = baseCanvas.height;

  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  const ctx = result.getContext('2d');
  // 土台は常に「送信時点の画像」。AIの出力はまだ一切含まれていない。
  ctx.drawImage(baseCanvas, 0, 0);

  if (maskBounds.length > 0) {
    // 座標系を baseCanvas の解像度に揃えるため、AIの出力をこのサイズで描き直す
    const aiCanvas = document.createElement('canvas');
    aiCanvas.width = width;
    aiCanvas.height = height;
    aiCanvas.getContext('2d').drawImage(aiImg, 0, 0, width, height);

    const trustMask = buildTrustMaskCanvas(width, height, maskBounds);

    const maskedAi = document.createElement('canvas');
    maskedAi.width = width;
    maskedAi.height = height;
    const maskedCtx = maskedAi.getContext('2d');
    maskedCtx.drawImage(aiCanvas, 0, 0);
    maskedCtx.globalCompositeOperation = 'destination-in';
    maskedCtx.drawImage(trustMask, 0, 0);

    ctx.drawImage(maskedAi, 0, 0);
  }

  // 移動後のパーツは、信頼範囲の内外に関わらず常に元のピクセルへ強制的に戻す。
  ctx.drawImage(piecesLayer, 0, 0);

  return result;
};

export default function GeneratorPage() {
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const importOriginalRef = useRef(null);
  const importEditedRef = useRef(null);
  const toastTimerRef = useRef(null);

  const { geminiApiKey, setGeminiApiKey } = useApiKeys();
  const [apiKeyInput, setApiKeyInput] = useState(geminiApiKey);

  const [currentMode, setCurrentModeState] = useState('lasso');
  const [hasSelection, setHasSelectionState] = useState(false);
  const [toast, setToast] = useState({ msg: '', visible: false });
  const [loading, setLoading] = useState({ visible: false, text: '処理中...' });
  const [manageOpen, setManageOpen] = useState(false);
  const [historyOriginal, setHistoryOriginal] = useState(null);
  const [historyEdited, setHistoryEdited] = useState(null);
  const [historyGenerated, setHistoryGenerated] = useState(null);

  const originalImageRef = useRef(null);
  const pastEditsRef = useRef([]);
  const lassoPointsRef = useRef([]);
  const cutPieceCanvasRef = useRef(null);
  const cutPieceBoundsRef = useRef(null);
  const cutPieceRotationRef = useRef(0);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const isDrawingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  const showToast = useCallback((msg) => {
    setToast({ msg, visible: true });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 3000);
  }, []);

  const setMode = useCallback((mode) => {
    setCurrentModeState(mode);
  }, []);

  const drawPiece = useCallback((targetCtx, points, pieceCanvasLayer, bounds, offset, rotation, showFrame) => {
    if (!pieceCanvasLayer || !bounds || points.length === 0) return;

    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) targetCtx.lineTo(points[i].x, points[i].y);
    targetCtx.closePath();
    targetCtx.fillStyle = MASK_COLOR;
    targetCtx.fill();

    // 手動でなぞった輪郭は実物の輪郭よりわずかに内側にずれやすく、塗りつぶしだけでは
    // 境界に数ピクセルの「残像」(元のパーツの端)が消されずに残ることがある。
    // 同じ輪郭を太めの線でなぞって、境界の外側にも一定の余白を持たせて
    // マスク領域(=消す/AIに補完させる範囲)に含める。
    const minSide = Math.max(1, Math.min(bounds.width, bounds.height));
    const holeExpandPx = Math.min(40, Math.max(6, minSide * 0.06));
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = holeExpandPx * 2;
    targetCtx.strokeStyle = MASK_COLOR;
    targetCtx.stroke();

    const centerX = bounds.x + bounds.width / 2 + offset.x;
    const centerY = bounds.y + bounds.height / 2 + offset.y;

    targetCtx.translate(centerX, centerY);
    targetCtx.rotate((rotation * Math.PI) / 180);
    targetCtx.translate(-centerX, -centerY);
    targetCtx.drawImage(pieceCanvasLayer, offset.x, offset.y);

    if (showFrame) {
      targetCtx.strokeStyle = '#00a8ff';
      targetCtx.lineWidth = 3;
      targetCtx.strokeRect(bounds.x + offset.x, bounds.y + offset.y, bounds.width, bounds.height);
    }
    targetCtx.restore();
  }, []);

  // drawPiece からマスク塗り・選択枠を省き、移動後のパーツ画像だけを描くバージョン。
  // AIの生成結果に、ユーザーが配置した通りのピクセルをそのまま上書きするために使う
  // (=「移動後のパーツは絶対」として扱い、AIに再解釈させない)。
  const drawPieceImageOnly = useCallback((targetCtx, pieceCanvasLayer, bounds, offset, rotation) => {
    if (!pieceCanvasLayer || !bounds) return;

    targetCtx.save();
    const centerX = bounds.x + bounds.width / 2 + offset.x;
    const centerY = bounds.y + bounds.height / 2 + offset.y;
    targetCtx.translate(centerX, centerY);
    targetCtx.rotate((rotation * Math.PI) / 180);
    targetCtx.translate(-centerX, -centerY);
    targetCtx.drawImage(pieceCanvasLayer, offset.x, offset.y);
    targetCtx.restore();
  }, []);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const originalImage = originalImageRef.current;
    if (!canvas || !originalImage) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(originalImage, 0, 0);

    pastEditsRef.current.forEach((edit) =>
      drawPiece(
        ctx,
        edit.lassoPoints,
        edit.cutPieceCanvas,
        edit.cutPieceBounds,
        edit.dragOffset,
        edit.cutPieceRotation,
        false
      )
    );

    if (hasSelection && cutPieceCanvasRef.current) {
      drawPiece(
        ctx,
        lassoPointsRef.current,
        cutPieceCanvasRef.current,
        cutPieceBoundsRef.current,
        dragOffsetRef.current,
        cutPieceRotationRef.current,
        true
      );
    }

    if (isDrawingRef.current && lassoPointsRef.current.length > 0) {
      const pts = lassoPointsRef.current;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.restore();
    }
  }, [drawPiece, hasSelection]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  const resetCurrentSelection = useCallback(() => {
    lassoPointsRef.current = [];
    setHasSelectionState(false);
    cutPieceCanvasRef.current = null;
    cutPieceBoundsRef.current = null;
    cutPieceRotationRef.current = 0;
    dragOffsetRef.current = { x: 0, y: 0 };
    setMode('lasso');
    renderCanvas();
  }, [renderCanvas, setMode]);

  const createCutPiece = useCallback(() => {
    const canvas = canvasRef.current;
    const points = lassoPointsRef.current;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((p) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    cutPieceBoundsRef.current = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

    const pieceCanvas = document.createElement('canvas');
    pieceCanvas.width = canvas.width;
    pieceCanvas.height = canvas.height;
    const pCtx = pieceCanvas.getContext('2d');
    pCtx.beginPath();
    pCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) pCtx.lineTo(points[i].x, points[i].y);
    pCtx.closePath();
    pCtx.clip();
    pCtx.drawImage(originalImageRef.current, 0, 0);

    cutPieceCanvasRef.current = pieceCanvas;
  }, []);

  const getCanvasPos = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0] && e.touches[0].clientX);
    const clientY = e.clientY ?? (e.touches && e.touches[0] && e.touches[0].clientY);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }, []);

  const handleStart = useCallback(
    (e) => {
      if (!originalImageRef.current) return;
      const pos = getCanvasPos(e);

      if (currentMode === 'lasso') {
        if (hasSelection && lassoPointsRef.current.length > 0) {
          pastEditsRef.current.push({
            lassoPoints: [...lassoPointsRef.current],
            cutPieceCanvas: cutPieceCanvasRef.current,
            cutPieceBounds: { ...cutPieceBoundsRef.current },
            cutPieceRotation: cutPieceRotationRef.current,
            dragOffset: { ...dragOffsetRef.current },
          });
        }
        lassoPointsRef.current = [pos];
        isDrawingRef.current = true;
        setHasSelectionState(false);
        cutPieceCanvasRef.current = null;
        cutPieceBoundsRef.current = null;
        cutPieceRotationRef.current = 0;
        dragOffsetRef.current = { x: 0, y: 0 };
      } else if (currentMode === 'move' && hasSelection) {
        isDraggingRef.current = true;
        lastPosRef.current = pos;
      }
    },
    [currentMode, hasSelection, getCanvasPos]
  );

  const handleMove = useCallback(
    (e) => {
      if (!originalImageRef.current) return;
      const pos = getCanvasPos(e);
      if (isDrawingRef.current && currentMode === 'lasso') {
        lassoPointsRef.current.push(pos);
        renderCanvas();
      } else if (isDraggingRef.current && currentMode === 'move' && hasSelection) {
        dragOffsetRef.current = {
          x: dragOffsetRef.current.x + (pos.x - lastPosRef.current.x),
          y: dragOffsetRef.current.y + (pos.y - lastPosRef.current.y),
        };
        lastPosRef.current = pos;
        renderCanvas();
      }
    },
    [currentMode, hasSelection, getCanvasPos, renderCanvas]
  );

  const handleEnd = useCallback(() => {
    if (!originalImageRef.current) return;
    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      if (lassoPointsRef.current.length > 5) {
        createCutPiece();
        setHasSelectionState(true);
        setMode('move');
      } else {
        resetCurrentSelection();
      }
      renderCanvas();
    } else if (isDraggingRef.current) {
      isDraggingRef.current = false;
    }
  }, [createCutPiece, renderCanvas, resetCurrentSelection, setMode]);

  // 現在の状態(元画像+配置済みパーツ+マスク色の穴)をそのまま描いたcanvasを返す。
  // AIへ送る画像であると同時に、生成後に「信頼範囲の外側」で使う土台にもなる
  // (=ユーザーが配置した通りのもの。AIの出力はまだ一切含まない)。
  const buildCleanCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const cCanvas = document.createElement('canvas');
    cCanvas.width = canvas.width;
    cCanvas.height = canvas.height;
    const cCtx = cCanvas.getContext('2d');
    cCtx.drawImage(originalImageRef.current, 0, 0);
    pastEditsRef.current.forEach((edit) =>
      drawPiece(
        cCtx,
        edit.lassoPoints,
        edit.cutPieceCanvas,
        edit.cutPieceBounds,
        edit.dragOffset,
        edit.cutPieceRotation,
        false
      )
    );
    if (hasSelection) {
      drawPiece(
        cCtx,
        lassoPointsRef.current,
        cutPieceCanvasRef.current,
        cutPieceBoundsRef.current,
        dragOffsetRef.current,
        cutPieceRotationRef.current,
        false
      );
    }
    return cCanvas;
  }, [drawPiece, hasSelection]);

  const getCleanCanvasDataURL = useCallback(() => {
    return buildCleanCanvas().toDataURL('image/jpeg', 0.95);
  }, [buildCleanCanvas]);

  // 「穴」が空いた元の位置(マスクを塗った矩形)と、パーツが移動・回転した後の
  // 新しい位置(繋ぎ目のブレンドが必要な範囲)の両方を集める。
  // pastEdits と、現在ドラッグ中の選択パーツの両方が対象。
  // 新しい位置も含めないと、パーツを動かした先の繋ぎ目にAIの結果が一切反映されない。
  const collectMaskBounds = useCallback(() => {
    const bounds = [];
    pastEditsRef.current.forEach((edit) => {
      if (!edit.cutPieceBounds) return;
      bounds.push(edit.cutPieceBounds);
      bounds.push(computeMovedBounds(edit.cutPieceBounds, edit.dragOffset, edit.cutPieceRotation));
    });
    if (hasSelection && cutPieceBoundsRef.current) {
      bounds.push(cutPieceBoundsRef.current);
      bounds.push(
        computeMovedBounds(cutPieceBoundsRef.current, dragOffsetRef.current, cutPieceRotationRef.current)
      );
    }
    return bounds;
  }, [hasSelection]);

  // 生成結果の画像を検査し、マスク領域にマゼンタがどれだけ残っているかを 0〜1 の割合で返す。
  // AIから返る画像の解像度が送信画像と異なる場合に備え、比率でスケーリングして座標を合わせる。
  const measureMaskRemaining = useCallback((img, sourceWidth, sourceHeight, maskBounds) => {
    if (!maskBounds.length || !sourceWidth || !sourceHeight) return 0;

    const scaleX = img.width / sourceWidth;
    const scaleY = img.height / sourceHeight;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = img.width;
    tmpCanvas.height = img.height;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(img, 0, 0);

    let maskPixels = 0;
    let totalPixels = 0;

    maskBounds.forEach((b) => {
      const x = Math.max(0, Math.floor(b.x * scaleX));
      const y = Math.max(0, Math.floor(b.y * scaleY));
      const w = Math.min(Math.ceil(b.width * scaleX), tmpCanvas.width - x);
      const h = Math.min(Math.ceil(b.height * scaleY), tmpCanvas.height - y);
      if (w <= 0 || h <= 0) return;

      const { data } = tmpCtx.getImageData(x, y, w, h);
      for (let i = 0; i < data.length; i += 4) {
        totalPixels++;
        if (isMaskColor(data[i], data[i + 1], data[i + 2])) maskPixels++;
      }
    });

    return totalPixels === 0 ? 0 : maskPixels / totalPixels;
  }, []);

  // 現在配置されている全パーツ(移動・回転後)の画像だけを、透明背景のレイヤーとして描く。
  // マスク色の塗りつぶしや土台の元画像は含まない。
  const buildPiecesOnlyLayer = useCallback(() => {
    const canvas = canvasRef.current;
    const layer = document.createElement('canvas');
    layer.width = canvas.width;
    layer.height = canvas.height;
    const ctx = layer.getContext('2d');

    pastEditsRef.current.forEach((edit) =>
      drawPieceImageOnly(ctx, edit.cutPieceCanvas, edit.cutPieceBounds, edit.dragOffset, edit.cutPieceRotation)
    );
    if (hasSelection) {
      drawPieceImageOnly(
        ctx,
        cutPieceCanvasRef.current,
        cutPieceBoundsRef.current,
        dragOffsetRef.current,
        cutPieceRotationRef.current
      );
    }
    return layer;
  }, [hasSelection, drawPieceImageOnly]);

  const loadMainImage = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const { img, dataUrl } = await readImageFile(file);
        const source = fitWithinMaxDimension(img);

        const canvas = canvasRef.current;
        canvas.width = source.width;
        canvas.height = source.height;
        originalImageRef.current = source;
        pastEditsRef.current = [];
        resetCurrentSelection();

        setHistoryOriginal(dataUrl);
        setHistoryEdited(null);
        setHistoryGenerated(null);

        showToast(
          source === img ? '画像を読み込みました' : '画像を読み込みました(サイズが大きいため縮小しました)'
        );
      } catch (error) {
        showToast(error.message || '画像を読み込めませんでした');
      }
    },
    [resetCurrentSelection, showToast]
  );

  // WK画像(ウェルカム画面でチェックした画像)を、通常のファイル読込と同じ
  // 「①元画像」の位置に読み込む。
  const applyMainImageFromDataUrl = useCallback(
    async (dataUrl) => {
      try {
        const img = await loadImageElementFromDataUrl(dataUrl);
        const source = fitWithinMaxDimension(img);

        const canvas = canvasRef.current;
        canvas.width = source.width;
        canvas.height = source.height;
        originalImageRef.current = source;
        pastEditsRef.current = [];
        resetCurrentSelection();

        setHistoryOriginal(dataUrl);
        setHistoryEdited(null);
        setHistoryGenerated(null);

        showToast('WK画像を読み込みました');
      } catch (error) {
        showToast(error.message || 'WK画像を読み込めませんでした');
      }
    },
    [resetCurrentSelection, showToast]
  );

  useWkAutoLoad('/generator', () => Boolean(originalImageRef.current), applyMainImageFromDataUrl);

  const handleUndo = useCallback(() => {
    if (!originalImageRef.current) return;
    if (hasSelection || isDrawingRef.current || lassoPointsRef.current.length > 0) {
      resetCurrentSelection();
    } else if (pastEditsRef.current.length > 0) {
      pastEditsRef.current.pop();
      resetCurrentSelection();
    }
  }, [hasSelection, resetCurrentSelection]);

  const handleRotate = useCallback(
    (delta) => {
      if (!hasSelection) return;
      cutPieceRotationRef.current += delta;
      renderCanvas();
    },
    [hasSelection, renderCanvas]
  );

  const handleApiKeyChange = useCallback((e) => {
    setApiKeyInput(e.target.value);
  }, []);

  const commitApiKey = useCallback(() => {
    setGeminiApiKey(apiKeyInput.trim());
  }, [apiKeyInput, setGeminiApiKey]);

  const downloadDataUrl = useCallback(
    (dataUrl, filename) => {
      if (!dataUrl) return showToast('この画像はまだありません');
      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [showToast]
  );

  const runAI = useCallback(async () => {
    if (!originalImageRef.current) return showToast('画像がありません');
    const apiKey = apiKeyInput.trim();
    if (!apiKey) return showToast('APIキーを入力してください');
    setGeminiApiKey(apiKey);

    const baseCanvas = buildCleanCanvas();
    const dataUrl = baseCanvas.toDataURL('image/jpeg', 0.95);
    setHistoryEdited(dataUrl);
    const base64Data = dataUrl.split(',')[1];
    const sourceWidth = baseCanvas.width;
    const sourceHeight = baseCanvas.height;
    const maskBounds = collectMaskBounds();
    // 「移動後のパーツは絶対」として扱うため、生成結果を受け取った後にこのレイヤーを
    // そのまま焼き込み直す。AIがパーツ自体を描き変えても最終的には上書きされる。
    const piecesLayer = buildPiecesOnlyLayer();

    setLoading({ visible: true, text: '処理中...' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `This is an edited collage image where a body part was repositioned to a new location. Treat the repositioned part's new position, pose, and pixels as FIXED and ABSOLUTE — do not redraw, reshape, or reinterpret the moved part itself. Instead, redraw only the small area immediately AROUND it (the connecting anatomy such as the arm or joint leading into it) so that it naturally connects to the moved part in its new position. Areas filled with solid ${MASK_COLOR} (magenta) are placeholder masks marking missing image data, not an intended color — they must not remain in the output; seamlessly inpaint every masked area and any awkward seams or gaps around the moved part. Do NOT add, remove, or change anything else in the image: no new objects, accessories, jewelry, or clothing that were not already there, and no changes to existing skin texture, shading, wrinkles, creases, or shadows anywhere outside the masked/seam area. Keep the exact original art style and level of detail everywhere else, without altering the overall character design or composition.`,
            },
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          ],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'] },
    };

    const requestOnce = async () => {
      let response;
      let delay = 1000;
      for (let i = 0; i < 3; i++) {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (response.ok) break;
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
      }

      if (!response || !response.ok) throw new Error('API通信エラー');

      const result = await response.json();
      const part = result?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error('画像が返されませんでした');

      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    };

    const loadImage = (src) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('生成画像の読み込みに失敗しました'));
        img.src = src;
      });

    try {
      let composited = null;
      // 最後の試行ではなく、マスク残存率が最小だった結果を採用する。
      let bestComposited = null;
      let bestRatio = Infinity;
      // 最終試行後もマスクが残っていたかどうか。残っていた場合は、穴の情報
      // (pastEdits・選択中パーツ)をクリアせずに残し、「AI実行」をもう一度押すだけで
      // 同じ穴に対して再試行できるようにする(でないと穴の位置情報が失われ、
      // ただ押し直しても何も変わらなくなってしまう)。
      let stillHasMask = false;

      for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        setLoading({
          visible: true,
          text: attempt === 1 ? '処理中...' : `マスクが残っていたため再生成中 (${attempt}/${MAX_GENERATION_ATTEMPTS})...`,
        });

        const imageUrl = await requestOnce();
        const img = await loadImage(imageUrl);

        // AIの出力は「穴とその周辺(繋ぎ目のブレンドに必要な範囲)」だけを信頼し、
        // それ以外は送信時の画像(=ユーザーが配置した通りのもの)をそのまま使う。
        // これにより、腕時計を足す・脇の下の影を消すといった無関係な場所への
        // "勝手な補完"を防ぎつつ、移動後のパーツ自体は常に元のピクセルへ戻す。
        composited = compositeTrustedRegionsOnly(img, baseCanvas, maskBounds, piecesLayer);

        // マスク残存の判定は、AIの生の出力ではなく実際に表示される合成後の画像に対して行う。
        // 生の出力だけを見ると、信頼範囲外だったせいで捨てられた結果
        // (=実際にはまだマゼンタが見えている)を「完了」と誤判定してしまうため。
        const remainingRatio = measureMaskRemaining(composited, sourceWidth, sourceHeight, maskBounds);
        if (remainingRatio < bestRatio) {
          bestRatio = remainingRatio;
          bestComposited = composited;
        }
        stillHasMask = bestRatio > MASK_REMAIN_RATIO_LIMIT;

        if (!stillHasMask) break;
      }

      composited = bestComposited;

      const compositedUrl = composited.toDataURL('image/png');

      setHistoryGenerated(compositedUrl);

      const canvas = canvasRef.current;
      canvas.width = composited.width;
      canvas.height = composited.height;
      originalImageRef.current = composited;

      if (stillHasMask) {
        // pastEdits・選択中パーツはそのまま維持。土台(originalImageRef)だけを
        // 今回の結果に差し替えて再描画することで、穴の位置・パーツの配置を保ったまま
        // 次の「AI実行」で同じ箇所を再試行できる。
        renderCanvas();
        setLoading({ visible: false, text: '処理中...' });
        showToast('⚠️ マスクが残りました。もう一度「AI実行」を押すと同じ箇所を再試行します');
      } else {
        pastEditsRef.current = [];
        resetCurrentSelection();
        setLoading({ visible: false, text: '処理中...' });
        showToast('✨ 完了しました');
      }
    } catch (error) {
      setLoading({ visible: false, text: '処理中...' });
      showToast('AI処理に失敗しました');
    }
  }, [
    apiKeyInput,
    buildCleanCanvas,
    resetCurrentSelection,
    renderCanvas,
    setGeminiApiKey,
    showToast,
    collectMaskBounds,
    measureMaskRemaining,
    buildPiecesOnlyLayer,
  ]);

  const handleSave = useCallback(() => {
    if (!originalImageRef.current) return showToast('保存する画像がありません');
    downloadDataUrl(getCleanCanvasDataURL(), 'current_edited_image.png');
  }, [downloadDataUrl, getCleanCanvasDataURL, showToast]);

  const handleImportOriginal = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const { img, dataUrl } = await readImageFile(file);
        const source = fitWithinMaxDimension(img);

        setHistoryOriginal(dataUrl);
        const canvas = canvasRef.current;
        canvas.width = source.width;
        canvas.height = source.height;
        originalImageRef.current = source;
        pastEditsRef.current = [];
        resetCurrentSelection();
        showToast(
          source === img
            ? '① 元画像を読み込みました'
            : '① 元画像を読み込みました(サイズが大きいため縮小しました)'
        );
      } catch (error) {
        showToast(error.message || '① 元画像を読み込めませんでした');
      }
    },
    [resetCurrentSelection, showToast]
  );

  const handleImportEdited = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const { dataUrl } = await readImageFile(file);
        setHistoryEdited(dataUrl);
        showToast('② 編集状態の画像を読み込みました');
      } catch (error) {
        showToast(error.message || '② 編集状態の画像を読み込めませんでした');
      }
    },
    [showToast]
  );

  return (
    <div className="flex h-screen touch-none select-none flex-col overflow-hidden bg-neutral-900 text-white">
      <div className="z-10 flex flex-wrap items-center gap-2 bg-neutral-800 p-2 shadow-lg">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => loadMainImage(e.target.files[0])}
        />
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          📁 読込
        </button>

        <div className="flex overflow-hidden rounded-md border border-neutral-600">
          <button
            className={`btn rounded-none border-r border-neutral-700 ${
              currentMode === 'lasso' ? 'bg-sky-600 font-bold shadow-inner' : ''
            }`}
            onClick={() => setMode('lasso')}
          >
            🖍️ 選択
          </button>
          <button
            className={`btn rounded-none ${currentMode === 'move' ? 'bg-sky-600 font-bold shadow-inner' : ''}`}
            onClick={() => (hasSelection ? setMode('move') : showToast('先にパーツをなぞってください'))}
          >
            🖐️ 移動
          </button>
        </div>

        <button className="btn" onClick={handleUndo}>
          ↩️ 取消
        </button>
        <button className="btn" onClick={() => handleRotate(-5)}>
          ↺
        </button>
        <button className="btn" onClick={() => handleRotate(5)}>
          ↻
        </button>

        <input
          type="password"
          className="w-20 rounded border border-neutral-600 bg-neutral-900 px-2 py-2 text-xs text-white"
          placeholder="APIキー"
          value={apiKeyInput}
          onChange={handleApiKeyChange}
          onBlur={commitApiKey}
        />
        <button
          className="btn border-purple-700 bg-purple-600 font-bold hover:bg-purple-500"
          onClick={runAI}
        >
          ✨ AI実行
        </button>

        <button className="btn" onClick={() => setManageOpen(true)}>
          🖼️ 画像管理
        </button>
        <button className="btn" onClick={handleSave}>
          💾 保存
        </button>
      </div>

      <div className="relative flex flex-grow items-center justify-center overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full touch-none object-contain"
          onMouseDown={handleStart}
          onMouseMove={handleMove}
          onMouseUp={handleEnd}
          onMouseLeave={handleEnd}
          onTouchStart={handleStart}
          onTouchMove={handleMove}
          onTouchEnd={handleEnd}
          onTouchCancel={handleEnd}
        />
      </div>

      <div
        className={`pointer-events-none fixed bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-black/85 px-6 py-3 text-sm text-white transition-opacity duration-300 ${
          toast.visible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {toast.msg}
      </div>

      <div
        className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 transition-opacity duration-300 ${
          loading.visible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="mb-2.5 h-10 w-10 animate-spin rounded-full border-4 border-neutral-300 border-t-sky-500" />
        <div className="text-sm font-bold">{loading.text}</div>
      </div>

      {manageOpen && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center overflow-y-auto bg-black/90 p-5">
          <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-xl bg-neutral-800 p-5">
            <span
              className="absolute right-5 top-2.5 cursor-pointer text-2xl text-neutral-400 hover:text-white"
              onClick={() => setManageOpen(false)}
            >
              &times;
            </span>
            <h2 className="m-0 text-lg">生成履歴 / 画像管理</h2>

            <div className="flex flex-wrap gap-4">
              <div className="flex min-w-[250px] flex-1 flex-col items-center gap-2.5 rounded-lg bg-neutral-700 p-3">
                <h3 className="m-0 text-sm text-neutral-300">① 元画像</h3>
                <img
                  src={historyOriginal || ''}
                  alt="未設定"
                  className="h-[22vh] w-full rounded bg-black object-contain"
                />
                <div className="flex gap-2.5">
                  <input
                    ref={importOriginalRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleImportOriginal(e.target.files[0])}
                  />
                  <button className="btn" onClick={() => importOriginalRef.current?.click()}>
                    📁 読込
                  </button>
                  <button className="btn" onClick={() => downloadDataUrl(historyOriginal, '1_original.png')}>
                    ⬇️ DL
                  </button>
                </div>
              </div>
              <div className="flex min-w-[250px] flex-1 flex-col items-center gap-2.5 rounded-lg bg-neutral-700 p-3">
                <h3 className="m-0 text-sm text-neutral-300">② 編集状態 (AI実行前)</h3>
                <img
                  src={historyEdited || ''}
                  alt="未設定"
                  className="h-[22vh] w-full rounded bg-black object-contain"
                />
                <div className="flex gap-2.5">
                  <input
                    ref={importEditedRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleImportEdited(e.target.files[0])}
                  />
                  <button className="btn" onClick={() => importEditedRef.current?.click()}>
                    📁 読込
                  </button>
                  <button className="btn" onClick={() => downloadDataUrl(historyEdited, '2_edited.png')}>
                    ⬇️ DL
                  </button>
                </div>
              </div>
            </div>

            <div className="py-1 text-center text-2xl">⬇️</div>

            <div className="flex justify-center">
              <div className="flex w-full max-w-xl flex-col items-center gap-2.5 rounded-lg bg-neutral-700 p-3">
                <h3 className="m-0 text-sm text-neutral-300">③ AI生成結果</h3>
                <img
                  src={historyGenerated || ''}
                  alt="未設定"
                  className="h-[35vh] w-full rounded bg-black object-contain"
                />
                <div className="flex gap-2.5">
                  <button className="btn" onClick={() => downloadDataUrl(historyGenerated, '3_generated.png')}>
                    ⬇️ DL
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
