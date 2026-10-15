import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Generated, Tool } from '../src/llm.js';

// チャットモードの会話（/api/ai/chat）と要約（summary.ts。チャットモードは /api/ai/chat が要約する）
// 二重実装をまとめる（#2）・ai.ts を分ける（#6）ときに、
// AI に渡すもの・画面に返すものが変わらないことを確かめる

const generate = vi.hoisted(() => vi.fn());
vi.mock('../src/llm.js', async (orig) => ({ ...(await orig<typeof import('../src/llm.js')>()), generate }));

const { ai } = await import('../src/ai.js');
const { EVIDENCE_LABEL, NOTE_NOW_LABEL, SCREEN_NOW_LABEL } = await import('../src/prompts.js');
const { historyText, summarize, SUMMARY_NOTICE, summaryThreshold } = await import('../src/summary.js');
const { dbGet, dbList, dbSet, resetDb } = await import('./fakeDb.js');
const { serve } = await import('./http.js');

const call = await serve('/api/ai', ai);
const IMG = 'data:image/jpeg;base64,AAAA';
const IMG2 = 'data:image/png;base64,BBBB';

type Req = { system?: string; turns: { role: string; parts: ({ text: string } | { image: { mimeType: string; data: string } })[] }[]; tools?: Tool[] };

/** AI の返事。onCall で、AI がツールを呼んだことにできる */
function reply(text: string, opts: { prompt?: number; onCall?: (req: Req) => Promise<void> } = {}) {
  generate.mockImplementationOnce(async (_purpose: string, req: Req): Promise<Generated> => {
    await opts.onCall?.(req);
    return { text, usage: { prompt: opts.prompt ?? 100, output: 10, thoughts: 0, total: 110 }, ms: 5, model: 'gemini-3.8-flash', config: { model: 'gemini-3.8-flash', thinking: 'low', mediaResolution: 'medium' } };
  });
}
const lastReq = () => generate.mock.calls.at(-1)![1] as Req;
const tool = (req: Req, name: string) => req.tools!.find((t) => t.name === name)!;

beforeEach(() => {
  resetDb();
  generate.mockReset();
});

