import { vi } from 'vitest';

// Firestore はメモリの中の偽物にする（本物にはつながない）
vi.mock('../src/db.js', async () => ({ db: (await import('./fakeDb.js')).fakeDb }));

// サーバーのログ（console.log・console.error）はテストの出力に出さない
import { beforeEach } from 'vitest';
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
