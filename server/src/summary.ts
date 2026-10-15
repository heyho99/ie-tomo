import { getConfig, modelInfo, type Purpose } from './aiConfig.js';
import { generate } from './llm.js';
import { messagesOf, saveSummary, summaryOf, type Message, type Summary } from './sessions.js';

// 会話が長くなったときの、古い会話の要約（会話モード・チャットモード共通）
// 入力のトークン数がコンテキストウィンドウの 80% をこえたら、直近 KEEP 件より前の発言をチャットのモデルで要約して、学習の回に保存する
// AI には「要約＋要約より後の発言」を渡す（続きから開いたときも同じ）

/** 要約するときに家トモが言うこと（会話の欄に出す。保存はしない） */
export const SUMMARY_NOTICE = 'そろそろ会話の量が増えてきたから、古い内容は要約していくね。';
const KEEP = 10; // 要約せずにそのまま残す、直近の発言の数
const RATIO = 0.8; // コンテキストウィンドウのこの割合をこえたら要約する
const READ_LIMIT = 1000; // 要約するときに読む発言の数の上限

/** 用途のいまのモデルで、要約を始めるトークン数 */
export function summaryThreshold(purpose: Purpose) {
  return Math.floor((modelInfo(getConfig(purpose).model)?.contextTokens ?? 128_000) * RATIO);
}

const PROMPT = `家で勉強している生徒と、付き添いの先生「家トモ」の会話を要約します。あとで家トモが会話の続きをするときに、この要約だけを読みます。
残すこと：何を勉強しているか、どこまで進んだか、生徒がつまずいたところ・わかったところ、生徒が話した目標や好み、約束したこと。
あいさつや、意味のないやりとりは省きます。前の要約があれば、その内容も入れて1つにまとめます。箇条書き（「- 」で始める）で、長くても20行までにします。`;

const lines = (ms: Message[]) => ms.map((m) => `${m.who === 'tomo' ? '家トモ' : '生徒'}：${m.text}`).join('\n');

/** AI に渡すこれまでの会話：要約と、要約より後の発言（limit 件まで） */
export async function historyOf(uid: string, sessionId: string, limit?: number): Promise<{ summary: Summary | null; recent: Message[] }> {
  const summary = await summaryOf(uid, sessionId);
  return { summary, recent: await messagesOf(uid, sessionId, limit, summary?.upTo) };
}

/** 直近 KEEP 件より前の発言を要約して保存する。要約するものがなければ、いまの要約のまま（updated: false） */
export async function summarize(uid: string, sessionId: string): Promise<{ summary: Summary | null; recent: Message[]; updated: boolean }> {
  const prev = await summaryOf(uid, sessionId);
  const all = await messagesOf(uid, sessionId, READ_LIMIT, prev?.upTo);
  const old = all.slice(0, -KEEP), recent = all.slice(-KEEP);
  if (!old.length) return { summary: prev, recent, updated: false };
  const r = await generate('chat', {
    system: PROMPT,
    turns: [{ role: 'user', parts: [{ text: `${prev ? `前の要約：\n${prev.text}\n\n` : ''}会話：\n${lines(old)}` }] }],
  });
  const summary = { text: r.text.trim(), upTo: old[old.length - 1].at };
  await saveSummary(uid, sessionId, summary);
  return { summary, recent, updated: true };
}

/** system prompt に入れる、これまでの会話（なければ空） */
export function historyText(summary: Summary | null, recent: Message[]) {
  if (!summary && !recent.length) return '';
  return `\n\nこの学習の回で、これまでに話したことです。この続きとして話します（あいさつのやり直しや、同じ説明のくり返しはしない）。${
    summary ? `\nここまでの会話の要約：\n${summary.text}` : ''}${recent.length ? `\n${summary ? 'そのあとの会話：\n' : ''}${lines(recent)}` : ''}`;
}