describe('/api/ai/chat', () => {
  it('空のメッセージは 400', async () => {
    expect((await call('POST', '/chat', { message: '  ' })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('要約・勉強の様子を system に、履歴を turns に入れる', async () => {
    reply(' こんにちは ');
    const r = await call('POST', '/chat', {
      message: 'これ何？',
      history: [{ role: 'user', text: 'やあ' }, { role: 'tomo', text: 'どうも' }],
      context: '学習の回：英語',
      summary: '前回は単語を覚えた',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reply: 'こんにちは', lookedAtScreen: false, lookedAtNote: false, model: 'gemini-3.8-flash' });
    expect(r.body).not.toHaveProperty('summary');
    expect(r.body).not.toHaveProperty('timer');
    expect(r.body).not.toHaveProperty('study');
    const req = lastReq();
    expect(generate.mock.calls[0][0]).toBe('chat');
    expect(req.system).toContain('家トモ');
    expect(req.system).toContain('ここまでの会話の要約：\n前回は単語を覚えた');
    expect(req.system).toContain('いまの勉強の様子：\n学習の回：英語');
    expect(req.turns).toEqual([
      { role: 'user', parts: [{ text: 'やあ' }] },
      { role: 'model', parts: [{ text: 'どうも' }] },
      { role: 'user', parts: [{ text: 'これ何？' }] },
    ]);
  });

  it('困りごとの合図の画像には根拠のラベル', async () => {
    reply('ok');
    await call('POST', '/chat', { message: '（声かけの合図）手が止まっている', image: IMG });
    expect(lastReq().turns.at(-1)!.parts).toEqual([
      { text: '（声かけの合図）手が止まっている' },
      { text: EVIDENCE_LABEL },
      { image: { mimeType: 'image/jpeg', data: 'AAAA' } },
    ]);
  });

  it('興味の合図の画像は「最後に読み取ったノート」、cueScreen は画面のラベルつき', async () => {
    reply('ok');
    await call('POST', '/chat', { message: '（声かけの合図・興味）集中している', image: IMG, cueScreen: IMG2 });
    expect(lastReq().turns.at(-1)!.parts).toEqual([
      { text: '（声かけの合図・興味）集中している' },
      { text: NOTE_NOW_LABEL },
      { image: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { text: SCREEN_NOW_LABEL },
      { image: { mimeType: 'image/png', data: 'BBBB' } },
    ]);
  });

  it('画面・ノートの画像は、ツールを呼んだときだけ AI に渡る', async () => {
    reply('見ました', {
      onCall: async (req) => {
        expect(JSON.stringify(req.turns)).not.toContain('BBBB'); // turns には入れない
        expect((await tool(req, 'look_at_screen').run({})).image).toEqual({ mimeType: 'image/png', data: 'BBBB' });
        expect((await tool(req, 'look_at_note').run({})).image).toEqual({ mimeType: 'image/jpeg', data: 'AAAA' });
      },
    });
    const r = await call('POST', '/chat', { message: '見て', screen: IMG2, note: IMG });
    expect(r.body).toMatchObject({ lookedAtScreen: true, lookedAtNote: true });
  });

  it('画面を共有していなければ look_at_screen はエラーを返し、見たことにしない', async () => {
    reply('見えません', { onCall: async (req) => { expect((await tool(req, 'look_at_screen').run({})).result).toHaveProperty('error'); } });
    expect((await call('POST', '/chat', { message: '見て' })).body.lookedAtScreen).toBe(false);
  });

  it('timer ツールで変えたら、変えたあとの状態を返す', async () => {
    reply('計ります', { onCall: async (req) => { await tool(req, 'timer').run({ action: 'start', minutes: 10 }); } });
    const r = await call('POST', '/chat', { message: '10分計って', timer: null });
    expect(r.body.timer).toMatchObject({ minutes: 10 });
    expect(r.body.timer.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('送られた timer をツールが読める（check）', async () => {
    let checked: unknown;
    reply('あと5分', { onCall: async (req) => { checked = (await tool(req, 'timer').run({ action: 'check' })).result; } });
    const r = await call('POST', '/chat', { message: 'あと何分？', timer: { elapsedMs: 5 * 60_000, minutes: 10 } });
    expect(checked).toMatchObject({ result: '10分のタイマー', elapsed: '5分' });
    expect(r.body).not.toHaveProperty('timer'); // 変えていなければ入れない
  });

  it('pause_study を呼んだら study を返す', async () => {
    reply('休みましょう', { onCall: async (req) => { await tool(req, 'pause_study').run({ action: 'pause' }); } });
    expect((await call('POST', '/chat', { message: '休む' })).body.study).toBe('pause');
  });

  it('会話の量を返す', async () => {
    const at = summaryThreshold('chat');
    reply('a', { prompt: at });
    expect((await call('POST', '/chat', { message: 'x' })).body).toMatchObject({ usage: { tokens: at, summaryAt: at, limit: 1_048_576 } });
  });

  it('AI が失敗したら 502、未設定なら 503', async () => {
    generate.mockRejectedValueOnce(new Error('boom'));
    const r = await call('POST', '/chat', { message: 'x' });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('boom');
    generate.mockRejectedValueOnce(Object.assign(new Error('未設定'), { status: 503 }));
    expect((await call('POST', '/chat', { message: 'x' })).status).toBe(503);
  });
});

describe('/api/ai/chat：会話を保存する（#3）', () => {
  const path = 'users/u1/sessions/s1/messages';
  const saved = () => dbList(path).sort((a: any, b: any) => a.at - b.at).map(({ who, text }: any) => ({ who, text }));
  beforeEach(() => { dbSet('users/u1/sessions/s1', { title: '英語', createdAt: 'x', updatedAt: 'x' }); });

  it('生徒の発言（student）と返事を保存する', async () => {
    reply('りんごです');
    await call('POST', '/chat', { message: 'これ何？', session: 's1', student: true });
    expect(saved()).toEqual([{ who: 'me', text: 'これ何？' }, { who: 'tomo', text: 'りんごです' }]);
  });

  it('会話モードの続き（Gemini Live の再開ハンドル）を使わないことにする（#5）', async () => {
    dbSet('users/u1/sessions/s1', { title: '英語', createdAt: 'x', updatedAt: 'x', live: { handle: 'h1', at: 1, model: 'm', voice: 'Puck' } });
    reply('はい');
    await call('POST', '/chat', { message: 'こんにちは', session: 's1', student: true });
    expect(dbGet('users/u1/sessions/s1')!.live).toBeNull();
  });

  it('合図・知らせ（student でない）は返事だけ保存する', async () => {
    reply('眠そうだね');
    await call('POST', '/chat', { message: '（声かけの合図）眠そう', session: 's1' });
    expect(saved()).toEqual([{ who: 'tomo', text: '眠そうだね' }]);
  });

  it('AI が失敗しても、生徒の発言は保存する', async () => {
    generate.mockRejectedValueOnce(new Error('x'));
    await call('POST', '/chat', { message: 'これ何？', session: 's1', student: true });
    expect(saved()).toEqual([{ who: 'me', text: 'これ何？' }]);
  });

  it('session がない・ほかのユーザーの回なら保存しない', async () => {
    reply('a');
    await call('POST', '/chat', { message: 'b', student: true });
    reply('a');
    await call('POST', '/chat', { message: 'b', session: 's1', student: true }, 'u2');
    expect(saved()).toEqual([]);
  });
});

describe('要約（summary.ts・/api/ai/chat）', () => {
  const path = 'users/u1/sessions/s1';
  const addMsgs = (n: number, from = 1) => {
    for (let at = from; at < from + n; at++) dbSet(`${path}/messages/m${at}`, { who: at % 2 ? 'me' : 'tomo', text: `発言${at}`, at });
  };
  beforeEach(() => { dbSet(path, { title: 't', createdAt: 'x', updatedAt: 'x' }); });

  it('直近10件を残して、それより前を要約して保存する', async () => {
    addMsgs(15);
    reply('- まとめ ');
    const r = await summarize('u1', 's1');
    expect(r.summary).toEqual({ text: '- まとめ', upTo: 5 });
    expect(r.recent.map((m) => m.at)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(dbGet(path)!.summary).toEqual({ text: '- まとめ', upTo: 5 });
    const prompt = (lastReq().turns[0].parts[0] as { text: string }).text;
    expect(prompt).toContain('生徒：発言1');
    expect(prompt).toContain('家トモ：発言2');
    expect(prompt).not.toContain('発言6');
  });

  it('前の要約があれば、それより後の発言だけを要約し、前の要約も渡す', async () => {
    dbSet(path, { title: 't', createdAt: 'x', updatedAt: 'x', summary: { text: '前のまとめ', upTo: 5 } });
    addMsgs(20);
    reply('新しいまとめ');
    const r = await summarize('u1', 's1');
    expect(r.summary).toEqual({ text: '新しいまとめ', upTo: 10 });
    const prompt = (lastReq().turns[0].parts[0] as { text: string }).text;
    expect(prompt).toContain('前の要約：\n前のまとめ');
    expect(prompt).not.toContain('発言5\n');
    expect(prompt).toContain('発言6');
  });

  it('10件以下なら要約しない', async () => {
    addMsgs(10);
    const r = await summarize('u1', 's1');
    expect(r).toMatchObject({ summary: null });
    expect(r.recent).toHaveLength(10);
    expect(generate).not.toHaveBeenCalled();
  });

  it('/api/ai/chat：入力がしきい値をこえたら、返事を保存してから要約して summary を返す', async () => {
    addMsgs(10);
    const at = summaryThreshold('chat');
    reply('返事', { prompt: at });
    expect((await call('POST', '/chat', { message: 'x', session: 's1', student: true })).body).not.toHaveProperty('summary');
    reply('返事', { prompt: at + 1 });
    reply('まとめ');
    const r = await call('POST', '/chat', { message: 'y', session: 's1', student: true });
    expect(r.body.reply).toBe('返事');
    expect(r.body.summary).toEqual({ text: 'まとめ', upTo: expect.any(Number) });
    expect(dbGet(path)!.summary).toEqual(r.body.summary);
    // 要約に、直前の生徒の発言・返事より前の発言が入っている（直近10件は残す）
    expect((generate.mock.calls.at(-1)![1] as Req).turns[0].parts[0]).toMatchObject({ text: expect.stringContaining('発言1') });
  });

  it('/api/ai/chat：session がない・要約するものがない・要約に失敗したときは summary を返さない', async () => {
    const at = summaryThreshold('chat');
    reply('a', { prompt: at + 1 });
    expect((await call('POST', '/chat', { message: 'x' })).body).not.toHaveProperty('summary');
    reply('a', { prompt: at + 1 });
    expect((await call('POST', '/chat', { message: 'x', session: 's1' })).body).not.toHaveProperty('summary'); // 発言が少ない
    addMsgs(20);
    reply('a', { prompt: at + 1 });
    generate.mockRejectedValueOnce(new Error('x'));
    const r = await call('POST', '/chat', { message: 'x', session: 's1' });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('summary');
  });

  it('historyText：要約と直近の発言を system に入れる形', () => {
    expect(historyText(null, [])).toBe('');
    const t = historyText({ text: 'まとめ', upTo: 1 }, [{ who: 'me', text: 'はい', at: 2 }]);
    expect(t).toContain('ここまでの会話の要約：\nまとめ');
    expect(t).toContain('そのあとの会話：\n生徒：はい');
    expect(historyText(null, [{ who: 'tomo', text: 'やあ', at: 1 }])).toContain('\n家トモ：やあ');
  });

  it('SUMMARY_NOTICE は画面（chat.ts）と同じ文', async () => {
    expect(SUMMARY_NOTICE).toBe('そろそろ会話の量が増えてきたから、古い内容は要約していくね。');
    expect(dbList(`${path}/messages`)).toEqual([]);
  });
});
