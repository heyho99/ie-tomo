import express, { type Router } from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll } from 'vitest';

/**
 * ルーターを本物の http サーバーで動かす（ポートは空いているもの）。ログインは X-Uid ヘッダーの uid（requireUser の代わり）
 * 返り値の call(method, path, body) で呼ぶ
 */
export async function serve(prefix: string, router: Router, opts: { json?: object } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.uid = req.get('X-Uid') ?? 'u1'; next(); });
  app.use(express.json({ limit: '8mb', ...opts.json }));
  app.use(prefix, router);
  const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
  return async function call(method: string, path: string, body?: unknown, uid = 'u1') {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Uid': uid },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}
