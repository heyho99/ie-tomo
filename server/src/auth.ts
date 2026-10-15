import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { getAuth } from 'firebase-admin/auth';
import './db.js'; // Firebase Admin の初期化（initializeApp）を先に済ませる

// ログイン（Firebase Authentication のメール／パスワード）。パスワードは Firebase が持ち、このサーバーは見ない
// 画面は ID トークンを Authorization: Bearer ヘッダーで送る。ヘッダーを付けられない EventSource・WebSocket は ?token= で送る
// 新規登録は Firebase コンソールで止めてあり、アカウントはコンソールで手で作る（ユーザー認証の計画.md）

declare module 'express-serve-static-core' {
  interface Request { uid?: string }
}

// 管理者設定（AI の設定・ツールのオン・オフ・声かけの基準）を変えてよいユーザー（Firebase の UID をカンマ区切り）
const ADMINS = new Set((process.env.ADMIN_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** リクエストの ID トークンを確かめて UID を返す（なし・まちがい・期限切れなら null） */
export async function userOf(req: IncomingMessage): Promise<string | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : new URL(req.url ?? '', 'http://x').searchParams.get('token');
  if (!token) return null;
  try {
    return (await getAuth().verifyIdToken(token)).uid;
  } catch {
    return null;
  }
}

export const requireUser: RequestHandler = async (req, res, next) => {
  const uid = await userOf(req);
  if (!uid) { res.status(401).json({ error: 'ログインしてください' }); return; }
  req.uid = uid;
  next();
};

export const isAdmin = (uid?: string) => !!uid && ADMINS.has(uid);

/** requireUser のあとに置く */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (isAdmin(req.uid)) next();
  else res.status(403).json({ error: '管理者だけが使えます' });
};
