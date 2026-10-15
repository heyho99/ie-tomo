import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { aiApi, api, type AiStatus, type Message, type StudySession } from '../api';
import type { Capture } from '../capture';
import { ContextMeter } from '../components/ContextMeter';
import { FaceCamera } from '../components/FaceCamera';
import { HandCamera, cameraCapture } from '../components/HandCamera';
import { Header } from '../components/Header';
import { GearIcon, MicIcon, PcIcon, PhoneIcon, TomoIcon, VoiceIcon } from '../components/Icons';
import { PadNote } from '../components/PadNote';
import { ScreenDraw, ScreenStage } from '../components/ScreenInk';
import { continueTimes, type ContinueState } from '../continueCheck';
import { debugLog } from '../debug';
import type { FaceView } from '../face';
import { screenShareSupported, useScreenShare } from '../screen';
import { PROGRESS_CHIP, PROGRESS_LABEL, useNoteReader } from '../noteReader';
import { useNudgeHub } from '../nudgeHub';
import { SettingsScope, useSessionSettings, useSettings } from '../settings';
import { SessionSettingsPanel } from '../components/SessionSettings';
import { speechSupported, useListening } from '../speech';
import { clockText, fromWire, minutesText, pomodoroAt, timerEnd, toWire, useTick, type Timer } from '../timer';
import { useTomoChannel } from '../tomo';
import { closeSpans, restoreOnReload, studyTotals, useSaveOnLeave, useStudySpans, type StudySpan } from '../studyTime';

/** 時間帯のあいさつ（日本時間）。4〜10時台はおはようございます、11〜17時台はこんにちは、それ以外はこんばんは */
function greeting(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour >= 4 && hour < 11 ? 'おはようございます。' : hour >= 11 && hour < 18 ? 'こんにちは。' : 'こんばんは。';
}

// 学習画面：生徒は自分で選んだ Web ページや本などで自分のペースで勉強し、家トモはとなりで見守って会話する
// 教材はアプリに登録しない。見ている画面について聞きたいときは、画面共有で家トモに見せる

const SIDE_MIN = 280; // 右の列（画面・顔・ノート）のいちばん細い幅
const MAIN_MIN = 360; // 中央の列（家トモとの会話）のいちばん細い幅

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function Study() {
  const { id = '' } = useParams();
  return <StudyScoped key={id} id={id} />;
}

// 授業の画面で変えた設定は、この会話内だけで使う（「設定」の設定は変えない。settings.ts の useSessionSettings）
// 画面の中の部品（カメラ・ノートの読み取りなど）も useSettings でこの会話内の設定を使う
function StudyScoped({ id }: { id: string }) {
  const scope = useSessionSettings(id);
  return <SettingsScope value={scope.pair}><StudyRoom scope={scope} /></SettingsScope>;
}

