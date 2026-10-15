import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

// 端末ごとの設定（顔カメラを使うか・家トモの声を出すか・使うカメラとマイク）。保存できない環境でも動くようにする
// handCameraId / micId が空ならブラウザの既定のデバイスを使う。handCameraOn は授業中の手元カメラのオン・オフ、micOn は授業中に声で話しかけるか
// handCameraRotate は手元カメラの画像を時計回りに回す角度（0〜359）。「設定」で合わせ、授業の映像と読み取りに使う
// sideWidth は授業画面の右の列（ノート）の幅（px）。仕切りのドラッグで変える
// talkMode は家トモとの話し方。voice：会話モード（Gemini Live と声で話す。チャット欄はない）、chat：チャットモード（チャットのモデルと文字で話す。マイクの声は文字にして送り、家トモは声を出さない）
// handCameraSize は手元カメラの映像の大きさの希望（CAMERA_SIZES の key）。noteMaxSide・noteQuality は AI に送る画像の長い辺（px。0 は縮めない）と JPEG の画質。どれも「設定」の手元ノートキャプチャ設定で変える（読み取る間隔は管理者設定）
// faceOn は授業中に顔カメラ（PC の内蔵カメラ）で表情を解析するか。faceCameraId は顔カメラに使うカメラ（空なら既定のカメラ）。解析は端末の中だけで行う（face.ts）
// liveVoice は会話モードの家トモの声（Gemini Live のプリセットの声の名前。LIVE_VOICES）
// handSource は手元（ノート）の入力元。camera：手元カメラ、pad：iPad のノート（iPad の Safari で書いた線を PC に送る。pad.ts）、none：手元ノートを使わない
export type Settings = { faceOn: boolean; voiceOn: boolean; handCameraId: string; handCameraRotate: number; micId: string; handCameraOn: boolean; micOn: boolean; sideWidth: number; handCameraSize: string; noteMaxSide: number; noteQuality: number; talkMode: TalkMode; handSource: HandSource; faceCameraId: string; liveVoice: string };
export type TalkMode = 'voice' | 'chat';
export type NoteSource = 'camera' | 'pad';
export type HandSource = NoteSource | 'none';

/** 会話モードで選べる家トモの声（Gemini Live のプリセット）。label は声の感じ。サーバーも同じ名前だけ受けつける（server/src/live.ts） */
export const LIVE_VOICES: { name: string; label: string }[] = [
  { name: 'Puck', label: '男性・明るい' },
  { name: 'Charon', label: '男性・説明上手' },
  { name: 'Orus', label: '男性・しっかり' },
  { name: 'Fenrir', label: '男性・元気' },
  { name: 'Kore', label: '女性・しっかり' },
  { name: 'Aoede', label: '女性・さわやか' },
  { name: 'Leda', label: '女性・若々しい' },
  { name: 'Zephyr', label: '女性・明るい' },
  { name: 'Sulafat', label: '女性・あたたかい' },
  { name: 'Vindemiatrix', label: '女性・やさしい' },
  { name: 'Achernar', label: '女性・やわらかい' },
];

const KEY = 'tonari-sensei:settings';
const DEFAULTS: Settings = { faceOn: true, voiceOn: true, handCameraId: '', handCameraRotate: 0, micId: '', handCameraOn: true, micOn: true, sideWidth: 380, handCameraSize: '720p', noteMaxSide: 1280, noteQuality: 0.85, talkMode: 'voice', handSource: 'camera', faceCameraId: '', liveVoice: 'Puck' };
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

let current = load();

function save(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* 保存できなくても動く */ }
  listeners.forEach((l) => l());
}

type SettingsPair = [Settings, (patch: Partial<Settings>) => void];

// 設定の範囲：SettingsScope の中では useSettings がその範囲の設定を返す。カメラやマイクの部品はそのまま範囲の設定で動く
// 「設定」の下書き（useSettingsDraft）と、授業の回だけの設定（useSessionSettings）で使う
const ScopeContext = createContext<SettingsPair | null>(null);

export function useSettings(): SettingsPair {
  const scope = useContext(ScopeContext);
  const value = usePersistent();
  const update = useCallback((patch: Partial<Settings>) => save(patch), []);
  return scope ?? [value, update];
}

/** 保存している設定（範囲の中でも、保存している設定を返す） */
function usePersistent() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

const changedKeys = (a: Settings, b: Settings) => (Object.keys(a) as (keyof Settings)[]).filter((k) => a[k] !== b[k]);

// 下書き：「設定」では変更をすぐ保存せず、「設定を保存」を押したときだけ保存する（押すまで授業には反映されない）
/** 下書きを作る。dirty は保存していない変更があるか */
export function useSettingsDraft() {
  const [draft, setDraft] = useState<Settings>(() => current);
  const update = useCallback((patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch })), []);
  const dirty = changedKeys(draft, current).length > 0;
  // 保存せずにページを閉じる・読み込み直すときは、ブラウザに確かめてもらう
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return {
    pair: [draft, update] as SettingsPair,
    dirty,
    save: () => { save(draft); setDraft(current); },
    reset: () => setDraft(current),
  };
}

// 授業の回だけの設定：授業の画面で変えた設定は、保存している設定（「設定」で決める）の上に重ねるだけで保存しない
// 重ねた分はタブの中（sessionStorage）に回ごとに覚えておき、読み込み直しても続く。閉じれば消え、次の回は「設定」の設定ではじまる
// 例外：PERSIST_KEYS（右の列の幅など、画面の見た目の好み）は授業の画面で変えても保存する
const PERSIST_KEYS: (keyof Settings)[] = ['sideWidth'];
const sessionKey = (id: string) => `tonari-sensei:session-settings:${id}`;

function loadSession(id: string): Partial<Settings> {
  try { return JSON.parse(sessionStorage.getItem(sessionKey(id)) || '{}'); } catch { return {}; }
}

/**
 * 授業の回（id）だけの設定。pair は SettingsScope に渡す。回が変わったら作り直す（key に id を渡す）
 * changed：「設定」の設定と違う項目。keep：いまの設定を保存して次の回からも使う。revert：「設定」の設定にもどす
 */
export function useSessionSettings(id: string) {
  const base = usePersistent();
  const [over, setOver] = useState<Partial<Settings>>(() => loadSession(id));
  useEffect(() => {
    try {
      if (Object.keys(over).length) sessionStorage.setItem(sessionKey(id), JSON.stringify(over));
      else sessionStorage.removeItem(sessionKey(id));
    } catch { /* 覚えておけなくても動く */ }
  }, [id, over]);
  const merged = useMemo(() => ({ ...base, ...over }), [base, over]);
  const update = useCallback((patch: Partial<Settings>) => {
    const keep = Object.fromEntries(Object.entries(patch).filter(([k]) => PERSIST_KEYS.includes(k as keyof Settings)));
    if (Object.keys(keep).length) save(keep);
    setOver((o) => {
      const next = { ...o };
      for (const [k, v] of Object.entries(patch) as [keyof Settings, never][]) {
        // 保存している設定と同じになったら、重ねるのをやめる（「設定」で変えればそれに合わせる）
        if (PERSIST_KEYS.includes(k) || current[k] === v) delete next[k];
        else next[k] = v;
      }
      return next;
    });
  }, []);
  return {
    pair: [merged, update] as SettingsPair,
    changed: changedKeys(merged, base),
    revert: () => setOver({}),
  };
}

export function SettingsScope({ value, children }: { value: SettingsPair; children: ReactNode }) {
  return createElement(ScopeContext.Provider, { value }, children);
}
