import { useEffect, useRef } from 'react';
import { useWkImages } from '../context/WkImageContext.jsx';

// 指定した機能ページ(path)宛にチェック済みのWK画像が来たら自動的に読み込む。
// 既に画像が読み込まれている場合は確認ダイアログを挟んでから上書きする。
// 一度適用したWK画像はチェックが自動的に外れる(単発の受け渡し用途のため)。
//
// hasExistingImage: () => boolean  読み込み先に既に画像があるかを返す関数
// onLoad: (dataUrl, filename) => void  実際に画像を読み込む処理
export function useWkAutoLoad(path, hasExistingImage, onLoad) {
  const { getCheckedImageForPath, consumeChecked } = useWkImages();
  const checkedImage = getCheckedImageForPath(path);
  const appliedIdRef = useRef(null);

  useEffect(() => {
    if (!checkedImage || appliedIdRef.current === checkedImage.id) return;

    if (hasExistingImage()) {
      const proceed = window.confirm(
        'チェック済みのWK画像が届いています。読み込むと現在の画像は破棄されます。読み込みますか?'
      );
      appliedIdRef.current = checkedImage.id;
      if (!proceed) return;
    } else {
      appliedIdRef.current = checkedImage.id;
    }

    consumeChecked(checkedImage.id);
    onLoad(checkedImage.dataUrl, checkedImage.filename);
    // hasExistingImage/onLoad は呼び出し側で毎回新しい関数になりうるため、
    // 依存配列には含めず checkedImage の変化だけをトリガーにする。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedImage, consumeChecked]);
}
