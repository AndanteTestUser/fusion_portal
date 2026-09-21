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

// GASへの自動取り込みの間隔。ポーリング先はユーザーがGAS連携を設定した場合のみ
// 呼ばれるため、未設定であればネットワーク通信は一切発生しない。
// 共有直後に即反映させたい場合は手動の「今すぐ取り込む」ボタンを使う想定のため、
// バックグラウンドポーリングは「押し忘れてもそのうち反映される」程度の頻度で十分。
const GAS_POLL_INTERVAL_MS = 60000;

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

  // GAS連携が設定され、かつ「自動取り込み」がオンの場合だけ、アプリを開いている間
  // バックグラウンドでポーリングする。既定はオフ(手動の「今すぐ取り込む」ボタンで
  // 十分なケースが多いため、無駄なリクエストを避ける)。
  useEffect(() => {
    if (!gasConfig.url || !gasConfig.secret || !gasConfig.autoPoll) return undefined;
    fetchFromGas({ silent: true });
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
