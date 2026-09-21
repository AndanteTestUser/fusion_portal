import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';
import {
  composeSelected, copyCanvas, editWithProvider, estimateBanzaiTargets, makePoseGuide,
  makeCanvas, maskHasPaint, restoreOccluder, selectedChangeRatio,
} from '../lib/banzaiPipeline.js';

const LANDMARKS = ['head', 'torso', 'leftShoulder', 'rightShoulder'];
const LABELS = { head: '頭の中心', torso: '胴体の中心', leftShoulder: '左肩', rightShoulder: '右肩', leftHand: '左手の目標', rightHand: '右手の目標' };
const MAX_SIDE = 2048;

function download(canvas, name) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = name;
  a.click();
}

async function decodeImageToCanvas(image) {
  const ratio = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = makeCanvas(Math.round(image.naturalWidth * ratio), Math.round(image.naturalHeight * ratio));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function readImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('画像を読み込めませんでした'));
      image.src = url;
    });
    return await decodeImageToCanvas(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// WK画像(既にdataURL化された画像)から読み込む。readImage と異なり
// Fileではないため object URL の生成・破棄は不要。
async function readImageFromDataUrl(dataUrl) {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('WK画像を読み込めませんでした'));
    image.src = dataUrl;
  });
  return decodeImageToCanvas(image);
}

