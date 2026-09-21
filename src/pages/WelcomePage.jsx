import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { tools } from '../tools.js';
import { providers } from '../providers.js';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkImages } from '../context/WkImageContext.jsx';
import { readFileAsDataUrl, resizeImageDataUrl } from '../lib/wkImageStore.js';

function WkImageRow({ image }) {
  const { setChecked, setTargetPath, setPersisted, removeImage } = useWkImages();

  return (
    <li className="flex gap-3 rounded-lg bg-neutral-700 p-3">
      <img
        src={image.dataUrl}
        alt={image.filename || 'WK画像'}
        className="h-16 w-16 flex-none rounded object-cover"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <select
          className="w-full rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-white"
          value={image.targetPath || ''}
          onChange={(e) => setTargetPath(image.id, e.target.value || null)}
        >
          <option value="">機能ページを選択...</option>
          {tools.map((tool) => (
            <option key={tool.path} value={tool.path}>
              {tool.icon} {tool.title}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-300">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={image.checked}
              disabled={!image.targetPath}
              onChange={(e) => setChecked(image.id, e.target.checked)}
            />
            自動選択する
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={image.persisted}
              onChange={(e) => setPersisted(image.id, e.target.checked)}
            />
            この端末に残す
          </label>
          <button type="button" className="ml-auto text-red-400 hover:text-red-300" onClick={() => removeImage(image.id)}>
            🗑️ 削除
          </button>
        </div>
        {!image.targetPath && <p className="text-[11px] text-amber-400">機能ページを選ぶとチェックできます</p>}
      </div>
    </li>
  );
}

function WkImageSection() {
  const { images, addImage, gasConfig, gasStatus, fetchFromGas } = useWkImages();
  const fileInputRef = useRef(null);

  const handleUpload = async (file) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const resized = await resizeImageDataUrl(dataUrl);
      addImage({ dataUrl: resized, filename: file.name, source: 'upload' });
    } catch (e) {
      // 読み込み失敗時はサイレントに諦める(致命的ではないため)
    }
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg bg-neutral-800 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-neutral-300">WK画像</h2>
        {gasConfig.url && gasConfig.secret && (
          <button type="button" className="btn px-2 py-1 text-xs" onClick={fetchFromGas} disabled={gasStatus.busy}>
            {gasStatus.busy ? '取り込み中...' : '🔄 GASから取り込む'}
          </button>
        )}
      </div>
      <p className="text-xs text-neutral-400">
        チェックした画像は、紐づけた機能ページを開いたときに自動で読み込まれます。
      </p>
      {gasStatus.message && <p className="text-xs text-amber-400">{gasStatus.message}</p>}

      {images.length > 0 && (
        <ul className="flex flex-col gap-2">
          {images.map((image) => (
            <WkImageRow key={image.id} image={image} />
          ))}
        </ul>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleUpload(e.target.files[0]);
          e.target.value = '';
        }}
      />
      <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
        📁 WK画像を手動で追加
      </button>
      {!gasConfig.url && (
        <p className="text-[11px] text-neutral-500">
          iOSの共有シートから自動で取り込みたい場合は、設定画面でGAS連携を設定してください。
        </p>
      )}
    </div>
  );
}

export default function WelcomePage() {
  const { entries } = useApiKeys();

  return (
    <div className="flex h-full flex-col items-center gap-8 overflow-y-auto bg-neutral-900 p-6 text-white">
      <div className="flex flex-col items-center gap-2 pt-4">
        <h1 className="text-2xl font-bold">Fusion Portal</h1>
        <p className="max-w-sm text-center text-sm text-neutral-400">利用するツールを選択してください。</p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-3">
        {tools.map((tool) => (
          <Link
            key={tool.path}
            to={tool.path}
            className="flex items-center gap-3 rounded-lg bg-neutral-800 px-4 py-3 transition-colors hover:bg-neutral-700"
          >
            <span className="text-2xl leading-none">{tool.icon}</span>
            <span className="flex flex-col">
              <span className="font-bold">{tool.title}</span>
              <span className="text-xs text-neutral-400">{tool.description}</span>
            </span>
          </Link>
        ))}
      </div>

      <WkImageSection />

      <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg bg-neutral-800 p-4">
        <h2 className="text-sm font-bold text-neutral-300">APIキーの状態</h2>
        <ul className="flex flex-col gap-1.5">
          {providers.map((provider) => {
            const isSet = Boolean(entries[provider.id]?.apiKey);
            return (
              <li key={provider.id} className="flex items-center justify-between text-sm">
                <span>{provider.label}</span>
                <span className={isSet ? 'font-bold text-emerald-400' : 'text-neutral-500'}>
                  {isSet ? '✅ 設定済み' : '未設定'}
                </span>
              </li>
            );
          })}
        </ul>
        <Link
          to="/settings"
          className="mt-2 rounded-md border border-neutral-600 px-3 py-2 text-center text-sm font-bold text-neutral-200 transition-colors hover:bg-neutral-700"
        >
          ⚙️ 設定を開く
        </Link>
      </div>
    </div>
  );
}
