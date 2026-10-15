import { useEffect, useRef, useState } from 'react';
import type { AiStatus, ContextUsage } from './api';
import { SUMMARY_NOTICE, useChatTomo } from './chat';
import { debugLog } from './debug';
import type { CueKind } from './interestNudge';
import { useLiveTomo } from './live';
import type { TimerWire } from './timer';

// 家トモとの話し口（TomoChannel）。学習画面は話し方（会話モード・チャットモード）を気にせず、ここに話しかける
// 会話モード：Gemini Live と声で話す（live.ts）。チャットモード：チャットのモデルと文字で話す（chat.ts）
// どちらの返事・家トモの発言も、同じ知らせ（Events）で学習画面に返す

/** 学習画面に返す知らせ */
export type TomoEvents = {
  onStudent: (text: string) => void; // 生徒の発言（文字で話しかけた・声で言いおわった）。会話の欄に出す
  onTomo: (text: string) => void; // 家トモの発言（返事・セリフ・おわび・要約のお知らせ）。会話の欄に出す
  onTimer: (state: TimerWire | null) => void; // 家トモが時間を計りはじめた・やめた（timer）
  onStudy: (action: 'pause' | 'continue') => void; // 家トモが一時中断する・続けると決めた（pause_study）
  onLooked: (what: 'screen' | 'note') => void; // 家トモが画面・ノートを見た（look_at_screen・look_at_note）
};

type Options = TomoEvents & {
  voiceMode: boolean; // 会話モード（false ならチャットモード）
  ai: AiStatus | null;
  sessionId: string;
  ready: boolean; // 学習の回を読みこんだ（つなぐ・チャットで送る）
  paused: boolean;
  settings: { micOn: boolean; voiceOn: boolean; micId: string; liveVoice: string };
  context: string; // いまの勉強の様子（変わったら会話モードは Gemini Live に知らせなおす。チャットモードは毎回送る）
  timerNow: () => TimerWire | null; // いま計っている時間
  captureScreen: () => string | null; // 共有している画面のいまの1コマ（共有していなければ null）
  captureNote: () => string | null; // 手元のノートのいまの画像（使っていない・映っていなければ null）
};

const NO_AI = 'すみません、いまは AI が使えないのでお話しできません。（server/.env の設定を確認してください）';
const FAILED = 'すみません、うまく答えられませんでした。もう一度話しかけてみてください。';

/** チャットモードで送るもの。image：合図の根拠のノート、screen・note：生徒の発言のときのいまの画像、cueScreen：興味の合図のときの画面、student：生徒の発言 */
type Ask = { image?: string; screen?: string; note?: string; cueScreen?: string; student?: boolean };

