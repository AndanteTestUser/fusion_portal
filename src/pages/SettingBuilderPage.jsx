import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkImages } from '../context/WkImageContext.jsx';
import { useWkAutoLoad } from '../hooks/useWkAutoLoad.js';
import { clearSettingDraft, loadSettingDraft, saveSettingDraft } from '../lib/settingDraft.js';
import { getSettingImage, listSettings, saveSetting } from '../lib/settingStore.js';

const INTRO = { role: 'notice', text: 'ベース画像を読み込み、名称と設定を対話で検討できます。図解指示と公式設定を編集して登録してください。' };
const TEXT_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3.1-flash-image';

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl, maxSide = 1200) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return reject(new Error('画像を処理できませんでした。'));
      context.fillStyle = '#dddddd';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    image.src = dataUrl;
  });
}

function inlineImage(dataUrl) {
  const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('画像データの形式が正しくありません。');
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

async function geminiRequest(model, payload, apiKey) {
  if (!apiKey) throw new Error('設定画面で Gemini API キーを設定してください。');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Gemini API エラー (HTTP ${response.status})`);
  const candidate = result.candidates?.[0];
  if (!candidate) throw new Error(result.promptFeedback?.blockReason || 'Gemini から結果が返されませんでした。');
  return candidate;
}

function StockImage({ config, id }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    getSettingImage(config, id).then((image) => { if (!cancelled) setUrl(image); }).catch(() => {});
    return () => { cancelled = true; };
  }, [config.url, config.secret, id]);
  return url ? <img src={url} alt="登録済み図解" className="h-32 w-32 rounded-lg object-contain bg-slate-950" /> : null;
}

function WkReceiver({ hasImage, onLoad }) {
  useWkAutoLoad('/setting-builder', () => hasImage, onLoad);
  return null;
}

export default function SettingBuilderPage() {
  const { geminiApiKey } = useApiKeys();
  const { gasConfig } = useWkImages();
  const [tab, setTab] = useState('stock');
  const [baseImage, setBaseImage] = useState(null);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [title, setTitle] = useState('');
  const [settingText, setSettingText] = useState('');
  const [imagePrompt, setImagePrompt] = useState('');
  const [chatHistory, setChatHistory] = useState([INTRO]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState([]);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [requestId, setRequestId] = useState(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    loadSettingDraft().then((draft) => {
      if (draft) {
        setBaseImage(draft.baseImage || null);
        setGeneratedImage(draft.generatedImage || null);
        setTitle(draft.title || '');
        setSettingText(draft.settingText || '');
        setImagePrompt(draft.imagePrompt || '');
        setChatHistory(draft.chatHistory?.length ? draft.chatHistory : [INTRO]);
        setRequestId(draft.requestId || null);
      }
    }).catch(() => setStatus('下書きを読み込めませんでした。')).finally(() => setDraftLoaded(true));
  }, []);

  useEffect(() => {
    if (!draftLoaded) return undefined;
    const timer = setTimeout(() => {
      saveSettingDraft({ baseImage, generatedImage, title, settingText, imagePrompt, chatHistory, requestId })
        .catch(() => setStatus('下書きを端末に保存できませんでした。'));
    }, 400);
    return () => clearTimeout(timer);
  }, [draftLoaded, baseImage, generatedImage, title, settingText, imagePrompt, chatHistory, requestId]);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await listSettings(gasConfig));
      setStatus('');
    } catch (error) {
      setStatus(error.message);
    }
  }, [gasConfig.url, gasConfig.secret]);

  useEffect(() => { refreshSettings(); }, [refreshSettings]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatHistory, tab]);

  const loadImage = useCallback(async (dataUrl) => {
    try {
      const compressed = await compressImage(dataUrl);
      setBaseImage(compressed);
      setGeneratedImage(null);
      setRequestId(null);
      setChatHistory([INTRO, { role: 'notice', text: 'ベース画像を読み込みました。画像に基づく設定を提案できます。' }]);
      setStatus('');
    } catch (error) { setStatus(error.message); }
  }, []);

  const uploadImage = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return setStatus('画像ファイルを選択してください。');
    try { await loadImage(await readFile(file)); }
    catch (error) { setStatus(error.message); }
  };

  const sendMessage = async () => {
    if (busy || (!input.trim() && !baseImage)) return;
    const message = { role: 'user', text: input.trim() || 'この画像に基づく名称と設定を提案してください。' };
    const history = [...chatHistory, message];
    setChatHistory(history);
    setInput('');
    setBusy('chat');
    try {
      const contents = history.filter((entry) => entry.role === 'user' || entry.role === 'model').slice(-12).map((entry) => ({
        role: entry.role,
        parts: [{ text: entry.text }],
      }));
      if (baseImage) contents[contents.length - 1].parts.push(inlineImage(baseImage));
      const candidate = await geminiRequest(TEXT_MODEL, {
        contents,
        systemInstruction: { parts: [{ text: '画像に見える内容と推測を区別し、名称と技術設定を対話で検討してください。図解用の構図とポーズが固まったら、[PROMPT: 構図とポーズの指示] を一つ含めてください。画風指定は含めないでください。' }] },
      }, geminiApiKey);
      const answer = candidate.content?.parts?.filter((part) => part.text).map((part) => part.text).join('\n') || '';
      if (!answer) throw new Error('Gemini から文章が返されませんでした。');
      const match = answer.match(/\[PROMPT:\s*([\s\S]*?)\]/);
      if (match?.[1]) setImagePrompt(match[1].trim());
      setChatHistory((current) => [...current, { role: 'model', text: answer }]);
    } catch (error) {
      setChatHistory((current) => [...current, { role: 'notice', text: `対話エラー: ${error.message}` }]);
    } finally { setBusy(''); }
  };

  const generateDiagram = async () => {
    if (!imagePrompt.trim() || busy) return;
    setBusy('image');
    try {
      const parts = [{ text: `装飾のないグレーの3Dマネキン。顔のパーツなし。薄いトポロジーライン、無地の背景、マットなモノクローム調。参照画像がある場合は人物の人数、身体配置、接触と遮蔽を参照する。\n\n構図・ポーズ: ${imagePrompt.trim()}` }];
      if (baseImage) parts.push(inlineImage(baseImage));
      const candidate = await geminiRequest(IMAGE_MODEL, {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
      }, geminiApiKey);
      const image = candidate.content?.parts?.find((part) => part.inlineData)?.inlineData;
      if (!image?.data) throw new Error(`画像が返されませんでした (${candidate.finishReason || '結果なし'})`);
      setGeneratedImage(await compressImage(`data:${image.mimeType || 'image/png'};base64,${image.data}`));
      setRequestId(null);
      setTab('workspace');
      setStatus('図解を生成しました。');
    } catch (error) { setStatus(`図解生成エラー: ${error.message}`); }
    finally { setBusy(''); }
  };

  const register = async () => {
    if (!title.trim() || busy) return;
    setBusy('save');
    const id = requestId || crypto.randomUUID();
    setRequestId(id);
    try {
      await saveSetting(gasConfig, { requestId: id, title: title.trim(), text: settingText, imagePrompt, baseImage, generatedImage });
      setTitle(''); setSettingText(''); setBaseImage(null); setGeneratedImage(null); setImagePrompt('');
      setChatHistory([INTRO]); setRequestId(null);
      await clearSettingDraft();
      setTab('stock');
      await refreshSettings();
      setStatus('Google Workspace に登録しました。');
    } catch (error) { setStatus(`登録エラー: ${error.message}`); }
    finally { setBusy(''); }
  };

  const changeField = (setter) => (value) => { setter(value); setRequestId(null); };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-100 md:flex-row">
      {draftLoaded && <WkReceiver hasImage={Boolean(baseImage)} onLoad={loadImage} />}
      <nav className="flex shrink-0 border-b border-slate-700 bg-slate-900 md:hidden">
        {[['chat', 'AI対話'], ['workspace', 'ワークスペース'], ['stock', 'ストック']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`flex-1 p-3 text-sm ${tab === id ? 'text-violet-300 border-b-2 border-violet-500' : 'text-slate-400'}`}>{label}</button>
        ))}
      </nav>

      <aside className={`${tab === 'chat' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col border-r border-slate-700 bg-slate-900 md:flex md:w-[380px] md:flex-none`}>
        <h2 className="border-b border-slate-700 p-4 font-semibold text-violet-300">設定構築アシスタント</h2>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {chatHistory.map((entry, index) => <div key={index} className={`rounded-lg p-3 text-sm whitespace-pre-wrap ${entry.role === 'user' ? 'ml-6 bg-violet-700' : 'mr-6 bg-slate-800'}`}>{entry.text}</div>)}
          {busy === 'chat' && <div className="text-sm text-slate-400">応答を待っています…</div>}
          <div ref={chatEndRef} />
        </div>
        <div className="space-y-3 border-t border-slate-700 p-3">
          <label className="block text-xs text-slate-300">図解生成用プロンプト
            <textarea value={imagePrompt} onChange={(e) => changeField(setImagePrompt)(e.target.value)} className="mt-1 h-24 w-full rounded border border-slate-600 bg-slate-950 p-2 text-sm" placeholder="構図とポーズの指示" />
          </label>
          <button onClick={generateDiagram} disabled={!imagePrompt.trim() || Boolean(busy)} className="btn w-full bg-violet-700 disabled:opacity-50">{busy === 'image' ? '生成中…' : '図解生成'}</button>
          <div className="flex items-center gap-2">
            <label className="btn cursor-pointer bg-slate-700 text-xs">ベース画像を選択<input type="file" accept="image/*" className="hidden" onChange={uploadImage} /></label>
            {baseImage && <span className="text-xs text-emerald-400">読込済み</span>}
          </div>
          <div className="flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }} className="min-w-0 flex-1 rounded bg-slate-800 px-3 py-2 text-sm" placeholder="要望を入力" />
            <button onClick={sendMessage} disabled={Boolean(busy) || (!input.trim() && !baseImage)} className="btn bg-violet-700 disabled:opacity-50">送信</button>
          </div>
        </div>
      </aside>

      <main className={`${tab === 'chat' ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col md:flex`}>
        <nav className="hidden border-b border-slate-700 bg-slate-900 md:flex">
          {[['stock', '登録済み設定'], ['workspace', 'ワークスペース']].map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`px-5 py-3 text-sm ${tab === id ? 'border-b-2 border-violet-500 text-violet-300' : 'text-slate-400'}`}>{label}</button>)}
        </nav>
        {status && <div role="status" className="border-b border-slate-700 px-4 py-2 text-sm text-amber-300">{status}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {tab === 'stock' ? <div className="mx-auto max-w-4xl space-y-4">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">登録済み設定</h2><button className="btn bg-slate-700 text-xs" onClick={refreshSettings}>更新</button></div>
            {settings.map((setting) => <article key={setting.id} className="flex flex-col gap-4 rounded-lg border border-slate-700 bg-slate-900 p-4 sm:flex-row">
              {setting.generatedImageFileId && <StockImage config={gasConfig} id={setting.generatedImageFileId} />}
              <div className="min-w-0 flex-1"><h3 className="font-semibold">{setting.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{setting.text || '（説明テキストなし）'}</p><p className="mt-3 text-xs text-slate-500">登録: {new Date(setting.createdAt).toLocaleString('ja-JP')}</p></div>
            </article>)}
            {!settings.length && <p className="text-sm text-slate-400">登録済み設定はありません。</p>}
          </div> : <div className="mx-auto max-w-4xl space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {[['ベース画像', baseImage], ['生成図解モデル', generatedImage]].map(([label, url]) => <div key={label} className="rounded-lg border border-slate-700 bg-slate-900 p-3"><h3 className="mb-2 text-xs text-slate-400">{label}</h3><div className="flex min-h-48 items-center justify-center rounded bg-slate-950">{url ? <img src={url} alt={label} className="max-h-80 w-full object-contain" /> : <span className="text-xs text-slate-500">画像未設定</span>}</div></div>)}
            </div>
            <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
              <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">公式設定エディタ</h3><button onClick={register} disabled={!title.trim() || Boolean(busy)} className="btn bg-emerald-700 text-xs disabled:opacity-50">{busy === 'save' ? '登録中…' : 'Google Workspace に登録'}</button></div>
              <input value={title} onChange={(e) => changeField(setTitle)(e.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 p-2 text-sm" placeholder="技術名称 / タイトル" />
              <textarea value={settingText} onChange={(e) => changeField(setSettingText)(e.target.value)} className="h-72 w-full rounded border border-slate-600 bg-slate-950 p-3 text-sm" placeholder="設定詳細" />
            </div>
          </div>}
        </div>
      </main>
    </div>
  );
}
