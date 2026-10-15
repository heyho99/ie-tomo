import type { RequestHandler } from 'express';

// ALLOWED_ORIGINS：サーバーに直接つないでよい画面の Origin（カンマ区切り）。本番は画面（Firebase Hosting）とサーバー（Cloud Run）のドメインが
// 別なので、ほかのサイトから会話 AI などを勝手に使われないように絞る。未設定（開発時）はすべて許可（Vite の proxy 経由で同じ Origin になる）
const allowed = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim());

/** この Origin の画面からつないでよいか（WebSocket の upgrade で使う） */
export const originAllowed = (origin: string | undefined) => !allowed || allowed.includes(origin ?? '');

/**
 * 画面が直接つなぐ API（画面の serverUrl.ts）の CORS
 * 許した Origin にだけ返事を読ませる。プリフライト（OPTIONS）はログインの確認より先に返す（トークンを付けずに来るため）
 */
export const cors: RequestHandler = (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowed?.includes(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Debug-Session',
        'Access-Control-Max-Age': '3600',
      });
      res.status(204).end();
      return;
    }
  }
  next();
};
