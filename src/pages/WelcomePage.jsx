import { Link } from 'react-router-dom';

export default function WelcomePage() {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-6 bg-neutral-900 p-6 text-white">
      <h1 className="text-2xl font-bold">Fusion Portal</h1>
      <p className="max-w-sm text-center text-sm text-neutral-400">
        利用するツールを選択してください。
      </p>
      <Link
        to="/generator"
        className="rounded-lg bg-purple-600 px-6 py-3 font-bold transition-colors hover:bg-purple-500"
      >
        🖼️ AI Image Editor を開く
      </Link>
    </div>
  );
}
