// 学習の回（/api/sessions/...）。いつ・何という名前で勉強したかの記録。教材は持たず、生徒は画面共有で家トモに見せる
// ユーザーごとに Firestore の users/{uid}/sessions/{id} に { title, createdAt, updatedAt }（日時は ISO 文字列）
// 会話（生徒と家トモの発言）は users/{uid}/sessions/{id}/messages に { who, text, at }（at はサーバーが受けた時刻のミリ秒）。保存するのは発言を受けたサーバー（addMessage）。続きから開くと画面に出し、AI にも渡す
// 会話が長くなったら、古い発言の要約を学習の回の summary に { text, upTo } で持つ（summary.ts）。AI には「要約＋upTo より後の発言」を渡す
// 会話モードの続き（Gemini Live の再開ハンドル）を学習の回の live に { handle, at, model, voice } で持つ（live.ts。台が替わっても続きからつなぐ）
import { Router, type Request } from 'express';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { db } from './db.js';

export const sessions = Router();

type StudySession = { id: string; title: string; createdAt: string; updatedAt: string; summary?: Summary; live?: LiveResume | null };
export type Message = { who: 'tomo' | 'me'; text: string; at: number };
/** 古い会話の要約。upTo：要約に入れた最後の発言の時刻（これより後の発言は要約していない） */
export type Summary = { text: string; upTo: number };
/** 会話モードの続き。handle：Gemini Live の最新の再開ハンドル、at：受けた時刻、model・voice：そのときつないだモデルと声（変わったら使わない） */
export type LiveResume = { handle: string; at: number; model: string; voice: string };

// 自分の記録だけ（uid は requireUser が付ける）
const sessionsOf = (uid: string) => db.collection('users').doc(uid).collection('sessions');
const col = (req: Request) => sessionsOf(req.uid!);
const view = (d: DocumentSnapshot) => {
  const { live: _, ...data } = d.data() ?? {}; // 再開ハンドルは画面に渡さない
  return { id: d.id, ...data } as StudySession;
};

const cleanTitle = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

// 過去の学習の回（新しい順）
sessions.get('/', async (req, res) => {
  res.json((await col(req).orderBy('updatedAt', 'desc').get()).docs.map(view));
});

// 新しく勉強をはじめる。title は画面が付ける（生徒の手元の日付）
sessions.post('/', async (req, res) => {
  const now = new Date().toISOString();
  const ref = await col(req).add({ title: cleanTitle(req.body?.title) || '勉強', createdAt: now, updatedAt: now });
  res.status(201).json(view(await ref.get()));
});

// 学習の回を開く（続きから勉強する）。一覧の上に来るよう、最終更新日時を今にする
sessions.get('/:id', async (req, res) => {
  const ref = col(req).doc(req.params.id);
  if (!(await ref.get()).exists) { res.status(404).json({ error: '学習の回が見つかりません' }); return; }
  await ref.update({ updatedAt: new Date().toISOString() });
  res.json(view(await ref.get()));
});

// 名前を変える
sessions.put('/:id', async (req, res) => {
  const title = cleanTitle(req.body?.title);
  if (!title) { res.status(400).json({ error: '名前を入力してください' }); return; }
  const ref = col(req).doc(req.params.id);
  if (!(await ref.get()).exists) { res.status(404).json({ error: '学習の回が見つかりません' }); return; }
  await ref.update({ title });
  res.json(view(await ref.get()));
});

sessions.delete('/:id', async (req, res) => {
  await db.recursiveDelete(col(req).doc(req.params.id)); // 会話もいっしょに消す
  res.status(204).end();
});

const MESSAGE_LIMIT = 200; // 画面に出す会話の数（学習画面の会話欄と同じ）

/** 学習の回の会話の、新しいほうから limit 件（古い順にして返す）。after があれば、その時刻より後の発言だけ。学習の回がなければ空 */
export async function messagesOf(uid: string, sessionId: string, limit = MESSAGE_LIMIT, after = 0): Promise<Message[]> {
  let q = sessionsOf(uid).doc(sessionId).collection('messages').orderBy('at', 'desc');
  if (after) q = q.where('at', '>', after);
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => d.data() as Message).reverse();
}

/** 学習の回の、古い会話の要約（まだなければ null） */
export async function summaryOf(uid: string, sessionId: string): Promise<Summary | null> {
  const s = (await sessionsOf(uid).doc(sessionId).get()).data()?.summary as Summary | undefined;
  return s?.text ? s : null;
}

export async function saveSummary(uid: string, sessionId: string, summary: Summary) {
  await sessionsOf(uid).doc(sessionId).update({ summary });
}

/** 会話モードの続き（まだない・使わないことにしたなら null） */
export async function liveResumeOf(uid: string, sessionId: string): Promise<LiveResume | null> {
  const r = (await sessionsOf(uid).doc(sessionId).get()).data()?.live as LiveResume | null | undefined;
  return r?.handle ? r : null;
}

/** 会話モードの続きを覚える。null は使わないことにする（要約した・チャットモードで話したなど、ハンドルの中身が会話とずれたとき）。学習の回がなければ何もしない */
export async function saveLiveResume(uid: string, sessionId: string, live: LiveResume | null) {
  const ref = sessionsOf(uid).doc(sessionId);
  if ((await ref.get()).exists) await ref.update({ live });
}

// これまでの会話
sessions.get('/:id/messages', async (req, res) => {
  res.json(await messagesOf(req.uid!, req.params.id));
});

/**
 * 発言を1つ足す。発言を受けたサーバー（会話モードは live.ts、チャットモードは ai.ts の /chat）が保存する（画面が閉じられても欠けないように）
 * at を省くといまの時刻。空の発言・学習の回がないときは保存しない（false）
 */
export async function addMessage(uid: string, sessionId: string, who: Message['who'], text: string, at = Date.now()) {
  const t = text.trim().slice(0, 4000);
  if (!t) return false;
  const ref = sessionsOf(uid).doc(sessionId);
  if (!(await ref.get()).exists) return false;
  await ref.collection('messages').add({ who, text: t, at } satisfies Message);
  return true;
}
