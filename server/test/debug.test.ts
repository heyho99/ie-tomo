import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// デバッグ授業の AI の送受信（debug.ts）。Cloud Run が2台以上でも流れるよう、Firestore を通して台をまたぐ（#10）

process.env.ADMIN_UIDS = 'u1';
const { debug, debugSession, traceLlm } = await import('../src/debug.js');
const { dbGet, dbList, dbSet, resetDb } = await import('./fakeDb.js');

const IMG = 'data:image/jpeg;base64,AAAA';

// この台：X-Debug-Session つきの /llm で AI を呼んだことにする。/api/debug/stream で SSE
const app = express();
app.use((req, _res, next) => { req.uid = 'u1'; next(); });
app.use(debugSession);
app.post('/llm', (_req, res) => {
  const t = traceLlm({ purpose: 'chat', provider: 'gemini', model: 'm', config: {}, endpoint: 'e', request: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] } });
  t?.end({ text: '返事', usage: {}, response: {} });
  res.json({ traced: !!t });
});
app.use('/api/debug', debug);
const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

/** SSE をつなぎ、届いたできごとを events にためる */
async function stream(session: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/debug/stream?session=${session}`, { signal: ctrl.signal });
  const events: any[] = [];
  const reader = res.body!.getReader();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        const parts = buf.split('\n\n');
        buf = parts.pop()!;
        for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)));
      }
    } catch { /* 閉じた */ }
  })();
  await flush();
  return { events, close: () => ctrl.abort() };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

beforeEach(() => { resetDb(); });

describe('デバッグの送受信を台をまたいで流す', () => {
  it('AI を呼んだら、この台の SSE に流し、Firestore にも書く（画像は1枚ずつ別のドキュメント）', async () => {
    const sse = await stream('d1');
    const r = await fetch(`${base}/llm`, { method: 'POST', headers: { 'X-Debug-Session': 'd1' } });
    expect(await r.json()).toEqual({ traced: true });
    await until(() => sse.events.length === 2);
    expect(sse.events.map((e) => e.type)).toEqual(['llm:start', 'llm:end']);
    expect(sse.events[0].images).toEqual([IMG]);
    await until(() => dbList('debugSessions/d1/debugEvents').length === 2);
    const docs = dbList('debugSessions/d1/debugEvents').sort((a: any, b: any) => a.at - b.at) as any[];
    expect(docs.map((d) => JSON.parse(d.json).type)).toEqual(['llm:start', 'llm:end']);
    expect(docs[0]).toMatchObject({ images: 1, expireAt: expect.any(Date) });
    expect(JSON.parse(docs[0].json).images).toBeUndefined();
    // 同じ台の SSE には、Firestore からは二重に流さない
    await flush();
    expect(sse.events).toHaveLength(2);
    sse.close();
  });

  it('ほかの台が Firestore に書いたできごとを、画像を読んで流す', async () => {
    const sse = await stream('d2');
    const at = Date.now() + 1;
    dbSet('debugSessions/d2/debugEvents/x/debugImages/0', { src: IMG });
    dbSet('debugSessions/d2/debugEvents/x', { from: 'other', at, json: JSON.stringify({ type: 'llm:start', id: 'a', at }), images: 1 });
    dbSet('debugSessions/d2/debugEvents/y', { from: 'other', at: at + 1, json: JSON.stringify({ type: 'llm:end', id: 'a', at: at + 1, ms: 1 }), images: 0 });
    await until(() => sse.events.length === 2);
    expect(sse.events).toEqual([{ type: 'llm:start', id: 'a', at, images: [IMG] }, { type: 'llm:end', id: 'a', at: at + 1, ms: 1 }]);
    sse.close();
  });

  it('つなぐまえに書かれたできごと・ほかのセッションのできごとは流さない', async () => {
    dbSet('debugSessions/d3/debugEvents/old', { from: 'other', at: Date.now() - 1000, json: JSON.stringify({ type: 'llm:end', id: 'old' }), images: 0 });
    const sse = await stream('d3');
    dbSet('debugSessions/d4/debugEvents/z', { from: 'other', at: Date.now() + 1, json: JSON.stringify({ type: 'llm:end', id: 'z' }), images: 0 });
    await flush();
    expect(sse.events).toEqual([]);
    expect(dbGet('debugSessions/d3/debugEvents/old')).toBeDefined();
    sse.close();
  });

  it('X-Debug-Session がなければ記録しない', async () => {
    const r = await fetch(`${base}/llm`, { method: 'POST' });
    expect(await r.json()).toEqual({ traced: false });
    await flush();
    expect(dbList('debugSessions')).toEqual([]);
  });
});
