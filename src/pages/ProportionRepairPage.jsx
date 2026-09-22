import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';
import { copyCanvas, editWithProvider } from '../lib/banzaiPipeline.js';
import {
  buildRepairPrompt,
  canvasToDataUrl,
  comparisonPositionFromClientX,
  dataUrlToCanvas,
  DEFAULT_STRETCH_FACTOR,
  fullSelection,
  loadRepairSession,
  normalizeSelectionRect,
  readFileAsDataUrl,
  resizeCanvas,
  saveRepairSession,
  stretchedDimensions,
  transformSelection,
} from '../lib/proportionRepair.js';

const STEPS = [
  ['元画像', '比率を記録'],
  ['縦伸長', '高さだけ変更'],
  ['頭身調整', '手修正して元比率へ'],
  ['描画修復', '編集痕をAI修復'],
];

function downloadDataUrl(dataUrl, name) {
  if (!dataUrl) return;
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = name;
  anchor.click();
}

function Comparison({ before, after, slider, setSlider }) {
  const ref = useRef(null);
  const update = useCallback((clientX) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setSlider(comparisonPositionFromClientX(clientX, rect.left, rect.width));
  }, [setSlider]);
  const down = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    update(event.clientX);
  };
  const move = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); update(event.clientX);
  };
  const key = (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') setSlider((value) => Math.max(0, value - 2));
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') setSlider((value) => Math.min(100, value + 2));
  };
  return (
    <div ref={ref} className="relative h-full min-h-[24rem] w-full overflow-hidden bg-black">
      <img src={before} alt="修復前" className="absolute inset-0 h-full w-full object-contain" />
      <img src={after} alt="修復後" className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - slider}% 0 0)` }} />
      <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-white shadow" style={{ left: `${slider}%` }}>
        <span className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-slate-900/90 text-lg">↔</span>
      </div>
      <div role="slider" tabIndex={0} aria-label="修復前後の比較位置" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(slider)} onPointerDown={down} onPointerMove={move} onKeyDown={key} className="absolute inset-0 z-10 cursor-ew-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
        <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs">修復後</span>
        <span className="pointer-events-none absolute right-3 top-3 rounded bg-black/70 px-2 py-1 text-xs">修復前</span>
      </div>
      <div className="absolute inset-x-3 bottom-3 z-20 flex justify-between">
        <button type="button" className="rounded bg-black/75 px-3 py-2 text-xs" onClick={() => setSlider(100)}>修復後のみ</button>
        <button type="button" className="rounded bg-black/75 px-3 py-2 text-xs" onClick={() => setSlider(0)}>修復前のみ</button>
      </div>
    </div>
  );
}

function Range({ label, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-slate-300"><span>{label}</span><span className="font-mono text-cyan-300">{value}{unit}</span></span>
      <input type="range" className="h-11 w-full cursor-pointer touch-pan-x accent-cyan-500" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export default function ProportionRepairPage() {
  const { entries } = useApiKeys();
  const fileRef = useRef(null);
  const manualFileRef = useRef(null);
  const canvasRef = useRef(null);
  const editorViewportRef = useRef(null);
  const pointerRef = useRef(null);
  const abortRef = useRef(null);
  const originalRef = useRef(null);
  const stretchedRef = useRef(null);
  const manualRef = useRef(null);
  const normalizedRef = useRef(null);
  const repairedRef = useRef(null);
  const undoRef = useRef([]);
  const [step, setStep] = useState(1);
  const [originalMeta, setOriginalMeta] = useState(null);
  const [stretchFactor, setStretchFactor] = useState(DEFAULT_STRETCH_FACTOR);
  const [selection, setSelection] = useState(null);
  const [transform, setTransform] = useState({ scale: 0.78, rotation: 0, offsetX: 0, offsetY: 0 });
  const [editorMode, setEditorMode] = useState('pan');
  const [editorZoom, setEditorZoom] = useState(1);
  const [provider, setProvider] = useState('openai');
  const [fallback, setFallback] = useState(true);
  const [repairNotes, setRepairNotes] = useState('灰色の塗り跡、黒い継ぎ目、切り抜き境界、途切れた背景と髪を自然につなぐ');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('元画像を選択してください。');
  const [requestCount, setRequestCount] = useState(0);
  const [slider, setSlider] = useState(50);
  const [version, setVersion] = useState(0);
  const [urls, setUrls] = useState({ original: '', stretched: '', manual: '', normalized: '', repaired: '' });

  const updateUrl = useCallback((name, canvas) => {
    const dataUrl = canvasToDataUrl(canvas);
    setUrls((current) => ({ ...current, [name]: dataUrl }));
    return dataUrl;
  }, []);

  const initialize = useCallback(async (dataUrl, filename = 'image.png') => {
    const original = await dataUrlToCanvas(dataUrl);
    const dimensions = stretchedDimensions(original.width, original.height, stretchFactor);
    const stretched = resizeCanvas(original, dimensions.width, dimensions.height);
    originalRef.current = original;
    stretchedRef.current = stretched;
    manualRef.current = copyCanvas(stretched);
    normalizedRef.current = null;
    repairedRef.current = null;
    undoRef.current = [];
    setOriginalMeta({ width: original.width, height: original.height, ratio: original.width / original.height, filename });
    setUrls({ original: canvasToDataUrl(original), stretched: canvasToDataUrl(stretched), manual: canvasToDataUrl(stretched), normalized: '', repaired: '' });
    setSelection(null); setEditorMode('pan'); setEditorZoom(1); setStep(1); setRequestCount(0); setSlider(50);
    setMessage('元画像の解像度と縦横比を記録しました。工程2へ進めます。');
    setVersion((value) => value + 1);
  }, [stretchFactor]);

  const loadFile = useCallback(async (file) => {
    if (!file?.type?.startsWith('image/')) return;
    try { await initialize(await readFileAsDataUrl(file), file.name); }
    catch (error) { setMessage(error.message); }
  }, [initialize]);

  useWkAutoLoad('/proportion-repair', () => Boolean(originalRef.current), (dataUrl) => initialize(dataUrl, 'wk-image.png'));

  useEffect(() => {
    let active = true;
    loadRepairSession().then(async (session) => {
      if (!active || !session?.urls?.original) return;
      try {
        const [original, stretched, manual, normalized, repaired] = await Promise.all([
          dataUrlToCanvas(session.urls.original),
          session.urls.stretched ? dataUrlToCanvas(session.urls.stretched) : null,
          session.urls.manual ? dataUrlToCanvas(session.urls.manual) : null,
          session.urls.normalized ? dataUrlToCanvas(session.urls.normalized) : null,
          session.urls.repaired ? dataUrlToCanvas(session.urls.repaired) : null,
        ]);
        if (!active) return;
        originalRef.current = original; stretchedRef.current = stretched; manualRef.current = manual;
        normalizedRef.current = normalized; repairedRef.current = repaired;
        setUrls(session.urls); setOriginalMeta(session.originalMeta); setStretchFactor(session.stretchFactor || DEFAULT_STRETCH_FACTOR);
        setStep(session.step || 1); setProvider(session.provider || 'openai'); setRepairNotes(session.repairNotes || '');
        setRequestCount(session.requestCount || 0); setMessage('前回の頭身補正セッションを復元しました。'); setVersion((value) => value + 1);
      } catch { /* a broken optional draft must not block a new workflow */ }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!urls.original) return undefined;
    const timer = setTimeout(() => {
      saveRepairSession({ urls, originalMeta, stretchFactor, step, provider, repairNotes, requestCount }).catch(() => {});
    }, 450);
    return () => clearTimeout(timer);
  }, [urls, originalMeta, stretchFactor, step, provider, repairNotes, requestCount]);

  const previewCanvas = useMemo(() => {
    if (step !== 3 || !manualRef.current || !selection) return null;
    return transformSelection(manualRef.current, selection, transform);
  }, [step, selection, transform, version]);

  useEffect(() => {
    const visible = canvasRef.current;
    if (!visible || step === 4 && urls.repaired) return;
    const image = step === 1 ? originalRef.current : step === 2 ? stretchedRef.current : step === 3 ? (previewCanvas || manualRef.current) : normalizedRef.current;
    if (!image) return;
    visible.width = image.width; visible.height = image.height;
    const ctx = visible.getContext('2d');
    ctx.drawImage(image, 0, 0);
    if (step === 3 && selection) {
      ctx.save(); ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = Math.max(3, image.width / 250); ctx.setLineDash([12, 8]);
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height); ctx.restore();
    }
  }, [step, version, selection, previewCanvas, urls.repaired]);

  const canvasPosition = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvasRef.current.width / rect.width, y: (event.clientY - rect.top) * canvasRef.current.height / rect.height };
  };
  const pointerDown = (event) => {
    if (step !== 3 || editorMode !== 'select' || busy || !manualRef.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = canvasPosition(event); setSelection(null);
  };
  const pointerMove = (event) => {
    if (!pointerRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    setSelection(normalizeSelectionRect(pointerRef.current, canvasPosition(event), manualRef.current.width, manualRef.current.height));
  };
  const pointerUp = (event) => {
    if (!pointerRef.current || !manualRef.current) return;
    const next = normalizeSelectionRect(pointerRef.current, canvasPosition(event), manualRef.current.width, manualRef.current.height);
    pointerRef.current = null;
    if (!next) return;
    setSelection(next);
    setEditorMode('pan');
    setMessage('範囲を選択しました。表示移動モードに戻しました。下のボタンで大きさと位置を調整してください。');
  };
  const pointerCancel = () => { pointerRef.current = null; };

  const changeTransform = (patch) => setTransform((current) => ({ ...current, ...patch }));
  const nudgeTransform = (key, amount) => setTransform((current) => {
    const limits = key === 'scale' ? [0.45, 1.4] : key === 'rotation' ? [-30, 30] : [-400, 400];
    const next = Math.max(limits[0], Math.min(limits[1], Number((current[key] + amount).toFixed(2))));
    return { ...current, [key]: next };
  });

  const rebuildStretch = () => {
    if (!originalRef.current) return;
    const size = stretchedDimensions(originalRef.current.width, originalRef.current.height, stretchFactor);
    stretchedRef.current = resizeCanvas(originalRef.current, size.width, size.height);
    manualRef.current = copyCanvas(stretchedRef.current);
    normalizedRef.current = null; repairedRef.current = null; undoRef.current = [];
    setUrls((current) => ({ ...current, stretched: canvasToDataUrl(stretchedRef.current), manual: canvasToDataUrl(manualRef.current), normalized: '', repaired: '' }));
    setSelection(null); setEditorMode('pan'); setEditorZoom(1); setStep(2); setMessage(`横幅${size.width}pxを維持し、高さだけ${size.height}pxへ伸長しました。`); setVersion((value) => value + 1);
  };

  const applyTransform = () => {
    if (!selection || !manualRef.current) return setMessage('先に画像上で頭部などの範囲を囲んでください。');
    undoRef.current = [...undoRef.current.slice(-9), copyCanvas(manualRef.current)];
    manualRef.current = transformSelection(manualRef.current, selection, transform);
    updateUrl('manual', manualRef.current); setSelection(null); setTransform({ scale: 0.78, rotation: 0, offsetX: 0, offsetY: 0 });
    setMessage('選択範囲の変形を適用しました。必要なら別の範囲も続けて調整できます。'); setVersion((value) => value + 1);
  };
  const undo = () => {
    const previous = undoRef.current.pop();
    if (!previous) return;
    manualRef.current = previous; updateUrl('manual', previous); setSelection(null); setMessage('直前の調整を戻しました。'); setVersion((value) => value + 1);
  };

  const loadManual = async (file) => {
    if (!file?.type?.startsWith('image/')) return;
    try {
      const canvas = await dataUrlToCanvas(await readFileAsDataUrl(file));
      undoRef.current = manualRef.current ? [...undoRef.current.slice(-9), copyCanvas(manualRef.current)] : [];
      manualRef.current = canvas; updateUrl('manual', canvas); setSelection(null); setEditorMode('pan'); setEditorZoom(1); setStep(3);
      setMessage('外部で手修正した画像を読み込みました。元比率へ復元できます。'); setVersion((value) => value + 1);
    } catch (error) { setMessage(error.message); }
  };

  const normalize = () => {
    if (!manualRef.current || !originalMeta) return;
    normalizedRef.current = resizeCanvas(manualRef.current, originalMeta.width, originalMeta.height);
    repairedRef.current = null;
    setUrls((current) => ({ ...current, normalized: canvasToDataUrl(normalizedRef.current), repaired: '' }));
    setSelection(null); setStep(4); setMessage(`元画像と同じ ${originalMeta.width}×${originalMeta.height}px に復元しました。AI修復前画像も保存できます。`); setVersion((value) => value + 1);
  };

  const runRepair = async () => {
    if (!normalizedRef.current) return;
    const primaryKey = entries[provider]?.apiKey;
    if (!primaryKey) return setMessage(`設定画面で${provider === 'openai' ? 'OpenAI' : 'Gemini'} APIキーを設定してください。`);
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); repairedRef.current = null;
    const candidates = [provider];
    const alternate = provider === 'openai' ? 'gemini' : 'openai';
    if (fallback && entries[alternate]?.apiKey) candidates.push(alternate);
    let lastError;
    for (const candidate of candidates) {
      try {
        setMessage(`${candidate === 'openai' ? 'OpenAI' : 'Gemini'}で描画修復中…`);
        setRequestCount((value) => value + 1);
        const generated = await editWithProvider({
          provider: candidate,
          key: entries[candidate]?.apiKey,
          image: normalizedRef.current,
          selection: fullSelection(normalizedRef.current.width, normalizedRef.current.height),
          prompt: buildRepairPrompt(repairNotes),
          signal: controller.signal,
        });
        const output = resizeCanvas(await dataUrlToCanvas(generated.src), originalMeta.width, originalMeta.height);
        repairedRef.current = output; updateUrl('repaired', output); setSlider(50);
        setMessage(`${candidate === 'openai' ? 'OpenAI' : 'Gemini'}で修復が完了しました。比較して保存できます。`); setVersion((value) => value + 1);
        lastError = null; break;
      } catch (error) {
        if (error.name === 'AbortError') { lastError = error; break; }
        lastError = error;
      }
    }
    if (lastError) setMessage(lastError.name === 'AbortError' ? '修復を中止しました。AI修復前画像は保持されています。' : `描画修復に失敗しました: ${lastError.message}。AI修復前画像は保持されています。`);
    setBusy(false); abortRef.current = null;
  };

  const reset = () => {
    abortRef.current?.abort(); originalRef.current = stretchedRef.current = manualRef.current = normalizedRef.current = repairedRef.current = null;
    undoRef.current = []; setUrls({ original: '', stretched: '', manual: '', normalized: '', repaired: '' }); setOriginalMeta(null); setSelection(null); setEditorMode('pan'); setEditorZoom(1); setStep(1); setRequestCount(0); setMessage('元画像を選択してください。'); setVersion((value) => value + 1);
  };

  const canVisit = (number) => number === 1 ? Boolean(urls.original) : number === 2 ? Boolean(urls.stretched) : number === 3 ? Boolean(urls.manual) : Boolean(urls.normalized);

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-full max-w-7xl flex-col p-3 sm:p-4">
        <div className="mb-3 grid grid-cols-4 gap-1 rounded-xl border border-slate-700 bg-slate-900 p-1.5">
          {STEPS.map(([title, subtitle], index) => {
            const number = index + 1; const enabled = canVisit(number);
            return <button key={title} type="button" disabled={!enabled} onClick={() => enabled && setStep(number)} className={`min-w-0 rounded-lg px-1 py-2 text-center transition-colors ${step === number ? 'bg-cyan-600 text-white' : enabled ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600'}`}>
              <span className="block text-xs font-bold sm:text-sm">{number}. {title}</span><span className="hidden text-[10px] sm:block">{subtitle}</span>
            </button>;
          })}
        </div>

        <div className="grid flex-1 grid-cols-1 gap-3 lg:min-h-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
          <section className="flex min-h-[28rem] flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 lg:min-h-0">
            <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2 text-xs text-slate-400">
              <span>{message}</span>
              {originalMeta && <span className="shrink-0 font-mono">元 {originalMeta.width}×{originalMeta.height}</span>}
            </div>
            <div ref={editorViewportRef} className={`relative flex-1 bg-black ${step === 3 ? 'block h-[62svh] min-h-[28rem] overflow-auto overscroll-contain' : 'flex min-h-[24rem] items-center justify-center overflow-hidden'}`}>
              {step === 3 && urls.manual && (
                <div className="sticky left-0 top-0 z-30 flex w-full flex-wrap justify-center gap-1 border-b border-slate-600 bg-slate-950/95 p-1.5 shadow-xl backdrop-blur">
                  <button type="button" className={`min-h-11 rounded-lg px-3 text-xs font-bold ${editorMode === 'pan' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-200'}`} onClick={() => setEditorMode('pan')}>✋ 表示を移動</button>
                  <button type="button" className={`min-h-11 rounded-lg px-3 text-xs font-bold ${editorMode === 'select' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-200'}`} onClick={() => { setEditorMode('select'); setSelection(null); setMessage('選択モードです。修正したい範囲を指で囲んでください。選択後は自動で表示移動モードへ戻ります。'); }}>＋ 範囲を選択</button>
                  <button type="button" aria-label="縮小表示" className="min-h-11 min-w-11 rounded-lg bg-slate-800 text-lg" onClick={() => setEditorZoom((value) => Math.max(0.75, Number((value - 0.25).toFixed(2))))}>−</button>
                  <span className="flex min-h-11 min-w-14 items-center justify-center rounded-lg bg-black/50 px-2 font-mono text-xs">{Math.round(editorZoom * 100)}%</span>
                  <button type="button" aria-label="拡大表示" className="min-h-11 min-w-11 rounded-lg bg-slate-800 text-lg" onClick={() => setEditorZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))))}>＋</button>
                </div>
              )}
              {!urls.original ? (
                <button type="button" className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-slate-400 hover:bg-slate-900" onClick={() => fileRef.current?.click()}><span className="text-4xl">↥</span><span className="font-semibold">元画像を選択</span><span className="text-xs">選択時点ではAPI通信しません</span></button>
              ) : step === 4 && urls.repaired ? (
                <Comparison before={urls.normalized} after={urls.repaired} slider={slider} setSlider={setSlider} />
              ) : (
                <canvas
                  ref={canvasRef}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={pointerCancel}
                  className={step === 3
                    ? `shrink-0 select-none ${editorMode === 'select' ? 'cursor-crosshair touch-none' : 'cursor-grab touch-pan-x touch-pan-y'}`
                    : 'max-h-full max-w-full object-contain'}
                  style={step === 3 ? { width: `${editorZoom * 100}%`, height: 'auto', maxWidth: 'none' } : undefined}
                />
              )}
              {urls.original && <button type="button" className="absolute bottom-3 right-3 z-30 rounded-lg bg-black/75 px-3 py-2 text-xs font-semibold" onClick={() => fileRef.current?.click()}>画像変更</button>}
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(event) => { loadFile(event.target.files?.[0]); event.target.value = ''; }} />
              <input ref={manualFileRef} type="file" accept="image/*" className="hidden" onChange={(event) => { loadManual(event.target.files?.[0]); event.target.value = ''; }} />
            </div>
          </section>

          <aside className="flex flex-col rounded-xl border border-slate-700 bg-slate-900 lg:min-h-0">
            <div className="flex-1 space-y-4 overflow-visible p-4 lg:overflow-y-auto">
              {step === 1 && <>
                <h2 className="font-bold">工程1：元画像</h2>
                {originalMeta ? <div className="space-y-2 rounded-lg bg-slate-950 p-3 text-sm"><p>解像度：<b>{originalMeta.width} × {originalMeta.height}px</b></p><p>縦横比：<b>{originalMeta.ratio.toFixed(6)}</b></p><p className="break-all text-xs text-slate-400">{originalMeta.filename}</p></div> : <p className="text-sm text-slate-400">画像を選ぶと元の解像度と比率を記録します。</p>}
                <button type="button" className="btn w-full border-cyan-700 bg-cyan-700 disabled:opacity-40" disabled={!originalMeta} onClick={rebuildStretch}>工程2へ</button>
              </>}

              {step === 2 && <>
                <h2 className="font-bold">工程2：縦方向ストレッチ</h2>
                <p className="text-sm text-slate-400">横幅と内容を固定し、高さだけ変更します。AIリクエストは発生しません。</p>
                <Range label="縦伸長率" value={Number(stretchFactor.toFixed(3))} min={1.05} max={1.6} step={0.01} onChange={setStretchFactor} />
                <div className="grid grid-cols-4 gap-1">{[1.2, 1.25, 4 / 3, 1.4].map((value) => <button key={value} type="button" className="btn px-1 text-xs" onClick={() => setStretchFactor(value)}>{value === 4 / 3 ? '4/3' : value}</button>)}</div>
                <button type="button" className="btn w-full" onClick={rebuildStretch}>この倍率で再作成</button>
                <button type="button" className="btn w-full border-cyan-700 bg-cyan-700" onClick={() => { setStep(3); setEditorMode('pan'); setEditorZoom(1); setMessage('まず表示をスクロールして対象を画面内に置き、「範囲を選択」を押してください。'); }}>工程3へ</button>
              </>}

              {step === 3 && <>
                <h2 className="font-bold">工程3：頭身調整</h2>
                <div className="rounded-lg border border-cyan-800 bg-cyan-950/40 p-3 text-sm text-cyan-100">
                  <b>{selection ? '範囲を選択済み' : editorMode === 'select' ? '選択モード' : '表示移動モード'}</b>
                  <p className="mt-1 text-xs text-cyan-200/80">表示移動中は画像を上下左右へスクロールできます。「範囲を選択」を押した時だけ、指のドラッグが選択操作になります。</p>
                </div>
                <Range label="選択範囲の倍率" value={transform.scale} min={0.45} max={1.4} step={0.01} unit="×" onChange={(value) => setTransform((current) => ({ ...current, scale: value }))} />
                <div className="grid grid-cols-3 gap-2">
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => nudgeTransform('scale', -0.05)}>− 小さく</button>
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => changeTransform({ scale: 1 })}>等倍</button>
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => nudgeTransform('scale', 0.05)}>＋ 大きく</button>
                </div>
                <Range label="左右移動" value={transform.offsetX} min={-400} max={400} unit="px" onChange={(value) => setTransform((current) => ({ ...current, offsetX: value }))} />
                <Range label="上下移動" value={transform.offsetY} min={-400} max={400} unit="px" onChange={(value) => setTransform((current) => ({ ...current, offsetY: value }))} />
                <div className="mx-auto grid w-44 grid-cols-3 gap-2">
                  <span />
                  <button type="button" aria-label="上へ移動" className="btn min-h-11 text-lg" disabled={!selection} onClick={() => nudgeTransform('offsetY', -12)}>↑</button>
                  <span />
                  <button type="button" aria-label="左へ移動" className="btn min-h-11 text-lg" disabled={!selection} onClick={() => nudgeTransform('offsetX', -12)}>←</button>
                  <button type="button" className="btn min-h-11 text-xs" disabled={!selection} onClick={() => changeTransform({ offsetX: 0, offsetY: 0 })}>中央</button>
                  <button type="button" aria-label="右へ移動" className="btn min-h-11 text-lg" disabled={!selection} onClick={() => nudgeTransform('offsetX', 12)}>→</button>
                  <span />
                  <button type="button" aria-label="下へ移動" className="btn min-h-11 text-lg" disabled={!selection} onClick={() => nudgeTransform('offsetY', 12)}>↓</button>
                  <span />
                </div>
                <Range label="回転" value={transform.rotation} min={-30} max={30} unit="°" onChange={(value) => setTransform((current) => ({ ...current, rotation: value }))} />
                <div className="grid grid-cols-3 gap-2">
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => nudgeTransform('rotation', -1)}>↶ −1°</button>
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => changeTransform({ rotation: 0 })}>0°</button>
                  <button type="button" className="btn min-h-11" disabled={!selection} onClick={() => nudgeTransform('rotation', 1)}>＋1° ↷</button>
                </div>
                <div className="grid grid-cols-2 gap-2"><button type="button" className="btn" onClick={undo} disabled={!undoRef.current.length}>↶ 戻す</button><button type="button" className="btn border-cyan-700 bg-cyan-700" onClick={applyTransform} disabled={!selection}>調整を適用</button></div>
                <button type="button" className="btn w-full" onClick={() => manualFileRef.current?.click()}>外部で手修正した画像を読込</button>
                <button type="button" className="btn w-full border-cyan-700 bg-cyan-700" onClick={normalize}>元比率へ戻して工程4へ</button>
              </>}

              {step === 4 && <>
                <h2 className="font-bold">工程4：描画修復</h2>
                <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-xs text-emerald-300">AI修復前の元比率復元版は保持済みです。生成に失敗しても失われません。</div>
                <label className="block text-xs text-slate-300">修復プロバイダー<select value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm"><option value="openai">OpenAI</option><option value="gemini">Gemini</option></select></label>
                <label className="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" className="mt-0.5 accent-cyan-500" checked={fallback} onChange={(event) => setFallback(event.target.checked)} /><span>失敗時、設定済みの別プロバイダーで1回だけ継続</span></label>
                <label className="block text-xs text-slate-300">修復対象<textarea rows={4} value={repairNotes} onChange={(event) => setRepairNotes(event.target.value)} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm" /></label>
                <div className="rounded-lg bg-slate-950 p-3 text-sm">AIリクエスト数：<b className="text-amber-300">{requestCount}</b></div>
                {busy ? <button type="button" className="w-full rounded-lg bg-rose-700 px-3 py-3 font-bold" onClick={() => abortRef.current?.abort()}>処理を中止</button> : <button type="button" className="w-full rounded-lg bg-cyan-600 px-3 py-3 font-bold disabled:opacity-40" disabled={!entries[provider]?.apiKey} onClick={runRepair}>描画を修復・高画質化</button>}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><button type="button" className="btn" onClick={() => downloadDataUrl(urls.normalized, 'proportion_manual_normalized.png')}>AI修復前を保存</button><button type="button" className="btn border-emerald-700 bg-emerald-700 disabled:opacity-40" disabled={!urls.repaired} onClick={() => downloadDataUrl(urls.repaired, 'proportion_repaired.png')}>完成画像を保存</button></div>
              </>}
            </div>
            <div className="border-t border-slate-700 p-3"><button type="button" className="btn w-full text-slate-300" onClick={reset}>新しい画像で最初から</button></div>
          </aside>
        </div>
      </div>
    </div>
  );
}
