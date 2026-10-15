import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 会話モードの中継（live.ts の LiveLesson）。画面とは WebSocket の JSON、Gemini Live とは SDK の Session でやりとりする
// WS の再接続（#8）・二重実装をまとめる（#2）・状態を Firestore に置く（#5）ときに、やりとりが変わらないことを確かめる
// Gemini Live（liveClient）と、要約の AI（generate）は偽物にする

/** Gemini Live の偽の接続。送ったものを記録し、cb でサーバーからのメッセージを流せる */
type FakeSession = {
  opts: any;
  sendClientContent: ReturnType<typeof vi.fn>;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  msg: (m: object) => void;
  drop: (code?: number) => void;
};
const live = vi.hoisted(() => ({ sessions: [] as any[], fail: 0 }));
const generate = vi.hoisted(() => vi.fn());
vi.mock('../src/llm.js', async (orig) => ({
  ...(await orig<typeof import('../src/llm.js')>()),
  generate,
  liveClient: () => ({
    live: {
      connect: async (opts: any) => {
        if (live.fail > 0) { live.fail--; throw new Error('つながらない'); }
        const s: FakeSession = {
          opts,
          sendClientContent: vi.fn(),
          sendRealtimeInput: vi.fn(),
          sendToolResponse: vi.fn(),
          close: vi.fn(),
          msg: (m) => opts.callbacks.onmessage(m),
          drop: (code = 1006) => opts.callbacks.onclose({ code, reason: 'test' }),
        };
        live.sessions.push(s);
        return s;
      },
    },
  }),
}));
vi.mock('../src/auth.js', async (orig) => ({ ...(await orig<typeof import('../src/auth.js')>()), userOf: async () => 'u1' }));

const { liveSocket } = await import('../src/live.js');
const { EVIDENCE_LABEL, NOTE_NOW_LABEL, SCREEN_NOW_LABEL } = await import('../src/prompts.js');
const { SUMMARY_NOTICE, summaryThreshold } = await import('../src/summary.js');
const { dbGet, dbList, dbSet, resetDb } = await import('./fakeDb.js');

