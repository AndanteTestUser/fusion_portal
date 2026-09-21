import { useEffect, useRef } from 'react';
import { useWkImages } from '../context/WkImageContext.jsx';

// 指定した機能ページ(path)宛に適用すべきWK画像があれば自動的に読み込む。
// そのページに固定された画像があればそれを、なければプール(特定ページに
// 固定されていない)の中で最新のものを使う。既に画像が読み込まれている
// 場合は確認ダイアログを挟んでから上書きする。適用したWK画像は一覧から
// 削除される(単発の受け渡し用途のため)。
//
// 注意: consumeImage を呼ぶと images 一覧が変化し再レンダーされるため、
// 何も対策しないと「このページを開いた時点でプールに残っていた他の画像」まで
// 玉突きで次々と適用対象として検出され、確認ダイアログが連発したり、
// 他ページ用・永続化(この端末に残す)目的で残していた画像まで一緒に
// 消費されてしまう。それを防ぐため、初回に見つけた対象以外の「元々プールに
// あった画像」は ignoredIdsRef に積んで無視し、この後で新たに届いた画像
// (GASポーリング等)だけを引き続き自動検知の対象にする。
//
// hasExistingImage: () => boolean  読み込み先に既に画像があるかを返す関数
// onLoad: (dataUrl, filename) => void  実際に画像を読み込む処理
export function useWkAutoLoad(path, hasExistingImage, onLoad) {
  const { images, getApplicableImage, consumeImage } = useWkImages();
  const targetImage = getApplicableImage(path);
  const appliedIdRef = useRef(null);
  const ignoredIdsRef = useRef(new Set());
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    if (!targetImage) return;
    if (appliedIdRef.current === targetImage.id) return;
    if (ignoredIdsRef.current.has(targetImage.id)) return;

    // 今回の対象(targetImage)以外、現時点でプールにある画像は「このページを
    // 開く前から既にあったもの」なので、対象を処理した結果その画像が
    // 繰り上がって検出されても無視する。
    imagesRef.current.forEach((img) => {
      if (img.id !== targetImage.id) ignoredIdsRef.current.add(img.id);
    });

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
