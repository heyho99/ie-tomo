import { db } from './db.js';

// 声かけの合図を出す基準と、ノートを読み取る間隔（管理者設定で変える。全員に同じ値を使う）
// ノートの合図は「直前何回の判定が同じ状態なら出すか」の回数、顔カメラの合図は「何秒続いたら出すか」とクールタイム（秒）
// 興味の合図（順調に勉強しているときの声かけ。興味の声かけの設計.md）は、しばらく話していない・経過時間の節目・状態がよくなったときの3種類で、それぞれオン・オフできる
// Firestore の appSettings/nudge に保存し、変更を受け取ってメモリの値を更新する（どの台で変えても全台に届く）

export type NudgeRules = {
  noteIntervalSec: number; // 授業でノートを読み取る間隔（秒）
  note: { unreadable: number; stuck: number };
  face: {
    sleepySec: number; sleepyCooldownSec: number;
    downSec: number; downCooldownSec: number;
  };
  interest: {
    quiet: { on: boolean; minSec: number; maxSec: number }; // しばらく話していない：話していない時間 N の最小・最大（秒。このあいだでランダムに決める）
    milestone: { on: boolean; everyMin: number }; // 経過時間の節目：何分ごとに出すか
    recovered: { on: boolean; cooldownSec: number }; // 状態がよくなった：ほかの合図・続けるかの確認のあと、この秒数は出さない（クールタイム）
  };
};

export const NUDGE_DEFAULTS: NudgeRules = {
  noteIntervalSec: 30,
  // stuck（手が止まっている）は考えている時間もあるので長め（既定の間隔 30 秒で約1分30秒）
  note: { unreadable: 1, stuck: 3 },
  face: {
    sleepySec: 3, sleepyCooldownSec: 60,
    downSec: 20, downCooldownSec: 60,
  },
  interest: {
    quiet: { on: true, minSec: 60, maxSec: 120 },
    milestone: { on: true, everyMin: 15 },
    recovered: { on: true, cooldownSec: 60 },
  },
};

const MAX = { count: 999, sec: 3600, interval: 180, minutes: 600 };
const doc = db.collection('appSettings').doc('nudge');
let saved: unknown = null;

/** 保存された基準を読み込み、以後の変更を受け取りつづける。最初の読み込みが終わったら解決する（起動時に待つ） */
export function watchNudgeRules() {
  return new Promise<void>((resolve, reject) => {
    let first = true;
    doc.onSnapshot((snap) => {
      saved = snap.exists ? snap.data() : null;
      if (first) { first = false; resolve(); }
    }, (e) => {
      console.error('声かけの基準を Firestore から読めません：', e.message);
      if (first) { first = false; reject(e); }
    });
  });
}

/** 1 以上 max 以下の整数にする。数でなければ既定値 */
const num = (v: unknown, d: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(1, Math.round(v))) : d);

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : undefined);

/** 保存された値を確かめて、足りない・おかしい項目は既定値にする */
function clean(raw: unknown): NudgeRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { noteIntervalSec?: unknown; note?: Record<string, unknown>; face?: Record<string, unknown>; interest?: Record<string, unknown>; globalCooldownSec?: unknown };
  const pick = <T extends Record<string, number>>(d: T, v: Record<string, unknown> | undefined, max: number) =>
    Object.fromEntries(Object.entries(d).map(([k, x]) => [k, num(v?.[k], x, max)])) as T;
  // 前の形（on・quietMinSec・quietMaxSec・milestoneMin・recovered がじかに入っていた。クールタイムは globalCooldownSec）で保存されていても、なるべく引きつぐ
  const d = NUDGE_DEFAULTS.interest, i = r.interest, allOn = bool(i?.on, true);
  const q = obj(i?.quiet), m = obj(i?.milestone), rc = obj(i?.recovered);
  const oldEvery = Array.isArray(i?.milestoneMin) ? i.milestoneMin[0] : undefined;
  const minSec = num(q?.minSec ?? i?.quietMinSec, d.quiet.minSec, MAX.sec);
  return {
    noteIntervalSec: num(r.noteIntervalSec, NUDGE_DEFAULTS.noteIntervalSec, MAX.interval),
    note: pick(NUDGE_DEFAULTS.note, r.note, MAX.count),
    face: pick(NUDGE_DEFAULTS.face, r.face, MAX.sec),
    interest: {
      quiet: {
        on: bool(q?.on, allOn && d.quiet.on),
        minSec,
        maxSec: Math.max(minSec, num(q?.maxSec ?? i?.quietMaxSec, d.quiet.maxSec, MAX.sec)), // 最小より短くしない
      },
      milestone: {
        on: bool(m?.on, allOn && (Array.isArray(i?.milestoneMin) ? i.milestoneMin.length > 0 : d.milestone.on)),
        everyMin: num(m?.everyMin ?? oldEvery, d.milestone.everyMin, MAX.minutes),
      },
      recovered: {
        on: bool(rc?.on, allOn && bool(i?.recovered, d.recovered.on)),
        cooldownSec: num(rc?.cooldownSec ?? r.globalCooldownSec, d.recovered.cooldownSec, MAX.sec),
      },
    },
  };
}

export const getNudgeRules = () => clean(saved);

export async function setNudgeRules(raw: unknown): Promise<NudgeRules> {
  const r = clean(raw);
  saved = r; // 自分の台にはすぐ反映する（ほかの台には onSnapshot で届く）
  await doc.set(r);
  return r;
}
