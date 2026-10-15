import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// ルートの node_modules には mafs 経由の React 18 がある。testing-library（ルートに入る）も client の React 19 を使うようにする
const local = (p: string) => fileURLToPath(new URL(`node_modules/${p}`, import.meta.url));
const root = (p: string) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      // ルートに入っているパッケージは、パッケージ名で読むと Node がそのまま読み、ルートの React 18 を使ってしまう。ESM のファイルを直接指す
      { find: /^@testing-library\/react$/, replacement: root('@testing-library/react/dist/@testing-library/react.esm.js') },
      { find: /^react-router-dom$/, replacement: root('react-router-dom/dist/index.mjs') },
      { find: /^react-router$/, replacement: root('react-router/dist/development/index.mjs') },
      { find: /^react$/, replacement: local('react') },
      { find: /^react\/(.*)$/, replacement: local('react/$1') },
      { find: /^react-dom$/, replacement: local('react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: local('react-dom/$1') },
    ],
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    server: { deps: { inline: [/@testing-library/, /react-router/] } },
  },
});
