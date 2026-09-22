import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';
import {
  analyzePoseWithProvider, composeSelected, copyCanvas, createAutomaticPlan, editWithProvider,
  estimateBanzaiTargets, makePoseGuide, makeCanvas, maskHasPaint, restoreOccluder, selectedChangeRatio,
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
  const [advanced, setAdvanced] = useState(false);
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
  const armsOldRegionRef = useRef(null);
  const canvasRef = useRef(null);
  const pointerRef = useRef(null);
  const abortRef = useRef(null);
  const advancedReturnRef = useRef(null);
  const advancedDraftRef = useRef(null);
  const advancedRef = useRef(false);
  const autoPlanRef = useRef(null);
  const manualTouchedRef = useRef({ occluder: false, arms: false, points: false });

  const estimated = estimateBanzaiTargets(landmarks);
  const targets = estimated ? { ...estimated, ...handOverrides } : null;
  const activeMask = stage === 'occluder' ? occluderRef.current : armsRef.current;
  const activeImage = preview ? pendingRef.current : workingRef.current;

  useEffect(() => { advancedRef.current = advanced; }, [advanced]);

  useEffect(() => {
    const visible = canvasRef.current;
    const image = activeImage;
    if (!visible || !image) return;
    visible.width = image.width;
    visible.height = image.height;
    const ctx = visible.getContext('2d');
    ctx.drawImage(image, 0, 0);
    if (advanced && stage !== 'done' && !preview && activeMask) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.drawImage(activeMask, 0, 0);
      ctx.restore();
    }
    if (advanced && stage === 'arms' && targets && !preview) {
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
    if (advanced && stage !== 'done' && !preview) {
      ctx.font = `bold ${Math.max(14, image.width / 50)}px sans-serif`;
      for (const [name, point] of Object.entries(landmarks)) {
        ctx.fillStyle = '#facc15';
        ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(5, image.width / 220), 0, 2 * Math.PI); ctx.fill();
        ctx.fillText(LABELS[name], point.x + 9, point.y - 9);
      }
    }
  }, [version, stage, preview, advanced, activeImage, activeMask, landmarks, targets?.leftHand.x, targets?.leftHand.y, targets?.rightHand.x, targets?.rightHand.y]);

  async function runAutomatic(image) {
    const key = entries[provider]?.apiKey;
    if (!key) {
      setStage('error');
      setMessage(`${provider === 'openai' ? 'OpenAI' : 'Gemini'}のAPIキーを設定すると、画像選択後に自動処理を開始します。`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setAdvanced(false); setPreview(false); setBusy(true); setStage('analyzing');
    setMessage('対象人物・両腕・前面の遮蔽物を自動解析しています…');
    try {
      const analysis = await analyzePoseWithProvider({ provider, key, image, signal: controller.signal });
      const plan = createAutomaticPlan(image, analysis);
      autoPlanRef.current = plan;
      if (advancedRef.current) {
        if (!manualTouchedRef.current.points) {
          setLandmarks(plan.landmarks);
          setHandOverrides(plan.targets);
        }
        const merge = (current, automatic) => {
          const result = current || makeCanvas(image.width, image.height);
          result.getContext('2d').drawImage(automatic, 0, 0);
          return result;
        };
        // Don't clobber a mask the user has already started correcting by
        // hand while the analysis was still running.
        if (!manualTouchedRef.current.occluder) occluderRef.current = merge(occluderRef.current, plan.occluder);
        if (!manualTouchedRef.current.arms) {
          armsRef.current = merge(armsRef.current, plan.arms);
          armsOldRegionRef.current = merge(armsOldRegionRef.current, plan.armsOldRegion);
        }
        if (advancedReturnRef.current?.stage === 'analyzing') {
          advancedReturnRef.current = {
            image: copyCanvas(image),
            stage: 'error',
            message: '自動解析は完了し、詳細調整へ反映済みです。',
          };
        }
        setMessage('自動解析が完了し、人物・遮蔽物・腕の編集候補を反映しました。必要な箇所だけ補正してください。');
        setVersion((v) => v + 1);
        return;
      }
      setLandmarks(plan.landmarks); setHandOverrides(plan.targets);
      occluderRef.current = plan.occluder; armsRef.current = plan.arms; armsOldRegionRef.current = plan.armsOldRegion;
      let base = copyCanvas(image);

      if (maskHasPaint(plan.occluder)) {
        setStage('occluder'); setMessage('前面の遮蔽物を一時的に除去しています…');
        const cleared = await editWithProvider({
          provider, key, image: base, selection: plan.occluder, signal: controller.signal,
          prompt: 'Remove only the foreground person or object inside the transparent mask. Reconstruct the temporarily hidden subject and background in the same camera, perspective, style and lighting. Preserve all unmasked pixels, the lying subject, furniture, framing and aspect ratio.',
        });
        base = composeSelected(base, cleared, plan.occluder);
      }

      setStage('arms'); setMessage('両腕を頭上へまっすぐ伸ばす形に再構築しています…');
      const guide = makePoseGuide(base, plan.landmarks, plan.targets);
      const generated = await editWithProvider({
        provider, key, image: base, selection: plan.arms, guide, signal: controller.signal,
        prompt: `Edit only the main lying subject's two arms into a fully extended, anatomically natural overhead banzai pose toward their head. The second input is a green pose guide from each shoulder to its target hand; follow it but never render the guide. Keep both elbows straight, reconstruct correct shoulder and underarm anatomy, remove every trace of the old arm pose inside the mask including any disconnected hand or finger fragments, and preserve face, torso, clothes, other people, camera, composition, aspect ratio and all unmasked pixels. Respect gravity: wherever a continuous supporting surface (mat, floor, bed, cushion) is actually visible directly beneath an arm's path, let that forearm and hand rest against it with a matching contact shadow and perspective instead of floating; where no such surface is visible under the path (it leaves frame, crosses open air, or the subject is not fully flat there), do not invent contact and let the arm continue naturally instead.`,
      });
      let result = composeSelected(base, generated, plan.arms);
      if (selectedChangeRatio(base, result, plan.arms) < 0.005) throw new Error('両腕の変化を確認できませんでした');
      result = restoreOccluder(result, image, plan.occluder, plan.armsOldRegion);
      workingRef.current = result;
      pendingRef.current = null;
      setStage('done'); setMessage('自動処理が完了しました。前面の遮蔽物は原画像から同じ位置へ復元済みです。');
      setVersion((v) => v + 1);
    } catch (error) {
      setStage('error');
      setMessage(error.name === 'AbortError' ? '処理を中止しました。' : `自動処理に失敗しました: ${error.message}`);
    } finally {
      setBusy(false); abortRef.current = null;
    }
  }

  function initializeImage(image) {
    originalRef.current = image;
    workingRef.current = copyCanvas(image);
    occluderRef.current = makeCanvas(image.width, image.height);
    armsRef.current = makeCanvas(image.width, image.height);
    armsOldRegionRef.current = makeCanvas(image.width, image.height);
    pendingRef.current = null;
    autoPlanRef.current = null;
    advancedDraftRef.current = null;
    advancedReturnRef.current = null;
    manualTouchedRef.current = { occluder: false, arms: false, points: false };
    setLandmarks({}); setHandOverrides({}); setPreview(false); setAdvanced(false);
    setVersion((v) => v + 1);
    runAutomatic(image);
  }

  const load = useCallback(async (file) => {
    if (!file) return;
    try {
      abortRef.current?.abort();
      const image = await readImage(file);
      initializeImage(image);
    } catch (error) { setMessage(error.message); }
  }, [provider, entries]);

  // WK画像(ウェルカム画面でチェックした画像)を、通常のファイル読込と同じ扱いで取り込む。
  const loadFromWkDataUrl = useCallback(async (dataUrl) => {
    try {
      abortRef.current?.abort();
      const image = await readImageFromDataUrl(dataUrl);
      initializeImage(image);
    } catch (error) { setMessage(error.message); }
  }, [provider, entries]);

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
    manualTouchedRef.current[stage === 'occluder' ? 'occluder' : 'arms'] = true;
    setVersion((v) => v + 1);
  };

  const pointerDown = (event) => {
    if (!advanced || busy || preview || !workingRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = position(event);
    if (pointMode) {
      manualTouchedRef.current.points = true;
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
    const oldCtx = armsOldRegionRef.current.getContext('2d');
    const shoulderWidth = Math.hypot(landmarks.leftShoulder.x - landmarks.rightShoulder.x, landmarks.leftShoulder.y - landmarks.rightShoulder.y);
    const width = Math.max(18, shoulderWidth * 0.38);
    // Narrower than the edit mask's width on purpose: see banzaiPipeline.js's
    // armsOldRegion comment. This only needs to suppress the old arm's own
    // pixels leaking back through restoreOccluder, not fully cover the arm
    // for editing, and covers the full shoulder-to-wrist length (unlike the
    // edit mask) so no gap reopens near the joint.
    const oldRegionWidth = width * 0.4;
    ctx.save(); ctx.strokeStyle = 'rgba(255, 60, 80, 1)'; ctx.fillStyle = 'rgba(255, 60, 80, 1)'; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    oldCtx.save(); oldCtx.strokeStyle = 'rgba(255, 60, 80, 1)'; oldCtx.fillStyle = 'rgba(255, 60, 80, 1)'; oldCtx.lineWidth = oldRegionWidth; oldCtx.lineCap = 'round'; oldCtx.lineJoin = 'round';
    const joints = autoPlanRef.current?.joints;
    for (const [side, hand] of [['left', targets.leftHand], ['right', targets.rightHand]]) {
      const shoulder = landmarks[`${side}Shoulder`];
      // Also cover the original elbow/wrist path (and a buffer around the
      // original hand) so the automatic update doesn't leave the previous
      // arm's pixels outside the mask as residual ghost fragments. This part
      // alone is mirrored onto armsOldRegionRef: occluder restoration must
      // only ever be excluded near this original path, never near the new
      // target below, which can land anywhere the pose direction points on
      // screen with no relation to what is actually there.
      const elbow = joints?.[`${side}Elbow`];
      const wrist = joints?.[`${side}Wrist`];
      if (elbow && wrist) {
        ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(wrist.x, wrist.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(wrist.x, wrist.y, width * 1.1, 0, Math.PI * 2); ctx.fill();
        oldCtx.beginPath(); oldCtx.moveTo(shoulder.x, shoulder.y); oldCtx.lineTo(elbow.x, elbow.y); oldCtx.lineTo(wrist.x, wrist.y); oldCtx.stroke();
        oldCtx.beginPath(); oldCtx.arc(wrist.x, wrist.y, oldRegionWidth * 1.1, 0, Math.PI * 2); oldCtx.fill();
      }
      ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(hand.x, hand.y); ctx.stroke();
      // The corridor's round cap at the target is only as wide as the
      // forearm; give the new hand the same buffer as the original wrist
      // above, or it gets clipped off by the mask boundary during composite.
      ctx.beginPath(); ctx.arc(hand.x, hand.y, width * 1.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    oldCtx.restore();
    setMessage('肩から目標方向までの編集範囲を自動設定しました。通常はこのまま生成できます。');
    setVersion((v) => v + 1);
  };

  const extendTargetOutside = (side) => {
    const shoulder = landmarks[`${side}Shoulder`];
    const current = targets?.[`${side}Hand`];
    const image = workingRef.current;
    if (!shoulder || !current || !image) return;
    let dx = current.x - shoulder.x;
    let dy = current.y - shoulder.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.01) return setMessage(`${side === 'left' ? '左' : '右'}腕の伸ばす方向を判定できませんでした。目標点を肩から離してください。`);
    dx /= length; dy /= length;
    const candidates = [];
    if (dx > 0) candidates.push((image.width - shoulder.x) / dx);
    if (dx < 0) candidates.push((0 - shoulder.x) / dx);
    if (dy > 0) candidates.push((image.height - shoulder.y) / dy);
    if (dy < 0) candidates.push((0 - shoulder.y) / dy);
    const edgeDistance = Math.min(...candidates.filter((value) => value > 0));
    const target = {
      x: shoulder.x + dx * (edgeDistance + Math.max(image.width, image.height) * 0.18),
      y: shoulder.y + dy * (edgeDistance + Math.max(image.width, image.height) * 0.18),
    };
    setHandOverrides((currentOverrides) => ({ ...currentOverrides, [`${side}Hand`]: target }));
    manualTouchedRef.current.points = true;
    setMessage(`${side === 'left' ? '左' : '右'}腕を画像端の外まで伸ばす設定にしました。手先は無理に画面内へ描画しません。`);
  };

  const moveToArms = () => {
    setStage('arms'); setPreview(false); setPointMode(null);
    setMessage('自動検出した肩と腕の方向を確認してください。必要な場合だけ位置や編集範囲を補正できます。');
    setVersion((v) => v + 1);
  };

  const run = async () => {
    const selected = stage === 'occluder' ? occluderRef.current : armsRef.current;
    if (!maskHasPaint(selected)) return setMessage('編集する範囲を塗ってください。');
    if (stage === 'arms' && !targets) return setMessage('頭・胴体・両肩の4点を指定してください。');
    const key = entries[provider]?.apiKey;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setMessage(`${provider === 'openai' ? 'OpenAI' : 'Gemini'}で編集中...`);
    try {
      const prompt = stage === 'occluder'
        ? 'Remove only the foreground occluding person or object inside the transparent mask. Complete the hidden surface and the background in the same camera angle, style and lighting. This is a temporary edit base; preserve the lying subject, their pose, all unmasked pixels, furniture and canvas framing.'
        : `Edit only the lying subject's two arms into a fully extended, anatomically natural overhead banzai pose in the direction of their head. The second input image is a pose guide with green lines from each shoulder toward a virtual target. Use those lines for the arm paths, but do not render the green lines. A target may be outside the crop: in that case, continue the arm naturally through the image edge and keep the hand out of frame instead of bending or shortening the arm. The head is at (${Math.round(landmarks.head.x)},${Math.round(landmarks.head.y)}), torso at (${Math.round(landmarks.torso.x)},${Math.round(landmarks.torso.y)}). Match shoulder joints and perspective, not equal lengths in image pixels. Remove traces of the old arm pose inside the mask, including any disconnected hand or finger fragments left outside the new pose. Respect gravity: wherever a continuous supporting surface (mat, floor, bed, cushion) is actually visible directly beneath an arm's path, let that forearm and hand rest against it with a matching contact shadow and perspective instead of floating; where no such surface is visible under the path (it leaves frame, crosses open air, or the subject is not fully flat there), do not invent contact and let the arm continue naturally instead. Preserve the subject's face, torso, clothing, other people, scene, camera, framing and proportions.`;
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
      workingRef.current = restoreOccluder(pendingRef.current, originalRef.current, occluderRef.current, armsOldRegionRef.current);
      pendingRef.current = null; setPreview(false); setStage('done');
      setMessage('前面の遮蔽物を元座標に復元しました。仕上がりを確認して保存してください。');
      setVersion((v) => v + 1);
    }
  };

  const revise = () => { pendingRef.current = null; setPreview(false); setVersion((v) => v + 1); };

  const openAdvanced = () => {
    const image = originalRef.current;
    if (!image) return;
    advancedReturnRef.current = {
      image: copyCanvas(workingRef.current || image),
      stage,
      message,
    };
    const draft = advancedDraftRef.current;
    if (draft) {
      workingRef.current = copyCanvas(draft.image);
      occluderRef.current = copyCanvas(draft.occluder);
      armsRef.current = copyCanvas(draft.arms);
      armsOldRegionRef.current = copyCanvas(draft.armsOldRegion);
      pendingRef.current = draft.pending ? copyCanvas(draft.pending) : null;
      setLandmarks(draft.landmarks);
      setHandOverrides(draft.handOverrides);
      setStage(draft.stage);
      setPreview(Boolean(draft.pending));
      setMessage('前回の詳細調整を復元しました。続きから作業できます。');
    } else {
      const plan = autoPlanRef.current;
      workingRef.current = copyCanvas(image);
      occluderRef.current = plan ? copyCanvas(plan.occluder) : makeCanvas(image.width, image.height);
      armsRef.current = plan ? copyCanvas(plan.arms) : makeCanvas(image.width, image.height);
      armsOldRegionRef.current = plan ? copyCanvas(plan.armsOldRegion) : makeCanvas(image.width, image.height);
      pendingRef.current = null;
      setLandmarks(plan?.landmarks || {});
      setHandOverrides(plan?.targets || {});
      setStage('occluder');
      setPreview(false);
      setMessage(busy
        ? '自動解析と並行して調整できます。解析結果は完了後に候補範囲へ反映されます。'
        : '自動検出した遮蔽物の候補を確認してください。問題がなければそのまま処理できます。');
    }
    advancedRef.current = true;
    setAdvanced(true);
    setVersion((v) => v + 1);
  };

  const closeAdvanced = () => {
    advancedRef.current = false;
    if (stage === 'done') {
      advancedReturnRef.current = {
        image: copyCanvas(workingRef.current),
        stage: 'done',
        message: '詳細調整した結果を反映しました。完成画像を保存できます。',
      };
      advancedDraftRef.current = null;
    } else {
      advancedDraftRef.current = {
        image: copyCanvas(workingRef.current),
        occluder: copyCanvas(occluderRef.current),
        arms: copyCanvas(armsRef.current),
        armsOldRegion: copyCanvas(armsOldRegionRef.current),
        pending: pendingRef.current ? copyCanvas(pendingRef.current) : null,
        landmarks: { ...landmarks },
        handOverrides: { ...handOverrides },
        stage,
      };
    }
    const previous = advancedReturnRef.current;
    if (previous) {
      workingRef.current = previous.image;
      setStage(previous.stage);
      setMessage(stage === 'done' ? previous.message : `${previous.message} 詳細調整の途中内容も保持しています。`);
    } else {
      workingRef.current = copyCanvas(originalRef.current);
      setStage('error');
      setMessage('詳細調整を終了しました。自動処理を再実行できます。');
    }
    pendingRef.current = null;
    setPreview(false);
    setAdvanced(false);
    setPointMode(null);
    setVersion((v) => v + 1);
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain text-slate-100">
      <div className={`mx-auto max-w-5xl ${advanced ? 'space-y-3 p-3 pb-4' : 'space-y-5 p-4 pb-12'}`}>
      {!advanced && <>
        <div>
          <h1 className="text-2xl font-bold">BANZAI Pose Pipeline</h1>
          <p className="mt-1 text-sm text-slate-300">画像を選ぶだけで、人物解析・遮蔽物処理・両腕の再構築・復元まで自動実行します。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-800 p-4">
          <label className={`cursor-pointer rounded px-4 py-2 font-medium ${originalRef.current ? 'bg-slate-600' : 'bg-blue-600'}`}>{originalRef.current ? '別の画像に変更' : '画像を選択'}
            <input className="hidden" type="file" accept="image/*" onChange={(e) => { load(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <label>画像AI <select className="ml-2 rounded bg-slate-700 p-2" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value)}>
            <option value="openai">OpenAI（既定）</option><option value="gemini">Gemini</option>
          </select></label>
          <span className="text-sm text-slate-300">キー: {entries[provider]?.apiKey ? '設定済み' : '設定画面で入力してください'}</span>
        </div>
      </>}
      {originalRef.current && <>
        {!advanced && <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
          <span className={`rounded px-3 py-2 ${stage === 'analyzing' ? 'bg-blue-600' : 'bg-slate-700'}`}>1 自動解析</span>
          <span className={`rounded px-3 py-2 ${stage === 'occluder' ? 'bg-blue-600' : 'bg-slate-700'}`}>2 遮蔽物処理</span>
          <span className={`rounded px-3 py-2 ${stage === 'arms' ? 'bg-blue-600' : 'bg-slate-700'}`}>3 両腕を生成</span>
          <span className={`rounded px-3 py-2 ${stage === 'done' ? 'bg-green-700' : 'bg-slate-700'}`}>4 復元・完成</span>
        </div>}
        {advanced && <>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-800 p-3">
            <button className="shrink-0 rounded bg-slate-600 px-3 py-2 font-medium" onClick={closeAdvanced}>← 通常画面へ戻る</button>
            <div className="min-w-0 text-right">
              <h2 className="font-semibold">通常工程 2–3 / 4 ＞ 詳細調整</h2>
              <p className="truncate text-xs text-slate-300">途中内容を保持して往復できます</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
            <span className={`rounded px-2 py-2 ${stage === 'occluder' ? 'bg-blue-600' : 'bg-slate-700'}`}>遮蔽物の補正</span>
            <span className={`rounded px-2 py-2 ${stage === 'arms' ? 'bg-blue-600' : 'bg-slate-700'}`}>腕の方向</span>
            <span className={`rounded px-2 py-2 ${stage === 'done' ? 'bg-green-700' : 'bg-slate-700'}`}>確認・反映</span>
          </div>
        </>}
        <p role="status" className={`min-h-12 rounded p-3 text-sm ${advanced ? 'border border-blue-700 bg-blue-950' : 'bg-slate-800'}`}>{message}</p>
        <div className={`flex min-h-[38dvh] items-center justify-center rounded-xl bg-slate-950/40 p-2 ${advanced ? 'min-h-[48dvh]' : ''}`}>
          <canvas ref={canvasRef} onPointerDown={pointerDown} onPointerMove={pointerMove}
            onPointerUp={() => { pointerRef.current = null; }} onPointerCancel={() => { pointerRef.current = null; }}
            className="mx-auto block h-auto max-h-[58dvh] max-w-full rounded border border-slate-500"
            style={{ touchAction: 'none' }} aria-label="画像編集キャンバス" />
        </div>
        {advanced && stage !== 'done' && !preview && <div className="space-y-3 rounded-xl bg-slate-800 p-3">
          <div>
            <p className="font-semibold">{stage === 'occluder' ? '自動検出した遮蔽物を確認' : '自動検出した腕の方向を確認'}</p>
            <p className="mt-1 text-xs text-slate-300">{stage === 'occluder' ? '人物の髪・服・影を含めた候補範囲を表示しています。通常は塗り直す必要はありません。' : '肩から緑線の方向へ腕を伸ばします。線が画像外へ続く場合、手先も画面外になるのが正常です。'}</p>
          </div>
          {stage === 'arms' && <div className="space-y-2 border-t border-slate-600 pt-3">
            <p className="text-sm font-semibold">位置がずれている場合のみ修正</p>
            <div className="flex flex-wrap gap-2">{LANDMARKS.map((name, index) => <button key={name}
              className={`rounded px-3 py-2 ${pointMode === name ? 'bg-amber-600' : 'bg-slate-600'}`}
              onClick={() => setPointMode(name)}>{index + 1}. {LABELS[name]}{landmarks[name] ? ' ✓' : ''}</button>)}</div>
            {targets && <div className="flex flex-wrap gap-2">{['leftHand', 'rightHand'].map((name) => <button key={name}
              className={`rounded px-3 py-2 ${pointMode === name ? 'bg-amber-600' : 'bg-slate-600'}`}
              onClick={() => setPointMode(name)}>{LABELS[name]}を直す{handOverrides[name] ? ' ✓' : ''}</button>)}
              {Object.keys(handOverrides).length > 0 && <button className="rounded bg-slate-600 px-3 py-2" onClick={() => setHandOverrides({})}>手先を自動位置に戻す</button>}</div>}
            <div className="flex flex-wrap gap-2">
              <button className="rounded bg-emerald-700 px-3 py-2" onClick={addTargetCorridors}>腕の編集範囲を自動更新</button>
              <button className="rounded bg-slate-600 px-3 py-2" onClick={() => extendTargetOutside('left')}>左腕を画面外へ伸ばす</button>
              <button className="rounded bg-slate-600 px-3 py-2" onClick={() => extendTargetOutside('right')}>右腕を画面外へ伸ばす</button>
            </div>
          </div>}
          <details className="border-t border-slate-600 pt-3">
            <summary className="cursor-pointer text-sm font-semibold">自動範囲に問題がある場合だけ手動補正</summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button aria-pressed={mode === 'paint'} className={`rounded px-3 py-2 ${mode === 'paint' ? 'bg-rose-600' : 'bg-slate-600'}`} onClick={() => { setMode('paint'); setPointMode(null); }}>＋ 範囲を追加</button>
              <button aria-pressed={mode === 'erase'} className={`rounded px-3 py-2 ${mode === 'erase' ? 'bg-rose-600' : 'bg-slate-600'}`} onClick={() => { setMode('erase'); setPointMode(null); }}>－ 範囲を除外</button>
              <label className="flex items-center gap-2 text-sm">太さ <input aria-label="ブラシの太さ" type="range" min="8" max="100" value={brush} onChange={(e) => setBrush(Number(e.target.value))} /></label>
              <button className="rounded bg-slate-600 px-3 py-2" onClick={() => { activeMask.getContext('2d').clearRect(0, 0, activeMask.width, activeMask.height); setVersion((v) => v + 1); }}>補正範囲を消去</button>
            </div>
          </details>
          <div className="flex flex-wrap gap-2 border-t border-slate-600 pt-3">
            <button disabled={busy} className="rounded bg-blue-600 px-4 py-2 font-medium disabled:opacity-50" onClick={run}>{stage === 'occluder' ? '候補の遮蔽物を一時除去' : 'この方向で両腕を生成'}</button>
            {busy && <button className="rounded bg-slate-600 px-4 py-2" onClick={() => abortRef.current?.abort()}>処理を中止</button>}
            {stage === 'occluder' && <button className="rounded bg-slate-600 px-4 py-2" onClick={moveToArms}>遮蔽物はない → 腕の調整へ</button>}
          </div>
        </div>}
        {busy && !advanced && <div className="flex justify-center rounded-xl bg-slate-800 p-4">
          <button className="rounded bg-slate-600 px-4 py-2" onClick={() => abortRef.current?.abort()}>自動処理を中止</button>
          <button className="ml-2 rounded bg-blue-700 px-4 py-2" onClick={openAdvanced}>解析を待たずに詳細調整</button>
        </div>}
        {stage === 'error' && !advanced && <div className="flex flex-wrap gap-2 rounded-xl bg-slate-800 p-4">
          <button disabled={busy} className="rounded bg-blue-600 px-4 py-2 disabled:opacity-50" onClick={() => runAutomatic(originalRef.current)}>自動処理を再実行</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={openAdvanced}>詳細調整を開く</button>
        </div>}
        {advanced && preview && <div className="flex flex-wrap gap-2 rounded-xl bg-slate-800 p-4">
          <button className="rounded bg-green-700 px-4 py-2" onClick={accept}>{stage === 'occluder' ? '確認して両腕の工程へ' : '確認して遮蔽物を復元'}</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={revise}>範囲を修正して再実行</button>
          <button className="rounded bg-slate-600 px-4 py-2" onClick={() => download(pendingRef.current, `banzai_${stage}_preview.png`)}>途中画像を保存</button>
        </div>}
        {stage === 'done' && <div className="flex flex-wrap gap-2 rounded-xl bg-slate-800 p-4">
          <button className="rounded bg-green-700 px-4 py-2" onClick={() => download(workingRef.current, 'banzai_result.png')}>完成画像を保存</button>
          {!advanced && <button className="rounded bg-blue-700 px-4 py-2" onClick={() => runAutomatic(originalRef.current)}>同じ原画像でもう一度</button>}
          {!advanced && <button className="rounded bg-slate-600 px-4 py-2" onClick={openAdvanced}>詳細調整</button>}
          {advanced && <button className="rounded bg-slate-600 px-4 py-2" onClick={closeAdvanced}>調整を終了して通常画面へ</button>}
        </div>}
        {!advanced && <p className="text-xs text-slate-400">通常は画像選択以外の操作は不要です。画像は長辺最大2048pxで処理し、選択中の画像AIへ送信します。</p>}
      </>}
      </div>
    </div>
  );
}
