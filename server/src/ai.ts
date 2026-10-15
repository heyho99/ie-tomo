import { Router } from 'express';
import { admin } from './admin.js';
import { modelInfo } from './aiConfig.js';
import { generate, parseImage } from './llm.js';
import { chatSystem, EVIDENCE_LABEL, isInterestCue, NOTE_NOW_LABEL, NOTE_SCHEMA, notePrompt, PROGRESS, SCREEN_NOW_LABEL, type NoteProgress, type NoteReading } from './prompts.js';
import { forChat } from './tools/index.js';
import type { StudyAction } from './tools/pause_study.js';
import { fromWire, toWire } from './tools/timer.js';
import { summarize, summaryThreshold } from './summary.js';
import { addMessage, saveLiveResume } from './sessions.js';

// AI：手元カメラのノートの様子の読み取り、チャットモードの会話（会話モードの家トモは Gemini Live。live.ts）
// 用途ごとにモデル（Gemini・Claude）と考える深さなどを選べる（aiConfig.ts、「管理者設定」画面）。呼び出しは llm.ts
// プロンプトは prompts.ts、管理者設定の API は admin.ts

export const ai = Router();

// 管理者設定と、AI・ツールが使えるか（admin.ts）。URL は /api/ai/... のまま
ai.use(admin);

/** AI を呼べないときのエラー（認証の設定がないなど） */
function sendError(res: import('express').Response, e: unknown, what: string) {
  const status = (e as { status?: number }).status === 503 ? 503 : 502;
  res.status(status).json({ error: `${what}：${(e as Error).message}` });
}

/**
 * 手元カメラ（または iPad のノート）の前回と今回の1コマから、ノートの様子を見る。usage・config は検証ページで見る
 * prevImage・elapsed（前回から何秒たったか）は、前回の画像がないときは送らない
 * source：'pad' なら iPad のノート（Apple Pencil で書いた線だけの画像）。ないときは手元カメラ
 */
ai.post('/read-note', async (req, res) => {
  const image = parseImage(req.body?.image);
  if (!image) { res.status(400).json({ error: '画像（data URL）を送ってください' }); return; }
  const prev = req.body?.prevImage ? parseImage(req.body.prevImage) : null;
  const elapsed = Number(req.body?.elapsed);
  const pad = req.body?.source === 'pad';
  const where = pad ? 'iPad のノート' : '手元カメラ';
  try {
    const r = await generate('note', {
      schema: NOTE_SCHEMA,
      turns: [{
        role: 'user',
        parts: [
          ...(prev ? [{ text: `前回の${where}${elapsed > 0 ? `（約${Math.round(elapsed)}秒前）` : ''}：` }, { image: prev }] : []),
          { text: `今回の${where}：` },
          { image },
          { text: notePrompt(pad, !!prev) },
        ],
      }],
    });
    const raw = JSON.parse(r.text || '{}') as Partial<NoteReading>;
    const readable = raw.readable !== false;
    const reading: NoteReading = {
      observation: raw.observation ?? '',
      readable,
      unreadableReason: readable ? '' : raw.unreadableReason ?? '',
      progress: PROGRESS.includes(raw.progress as NoteProgress) ? raw.progress as NoteProgress : 'unknown',
    };
    res.json({ ...reading, usage: r.usage, ms: r.ms, model: r.model, config: r.config });
  } catch (e) {
    console.error('[ai] read-note', e);
    sendError(res, e, '読み取りに失敗しました');
  }
});

// チャットモードの家トモ（文字で返事をする。声は出さない）。会話モードは Gemini Live（live.ts）
type ChatTurn = { role: 'user' | 'tomo'; text: string };

/**
 * チャットモードの家トモとの会話。context はいまの勉強の様子
 * summary：古い会話の要約（summary.ts。history はそれより後の発言）
 * session：学習の回の id。あれば、生徒の発言（student が true のとき）と家トモの返事を保存する
 * image：声かけの合図のとき、その状態の根拠になったノートの画像（data URL。興味・節目・回復の合図なら、最後に読み取ったノートの画像）
 * cueScreen：興味・節目・回復の合図のとき、共有している画面のいまの1コマ（data URL）。合図といっしょにそのまま見せる
 * screen：画面を共有しているとき、生徒の発言といっしょに送る、いまの画面の画像（data URL）。AI が look_at_screen を呼んだときだけ AI に見せる
 * note：生徒の発言といっしょに送る、いまの手元のノートの画像（data URL）。AI が look_at_note を呼んだときだけ AI に見せる
 * timer：計っている時間（{ elapsedMs, minutes }。計っていなければ null）。AI が timer で変えたら、返事の timer に変えたあとの状態を入れる（変えていなければ入れない）
 * lookedAtScreen・lookedAtNote：AI が画面・ノートを見たか
 * study：AI が pause_study で一時中断する（pause）・続ける（continue）と決めた（呼んでいなければ入れない）
 * summary：入力がコンテキストウィンドウの 80% をこえたので、学習の回の古い会話を要約した（session があるときだけ。会話モードと同じくサーバーが要約する）。
 *   画面はお知らせを出し、次からこの要約を送って、履歴は直近の発言だけにする。要約しなかった・できなかったときは入れない
 * usage：いまの会話の量（tokens：入力のトークン数、summaryAt：要約を始める量、limit：コンテキストウィンドウ）。画面はメーターに出す
 */
