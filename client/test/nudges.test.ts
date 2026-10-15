import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NudgeRules } from '../src/api';
import { useContinueCheck } from '../src/continueCheck';
import { useInterestNudge, type InterestSnapshot } from '../src/interestNudge';
import { useNoteNudge, type NoteState } from '../src/noteReader';

// 合図のルール（いつ合図を出すか）。合図の調停を useNudgeHub に切り出す（#1）・純粋関数にする（#7）ときに、
// 出すタイミングが変わらないことを確かめる。時間は偽の時計で進める

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const SEC = 1000, MIN = 60 * SEC;
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('続けるかの確認（useContinueCheck）', () => {
  function setup(over: Partial<Parameters<typeof useContinueCheck>[0]> = {}) {
    const props = { running: true, quiet: false, ask: vi.fn(), timeout: vi.fn(), ...over };
    return { ...renderHook((p: typeof props) => useContinueCheck(p), { initialProps: props }), props };
  }

  it('27分でたずね、3分返事がなければ timeout', () => {
    const { props, result } = setup();
    advance(27 * MIN - SEC);
    expect(props.ask).not.toHaveBeenCalled();
    advance(SEC);
    expect(props.ask).toHaveBeenCalledWith(27 * MIN);
    expect(result.current.peek()).toMatchObject({ asked: true });
    advance(3 * MIN - SEC);
    expect(props.timeout).not.toHaveBeenCalled();
    advance(SEC);
    expect(props.timeout).toHaveBeenCalledTimes(1);
    // timeout のあとは、はじめから数えなおす
    expect(result.current.peek()).toMatchObject({ asked: false });
  });

  it('続けると答えたら30分のびる', () => {
    const { props, result } = setup();
    advance(27 * MIN);
    act(() => result.current.continued());
    advance(10 * MIN);
    expect(props.timeout).not.toHaveBeenCalled();
    expect(props.ask).toHaveBeenCalledTimes(1);
    advance(20 * MIN);
    expect(props.ask).toHaveBeenCalledTimes(2); // 57分
    expect(props.ask).toHaveBeenLastCalledWith(57 * MIN);
  });

  it('たずねるまえの continued では、のびない', () => {
    const { props, result } = setup();
    act(() => result.current.continued());
    advance(27 * MIN);
    expect(props.ask).toHaveBeenCalledWith(27 * MIN);
  });

  it('quiet のあいだはたずねない・一時中断しない', () => {
    const { props, rerender } = setup({ quiet: true });
    advance(40 * MIN);
    expect(props.ask).not.toHaveBeenCalled();
    rerender({ ...props, quiet: false });
    advance(SEC);
    expect(props.ask).toHaveBeenCalled();
  });

  it('running でなくなったら、はじめから数えなおす', () => {
    const { props, rerender, result } = setup();
    advance(20 * MIN);
    rerender({ ...props, running: false });
    expect(result.current.peek()).toBeNull();
    rerender({ ...props, running: true });
    advance(20 * MIN);
    expect(props.ask).not.toHaveBeenCalled();
  });

  it('snapshot から続けられる（リロード）', () => {
    const since = Date.now() - 26 * MIN;
    const { props, result } = setup({ restore: { since, limit: 30 * MIN, askedAt: null } });
    expect(result.current.snapshot()).toEqual({ since, limit: 30 * MIN, askedAt: null });
    advance(MIN);
    expect(props.ask).toHaveBeenCalled();
  });

  it('peek：一時中断する時刻とたずねる時刻', () => {
    const { result } = setup();
    const now = Date.now();
    expect(result.current.peek()).toEqual({ since: now, pauseAt: now + 30 * MIN, askAt: now + 27 * MIN, asked: false });
  });
});

