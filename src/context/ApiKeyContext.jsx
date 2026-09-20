import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { providers } from '../providers.js';
import { hasVault } from '../lib/vault.js';

const STORAGE_KEY = 'fusion_portal_providers';

// { [providerId]: { apiKey, keyPageUrl } } の形で保持する。
// sessionStorage に保存するのは意図的な選択で、タブを閉じれば消える
// (端末に永続化したい場合はオプションの Vault を利用する。src/lib/vault.js 参照)。
function loadInitial() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // sessionStorage が使えない/壊れている場合は無視して初期値を使う
  }
  return {};
}

function persist(entries) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e) {
    // 保存に失敗してもアプリの動作自体は継続する(メモリ上の state のみで動く)
  }
}

const ApiKeyContext = createContext(null);

export function ApiKeyProvider({ children }) {
  const [entries, setEntries] = useState(loadInitial);

  const setApiKey = useCallback((id, apiKey) => {
    setEntries((prev) => {
      const next = { ...prev, [id]: { ...prev[id], apiKey } };
      persist(next);
      return next;
    });
  }, []);

  const setKeyPageUrl = useCallback((id, keyPageUrl) => {
    setEntries((prev) => {
      const next = { ...prev, [id]: { ...prev[id], keyPageUrl } };
      persist(next);
      return next;
    });
  }, []);

  // このセッションからプロバイダーの情報を削除する。端末に Vault が
  // 作成済みの場合、そちらのデータはこの操作では削除されないため、
  // 呼び出し側に { vaultKept: true } を伝えて案内できるようにする。
  const clearProvider = useCallback((id) => {
    setEntries((prev) => {
      const next = { ...prev };
      delete next[id];
      persist(next);
      return next;
    });
    return { vaultKept: hasVault() };
  }, []);

  const getKeyPageUrl = useCallback(
    (id) => {
      const custom = entries[id]?.keyPageUrl;
      if (custom && custom.startsWith('https://')) return custom;
      return providers.find((p) => p.id === id)?.defaultKeyPageUrl || '';
    },
    [entries]
  );

  const isCustomUrl = useCallback(
    (id) => Boolean(entries[id]?.keyPageUrl && entries[id].keyPageUrl.startsWith('https://')),
    [entries]
  );

  // GeneratorPage.jsx が useCallback の依存配列に含めているため、
  // 呼び出しごとに参照が変わらない安定した関数である必要がある。
  const setGeminiApiKey = useCallback((apiKey) => setApiKey('gemini', apiKey), [setApiKey]);

  const value = useMemo(
    () => ({
      geminiApiKey: entries.gemini?.apiKey || '',
      setGeminiApiKey,
      entries,
      setApiKey,
      setKeyPageUrl,
      clearProvider,
      getKeyPageUrl,
      isCustomUrl,
    }),
    [entries, setGeminiApiKey, setApiKey, setKeyPageUrl, clearProvider, getKeyPageUrl, isCustomUrl]
  );

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKeys() {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error('useApiKeys must be used within ApiKeyProvider');
  return ctx;
}
