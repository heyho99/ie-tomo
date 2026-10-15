// サーバー（Cloud Run）の URL。本番の画面（Firebase Hosting）は画面を配るだけで、API・WebSocket・SSE はすべて Cloud Run に直接つなぐ
// （Hosting の rewrite は WebSocket を通さず、60秒で切るため。サーバーは CORS で画面の Origin を許す。cors.ts）
// VITE_API_ORIGIN（例：https://tomo-xxxxx-an.a.run.app）はビルド時に deploy.sh が渡す。開発時は未設定で、Vite の proxy 経由（同じ Origin）
const origin = import.meta.env.VITE_API_ORIGIN;

/** API・SSE の URL */
export const apiUrl = (path: string) => `${origin ?? ''}${path}`;

/** WebSocket の URL */
export const wsUrl = (path: string) =>
  `${origin ? origin.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`}${path}`;