/** 画面側の偽の WebSocket。sent：サーバーが画面に送ったもの */
class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
  /** 画面からサーバーへ送る */
  post(m: object) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  of(type: string) { return this.sent.filter((m) => m.type === type); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const tick = async () => { for (let i = 0; i < 5; i++) await flush(); };

/** 授業を開いて、Gemini Live につながるまで待つ */
async function open(query = 'session=s1&voice=Kore') {
  const ws = new FakeWs();
  liveSocket().emit('connection', ws, { url: `/api/live?${query}`, headers: {} });
  await tick();
  return { ws, s: live.sessions.at(-1) as FakeSession };
}
/** sendClientContent で送った turns（文字だけにする）と turnComplete */
const turnsOf = (s: FakeSession, i = -1) => {
  const a = s.sendClientContent.mock.calls.at(i)![0];
  return { turns: a.turns.map((t: any) => t.parts), turnComplete: a.turnComplete };
};
const textTurn = (text: string) => [{ text }];

beforeEach(() => {
  resetDb();
  live.sessions.length = 0;
  live.fail = 0;
  generate.mockReset();
  dbSet('users/u1/sessions/s1', { title: '英語', createdAt: 'x', updatedAt: 'x' });
});
afterEach(() => { vi.useRealTimers(); });

describe('つなぐ', () => {
  it('これまでの会話・声・ツールを渡してつなぎ、ready を送る', async () => {
    dbSet('users/u1/sessions/s1/messages/a', { who: 'me', text: '単語を覚えたい', at: 1 });
    dbSet('users/u1/sessions/s1/messages/b', { who: 'tomo', text: 'いいですね', at: 2 });
    const { ws, s } = await open();
    const c = s.opts.config;
    expect(c.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(c.systemInstruction).toContain('生徒：単語を覚えたい\n家トモ：いいですね');
    expect(c.sessionResumption).toEqual({ handle: undefined });
    expect(c.tools[0].functionDeclarations.map((f: any) => f.name)).toEqual(['look_at_screen', 'look_at_note', 'timer', 'pause_study', 'how_to_start', 'what_can_you_do']);
    expect(ws.sent).toEqual([{ type: 'ready' }]);
  });

  it('要約があれば、要約とそれより後の発言だけを渡す', async () => {
    dbSet('users/u1/sessions/s1', { title: '英語', createdAt: 'x', updatedAt: 'x', summary: { text: 'まとめ', upTo: 1 } });
    dbSet('users/u1/sessions/s1/messages/a', { who: 'me', text: '古い発言', at: 1 });
    dbSet('users/u1/sessions/s1/messages/b', { who: 'me', text: '新しい発言', at: 2 });
    const { s } = await open();
    expect(s.opts.config.systemInstruction).toContain('ここまでの会話の要約：\nまとめ');
    expect(s.opts.config.systemInstruction).toContain('新しい発言');
    expect(s.opts.config.systemInstruction).not.toContain('古い発言');
  });

  it('知らない声は Puck、session がなければ会話を読まない', async () => {
    dbSet('users/u1/sessions/s1/messages/a', { who: 'me', text: '前の発言', at: 1 });
    const { s } = await open('voice=Nope');
    expect(s.opts.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(s.opts.config.systemInstruction).not.toContain('前の発言');
  });

  it('つながるまえに届いたメッセージは、つながってから送る（音声は捨てる）', async () => {
    const ws = new FakeWs();
    liveSocket().emit('connection', ws, { url: '/api/live?session=s1', headers: {} });
    ws.post({ type: 'audio', data: 'xx' });
    ws.post({ type: 'say', text: 'こんにちは' });
    await tick();
    const s = live.sessions[0] as FakeSession;
    expect(s.sendRealtimeInput).not.toHaveBeenCalled();
    expect(turnsOf(s).turns.at(-1)[0].text).toContain('「こんにちは」');
  });

  it('つなげなければ error を送って WebSocket を閉じる', async () => {
    live.fail = 1;
    const ws = new FakeWs();
    liveSocket().emit('connection', ws, { url: '/api/live', headers: {} });
    await tick();
    expect(ws.of('error')[0].message).toContain('つながりませんでした');
    expect(ws.readyState).toBe(3);
  });

  it('画面が閉じたら Gemini Live も閉じる', async () => {
    const { ws, s } = await open();
    ws.close();
    expect(s.close).toHaveBeenCalled();
  });
});

describe('画面 → Gemini Live', () => {
  it('audio・audioEnd・text', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'audio', data: 'pcm' });
    ws.post({ type: 'audioEnd' });
    ws.post({ type: 'text', text: 'これ何？' });
    expect(s.sendRealtimeInput.mock.calls.map((c) => c[0])).toEqual([
      { audio: { data: 'pcm', mimeType: 'audio/pcm;rate=16000' } },
      { audioStreamEnd: true },
      { text: 'これ何？' },
    ]);
  });

  it('say はセリフとして読み上げさせ、その書き起こしは scripted', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'say', text: 'こんにちは' });
    const { turns, turnComplete } = turnsOf(s);
    expect(turnComplete).toBe(true);
    expect(turns[0][0].text).toMatch(/^（家トモのセリフ）.*\n「こんにちは」$/s);
    s.msg({ serverContent: { outputTranscription: { text: 'こんにちは' } } });
    expect(ws.of('transcript').at(-1)).toEqual({ type: 'transcript', who: 'tomo', text: 'こんにちは', scripted: true });
    // 生徒が話したら、そのあとの返事はセリフではない
    s.msg({ serverContent: { inputTranscription: { text: 'はい' } } });
    s.msg({ serverContent: { outputTranscription: { text: 'どうぞ' } } });
    expect(ws.of('transcript').slice(-2)).toEqual([
      { type: 'transcript', who: 'student', text: 'はい' },
      { type: 'transcript', who: 'tomo', text: 'どうぞ', scripted: false },
    ]);
  });

  it('困りごとの nudge：根拠の画像つき', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'nudge', text: '手が止まっている', image: 'data:image/jpeg;base64,AAAA', screen: 'data:image/png;base64,BBBB' });
    expect(turnsOf(s).turns).toEqual([[
      { text: '（声かけの合図）手が止まっている' },
      { text: EVIDENCE_LABEL },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      // 困りごとの合図には画面をつけない
    ]]);
  });

  it('興味の nudge：種類・最後のノート・いまの画面つき', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'nudge', text: '集中している', kind: '興味', image: 'data:image/jpeg;base64,AAAA', screen: 'data:image/png;base64,BBBB' });
    expect(turnsOf(s).turns).toEqual([[
      { text: '（声かけの合図・興味）集中している' },
      { text: NOTE_NOW_LABEL },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { text: SCREEN_NOW_LABEL },
      { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
    ]]);
  });

  it('知らない kind は困りごとの合図として扱う', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'nudge', text: 'x', kind: 'ほか' });
    expect(turnsOf(s).turns).toEqual([[{ text: '（声かけの合図）x' }]]);
  });

  it('notice・check', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'notice', text: '10分になりました' });
    expect(turnsOf(s).turns).toEqual([textTurn('（タイマーの知らせ）10分になりました')]);
    ws.post({ type: 'check', text: '30分たちました' });
    expect(turnsOf(s).turns).toEqual([textTurn('（続けるかの確認）30分たちました')]);
  });

  it('context：話していなければ返事をさせずにすぐ送り、同じものは送りなおさない', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'context', context: '画面共有：オフ' });
    expect(turnsOf(s)).toEqual({ turns: [textTurn('（勉強の様子）画面共有：オフ')], turnComplete: false });
    ws.post({ type: 'context', context: '画面共有：オフ' });
    expect(s.sendClientContent).toHaveBeenCalledTimes(1);
  });

  it('context：話しているあいだは待ち、次の合図といっしょか、話し終わってから送る', async () => {
    const { ws, s } = await open();
    s.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'voice' } }] } } });
    ws.post({ type: 'context', context: '画面共有：オン' });
    expect(s.sendClientContent).not.toHaveBeenCalled();
    s.msg({ serverContent: { turnComplete: true } });
    expect(turnsOf(s)).toEqual({ turns: [textTurn('（勉強の様子）画面共有：オン')], turnComplete: false });

    s.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'voice' } }] } } });
    ws.post({ type: 'context', context: '画面共有：オフ' });
    ws.post({ type: 'notice', text: '時間です' });
    expect(turnsOf(s).turns).toEqual([textTurn('（勉強の様子）画面共有：オフ'), textTurn('（タイマーの知らせ）時間です')]);
  });

  it('text のまえに、まだ送っていない context を送る', async () => {
    const { ws, s } = await open();
    s.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'voice' } }] } } });
    ws.post({ type: 'context', context: 'A' });
    ws.post({ type: 'text', text: 'こんにちは' });
    expect(turnsOf(s)).toEqual({ turns: [textTurn('（勉強の様子）A')], turnComplete: false });
    expect(s.sendRealtimeInput).toHaveBeenCalledWith({ text: 'こんにちは' });
  });
});

