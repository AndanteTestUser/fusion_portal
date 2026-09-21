import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';
import {
  buildGeminiCanvasPrompt,
  GEMINI_CANVAS_MODEL,
  getGeminiErrorMessage,
  isRetryableGeminiStatus,
  parseTags,
} from '../lib/geminiCanvas.js';

const PRESET_STORAGE_KEY = 'fusion_portal_gemini_canvas_presets';
const MAX_IMAGE_SIDE = 2048;

const DIRECT_STYLE = '(mature adult woman:1.2), realistic adult proportions, tall stature, slender, detailed beautiful face, detailed shading, intricate details';
const DIRECT_AVOID = 'childlike proportions, chibi, oversized eyes, round juvenile face, deformed anatomy, flat color';

function now() {
  return new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function loadPresets() {
  try {
    const value = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePresets(value) {
  try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(value)); } catch { /* optional */ }
}

function imageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('画像を読み込めませんでした。対応形式を確認してください。'));
    image.src = dataUrl;
  });
}

async function normalizeImage(dataUrl, maxSide = MAX_IMAGE_SIDE, mimeType = 'image/png', quality = 0.92) {
  const image = await imageElement(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType, quality);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsDataURL(file);
  });
}

function splitDataUrl(dataUrl) {
  const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('画像データの形式を読み取れませんでした。');
  return { mimeType: match[1], data: match[2] };
}

async function apiError(response) {
  let payload = {};
  try { payload = await response.json(); } catch { /* empty response */ }
  const error = new Error(getGeminiErrorMessage(response.status, payload));
  error.status = response.status;
  throw error;
}

async function callGemini(parts, apiKey, responseModalities, signal) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CANVAS_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseModalities },
        }),
        signal,
      }
    );
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Geminiへの接続に失敗しました。通信状態を確認してください。');
  }
  if (!response.ok) await apiError(response);
  const result = await response.json();
  const candidate = result.candidates?.[0];
  if (!candidate) {
    const reason = result.promptFeedback?.blockReason;
    throw new Error(reason ? `生成できませんでした: ${reason}` : 'Geminiから結果が返されませんでした。');
  }
  return candidate;
}

async function analyzeImage(dataUrl, apiKey, signal) {
  const { mimeType, data } = splitDataUrl(dataUrl);
  const instruction = [
    'Analyze the supplied image for an image-to-image editor.',
    'Return only a comma-separated list of concise English tags.',
    'Prioritize character count and adult status, exact body orientation and pose, camera angle, foreground/background overlap, clothing, props, environment, and visible effects.',
    'Describe only what is visibly supported. Do not infer sensitive traits.',
  ].join(' ');
  const candidate = await callGemini(
    [{ text: instruction }, { inlineData: { mimeType, data } }],
    apiKey,
    ['TEXT'],
    signal
  );
  const text = candidate.content?.parts?.filter((part) => part.text).map((part) => part.text).join('\n');
  if (!text) throw new Error('画像解析のタグが返されませんでした。');
  return parseTags(text);
}

async function generateImage(prompt, dataUrl, apiKey, signal) {
  const { mimeType, data } = splitDataUrl(dataUrl);
  const candidate = await callGemini(
    [{ text: prompt }, { inlineData: { mimeType, data } }],
    apiKey,
    ['IMAGE'],
    signal
  );
  const result = candidate.content?.parts?.find((part) => part.inlineData)?.inlineData;
  if (!result?.data) {
    const finish = candidate.finishReason;
    throw new Error(finish ? `画像が返されませんでした: ${finish}` : 'Geminiから画像が返されませんでした。');
  }
  return `data:${result.mimeType || 'image/png'};base64,${result.data}`;
}

function Field({ label, hint, rows, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 flex flex-wrap items-center gap-1 text-xs font-semibold text-slate-300">
        {label}{hint && <span className="font-normal text-violet-400">{hint}</span>}
      </span>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm leading-5 text-slate-100 outline-none transition-colors focus:border-violet-500"
      />
    </label>
  );
}

