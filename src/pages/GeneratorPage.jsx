import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';

// 元の index.html（vanilla JS 実装）のロジックをそのまま React に移植したもの。
// キャンバス上の一時的な描画状態（座標・切り出し済みキャンバスなど）は再描画の
// トリガーにする必要がないため useRef（可変値）に持たせ、ボタンの見た目や
// モーダルの開閉などUIに反映すべき状態だけ useState にしている。
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
    targetCtx.fillStyle = 'white';
    targetCtx.fill();

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

  const getCleanCanvasDataURL = useCallback(() => {
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
    return cCanvas.toDataURL('image/jpeg', 0.95);
  }, [drawPiece, hasSelection]);

  const loadMainImage = useCallback(
    (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          canvas.width = img.width;
          canvas.height = img.height;
          originalImageRef.current = img;
          pastEditsRef.current = [];
          resetCurrentSelection();

          setHistoryOriginal(event.target.result);
          setHistoryEdited(null);
          setHistoryGenerated(null);

          showToast('画像を読み込みました');
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    },
    [resetCurrentSelection, showToast]
  );

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

    const dataUrl = getCleanCanvasDataURL();
    setHistoryEdited(dataUrl);
    const base64Data = dataUrl.split(',')[1];

    setLoading({ visible: true, text: '処理中...' });

    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'This is an edited collage image where a body part was repositioned, leaving some awkward gaps or white spots. Please perform inpainting/blending: seamlessly blend the moved part with the surrounding body, clothes, and background, remove any awkward seams or gaps, and make it look like a naturally drawn, flawless illustration without altering the overall character design or composition.',
              },
              { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
            ],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'] },
      };

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

      const imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      setHistoryGenerated(imageUrl);

      const finalImg = new Image();
      finalImg.onload = () => {
        const canvas = canvasRef.current;
        canvas.width = finalImg.width;
        canvas.height = finalImg.height;
        originalImageRef.current = finalImg;
        pastEditsRef.current = [];
        resetCurrentSelection();
        setLoading({ visible: false, text: '処理中...' });
        showToast('✨ 完了しました');
      };
      finalImg.src = imageUrl;
    } catch (error) {
      setLoading({ visible: false, text: '処理中...' });
      showToast('AI処理に失敗しました');
    }
  }, [apiKeyInput, getCleanCanvasDataURL, resetCurrentSelection, setGeminiApiKey, showToast]);

  const handleSave = useCallback(() => {
    if (!originalImageRef.current) return showToast('保存する画像がありません');
    downloadDataUrl(getCleanCanvasDataURL(), 'current_edited_image.png');
  }, [downloadDataUrl, getCleanCanvasDataURL, showToast]);

  const handleImportOriginal = useCallback(
    (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        setHistoryOriginal(event.target.result);
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          canvas.width = img.width;
          canvas.height = img.height;
          originalImageRef.current = img;
          pastEditsRef.current = [];
          resetCurrentSelection();
          showToast('① 元画像を読み込みました');
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    },
    [resetCurrentSelection, showToast]
  );

  const handleImportEdited = useCallback(
    (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        setHistoryEdited(event.target.result);
        showToast('② 編集状態の画像を読み込みました');
      };
      reader.readAsDataURL(file);
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
