import { useCallback, useRef, useState } from 'react';
import { aiApi, type ChatExtra, type ChatReply, type ChatTurn, type Summary } from './api';
import type { TimerWire } from './timer';
import { debugLog } from './debug';

// チャットモードの家トモ：チャットのモデル（「管理者設定」の chat）と文字で話す。家トモは声を出さない
// 会話の続き（古い会話の要約と、それより後の発言）はここで持ち、毎回サーバーに送る
// 会話が長くなったら、サーバーが学習の回の古い会話を要約して返事といっしょに返す（summary）。そのあとは要約を送り、履歴は直近 KEEP 発言だけを残す

/** 会話が長くなって古い会話を要約するときに、家トモが言うこと（会話の欄に出す。保存はしない。サーバーの summary.ts と同じ） */
export const SUMMARY_NOTICE = 'そろそろ会話の量が増えてきたから、古い内容は要約していくね。';
const KEEP = 10; // 要約したあとに残す、直近の発言の数（サーバーの summary.ts と同じ）

export function useChatTomo() {
  const [thinking, setThinking] = useState(false);
  const history = useRef<ChatTurn[]>([]);
  const summary = useRef('');
  const busy = useRef(false);

  /**
   * 生徒の発言を送って、家トモの返事を受け取る。考え中に送られたもの・失敗したときは null
   * context はいまの勉強の様子
   * image は声かけの合図の根拠になったノートの画像、screen は共有している画面のいまの画像、note は手元のノートのいまの画像（どれも会話の続きには残さない）
   * timer はいま計っている時間（計っていなければ null）
   * extra：cueScreen は興味の合図のとき、共有している画面のいまの1コマ（合図といっしょにそのまま見せる）。session・student はサーバーが会話を保存するのに使う
   */
  const ask = useCallback(async (said: string, context?: string, image?: string, screen?: string, note?: string, timer?: TimerWire | null, extra?: Omit<ChatExtra, 'summary'>): Promise<ChatReply | null> => {
    if (busy.current) return null;
    busy.current = true;
    setThinking(true);
    try {
      const r = await aiApi.chat(said, history.current, context, image, screen, note, timer, { ...extra, summary: summary.current || undefined });
      history.current = [...history.current, { role: 'user' as const, text: said }, { role: 'tomo' as const, text: r.reply }];
      if (r.summary) {
        summary.current = r.summary.text;
        history.current = history.current.slice(-KEEP); // 画面が持っている直近の発言を残す（覚えているだけで保存しないセリフも入る）
      }
      return r;
    } catch (e) {
      debugLog.event('チャットのエラー', (e as Error).message);
      return null;
    } finally {
      busy.current = false;
      setThinking(false);
    }
  }, []);

  /** 家トモが自分から言ったこと（台本のセリフ・ノートの声かけ）も、会話の続きとして覚えておく。会話モードのあいだの発言（role）も覚えて、チャットモードに変えたら続きから話す */
  const remember = useCallback((text: string, role: ChatTurn['role'] = 'tomo') => {
    history.current = [...history.current, { role, text }];
  }, []);

  const reset = useCallback(() => { history.current = []; summary.current = ''; }, []);

  /** これまでの会話（学習の回を続きから開いたとき。古い会話の要約と、それより後の発言）を、会話の続きにする */
  const load = useCallback((turns: ChatTurn[], s?: Summary) => { history.current = turns; summary.current = s?.text ?? ''; }, []);

  return { thinking, ask, remember, reset, load };
}
