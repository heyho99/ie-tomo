import { useEffect, useSyncExternalStore } from 'react';
import { aiApi, type NudgeRules } from './api';

// 声かけの合図を出す基準と、ノートを読み取る間隔（管理者設定で変える。全員に同じ値。サーバーの nudgeConfig.ts）
// 使う画面を開くたびにサーバーから読みなおす（管理者が変えた基準を、授業を開き直せば使う）。はじめて読めるまでは null（そのあいだは読み取りも合図もしない）
// 読めなかったときは、読めるまで数秒おきに読みなおす

let rules: NudgeRules | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(r: NudgeRules) {
  rules = r;
  listeners.forEach((l) => l());
}

const RETRY_MS = 5000; // まだ一度も読めていないときに読みなおす間隔
let retry = 0;

function load() {
  // 同時に開いた画面どうしでは1回だけ読む
  loading ??= aiApi.nudgeRules().then(set).catch(() => {
    // まだ一度も読めていなければ、使っている画面があるあいだ読みなおす（ネットが戻れば動きはじめる）。前に読めた値があれば、それを使いつづける
    if (!rules && listeners.size && !retry) retry = window.setTimeout(() => { retry = 0; load(); }, RETRY_MS);
  }).finally(() => { loading = null; });
}

export function useNudgeRules() {
  useEffect(load, []);
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => rules);
}

/** 管理者設定で基準を保存する（保存した値をすぐこの画面でも使う） */
export async function saveNudgeRules(r: NudgeRules) {
  const saved = await aiApi.saveNudgeRules(r);
  set(saved);
  return saved;
}
