import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages のプロジェクトページ（https://<user>.github.io/fusion_portal/）を想定し、
// base をリポジトリ名に合わせている。カスタムドメインを使う場合は '/' に変更すること。
export default defineConfig({
  plugins: [react()],
  base: '/fusion_portal/',
});
