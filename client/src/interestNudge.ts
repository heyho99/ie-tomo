import { useCallback, useEffect, useRef } from 'react';
import type { NudgeRules } from './api';

// 興味の合図：順調に勉強しているあいだも、家トモが話しかけるきっかけ（興味の声かけの設計.md）
// 合図を出すかどうかはここのルールで決め、何を言うかは会話・チャットの AI が考える。3種類それぞれ管理者設定でオン・オフできる
//   回復：困りごとの合図（手が止まっている・下を向いている・目を閉じている）のあとで、また進みはじめた（recovered）
//   節目：勉強を始めてからの時間が節目（管理者設定 milestone.everyMin 分ごと。15分なら 15・30・45…分）になった
//   興味：話していない時間が N 秒をこえた（N は quiet.minSec〜quiet.maxSec でランダム。生徒の反応で変える）
// 同時に出せるときは 回復 ＞ 節目 ＞ 興味 の上だけ出す。家トモが話している・返事を考え中は出さない
// 回復だけは、ほかの合図（困りごと・興味）・続けるかの確認のあと recovered.cooldownSec は出さない（困りごとの声かけのすぐあとに「よくなったね」と言わないように）
// 節目・興味はもともと一定時間たってから出るので、クールタイムはない（興味は家トモが話すと数えなおす）
// 経過時間・話していない時間は、一時中断のあいだは数えない

export type CueKind = '興味' | '節目' | '回復';
/** 興味の合図。elapsedMin：勉強を始めてからの分、quietMin：最後に話してからの分、milestoneMin：節目の分（節目）、from：何から回復したか（回復） */
export type InterestCue = { kind: CueKind; elapsedMin: number; quietMin: number; milestoneMin?: number; from?: RecoveredFrom };
/** 何から回復したか。stuck：手が止まっていた、down：下を向いていた、sleepy：目を閉じていた */
export type RecoveredFrom = 'stuck' | 'down' | 'sleepy';

const TICK_MS = 5000;
const PENDING_TTL_MS = 3 * 60_000; // 回復・節目は、この時間のうちに出せなければ捨てる（古い話をしないように）
const REPLIED = 0.8; // 興味の合図に生徒が返事をしたら、次の N をこの倍にする（短く）
const IGNORED = 1.5; // 返事がないまま次の興味の合図になったら、次の N をこの倍にする（長く）

type Options = {
  rules: NudgeRules['interest'] | null; // 読めるまでは null で、合図を出さない
  running: boolean; // 勉強している（学習の回を開いていて、一時中断していない）。false のあいだは時間を数えない
  quiet: boolean; // 家トモが話している・返事を考え中（そのあいだは出さない）
  nudge: (c: InterestCue) => void;
  restore?: InterestSnapshot; // リロードのまえの数え具合（studyTime.ts）
};

/** 数え具合をそのまま覚えておく形（リロードのまえに覚えておく）。lastCue は時刻なので、リロードをはさんでもそのまま使える */
export type InterestSnapshot = { elapsed: number; quiet: number; lastCue: number; milestones: number; n: number; factor: number; awaiting: boolean };

// 判定は「数え具合＋いまの時刻 → 次の数え具合と合図」の純粋関数にする（Vitest で単体テストする。#7）。フックは時計と React をつなぐだけ

/** 数え具合 */
export type InterestCount = {
  lastTick: number; // 前の tick の時刻（0 はまだ数えていない）
  elapsed: number; // 勉強を始めてから（ms）
  quiet: number; // 最後に話してから（ms）
  lastCue: number; // 最後に合図を出した時刻（困りごとの合図も）
  milestones: number; // 何個目の節目まで過ぎたか（次の節目は (milestones + 1) × everyMin 分）
  milestone: { min: number; at: number } | null; // まだ出していない節目
  recovered: { from: RecoveredFrom; at: number } | null; // まだ出していない回復
  n: number; // 次の興味の合図までの、話していない時間（秒。0 はまだ決めていない）
  factor: number; // 生徒の反応で N にかける倍率
  awaiting: boolean; // 興味の合図のあと、生徒がまだ返事をしていない
};

export const interestStart = (restore?: InterestSnapshot): InterestCount => ({
  lastTick: 0, elapsed: 0, quiet: 0, lastCue: -Infinity, milestones: 0, milestone: null, recovered: null, n: 0, factor: 1, awaiting: false,
  ...restore,
});

