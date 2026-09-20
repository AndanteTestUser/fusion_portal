import { Link } from 'react-router-dom';
import { tools } from '../tools.js';
import { providers } from '../providers.js';
import { useApiKeys } from '../context/ApiKeyContext.jsx';

export default function WelcomePage() {
  const { entries } = useApiKeys();

  return (
    <div className="flex h-full flex-col items-center gap-8 overflow-y-auto bg-neutral-900 p-6 text-white">
      <div className="flex flex-col items-center gap-2 pt-4">
        <h1 className="text-2xl font-bold">Fusion Portal</h1>
        <p className="max-w-sm text-center text-sm text-neutral-400">利用するツールを選択してください。</p>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-3">
        {tools.map((tool) => (
          <Link
            key={tool.path}
            to={tool.path}
            className="flex items-center gap-3 rounded-lg bg-neutral-800 px-4 py-3 transition-colors hover:bg-neutral-700"
          >
            <span className="text-2xl leading-none">{tool.icon}</span>
            <span className="flex flex-col">
              <span className="font-bold">{tool.title}</span>
              <span className="text-xs text-neutral-400">{tool.description}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg bg-neutral-800 p-4">
        <h2 className="text-sm font-bold text-neutral-300">APIキーの状態</h2>
        <ul className="flex flex-col gap-1.5">
          {providers.map((provider) => {
            const isSet = Boolean(entries[provider.id]?.apiKey);
            return (
              <li key={provider.id} className="flex items-center justify-between text-sm">
                <span>{provider.label}</span>
                <span className={isSet ? 'font-bold text-emerald-400' : 'text-neutral-500'}>
                  {isSet ? '✅ 設定済み' : '未設定'}
                </span>
              </li>
            );
          })}
        </ul>
        <Link
          to="/settings"
          className="mt-2 rounded-md border border-neutral-600 px-3 py-2 text-center text-sm font-bold text-neutral-200 transition-colors hover:bg-neutral-700"
        >
          ⚙️ 設定を開く
        </Link>
      </div>
    </div>
  );
}
