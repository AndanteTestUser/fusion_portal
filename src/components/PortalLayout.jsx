import { Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { tools } from '../tools.js';

const SETTINGS_TITLE = '設定';

function useRouteTitle(pathname) {
  if (pathname === '/settings') return SETTINGS_TITLE;
  return tools.find((tool) => tool.path === pathname)?.title || '';
}

function LoadingFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-neutral-900 text-neutral-400">
      読み込み中...
    </div>
  );
}

// ポータル全体の外枠。'/'(ウェルカム画面)以外の全ルートでヘッダーを表示する。
// このアプリはホーム画面追加のスタンドアロンPWAとして使う想定でブラウザの
// 戻るボタンが使えないため、各画面から戻る手段は必ずこのヘッダーの
// 「‹ ポータル」リンクを介する。
export default function PortalLayout() {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const title = useRouteTitle(location.pathname);

  return (
    <div className="flex h-full flex-col">
      {!isHome && (
        <header className="relative z-10 flex h-12 flex-none items-center bg-neutral-800 px-3 shadow-lg">
          <Link
            to="/"
            className="z-10 whitespace-nowrap text-sm font-bold text-neutral-300 transition-colors hover:text-white"
          >
            ‹ ポータル
          </Link>
          <h1 className="pointer-events-none absolute inset-x-0 text-center text-base font-bold text-white">
            {title}
          </h1>
        </header>
      )}
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">
          <Suspense fallback={<LoadingFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
