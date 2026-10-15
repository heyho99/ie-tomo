import { useSyncExternalStore } from 'react';

// 開発者用：デバッグ授業の記録。授業の画面（Study）はふつうの授業と同じもので、デバッグ授業のときだけここに記録がたまる
// llm：サーバーが AI（LLM）に送ったデータと返ってきたデータ（サーバーから SSE で届く）
// api：画面がサーバーの AI の API に送ったデータと返ってきたデータ
// event：授業の画面で起きたこと（家トモの発話、生徒の発言、場面の切りかわりなど）

export type LlmEntry = {
  kind: 'llm'; id: string; at: number;
  purpose: string; provider: string; model: string; config: unknown; endpoint: string; request: unknown; images: string[];
  end?: { at: number; ms: number; text?: string; usage?: unknown; response?: unknown; error?: string };
};
export type ApiEntry = {
  kind: 'api'; id: string; at: number;
  method: string; url: string; body: unknown; images: string[];
  end?: { at: number; ms: number; status: number; response: unknown; error?: string };
};
export type EventEntry = { kind: 'event'; id: string; at: number; label: string; detail?: unknown };
export type DebugEntry = LlmEntry | ApiEntry | EventEntry;

const MAX = 500; // これより古い記録は捨てる

type Store = { session: string | null; entries: DebugEntry[]; state: Record<string, unknown> };
let store: Store = { session: null, entries: [], state: {} };
const listeners = new Set<() => void>();
let seq = 0;
let holders = 0;

function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((l) => l());
}

function add(e: DebugEntry) {
  set({ entries: [...store.entries, e].slice(-MAX) });
}

function patchEntry(id: string, f: (e: DebugEntry) => DebugEntry) {
  set({ entries: store.entries.map((e) => (e.id === id ? f(e) : e)) });
}

const newId = () => `c${++seq}`;

export const debugLog = {
  /** デバッグ授業のあいだの ID（ふつうの授業では null） */
  get session() { return store.session; },
  /** デバッグ授業を始める（同じ ID なら記録はそのまま） */
  start(session: string) {
    holders++;
    if (store.session !== session) set({ session, entries: [], state: {} });
  },
  /** デバッグ授業をおえる。StrictMode のつなぎなおしで止まらないよう、少し待ってから止める */
  stop() {
    holders--;
    setTimeout(() => { if (holders <= 0) set({ session: null }); });
  },
  clear() { set({ entries: [] }); },

  /** 授業の画面で起きたこと */
  event(label: string, detail?: unknown) {
    if (store.session) add({ kind: 'event', id: newId(), at: Date.now(), label, detail });
  },

  /** 授業の画面のいまの状態（変わったときだけ更新） */
  state(s: Record<string, unknown>) {
    if (store.session && JSON.stringify(s) !== JSON.stringify(store.state)) set({ state: s });
  },

  /** サーバーから届いた AI の送受信 */
  llm(e: { type: 'llm:start' | 'llm:end'; id: string } & Record<string, unknown>) {
    if (!store.session) return;
    const { type, id, ...rest } = e;
    if (type === 'llm:start') add({ kind: 'llm', id, ...(rest as Omit<LlmEntry, 'kind' | 'id'>) });
    else patchEntry(id, (x) => (x.kind === 'llm' ? { ...x, end: rest as LlmEntry['end'] } : x));
  },

  /** 画面からサーバーへの API 呼び出しを記録する。返り値で結果を記録する（ふつうの授業では null） */
  api(method: string, url: string, body: unknown) {
    if (!store.session) return null;
    const id = newId();
    const at = Date.now();
    const { value, images } = pickImages(body);
    add({ kind: 'api', id, at, method, url, body: value, images });
    const end = (status: number, response: unknown, error?: string) =>
      patchEntry(id, (x) => (x.kind === 'api' ? { ...x, end: { at: Date.now(), ms: Date.now() - at, status, response, ...(error && { error }) } } : x));
    return { end };
  },
};

/** 送る中の画像（data URL）を取り出して、本文では短い文字に置きかえる */
function pickImages(body: unknown) {
  const images: string[] = [];
  if (!body || typeof body !== 'object') return { value: body, images };
  const value = Object.fromEntries(Object.entries(body).map(([k, v]) => {
    if (typeof v === 'string' && v.startsWith('data:image/')) {
      images.push(v);
      return [k, `<画像 ${Math.round((v.length * 3) / 4 / 1024)}KB：#${images.length}>`];
    }
    return [k, v];
  }));
  return { value, images };
}

export function useDebugLog() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => store);
}