describe('Gemini Live → 画面', () => {
  it('audio・interrupted・turn・usage', async () => {
    const { ws, s } = await open();
    s.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'voice1' } }] } }, usageMetadata: { totalTokenCount: 1234 } });
    s.msg({ serverContent: { interrupted: true } });
    s.msg({ serverContent: { turnComplete: true } });
    expect(ws.sent.slice(1)).toEqual([
      { type: 'audio', data: 'voice1' },
      { type: 'usage', tokens: 1234, summaryAt: summaryThreshold('live'), compressAt: 115_200, limit: 128_000 },
      { type: 'interrupted' },
      { type: 'turn' },
    ]);
  });
});

describe('ツール', () => {
  const callTool = (s: FakeSession, name: string, args: object = {}, id = 'c1') => s.msg({ toolCall: { functionCalls: [{ id, name, args }] } });

  it('look_at_screen：画面に screenRequest を送り、返ってきた画像をツールの結果に入れる', async () => {
    const { ws, s } = await open();
    callTool(s, 'look_at_screen');
    const req = ws.of('screenRequest')[0];
    expect(req).toEqual({ type: 'screenRequest', id: expect.any(Number) });
    ws.post({ type: 'screen', id: req.id, image: 'data:image/png;base64,SCR' });
    await tick();
    const r = s.sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect(r).toMatchObject({ id: 'c1', name: 'look_at_screen', parts: [{ inlineData: { mimeType: 'image/png', data: 'SCR' } }] });
  });

  it('look_at_note：画像がなければエラーの結果', async () => {
    const { ws, s } = await open();
    callTool(s, 'look_at_note');
    ws.post({ type: 'note', id: ws.of('noteRequest')[0].id, image: null });
    await tick();
    const r = s.sendToolResponse.mock.calls[0][0].functionResponses[0];
    expect(r.response).toHaveProperty('error');
    expect(r).not.toHaveProperty('parts');
  });

  it('画像が5秒届かなければ、ないものとして答える', async () => {
    const { s } = await open();
    vi.useFakeTimers();
    callTool(s, 'look_at_screen');
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await tick();
    expect(s.sendToolResponse.mock.calls[0][0].functionResponses[0].response).toHaveProperty('error');
  });

  it('timer：画面が送った状態を読み、変えたら画面に送る', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'timer', state: { elapsedMs: 60_000, minutes: 10 } });
    callTool(s, 'timer', { action: 'check' });
    await tick();
    expect(s.sendToolResponse.mock.calls[0][0].functionResponses[0].response).toMatchObject({ elapsed: '1分', remaining: '9分' });
    callTool(s, 'timer', { action: 'stop' }, 'c2');
    await tick();
    expect(ws.of('timer')).toEqual([{ type: 'timer', state: null }]);
  });

  it('pause_study：画面に study を送る', async () => {
    const { ws, s } = await open();
    callTool(s, 'pause_study', { action: 'continue' });
    await tick();
    expect(ws.of('study')).toEqual([{ type: 'study', action: 'continue' }]);
  });
});

