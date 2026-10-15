import { useCallback, useEffect, useRef } from 'react';
import { debugLog } from './debug';

// 続けるかの確認：放置されたまま動きつづけないよう、一時中断する時刻（はじめは勉強を続けて interval 秒）の warn 秒前に、続けるかを家トモにたずねてもらう
// 生徒が続けると答えたら（家トモが pause_study の continue を呼んだら）continued() で、一時中断する時刻を interval 秒のばす
// たずねてから warn 秒のうちに continued() が来なければ（返事がない）、timeout を呼ぶ（学習画面が一時中断する）
// 続けないと答えたときは、家トモが pause_study の pause を呼ぶ（ここでは何もしない）
// 時間は running のあいだだけ数え、running でなくなったら（一時中断したら）はじめから数えなおす

// ふつうは30分で一時中断し、その3分前にたずねる。デバッグ授業では、ためしやすいよう30秒・10秒にする
/** 続けるかの確認の時間（秒）。interval：一時中断するまで（続けると答えるたびにこれだけのびる）、warn：一時中断する何秒前にたずねるか */
export type ContinueTimes = { interval: number; warn: number };
export const continueTimes = (): ContinueTimes => (debugLog.session ? { interval: 30, warn: 10 } : { interval: 30 * 60, warn: 3 * 60 });
const TICK_MS = 1000;

type Options = {
  running: boolean; // 勉強している（学習の回を開いていて、一時中断していない・AI と pause_study が使える）
  quiet: boolean; // 家トモが話している・返事を考え中（そのあいだはたずねない・一時中断しない）
  ask: (elapsedMs: number) => void; // 続けるかをたずねる合図を出す
  timeout: () => void; // 返事がなかった
  restore?: ContinueSnapshot | null; // リロードのまえの数え具合（はじめて running になったときに、はじめからではなくこれで続ける）
};

/** 数え具合をそのまま覚えておく形（リロードのまえに覚えておく）。中身は ContinueCount（数えているとき）と同じ */
export type ContinueSnapshot = { since: number; limit: number; askedAt: number | null };

/** いまの数え具合。since：数えはじめた時刻、pauseAt：返事がなければ一時中断する時刻、askAt：たずねる（たずねた）時刻、asked：もうたずねた */
export type ContinueState = { since: number; pauseAt: number; askAt: number; asked: boolean };

// 判定は「数え具合＋いまの時刻 → 次の数え具合と合図」の純粋関数にする（Vitest で単体テストする。#7）。フックは時計と React をつなぐだけ

/** 数え具合。since：数えはじめた時刻（数えていなければ null）。limit：数えはじめてから一時中断するまで（ms。続けると答えるたびにのびる）
 * askedAt：たずねたときの、数えはじめてからの時間（ms）。経過は時刻の差で出す（画面のバーとずれないように） */
export type ContinueCount = { since: number | null; limit: number; askedAt: number | null };
/** 合図。ask：続けるかをたずねる（elapsed：数えはじめてからの ms）、timeout：返事がなかった */
export type ContinueCue = { kind: 'ask'; elapsed: number } | { kind: 'timeout' };

/** はじめから数える（since が null なら数えない） */
export const continueStart = (since: number | null, t: ContinueTimes): ContinueCount => ({ since, limit: t.interval * 1000, askedAt: null });

/** 時間が進んだ。たずねる時刻になったら ask、たずねてから warn 秒たったら timeout（そのあとは now からはじめて数えなおす）。quiet のあいだは何もしない */
export function continueTick(v: ContinueCount, now: number, quiet: boolean, t: ContinueTimes): { next: ContinueCount; cue: ContinueCue | null } {
  if (v.since === null || quiet) return { next: v, cue: null };
  const elapsed = now - v.since;
  if (v.askedAt === null) {
    if (elapsed < v.limit - t.warn * 1000) return { next: v, cue: null };
    return { next: { ...v, askedAt: elapsed }, cue: { kind: 'ask', elapsed } };
  }
  if (elapsed - v.askedAt >= t.warn * 1000) return { next: continueStart(now, t), cue: { kind: 'timeout' } };
  return { next: v, cue: null };
}

/** 続けると答えた。一時中断する時刻を interval 秒のばす（たずねる前に言われたときは、のばさない） */
export function continueAnswered(v: ContinueCount, t: ContinueTimes): ContinueCount {
  if (v.since === null || v.askedAt === null) return v;
  return { ...v, limit: v.limit + t.interval * 1000, askedAt: null };
}

/** いまの数え具合（画面のバーに出す）。数えていなければ null */
export function continuePeek(v: ContinueCount, t: ContinueTimes): ContinueState | null {
  if (v.since === null) return null;
  // 話しているあいだはたずねるのを待つので、たずねたあとは、たずねてから warn 秒で一時中断する
  const pause = v.askedAt === null ? v.limit : v.askedAt + t.warn * 1000;
  return { since: v.since, pauseAt: v.since + pause, askAt: v.since + (v.askedAt ?? v.limit - t.warn * 1000), asked: v.askedAt !== null };
}

export function useContinueCheck(o: Options) {
  const cb = useRef(o);
  cb.current = o;
  const times = useRef(continueTimes()).current; // デバッグ授業かどうかは、授業の画面を開いているあいだ変わらない
  const s = useRef(continueStart(null, times));
  const restore = useRef(o.restore ?? null);
  useEffect(() => {
    s.current = o.running && restore.current ? { ...restore.current } : continueStart(o.running ? Date.now() : null, times);
    if (o.running) restore.current = null;
  }, [o.running]);

  useEffect(() => {
    const t = setInterval(() => {
      const { next, cue } = continueTick(s.current, Date.now(), cb.current.quiet, times);
      s.current = next;
      if (cue?.kind === 'ask') cb.current.ask(cue.elapsed);
      else if (cue?.kind === 'timeout') cb.current.timeout();
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  /** 続けると答えた。一時中断する時刻を interval 秒のばす（たずねる前に言われたときは、のばさない） */
  const continued = useCallback(() => { s.current = continueAnswered(s.current, times); }, []);
  /** いまの数え具合（画面のバーに出す）。数えていなければ null */
  const peek = useCallback(() => continuePeek(s.current, times), []);
  /** いまの数え具合をそのまま（リロードのまえに覚えておく）。数えていなければ null */
  const snapshot = useCallback((): ContinueSnapshot | null => {
    const v = s.current;
    return v.since === null ? null : { since: v.since, limit: v.limit, askedAt: v.askedAt };
  }, []);
  return { continued, peek, snapshot, times };
}
