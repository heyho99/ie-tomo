import { useEffect, useRef, useState } from 'react';
import { aiApi, type NoteProgress, type NoteReading, type NudgeRules } from './api';
import type { Capture } from './capture';
import { useNudgeRules } from './nudgeRules';
import { useSettings } from './settings';

// 手元カメラの映像（または iPad のノート）を、一定間隔で AI（Gemini）に見せて、ノートが読み取れるか・手が進んでいるかを判定させる
// 前回送った画像もいっしょに送り、変化を比べさせる
// 間隔は管理者設定（noteIntervalSec。nudgeRules.ts）。読めるまでは読み取らない。前の読み取りが終わっていなければ、その回は飛ばす
// capture：画像を作る関数（手元カメラは cameraCapture、iPad のノートは PadNote が渡す）。null のあいだは読み取らない

export const PROGRESS_LABEL: Record<NoteProgress, string> = { working: '勉強を続けている', stuck: '手が止まっている', unknown: '様子はまだわからない' };
export const PROGRESS_CHIP: Record<NoteProgress, string> = { working: 'chip-blue', stuck: 'chip-cream', unknown: 'chip-gray' };

/** at：読み取りが返ってきた時刻。image：読み取りに使った画像（data URL） */
export type NoteState = NoteReading & { at: number; image: string };
/** 最近のノートの様子（興味の合図で AI に渡す）。observation：見えたこと・前回からの変化 */
export type NoteObservation = { at: number; observation: string };
const RECENT = 5; // 残しておく、最近のノートの様子の数

/** recent：最近のノートの様子（古い順。読み取れたものだけ） */
export function useNoteReader(capture: Capture | null, enabled: boolean) {
  const [reading, setReading] = useState<NoteState | null>(null);
  const [recent, setRecent] = useState<NoteObservation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings] = useSettings();
  const current = useRef(settings);
  current.current = settings;
  const prev = useRef<{ image: string; at: number } | null>(null); // 前回送った画像
  const interval = useNudgeRules()?.noteIntervalSec;

  useEffect(() => {
    if (!capture || !enabled || !interval) return;
    let alive = true;
    let inFlight = false;
    prev.current = null; // 止まっていたあいだの画像とは比べない
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const { noteMaxSide, noteQuality, handCameraRotate, handSource } = current.current; // 画像の大きさ・画質・向きは「設定」の手元ノートキャプチャ設定
        const image = capture({ maxSide: noteMaxSide || Infinity, quality: noteQuality, rotate: handCameraRotate })?.image;
        if (!image) return;
        const at = Date.now();
        const p = prev.current;
        const r = await aiApi.readNote(image, p ? { image: p.image, elapsed: (at - p.at) / 1000 } : undefined, handSource === 'pad' ? 'pad' : 'camera');
        if (!alive) return;
        prev.current = { image, at };
        const now = Date.now();
        setReading({ ...r, at: now, image });
        if (r.readable && r.observation) setRecent((o) => [...o, { at: now, observation: r.observation }].slice(-RECENT));
        setError('');
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (alive) setBusy(false);
      }
    };
    tick();
    const t = setInterval(tick, interval * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [capture, enabled, interval]);

  return { reading, recent, error, busy };
}

// 読み取りの結果からの声かけの合図。直前 n 回の判定が同じ状態なら出す（何を言うかは会話・チャットの AI が考える）
// 声をかけたら数えなおすので、改善されなければ、また n 回たったら声をかける。n は管理者設定（counts。nudgeRules.ts）

export type NudgeKind = keyof NudgeRules['note'];
/** 声かけの合図。count：同じ状態が何回続けて判定されたか。reason：読み取れない理由（unreadable のとき）。image：この状態の根拠になった、最後に判定した画像 */
export type Nudge = { kind: NudgeKind; count: number; reason: string; image: string };

/** 同じ状態が続いている数（working は合図を出さないが、続いている状態を切るのに使う） */
export type NoteStreak = { kind: NudgeKind | 'working'; count: number } | null;

/**
 * 判定がひとつ届いた（「続いている数＋判定 → 次の続いている数と合図」の純粋関数。Vitest で単体テストする。#7）
 * quiet のあいだ（家トモが話している・考えているなど）に届いた判定は数えない（生徒は家トモの話を聞いているので）
 * counts：状態ごとに、直前何回の判定が同じなら声をかけるか（管理者設定）。読めるまでは null で、合図を出さない
 */
export function noteStep(streak: NoteStreak, reading: NoteState, quiet: boolean, counts: NudgeRules['note'] | null): { next: NoteStreak; nudge: Nudge | null } {
  if (quiet || !counts) return { next: streak, nudge: null };
  const kind = reading.readable ? reading.progress : 'unreadable';
  // unknown（判定できない）は数えず、続いている状態も切らない
  if (kind === 'unknown') return { next: streak, nudge: null };
  const count = streak?.kind === kind ? streak.count + 1 : 1;
  if (kind === 'working' || count < counts[kind]) return { next: { kind, count }, nudge: null };
  // 声をかけたら数えなおす
  return { next: { kind, count: 0 }, nudge: { kind, count, reason: reading.unreadableReason, image: reading.image } };
}

export function useNoteNudge(reading: NoteState | null, quiet: boolean, counts: NudgeRules['note'] | null, nudge: (n: Nudge) => void) {
  const streak = useRef<NoteStreak>(null);
  const seen = useRef(0); // 最後に見た判定の時刻（同じ判定を2回数えない）
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  useEffect(() => {
    if (!reading || reading.at === seen.current) return; // quiet が変わっただけのときは何もしない
    seen.current = reading.at;
    const r = noteStep(streak.current, reading, quiet, counts);
    streak.current = r.next;
    if (r.nudge) nudgeRef.current(r.nudge);
  }, [reading, quiet, counts]);
}
