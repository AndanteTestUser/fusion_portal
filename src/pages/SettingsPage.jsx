import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiKeys } from '../context/ApiKeyContext.jsx';
import { useWkImages } from '../context/WkImageContext.jsx';
import { providers } from '../providers.js';
import {
  hasVault,
  listStoredWraps,
  createVaultWithPassphrase,
  createVaultWithPasskey,
  unlockStoredVaultWithPassphrase,
  unlockStoredVaultWithPasskey,
  addPasskeyToStoredVault,
  addPassphraseToStoredVault,
  removeWrapFromStoredVault,
  autosavePayloadToStoredVault,
  deleteVault,
  isPasskeySupported,
  VaultError,
  MIN_PASSPHRASE_LENGTH,
} from '../lib/vault.js';

const AUTOSAVE_DEBOUNCE_MS = 600;

function buildPayload(entries) {
  const keys = {};
  const urls = {};
  providers.forEach((p) => {
    keys[p.id] = entries[p.id]?.apiKey || '';
    urls[p.id] = entries[p.id]?.keyPageUrl || '';
  });
  return { keys, urls };
}

function ProviderRow({ provider }) {
  const { entries, setApiKey, setKeyPageUrl, clearProvider, getKeyPageUrl, isCustomUrl } = useApiKeys();
  const [showKey, setShowKey] = useState(false);
  const [note, setNote] = useState('');

  const apiKey = entries[provider.id]?.apiKey || '';
  const keyPageUrlInput = entries[provider.id]?.keyPageUrl || '';

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setApiKey(provider.id, text.trim());
    } catch (e) {
      setNote('クリップボードから読み取れませんでした(権限が必要な場合があります)');
    }
  }, [provider.id, setApiKey]);

  const handleDelete = useCallback(() => {
    const { vaultKept } = clearProvider(provider.id);
    setNote(
      vaultKept
        ? 'このセッションから削除しました(この端末のVaultには残っている場合があります)'
        : 'このセッションから削除しました'
    );
  }, [clearProvider, provider.id]);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-neutral-800 p-4">
      <h3 className="text-sm font-bold text-neutral-200">{provider.label}</h3>

      <div className="flex gap-2">
        <input
          type={showKey ? 'text' : 'password'}
          className="min-w-0 flex-1 rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
          placeholder="APIキー"
          value={apiKey}
          onChange={(e) => setApiKey(provider.id, e.target.value)}
          autoComplete="off"
        />
        <button type="button" className="btn" onClick={() => setShowKey((v) => !v)}>
          {showKey ? '隠す' : '表示'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={handlePaste}>
          📋 貼り付け
        </button>
        <button type="button" className="btn" onClick={handleDelete}>
          🗑️ 削除
        </button>
        <a
          className="btn inline-flex items-center"
          href={getKeyPageUrl(provider.id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          🔗 キー取得ページを開く
        </a>
      </div>

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        <span>
          キー取得ページのURL(任意・独自のページを指定する場合){isCustomUrl(provider.id) && ' - カスタム設定中'}
        </span>
        <input
          type="url"
          className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
          placeholder={`未指定の場合: ${provider.defaultKeyPageUrl}`}
          value={keyPageUrlInput}
          onChange={(e) => setKeyPageUrl(provider.id, e.target.value)}
        />
      </label>

      {note && <p className="text-xs text-amber-400">{note}</p>}
    </div>
  );
}

function WkGasSection() {
  const { gasConfig, saveGasConfig, gasStatus, fetchFromGas } = useWkImages();
  const [url, setUrl] = useState(gasConfig.url);
  const [secret, setSecret] = useState(gasConfig.secret);

  const handleSave = useCallback(() => {
    saveGasConfig({ ...gasConfig, url: url.trim(), secret: secret.trim() });
  }, [url, secret, gasConfig, saveGasConfig]);

  // チェックボックスはURL・シークレットの未保存の下書きに関わらず、
  // 保存済みの設定に対してその場で反映する。
  const handleAutoPollChange = useCallback(
    (checked) => {
      saveGasConfig({ ...gasConfig, autoPoll: checked });
    },
    [gasConfig, saveGasConfig]
  );

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-neutral-800 p-4">
      <h2 className="text-sm font-bold text-neutral-300">WK画像 (GAS連携)</h2>
      <p className="text-xs text-neutral-400">
        iOSの共有シート→ショートカット経由で送られた画像を、Google Apps Script(GAS)の中継Webアプリ経由で
        自動的に取り込みます。デプロイ方法は <code>gas/README.md</code> を参照してください。
      </p>
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        <span>GAS Web AppのURL</span>
        <input
          type="url"
          className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
          placeholder="https://script.google.com/macros/s/.../exec"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        <span>共有シークレット</span>
        <input
          type="password"
          className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
          placeholder="ショートカット側と同じ値"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={gasConfig.autoPoll}
          onChange={(e) => handleAutoPollChange(e.target.checked)}
        />
        アプリを開いている間、自動的にバックグラウンドで取り込む(既定はオフ)
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={handleSave}>
          💾 保存
        </button>
        <button type="button" className="btn" onClick={() => fetchFromGas()} disabled={gasStatus.busy}>
          {gasStatus.busy ? '取り込み中...' : '🔄 今すぐ取り込む'}
        </button>
      </div>
      {gasStatus.message && <p className="text-xs text-amber-400">{gasStatus.message}</p>}
      <p className="text-[11px] text-neutral-500">
        このURL・シークレットはこの端末にのみ平文で保存されます(APIキーのVaultとは異なり暗号化はしていません)。
      </p>
    </section>
  );
}