describe('つなぎ直し', () => {
  it('切れたら、続きのハンドルでつなぎ直す（会話は読みなおさない）', async () => {
    const { ws, s } = await open();
    s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    dbSet('users/u1/sessions/s1/messages/a', { who: 'me', text: 'あとの発言', at: 1 });
    s.drop();
    await tick();
    const s2 = live.sessions[1] as FakeSession;
    expect(s2.opts.config.sessionResumption).toEqual({ handle: 'h1' });
    expect(s2.opts.config.systemInstruction).not.toContain('あとの発言');
    expect(ws.of('ready')).toHaveLength(2);
    // 新しい接続に送る
    ws.post({ type: 'text', text: 'x' });
    expect(s2.sendRealtimeInput).toHaveBeenCalledWith({ text: 'x' });
  });

  it('goAway でもつなぎ直す', async () => {
    const { s } = await open();
    s.msg({ goAway: { timeLeft: '1s' } });
    await tick();
    expect(s.close).toHaveBeenCalled();
    expect(live.sessions).toHaveLength(2);
  });

  it('続けて3回より多く切れたらあきらめて error', async () => {
    const { ws } = await open();
    for (let i = 0; i < 4; i++) { (live.sessions.at(-1) as FakeSession).drop(); await tick(); }
    expect(live.sessions).toHaveLength(4);
    expect(ws.of('error')[0].message).toContain('Gemini Live が切れました');
    expect(ws.readyState).toBe(3);
  });

  it('ハンドルが届いたら数えなおす', async () => {
    const { ws } = await open();
    for (let i = 0; i < 6; i++) {
      const s = live.sessions.at(-1) as FakeSession;
      s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: `h${i}` } });
      s.drop();
      await tick();
    }
    expect(ws.of('error')).toEqual([]);
  });
});