describe('興味・節目・回復の合図（useInterestNudge）', () => {
  const rules = (over: Partial<NudgeRules['interest']> = {}): NudgeRules['interest'] => ({
    quiet: { on: false, minSec: 60, maxSec: 60 },
    milestone: { on: false, everyMin: 15 },
    recovered: { on: false, cooldownSec: 60 },
    ...over,
  });
  function setup(over: Partial<Parameters<typeof useInterestNudge>[0]> = {}) {
    const props = { rules: rules(), running: true, quiet: false, nudge: vi.fn(), ...over };
    const h = renderHook((p: typeof props) => useInterestNudge(p), { initialProps: props });
    advance(5 * SEC); // 最初の tick（時間を数えはじめる）
    return { ...h, props };
  }

  it('rules がない・running でなければ何もしない', () => {
    const { props } = setup({ rules: null });
    advance(60 * MIN);
    expect(props.nudge).not.toHaveBeenCalled();
  });

  it('興味：話していない時間が N 秒をこえたら出す。話したら数えなおす', () => {
    const { props, result } = setup({ rules: rules({ quiet: { on: true, minSec: 60, maxSec: 60 } }) });
    advance(55 * SEC);
    expect(props.nudge).not.toHaveBeenCalled();
    act(() => result.current.talked('tomo'));
    advance(55 * SEC);
    expect(props.nudge).not.toHaveBeenCalled();
    advance(10 * SEC);
    expect(props.nudge).toHaveBeenCalledWith({ kind: '興味', elapsedMin: 2, quietMin: 1 });
  });

  it('興味：返事がなければ次の N を長く、生徒が返事をしたら短くする', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // N = minSec × factor
    const { props, result } = setup({ rules: rules({ quiet: { on: true, minSec: 60, maxSec: 1000 } }) });
    advance(60 * SEC);
    expect(props.nudge).toHaveBeenCalledTimes(1);
    act(() => result.current.talked('tomo')); // 家トモが声をかけた
    advance(60 * SEC);
    expect(props.nudge).toHaveBeenCalledTimes(2); // 返事がないまま次の合図 → factor 1.5
    act(() => result.current.talked('tomo'));
    expect(result.current.snapshot()).toMatchObject({ factor: 1.5, awaiting: true });
    act(() => result.current.talked('me')); // 生徒が返事をした
    expect(result.current.snapshot()).toMatchObject({ factor: expect.closeTo(1.2), awaiting: false });
  });

  it('節目：everyMin 分ごとに出す', () => {
    const { props } = setup({ rules: rules({ milestone: { on: true, everyMin: 15 } }) });
    advance(15 * MIN);
    expect(props.nudge).toHaveBeenCalledTimes(1);
    expect(props.nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: '節目', milestoneMin: 15 }));
    advance(15 * MIN);
    expect(props.nudge).toHaveBeenLastCalledWith(expect.objectContaining({ kind: '節目', milestoneMin: 30 }));
  });

  it('節目：quiet のあいだは待ち、3分のうちに出せなければ捨てる', () => {
    const { props, rerender } = setup({ rules: rules({ milestone: { on: true, everyMin: 15 } }) });
    rerender({ ...props, quiet: true });
    advance(19 * MIN);
    rerender({ ...props, quiet: false });
    advance(5 * SEC);
    expect(props.nudge).not.toHaveBeenCalled();
  });

  it('回復：節目と重なったら回復だけを出し、節目は捨てる', () => {
    const { props, result } = setup({ rules: rules({ recovered: { on: true, cooldownSec: 0 }, milestone: { on: true, everyMin: 1 } }) });
    advance(55 * SEC);
    act(() => result.current.recovered('stuck'));
    advance(5 * SEC); // 1分の節目と回復が同時
    expect(props.nudge).toHaveBeenCalledTimes(1);
    expect(props.nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: '回復', from: 'stuck' }));
    advance(55 * SEC);
    expect(props.nudge).toHaveBeenCalledTimes(1);
  });

  it('回復：ほかの合図のあとクールタイムのあいだは出さず、あとで出す', () => {
    const { props, result } = setup({ rules: rules({ recovered: { on: true, cooldownSec: 60 } }) });
    act(() => { result.current.cued(); result.current.recovered('down'); });
    advance(55 * SEC);
    expect(props.nudge).not.toHaveBeenCalled();
    advance(10 * SEC);
    expect(props.nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: '回復', from: 'down' }));
  });

  it('回復：3分のうちに出せなければ捨てる', () => {
    const { props, result } = setup({ rules: rules({ recovered: { on: true, cooldownSec: 600 } }) });
    act(() => { result.current.cued(); result.current.recovered('sleepy'); });
    advance(11 * MIN);
    expect(props.nudge).not.toHaveBeenCalled();
  });

  it('一時中断（running でない）のあいだは時間を数えない', () => {
    const { props, rerender } = setup({ rules: rules({ milestone: { on: true, everyMin: 15 } }) });
    advance(10 * MIN);
    rerender({ ...props, running: false });
    advance(30 * MIN);
    rerender({ ...props, running: true });
    advance(4 * MIN);
    expect(props.nudge).not.toHaveBeenCalled();
    advance(MIN + 5 * SEC);
    expect(props.nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: '節目', milestoneMin: 15 }));
  });

  it('snapshot から続けられる（リロード）', () => {
    const restore: InterestSnapshot = { elapsed: 14 * MIN, quiet: 0, lastCue: 0, milestones: 0, n: 0, factor: 1, awaiting: false };
    const { props } = setup({ rules: rules({ milestone: { on: true, everyMin: 15 } }), restore });
    advance(MIN);
    expect(props.nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: '節目', milestoneMin: 15 }));
  });
});

