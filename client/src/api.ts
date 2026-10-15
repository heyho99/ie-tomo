import { authHeader } from './auth';
import { debugLog } from './debug';
import { apiUrl } from './serverUrl';
import type { NoteSource } from './settings';
import type { TimerWire } from './timer';

/** 学習の回。いつ・何という名前で勉強したか（教材は持たず、画面共有で家トモに見せる）。summary：会話が長くなったときの、古い会話の要約 */
export type StudySession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary?: Summary;
};
/** 古い会話の要約。upTo：要約に入れた最後の発言の時刻（これより後の発言は要約していない） */
export type Summary = { text: string; upTo: number };
/** 会話の発言。who：tomo は家トモ、me は生徒。at：言った時刻（ミリ秒） */
export type Message = { who: 'tomo' | 'me'; text: string; at: number };

/** エラー時はサーバーの error メッセージを投げる */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), { ...init, headers: { 'Content-Type': 'application/json', ...(await authHeader()), ...init?.headers } });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const sessionUrl = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
  sessions: () => request<StudySession[]>('/api/sessions'),
  createSession: (title: string) => request<StudySession>('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) }),
  session: (id: string) => request<StudySession>(sessionUrl(id)),
  renameSession: (id: string, title: string) => request<StudySession>(sessionUrl(id), { method: 'PUT', body: JSON.stringify({ title }) }),
  removeSession: (id: string) => request<void>(sessionUrl(id), { method: 'DELETE' }),
  /** 学習の回のこれまでの会話（古い順） */
  messages: (id: string) => request<Message[]>(`${sessionUrl(id)}/messages`),
};

// AI：チャットモードの会話、会話モード（Gemini Live。live.ts）の会話、手元のノートの読み取り。用途ごとにモデルと設定を選ぶ（「管理者設定」画面）
export type AiPurpose = 'chat' | 'live' | 'note';
export type AiLevel = 'low' | 'medium' | 'high';
export type AiProvider = 'gemini' | 'claude';
export type AiConfig = { model: string; thinking: AiLevel; mediaResolution: AiLevel };
/** ready：その用途の AI が使えるか（選んだモデルの認証が設定されているか）。tools：家トモのツールがオンか（管理者設定。ツール名ごと） */
export type AiStatus = { purposes: Record<AiPurpose, { ready: boolean; model: string; label: string }>; tools: Partial<Record<ToolName, boolean>> };
/** 家トモが使えるツール（server/src/tools/） */
export type ToolName = 'look_at_screen' | 'look_at_note' | 'timer' | 'pause_study' | 'how_to_start' | 'what_can_you_do';
/** 管理者設定のツールの一覧 */
export type AdminTool = { name: ToolName; label: string; description: string; defaultDescription: string; enabled: boolean };
/** kind：text はふつうの生成、live は Gemini Live。用途の kind と同じ種類のモデルだけ選べる */
export type AiModelKind = 'text' | 'live';
export type AiModel = { id: string; provider: AiProvider; label: string; kind: AiModelKind; ready: boolean };
/** media：画像を渡す用途（解像度の設定がある） */
export type AiSettings = { models: AiModel[]; purposes: { key: AiPurpose; label: string; kind: AiModelKind; media: boolean; config: AiConfig }[]; notConfigured: Record<AiProvider, string> };

/** 声かけの合図を出す基準と、ノートを読み取る間隔（管理者設定）。noteIntervalSec：授業でノートを読み取る間隔（秒）。note：直前何回の判定が同じ状態なら出すか。face：何秒続いたら出すかと、クールタイム（秒） */
export type NudgeRules = {
  noteIntervalSec: number;
  note: { unreadable: number; stuck: number };
  face: {
    sleepySec: number; sleepyCooldownSec: number;
    downSec: number; downCooldownSec: number;
  };
  /**
   * 興味の合図（順調に勉強しているときの声かけ）。3種類それぞれオン・オフできる
   * quiet：しばらく話していない（minSec〜maxSec：話していない時間 N の範囲、秒）。milestone：経過時間の節目（everyMin 分ごと）。recovered：状態がよくなった（cooldownSec：ほかの合図・続けるかの確認のあと、この秒数は出さない）
   */
  interest: {
    quiet: { on: boolean; minSec: number; maxSec: number };
    milestone: { on: boolean; everyMin: number };
    recovered: { on: boolean; cooldownSec: number };
  };
};