describe('台が替わっても続きからつなぐ（#5）', () => {
  const doc = () => dbGet('users/u1/sessions/s1')!;
  const resume = (over: object = {}) => ({ handle: 'h1', at: Date.now(), model: 'gemini-3.8-live', voice: 'Kore', ...over });
  const withResume = (over: object = {}) => {
    dbSet('users/u1/sessions/s1', { title: '英語', createdAt: 'x', updatedAt: 'x', live: resume(over) });
    dbSet('users/u1/sessions/s1/messages/a', { who: 'me', text: '前の発言', at: 1 });
  };

  it('新しいハンドルを学習の回に保存する', async () => {
    const { s } = await open();
    s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    await tick();
    expect(doc().live).toMatchObject({ handle: 'h1', model: 'gemini-3.8-live', voice: 'Kore' });
  });

  it('保存したハンドルがあれば、そのハンドルで Gemini Live の続きにつなぐ（会話履歴は渡さない）', async () => {
    withResume();
    const { s } = await open();
    expect(s.opts.config.sessionResumption).toEqual({ handle: 'h1' });
    expect(s.opts.config.systemInstruction).not.toContain('前の発言');
  });

  it.each([
    ['2時間より古い', { at: Date.now() - 2 * 60 * 60_000 - 1 }],
    ['声が変わった', { voice: 'Puck' }],
    ['モデルが変わった', { model: 'gemini-old-live' }],
  ])('%sハンドルは使わず、会話履歴を渡す', async (_, over) => {
    withResume(over);
    const { s } = await open();
    expect(s.opts.config.sessionResumption).toEqual({ handle: undefined });
    expect(s.opts.config.systemInstruction).toContain('前の発言');
  });

  it('ハンドルでつなげなければ、ハンドルを捨てて会話履歴でつなぐ', async () => {
    withResume();
    live.fail = 1;
    const { ws, s } = await open();
    expect(s.opts.config.sessionResumption).toEqual({ handle: undefined });
    expect(s.opts.config.systemInstruction).toContain('前の発言');
    expect(ws.of('error')).toEqual([]);
    expect(doc().live).toBeNull();
  });

  it('ハンドルでつないでも切れつづけたら、最後は会話履歴でつなぐ', async () => {
    withResume();
    await open();
    for (let i = 0; i < 3; i++) { (live.sessions.at(-1) as FakeSession).drop(); await tick(); }
    expect(live.sessions.map((x: FakeSession) => x.opts.config.sessionResumption.handle)).toEqual(['h1', 'h1', 'h1', undefined]);
    expect(doc().live).toBeNull();
  });

  it('要約したら、保存したハンドルも使わないことにする', async () => {
    const { s } = await open();
    for (let at = 1; at <= 12; at++) dbSet(`users/u1/sessions/s1/messages/m${at}`, { who: 'me', text: `発言${at}`, at });
    generate.mockResolvedValueOnce({ text: 'まとめ', usage: { prompt: 1, output: 1, thoughts: 0, total: 2 }, ms: 1, model: 'gemini-3.8-flash', config: {} });
    s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    s.msg({ usageMetadata: { totalTokenCount: summaryThreshold('live') + 1 } });
    s.msg({ serverContent: { turnComplete: true } });
    await tick();
    expect(doc().live).toBeNull();
  });

  it('学習の回がなければ保存しない', async () => {
    const { s } = await open('voice=Kore');
    s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    await tick();
    expect(doc().live).toBeUndefined();
  });
});

