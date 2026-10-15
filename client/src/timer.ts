import { useEffect, useState } from 'react';

// 家トモが計っている時間（server/src/tools/timer.ts）。計っている状態は学習画面が持ち、サーバーとは経過時間でやりとりする（時計がずれていてもいいように）

/** ポモドーロ。work：1回の集中（分）、rest：休憩（分）、rounds：集中する回数（最後の集中で終わる） */
export type Pomodoro = { work: number; rest: number; rounds: number };
/** startedAt：計りはじめた時刻（この端末の時計）。minutes：タイマーの長さ（分。ポモドーロは全体の長さ）。ストップウォッチなら null */
export type Timer = { startedAt: number; minutes: number | null; pomodoro?: Pomodoro };
/** サーバーとやりとりする形。elapsedMs：計りはじめてからの時間 */
export type TimerWire = { elapsedMs: number; minutes: number | null; pomodoro?: Pomodoro };

export const toWire = (t: Timer | null): TimerWire | null => t && { elapsedMs: Date.now() - t.startedAt, minutes: t.minutes, ...(t.pomodoro && { pomodoro: t.pomodoro }) };
export const fromWire = (w: TimerWire | null | undefined): Timer | null => w ? { startedAt: Date.now() - w.elapsedMs, minutes: w.minutes, ...(w.pomodoro && { pomodoro: w.pomodoro }) } : null;

/**
 * ポモドーロのいまの段階（サーバーの tools/timer.ts の pomodoroAt と同じ計算）
 * round：何回目か（1〜）、working：集中しているか（false なら休憩）、phaseStart・phaseEnd：いまの段階の始まりと終わり（計りはじめからの ms）
 * stage：計りはじめてから何回切りかわったか（集中・休憩・集中…の順に 0, 1, 2…）
 */
export function pomodoroAt(p: Pomodoro, elapsedMs: number) {
  const min = elapsedMs / 60_000, cycle = p.work + p.rest;
  const round = Math.min(p.rounds, Math.floor(min / cycle) + 1);
  const working = round === p.rounds || min - (round - 1) * cycle < p.work;
  const start = (round - 1) * cycle + (working ? 0 : p.work);
  return { round, working, phaseStart: start * 60_000, phaseEnd: (start + (working ? p.work : p.rest)) * 60_000, stage: (round - 1) * 2 + (working ? 0 : 1) };
}

/** タイマーが終わる時刻。ストップウォッチなら null */
export const timerEnd = (t: Timer) => (t.minutes ? t.startedAt + t.minutes * 60_000 : null);

/** 「1:05」「1:02:03」のように出す */
export function clockText(ms: number) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}

/** 「10分」「30秒」のように言う */
export function minutesText(minutes: number) {
  const sec = Math.round(minutes * 60);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h && `${h}時間`, m && `${m}分`, s && `${s}秒`].filter(Boolean).join('');
}

/** 計っているあいだ、1秒ごとにいまの時刻を返す */
export function useTick(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
