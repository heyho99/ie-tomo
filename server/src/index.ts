import './env.js';
import express from 'express';
import { ai } from './ai.js';
import { watchConfigs } from './aiConfig.js';
import { isAdmin, requireAdmin, requireUser, userOf } from './auth.js';
import { cors, originAllowed } from './cors.js';
import { watchNudgeRules } from './nudgeConfig.js';
import { watchToolConfig } from './toolConfig.js';
import { debug, debugSession } from './debug.js';
import { liveSocket } from './live.js';
import { pad, padSocket } from './pad.js';
import { sessions } from './sessions.js';

// 管理者設定（AI の設定・ツールのオン・オフ・声かけの基準）を Firestore から読み込んでから受けつける（以後の変更も受け取りつづける）
// 読めない・10秒たっても返事がない（データベースがないなど）ときは、既定の設定で動きはじめる
let timer: NodeJS.Timeout | undefined;
await Promise.race([
  Promise.all([watchConfigs(), watchNudgeRules(), watchToolConfig()]).catch(() => {}),
  new Promise((resolve) => { timer = setTimeout(() => { console.error('管理者設定を Firestore から読めないまま起動します（既定の設定を使う）'); resolve(null); }, 10_000); }),
]);
clearTimeout(timer);

const app = express();
// 画面（Firebase Hosting）は API に直接つなぐので、画面の Origin を許す（cors.ts）
app.use('/api', cors);
// AI を使う・学習記録を読み書きする API はログインがいる（auth.ts）。iPad のノート（/api/pad）は AI を使わず、
// QR コードで開く iPad はログインしていないので除く（部屋の ID が PC ごとの合言葉の代わり）
app.use(['/api/debug', '/api/ai', '/api/sessions'], requireUser);
// ログイン中のユーザーが管理者か（画面が「管理者設定」を出すかどうかに使う。守りはサーバーの requireAdmin）
app.get('/api/me', requireUser, (req, res) => { res.json({ admin: isAdmin(req.uid) }); });
// 開発者用（管理者だけ）：デバッグ画面で AI の送受信をリアルタイムで見る（debug.ts）
app.use('/api/debug', requireAdmin, debug);
// AI（Gemini）：ノートの読み取り、家トモとの会話、教材からの問題づくり。画像を受け取るので、ふつうの JSON より先に置く
// debugSession：デバッグ画面からのリクエストなら AI の送受信を記録する。本文を読んだあとに置く（読む途中で記録先がわからなくなるため）
app.use('/api/ai', express.json({ limit: '8mb' }), debugSession, ai);
app.use(express.json());

// 学習の回：教材（Web ページ・PDF）と、その回で作った問題（sessions.ts）
app.use('/api/sessions', sessions);

// iPad のノート：iPad から開く URL を作るための、PC の LAN 内の IP アドレス
app.use('/api/pad', pad);

const PORT = Number(process.env.PORT ?? 3001);
const server = app.listen(PORT, () => console.log(`API サーバー起動：http://localhost:${PORT}`));
// WebSocket はパスで振り分ける（同じ http サーバーに WebSocketServer を2つ直接つなぐと、ほかのパスを断ってしまうため）
// /api/live：家トモとの会話（Gemini Live）の中継。/api/pad：iPad のノートの線の中継
const sockets = { '/api/live': liveSocket(), '/api/pad': padSocket() };
// WebSocket をつないでよいのは ALLOWED_ORIGINS の画面だけ（cors.ts）
server.on('upgrade', async (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) { socket.destroy(); return; }
  const path = new URL(req.url ?? '', 'http://x').pathname as keyof typeof sockets;
  const wss = sockets[path];
  if (!wss || (path === '/api/live' && !(await userOf(req)))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
