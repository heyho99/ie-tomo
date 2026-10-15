import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveTomo } from '../src/live';
import { FakeWebSocket, installBrowserFakes } from './fakes';

// 会話モードの画面側（live.ts の useLiveTomo）。サーバー（/api/live）との WebSocket のやりとり
// TomoChannel にまとめる（#2）ときに、送るもの・受けたときの動きが変わらないことを確かめる

beforeEach(installBrowserFakes);

function setup(over: Partial<Parameters<typeof useLiveTomo>[0]> = {}) {
  const cb = {
    onStudent: vi.fn(), onTomo: vi.fn(), onTimer: vi.fn(), onStudy: vi.fn(), onSummary: vi.fn(), onUsage: vi.fn(),
    captureScreen: vi.fn(() => 'data:image/png;base64,SCR'),
    captureNote: vi.fn(() => null),
    timerNow: vi.fn(() => ({ elapsedMs: 1000, minutes: 10 })),
  };
  const props = { enabled: true, sessionId: 's 1', micOn: false, voiceOn: true, micId: '', voice: 'Kore', ...cb, ...over };
  const h = renderHook((p: typeof props) => useLiveTomo(p), { initialProps: props });
  return { ...h, cb, props };
}

describe('つなぐ', () => {
  it('enabled でなければつながない', () => {
    const { result } = setup({ enabled: false });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.status).toBe('off');
  });

  it('トークン・学習の回・声を URL につけてつなぐ', () => {
    const { result } = setup();
    expect(FakeWebSocket.last().url).toMatch(/\/api\/live\?token=test&session=s%201&voice=Kore$/);
    expect(result.current.status).toBe('connecting');
  });

  it('つながったら、まず計っている時間を送り、つながるまえに送ろうとしたものを送る', () => {
    const { result } = setup();
    act(() => { result.current.say('こんにちは'); result.current.nudge('手が止まっている', 'data:image/jpeg;base64,A'); });
    const ws = FakeWebSocket.last();
    act(() => ws.open());
    expect(ws.sent).toEqual([
      { type: 'timer', state: { elapsedMs: 1000, minutes: 10 } },
      { type: 'say', text: 'こんにちは' },
      { type: 'nudge', text: '手が止まっている', image: 'data:image/jpeg;base64,A' },
    ]);
  });

  it('ready で status が ready', () => {
    const { result } = setup();
    act(() => { FakeWebSocket.last().open(); FakeWebSocket.last().receive({ type: 'ready' }); });
    expect(result.current.status).toBe('ready');
  });

  it('声を変えたらつなぎ直す', () => {
    const { rerender, props } = setup();
    rerender({ ...props, voice: 'Puck' });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].readyState).toBe(3);
    expect(FakeWebSocket.last().url).toContain('voice=Puck');
  });

  it('enabled でなくなったら閉じて off', () => {
    const { result, rerender, props } = setup();
    rerender({ ...props, enabled: false });
    expect(FakeWebSocket.instances[0].readyState).toBe(3);
    expect(result.current.status).toBe('off');
  });
});

describe('送る', () => {
  it('どの送り方も、つながっていればそのまま送る', () => {
    const { result } = setup();
    const ws = FakeWebSocket.last();
    act(() => ws.open());
    ws.sent = [];
    act(() => {
      result.current.say('');  // 空のセリフは送らない
      result.current.text('これ何？');
      result.current.nudge('集中', 'img', '興味', 'scr');
      result.current.context('画面共有：オフ');
      result.current.timer(null);
      result.current.notice('時間です');
      result.current.check('続けますか');
    });
    expect(ws.sent).toEqual([
      { type: 'text', text: 'これ何？' },
      { type: 'nudge', text: '集中', image: 'img', kind: '興味', screen: 'scr' },
      { type: 'context', context: '画面共有：オフ' },
      { type: 'timer', state: null },
      { type: 'notice', text: '時間です' },
      { type: 'check', text: '続けますか' },
    ]);
  });
});

