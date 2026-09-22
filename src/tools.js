import { lazy } from 'react';

// アプリに機能画面を追加するときは、この配列にエントリを1つ追加するだけでよい。
// ルーティング（App.jsx）とウェルカム画面のメニューはどちらもこの配列から自動生成される。
export const tools = [
  {
    path: '/generator',
    title: 'AI Image Editor',
    icon: '🖼️',
    description: '画像のパーツを切り貼りし、AIで自然に馴染ませます。',
    component: lazy(() => import('./pages/GeneratorPage.jsx')),
  },
  {
    path: '/banzai-pose',
    title: 'BANZAI Pose Pipeline',
    icon: '🙌',
    description: '遮蔽を一時的に解き、両腕を頭側へ伸ばして復元します。',
    component: lazy(() => import('./pages/BanzaiPosePage.jsx')),
  },
  {
    path: '/gemini-canvas',
    title: 'Gemini Canvas',
    icon: '✨',
    description: '構図を解析し、元画像と比較しながらスタイル変換します。',
    component: lazy(() => import('./pages/GeminiCanvasPage.jsx')),
  },
  {
    path: '/proportion-repair',
    title: '頭身補正・描画修復',
    icon: '📐',
    description: '縦伸長で頭身を手調整し、元比率へ戻して編集痕だけを修復します。',
    component: lazy(() => import('./pages/ProportionRepairPage.jsx')),
  },
];
