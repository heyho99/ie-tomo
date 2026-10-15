import { useEffect, useRef } from 'react';
import { continueTimes, useContinueCheck, type ContinueSnapshot } from './continueCheck';
import { debugLog } from './debug';
import type { FaceNudge, FaceView } from './face';
import { useInterestNudge, type InterestCue, type InterestSnapshot } from './interestNudge';
import { useNoteNudge, type Nudge, type useNoteReader } from './noteReader';
import { useNudgeRules } from './nudgeRules';
import { minutesText, pomodoroAt, timerEnd, type Timer } from './timer';
import type { TomoChannel } from './tomo';

// 声かけの合図の調停（どの合図を・いつ・どんな文で家トモに送るか）。学習画面は表示だけをする
// 合図はプログラムが出し、何を言うかは Gemini Live・チャットの AI が考える（送り先は TomoChannel が決める）
//   困りごと：ノートが読み取れない・手が止まっている（noteReader.ts）、眠そう・下を向いている（face.ts。FaceCamera が onFaceNudge を呼ぶ）
//   興味・節目・回復：順調に勉強しているあいだ（interestNudge.ts）。回復は困りごとの合図のあとでよくなったとき
//   続けるかの確認：放置されたまま動きつづけないよう、一時中断する時刻の3分前にたずねる（continueCheck.ts）
//   タイマーの知らせ：家トモが計っている時間になった・ポモドーロが切りかわった
// 家トモが話している・考えているあいだ（quiet）は待つ。合図を出したら、興味の合図の「最後に話してから」を数えなおす

type Options = {
  tomo: TomoChannel;
  ready: boolean; // 学習の回を読みこんだ
  paused: boolean;
  pausing: boolean; // 家トモが一時中断すると決めた（話し終わったら一時中断する）
  quiet: boolean; // 家トモが話している・考えている
  note: ReturnType<typeof useNoteReader>;
  hand: { name: string; on: boolean; off: boolean; pad: boolean }; // 手元ノートの入力元の名前、映っているか、使わないか、iPad か
  face: { view: FaceView | null; down: boolean; closed: boolean };
  screen: { shown: boolean; capture: () => string | null }; // 画面を共有していて、家トモが見られる
  canPause: boolean; // pause_study が使える（オフなら続けると答えても伝わらないので、たずねない）
  timer: Timer | null;
  now: number;
  onTimerDone: () => void; // タイマーが時間になった（計るのをやめる）
  onTimeout: (note: string) => void; // 続けるかの確認に返事がなかった（一時中断する）
  restore?: { interest?: InterestSnapshot; check?: ContinueSnapshot | null };
};