export type TokenUsage = { prompt: number; output: number; thoughts: number; total: number };
/** 前回からの生徒の様子。working：勉強を続けている、stuck：手が止まっている、unknown：わからない（初回など） */
export type NoteProgress = 'working' | 'stuck' | 'unknown';
/** readable：図・グラフ・式・答えが読み取れるか。unreadableReason：読み取れない理由（読み取れるなら空） */
export type ChatTurn = { role: 'user' | 'tomo'; text: string };
/**
 * lookedAtScreen：家トモが共有している画面を見た（look_at_screen）。lookedAtNote：手元のノートを見た（look_at_note）
 * timer：家トモが時間を計りはじめた・やめたときだけ入る、変えたあとの状態（やめたら null）
 * summary：会話が長くなった（入力がコンテキストウィンドウの 80% をこえた）ので、サーバーが学習の回の古い会話を要約した。要約しなかったときは入らない
 */
/** いまの会話の量（トークン）。summaryAt：古い会話を要約する量、compressAt：Gemini Live が古い会話を捨てる量（会話モードだけ）、limit：コンテキストウィンドウ */
export type ContextUsage = { tokens: number; summaryAt: number; compressAt?: number; limit: number };
export type ChatReply = { reply: string; lookedAtScreen: boolean; lookedAtNote: boolean; timer?: TimerWire | null; study?: 'pause' | 'continue'; summary?: Summary; usage?: ContextUsage; ms: number; model: string };
/**
 * チャットに足して送るもの。summary：古い会話の要約。cueScreen：興味の合図のとき、共有している画面のいまの1コマ（合図といっしょにそのまま見せる）
 * session：学習の回の id（サーバーが会話を保存する）。student：message が生徒の発言（合図・知らせでない）。生徒の発言だけ保存する
 */
export type ChatExtra = { summary?: string; cueScreen?: string; session?: string; student?: boolean };
export type NoteReading = { observation: string; readable: boolean; unreadableReason: string; progress: NoteProgress; ms: number; model: string; config: AiConfig; usage: TokenUsage };

/**
 * エラー時はサーバーの日本語メッセージを投げる
 * デバッグ画面のときは、送ったデータと返ってきたデータを記録し、サーバーにも AI の送受信を記録させる（debug.ts）
 */
async function aiRequest<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const session = debugLog.session;
  const trace = debugLog.api(method, url, body);
  try {
    const res = await fetch(apiUrl(url), {
      method,
      headers: { 'Content-Type': 'application/json', ...(await authHeader()), ...(session && { 'X-Debug-Session': session }) },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    trace?.end(res.status, data, res.ok ? undefined : data.error ?? res.statusText);
    if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
    return data as T;
  } catch (e) {
    if (e instanceof TypeError) trace?.end(0, null, e.message); // サーバーにつながらなかった
    throw e;
  }
}

export const aiApi = {
  status: () => request<AiStatus>('/api/ai/status'),
  /** image・prevImage は data URL（JPEG）。prev は前回送った画像と、それから何秒たったか（初回はなし）。source は手元カメラか iPad のノートか */
  readNote: (image: string, prev?: { image: string; elapsed: number }, source: NoteSource = 'camera') =>
    aiRequest<NoteReading>('/api/ai/read-note', { image, prevImage: prev?.image, elapsed: prev?.elapsed, source }),
  /**
   * チャットモードの会話。image：声かけの合図の根拠になったノートの画像、screen：共有している画面のいまの画像、note：手元のノートのいまの画像（どれも data URL。screen・note は家トモが見たいときだけ AI に渡る）
   * timer：いま計っている時間（計っていなければ null）
   */
  chat: (message: string, history: ChatTurn[], context?: string, image?: string, screen?: string, note?: string, timer?: TimerWire | null, extra?: ChatExtra) =>
    aiRequest<ChatReply>('/api/ai/chat', { message, history, context, image, screen, note, timer, ...extra }),
  settings: () => request<AiSettings>('/api/ai/settings'),
  saveSettings: (purpose: AiPurpose, config: AiConfig) => aiRequest<AiConfig>(`/api/ai/settings/${purpose}`, config, 'PUT'),
  tools: () => request<AdminTool[]>('/api/ai/tools'),
  saveTools: (enabled: Partial<Record<ToolName, boolean>>) => aiRequest<Record<ToolName, boolean>>('/api/ai/tools', enabled, 'PUT'),
  /** AI に渡すツールの説明。空にするとコードに書いた説明に戻る */
  saveToolDescription: (name: ToolName, description: string) => aiRequest<{ description: string }>(`/api/ai/tools/${name}/description`, { description }, 'PUT'),
  nudgeRules: () => request<NudgeRules>('/api/ai/nudge'),
  saveNudgeRules: (rules: NudgeRules) => aiRequest<NudgeRules>('/api/ai/nudge', rules, 'PUT'),
};
