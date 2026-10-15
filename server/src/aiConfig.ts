import { db } from './db.js';

// AI の設定。用途（チャットモードの会話・会話モードの会話・ノートの読み取り）ごとに、モデルと考える深さなどを選ぶ
// 設定は Firestore の aiSettings/{purpose} に保存し、「管理者設定」画面から変える
// 読むのは呼び出しのたびなので、メモリに持っておき、Firestore の変更を受け取って更新する（どの台で変えても全台に届く）

export type Purpose = 'chat' | 'live' | 'note';
export type Level = 'low' | 'medium' | 'high';
export type Provider = 'gemini' | 'claude';
/** text：ふつうの生成（generate で呼ぶ）。live：Gemini Live（声で話す。live.ts でつなぐ） */
export type ModelKind = 'text' | 'live';

/**
 * 使えるモデル。id は各プラットフォームでのモデル ID。用途の kind と同じ種類のモデルだけ選べる
 * contextTokens：コンテキストウィンドウ（トークン）。会話がこの 80% をこえたら古い会話を要約する（summary.ts）。Live API のモデルはどれも 128k
 */
export const MODELS = [
  { id: 'gemini-3.8-flash', provider: 'gemini', label: 'Gemini 3.8 Flash', kind: 'text', contextTokens: 1_048_576 },
  { id: 'claude-sonnet-5-5', provider: 'claude', label: 'Claude Sonnet 5.5', kind: 'text', contextTokens: 200_000 },
  { id: 'gemini-3.8-live', provider: 'gemini', label: 'Gemini 3.8 Live', kind: 'live', contextTokens: 128_000 },
] as const satisfies readonly { id: string; provider: Provider; label: string; kind: ModelKind; contextTokens: number }[];
export type ModelId = (typeof MODELS)[number]['id'];

/**
 * thinking：考える深さ（Gemini は thinkingLevel、Claude は effort）
 * mediaResolution：画像をどれだけ細かく見るか（Gemini だけ。Claude にはこの設定がない）
 */
export type AiConfig = { model: ModelId; thinking: Level; mediaResolution: Level };

/**
 * kind：選べるモデルの種類。media：画像を渡す（解像度の設定がある）
 * live は考える深さ・解像度を選べない（モデルだけ）
 */
export const PURPOSES: { key: Purpose; label: string; kind: ModelKind; media: boolean }[] = [
  { key: 'chat', label: 'チャットモードの会話', kind: 'text', media: true }, // 声かけの合図にノートの画像、共有中は画面の画像がつく
  { key: 'live', label: '会話モードの会話（Gemini Live）', kind: 'live', media: false },
  { key: 'note', label: 'ノートの読み取り（手元カメラ・iPad）', kind: 'text', media: true },
];

const DEFAULTS: Record<Purpose, AiConfig> = {
  chat: { model: 'gemini-3.8-flash', thinking: 'low', mediaResolution: 'medium' }, // 返事を待つあいだ会話が止まるので、速さ優先
  live: { model: 'gemini-3.8-live', thinking: 'low', mediaResolution: 'medium' }, // モデルだけ使う
  note: { model: 'gemini-3.8-flash', thinking: 'low', mediaResolution: 'high' }, // 速さ優先。手書きの細かい字を読むため解像度は高
};

const LEVELS: Level[] = ['low', 'medium', 'high'];

export function modelInfo(id: string) {
  return MODELS.find((m) => m.id === id);
}

const col = db.collection('aiSettings');
const saved: Partial<Record<Purpose, unknown>> = {};

/** 保存された設定を読み込み、以後の変更を受け取りつづける。最初の読み込みが終わったら解決する（起動時に待つ） */
export function watchConfigs() {
  return new Promise<void>((resolve, reject) => {
    let first = true;
    col.onSnapshot((snap) => {
      snap.docChanges().forEach((c) => {
        if (!isPurpose(c.doc.id)) return;
        if (c.type === 'removed') delete saved[c.doc.id];
        else saved[c.doc.id] = c.doc.data();
      });
      if (first) { first = false; resolve(); }
    }, (e) => {
      console.error('AI の設定を Firestore から読めません：', e.message);
      if (first) { first = false; reject(e); }
    });
  });
}

/** 保存された値を確かめて、足りない・おかしい項目は既定値にする */
function clean(purpose: Purpose, raw: unknown): AiConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AiConfig, unknown>>;
  const d = DEFAULTS[purpose];
  const kind = PURPOSES.find((p) => p.key === purpose)!.kind;
  return {
    model: modelInfo(String(v.model))?.kind === kind ? (v.model as ModelId) : d.model,
    thinking: LEVELS.includes(v.thinking as Level) ? (v.thinking as Level) : d.thinking,
    mediaResolution: LEVELS.includes(v.mediaResolution as Level) ? (v.mediaResolution as Level) : d.mediaResolution,
  };
}

export function getConfig(purpose: Purpose): AiConfig {
  return clean(purpose, saved[purpose]);
}

export function getAllConfigs(): Record<Purpose, AiConfig> {
  return Object.fromEntries(PURPOSES.map(({ key }) => [key, getConfig(key)])) as Record<Purpose, AiConfig>;
}

export async function setConfig(purpose: Purpose, raw: unknown): Promise<AiConfig> {
  const c = clean(purpose, raw);
  saved[purpose] = c; // 自分の台にはすぐ反映する（ほかの台には onSnapshot で届く）
  await col.doc(purpose).set(c);
  return c;
}

export const isPurpose = (v: unknown): v is Purpose => PURPOSES.some((p) => p.key === v);
