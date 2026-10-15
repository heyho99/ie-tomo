import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { WebSocketServer, type WebSocket } from 'ws';
import { db } from './db.js';

// iPad のノート：iPad（Safari）で Apple Pencil で書いた線を、授業の画面（PC）に中継する。WebSocket の /api/pad
// ?room= は PC ごとの合言葉（PC の画面が決めて QR コードに入れる）。?role= は pad（iPad）か view（PC の画面）
//
// サーバーは何台にもなりうる（Cloud Run）ので、iPad と PC が別の台につながっても届くよう、部屋は Firestore に置く
//   padRooms/{room}                  { paper, lastPad, page, gen, expireAt } 用紙・いまの問題・白紙にした回（gen）
//   padRooms/{room}/strokes/{id}     { stroke, gen, at, expireAt }           線。いまの gen の線だけが用紙に出る
//   padRooms/{room}/clients/{id}     { role, expireAt }                      つないでいる iPad（数を数えるため）
// 各台は、自分に1人でもつながっている部屋だけ購読して、変化を自分の WebSocket に流す
// 白紙にするときは gen を変えるだけ（線は消さない）。古い線・部屋は expireAt（TTL）で Firestore が消す
//
// iPad → サーバー
//   hello { w, h }   書ける広さ（CSS px）。用紙がまだなければ、この大きさを用紙にする
//   add   { stroke } 線を1本書いた（書き終わったときに送る）
//   undo             最後の1本を消す
//   clear            全部消す（用紙は最後につないだ iPad の大きさにしなおす）
// PC の画面 → サーバー
//   page  { key }    いまの問題。変わったら白紙にする（同じ key なら、そのまま続きを出す）
// サーバー → みんな
//   state { paper, strokes, pads } 用紙・線のすべてと、つないでいる iPad の数（つないだとき・消したとき・白紙にしたとき）
//   add   { stroke } 線が1本ふえた（書いた iPad には送らない）
//   pads  { count }  つないでいる iPad の数が変わった

/** 線。pts は用紙の上の座標（CSS px）を x, y, x, y… と並べたもの。eraser は白で上から塗る */
type Stroke = { id: string; tool: 'pen' | 'eraser'; w: number; pts: number[] };
type Size = { w: number; h: number };
type RoomDoc = { paper: Size | null; lastPad: Size | null; page: string; gen: number };
/** 用紙に出ている線。docId は Firestore のドキュメント ID（undo で消すため） */
type Line = { docId: string; at: number; stroke: Stroke };

/** この台につながっている部屋。doc・lines・padCount は Firestore を購読して最新にしておく */
type Room = {
  ref: DocumentReference;
  doc: RoomDoc;
  lines: Line[];
  padCount: number;
  pads: Set<WebSocket>;
  views: Set<WebSocket>;
  /** この台でこの部屋につないでいる数（読み込み待ちの人も含む）。0 になったら購読をやめる */
  users: number;
  /** 最初の読み込みが終わったら解決する */
  ready: Promise<void>;
  stop: () => void;
};

const MAX_STROKES = 5000;
const TTL_MS = 24 * 60 * 60 * 1000;
const expireAt = () => Timestamp.fromMillis(Date.now() + TTL_MS);
const rooms = new Map<string, Room>();
/** この台がつくった clients のドキュメント（終了するときに消す） */
const myClients = new Set<DocumentReference>();
/** 線の時刻（ミリ秒）。同じミリ秒に2本来ても順番がわかるよう、かならず前より大きくする */
let lastAt = 0;

