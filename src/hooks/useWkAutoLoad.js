import { useEffect, useRef } from 'react';
import { useWkImages } from '../context/WkImageContext.jsx';

// 指定した機能ページ(path)宛に適用すべきWK画像があれば自動的に読み込む。
// そのページに固定された画像があればそれを、なければプール(特定ページに
// 固定されていない)の中で最新のものを使う。既に画像が読み込まれている
// 場合は確認ダイアログを挟んでから上書きする。適用したWK画像は一覧から
// 削除される(単発の受け渡し用途のため)。
//
// hasExistingImage: () => boolean  読み込み先に既に画像があるかを返す関数
// onLoad: (dataUrl, filename) => void  実際に画像を読み込む処理
export function useWkAutoLoad(path, hasExistingImage, onLoad) {
  const { getApplicableImage, consumeImage } = useWkImages();
  const targetImage = getApplicableImage(path);
  const appliedIdRef = useRef(null);

  useEffect(() => {
    if (!targetImage || appliedIdRef.current === targetImage.id) return;

    if (hasExistingImage()) {
      const proceed = window.confirm(
        'WK画像が届いています。読み込むと現在の画像は破棄されます。読み込みますか?'
      );
      appliedIdRef.current = targetImage.id;
      if (!proceed) return;
    } else {
      appliedIdRef.current = targetImage.id;
    }

    consumeImage(targetImage.id);
    onLoad(targetImage.dataUrl, targetImage.filename);
    // hasExistingImage/onLoad は呼び出し側で毎回新しい関数になりうるため、
    // 依存配列には含めず targetImage の変化だけをトリガーにする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetImage, consumeImage]);
}
