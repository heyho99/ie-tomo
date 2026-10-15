import { useCallback, useEffect, useRef, useState } from 'react';
import { wsUrl } from './serverUrl';

// iPad のノート：iPad（Safari の /pad/:room）で書いた線を、サーバー（/api/pad）経由で授業の画面に届ける
// 線と用紙の座標は iPad の CSS px。PC の画面は用紙ごと縮めて描く。メッセージの中身は server/src/pad.ts

/** 線。pts は用紙の上の座標を x, y, x, y… と並べたもの。eraser は白で上から塗る */
export type Stroke = { id: string; tool: 'pen' | 'eraser'; w: number; pts: number[] };
export type Paper = { w: number; h: number };

export const PEN_WIDTH = 3;
export const ERASER_WIDTH = 28;

const ROOM_KEY = 'tonari-sensei:padRoom';

/** この PC の部屋（合言葉）。一度決めたら変えないので、iPad のホーム画面に追加した URL がずっと使える */
export function padRoom(): string {
  try {
    const saved = localStorage.getItem(ROOM_KEY);
    if (saved && /^[a-z0-9]{4,32}$/.test(saved)) return saved;
  } catch { /* 保存できなければ、開くたびに新しい部屋になる */ }
  const room = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  try { localStorage.setItem(ROOM_KEY, room); } catch { /* 同上 */ }
  return room;
}

/** 線を1本描く（座標は用紙の上。ctx の変換で縮める） */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.pts;
  ctx.strokeStyle = s.tool === 'eraser' ? '#fff' : '#1a1a1a';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = s.w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.length === 2) { // 点だけ
    ctx.beginPath();
    ctx.arc(p[0], p[1], s.w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  // となりの点との中点を通る曲線にして、なめらかにする
  for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
  ctx.stroke();
}

/** 白い用紙に線をすべて描く。scale は用紙の 1px を canvas の何 px にするか */
export function drawPaper(ctx: CanvasRenderingContext2D, paper: Paper, strokes: Stroke[], scale: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const s of strokes) drawStroke(ctx, s);
}

type FromServer =
  | { type: 'state'; paper: Paper | null; strokes: Stroke[]; pads: number }
  | { type: 'add'; stroke: Stroke }
  | { type: 'pads'; count: number };

/**
 * /api/pad につなぐ。切れたらつなぎ直す
 * onOpen：つながるたびに呼ぶ（iPad は書ける広さ、PC はいまの問題を送る）
 */
export function usePadSocket(role: 'pad' | 'view', room: string, onOpen: (send: (m: object) => void) => void) {
  const [connected, setConnected] = useState(false);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [pads, setPads] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const send = useCallback((m: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/api/pad?room=${room}&role=${role}`));
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); openRef.current(send); };
      ws.onmessage = (e) => {
        let m: FromServer;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m.type === 'state') { setPaper(m.paper); setStrokes(m.strokes); setPads(m.pads); }
        else if (m.type === 'add') setStrokes((s) => [...s, m.stroke]);
        else if (m.type === 'pads') setPads(m.count);
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!alive) return;
        setConnected(false);
        setPads(0);
        timer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { alive = false; clearTimeout(timer); wsRef.current?.close(); wsRef.current = null; };
  }, [role, room, send]);

  return { connected, paper, strokes, setStrokes, pads, send };
}