const send = (ws: WebSocket, m: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
const everyone = (r: Room) => [...r.pads, ...r.views];
const broadcast = (r: Room, m: object, except?: WebSocket) => everyone(r).forEach((ws) => ws !== except && send(ws, m));
const stateOf = (r: Room) => ({ type: 'state', paper: r.doc.paper, strokes: r.lines.map((l) => l.stroke), pads: r.padCount });

/**
 * 部屋のドキュメントを読み、fn の結果で書きかえる（トランザクション）
 * 部屋がまだない（期限切れで消えた）ときの gen は今の時刻にする。前に同じ部屋で書いた線が、うっかり出てこないように
 */
function updateRoom(r: Room, fn: (d: RoomDoc) => Partial<RoomDoc> | null) {
  return db.runTransaction(async (t) => {
    const snap = await t.get(r.ref);
    const d: RoomDoc = { paper: null, lastPad: null, page: '', gen: Date.now(), ...(snap.data() as Partial<RoomDoc> | undefined) };
    const next = fn(d);
    if (next) t.set(r.ref, { ...d, ...next, expireAt: expireAt() });
  });
}

/** 白紙にする。用紙は最後につないだ iPad の大きさ（向きを変えていたら、その向き）にしなおす */
const blank = (d: RoomDoc): Partial<RoomDoc> => ({ gen: Math.max(d.gen + 1, Date.now()), paper: d.lastPad ?? d.paper });

/** 部屋を開く（この台で最初の1人なら Firestore の購読をはじめる） */
function openRoom(id: string): Room {
  const found = rooms.get(id);
  if (found) return found;
  const ref = db.collection('padRooms').doc(id);
  const r: Room = { ref, doc: { paper: null, lastPad: null, page: '', gen: 0 }, lines: [], padCount: 0, pads: new Set(), views: new Set(), users: 0, ready: Promise.resolve(), stop: () => {} };
  const fail = (what: string) => (e: Error) => console.error(`iPad のノート（${what}）を Firestore から読めません：`, e.message);

  // 線：いまの gen の線だけ購読する。gen が変わったら購読しなおし、みんなに用紙ごと送りなおす
  let stopLines = () => {};
  const watchLines = (gen: number) => new Promise<void>((resolve) => {
    stopLines();
    r.lines = [];
    let first = true;
    stopLines = ref.collection('strokes').where('gen', '==', gen).onSnapshot((snap) => {
      if (r.doc.gen !== gen) return;
      let removed = false;
      const added: Line[] = [];
      for (const c of snap.docChanges()) {
        if (c.type === 'removed') {
          const n = r.lines.length;
          r.lines = r.lines.filter((l) => l.docId !== c.doc.id);
          removed ||= r.lines.length !== n;
        } else if (c.type === 'added' && !r.lines.some((l) => l.docId === c.doc.id)) { // この台で書いた線はもう入っている
          const d = c.doc.data() as { stroke: Stroke; at: number };
          added.push({ docId: c.doc.id, at: d.at, stroke: d.stroke });
        }
      }
      // 届く順は書いた順とはかぎらない（消しゴムは上から塗るので、順番が大事）
      // すでに出した線より前に書かれた線が届いたら、add ではなく用紙ごと送りなおす
      added.sort((a, b) => a.at - b.at);
      const late = added.length > 0 && added[0].at < (r.lines.at(-1)?.at ?? 0);
      r.lines.push(...added);
      r.lines.sort((a, b) => a.at - b.at);
      if (first || removed || late) broadcast(r, stateOf(r));
      else added.forEach((l) => broadcast(r, { type: 'add', stroke: l.stroke }));
      if (first) { first = false; resolve(); }
    }, (e) => { fail('線')(e); resolve(); });
  });

  // 部屋：用紙・gen。gen が変わったら線を購読しなおす
  let linesReady: Promise<void> | null = null;
  let stopDoc = () => {};
  const docReady = new Promise<void>((resolve) => {
    stopDoc = ref.onSnapshot((snap) => {
      const next: RoomDoc = { paper: null, lastPad: null, page: '', gen: 0, ...(snap.data() as Partial<RoomDoc> | undefined) };
      const prev = r.doc;
      r.doc = next;
      if (!linesReady || next.gen !== prev.gen) linesReady = watchLines(next.gen);
      else if (JSON.stringify(next.paper) !== JSON.stringify(prev.paper)) broadcast(r, stateOf(r));
      resolve();
    }, (e) => { fail('部屋')(e); resolve(); });
  });

  // つないでいる iPad の数（どの台につないでいても数える）
  let stopClients = () => {};
  const clientsReady = new Promise<void>((resolve) => {
    stopClients = ref.collection('clients').where('role', '==', 'pad').onSnapshot((snap) => {
      if (snap.size !== r.padCount) { r.padCount = snap.size; broadcast(r, { type: 'pads', count: r.padCount }); }
      resolve();
    }, (e) => { fail('iPad の数')(e); resolve(); });
  });

  r.ready = Promise.all([docReady, clientsReady]).then(() => linesReady ?? undefined);
  r.stop = () => { stopDoc(); stopClients(); stopLines(); };
  rooms.set(id, r);
  return r;
}

const isSize = (m: { w?: unknown; h?: unknown }) => Number(m.w) > 0 && Number(m.h) > 0;
function isStroke(s: unknown): s is Stroke {
  const t = s as Stroke;
  return !!t && typeof t.id === 'string' && (t.tool === 'pen' || t.tool === 'eraser') && Number(t.w) > 0
    && Array.isArray(t.pts) && t.pts.length >= 2 && t.pts.length % 2 === 0 && t.pts.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** /api/pad の WebSocket（http サーバーへのつなぎ方は index.ts） */
export function padSocket() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    const id = q.get('room') ?? '';
    const isPad = q.get('role') === 'pad';
    if (!/^[a-z0-9]{4,32}$/.test(id)) { ws.close(1008, 'room'); return; }
    const r = openRoom(id);
    r.users++;
    const client = isPad ? r.ref.collection('clients').doc(randomUUID()) : null;
    let closed = false;
    const report = (e: Error) => console.error('iPad のノートを Firestore に書けません：', e.message);

    // 最初の読み込みが終わってから仲間に入れる（state を送る前の変化を取りこぼさないため）
    r.ready.then(() => {
      if (closed) return;
      (isPad ? r.pads : r.views).add(ws);
      send(ws, stateOf(r));
      if (client) { myClients.add(client); client.set({ role: 'pad', expireAt: expireAt() }).catch(report); }
    });

    // メッセージは ready のあとに届いた順に処理する
    ws.on('message', (raw) => r.ready.then(() => {
      let m: { type?: string; w?: number; h?: number; stroke?: unknown; key?: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (isPad && m.type === 'hello' && isSize(m)) {
        const size = { w: Number(m.w), h: Number(m.h) };
        updateRoom(r, (d) => ({ lastPad: size, paper: d.paper ?? size })).catch(report);
      } else if (isPad && m.type === 'add' && isStroke(m.stroke)) {
        if (r.lines.length >= MAX_STROKES) return;
        // この台の仲間にはすぐ送り、Firestore 経由でほかの台に届ける
        const doc = r.ref.collection('strokes').doc();
        const line = { docId: doc.id, at: lastAt = Math.max(Date.now(), lastAt + 1), stroke: m.stroke };
        r.lines.push(line);
        broadcast(r, { type: 'add', stroke: m.stroke }, ws);
        doc.set({ stroke: m.stroke, gen: r.doc.gen, at: line.at, expireAt: expireAt() }).catch(report);
      } else if (isPad && m.type === 'undo') {
        const last = r.lines.pop();
        if (!last) return;
        broadcast(r, stateOf(r));
        r.ref.collection('strokes').doc(last.docId).delete().catch(report);
      } else if (isPad && m.type === 'clear') {
        updateRoom(r, blank).catch(report);
      } else if (!isPad && m.type === 'page' && typeof m.key === 'string') {
        const key = m.key;
        updateRoom(r, (d) => (key === d.page ? null : { ...blank(d), page: key })).catch(report);
      }
    }));

    ws.on('close', () => {
      closed = true;
      (isPad ? r.pads : r.views).delete(ws);
      if (client) { myClients.delete(client); client.delete().catch(report); }
      if (--r.users === 0) { r.stop(); rooms.delete(id); }
    });
  });
  return wss;
}

/** 終了するとき（Cloud Run が台を減らすときなど）、この台の iPad を数から外す */
process.once('SIGTERM', async () => {
  await Promise.allSettled([...myClients].map((c) => c.delete()));
  process.exit(0);
});

// 仮想のネットワーク（WSL・Hyper-V・VPN など）は iPad から届かないことが多いので後ろに回す
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|VPN/i;
const rank = (name: string, address: string) =>
  (VIRTUAL.test(name) ? 10 : 0) + (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);

/** PC の LAN 内の IP アドレス（iPad から開く URL を作るため）。iPad から届きそうな順 */
export const pad = Router();
pad.get('/addresses', (_req, res) => {
  const list = Object.entries(networkInterfaces()).flatMap(([name, infos]) =>
    (infos ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, address: i.address })));
  list.sort((a, b) => rank(a.name, a.address) - rank(b.name, b.address));
  res.json({ addresses: list });
});
