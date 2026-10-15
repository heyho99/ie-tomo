import { describe, expect, it } from 'vitest';
import type { NudgeRules } from '../src/api';
import { continueAnswered, continuePeek, continueStart, continueTick, type ContinueCount } from '../src/continueCheck';
import { interestSnapshot, interestStart, interestTalked, interestTick, type InterestCount } from '../src/interestNudge';
import { noteStep, type NoteState, type NoteStreak } from '../src/noteReader';

// 合図のルールの判定（純粋関数。#7）。「数え具合＋時刻 → 次の数え具合と合図」を、フック・偽の時計なしで確かめる
// フックごと時間を進めて確かめるのは nudges.test.ts

const SEC = 1000, MIN = 60 * SEC;
const T0 = Date.parse('2026-10-14T10:00:00Z');

describe('続けるかの確認（continueTick）', () => {
  const t = { interval: 30 * 60, warn: 3 * 60 };
  const at = (v: ContinueCount, ms: number, quiet = false) => continueTick(v, T0 + ms, quiet, t);

  it('数えていなければ何もしない', () => {
    expect(at(continueStart(null, t), 60 * MIN)).toEqual({ next: continueStart(null, t), cue: null });
  });

  it('interval − warn でたずね、そこから warn たったら timeout して now から数えなおす', () => {
    const v = continueStart(T0, t);
    expect(at(v, 27 * MIN - 1).cue).toBeNull();
    const asked = at(v, 27 * MIN);
    expect(asked.cue).toEqual({ kind: 'ask', elapsed: 27 * MIN });
    expect(at(asked.next, 30 * MIN - 1).cue).toBeNull();
    expect(at(asked.next, 30 * MIN)).toEqual({ next: continueStart(T0 + 30 * MIN, t), cue: { kind: 'timeout' } });
  });

  it('話しているあいだ待ってからたずねたら、たずねた時刻から warn 待つ', () => {
    const v = continueStart(T0, t);
    expect(at(v, 40 * MIN, true).cue).toBeNull();
    const asked = at(v, 40 * MIN);
    expect(asked.cue).toEqual({ kind: 'ask', elapsed: 40 * MIN });
    expect(continuePeek(asked.next, t)).toEqual({ since: T0, pauseAt: T0 + 43 * MIN, askAt: T0 + 40 * MIN, asked: true });
    expect(at(asked.next, 43 * MIN).cue).toEqual({ kind: 'timeout' });
  });

  it('続けると答えたら interval のびる。たずねるまえの答えでは、のびない', () => {
    const v = continueStart(T0, t);
    expect(continueAnswered(v, t)).toBe(v);
    const longer = continueAnswered(at(v, 27 * MIN).next, t);
    expect(longer).toEqual({ since: T0, limit: 60 * MIN, askedAt: null });
    expect(at(longer, 57 * MIN).cue).toEqual({ kind: 'ask', elapsed: 57 * MIN });
  });

  it('もとの数え具合は変えない', () => {
    const v = continueStart(T0, t);
    at(v, 27 * MIN);
    expect(v.askedAt).toBeNull();
  });
});