export function useTomoChannel(o: Options) {
  const liveOn = o.voiceMode && !!o.ai?.purposes.live.ready;
  const chatOn = !o.voiceMode && !!o.ai?.purposes.chat.ready;
  const screenTool = o.ai?.tools.look_at_screen ?? false;
  const noteTool = o.ai?.tools.look_at_note ?? false;
  const cb = useRef(o);
  cb.current = o;
  // 会話の量（コンテキストウィンドウのどのくらいか）と、この画面を開いてから古い会話を要約した回数。話し方ごとに持つ（モデルがちがうため）
  const [usage, setUsage] = useState<{ voice?: ContextUsage; chat?: ContextUsage }>({});
  const [summaries, setSummaries] = useState(0);

  const chat = useChatTomo();
  const live = useLiveTomo({
    enabled: liveOn && o.ready,
    sessionId: o.sessionId, // サーバーがこの回のこれまでの会話を読んで、Gemini Live に渡す
    micOn: o.settings.micOn && !o.paused,
    voiceOn: o.settings.voiceOn,
    micId: o.settings.micId,
    voice: o.settings.liveVoice,
    onStudent: (t) => {
      debugLog.event('生徒の発言（Live）', t);
      cb.current.onStudent(t);
      chat.remember(t, 'user'); // チャットモードに変えたら続きから話す
    },
    onTomo: (t) => {
      debugLog.event('家トモの発話（Live）', t);
      cb.current.onTomo(t); // 声はもう出ているので、読み上げずに会話に足す
      chat.remember(t);
    },
    captureScreen: () => { const image = cb.current.captureScreen(); if (image) cb.current.onLooked('screen'); return image; },
    captureNote: () => { const image = cb.current.captureNote(); if (image) cb.current.onLooked('note'); return image; },
    timerNow: () => cb.current.timerNow(),
    onTimer: (w) => cb.current.onTimer(w),
    onStudy: (a) => cb.current.onStudy(a),
    onSummary: (t) => { cb.current.onTomo(t); setSummaries((n) => n + 1); }, // 声はサーバーが Gemini Live に言わせる
    onUsage: (u) => setUsage((x) => ({ ...x, voice: u })),
  });

  // 勉強の様子が変わったら Gemini Live に知らせる（セリフより先に送る）
  useEffect(() => {
    if (liveOn && o.ready) live.context(o.context);
  }, [liveOn, o.ready, o.context]);

  // セリフは Gemini Live に言わせる（つながるまえのセリフは、つながってから言う）
  // 話し方を変えたときは、それまでのセリフをもう一度言わない
  const [line, setLine] = useState('');
  const saidLine = useRef('');
  useEffect(() => { saidLine.current = line; }, [o.voiceMode]);
  useEffect(() => {
    if (!liveOn || !line || saidLine.current === line) return;
    saidLine.current = line;
    live.say(line);
  }, [line, liveOn]);
  useEffect(() => { if (line) debugLog.event('家トモの発話', line); }, [line]);

  /** チャットモードで送って、返事を知らせる */
  async function ask(said: string, a: Ask = {}) {
    const e = cb.current;
    const r = await chat.ask(said, e.context, a.image, a.screen, a.note, e.timerNow(), { cueScreen: a.cueScreen, session: e.sessionId, student: !!a.student });
    if (!r) { e.onTomo(FAILED); return; }
    if (r.timer !== undefined) { e.onTimer(r.timer); debugLog.event('チャット：家トモが時間を計る', r.timer ? JSON.stringify(r.timer) : 'やめた'); }
    if (r.study) { debugLog.event(`チャット：家トモが${r.study === 'pause' ? '一時中断する' : '勉強を続ける'}と決めた`); e.onStudy(r.study); }
    debugLog.event('家トモの返事（チャット）', r.reply);
    if (r.lookedAtScreen) { e.onLooked('screen'); debugLog.event('チャット：家トモが画面を見た'); }
    if (r.lookedAtNote) { e.onLooked('note'); debugLog.event('チャット：家トモがノートを見た'); }
    e.onTomo(r.reply);
    if (r.usage) setUsage((x) => ({ ...x, chat: r.usage }));
    // 会話が長くなったので、サーバーが古い会話を要約した
    if (r.summary) {
      debugLog.event('チャット：会話が長くなったので、古い会話を要約した');
      e.onTomo(SUMMARY_NOTICE);
      setSummaries((n) => n + 1);
    }
  }
  /** 合図・知らせ。会話モードはそのまま Gemini Live に、チャットモードは印をつけて送る */
  const cue = (label: string, text: string, a?: Ask) => { if (chatOn && cb.current.ready) void ask(`（${label}）${text}`, a); };

  return {
    liveOn, chatOn,
    on: liveOn || chatOn, // いまの話し方の AI が使える
    live, chat, usage: o.voiceMode ? usage.voice : usage.chat, summaries,
    thinking: !o.voiceMode && chat.thinking, // 返事を考え中（チャットモード）
    speaking: live.speaking, // 家トモが話している（会話モード）

    /** 生徒の話しかけ（文字でも声でも）。返事を考え中（チャットモード）のときは受けつけない（false） */
    say(text: string) {
      const said = text.trim();
      debugLog.event('生徒の発言', !o.voiceMode && chat.thinking ? `${said}（考え中なので無視）` : said);
      if (!said || (!o.voiceMode && chat.thinking)) return false;
      o.onStudent(said);
      if (o.voiceMode) chat.remember(said, 'user'); // チャットモードは chat.ask が覚える
      if (liveOn) live.text(said);
      else if (chatOn && o.ready) void ask(said, { screen: (screenTool && o.captureScreen()) || undefined, note: (noteTool && o.captureNote()) || undefined, student: true });
      else o.onTomo(NO_AI);
      return true;
    },
    /** 家トモのセリフ（あいさつなど。台本どおりに言う）。会話の欄に出し、チャットのモデルにも覚えさせる。決まり文句なので保存しない */
    line(text: string) {
      setLine(text);
      o.onTomo(text);
      chat.remember(text); // 会話モードでも覚えておく（チャットモードに変えたら続きから話す）
    },
    /**
     * 声かけの合図（何を言うかは AI が考える）。image は根拠になったノートの画像
     * kind：興味・節目・回復の合図のとき（image は最後に読み取ったノート、screen は共有している画面のいまの1コマ）
     */
    nudge(...args: [text: string, image?: string, kind?: CueKind, screen?: string]) {
      const [text, image, kind, screen] = args;
      if (liveOn) live.nudge(...args);
      else cue(kind ? `声かけの合図・${kind}` : '声かけの合図', text, { image, cueScreen: screen });
    },
    /** タイマーの知らせ（時間になった） */
    notice(text: string) {
      if (liveOn) live.notice(text);
      else cue('タイマーの知らせ', text);
    },
    /** 続けるかの確認 */
    check(text: string) {
      if (liveOn) live.check(text);
      else cue('続けるかの確認', text);
    },
    /** 画面で計る時間を変えた（会話モードは Gemini Live に知らせる。チャットモードは毎回送るので何もしない） */
    timer(state: TimerWire | null) {
      if (liveOn) live.timer(state);
    },
    /** 家トモの声を止める（一時中断） */
    hush: live.hush,
  };
}

export type TomoChannel = ReturnType<typeof useTomoChannel>;
