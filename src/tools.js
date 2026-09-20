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
];
