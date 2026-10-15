import { useEffect, useState } from 'react';
import type { ContinueSnapshot } from './continueCheck';
import type { InterestSnapshot } from './interestNudge';
import type { Timer } from './timer';

// この回を開いてからの、勉強していた時間と一時中断していた時間（学習画面のバーに出す）
// 一時中断のあいだは勉強した時間に入れない。記録はこの画面を開いているあいだだけ（開きなおすと 0 から）
// 例外：リロードしたときは、バー・続けるかの確認・一時中断・タイマー・興味の合図の時間をそのまま続ける（ページを閉じるときにタブの中＝sessionStorage に覚えておく）

/** 勉強していた・一時中断していたひとまとまり。to：終わった時刻（いま続いていれば null） */
export type StudySpan = { from: number; to: number | null; paused: boolean };

/**
 * リロードのまえに覚えておくもの。key：そのときの履歴の key（同じページをリロードしたかを見る）
 * check：続けるかの確認の数え具合、paused：一時中断していたら、そのわけ（一時中断の画面に出す文）、timer：家トモが計っている時間、interest：興味の合図の数え具合
 */
export type StudySaved = { key: string; spans: StudySpan[]; check: ContinueSnapshot | null; paused: string | null; timer: Timer | null; interest: InterestSnapshot };

const savedKey = (id: string) => `tonari-sensei:study-time:${id}`;

// ページを読み込んだときのようす。リロードなら、そのときの履歴の key の学習画面だけ、前の状態を戻す
const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
const boot = { reload: nav?.type === 'reload', key: (history.state as { key?: string } | null)?.key ?? 'default', used: false };
let last: { id: string; key: string; saved: StudySaved | null } | null = null; // いちばん最近の restoreOnReload の結果

/**
 * リロードした学習画面なら、リロードのまえの状態。そうでなければ null（覚えていたものは捨てる）
 * リロードのあとの最初の1回だけ（ほかの画面から入りなおしたときは、はじめから）
 */
export function restoreOnReload(id: string, key: string): StudySaved | null {
  if (last?.id === id && last.key === key) return last.saved;
  let saved: StudySaved | null = null;
  try {
    if (boot.reload && !boot.used && key === boot.key) {
      const v = JSON.parse(sessionStorage.getItem(savedKey(id)) || 'null') as StudySaved | null;
      if (v?.key === key && Array.isArray(v.spans) && v.spans.length) saved = v;
    }
    sessionStorage.removeItem(savedKey(id));
  } catch { /* 読めなければ、はじめから */ }
  // StrictMode で2回呼ばれても同じ結果を返し、少しあとで使ったことにする
  last = { id, key, saved };
  setTimeout(() => { boot.used = true; last = null; }, 0);
  return saved;
}

/** ページを閉じる（リロードする）ときに覚えておく。get：そのときの状態 */
export function useSaveOnLeave(id: string, get: () => StudySaved | null) {
  useEffect(() => {
    const onHide = () => {
      const v = get();
      try { if (v) sessionStorage.setItem(savedKey(id), JSON.stringify(v)); } catch { /* 覚えておけなければ、リロードではじめから */ }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [id]);
}

/** started：学習の回を読み込んだ。paused：一時中断している。initial：リロードのまえの区間（最後の区間は閉じてある） */
export function useStudySpans(started: boolean, paused: boolean, initial: StudySpan[] = []) {
  const [spans, setSpans] = useState<StudySpan[]>(initial);
  useEffect(() => {
    if (!started) return;
    const now = Date.now();
    setSpans((s) => {
      const last = s[s.length - 1];
      if (last && last.to === null && last.paused === paused) return s;
      return [...s.slice(0, -1), ...(last ? [{ ...last, to: last.to ?? now }] : []), { from: now, to: null, paused }];
    });
  }, [started, paused]);
  return spans;
}

/** いまの区間を閉じたもの（リロードのまえに覚えておく） */
export const closeSpans = (spans: StudySpan[], now: number) => spans.map((s) => (s.to === null ? { ...s, to: now } : s));

/** 勉強した時間・一時中断していた時間（ms） */
export function studyTotals(spans: StudySpan[], now: number) {
  let study = 0, paused = 0;
  for (const s of spans) {
    const ms = (s.to ?? now) - s.from;
    if (s.paused) paused += ms;
    else study += ms;
  }
  return { study, paused };
}