describe('興味・節目・回復の合図（interestTick）', () => {
  const rules = (over: Partial<NudgeRules['interest']> = {}): NudgeRules['interest'] => ({
    quiet: { on: false, minSec: 60, maxSec: 60 },
    milestone: { on: false, everyMin: 15 },
    recovered: { on: false, cooldownSec: 60 },
    ...over,
  });
  /** start から 5 秒ごとに until まで進め、出た合図を返す */
  function run(v: InterestCount, r: NudgeRules['interest'] | null, until: number, o: { quiet?: boolean; running?: boolean; from?: number } = {}) {
    const cues = [];
    for (let ms = o.from ?? 0; ms <= until; ms += 5 * SEC) {
      const s = interestTick(v, T0 + ms, { rules: r, running: o.running ?? true, quiet: o.quiet ?? false }, () => 0);
      v = s.next;
      if (s.cue) cues.push({ at: ms, ...s.cue });
    }
    return { v, cues };
  }

  it('最初の tick では時間を数えない', () => {
    const { next } = interestTick(interestStart(), T0, { rules: rules(), running: true, quiet: false });
    expect(next).toMatchObject({ lastTick: T0, elapsed: 0 });
  });

  it('rules がない・running でなければ、時間も数えない', () => {
    expect(run(interestStart(), null, 60 * MIN).v.elapsed).toBe(0);
    expect(run(interestStart(), rules(), 60 * MIN, { running: false }).v.elapsed).toBe(0);
  });

  it('興味：話していない時間が N 秒をこえたら出し、N を決めなおす', () => {
    const { cues, v } = run(interestStart(), rules({ quiet: { on: true, minSec: 60, maxSec: 60 } }), 60 * SEC);
    expect(cues).toEqual([{ at: 60 * SEC, kind: '興味', elapsedMin: 1, quietMin: 1 }]);
    expect(v).toMatchObject({ n: 0, awaiting: true, lastCue: T0 + 60 * SEC });
  });

  it('興味：N は minSec〜maxSec を factor 倍し、maxSec の2倍までにする', () => {
    const r = rules({ quiet: { on: true, minSec: 60, maxSec: 100 } });
    const tick = (factor: number, random: number) => interestTick({ ...interestStart(), lastTick: T0, factor }, T0 + 5 * SEC, { rules: r, running: true, quiet: false }, () => random).next.n;
    expect(tick(1, 0.5)).toBe(80);
    expect(tick(0.25, 0)).toBe(60); // minSec より短くしない
    expect(tick(4, 1)).toBe(200); // maxSec の2倍まで
  });

  it('興味：返事がないまま次の合図になったら factor 1.5 倍、生徒が返事をしたら 0.8 倍', () => {
    const awaiting = { ...interestStart(), awaiting: true, factor: 2 };
    const { v } = run(awaiting, rules({ quiet: { on: true, minSec: 60, maxSec: 60 } }), 2 * MIN);
    expect(v.factor).toBe(3);
    expect(interestTalked(v, 'me')).toMatchObject({ quiet: 0, awaiting: false, factor: expect.closeTo(2.4), n: 0 });
    expect(interestTalked(v, 'tomo')).toMatchObject({ quiet: 0, awaiting: true, factor: 3 });
    expect(interestTalked({ ...v, factor: 0.3 }, 'me').factor).toBe(0.25);
    expect(run({ ...awaiting, factor: 3 }, rules({ quiet: { on: true, minSec: 60, maxSec: 60 } }), 2 * MIN).v.factor).toBe(4);
  });

  it('節目：everyMin 分ごとに出す。オフでも節目の数は進める（オンにしたとき古い節目を出さない）', () => {
    const r = rules({ milestone: { on: true, everyMin: 15 } });
    expect(run(interestStart(), r, 31 * MIN).cues.map((c) => [c.at, c.milestoneMin])).toEqual([[15 * MIN, 15], [30 * MIN, 30]]);
    const off = run(interestStart(), rules(), 31 * MIN);
    expect(off).toMatchObject({ cues: [], v: { milestones: 2, milestone: null } });
  });

  it('節目・回復：quiet のあいだは待ち、3分のうちに出せなければ捨てる', () => {
    const r = rules({ milestone: { on: true, everyMin: 15 }, recovered: { on: true, cooldownSec: 0 } });
    const quiet = run({ ...interestStart(), recovered: { from: 'down', at: T0 + 15 * MIN } }, r, 18 * MIN, { quiet: true });
    expect(quiet.cues).toEqual([]);
    expect(quiet.v).toMatchObject({ milestone: { min: 15, at: T0 + 15 * MIN }, recovered: { from: 'down' } }); // 3分ちょうどまでは残す
    const late = run(quiet.v, r, 18 * MIN + 5 * SEC, { from: 18 * MIN + 5 * SEC });
    expect(late).toMatchObject({ cues: [], v: { milestone: null, recovered: null } });
  });

  it('回復 ＞ 節目 ＞ 興味。回復を出したら節目は捨てる', () => {
    const r = rules({ quiet: { on: true, minSec: 60, maxSec: 60 }, milestone: { on: true, everyMin: 1 }, recovered: { on: true, cooldownSec: 0 } });
    const v = { ...interestStart(), lastTick: T0, recovered: { from: 'stuck' as const, at: T0 } };
    const s = interestTick(v, T0 + 60 * SEC, { rules: r, running: true, quiet: false });
    expect(s.cue).toMatchObject({ kind: '回復', from: 'stuck' });
    expect(s.next).toMatchObject({ recovered: null, milestone: null, awaiting: false });
    const m = interestTick({ ...v, recovered: null }, T0 + 60 * SEC, { rules: r, running: true, quiet: false });
    expect(m.cue).toMatchObject({ kind: '節目', milestoneMin: 1 });
  });

  it('回復：ほかの合図から cooldownSec のあいだは出さず、残しておく。オフなら出さない', () => {
    const v = { ...interestStart(), lastTick: T0, lastCue: T0, recovered: { from: 'sleepy' as const, at: T0 } };
    const tick = (ms: number, on = true) => interestTick(v, T0 + ms, { rules: rules({ recovered: { on, cooldownSec: 60 } }), running: true, quiet: false });
    expect(tick(59 * SEC)).toMatchObject({ cue: null, next: { recovered: { from: 'sleepy' } } });
    expect(tick(60 * SEC).cue).toMatchObject({ kind: '回復', from: 'sleepy' });
    expect(tick(60 * SEC, false).cue).toBeNull();
  });

  it('snapshot：まだ出していない回復・節目は覚えず、出していない lastCue は 0 にする', () => {
    const v = { ...interestStart(), milestone: { min: 15, at: T0 }, recovered: { from: 'down' as const, at: T0 } };
    expect(interestSnapshot(v)).toEqual({ elapsed: 0, quiet: 0, lastCue: 0, milestones: 0, n: 0, factor: 1, awaiting: false });
    expect(interestStart(interestSnapshot(v))).toMatchObject({ milestone: null, recovered: null, lastTick: 0 });
  });
});