ai.post('/chat', async (req, res) => {
  const history = (Array.isArray(req.body?.history) ? req.body.history : []) as ChatTurn[];
  const message = String(req.body?.message ?? '').trim();
  if (!message) { res.status(400).json({ error: 'メッセージが空です' }); return; }
  const context = typeof req.body?.context === 'string' ? req.body.context : '';
  const image = parseImage(req.body?.image);
  const screen = parseImage(req.body?.screen);
  const note = parseImage(req.body?.note);
  const cueScreen = parseImage(req.body?.cueScreen);
  const summary = typeof req.body?.summary === 'string' ? req.body.summary : '';
  // 学習の回があれば、生徒の発言（student。合図・知らせは保存しない）と家トモの返事を保存する。保存できなくても返事はする
  const session = typeof req.body?.session === 'string' ? req.body.session : '';
  const save = (who: 'me' | 'tomo', text: string) =>
    session ? addMessage(req.uid!, session, who, text).catch((e) => console.error('[ai] 会話を保存できません', (e as Error).message)) : undefined;
  // チャットで話すと、会話モードの続き（Gemini Live の再開ハンドル）には入らない会話ができるので、次に会話モードでつなぐときは会話履歴を渡す（live.ts）
  if (session) await saveLiveResume(req.uid!, session, null).catch((e) => console.error('[ai] 会話モードの続きを消せません', (e as Error).message));
  if (req.body?.student === true) await save('me', message);
  let lookedAtScreen = false, lookedAtNote = false;
  let timer = fromWire(req.body?.timer), timerChanged = false;
  let study: StudyAction | undefined;
  const tools = forChat({
    screen: async () => { lookedAtScreen = !!screen; return screen; },
    note: async () => { lookedAtNote = !!note; return note; },
    timer: { get: () => timer, set: (s) => { timer = s; timerChanged = true; } },
    study: (a) => { study = a; },
  });
  const system = [chatSystem(), summary && `この学習の回の、ここまでの会話の要約：\n${summary}`, context && `いまの勉強の様子：\n${context}`].filter(Boolean).join('\n\n');
  try {
    const r = await generate('chat', {
      system,
      turns: [
        ...history.map((t) => ({ role: t.role === 'tomo' ? 'model' as const : 'user' as const, parts: [{ text: String(t.text) }] })),
        { role: 'user', parts: [
          { text: message },
          ...(image ? [{ text: isInterestCue(message) ? NOTE_NOW_LABEL : EVIDENCE_LABEL }, { image }] : []),
          ...(cueScreen ? [{ text: SCREEN_NOW_LABEL }, { image: cueScreen }] : []),
        ] },
      ],
      tools,
    });
    await save('tomo', r.text);
    const summarized = session && r.usage.prompt > summaryThreshold('chat') ? await compact(req.uid!, session) : null;
    res.json({ reply: r.text.trim(), lookedAtScreen, lookedAtNote, ...(timerChanged ? { timer: toWire(timer) } : {}), ...(study && { study }), ...(summarized && { summary: summarized }),
      usage: { tokens: r.usage.prompt, summaryAt: summaryThreshold('chat'), limit: modelInfo(r.model)?.contextTokens ?? 128_000 }, ms: r.ms, model: r.model });
  } catch (e) {
    console.error('[ai] chat', e);
    sendError(res, e, '家トモが答えられませんでした');
  }
});

/** 会話が長くなったとき、学習の回の古い会話を要約して保存する（チャットモード。会話モードは live.ts がする）。要約するものがない・できなければ null（会話は続ける） */
async function compact(uid: string, session: string) {
  try {
    const r = await summarize(uid, session);
    return r.updated ? r.summary : null;
  } catch (e) {
    console.error('[ai] summarize', (e as Error).message);
    return null;
  }
}
