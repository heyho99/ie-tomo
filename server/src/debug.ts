import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Router, type RequestHandler } from 'express';
import { isAdmin } from './auth.js';
import { db } from './db.js';

// 開発者用：デバッグ授業で、AI（LLM）に送ったデータと返ってきたデータをリアルタイムで見る
// 画面はリクエストに X-Debug-Session ヘッダーを付ける。そのリクエストの中で呼んだ LLM の送受信だけを記録し、
// 同じセッションの画面に SSE（/api/debug/stream）で流す。ふつうの授業では何も記録しない
// Cloud Run が2台以上のとき、AI を呼んだ台と SSE をつないでいる台がちがうことがあるので、台をまたいで Firestore で流す
//   debugSessions/{session}/debugEvents/{id} に { from, at, json, images, expireAt }。画像は1枚ずつ debugImages/{i} に { src, expireAt }
//   （1つのドキュメントは 1MB まで。大きすぎるものは省く）。expireAt を過ぎたら TTL で消える（deploy.sh setup）
//   同じ台では Firestore を待たずにメモリで流す（from が自分のものは Firestore からは流さない）

const session = new AsyncLocalStorage<string>();
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** 画面に流すできごと。start で送ったデータ、end で返ってきたデータ（失敗なら error） */
export type LlmEvent =
  | { type: 'llm:start'; id: string; at: number; purpose: string; provider: string; model: string; config: unknown; endpoint: string; request: unknown; images: string[] }
  | { type: 'llm:end'; id: string; at: number; ms: number; text?: string; usage?: unknown; response?: unknown; error?: string };

/** X-Debug-Session ヘッダーがあれば、そのリクエストの処理をデバッグセッションの中で動かす */
export const debugSession: RequestHandler = (req, _res, next) => {
  const id = req.get('X-Debug-Session');
  // デバッグ授業は管理者だけ。管理者でなければ記録しない
  if (id && isAdmin(req.uid)) session.run(id, next);
  else next();
};

let seq = 0;
const INSTANCE = randomUUID(); // この台の印（自分が Firestore に書いたできごとを、二重に流さない）
const TTL_MS = 24 * 60 * 60_000; // Firestore に残す時間
const MAX_DOC = 900_000; // 1つのドキュメントに入れる文字数の上限（Firestore は 1MB まで）
const TOO_BIG = '<大きすぎるので、ほかの台には送らない>';
const eventsOf = (sid: string) => db.collection('debugSessions').doc(sid).collection('debugEvents');

let relaying = Promise.resolve(); // start より先に end が届かないよう、Firestore には順に書く

/** できごとを流す。同じ台の SSE にはメモリで、ほかの台の SSE には Firestore で */
function publish(sid: string, e: LlmEvent) {
  bus.emit(sid, e);
  relaying = relaying.then(() => relay(sid, e)).catch((err) => console.error('[debug] Firestore に書けません', (err as Error).message));
}

async function relay(sid: string, e: LlmEvent) {
  const { images = [], ...rest } = e as LlmEvent & { images?: string[] };
  const expireAt = new Date(Date.now() + TTL_MS);
  let json = JSON.stringify(rest);
  if (json.length > MAX_DOC) json = JSON.stringify({ ...rest, ...('request' in rest && { request: TOO_BIG }), ...('response' in rest && { response: TOO_BIG }), ...('text' in rest && { text: TOO_BIG }) });
  const ref = eventsOf(sid).doc();
  await Promise.all(images.map((src, i) => ref.collection('debugImages').doc(String(i)).set({ src: src.length > MAX_DOC ? '' : src, expireAt })));
  await ref.set({ from: INSTANCE, at: Date.now(), json, images: images.length, expireAt });
}

/** ほかの台が Firestore に書いたできごとを受け取る（since より後に書かれたものだけ）。返り値で受け取るのをやめる */
function subscribe(sid: string, since: number, send: (e: LlmEvent) => void) {
  let chain = Promise.resolve(); // 画像を読むあいだに順番が入れかわらないよう、届いた順に流す
  return eventsOf(sid).where('at', '>', since).onSnapshot((snap) => {
    for (const c of snap.docChanges()) {
      const d = c.doc.data();
      if (c.type !== 'added' || d.from === INSTANCE) continue;
      chain = chain.then(async () => {
        const images = await Promise.all(Array.from({ length: d.images as number }, async (_, i) =>
          ((await c.doc.ref.collection('debugImages').doc(String(i)).get()).data()?.src as string | undefined) ?? ''));
        const e = JSON.parse(d.json as string) as LlmEvent;
        send(e.type === 'llm:start' ? { ...e, images } : e);
      }).catch((err) => console.error('[debug] Firestore から読めません', (err as Error).message));
    }
  }, (err) => console.error('[debug] Firestore を購読できません', err.message));
}

/** いまのリクエストがデバッグ授業からなら、LLM の呼び出しを記録する関数を返す（そうでなければ null） */
export function traceLlm(info: { purpose: string; provider: string; model: string; config: unknown; endpoint: string; request: unknown }) {
  const sid = session.getStore();
  if (!sid) return null;
  const id = `${Date.now().toString(36)}-${++seq}`;
  const started = Date.now();
  const { value, images } = stripBinary(info.request);
  publish(sid, { type: 'llm:start', id, at: started, ...info, request: value, images } satisfies LlmEvent);
  return {
    end: (r: { text: string; usage: unknown; response: unknown }) =>
      publish(sid, { type: 'llm:end', id, at: Date.now(), ms: Date.now() - started, text: r.text, usage: r.usage, response: stripBinary(r.response).value } satisfies LlmEvent),
    fail: (e: unknown) => {
      const response = (e as { response?: unknown } | null)?.response; // 断られたときなど、返ってきた中身があれば添える
      publish(sid, {
        type: 'llm:end', id, at: Date.now(), ms: Date.now() - started,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        ...(response !== undefined && { response: stripBinary(response).value }),
      } satisfies LlmEvent);
    },
  };
}

/**
 * 画像・PDF の base64 は長すぎて読めないので、置きかえて短くする。画像は images に data URL で取り出す（画面で表示する）
 * Gemini は { mimeType, data }、Claude は { type: 'base64', media_type, data } の形
 */
function stripBinary(v: unknown): { value: unknown; images: string[] } {
  const images: string[] = [];
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    const mime = typeof o.mimeType === 'string' ? o.mimeType : typeof o.media_type === 'string' ? o.media_type : '';
    if (mime && typeof o.data === 'string') {
      const kb = Math.round((o.data.length * 3) / 4 / 1024);
      let note = `<${mime} base64 ${kb}KB>`;
      if (mime.startsWith('image/')) {
        images.push(`data:${mime};base64,${o.data}`);
        note = `<${mime} base64 ${kb}KB：画像 #${images.length}>`;
      }
      return { ...o, data: note };
    }
    return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, walk(val)]));
  };
  return { value: walk(v), images };
}

export const debug = Router();

/** デバッグ授業の画面が開く SSE。session はその画面が作った ID */
debug.get('/stream', (req, res) => {
  const sid = String(req.query.session ?? '');
  if (!sid) { res.status(400).json({ error: 'session を指定してください' }); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const send = (e: LlmEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on(sid, send);
  const unsubscribe = subscribe(sid, Date.now(), send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000); // 途中で切られないように
  req.on('close', () => { clearInterval(ping); bus.off(sid, send); unsubscribe(); });
});