describe('ノートの様子の合図（useNoteNudge）', () => {
  const counts = { unreadable: 2, stuck: 3 };
  let at = 0;
  const reading = (r: Partial<NoteState>): NoteState => ({ observation: '', readable: true, unreadableReason: '', progress: 'working', ms: 0, model: '', config: {} as never, usage: {} as never, at: ++at, image: `img${at}`, ...r });

  function setup(quiet = false) {
    const nudge = vi.fn();
    const h = renderHook(({ r, q }: { r: NoteState | null; q: boolean }) => useNoteNudge(r, q, counts, nudge), { initialProps: { r: null as NoteState | null, q: quiet } });
    return { nudge, feed: (r: NoteState, q = quiet) => h.rerender({ r, q }) };
  }

  it('stuck が3回続いたら出し、数えなおす', () => {
    const { nudge, feed } = setup();
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'stuck' }));
    expect(nudge).not.toHaveBeenCalled();
    feed(reading({ progress: 'stuck' }));
    expect(nudge).toHaveBeenCalledWith({ kind: 'stuck', count: 3, reason: '', image: `img${at}` });
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'stuck' }));
    expect(nudge).toHaveBeenCalledTimes(1);
    feed(reading({ progress: 'stuck' }));
    expect(nudge).toHaveBeenCalledTimes(2);
  });

  it('読み取れないが2回続いたら、理由つきで出す', () => {
    const { nudge, feed } = setup();
    feed(reading({ readable: false, unreadableReason: '暗い' }));
    feed(reading({ readable: false, unreadableReason: '手でかくれている' }));
    expect(nudge).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreadable', count: 2, reason: '手でかくれている' }));
  });

  it('working で切れ、unknown は数えず切りもしない', () => {
    const { nudge, feed } = setup();
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'unknown' }));
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'working' }));
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'stuck' }));
    expect(nudge).not.toHaveBeenCalled();
    feed(reading({ progress: 'stuck' }));
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('quiet のあいだの判定は数えない', () => {
    const { nudge, feed } = setup();
    feed(reading({ progress: 'stuck' }));
    feed(reading({ progress: 'stuck' }), true);
    feed(reading({ progress: 'stuck' }));
    expect(nudge).not.toHaveBeenCalled();
  });
});