describe('受ける', () => {
  function ready() {
    const h = setup();
    const ws = FakeWebSocket.last();
    act(() => { ws.open(); ws.receive({ type: 'ready' }); });
    ws.sent = [];
    return { ...h, ws };
  }

  it('書き起こし：生徒は家トモが返事を始めたら、家トモは話し終わったら1回知らせる', () => {
    const { result, ws, cb } = ready();
    act(() => { ws.receive({ type: 'transcript', who: 'student', text: 'これ' }); ws.receive({ type: 'transcript', who: 'student', text: '何？' }); });
    expect(result.current.draft.student).toBe('これ何？');
    expect(cb.onStudent).not.toHaveBeenCalled();
    act(() => ws.receive({ type: 'transcript', who: 'tomo', text: '（家トモのセリフ）「それは' }));
    expect(cb.onStudent).toHaveBeenCalledWith('これ何？');
    act(() => ws.receive({ type: 'transcript', who: 'tomo', text: 'りんごです」' }));
    expect(result.current.draft.tomo).toBe('それはりんごです');
    act(() => ws.receive({ type: 'turn' }));
    expect(cb.onTomo).toHaveBeenCalledWith('それはりんごです'); // セリフの印は外す
    expect(result.current.draft).toEqual({ student: '', tomo: '' });
  });

  it('セリフ（scripted）の書き起こしは onTomo に来ない', () => {
    const { ws, cb } = ready();
    act(() => { ws.receive({ type: 'transcript', who: 'tomo', text: 'こんにちは', scripted: true }); ws.receive({ type: 'turn' }); });
    expect(cb.onTomo).not.toHaveBeenCalled();
  });

  it('interrupted：そこまでの家トモの発言を知らせる', () => {
    const { ws, cb } = ready();
    act(() => { ws.receive({ type: 'transcript', who: 'tomo', text: 'えっと' }); ws.receive({ type: 'interrupted' }); });
    expect(cb.onTomo).toHaveBeenCalledWith('えっと');
  });

  it('screenRequest・noteRequest に画像で返事をする（なければ null）', () => {
    const { ws, cb } = ready();
    act(() => { ws.receive({ type: 'screenRequest', id: 3 }); ws.receive({ type: 'noteRequest', id: 4 }); });
    expect(cb.captureScreen).toHaveBeenCalled();
    expect(ws.sent).toEqual([{ type: 'screen', id: 3, image: 'data:image/png;base64,SCR' }, { type: 'note', id: 4, image: null }]);
  });

  it('timer・study・summary・usage をそれぞれ知らせる', () => {
    const { ws, cb } = ready();
    act(() => {
      ws.receive({ type: 'timer', state: { elapsedMs: 0, minutes: 5 } });
      ws.receive({ type: 'study', action: 'pause' });
      ws.receive({ type: 'summary', text: 'まとめます' });
      ws.receive({ type: 'usage', tokens: 10, summaryAt: 80, compressAt: 90, limit: 100 });
    });
    expect(cb.onTimer).toHaveBeenCalledWith({ elapsedMs: 0, minutes: 5 });
    expect(cb.onStudy).toHaveBeenCalledWith('pause');
    expect(cb.onSummary).toHaveBeenCalledWith('まとめます');
    expect(cb.onUsage).toHaveBeenCalledWith({ tokens: 10, summaryAt: 80, compressAt: 90, limit: 100 });
  });

  it('error で status が error になり、メッセージを出す', () => {
    const { result, ws } = ready();
    act(() => ws.receive({ type: 'error', message: 'つながりません' }));
    expect(result.current).toMatchObject({ status: 'error', error: 'つながりません' });
  });
});

describe('切れたとき', () => {
  beforeEach(() => { vi.useFakeTimers(); return () => vi.useRealTimers(); });

  it('予期せず切れたら、待つ時間をのばしながら自動でつなぎ直す', () => {
    const { result } = setup();
    act(() => { FakeWebSocket.last().open(); FakeWebSocket.last().receive({ type: 'ready' }); FakeWebSocket.last().drop(); });
    expect(result.current.status).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.last().drop()); // つながらずに切れた
    act(() => vi.advanceTimersByTime(1999));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('つながったら待つ時間はもとに戻る', () => {
    setup();
    act(() => { FakeWebSocket.last().drop(); vi.advanceTimersByTime(1000); });
    act(() => { FakeWebSocket.last().open(); FakeWebSocket.last().receive({ type: 'ready' }); FakeWebSocket.last().drop(); });
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('つなぎ直すあいだに送ろうとしたものは、つながってから送る', () => {
    const { result } = setup();
    act(() => { FakeWebSocket.last().open(); result.current.context('画面共有：オン'); FakeWebSocket.last().drop(); });
    act(() => { result.current.nudge('手が止まっている'); vi.advanceTimersByTime(1000); });
    const ws2 = FakeWebSocket.last();
    act(() => ws2.open());
    expect(ws2.sent).toEqual([
      { type: 'timer', state: { elapsedMs: 1000, minutes: 10 } },
      { type: 'context', context: '画面共有：オン' },
      { type: 'nudge', text: '手が止まっている' },
    ]);
  });

  it('5回続けてつなげなければ、あきらめて error にする', () => {
    const { result } = setup();
    for (let i = 0; i < 5; i++) act(() => { FakeWebSocket.last().drop(); vi.advanceTimersByTime(30_000); });
    act(() => FakeWebSocket.last().drop());
    expect(result.current).toMatchObject({ status: 'error', error: 'Gemini Live との接続が切れました' });
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it('サーバーが error を送ってきたら、自動ではつなぎ直さない', () => {
    const { result } = setup();
    act(() => { FakeWebSocket.last().open(); FakeWebSocket.last().receive({ type: 'error', message: '設定がありません' }); FakeWebSocket.last().drop(); });
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(result.current).toMatchObject({ status: 'error', error: '設定がありません' });
  });

  it('reconnect でつなぎ直し、最後の勉強の様子を送りなおす', () => {
    const { result } = setup();
    const ws = FakeWebSocket.last();
    act(() => { ws.open(); result.current.context('画面共有：オン'); ws.receive({ type: 'error', message: 'x' }); ws.drop(); });
    act(() => result.current.reconnect());
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.last();
    expect(result.current.status).toBe('connecting');
    act(() => { result.current.say('続けましょう'); ws2.open(); });
    expect(ws2.sent).toEqual([
      { type: 'timer', state: { elapsedMs: 1000, minutes: 10 } },
      { type: 'context', context: '画面共有：オン' },
      { type: 'say', text: '続けましょう' },
    ]);
  });
});
