import { createContext, useCallback, useContext, useState } from 'react';

const STORAGE_KEY = 'fusion_portal_providers';

// 将来 OpenAI 等を追加しやすいよう { providers: { gemini: {...}, openai: {...} } } の形を
// 見据えつつ、現段階では Gemini のみ実装する。
function loadInitial() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // sessionStorage が使えない/壊れている場合は無視して初期値を使う
  }
  return { gemini: { apiKey: '' } };
}

const ApiKeyContext = createContext(null);

export function ApiKeyProvider({ children }) {
  const [providers, setProviders] = useState(loadInitial);

  const setGeminiApiKey = useCallback((apiKey) => {
    setProviders((prev) => {
      const next = { ...prev, gemini: { ...prev.gemini, apiKey } };
      try {
        // localStorage ではなく sessionStorage に保存し、タブを閉じれば消えるようにする
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (e) {
        // 保存に失敗してもアプリの動作自体は継続する（メモリ上の state のみで動く）
      }
      return next;
    });
  }, []);

  const value = {
    geminiApiKey: providers.gemini?.apiKey || '',
    setGeminiApiKey,
  };

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKeys() {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error('useApiKeys must be used within ApiKeyProvider');
  return ctx;
}