describe('要約', () => {
  const over = () => summaryThreshold('live') + 1;
  const addMsgs = (n: number) => { for (let at = 1; at <= n; at++) dbSet(`users/u1/sessions/s1/messages/m${at}`, { who: 'me', text: `発言${at}`, at }); };

  it('しきい値をこえたら、お知らせを言わせてから要約し、要約を渡して新しいセッションにつなぐ', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'context', context: '画面共有：オフ' });
    addMsgs(12);
    generate.mockResolvedValueOnce({ text: 'まとめ', usage: { prompt: 1, output: 1, thoughts: 0, total: 2 }, ms: 1, model: 'gemini-3.8-flash', config: {} });
    s.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
    s.msg({ usageMetadata: { totalTokenCount: over() } });
    expect(ws.of('summary')).toEqual([{ type: 'summary', text: SUMMARY_NOTICE }]);
    expect(turnsOf(s).turns.at(-1)[0].text).toContain(`「${SUMMARY_NOTICE}」`);
    // お知らせを言い終わったら要約する
    s.msg({ serverContent: { turnComplete: true } });
    await tick();
    expect(dbGet('users/u1/sessions/s1')!.summary).toEqual({ text: 'まとめ', upTo: 2 });
    expect(s.close).toHaveBeenCalled();
    const s2 = live.sessions[1] as FakeSession;
    expect(s2.opts.config.sessionResumption).toEqual({ handle: undefined }); // ハンドルは使わない
    expect(s2.opts.config.systemInstruction).toContain('ここまでの会話の要約：\nまとめ');
    expect(s2.opts.config.systemInstruction).toContain('発言3');
    // いまの勉強の様子は、次に送るものといっしょに知らせなおす
    expect(s2.sendClientContent).not.toHaveBeenCalled();
    ws.post({ type: 'notice', text: '時間です' });
    expect(turnsOf(s2).turns).toEqual([textTurn('（勉強の様子）画面共有：オフ'), textTurn('（タイマーの知らせ）時間です')]);
  });

  it('話している途中なら、話し終わってからお知らせを言う', async () => {
    const { ws, s } = await open();
    s.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'v' } }] } }, usageMetadata: { totalTokenCount: over() } });
    expect(ws.of('summary')).toEqual([]);
    s.msg({ serverContent: { turnComplete: true } });
    expect(ws.of('summary')).toHaveLength(1);
  });

  it('要約に失敗したら、つなぎ直さず2分はためさない', async () => {
    const { ws, s } = await open();
    addMsgs(12);
    generate.mockRejectedValueOnce(new Error('boom'));
    s.msg({ usageMetadata: { totalTokenCount: over() } });
    s.msg({ serverContent: { turnComplete: true } });
    await tick();
    expect(live.sessions).toHaveLength(1);
    s.msg({ usageMetadata: { totalTokenCount: over() } });
    expect(ws.of('summary')).toHaveLength(1);
  });
});

describe('会話を保存する（#3）', () => {
  const saved = () => dbList('users/u1/sessions/s1/messages').sort((a: any, b: any) => a.at - b.at).map(({ who, text }: any) => ({ who, text }));
  const sc = (s: FakeSession, c: object) => s.msg({ serverContent: c });

  it('生徒の声は家トモが返事を始めたら、家トモの声は話し終わったら保存する（セリフの印は外す）', async () => {
    const { s } = await open();
    sc(s, { inputTranscription: { text: 'これ' } });
    sc(s, { inputTranscription: { text: '何？' } });
    await tick();
    expect(saved()).toEqual([]);
    sc(s, { outputTranscription: { text: '（家トモのセリフ）「それは' } });
    await tick();
    expect(saved()).toEqual([{ who: 'me', text: 'これ何？' }]);
    sc(s, { outputTranscription: { text: 'りんごです」' } });
    sc(s, { turnComplete: true });
    await tick();
    expect(saved()).toEqual([{ who: 'me', text: 'これ何？' }, { who: 'tomo', text: 'それはりんごです' }]);
  });

  it('生徒が文字で話しかけたら保存する', async () => {
    const { ws } = await open();
    ws.post({ type: 'text', text: ' 単語を覚えたい ' });
    await tick();
    expect(saved()).toEqual([{ who: 'me', text: '単語を覚えたい' }]);
  });

  it('セリフ（say）は保存しない', async () => {
    const { ws, s } = await open();
    ws.post({ type: 'say', text: 'こんにちは' });
    sc(s, { outputTranscription: { text: 'こんにちは' } });
    sc(s, { turnComplete: true });
    await tick();
    expect(saved()).toEqual([]);
  });

  it('interrupted・画面が閉じたときも、そこまでの発言を保存する', async () => {
    const { ws, s } = await open();
    sc(s, { outputTranscription: { text: 'えっと' } });
    sc(s, { interrupted: true });
    sc(s, { inputTranscription: { text: 'ちょっと待って' } });
    ws.close();
    await tick();
    expect(saved()).toEqual([{ who: 'tomo', text: 'えっと' }, { who: 'me', text: 'ちょっと待って' }]);
  });

  it('session がなければ保存しない', async () => {
    const { ws, s } = await open('voice=Kore');
    ws.post({ type: 'text', text: 'こんにちは' });
    sc(s, { outputTranscription: { text: 'やあ' } });
    sc(s, { turnComplete: true });
    await tick();
    expect(saved()).toEqual([]);
  });
});