export default function SettingsPage() {
  const { entries, setApiKey, setKeyPageUrl } = useApiKeys();
  const dataKeyRef = useRef(null);
  const [vaultState, setVaultState] = useState(() => (hasVault() ? 'locked' : 'none'));
  const [wraps, setWraps] = useState(() => listStoredWraps());
  const [vaultMessage, setVaultMessage] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);

  const [passphraseInput, setPassphraseInput] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [unlockPassphraseInput, setUnlockPassphraseInput] = useState('');

  const refreshWraps = useCallback(() => setWraps(listStoredWraps()), []);

  // Vaultを解錠したら、その中身をセッションへ反映する。ただし既にUIへ入力済みの
  // 値(このセッション中に既に入力されている値)を優先し、空欄のフィールドにだけ
  // Vaultの値を補う。
  const mergeVaultPayload = useCallback(
    (payload) => {
      providers.forEach((p) => {
        const currentKey = entries[p.id]?.apiKey || '';
        const currentUrl = entries[p.id]?.keyPageUrl || '';
        if (!currentKey && payload.keys?.[p.id]) setApiKey(p.id, payload.keys[p.id]);
        if (!currentUrl && payload.urls?.[p.id]) setKeyPageUrl(p.id, payload.urls[p.id]);
      });
    },
    [entries, setApiKey, setKeyPageUrl]
  );

  const handleCreatePassphraseVault = useCallback(async () => {
    setVaultMessage('');
    if (passphraseInput.length < MIN_PASSPHRASE_LENGTH) {
      setVaultMessage(`パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上で入力してください`);
      return;
    }
    if (passphraseInput !== passphraseConfirm) {
      setVaultMessage('確認用のパスフレーズが一致しません');
      return;
    }
    setVaultBusy(true);
    try {
      const dataKeyBytes = await createVaultWithPassphrase(passphraseInput, buildPayload(entries));
      dataKeyRef.current = dataKeyBytes;
      setVaultState('unlocked');
      setPassphraseInput('');
      setPassphraseConfirm('');
      refreshWraps();
      setVaultMessage('この端末にVaultを作成しました');
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : 'Vaultの作成に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [passphraseInput, passphraseConfirm, entries, refreshWraps]);

  const handleCreatePasskeyVault = useCallback(async () => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      const dataKeyBytes = await createVaultWithPasskey(buildPayload(entries));
      dataKeyRef.current = dataKeyBytes;
      setVaultState('unlocked');
      refreshWraps();
      setVaultMessage('この端末にVaultを作成しました');
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : 'Vaultの作成に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [entries, refreshWraps]);

  const handleUnlockWithPassphrase = useCallback(async () => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      const { dataKeyBytes, payload } = await unlockStoredVaultWithPassphrase(unlockPassphraseInput);
      dataKeyRef.current = dataKeyBytes;
      mergeVaultPayload(payload);
      setVaultState('unlocked');
      setUnlockPassphraseInput('');
      refreshWraps();
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : '解錠に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [unlockPassphraseInput, mergeVaultPayload, refreshWraps]);

  const handleUnlockWithPasskey = useCallback(async () => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      const { dataKeyBytes, payload } = await unlockStoredVaultWithPasskey();
      dataKeyRef.current = dataKeyBytes;
      mergeVaultPayload(payload);
      setVaultState('unlocked');
      refreshWraps();
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : '解錠に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [mergeVaultPayload, refreshWraps]);

  const handleLock = useCallback(() => {
    dataKeyRef.current = null;
    setVaultState('locked');
    setVaultMessage('');
  }, []);

  const handleDeleteVault = useCallback(() => {
    if (!window.confirm('この端末のVaultを完全に削除します。よろしいですか?')) return;
    deleteVault();
    dataKeyRef.current = null;
    setVaultState('none');
    setWraps([]);
    setVaultMessage('Vaultを削除しました');
  }, []);

  const handleAddPasskey = useCallback(async () => {
    setVaultMessage('');
    setVaultBusy(true);
    try {
      await addPasskeyToStoredVault(dataKeyRef.current);
      refreshWraps();
      setVaultMessage('パスキーを追加しました');
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : 'パスキーの追加に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [refreshWraps]);

  const handleAddPassphrase = useCallback(async () => {
    setVaultMessage('');
    if (passphraseInput.length < MIN_PASSPHRASE_LENGTH) {
      setVaultMessage(`パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上で入力してください`);
      return;
    }
    if (passphraseInput !== passphraseConfirm) {
      setVaultMessage('確認用のパスフレーズが一致しません');
      return;
    }
    setVaultBusy(true);
    try {
      await addPassphraseToStoredVault(dataKeyRef.current, passphraseInput);
      setPassphraseInput('');
      setPassphraseConfirm('');
      refreshWraps();
      setVaultMessage('パスフレーズを設定しました');
    } catch (e) {
      setVaultMessage(e instanceof VaultError ? e.message : 'パスフレーズの設定に失敗しました');
    } finally {
      setVaultBusy(false);
    }
  }, [passphraseInput, passphraseConfirm, refreshWraps]);

  const handleRemoveWrap = useCallback(
    (wrapId) => {
      setVaultMessage('');
      try {
        removeWrapFromStoredVault(wrapId);
        refreshWraps();
        setVaultMessage('解錠方法を削除しました');
      } catch (e) {
        setVaultMessage(e instanceof VaultError ? e.message : '削除に失敗しました');
      }
    },
    [refreshWraps]
  );

  // Vaultが解錠されている間、入力内容を600msのデバウンスで自動的にVaultへ保存する。
  useEffect(() => {
    if (vaultState !== 'unlocked' || !dataKeyRef.current) return undefined;
    const timer = setTimeout(() => {
      autosavePayloadToStoredVault(dataKeyRef.current, buildPayload(entries)).catch(() => {});
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entries, vaultState]);

  const hasPassphraseWrap = wraps.some((w) => w.type === 'passphrase');
  const passkeyWraps = wraps.filter((w) => w.type === 'passkey');

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto bg-neutral-900 p-4 text-white">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold text-neutral-300">APIキー</h2>
        {providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} />
        ))}
      </section>

      <WkGasSection />

      <section className="flex flex-col gap-3 rounded-lg bg-neutral-800 p-4">
        <h2 className="text-sm font-bold text-neutral-300">端末への保存(Vault)</h2>
        <p className="text-xs text-neutral-400">
          この端末に限り、APIキーを暗号化して保存できます(任意)。保存内容はこの端末の外へは送信されません。
        </p>

        {vaultBusy && <p className="text-xs text-neutral-400">処理中...</p>}
        {vaultMessage && <p className="text-xs text-amber-400">{vaultMessage}</p>}

        {vaultState === 'none' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <input
                type="password"
                className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
                placeholder={`パスフレーズ(${MIN_PASSPHRASE_LENGTH}文字以上)`}
                value={passphraseInput}
                onChange={(e) => setPassphraseInput(e.target.value)}
              />
              <input
                type="password"
                className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
                placeholder="パスフレーズ(確認)"
                value={passphraseConfirm}
                onChange={(e) => setPassphraseConfirm(e.target.value)}
              />
              <button type="button" className="btn" onClick={handleCreatePassphraseVault} disabled={vaultBusy}>
                🔑 パスフレーズでVaultを作成
              </button>
            </div>
            {isPasskeySupported() && (
              <button type="button" className="btn" onClick={handleCreatePasskeyVault} disabled={vaultBusy}>
                👆 パスキーでVaultを作成
              </button>
            )}
          </div>
        )}

        {vaultState === 'locked' && (
          <div className="flex flex-col gap-3">
            {hasPassphraseWrap && (
              <div className="flex gap-2">
                <input
                  type="password"
                  className="min-w-0 flex-1 rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
                  placeholder="パスフレーズ"
                  value={unlockPassphraseInput}
                  onChange={(e) => setUnlockPassphraseInput(e.target.value)}
                />
                <button type="button" className="btn" onClick={handleUnlockWithPassphrase} disabled={vaultBusy}>
                  解錠
                </button>
              </div>
            )}
            {passkeyWraps.length > 0 && (
              <button type="button" className="btn" onClick={handleUnlockWithPasskey} disabled={vaultBusy}>
                👆 パスキーで解錠
              </button>
            )}
            <button type="button" className="btn self-start text-red-400" onClick={handleDeleteVault}>
              🗑️ この端末のVaultを削除
            </button>
          </div>
        )}

        {vaultState === 'unlocked' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-emerald-400">🔓 解錠中(入力内容は自動的にこの端末へ保存されます)</p>

            <ul className="flex flex-col gap-1">
              {wraps.map((w) => (
                <li key={w.id} className="flex items-center justify-between text-xs text-neutral-300">
                  <span>{w.type === 'passphrase' ? 'パスフレーズ' : `パスキー (${w.id.slice(-8)})`}</span>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-[11px]"
                    onClick={() => handleRemoveWrap(w.id)}
                    disabled={wraps.length <= 1}
                    title={wraps.length <= 1 ? '最後に残った解錠方法は削除できません' : ''}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>

            <div className="flex flex-col gap-2">
              <input
                type="password"
                className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
                placeholder={`新しいパスフレーズ(${MIN_PASSPHRASE_LENGTH}文字以上)`}
                value={passphraseInput}
                onChange={(e) => setPassphraseInput(e.target.value)}
              />
              <input
                type="password"
                className="rounded border border-neutral-600 bg-neutral-900 px-3 py-2 text-sm text-white"
                placeholder="パスフレーズ(確認)"
                value={passphraseConfirm}
                onChange={(e) => setPassphraseConfirm(e.target.value)}
              />
              <button type="button" className="btn" onClick={handleAddPassphrase} disabled={vaultBusy}>
                🔑 パスフレーズを設定/変更
              </button>
            </div>

            {isPasskeySupported() && (
              <button type="button" className="btn" onClick={handleAddPasskey} disabled={vaultBusy}>
                👆 パスキーを追加
              </button>
            )}

            <div className="flex gap-2">
              <button type="button" className="btn" onClick={handleLock}>
                🔒 ロック
              </button>
              <button type="button" className="btn text-red-400" onClick={handleDeleteVault}>
                🗑️ Vaultを削除
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