export default function BanzaiPosePage() {
  const { entries } = useApiKeys();
  const [provider, setProvider] = useState('openai');
  const [stage, setStage] = useState('occluder');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('原画像を読み込んでください。');
  const [brush, setBrush] = useState(34);
  const [mode, setMode] = useState('paint');
  const [pointMode, setPointMode] = useState(null);
  const [landmarks, setLandmarks] = useState({});
  const [handOverrides, setHandOverrides] = useState({});
  const [version, setVersion] = useState(0);
  const originalRef = useRef(null);
  const workingRef = useRef(null);
  const pendingRef = useRef(null);
  const occluderRef = useRef(null);
  const armsRef = useRef(null);
  const canvasRef = useRef(null);
  const pointerRef = useRef(null);
  const abortRef = useRef(null);

  const estimated = estimateBanzaiTargets(landmarks);
  const targets = estimated ? { ...estimated, ...handOverrides } : null;
  const activeMask = stage === 'occluder' ? occluderRef.current : armsRef.current;
  const activeImage = preview ? pendingRef.current : workingRef.current;

  useEffect(() => {
    const visible = canvasRef.current;
    const image = activeImage;
    if (!visible || !image) return;
    visible.width = image.width;
    visible.height = image.height;
    const ctx = visible.getContext('2d');
    ctx.drawImage(image, 0, 0);
    if (stage !== 'done' && !preview && activeMask) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.drawImage(activeMask, 0, 0);
      ctx.restore();
    }
    if (stage === 'arms' && targets && !preview) {
      ctx.save();
      ctx.strokeStyle = '#22c55e';
      ctx.fillStyle = '#22c55e';
      ctx.lineWidth = Math.max(3, image.width / 400);
      for (const [side, hand] of [['left', targets.leftHand], ['right', targets.rightHand]]) {
        const shoulder = landmarks[`${side}Shoulder`];
        ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(hand.x, hand.y, Math.max(5, image.width / 200), 0, 2 * Math.PI); ctx.fill();
      }
      ctx.restore();
    }
    if (stage !== 'done' && !preview) {
      ctx.font = `bold ${Math.max(14, image.width / 50)}px sans-serif`;
      for (const [name, point] of Object.entries(landmarks)) {
        ctx.fillStyle = '#facc15';
        ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(5, image.width / 220), 0, 2 * Math.PI); ctx.fill();
        ctx.fillText(LABELS[name], point.x + 9, point.y - 9);
      }
    }
  }, [version, stage, preview, activeImage, activeMask, landmarks, targets?.leftHand.x, targets?.leftHand.y, targets?.rightHand.x, targets?.rightHand.y]);

  const load = useCallback(async (file) => {
    if (!file) return;
    try {
      abortRef.current?.abort();
      const image = await readImage(file);
      originalRef.current = image;
      workingRef.current = copyCanvas(image);
      occluderRef.current = makeCanvas(image.width, image.height);
      armsRef.current = makeCanvas(image.width, image.height);
      pendingRef.current = null;
      setLandmarks({}); setHandOverrides({}); setStage('occluder'); setPreview(false);
      setMessage('前面人物など、腕に重なる部分を塗ってください。遮蔽物がなければスキップできます。');
      setVersion((v) => v + 1);
    } catch (error) { setMessage(error.message); }
  }, []);

  // WK画像(ウェルカム画面でチェックした画像)を、通常のファイル読込と同じ扱いで取り込む。
  const loadFromWkDataUrl = useCallback(async (dataUrl) => {
    try {
      abortRef.current?.abort();
      const image = await readImageFromDataUrl(dataUrl);
      originalRef.current = image;
      workingRef.current = copyCanvas(image);
      occluderRef.current = makeCanvas(image.width, image.height);
      armsRef.current = makeCanvas(image.width, image.height);
      pendingRef.current = null;
      setLandmarks({}); setHandOverrides({}); setStage('occluder'); setPreview(false);
      setMessage('WK画像を読み込みました。前面人物など、腕に重なる部分を塗ってください。');
      setVersion((v) => v + 1);
    } catch (error) { setMessage(error.message); }
  }, []);

  useWkAutoLoad('/banzai-pose', () => Boolean(originalRef.current), loadFromWkDataUrl);

  const position = (event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvasRef.current.width / rect.width,
      y: (event.clientY - rect.top) * canvasRef.current.height / rect.height,
    };
  };

  const stroke = (from, to) => {
    const mask = stage === 'occluder' ? occluderRef.current : armsRef.current;
    const ctx = mask.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'rgba(255, 60, 80, 1)';
    ctx.fillStyle = 'rgba(255, 60, 80, 1)';
    ctx.lineWidth = brush * mask.width / 800;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    setVersion((v) => v + 1);
  };

  const pointerDown = (event) => {
    if (busy || preview || !workingRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = position(event);
    if (pointMode) {
      if (pointMode.endsWith('Hand')) setHandOverrides((current) => ({ ...current, [pointMode]: at }));
      else setLandmarks((current) => ({ ...current, [pointMode]: at }));
      setPointMode(null);
    } else { pointerRef.current = at; stroke(at, at); }
  };
  const pointerMove = (event) => {
    if (!pointerRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const at = position(event);
    stroke(pointerRef.current, at);
    pointerRef.current = at;
  };

  const addTargetCorridors = () => {
    if (!targets) return setMessage('頭・胴体・両肩の4点を指定してください。');
    const mask = armsRef.current;
    const ctx = mask.getContext('2d');
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 60, 80, 1)';
    ctx.lineWidth = Math.max(18, Math.hypot(landmarks.leftShoulder.x - landmarks.rightShoulder.x, landmarks.leftShoulder.y - landmarks.rightShoulder.y) * 0.38);
    ctx.lineCap = 'round';
    for (const [side, hand] of [['left', targets.leftHand], ['right', targets.rightHand]]) {
      const shoulder = landmarks[`${side}Shoulder`];
      ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
    }
    ctx.restore();
    setMessage('緑線の周囲を追加しました。元の腕が残りそうな箇所も塗り足してください。');
    setVersion((v) => v + 1);
  };

  const moveToArms = () => {
    setStage('arms'); setPreview(false); setPointMode(null);
    setMessage('頭・胴体・両肩を指定し、既存の両腕と目標の腕が通る範囲を塗ってください。');
    setVersion((v) => v + 1);
  };

  const run = async () => {
    const selected = stage === 'occluder' ? occluderRef.current : armsRef.current;
    if (!maskHasPaint(selected)) return setMessage('編集する範囲を塗ってください。');
    if (stage === 'arms' && !targets) return setMessage('頭・胴体・両肩の4点を指定してください。');
    if (stage === 'arms' && Object.values(targets).some(({ x, y }) => x < 0 || y < 0 || x >= workingRef.current.width || y >= workingRef.current.height)) {
      return setMessage('手先の目標が画像の外にあります。左右の手先を画像内へ修正してください。');
    }
    const key = entries[provider]?.apiKey;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setMessage(`${provider === 'openai' ? 'OpenAI' : 'Gemini'}で編集中...`);
    try {
      const prompt = stage === 'occluder'
        ? 'Remove only the foreground occluding person or object inside the transparent mask. Complete the hidden surface and the background in the same camera angle, style and lighting. This is a temporary edit base; preserve the lying subject, their pose, all unmasked pixels, furniture and canvas framing.'
        : `Edit only the lying subject's two arms into a fully extended, anatomically natural overhead banzai pose in the direction of their head. The second input image is a pose guide with green lines from each shoulder to its target hand position. Use those lines for the arm paths, but do not render the green lines. The head is at (${Math.round(landmarks.head.x)},${Math.round(landmarks.head.y)}), torso at (${Math.round(landmarks.torso.x)},${Math.round(landmarks.torso.y)}). Match shoulder joints and perspective, not equal lengths in image pixels. Remove traces of the old arm pose inside the mask. Preserve the subject's face, torso, clothing, other people, scene, camera, framing and proportions.`;
      const guide = stage === 'arms' ? makePoseGuide(workingRef.current, landmarks, targets) : null;
      const generated = await editWithProvider({ provider, key, image: workingRef.current, selection: selected, guide, prompt, signal: controller.signal });
      pendingRef.current = composeSelected(workingRef.current, generated, selected);
      if (selectedChangeRatio(workingRef.current, pendingRef.current, selected) < 0.005) {
        pendingRef.current = null;
        throw new Error('指定範囲の変化が確認できません。範囲を見直して再実行してください');
      }
      setPreview(true);
      setMessage('プレビューを確認してください。問題があれば編集範囲を直して同じ工程を再実行できます。');
      setVersion((v) => v + 1);
    } catch (error) {
      setMessage(error.name === 'AbortError' ? '処理を中止しました。' : `編集に失敗しました: ${error.message}`);
    } finally { setBusy(false); abortRef.current = null; }
  };

  const accept = () => {
    if (!pendingRef.current) return;
    if (stage === 'occluder') {
      workingRef.current = pendingRef.current; pendingRef.current = null; moveToArms();
    } else {
      workingRef.current = restoreOccluder(pendingRef.current, originalRef.current, occluderRef.current);
      pendingRef.current = null; setPreview(false); setStage('done');
      setMessage('前面の遮蔽物を元座標に復元しました。仕上がりを確認して保存してください。');
      setVersion((v) => v + 1);
    }
  };

  const revise = () => { pendingRef.current = null; setPreview(false); setVersion((v) => v + 1); };

  return (
    <div className="h-full overflow-y-auto overscroll-contain text-slate-100">
      <div className="mx-auto max-w-5xl space-y-5 p-4 pb-12">
      <div>
        <h1 className="text-2xl font-bold">BANZAI Pose Pipeline</h1>
        <p className="mt-1 text-sm text-slate-300">原本保存 → 遮蔽物の一時除去 → 両腕の再構築 → 原本から遮蔽物を復元</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-800 p-4">
        <label className="cursor-pointer rounded bg-blue-600 px-4 py-2 font-medium">画像を選択
          <input className="hidden" type="file" accept="image/*" onChange={(e) => { load(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <label>画像AI <select className="ml-2 rounded bg-slate-700 p-2" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value)}>
          <option value="openai">OpenAI（既定）</option><option value="gemini">Gemini</option>
        </select></label>
        <span className="text-sm text-slate-300">キー: {entries[provider]?.apiKey ? '設定済み' : '設定画面で入力してください'}</span>
      </div>
      {originalRef.current && <>
        <div className="flex flex-wrap gap-2 text-sm">
          <span className={`rounded px-3 py-1 ${stage === 'occluder' ? 'bg-blue-600' : 'bg-slate-700'}`}>1 遮蔽物</span>
          <span className={`rounded px-3 py-1 ${stage === 'arms' ? 'bg-blue-600' : 'bg-slate-700'}`}>2 両腕</span>
          <span className={`rounded px-3 py-1 ${stage === 'done' ? 'bg-green-700' : 'bg-slate-700'}`}>3 復元・検品</span>
        </div>
        <p role="status" className="rounded bg-slate-800 p-3 text-sm">{message}</p>
        <canvas ref={canvasRef} onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={() => { pointerRef.current = null; }} onPointerCancel={() => { pointerRef.current = null; }}
          className="mx-auto block h-auto max-h-[70vh] max-w-full rounded border border-slate-500"
          style={{ touchAction: 'none' }} aria-label="画像編集キャンバス" />
        {stage !== 'done' && !preview && <div className="space-y-3 rounded-xl bg-slate-800 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button className={`rounded px-3 py-2 ${mode === 'paint' ? 'bg-rose-600' : 'bg-slate-600'}`} onClick={() => { setMode('paint'); setPointMode(null); }}>範囲を塗る</button>
            <button className={`rounded px-3 py-2 ${mode === 'erase' ? 'bg-rose-600' : 'bg-slate-600'}`} onClick={() => { setMode('erase'); setPointMode(null); }}>塗り消す</button>
            <label>ブラシ幅 <input type="range" min="8" max="100" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
            <button className="rounded bg-slate-600 px-3 py-2" onClick={() => { activeMask.getContext('2d').clearRect(0, 0, activeMask.width, activeMask.height); setVersion((v) => v + 1); }}>範囲をクリア</button>
          </div>
          {stage === 'arms' && <>
            <div className="flex flex-wrap gap-2">{LANDMARKS.map((name) => <button key={name}
              className={`rounded px-3 py-2 ${pointMode === name ? 'bg-amber-600' : 'bg-slate-600'}`}
              onClick={() => setPointMode(name)}>{LABELS[name]}{landmarks[name] ? ' ✓' : ''}</button>)}</div>
            {targets && <div className="flex flex-wrap gap-2">{['leftHand', 'rightHand'].map((name) => <button key={name}
              className={`rounded px-3 py-2 ${pointMode === name ? 'bg-amber-600' : 'bg-slate-600'}`}
              onClick={() => setPointMode(name)}>{LABELS[name]}を修正{handOverrides[name] ? ' ✓' : ''}</button>)}
              {Object.keys(handOverrides).length > 0 && <button className="rounded bg-slate-600 px-3 py-2" onClick={() => setHandOverrides({})}>手先を自動位置に戻す</button>}</div>}
            <p className="text-sm text-slate-300">各ボタンを押し、画像上の位置をタップ。緑線は姿勢の目安です。元の腕も含めて編集領域を塗ってください。</p>
            <button className="rounded bg-emerald-700 px-3 py-2" onClick={addTargetCorridors}>目標の腕の範囲を追加</button>
          </>}
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} className="rounded bg-blue-600 px-4 py-2 disabled:opacity-50" onClick={run}>{stage === 'occluder' ? '遮蔽物を一時除去' : '両腕を生成'}</button>
            {busy && <button className="rounded bg-slate-600 px-4 py-2" onClick={() => abortRef.current?.abort()}>中止</button>}
            {stage === 'occluder' && <button className="rounded bg-slate-600 px-4 py-2" onClick={moveToArms}>遮蔽物なしで次へ</button>}
          </div>
        </div>}
        {preview && <div className="flex flex-wrap gap-2 rounded-xl bg-slate-800 p-4">
          <button className="rounded bg-green-700 px-4 py-2" onClick={accept}>{stage === 'occluder' ? '確認して両腕の工程へ' : '確認して遮蔽物を復元'}</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={revise}>範囲を修正して再実行</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={() => download(pendingRef.current, `banzai_${stage}_preview.png`)}>途中画像を保存</button>
        </div>}
        {stage === 'done' && <div className="flex flex-wrap gap-2 rounded-xl bg-slate-800 p-4">
          <button className="rounded bg-green-700 px-4 py-2" onClick={() => download(workingRef.current, 'banzai_result.png')}>完成画像を保存</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={() => { workingRef.current = copyCanvas(originalRef.current); occluderRef.current.getContext('2d').clearRect(0, 0, originalRef.current.width, originalRef.current.height); armsRef.current.getContext('2d').clearRect(0, 0, originalRef.current.width, originalRef.current.height); setLandmarks({}); setHandOverrides({}); setStage('occluder'); setPreview(false); setVersion((v) => v + 1); }}>原本からやり直す</button>
        </div>}
        <p className="text-xs text-slate-400">画像は長辺最大2048pxで処理します。APIキーは既存の設定画面から取得し、画像は選択中の画像AIへ送信します。</p>
      </>}
      </div>
    </div>
  );
}
