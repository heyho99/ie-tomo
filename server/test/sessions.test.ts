import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessage, messagesOf, saveSummary, sessions, summaryOf } from '../src/sessions.js';
import { dbGet, dbList, dbSet, resetDb } from './fakeDb.js';
import { serve } from './http.js';

// 学習の回と会話の読み書き（/api/sessions）。会話は発言を受けたサーバーが addMessage で保存する（architecture.md #3）

const call = await serve('/api/sessions', sessions);
const msgs = (uid: string, sid: string) => `users/${uid}/sessions/${sid}/messages`;

beforeEach(() => {
  resetDb();
});

describe('学習の回', () => {
  it('作る・一覧・開く・名前を変える・消す', async () => {
    const created = await call('POST', '/', { title: '  英語  ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: '英語' });
    const id = created.body.id;

    expect((await call('GET', '/')).body.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await call('GET', `/${id}`)).body).toMatchObject({ id, title: '英語' });
    expect((await call('PUT', `/${id}`, { title: '数学' })).body).toMatchObject({ title: '数学' });
    expect((await call('PUT', `/${id}`, { title: ' ' })).status).toBe(400);

    await addMessage('u1', id, 'me', 'こんにちは', 1);
    expect((await call('DELETE', `/${id}`)).status).toBe(204);
    expect(dbGet(`users/u1/sessions/${id}`)).toBeUndefined();
    expect(dbList(msgs('u1', id))).toEqual([]); // 会話もいっしょに消える
  });

  it('名前がなければ「勉強」', async () => {
    expect((await call('POST', '/', {})).body.title).toBe('勉強');
  });

  it('ほかのユーザーの回は見えない', async () => {
    const { body } = await call('POST', '/', { title: 'a' }, 'u1');
    expect((await call('GET', `/${body.id}`, undefined, 'u2')).status).toBe(404);
    expect((await call('GET', '/', undefined, 'u2')).body).toEqual([]);
  });

  it('一覧は最終更新の新しい順', async () => {
    dbSet('users/u1/sessions/old', { title: 'old', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    dbSet('users/u1/sessions/new', { title: 'new', createdAt: '2026-01-02', updatedAt: '2026-01-02' });
    expect((await call('GET', '/')).body.map((s: { id: string }) => s.id)).toEqual(['new', 'old']);
  });

  it('開くと summary も返す', async () => {
    dbSet('users/u1/sessions/s1', { title: 't', createdAt: 'x', updatedAt: 'x', summary: { text: '要約', upTo: 5 } });
    expect((await call('GET', '/s1')).body.summary).toEqual({ text: '要約', upTo: 5 });
  });
});

describe('会話', () => {
  beforeEach(() => {
    dbSet('users/u1/sessions/s1', { title: 't', createdAt: 'x', updatedAt: 'x' });
  });

  it('発言を足すと、古い順で読める', async () => {
    expect(await addMessage('u1', 's1', 'tomo', ' やあ ', 20)).toBe(true);
    await addMessage('u1', 's1', 'me', 'はい', 10);
    expect((await call('GET', '/s1/messages')).body).toEqual([
      { who: 'me', text: 'はい', at: 10 },
      { who: 'tomo', text: 'やあ', at: 20 },
    ]);
  });

  it('at を省くといまの時刻', async () => {
    vi.setSystemTime(1234);
    await addMessage('u1', 's1', 'me', 'a');
    vi.useRealTimers();
    expect(dbList(msgs('u1', 's1'))[0].at).toBe(1234);
  });

  it('空の発言・ない回・ほかのユーザーの回には保存しない', async () => {
    expect(await addMessage('u1', 's1', 'me', '  ')).toBe(false);
    expect(await addMessage('u1', 'nope', 'me', 'a')).toBe(false);
    expect(await addMessage('u2', 's1', 'me', 'a')).toBe(false);
    expect(dbList(msgs('u1', 's1'))).toEqual([]);
  });

  it('長い発言は 4000 文字で切る', async () => {
    await addMessage('u1', 's1', 'me', 'あ'.repeat(5000), 1);
    expect((dbList(msgs('u1', 's1'))[0].text as string).length).toBe(4000);
  });

  it('messagesOf：新しいほうから limit 件、after より後だけ', async () => {
    for (let at = 1; at <= 5; at++) dbSet(`${msgs('u1', 's1')}/m${at}`, { who: 'me', text: `#${at}`, at });
    expect((await messagesOf('u1', 's1', 2)).map((m) => m.at)).toEqual([4, 5]);
    expect((await messagesOf('u1', 's1', 10, 3)).map((m) => m.at)).toEqual([4, 5]);
  });

  it('要約を保存して読める', async () => {
    expect(await summaryOf('u1', 's1')).toBeNull();
    await saveSummary('u1', 's1', { text: 'まとめ', upTo: 3 });
    expect(await summaryOf('u1', 's1')).toEqual({ text: 'まとめ', upTo: 3 });
  });
});