function StudyRoom({ scope }: { scope: ReturnType<typeof useSessionSettings> }) {
  const { id = '' } = useParams();
  const { key: navKey } = useLocation();
  // リロードしたときは、あいさつをせず、勉強した時間のバーと続けるかの確認をそのまま続ける（studyTime.ts）
  const [restored] = useState(() => restoreOnReload(id, navKey));
  const [settings, setSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false); // この会話内の設定を開いている
  const clock = useClock();

  const [session, setSession] = useState<StudySession | null>(null);
  const [error, setError] = useState('');
  const [log, setLog] = useState<{ id: number; who: 'tomo' | 'me'; text: string }[]>([]); // 会話の記録
  const [tutor, setTutor] = useState(''); // 家トモのセリフ（会話モードは Gemini Live に言わせる）
  const logId = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // 会話のいちばん下を見ているか（上にスクロールして読み返しているあいだは、勝手に下へ動かさない）
  const [talk, setTalk] = useState('');
  const [handOn, setHandOn] = useState(false);
  const [faceView, setFaceView] = useState<FaceView | null>(null); // 顔カメラに何が映っているか（止まっているときは null）
  const [faceDown, setFaceDown] = useState(false); // 顔カメラで下を向いているか
  const [faceClosed, setFaceClosed] = useState(false); // 顔カメラで目を閉じているか
  const [paused, setPaused] = useState(restored?.paused != null); // 一時中断中はカメラと読み上げを止める（リロードしても一時中断のまま）
  const [pauseNote, setPauseNote] = useState(restored?.paused ?? ''); // 一時中断したわけ（一時中断の画面に出す。ボタンで止めたときは空）
  const [pausing, setPausing] = useState(false); // 家トモが一時中断すると決めた（話し終わったら一時中断する）
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [padCapture, setPadCapture] = useState<Capture | null>(null);
  const onPadCapture = useCallback((c: Capture | null) => setPadCapture(() => c), []);
  const gridRef = useRef<HTMLDivElement>(null);
  // 家トモが計っている時間（timer ツール）。チャットモードは毎回サーバーに送り、会話モードは変わったときに送り合う
  const [timer, setTimer] = useState<Timer | null>(restored?.timer ?? null); // リロードしても続ける（計りはじめた時刻で数えるので、そのまま使える）
  const timerRef = useRef<Timer | null>(timer);
  const changeTimer = (t: Timer | null) => { timerRef.current = t; setTimer(t); };

  useEffect(() => { aiApi.status().then(setAi).catch(() => undefined); }, []);
  const spans = useStudySpans(!!session, paused, restored?.spans); // 勉強していた・一時中断していた時間（バーに出す）
  const spansRef = useRef(spans);
  spansRef.current = spans;

  // 手元（ノート）の入力元は「設定」で選ぶ（settings.handSource）。手元カメラか、iPad のノート（PadNote）か、使わない
  const noteOff = settings.handSource === 'none';
  const padMode = settings.handSource === 'pad';
  const handName = noteOff ? '手元ノート' : padMode ? 'iPad' : '手元カメラ';
  const capture = useMemo(() => (noteOff ? null : padMode ? padCapture : video && cameraCapture(video)), [noteOff, padMode, padCapture, video]);
  // 勉強しているあいだ、手元のノートの様子を AI で見る（AI が設定されているときだけ）
  const note = useNoteReader(capture, !!ai?.purposes.note.ready && !paused);
  // 家トモが使えるツール（管理者設定でオン・オフ）。オフなら画面共有の欄は出さず、チャットモードでも画面・ノートの画像を送らない
  const screenTool = ai?.tools.look_at_screen ?? false;
  const [noteLook, setNoteLook] = useState(0); // 家トモが最後にノートを見た時刻（look_at_note。0 はまだ見ていない）
  /** 手元のノートのいまの画像（家トモが look_at_note で見たいとき）。大きさ・画質・向きはノートの読み取りと同じ。使っていない・映っていなければ null */
  const noteImage = () => capture?.({ maxSide: settings.noteMaxSide || Infinity, quality: settings.noteQuality, rotate: settings.handCameraRotate })?.image ?? null;

  // 家トモとの話し方は「設定」で選ぶ（settings.talkMode）
  // 会話モード：Gemini Live と声で話す（聞き取り・話しはじめの判定・読み上げも Gemini Live がする）。チャット欄はない
  // チャットモード：チャットのモデルと文字で話す。マイクの声はブラウザで文字にして送る。家トモは声を出さない
  // どちらも tomo（TomoChannel。tomo.ts）に話しかけ、返事は同じ知らせで受ける
  const voiceMode = settings.talkMode === 'voice';
  const screen = useScreenShare(); // 見ている画面を家トモに見せる（家トモが見たいときだけ1コマ渡す）
  const [drawing, setDrawing] = useState(false); // 共有している画面を大きく映して書き込んでいる
  const tomo = useTomoChannel({
    voiceMode, ai, sessionId: id, ready: !!session, paused, settings,
    context: session ? studyContext(session) : '',
    timerNow: () => toWire(timerRef.current),
    captureScreen: () => screen.capture(),
    captureNote: noteImage,
    onStudent: studentSays,
    onTomo: addTomo,
    onTimer: (w) => changeTimer(fromWire(w)),
    onStudy,
    onLooked: (what) => (what === 'screen' ? screen.looked() : setNoteLook(Date.now())),
  });
  const { live, chat, speaking } = tomo;

  /** 家トモの発言を会話の欄に足す（保存は発言を受けたサーバーがする） */
  function addTomo(text: string) {
    nudges.talked('tomo');
    setLog((g) => [...g, { id: ++logId.current, who: 'tomo' as const, text }].slice(-200));
  }
  /** 生徒の発言を会話の欄に足す（保存は発言を受けたサーバーがする） */
  function studentSays(text: string) {
    nudges.talked('me');
    setLog((g) => [...g, { id: ++logId.current, who: 'me' as const, text }].slice(-200));
  }

  // 新しい発言が来たら、いちばん下までスクロールする
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [log, chat.thinking, live.draft]);

  // マイクがオン（ミュートでない）あいだは、会話モードは声を Gemini Live に送りつづけ、チャットモードは聞き続けて言い終わるたびに送る
  // （チャットモードはブラウザの音声認識なので、ブラウザの既定のマイクを使う。家トモが考えているあいだは聞かない）
  const micOn = settings.micOn && (voiceMode || speechSupported);
  const busy = tomo.thinking; // 返事を考え中
  const listen = useListening(!voiceMode && micOn && !!session && !paused && !chat.thinking, (t) => tomo.say(t));

  // 声かけの合図（困りごと・興味・回復・続けるかの確認・タイマーの知らせ）。nudgeHub.ts
  const now = useTick(!!timer);
  const nudges = useNudgeHub({
    tomo, ready: !!session, paused, pausing, quiet: busy || speaking,
    note,
    hand: { name: handName, on: handOn, off: noteOff, pad: padMode },
    face: { view: faceView, down: faceDown, closed: faceClosed },
    screen: { shown: screenTool && screen.sharing, capture: screen.capture },
    canPause: !!ai?.tools.pause_study,
    timer, now,
    onTimerDone: () => { changeTimer(null); tomo.timer(null); },
    onTimeout: pause,
    restore: restored ?? undefined,
  });

  // リロードのまえに覚えておく。家トモが一時中断すると決めて話しているところなら、一時中断したことにする
  const leaveRef = useRef({ paused, pausing, pauseNote });
  leaveRef.current = { paused, pausing, pauseNote };
  useSaveOnLeave(id, () => {
    if (!spansRef.current.length) return null;
    const p = leaveRef.current;
    const n = nudges.snapshot();
    return {
      key: navKey, spans: closeSpans(spansRef.current, Date.now()), check: n.check,
      paused: p.paused ? p.pauseNote : p.pausing ? '' : null, timer: timerRef.current, interest: n.interest,
    };
  });
  /** 家トモが一時中断する・続けると決めた（pause_study） */
  function onStudy(a: 'pause' | 'continue') {
    if (a === 'continue') nudges.continued();
    else setPausing(true);
  }
  // 家トモが一時中断すると決めたら、話し終わってから一時中断する（話しおわってすぐに次の話が始まることがあるので、少し待つ）
  useEffect(() => {
    if (!pausing || busy || speaking) return;
    const t = setTimeout(() => pause(), 2000);
    return () => clearTimeout(t);
  }, [pausing, busy, speaking]);

  /** 画面で計るのをやめる */
  function stopTimer() {
    debugLog.event('タイマーを止めた（画面）');
    changeTimer(null);
    tomo.timer(null);
  }
  const toggleMic = () => {
    listen.clearError(); // ミュートを解除したら、マイクの許可などをもう一度ためす
    setSettings({ micOn: !settings.micOn });
  };

  useEffect(() => {
    let alive = true;
    // これまでの会話は、読めなくても勉強ははじめられる
    Promise.all([api.session(id), api.messages(id).catch(() => [] as Message[])])
      .then(([s, past]) => {
        if (!alive) return;
        // これまでの会話を画面に出し、チャットのモデルにも続きとして渡す（古い会話の要約と、それより後の発言。会話モードはサーバーが Gemini Live に渡す）
        setLog(past.map((m) => ({ id: ++logId.current, who: m.who, text: m.text })));
        const after = past.filter((m) => !s.summary || m.at > s.summary.upTo);
        chat.load(after.map((m) => ({ role: m.who === 'tomo' ? 'tomo' as const : 'user' as const, text: m.text })), s.summary);
        setSession(s);
        if (!restored) tomo.line(`${greeting()}${past.length ? '前回は何をしていたんでしたっけ？' : '今日は何を勉強するんですか？'}`); // リロードしたときはあいさつしない
      })
      .catch(() => alive && setError('学習の記録を読み込めませんでした。'));
    return () => { alive = false; };
  }, [id]);

  // 文字での話しかけ（チャットモード）
  function onTalk(e: FormEvent) {
    e.preventDefault();
    if (!talk.trim()) return;
    setTalk('');
    tomo.say(talk);
  }

  /** AI に知らせる、いまの勉強の様子。家トモが話したことは、Gemini Live・チャットの会話の続きとして AI が覚えている */
  function studyContext(s: StudySession) {
    const lines = [`学習の回：${s.title}`];
    lines.push(screen.sharing
      ? '画面共有：オン（生徒が見ている画面を家トモに見せている。画面に映っているものについて聞かれたら、その画面を見て答えられる）'
      : '画面共有：オフ（家トモには生徒の画面が見えない）');
    return lines.join('\n');
  }

  /** note：一時中断したわけ（一時中断の画面に出す） */
  function pause(note = '') {
    debugLog.event('一時中断', note);
    tomo.hush();
    setPausing(false);
    setPauseNote(note);
    setPaused(true);
  }

  // 一時中断は「一時中断」ボタンを押したときだけ。別のタブやアプリに移っても止めない（別タブの教材を手元ノートに写しながら続けられるように）
  const canPause = !!session;

  // デバッグ画面：いまの状態
  useEffect(() => { if (note.error) debugLog.event('ノート読み取りのエラー', note.error); }, [note.error]);
  useEffect(() => debugLog.state({
    session: session ? `${session.title}（${session.id}）` : null,
    screenShare: screen.sharing ? screen.label || 'オン' : 'オフ',
    talkMode: settings.talkMode, speaking, paused,
    timer: timer ? `${timer.pomodoro ? `ポモドーロ（${minutesText(timer.pomodoro.work)}・${minutesText(timer.pomodoro.rest)}・${timer.pomodoro.rounds}回）` : timer.minutes ? `${minutesText(timer.minutes)}のタイマー` : 'ストップウォッチ'}（${new Date(timer.startedAt).toLocaleTimeString('ja-JP')} から）` : 'なし',
    live: !voiceMode ? '使わない（チャットモード）' : tomo.liveOn ? `${live.status}${live.error ? `（${live.error}）` : ''}` : '使えない',
    chat: voiceMode ? '使わない（会話モード）' : tomo.chatOn ? (chat.thinking ? '考え中' : '待機') : '使えない',
    mic: !settings.micOn ? 'ミュート'
      : voiceMode ? live.micError || 'Gemini Live に送っている'
      : !speechSupported ? '使えない（音声認識に非対応）' : listen.error ? `使えない（${listen.code}）` : listen.listening ? '聞いている' : '待機',
    voiceOn: settings.voiceOn, handCamera: noteOff ? '使わない' : handOn, face: !settings.faceOn ? 'オフ' : faceView ?? '準備中', noteReading: note.busy ? '読み取り中' : 'なし',
    ai: ai ? Object.fromEntries(Object.entries(ai.purposes).map(([k, v]) => [k, `${v.label}${v.ready ? '' : '（使えない）'}`])) : null,
  })); // 描画のたびに確かめる（変わったときだけ更新される）

  const headerRight = (
    <div className="top-right">
      {canPause && !paused && <button type="button" className="btn btn-ghost btn-sm" onClick={() => pause()}>一時中断</button>}
      <div className="dev-icons" aria-label="使っているデバイス">
        <span className={`dev-icon${settings.faceOn && faceView ? '' : ' off'}`} title={settings.faceOn ? '顔カメラ：オン' : '顔カメラ：オフ'}><PcIcon /></span>
        <span className={`dev-icon${handOn ? '' : ' off'}`} title={`${handName}：${noteOff ? '使わない' : handOn ? 'オン' : 'オフ'}`}><PhoneIcon /></span>
      </div>
      <div className="num" style={{ fontWeight: 700 }}>{clock}</div>
    </div>
  );

  if (error || !session) {
    return (
      <div className="page">
        <Header right={headerRight} account={false} />
        <main className="study"><div className="card empty">{error || '読み込み中…'} {error && <Link to="/">はじめるへもどる</Link>}</div></main>
      </div>
    );
  }

  const voiceOn = settings.voiceOn;

  // 家トモの欄。どちらのモードも会話の記録を出す（会話モードは書き起こしを出すだけで、文字の入力欄はない）
  const tutorHead = (
    <>
      <div className="tutor-head">
        <div className={`avatar${voiceMode && speaking ? ' speaking' : ''}`}><TomoIcon size={24} /><span className="ring" /></div>
        <div className="tutor-col">
          <div className="who-row">
            <div className="who">家トモ</div>
            <span className="chip chip-gray">{voiceMode ? '会話モード' : 'チャットモード'}</span>
            {/* 会話モードの家トモの声はふだんオン。押すとミュート／ミュート解除 */}
            {voiceMode && (
              <button type="button" className={`chip voice-chip ${voiceOn ? 'chip-blue' : 'chip-gray'}`} aria-pressed={!voiceOn}
                title={voiceOn ? '押すと家トモの声をミュート' : '押すとミュートを解除'}
                onClick={() => setSettings({ voiceOn: !settings.voiceOn })}>
                <VoiceIcon />{voiceOn ? '音声：オン' : '音声：ミュート中'}
              </button>
            )}
          </div>
        </div>
      </div>
      {/* これまでの会話。スクロールして読み返せる（新しい発言は下に足す）。会話モードは話した内容の書き起こし */}
      <div className="study-chat" ref={logRef} aria-live="polite" aria-label="家トモとの会話"
        onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {log.map((m) => (m.who === 'tomo'
          ? <div key={m.id} className="bubble">{m.text}</div>
          : <div key={m.id} className="me"><div className="me-label">あなた</div><div className="me-bubble">{m.text}</div></div>))}
        {/* 話している途中の書き起こし・聞き取り */}
        {voiceMode ? (
          <>
            {live.draft.student && <div className="me"><div className="me-label">あなた</div><div className="me-bubble live-draft">{live.draft.student}</div></div>}
            {live.draft.tomo && <div className="bubble live-draft">{live.draft.tomo}</div>}
          </>
        ) : (
          <>
            {listen.interim && <div className="me"><div className="me-label">あなた</div><div className="me-bubble live-draft">{listen.interim}</div></div>}
            {chat.thinking && <div className="bubble study-chat-thinking">考え中…</div>}
          </>
        )}
      </div>
    </>
  );

  const micChip = (
    // マイクはふだんオンで聞き続ける。押すとミュート／ミュート解除
    <button type="button" className={`chip voice-chip ${micOn ? 'chip-blue' : 'chip-gray'}`} aria-pressed={!micOn}
      disabled={!voiceMode && !speechSupported}
      title={!voiceMode && !speechSupported ? 'このブラウザは聞き取りに対応していません（Chrome か Edge で開いてください）' : micOn ? '押すとマイクをミュート' : '押すとミュートを解除'}
      onClick={toggleMic}>
      <MicIcon />{!voiceMode && !speechSupported ? 'マイク：使えません' : micOn ? 'マイク：オン' : 'マイク：ミュート中'}
    </button>
  );

  // 会話モード：声だけで話す（文字の入力欄はない）。マイクの音は Gemini Live に送りつづけ、家トモが話していても話しかければ止まる
  const voicePanel = (
    <div className="field" style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid var(--soft)' }}>
      <div className="who-row">
        <span className="read-label" style={{ margin: 0 }}>家トモと声で話す</span>
        {micChip}
      </div>
      <div className={`mic-status${micOn && live.status === 'ready' && !live.micError ? ' on' : ''}`} aria-live="polite">
        {!tomo.liveOn ? <span role="alert">{ai ? 'Gemini Live が使えません（server/.env の設定を確認してください）' : 'サーバーに確認しています…'}</span>
          : live.status === 'error' ? <span role="alert">{live.error} <button type="button" className="btn btn-ghost btn-sm" onClick={live.reconnect}>つなぎ直す</button></span>
          : live.status !== 'ready' ? 'Gemini Live につないでいます…'
          : live.speaking ? '家トモが話しています（話しかけると止まります）'
          : !micOn ? 'マイクはミュート中です。話しかけるときはミュートを解除してください'
          : live.micError ? <span role="alert">{live.micError}（ブラウザでマイクを許可してから、マイクをミュート→解除してください）</span>
          : '聞いています。声で話しかけてください'}
      </div>
    </div>
  );

  // チャットモード：文字で話す。マイクがオンなら、声も文字にして送る（家トモは声を出さない）
  const chatForm = (
    <form className="field" onSubmit={onTalk} style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid var(--soft)' }}>
      <div className="who-row">
        <label htmlFor="talk">家トモに話しかける</label>
        {micChip}
      </div>
      <div className={`mic-status${listen.listening ? ' on' : ''}`} aria-live="polite">
        {!tomo.chatOn ? <span role="alert">{ai ? 'チャットの AI が使えません（server/.env の設定を確認してください）' : 'サーバーに確認しています…'}</span>
          : chat.thinking ? '家トモが考えています…'
          : listen.error ? <span role="alert">{listen.error}（ブラウザでマイクを許可してから、マイクをミュート→解除してください）</span>
          : listen.listening ? '聞いています。声でも文字でも話しかけてください'
          : '文字で話しかけてください'}
      </div>
      <div className="field-row">
        <input id="talk" value={talk} onChange={(e) => setTalk(e.target.value)} autoComplete="off"
          placeholder="例：この言葉の意味は？／画面のこの図を説明して" />
        <button type="submit" className="btn btn-ghost" disabled={chat.thinking}>{chat.thinking ? '考え中…' : '送る'}</button>
      </div>
    </form>
  );
  const talkForm = voiceMode ? voicePanel : chatForm;

  // 中央と右の仕切り：ドラッグ（または ← → キー）で右の列の幅を変える。ダブルクリックでもとの幅
  const clampSide = (w: number) => {
    const total = gridRef.current?.clientWidth ?? 0;
    return Math.round(Math.max(SIDE_MIN, Math.min(w, total - MAIN_MIN)));
  };
  const onSplitDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSplitMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !gridRef.current) return;
    setSettings({ sideWidth: clampSide(gridRef.current.getBoundingClientRect().right - e.clientX - 10) });
  };
  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
    if (!d) return;
    e.preventDefault();
    setSettings({ sideWidth: clampSide(settings.sideWidth + d) });
  };

  return (
    <div className="page study-page" style={{ display: 'flex', flexDirection: 'column' }}>
      <Header right={headerRight} account={false} />
      <main className="study">
        {/* 中央：家トモとの会話。右：共有している画面・表情のようす・あなたのノート（ノートはずっと同じ位置に置いて、カメラがつなぎ直しにならないようにする） */}
        <div className="study-grid" ref={gridRef} style={{ '--side-w': `${settings.sideWidth}px` } as CSSProperties}>
          <section className="card tutor-card study-main" aria-label="家トモ">
            <div className="study-title">{session.title}</div>
            {tutorHead}
            {talkForm}
          </section>

          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="左右の幅を変える"
            tabIndex={0}
            title="ドラッグで幅を変える（ダブルクリックでもとにもどす）"
            onPointerDown={onSplitDown}
            onPointerMove={onSplitMove}
            onKeyDown={onSplitKey}
            onDoubleClick={() => setSettings({ sideWidth: 380 })}
          />

          <div className="study-side">
            {/* タイマー：家トモが計っている時間（「10分計って」「時間計って」）。計っているあいだだけ出す */}
            {timer && <TimerCard timer={timer} now={now} onStop={stopTimer} />}

            {/* 勉強した時間：この回を開いてからの、勉強していた時間と一時中断していた時間をバーで出す */}
            <section className="card study-time-card" aria-label="勉強した時間">
              <StudyTimeBar spans={spans} check={nudges.peek} />
            </section>

            {/* この会話内の設定：「設定」と同じ項目を、この会話の中だけ変える */}
            <button type="button" className="btn btn-ghost btn-sm session-set-open" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>
              <GearIcon />この会話内の設定{scope.changed.length > 0 && <span className="chip chip-cream session-set-count">変更 {scope.changed.length}</span>}
            </button>

            {/* 共有している画面：見ている画面を小さく映す（家トモには、聞かれたときだけ1コマ渡す）。画面を見るツールがオフなら出さない */}
            {screenTool && <section className="card face-card" aria-label="共有している画面">
              <div className="note-head">
                <h2 className="h2">共有している画面</h2>
                {screen.sharing && <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={screen.stop}>見せるのをやめる</button>}
              </div>
              {!screenShareSupported() ? (
                <p className="muted screen-note">このブラウザは画面共有に対応していません（PC の Chrome か Edge で開いてください）。</p>
              ) : screen.sharing ? (
                <>
                  <ScreenStage stream={screen.stream} strokes={screen.ink.strokes} />
                  <div className="row-wrap">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setDrawing(true)}>ペンで書く</button>
                    {screen.ink.strokes.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={screen.ink.clear}>書き込みを消す</button>}
                  </div>
                  <div className="row-wrap">
                    {screen.label && <span className="chip chip-gray screen-label" title={screen.label}>{screen.label}</span>}
                    <span className={`chip ${screen.lastLook ? 'chip-blue' : 'chip-gray'}`}>
                      {screen.lastLook ? `家トモが見た：${new Date(screen.lastLook).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '家トモはまだ見ていません'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <p className="muted screen-note">勉強に使っている Web ページなどを別タブで開いて共有すると、画面について質問できます。家トモは、聞かれたときだけ画面を見ます。</p>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void screen.start()}>画面を家トモに見せる</button>
                </>
              )}
              {screen.error && <p className="make-error" role="alert">{screen.error}</p>}
            </section>}

            {/* 表情のようす：顔カメラを小さく映し、いまの様子を出す（解析は端末の中だけ） */}
            {settings.faceOn && (
              <section className="card face-card" aria-label="表情のようす">
                <h2 className="h2">表情のようす</h2>
                <FaceCamera active={!paused} quiet={busy || speaking || paused} downNudge={nudges.downNudge} onNudge={nudges.onFaceNudge} onView={setFaceView} onDown={setFaceDown} onClosed={setFaceClosed} />
              </section>
            )}

            {/* あなたのノート：手元カメラの映像（または iPad のノート）と、AI が見たノートの様子。手元ノートを使わないときは出さない */}
            {!noteOff && <section className="card note-card" aria-label="あなたのノート">
              <div className="note-head">
                <h2 className="h2">あなたのノート</h2>
                <span className={`chip ${handOn ? 'chip-blue' : 'chip-gray'}`}>{padMode ? (handOn ? 'iPad：つながっています' : 'iPad：つながっていません') : handOn ? '手元カメラ：オン' : '手元カメラ：オフ'}</span>
                {!padMode && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSettings({ handCameraOn: !settings.handCameraOn })}>
                    {settings.handCameraOn ? 'カメラを切る' : 'カメラをつける'}
                  </button>
                )}
              </div>
              {padMode
                ? <PadNote pageKey={session.id} onStatus={setHandOn} onCapture={onPadCapture} />
                : <HandCamera active={!paused && settings.handCameraOn} onStatus={setHandOn} onVideo={setVideo} rotate={settings.handCameraRotate} />}
              <div className="read-text" aria-label="ノートの様子">
                {noteLook > 0 && <span className="chip chip-blue">家トモがノートを見た：{new Date(noteLook).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                <div className="read-label">
                  ノートの様子{ai?.purposes.note.ready && note.busy && <span className="muted">（読み取り中…）</span>}
                </div>
                {ai?.purposes.note.ready && note.reading ? (
                  <dl className="note-props">
                    <dt>readable<span>読み取れるか</span></dt>
                    <dd><span className={`chip ${note.reading.readable ? 'chip-blue' : 'chip-red'}`}>{String(note.reading.readable)}</span></dd>
                    <dt>progress<span>前回からの様子</span></dt>
                    <dd><span className={`chip ${PROGRESS_CHIP[note.reading.progress]}`}>{note.reading.progress}</span> {PROGRESS_LABEL[note.reading.progress]}</dd>
                    <dt>unreadableReason<span>読み取れない理由</span></dt>
                    <dd>{note.reading.unreadableReason || <span className="muted">（なし）</span>}</dd>
                    <dt>observation<span>見えたこと</span></dt>
                    <dd>{note.reading.observation || <span className="muted">（なし）</span>}</dd>
                  </dl>
                ) : (
                  <p className="muted">{ai?.purposes.note.ready ? 'まだありません' : 'ノート読み取りの AI が使えません'}</p>
                )}
                {ai?.purposes.note.ready && note.error && <p className="muted" role="alert">{note.error}</p>}
              </div>
            </section>}
          </div>
        </div>
      </main>

      {settingsOpen && <SessionSettingsPanel changed={scope.changed} onRevert={scope.revert} onClose={() => setSettingsOpen(false)}
        meter={<ContextMeter usage={tomo.usage ?? null} summaries={tomo.summaries} />} />}

      {drawing && screen.sharing && <ScreenDraw stream={screen.stream} ink={screen.ink} onClose={() => setDrawing(false)} />}

      {paused && (
        <div className="pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title">
          <div className="card pause-card">
            <h2 id="pause-title" className="h2">一時中断しています</h2>
            <p className="muted">{pauseNote}カメラと読み上げを止めました。もどると、いまの続きから再開します。</p>
            <StudyTimeBar spans={spans} />
            <div className="row-wrap">
              <button type="button" className="btn btn-primary" autoFocus onClick={() => { debugLog.event('再開'); setPaused(false); }}>勉強にもどる</button>
              <Link className="btn btn-ghost" to="/">はじめるへ</Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * この回を開いてからの時間を1本のバーにする。勉強していたところは緑、一時中断していたところは灰色のしま
 * 続けるかの確認を数えているときは、バーの右はしを一時中断する時刻にして、たずねるところに目盛りを付ける（続けると答えたら右はしがのびる）
 * 一時中断していた時間は、勉強した時間に入れない
 */
function StudyTimeBar({ spans, check }: { spans: StudySpan[]; check?: () => ContinueState | null }) {
  const now = useTick(spans.length > 0);
  if (!spans.length) return null;
  const { study, paused } = studyTotals(spans, now);
  const c = check?.() ?? null;
  const from = spans[0].from;
  const scale = Math.max(now, c?.pauseAt ?? 0) - from; // バー全体の長さ（ms）
  const at = (t: number) => `${scale ? ((t - from) / scale) * 100 : 0}%`;
  return (
    <div className="study-time">
      <div className="study-time-nums">
        <span><b className="num">{clockText(study)}</b> 勉強</span>
        {paused > 0 && <span className="muted"><span className="num">{clockText(paused)}</span> 一時中断（勉強した時間に入れない）</span>}
        {c && <span className="study-time-left">一時中断まで <b className={`num${c.asked ? ' asked' : ''}`}>{clockText(c.pauseAt - now)}</b></span>}
      </div>
      <div className="study-time-bar" role="img" aria-label={`勉強 ${clockText(study)}、一時中断 ${clockText(paused)}${c ? `、一時中断まで ${clockText(c.pauseAt - now)}` : ''}`}>
        <div className="study-time-track">
          {spans.map((s) => <i key={s.from} className={s.paused ? 'paused' : ''} style={{ left: at(s.from), width: `${scale ? (((s.to ?? now) - s.from) / scale) * 100 : 0}%` }} />)}
        </div>
        {c && <span className={`study-time-mark${c.asked ? ' asked' : ''}`} style={{ left: at(c.askAt) }} />}
      </div>
      <div className="study-time-sub muted">
        <span>{timeOfDay(from)} から</span>
        {c && <span>{c.asked ? `続けるかたずねています（続けると答えたら${minutesText(continueTimes().interval / 60)}のびます）` : `${timeOfDay(c.askAt)} に続けるかたずねます`}</span>}
      </div>
    </div>
  );
}

const timeOfDay = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/**
 * タイマー（決まった時間）は残り時間と進み具合、ストップウォッチは経過時間を大きく出す
 * ポモドーロは、いまの段階（何回目の集中か・休憩か）の残り時間と進み具合を出す
 */
function TimerCard({ timer, now, onStop }: { timer: Timer; now: number; onStop: () => void }) {
  const end = timerEnd(timer);
  const done = !!end && now >= end; // 時間になった（家トモが知らせるまでのあいだ）
  const p = timer.pomodoro;
  const at = p && !done ? pomodoroAt(p, now - timer.startedAt) : null;
  // バーと残り時間：ポモドーロはいまの段階、タイマーは全体
  const [from, to] = at ? [timer.startedAt + at.phaseStart, timer.startedAt + at.phaseEnd] : [timer.startedAt, end ?? 0];
  const progress = end ? Math.min(1, (now - from) / (to - from)) : 0;
  const title = p ? 'ポモドーロ' : end ? 'タイマー' : 'ストップウォッチ';
  return (
    <section className={`card face-card timer-card${at && !at.working ? ' resting' : ''}`} aria-label={title}>
      <div className="note-head">
        <h2 className="h2">{title}</h2>
        {at ? <span className={`chip ${at.working ? 'chip-blue' : 'chip-cream'}`}>{at.working ? `集中 ${at.round}/${p!.rounds}回目` : '休憩'}</span>
          : timer.minutes && !p && <span className="chip chip-gray">{minutesText(timer.minutes)}</span>}
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onStop}>{end ? 'やめる' : '止める'}</button>
      </div>
      <div className={`timer-time num${done ? ' done' : ''}`} role="timer" aria-live="off">
        {done ? (p ? 'おつかれさまでした' : '時間です') : clockText(end ? to - now : now - timer.startedAt)}
      </div>
      {/* 段階が変わったときにバーが戻るのを動かさないよう、段階ごとに作りなおす */}
      {end && <div key={at?.stage} className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><i style={{ width: `${progress * 100}%` }} /></div>}
      <p className="muted timer-sub">
        {p && `${minutesText(p.work)}集中・${minutesText(p.rest)}休憩を${p.rounds}回 · `}
        {end ? `${timeOfDay(end)} に終わります` : `${timeOfDay(timer.startedAt)} から計っています`}
      </p>
    </section>
  );
}