/** 時間が進んだ（TICK_MS ごと）。出す合図があれば cue に入れる。random は N を決めるときに使う（テストでは固定する） */
export function interestTick(
  prev: InterestCount, now: number, o: { rules: NudgeRules['interest'] | null; running: boolean; quiet: boolean }, random: () => number = Math.random,
): { next: InterestCount; cue: InterestCue | null } {
  const v = { ...prev };
  const dt = v.lastTick ? now - v.lastTick : 0;
  v.lastTick = now;
  const { rules } = o;
  if (!rules || !o.running) return { next: v, cue: null };
  v.elapsed += dt;
  v.quiet += dt;
  const every = rules.milestone.everyMin * 60_000;
  while (v.elapsed >= (v.milestones + 1) * every) {
    v.milestones++;
    if (rules.milestone.on) v.milestone = { min: v.milestones * rules.milestone.everyMin, at: now };
  }
  if (v.milestone && now - v.milestone.at > PENDING_TTL_MS) v.milestone = null;
  if (v.recovered && now - v.recovered.at > PENDING_TTL_MS) v.recovered = null;
  if (o.quiet) return { next: v, cue: null };
  const cooling = now - v.lastCue < rules.recovered.cooldownSec * 1000;

  const base = { elapsedMin: Math.round(v.elapsed / 60_000), quietMin: Math.round(v.quiet / 60_000) };
  let cue: InterestCue | null = null;
  if (v.recovered && rules.recovered.on && !cooling) cue = { ...base, kind: '回復', from: v.recovered.from };
  else if (v.milestone) cue = { ...base, kind: '節目', milestoneMin: v.milestone.min };
  else if (rules.quiet.on) {
    if (!v.n) {
      const { minSec: min, maxSec: max } = rules.quiet;
      v.n = Math.min(max * 2, Math.max(min, (min + random() * (max - min)) * v.factor));
    }
    if (v.quiet >= v.n * 1000) cue = { ...base, kind: '興味' };
  }
  if (!cue) return { next: v, cue: null };
  // 回復を出したら、出さなかった節目は捨てる。クールタイム中で出せなかった回復は、あとで出せるよう残す
  if (cue.kind === '回復') v.recovered = v.milestone = null;
  else v.milestone = null;
  if (cue.kind === '興味') {
    if (v.awaiting) v.factor = Math.min(4, v.factor * IGNORED);
    v.awaiting = true;
    v.n = 0; // 次の N は、出したあとに決めなおす
  }
  v.lastCue = now;
  return { next: v, cue };
}

/** だれかが話した（家トモの発言・生徒の発言）。話していない時間を数えなおす。興味の合図のあとで生徒が話したら、次の N を短くする */
export function interestTalked(v: InterestCount, who: 'tomo' | 'me'): InterestCount {
  if (who === 'me' && v.awaiting) return { ...v, quiet: 0, awaiting: false, factor: Math.max(0.25, v.factor * REPLIED), n: 0 };
  return { ...v, quiet: 0 };
}

/** いまの数え具合（リロードのまえに覚えておく）。まだ出していない回復・節目は覚えない */
export function interestSnapshot(v: InterestCount): InterestSnapshot {
  const { elapsed, quiet, lastCue, milestones, n, factor, awaiting } = v;
  return { elapsed, quiet, lastCue: Number.isFinite(lastCue) ? lastCue : 0, milestones, n, factor, awaiting };
}

export function useInterestNudge(o: Options) {
  const cb = useRef(o);
  cb.current = o;
  const s = useRef(interestStart(o.restore));

  useEffect(() => {
    const t = setInterval(() => {
      const { next, cue } = interestTick(s.current, Date.now(), cb.current);
      s.current = next;
      if (cue) cb.current.nudge(cue);
    }, TICK_MS);
    return () => clearInterval(t);
  }, []);

  /** だれかが話した（家トモの発言・生徒の発言）。話していない時間を数えなおす。興味の合図のあとで生徒が話したら、次の N を短くする */
  const talked = useCallback((who: 'tomo' | 'me') => { s.current = interestTalked(s.current, who); }, []);
  /** 困りごとの合図・続けるかの確認を出した（そのあと recovered.cooldownSec は回復の合図を出さない） */
  const cued = useCallback(() => { s.current = { ...s.current, lastCue: Date.now() }; }, []);
  /** 困りごとの合図のあとで、状態がよくなった */
  const recovered = useCallback((from: RecoveredFrom) => { s.current = { ...s.current, recovered: { from, at: Date.now() } }; }, []);
  /** いまの数え具合（リロードのまえに覚えておく）。まだ出していない回復・節目は覚えない */
  const snapshot = useCallback(() => interestSnapshot(s.current), []);

  return { talked, cued, recovered, snapshot };
}