export function useNudgeHub(o: Options) {
  const { tomo, note, hand } = o;
  const rules = useNudgeRules();
  const running = o.ready && !o.paused && tomo.on; // 合図を数える（一時中断のあいだ・AI が使えないときは数えない）
  const troubled = useRef({ stuck: false, down: false, sleepy: false }); // 困りごとの合図を出したあと、まだよくなっていない（よくなったら回復の合図）

  // ノートが見えない・手が止まっているときに声をかける
  useNoteNudge(note.reading, o.quiet, rules?.note ?? null, (n) => {
    const text = noteText(n);
    debugLog.event('ノートの様子で声かけの合図', text);
    interest.cued();
    if (n.kind === 'stuck') troubled.current.stuck = true;
    tomo.nudge(text, n.image);
  });

  // 下を向きつづけていたら声をかけるか
  // 手元ノートがオン（手元カメラが映っている・iPad がつながっている）：ノートに変化がない（最後の判定が「手が止まっている」）ときだけ
  // 手元ノートがオフ（使わない・カメラを切っている・つながっていない）：手元が見えないので、下を向いているだけで
  const noteOn = !hand.off && hand.on;
  const downNudge = noteOn ? note.reading?.progress === 'stuck' : true;
  // 顔カメラで眠そう・下を向いているとわかったときに声をかける（顔の画像は送らず、様子の文だけを渡す）
  function onFaceNudge(n: FaceNudge) {
    if (!o.ready) return;
    const text = faceText(n);
    debugLog.event('顔の様子で声かけの合図', text);
    interest.cued();
    if (n.kind === 'down') troubled.current.down = true;
    if (n.kind === 'sleepy') troubled.current.sleepy = true;
    tomo.nudge(text);
  }

  // 順調に勉強しているあいだの声かけ（興味・節目・回復の合図）
  const interest = useInterestNudge({
    rules: rules?.interest ?? null,
    running,
    quiet: o.quiet,
    nudge: (c) => {
      if (!o.ready) return;
      const text = interestText(c);
      debugLog.event(`声かけの合図（${c.kind}）`, text);
      tomo.nudge(text, note.reading?.image, c.kind, (o.screen.shown && o.screen.capture()) || undefined);
    },
    restore: o.restore?.interest,
  });
  // 困りごとの合図のあとで、よくなったら回復の合図（ノートがまた進みはじめた・顔を上げた・目を開けた）
  useEffect(() => {
    if (note.reading?.readable && note.reading.progress === 'working' && troubled.current.stuck) { troubled.current.stuck = false; interest.recovered('stuck'); }
  }, [note.reading]);
  useEffect(() => {
    if (o.face.view === 'face' && !o.face.down && troubled.current.down) { troubled.current.down = false; interest.recovered('down'); }
  }, [o.face.view, o.face.down]);
  useEffect(() => {
    if (o.face.view === 'face' && !o.face.closed && troubled.current.sleepy) { troubled.current.sleepy = false; interest.recovered('sleepy'); }
  }, [o.face.view, o.face.closed]);

  // 一時中断する時刻（はじめは勉強を続けて30分）の3分前に、続けるかを家トモにたずねてもらう
  // 続けると答えたら一時中断する時刻を30分のばし、続けないと答えたら家トモが一時中断する（pause_study）。返事がなければ3分後に一時中断する
  const keepGoing = useContinueCheck({
    running: running && !o.pausing && o.canPause,
    quiet: o.quiet,
    ask: (ms) => {
      if (!o.ready) return;
      const { warn } = continueTimes();
      const text = `勉強を続けて${minutesText(Math.round(ms / 1000) / 60)}たちました。${minutesText(warn / 60)}のうちに続けると返事がなければ、一時中断します。`;
      debugLog.event('続けるかの確認', text);
      interest.cued();
      tomo.check(text);
    },
    timeout: () => {
      debugLog.event('続けるかの確認に返事がなかったので、一時中断する');
      o.onTimeout(`${minutesText(continueTimes().warn / 60)}のあいだ返事がなかったので、一時中断しました。`);
    },
    restore: o.restore?.check ?? undefined,
  });

  // タイマーが時間になったら（ポモドーロは集中・休憩が切りかわったときも）、家トモに知らせる
  // 話している・考えている・一時中断のあいだは待つ（待つあいだに何度か切りかわったら、いまの段階だけを知らせる）
  const { timer, now } = o;
  const end = timer && timerEnd(timer);
  const told = useRef({ startedAt: 0, stage: 0 }); // ポモドーロで、どの段階まで知らせたか
  if (timer?.pomodoro && told.current.startedAt !== timer.startedAt) told.current = { startedAt: timer.startedAt, stage: pomodoroAt(timer.pomodoro, Date.now() - timer.startedAt).stage };
  useEffect(() => {
    if (!timer?.minutes || !end || o.quiet || o.paused || !o.ready) return;
    const p = timer.pomodoro;
    let text = '';
    if (now >= end) {
      text = p ? `ポモドーロ（${minutesText(p.work)}集中・${minutesText(p.rest)}休憩を${p.rounds}回）が終わりました。` : `${minutesText(timer.minutes)}のタイマーが時間になりました。`;
      o.onTimerDone();
    } else if (p) {
      const at = pomodoroAt(p, now - timer.startedAt);
      if (at.stage <= told.current.stage) return;
      told.current.stage = at.stage;
      text = at.working
        ? `ポモドーロの休憩が終わりました。${at.round}回目（全${p.rounds}回）の集中（${minutesText(p.work)}）を始めます。`
        : `ポモドーロの${at.round}回目（全${p.rounds}回）の集中が終わりました。${minutesText(p.rest)}休憩です。`;
    } else return;
    debugLog.event('タイマーの知らせ', text);
    tomo.notice(text);
  }, [now, end, o.quiet, o.paused]);

  /** ノートの合図で AI に渡す、生徒の様子 */
  function noteText(n: Nudge) {
    return n.kind === 'unreadable' ? `${hand.name}でノートが読み取れません（理由：${n.reason || 'わからない'}）。`
      : `${hand.name}の画像の判定で${n.count}回続けて、ノートが変わっていません（手が止まっている）。`;
  }

  /** 興味・節目・回復の合図で AI に渡す、生徒の様子（最近のノートの様子もつける） */
  function interestText(c: InterestCue) {
    const head = c.kind === '回復'
      ? c.from === 'stuck' ? 'さっき手が止まっていましたが、またノートが進みはじめました。'
        : c.from === 'down' ? 'さっき下を向いたままでしたが、また顔を上げて取り組んでいます。'
        : 'さっき目を閉じていて眠そうでしたが、また目を開けて取り組んでいます。'
      : c.kind === '節目' ? `勉強を始めて${c.milestoneMin}分たちました。ずっと続けて取り組んでいます。`
      : `集中して取り組んでいます。勉強を始めて${c.elapsedMin}分、最後に話してから${c.quietMin}分です。`;
    const t = Date.now();
    const seen = note.recent.map((r, i) => {
      const min = Math.round((t - r.at) / 60_000);
      return `- ${i === note.recent.length - 1 && min < 2 ? 'いま' : `${min}分前`}：${r.observation}`;
    });
    return [head, seen.length ? `最近のノートの様子：\n${seen.join('\n')}` : '', o.screen.shown ? '画面を共有しています（いまの画面の画像つき）。' : ''].filter(Boolean).join('\n');
  }

  /** 顔カメラの合図で AI に渡す、生徒の様子 */
  function faceText(n: FaceNudge) {
    if (n.kind === 'sleepy') return `顔カメラの表情の解析で、目を閉じているのが${n.sec}秒続いています（眠そう）。`;
    return noteOn
      ? `顔カメラの解析で、${n.sec}秒続けて下を向いています。でも${hand.name}のノートには変化がありません（手が止まっている。スマホなど、勉強と関係ないものを見ているかもしれない）。`
      : `顔カメラの解析で、${n.sec}秒続けて下を向いています。${hand.off ? '手元ノートは使っていない' : hand.pad ? 'iPad がつながっていない' : '手元カメラがオフな'}ので、手元で何をしているかはわかりません（スマホなど、勉強と関係ないものを見ているかもしれない）。`;
  }

  return {
    onFaceNudge, // FaceCamera に渡す
    downNudge, // 下を向いていたら声をかけるか（FaceCamera に渡す）
    /** 生徒・家トモが話した（興味の合図の「最後に話してから」を数えなおす） */
    talked: interest.talked,
    /** 家トモが続けると決めた（pause_study） */
    continued: keepGoing.continued,
    peek: keepGoing.peek, // 続けるかの確認のいまの状態（勉強した時間のバーに出す）
    /** リロードのまえに覚えておくもの */
    snapshot: () => ({ interest: interest.snapshot(), check: keepGoing.snapshot() }),
  };
}
