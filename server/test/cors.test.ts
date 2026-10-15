import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';

// 画面が直接つなぐ API の CORS（cors.ts。#9）。許すのは ALLOWED_ORIGINS の画面だけ

process.env.ALLOWED_ORIGINS = 'https://p.web.app, https://p.firebaseapp.com';
const { cors, originAllowed } = await import('../src/cors.js');

const app = express();
app.use(cors);
app.use((req, res, next) => { if (!req.get('Authorization')) { res.status(401).end(); return; } next(); }); // ログインの確認の代わり
app.post('/api/ai/chat', (_req, res) => { res.json({ ok: true }); });
const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/chat`;

describe('CORS', () => {
  it('許した Origin のプリフライトには、ログインの確認より先に 204 を返す', async () => {
    const r = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://p.web.app', 'Access-Control-Request-Method': 'POST' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://p.web.app');
    expect(r.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(r.headers.get('access-control-allow-headers')).toContain('X-Debug-Session');
  });

  it('許した Origin の返事は読める', async () => {
    const r = await fetch(url, { method: 'POST', headers: { Origin: 'https://p.firebaseapp.com', Authorization: 'Bearer x' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://p.firebaseapp.com');
  });

  it('ほかの Origin には許可を付けない（プリフライトもログインの確認に進んで断られる）', async () => {
    const r = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('WebSocket も同じ Origin だけ', () => {
    expect(originAllowed('https://p.web.app')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed(undefined)).toBe(false);
  });
});
