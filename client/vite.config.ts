import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ルートの node_modules に mafs 経由で React 18 が入っているため、React を1つに揃える
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    // host：LAN に公開する（iPad のノートを、同じ Wi-Fi の iPad から開くため）
    host: true,
    // ws：音声会話モード（/api/live）は WebSocket
    proxy: { '/api': { target: 'http://localhost:3001', ws: true } },
  },
});
