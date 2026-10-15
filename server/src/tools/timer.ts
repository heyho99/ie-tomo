import type { ToolDef } from './index.js';

// 時間を計る。決まった時間を計る（タイマー：「10分計って」）か、かかった時間を計る（ストップウォッチ：「時間計って」）か、
// 集中と休憩をくり返す（ポモドーロ：「ポモドーロして」。ふつうは 25分集中・5分休憩を4回。最後の集中で終わる）
// 計っている状態はブラウザが持つ（チャットモードは毎回送ってもらい、会話モードは変わったときに送り合う）。時計がずれていてもいいよう、やりとりは経過時間でする
// 時間になったら（ポモドーロは集中・休憩が切りかわるたびにも）、ブラウザが「（タイマーの知らせ）」を家トモに送る（Study.tsx）

/** ポモドーロ。work：1回の集中（分）、rest：休憩（分）、rounds：集中する回数 */
export type Pomodoro = { work: number; rest: number; rounds: number };
/** 計っている状態（サーバーの時計）。minutes：タイマーの長さ（分。ポモドーロは全体の長さ）。ストップウォッチなら null */
export type TimerState = { startedAt: number; minutes: number | null; pomodoro?: Pomodoro };
/** ブラウザとやりとりする形。elapsedMs：計りはじめてからの時間 */
export type TimerWire = { elapsedMs: number; minutes: number | null; pomodoro?: Pomodoro };

const MAX_MINUTES = 600;
const MAX_ROUNDS = 12;
const POMODORO: Pomodoro = { work: 25, rest: 5, rounds: 4 };

export const toWire = (s: TimerState | null): TimerWire | null => s && { elapsedMs: Date.now() - s.startedAt, minutes: s.minutes, ...(s.pomodoro && { pomodoro: s.pomodoro }) };

const minutesOk = (m: number) => m > 0 && m <= MAX_MINUTES;
/** ポモドーロ全体の長さ（分）。最後の集中のあとに休憩はない */
const pomodoroTotal = (p: Pomodoro) => p.rounds * p.work + (p.rounds - 1) * p.rest;

/** ブラウザから届いた状態。おかしな値なら null（計っていない） */
export function fromWire(raw: unknown): TimerState | null {
  const w = raw as Partial<TimerWire> | null;
  const elapsed = Number(w?.elapsedMs);
  if (!w || !Number.isFinite(elapsed) || elapsed < 0) return null;
  const startedAt = Date.now() - elapsed;
  const p = w.pomodoro;
  if (p) {
    const pomodoro = { work: Number(p.work), rest: Number(p.rest), rounds: Math.round(Number(p.rounds)) };
    const ok = minutesOk(pomodoro.work) && minutesOk(pomodoro.rest) && pomodoro.rounds >= 1 && pomodoro.rounds <= MAX_ROUNDS && minutesOk(pomodoroTotal(pomodoro));
    return ok ? { startedAt, minutes: pomodoroTotal(pomodoro), pomodoro } : null;
  }
  const minutes = Number(w.minutes);
  return { startedAt, minutes: w.minutes != null && minutesOk(minutes) ? minutes : null };
}

/**
 * ポモドーロのいまの段階。round：何回目か（1〜）、working：集中しているか（false なら休憩）、remainingMs：いまの段階の残り
 * 学習画面（client/src/timer.ts の pomodoroAt）も同じ計算をしている
 */
export function pomodoroAt(p: Pomodoro, elapsedMs: number) {
  const min = elapsedMs / 60_000, cycle = p.work + p.rest;
  const round = Math.min(p.rounds, Math.floor(min / cycle) + 1);
  const working = round === p.rounds || min - (round - 1) * cycle < p.work;
  const phaseEnd = (round - 1) * cycle + (working ? p.work : cycle);
  return { round, working, remainingMs: phaseEnd * 60_000 - elapsedMs };
}

/** 「3分20秒」のように言う */
export function duration(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h && `${h}時間`, m && `${m}分`, (s || sec === 0) && `${s}秒`].filter(Boolean).join('');
}

const pomodoroText = (p: Pomodoro) => `ポモドーロ（${duration(p.work * 60_000)}集中・${duration(p.rest * 60_000)}休憩を${p.rounds}回）`;
const kindText = (s: TimerState) => (s.pomodoro ? pomodoroText(s.pomodoro) : s.minutes ? `${duration(s.minutes * 60_000)}のタイマー` : 'ストップウォッチ');

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'check', 'stop'],
      description: 'start：計りはじめる（計っている途中なら、はじめから計りなおす）。check：いま何分たったか・あと何分かを確かめる。stop：計るのをやめる（かかった時間がわかる）',
    },
    pomodoro: {
      type: 'boolean',
      description: 'start のときだけ。ポモドーロ（集中と休憩をくり返す）なら true',
    },
    minutes: {
      type: 'number',
      description: 'start のときだけ。何分計るか（「10分計って」なら 10、「1時間」なら 60、「30秒」なら 0.5）。長さが決まっていない（「時間を計って」「どれくらいかかるか計って」）ときは省く（ストップウォッチになる）。ポモドーロのときは1回の集中の時間（言われなければ省く。25分になる）',
    },
    breakMinutes: {
      type: 'number',
      description: 'ポモドーロのときだけ。休憩の時間（分）。言われなければ省く（5分になる）',
    },
    rounds: {
      type: 'number',
      description: `ポモドーロのときだけ。集中する回数（1〜${MAX_ROUNDS}）。言われなければ省く（4回になる）`,
    },
  },
  required: ['action'],
};

