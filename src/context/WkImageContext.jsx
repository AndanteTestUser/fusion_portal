import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadWkImages,
  saveWkImages,
  loadGasConfig,
  saveGasConfig,
  fetchGasImages,
  mergeGasImages,
  addImageToList,
  removeImageFromList,
  setCheckedInList,
  setTargetPathInList,
  setPersistedInList,
  generateImageId,
} from '../lib/wkImageStore.js';

// GASへの自動取り込み(ポーリング)の間隔。既定はオフで、設定画面で明示的に
// オンにした場合のみ動作する(オンにする場合はアプリを開きっぱなしで共有する
// ケースにも対応できるよう、体感の速さを優先して20秒間隔にしている)。
const GAS_POLL_INTERVAL_MS = 20000;

const WkImageContext = createContext(null);

export function WkImageProvider({ children }) {
  const [images, setImages] = useState(loadWkImages);
  const [gasConfig, setGasConfigState] = useState(loadGasConfig);
  const [gasStatus, setGasStatus] = useState({ busy: false, message: '' });
  const fetchInFlightRef = useRef(false);

  const addImage = useCallback(
    ({ dataUrl, filename, targetPath = null, source = 'upload' }) => {
      const image = {
        id: generateImageId(),
        dataUrl,
        filename: filename || '',
        targetPath,
        checked: false,
        persisted: false,
        source,
        createdAt: Date.now(),
      };
      setImages((prev) => {
        const next = addImageToList(prev, image);
        saveWkImages(next);
        return next;
      });
      return image.id;
    },
    []
  );

  const removeImage = useCallback((id) => {
    setImages((prev) => {
      const next = removeImageFromList(prev, id);
      saveWkImages(next);
      return next;
    });
  }, []);

  const setChecked = useCallback((id, checked) => {
    setImages((prev) => {
      const next = setCheckedInList(prev, id, checked);
      saveWkImages(next);
      return next;
    });
  }, []);

  const setTargetPath = useCallback((id, targetPath) => {
    setImages((prev) => {
      const next = setTargetPathInList(prev, id, targetPath);
      saveWkImages(next);
      return next;
    });
  }, []);

  const setPersisted = useCallback((id, persistedFlag) => {
    setImages((prev) => {
      const next = setPersistedInList(prev, id, persistedFlag);
      saveWkImages(next);
      return next;
    });
  }, []);

  // 機能ページが自動選択を実行した後に呼ぶ。チェックだけを外し、一覧からは削除しない
  // (単発の受け渡し用途のため、同じ画像を毎回自動適用し続けないようにする)。
  const consumeChecked = useCallback((id) => {
    setImages((prev) => {
      const next = setCheckedInList(prev, id, false);
      saveWkImages(next);
      return next;
    });
  }, []);

  const saveGasConfigAndState = useCallback((config) => {
    setGasConfigState(config);
    saveGasConfig(config);
  }, []);

  // silent=true はバックグラウンドポーリング用。「新しい画像はありませんでした」を
  // 毎回表示すると煩わしいため、何か見つかった時・エラー時以外は状態を更新しない。
  // 手動ボタン(silent=false)のときは、結果が空でもその旨を表示する。
  const fetchFromGas = useCallback(
    async ({ silent = false } = {}) => {
      if (fetchInFlightRef.current) return;
      if (!gasConfig.url || !gasConfig.secret) return;
      fetchInFlightRef.current = true;
      if (!silent) setGasStatus({ busy: true, message: '' });
      try {
        const gasImages = await fetchGasImages(gasConfig);
        setImages((prev) => {
          const next = mergeGasImages(prev, gasImages);
          if (next !== prev) saveWkImages(next);
          return next;
        });
        if (gasImages.length > 0) {
          setGasStatus({ busy: false, message: `${gasImages.length}件のWK画像を取り込みました` });
        } else if (!silent) {
          setGasStatus({ busy: false, message: '新しいWK画像はありませんでした' });
        } else {
          setGasStatus((prev) => ({ ...prev, busy: false }));
        }
      } catch (error) {
        setGasStatus({ busy: false, message: error.message || 'GASからの取得に失敗しました' });
      } finally {
        fetchInFlightRef.current = false;
      }
    },
    [gasConfig]
  );

  // ショートカット実行後にアプリを開き直す(または既に開いていたアプリの前面に
  // 戻ってくる)運用を主なトリガーとして想定し、GAS連携が設定されていれば
  // 「表示された瞬間」に1回だけ取り込みを試みる。ポーリングではないため、
  // 無駄なリクエストは発生しない。
  useEffect(() => {
    if (!gasConfig.url || !gasConfig.secret) return undefined;

    fetchFromGas({ silent: true });

    const handleVisible = () => {
      if (document.visibilityState === 'visible') fetchFromGas({ silent: true });
    };
    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gasConfig.url, gasConfig.secret]);

  // 上記の「開いた瞬間」トリガーとは別に、アプリを開きっぱなしの間も一定間隔で
  // 取り込みたい場合だけ追加でポーリングする(既定はオフ)。
  useEffect(() => {
    if (!gasConfig.url || !gasConfig.secret || !gasConfig.autoPoll) return undefined;
    const timer = setInterval(() => fetchFromGas({ silent: true }), GAS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gasConfig.url, gasConfig.secret, gasConfig.autoPoll]);

  const getCheckedImageForPath = useCallback(
    (path) => images.find((img) => img.targetPath === path && img.checked) || null,
    [images]
  );

  const value = useMemo(
    () => ({
      images,
      addImage,
      removeImage,
      setChecked,
      setTargetPath,
      setPersisted,
      consumeChecked,
      getCheckedImageForPath,
      gasConfig,
      saveGasConfig: saveGasConfigAndState,
      gasStatus,
      fetchFromGas,
    }),
    [
      images,
      addImage,
      removeImage,
      setChecked,
      setTargetPath,
      setPersisted,
      consumeChecked,
      getCheckedImageForPath,
      gasConfig,
      saveGasConfigAndState,
      gasStatus,
      fetchFromGas,
    ]
  );

  return <WkImageContext.Provider value={value}>{children}</WkImageContext.Provider>;
}

export function useWkImages() {
  const ctx = useContext(WkImageContext);
  if (!ctx) throw new Error('useWkImages must be used within WkImageProvider');
  return ctx;
}