describe('ノートの様子の合図（noteStep）', () => {
  const counts = { unreadable: 2, stuck: 3 };
  const reading = (r: Partial<NoteState>): NoteState => ({ observation: '', readable: true, unreadableReason: '', progress: 'working', ms: 0, model: '', config: {} as never, usage: {} as never, at: 1, image: 'img', ...r });
  /** 判定を順に流し、出た合図を返す */
  function feed(rs: NoteState[], quiet = false, c: typeof counts | null = counts) {
    let s: NoteStreak = null;
    const out = [];
    for (const r of rs) {
      const x = noteStep(s, r, quiet, c);
      s = x.next;
      if (x.nudge) out.push(x.nudge);
    }
    return { streak: s, nudges: out };
  }
  const stuck = reading({ progress: 'stuck' });

  it('stuck が counts.stuck 回続いたら出して、0 から数えなおす', () => {
    expect(feed([stuck, stuck])).toEqual({ streak: { kind: 'stuck', count: 2 }, nudges: [] });
    expect(feed([stuck, stuck, stuck])).toEqual({ streak: { kind: 'stuck', count: 0 }, nudges: [{ kind: 'stuck', count: 3, reason: '', image: 'img' }] });
    expect(feed(Array(6).fill(stuck)).nudges).toHaveLength(2);
  });

  it('読み取れないは readable で決まり、理由をつける（progress は見ない）', () => {
    const r = reading({ readable: false, progress: 'working', unreadableReason: '暗い' });
    expect(feed([r, r]).nudges).toEqual([{ kind: 'unreadable', count: 2, reason: '暗い', image: 'img' }]);
  });

  it('ちがう状態で切れ、unknown は数えず切りもしない', () => {
    const unknown = reading({ progress: 'unknown' });
    expect(feed([stuck, unknown, stuck]).streak).toEqual({ kind: 'stuck', count: 2 });
    expect(feed([stuck, stuck, reading({})]).streak).toEqual({ kind: 'working', count: 1 });
    expect(feed([stuck, stuck, reading({ readable: false }), stuck]).streak).toEqual({ kind: 'stuck', count: 1 });
  });

  it('quiet のあいだ・counts が読めていないあいだは数えない', () => {
    expect(feed([stuck, stuck, stuck], true)).toEqual({ streak: null, nudges: [] });
    expect(feed([stuck, stuck, stuck], false, null)).toEqual({ streak: null, nudges: [] });
  });
});