/** start の引数から、計る状態を作る。おかしな値ならエラーの文 */
function startState(args: Record<string, unknown>, now: number): TimerState | string {
  const num = (v: unknown, fallback: number | null) => (v == null ? fallback : Number(v));
  if (args.pomodoro === true) {
    const p = { work: num(args.minutes, POMODORO.work)!, rest: num(args.breakMinutes, POMODORO.rest)!, rounds: Math.round(num(args.rounds, POMODORO.rounds)!) };
    if (!minutesOk(p.work) || !minutesOk(p.rest)) return `minutes・breakMinutes は 0 より大きく ${MAX_MINUTES} 以下にしてください`;
    if (!(p.rounds >= 1 && p.rounds <= MAX_ROUNDS)) return `rounds は 1 から ${MAX_ROUNDS} にしてください`;
    if (!minutesOk(pomodoroTotal(p))) return `全体で ${MAX_MINUTES} 分以下にしてください`;
    return { startedAt: now, minutes: pomodoroTotal(p), pomodoro: p };
  }
  const minutes = num(args.minutes, null);
  if (minutes !== null && !minutesOk(minutes)) return `minutes は 0 より大きく ${MAX_MINUTES} 以下にしてください`;
  return { startedAt: now, minutes };
}

export const timer: ToolDef = {
  name: 'timer',
  label: '時間を計る',
  description: '時間を計る。生徒が「10分計って」「25分たったら教えて」のように決まった時間を頼んだら minutes をつけて start（時間になると「（タイマーの知らせ）」が届く）。「時間を計って」「この問題にどれくらいかかるか計って」なら minutes なしで start。「ポモドーロして」「集中と休憩をくり返したい」なら pomodoro を true にして start（集中・休憩が切りかわるたびと、終わったときに「（タイマーの知らせ）」が届く）。「あと何分？」「何分たった？」「いま休憩？」は check、「止めて」「終わった」は stop。時間は推測で言わずに、このツールで確かめてから答える',
  parameters: PARAMETERS,
  features: [
    { name: 'タイマー', hint: '「10分計って」' },
    { name: 'ストップウォッチ', hint: '「時間を計って」' },
    { name: 'ポモドーロ', hint: '「ポモドーロして」（25分集中・5分休憩）' },
    { name: '残り時間の確認', hint: '「あと何分？」' },
  ],
  async run(ctx, args) {
    const now = Date.now();
    const s = ctx.timer.get();
    switch (args.action) {
      case 'start': {
        const next = startState(args, now);
        if (typeof next === 'string') return { result: { error: next } };
        ctx.timer.set(next);
        const restarted = s ? `（計っていた${kindText(s)}は、${duration(now - s.startedAt)}のところでやめて、計りなおした）` : '';
        return { result: { result: next.pomodoro
          ? `${pomodoroText(next.pomodoro)}を始めました${restarted}。まず1回目の集中です。集中・休憩が切りかわるたびと、終わったときに「（タイマーの知らせ）」が届きます`
          : next.minutes
            ? `${duration(next.minutes * 60_000)}のタイマーを始めました${restarted}。時間になると「（タイマーの知らせ）」が届きます`
            : `時間を計りはじめました（ストップウォッチ）${restarted}。止めるか、聞かれるまで計りつづけます` } };
      }
      case 'check': {
        if (!s) return { result: { error: 'いまは時間を計っていません' } };
        const elapsed = now - s.startedAt;
        if (s.pomodoro) {
          const p = pomodoroAt(s.pomodoro, elapsed);
          return { result: {
            result: pomodoroText(s.pomodoro),
            now: `${p.round}回目の${p.working ? '集中' : 'あとの休憩'}`,
            remaining: duration(p.remainingMs),
            totalRemaining: duration(s.minutes! * 60_000 - elapsed),
          } };
        }
        return { result: s.minutes
          ? { result: kindText(s), elapsed: duration(elapsed), remaining: duration(s.minutes * 60_000 - elapsed) }
          : { result: kindText(s), elapsed: duration(elapsed) } };
      }
      case 'stop': {
        if (!s) return { result: { error: 'いまは時間を計っていません' } };
        ctx.timer.set(null);
        return { result: { result: `${kindText(s)}をやめました`, elapsed: duration(now - s.startedAt) } };
      }
      default:
        return { result: { error: 'action は start・check・stop のどれかにしてください' } };
    }
  },
};