export default function GeminiCanvasPage() {
  const { entries } = useApiKeys();
  const apiKey = entries.gemini?.apiKey || '';
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const [mode, setMode] = useState('specialized');
  const [sourceUrl, setSourceUrl] = useState('');
  const [resultUrl, setResultUrl] = useState('');
  const [slider, setSlider] = useState(50);
  const [tags, setTags] = useState([]);
  const [status, setStatus] = useState('元画像を選択してください。');
  const [busy, setBusy] = useState('');
  const [logs, setLogs] = useState([{ at: now(), message: 'System ready.', type: 'muted' }]);
  const [presets, setPresets] = useState(loadPresets);
  const [autoRetry, setAutoRetry] = useState(true);
  const [addLightEffects, setAddLightEffects] = useState(false);
  const [clarifyClothing, setClarifyClothing] = useState(false);
  const [situation, setSituation] = useState('画像を読み込むと構図タグが自動入力されます。');
  const [style, setStyle] = useState('(mature adult body:1.2), tall stature, slender');
  const [face, setFace] = useState('(gentle eyes:1.1), soft facial features, playful smile, detailed shading, intricate details');
  const [negative, setNegative] = useState('childlike proportions, chibi, deformed anatomy, poorly drawn hands, poorly drawn face, flat color');

  const addLog = useCallback((message, type = 'normal') => {
    setLogs((current) => [...current.slice(-59), { at: now(), message, type }]);
  }, []);

  const analyzeLoadedImage = useCallback(async (dataUrl) => {
    if (!apiKey) {
      setSituation('Gemini APIキーを設定すると、画像の構図タグを自動解析できます。');
      setStatus('画像を読み込みました。Gemini APIキーは未設定です。');
      addLog('画像読込完了。Gemini APIキー未設定のため解析を待機しています。', 'warn');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('analyzing');
    setStatus('Geminiで画像を解析しています…');
    addLog('画像解析を開始しました。', 'system');
    try {
      const nextTags = await analyzeImage(dataUrl, apiKey, controller.signal);
      setTags(nextTags);
      setSituation(nextTags.join(', '));
      setStatus('解析が完了しました。');
      addLog('画像の構図タグを入力しました。', 'success');
    } catch (error) {
      if (error.name === 'AbortError') return;
      setStatus(`解析に失敗しました: ${error.message}`);
      setSituation('解析に失敗しました。手動で入力してください。');
      addLog(`画像解析エラー: ${error.message}`, 'error');
    } finally {
      setBusy('');
      abortRef.current = null;
    }
  }, [addLog, apiKey]);

  const loadDataUrl = useCallback(async (dataUrl) => {
    try {
      abortRef.current?.abort();
      const normalized = await normalizeImage(dataUrl);
      setSourceUrl(normalized);
      setResultUrl('');
      setSlider(50);
      setTags([]);
      await analyzeLoadedImage(normalized);
    } catch (error) {
      setStatus(error.message);
      addLog(error.message, 'error');
    }
  }, [addLog, analyzeLoadedImage]);

  const loadFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    await loadDataUrl(await readFileAsDataUrl(file));
  }, [loadDataUrl]);

  useWkAutoLoad('/gemini-canvas', () => Boolean(sourceUrl), loadDataUrl);

  useEffect(() => () => abortRef.current?.abort(), []);

  const finalPrompt = useMemo(() => buildGeminiCanvasPrompt({
    mode, situation, style, face, negative, addLightEffects, clarifyClothing,
  }), [mode, situation, style, face, negative, addLightEffects, clarifyClothing]);

  const runGeneration = async () => {
    if (!sourceUrl) return setStatus('先に元画像を選択してください。');
    if (!apiKey) return setStatus('設定画面でGemini APIキーを設定してください。');
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('generating');
    setStatus('Geminiで画像を生成しています…');
    addLog(`${mode === 'direct' ? 'ダイレクト' : '特化カスタマイズ'}設定で生成を開始しました。`, 'system');
    try {
      let generated;
      try {
        generated = await generateImage(finalPrompt, sourceUrl, apiKey, controller.signal);
      } catch (error) {
        if (!autoRetry || !isRetryableGeminiStatus(error.status)) throw error;
        addLog('一時的なAPIエラーのため、入力を軽量化して1回再試行します。', 'warn');
        const lightweight = await normalizeImage(sourceUrl, 1536, 'image/jpeg', 0.88);
        generated = await generateImage(finalPrompt, lightweight, apiKey, controller.signal);
      }
      setResultUrl(generated);
      setSlider(50);
      setStatus('画像の変換が完了しました。');
      addLog('生成画像を受信しました。', 'success');
    } catch (error) {
      if (error.name === 'AbortError') {
        setStatus('処理を中止しました。');
      } else {
        setStatus(`生成に失敗しました: ${error.message}`);
        addLog(`生成エラー: ${error.message}`, 'error');
      }
    } finally {
      setBusy('');
      abortRef.current = null;
    }
  };

  const addPreset = () => {
    const name = window.prompt('プリセット名を入力してください', 'マイプリセット');
    if (!name?.trim()) return;
    const next = [{ id: crypto.randomUUID(), name: name.trim(), style, face, negative }, ...presets].slice(0, 20);
    setPresets(next);
    savePresets(next);
    addLog(`プリセット「${name.trim()}」を保存しました。`, 'success');
  };

  const applyPreset = (preset) => {
    setMode('specialized');
    setStyle(preset.style);
    setFace(preset.face);
    setNegative(preset.negative);
    addLog(`プリセット「${preset.name}」を適用しました。`, 'system');
  };

  const removePreset = (id) => {
    const next = presets.filter((preset) => preset.id !== id);
    setPresets(next);
    savePresets(next);
  };

  const download = () => {
    if (!resultUrl) return;
    const anchor = document.createElement('a');
    anchor.href = resultUrl;
    anchor.download = `gemini_canvas_${Date.now()}.png`;
    anchor.click();
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-slate-100 lg:overflow-hidden">
      <div className="grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[minmax(0,1.25fr)_minmax(22rem,1fr)_19rem]">
        <section className="flex min-h-[42rem] flex-col border-b border-slate-700 p-4 lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">▧ Viewer</h2>
            <button type="button" onClick={download} disabled={!resultUrl} className="btn border-violet-700 bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40">
              ↓ 保存
            </button>
          </div>

          <div
            className="relative flex min-h-[28rem] flex-1 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-slate-600 bg-slate-900"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); loadFile(event.dataTransfer.files?.[0]); }}
          >
            {!sourceUrl ? (
              <button type="button" className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-slate-400 hover:bg-slate-800/60" onClick={() => fileInputRef.current?.click()}>
                <span className="text-4xl">↥</span>
                <span className="font-medium">元画像を選択またはドロップ</span>
                <span className="text-xs text-slate-500">読み込み後に構図タグを自動解析します</span>
              </button>
            ) : (
              <div className="relative h-full min-h-[28rem] w-full bg-black">
                <img src={sourceUrl} alt="変換前" className="absolute inset-0 h-full w-full object-contain" />
                {resultUrl && (
                  <img
                    src={resultUrl}
                    alt="変換後"
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ clipPath: `inset(0 ${100 - slider}% 0 0)` }}
                  />
                )}
                {resultUrl && <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${slider}%` }} />}
                {resultUrl && (
                  <input aria-label="変換前後の比較位置" type="range" min="0" max="100" value={slider} onChange={(event) => setSlider(Number(event.target.value))} className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0" />
                )}
                <button type="button" onClick={() => fileInputRef.current?.click()} className="absolute bottom-3 right-3 rounded-lg bg-black/70 px-3 py-2 text-xs font-semibold text-white backdrop-blur hover:bg-black/90">
                  画像を変更
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { loadFile(event.target.files?.[0]); event.target.value = ''; }} />
          </div>

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-slate-400">抽出されたタグ</h3>
              <span className="text-[11px] text-slate-500">{status}</span>
            </div>
            <div className="flex min-h-7 flex-wrap gap-2">
              {tags.length ? tags.map((tag, index) => <span key={`${tag}-${index}`} className="rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-300">{tag}</span>) : <span className="text-xs italic text-slate-500">タグはまだありません</span>}
            </div>
          </div>
        </section>

        <section className="flex min-h-[48rem] flex-col border-b border-slate-700 bg-slate-950 lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="border-b border-slate-700 bg-slate-900 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">⚙ Controls</h2>
            <div className="grid grid-cols-2 rounded-lg bg-slate-950 p-1">
              {[
                ['direct', 'ダイレクト実行'],
                ['specialized', '特化カスタマイズ'],
              ].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setMode(id)} disabled={Boolean(busy)} className={`rounded-md px-2 py-2 text-sm transition-colors ${mode === id ? 'bg-violet-600 font-semibold text-white shadow' : 'text-slate-400 hover:text-white'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-visible p-4 lg:overflow-y-auto">
            {mode === 'direct' ? (
              <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-xs leading-5 text-slate-400">
                <p className="mb-2 text-sm font-semibold text-slate-200">汎用大人化プロンプト</p>
                <p className="rounded bg-slate-950 p-2"><span className="text-emerald-400">Style:</span> {DIRECT_STYLE}</p>
                <p className="mt-2 rounded bg-slate-950 p-2"><span className="text-rose-400">Avoid:</span> {DIRECT_AVOID}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <Field label="シチュエーション / 構図" hint="(API自動解析結果)" rows={4} value={situation} onChange={setSituation} />
                <Field label="スタイル / 体型" hint="(固定推奨)" rows={2} value={style} onChange={setStyle} />
                <Field label="顔 / 表情・品質" hint="(可変)" rows={3} value={face} onChange={setFace} />
                <Field label="除外要素" rows={3} value={negative} onChange={setNegative} />
              </div>
            )}

            <div className="mt-auto rounded-xl border border-slate-700 bg-slate-900 p-4">
              <h3 className="mb-3 text-xs font-semibold text-slate-300">生成オプション</h3>
              <label className="mb-3 flex cursor-pointer items-start gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={autoRetry} onChange={(event) => setAutoRetry(event.target.checked)} className="mt-0.5 accent-violet-500" />
                <span>一時的な通信・APIエラー時に軽量画像で1回再試行</span>
              </label>
              <label className="mb-2 flex cursor-pointer items-start gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={addLightEffects} onChange={(event) => setAddLightEffects(event.target.checked)} className="mt-0.5 accent-violet-500" />
                <span>抽象的な光エフェクトを追加</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={clarifyClothing} onChange={(event) => setClarifyClothing(event.target.checked)} className="mt-0.5 accent-violet-500" />
                <span>成人向けの露出を抑えたノースリーブ衣装へ変更</span>
              </label>
            </div>
          </div>

          <div className="border-t border-slate-700 bg-slate-900 p-4">
            {busy ? (
              <button type="button" onClick={() => abortRef.current?.abort()} className="w-full rounded-xl bg-rose-700 px-4 py-3 font-bold text-white hover:bg-rose-600">処理を中止</button>
            ) : (
              <button type="button" onClick={runGeneration} disabled={!sourceUrl || !apiKey} className="w-full rounded-xl bg-violet-600 px-4 py-3 font-bold text-white shadow-lg shadow-violet-900/40 transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40">⚡ 画像を生成・変換</button>
            )}
          </div>
        </section>

        <aside className="grid min-h-[38rem] grid-rows-2 bg-slate-950 lg:min-h-0">
          <section className="flex min-h-0 flex-col border-b border-slate-700">
            <div className="flex items-center justify-between border-b border-slate-700 bg-slate-900 p-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">▰ Presets</h2>
              <button type="button" onClick={addPreset} className="btn px-2 py-1 text-xs">保存</button>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
              {presets.length ? presets.map((preset) => (
                <div key={preset.id} className="group rounded-lg border border-slate-700 bg-slate-900 p-3 hover:border-violet-500">
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => applyPreset(preset)} className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-200">{preset.name}</button>
                    <button type="button" aria-label={`${preset.name}を削除`} onClick={() => removePreset(preset.id)} className="text-xs text-slate-600 hover:text-rose-400">削除</button>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">{preset.face}</p>
                </div>
              )) : <p className="text-xs text-slate-500">保存したプリセットはありません。</p>}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <div className="border-b border-slate-700 bg-slate-900 p-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">⌁ History & Logs</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
              {logs.map((log, index) => (
                <div key={`${log.at}-${index}`} className={`border-b border-slate-800/70 py-1.5 ${log.type === 'error' ? 'text-rose-400' : log.type === 'success' ? 'text-emerald-400' : log.type === 'warn' ? 'text-amber-400' : log.type === 'system' ? 'text-violet-400' : 'text-slate-400'}`}>
                  <span className="mr-2 text-slate-600">[{log.at}]</span>{log.message}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
