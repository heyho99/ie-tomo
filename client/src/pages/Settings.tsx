import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { aiApi, type AiStatus } from '../api';
import type { Capture } from '../capture';
import { CameraLab } from '../components/CameraLab';
import { FaceCamera } from '../components/FaceCamera';
import type { FaceView } from '../face';
import { HandCamera, RotateControl, cameraCapture } from '../components/HandCamera';
import { Header } from '../components/Header';
import { MicIcon, PcIcon, PhoneIcon, TomoIcon } from '../components/Icons';
import { PadNote } from '../components/PadNote';
import { useChatTomo } from '../chat';
import { useLiveTomo } from '../live';
import { SettingsScope, useSettings, useSettingsDraft } from '../settings';
import { FaceOnField, HandSourceField, LiveVoiceField, TalkModeField } from '../components/SettingFields';
import { speechSupported, useListening, useMicLevel } from '../speech';

// 設定：授業の前に、手元カメラ・顔カメラ・マイク・家トモとの会話がちゃんと動くか確かめる。家トモとの話し方（会話モード・チャットモード）もここで選ぶ
// 「会話設定」「手元ノート設定」「顔カメラ設定」の3つに分けて並べる。手元ノートキャプチャ設定は、手元カメラの映像（または iPad のノート）をそのまま使う
// 変えた設定は下書きで、「設定を保存」を押すまで授業には反映しない（このページの中では下書きで動かして確かめられる）

export function Settings() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [aiError, setAiError] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [padCapture, setPadCapture] = useState<Capture | null>(null);
  const onPadCapture = useCallback((c: Capture | null) => setPadCapture(() => c), []);
  const draft = useSettingsDraft();
  const [saved, setSaved] = useState(false);
  const pad = draft.pair[0].handSource === 'pad';
  const noteOff = draft.pair[0].handSource === 'none';
  const capture = useMemo(() => (pad ? padCapture : video && cameraCapture(video)), [pad, padCapture, video]);

  useEffect(() => { if (draft.dirty) setSaved(false); }, [draft.dirty]);

  useEffect(() => {
    aiApi.status().then(setAi).catch(() => setAiError(true));
  }, []);

  return (
    <SettingsScope value={draft.pair}>
      <div className="page">
        <Header />
        <main className="setup">
          <div>
            <h1 className="h1-setup">設定</h1>
            <p className="muted" style={{ margin: '6px 0 0' }}>授業の前に、カメラ・マイク・家トモとの会話が動くか確かめよう。「設定を保存」を押すと、授業でもこの設定を使います。</p>
          </div>
          <nav className="pills setup-jump" aria-label="設定の目次">
            {SETUP_GROUPS.map((g) => <a key={g.id} className="pill" href={`#${g.id}`}>{g.title}</a>)}
          </nav>
          <SetupGroup id="setup-talk">
            <MicCard />
            <ChatCard ai={ai} aiError={aiError} />
          </SetupGroup>
          <SetupGroup id="setup-note">
            <HandCard onVideo={setVideo} onPadCapture={onPadCapture} />
            {!noteOff && <section className="card setup-card" aria-label="手元ノートキャプチャ設定">
              <div className="setup-head">
                <h3 className="h2" style={{ flex: '1 1 auto' }}>手元ノートキャプチャ設定</h3>
                {aiError ? <span className="chip chip-red">サーバーにつながりません</span>
                  : !ai ? <span className="chip chip-gray">確認中…</span>
                  : ai.purposes.note.ready ? <span className="chip chip-blue">{ai.purposes.note.label}</span>
                  : <span className="chip chip-red">AI が未設定</span>}
              </div>
              <CameraLab video={pad ? null : video} capture={capture} ai={ai} />
            </section>}
          </SetupGroup>
          <SetupGroup id="setup-face">
            <FaceCard />
          </SetupGroup>
        </main>
        <div className="save-bar" role="region" aria-label="設定の保存">
          <span className={`save-status${draft.dirty ? ' dirty' : ''}`}>
            {draft.dirty ? '保存していない変更があります（保存するまで授業には反映されません）' : saved ? '保存しました' : '変更はありません'}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!draft.dirty} onClick={draft.reset}>元に戻す</button>
          <button type="button" className="btn btn-primary" disabled={!draft.dirty} onClick={() => { draft.save(); setSaved(true); }}>設定を保存</button>
        </div>
      </div>
    </SettingsScope>
  );
}

// 設定のまとまり（上から順に並べ、ページ上部の目次からも飛べる）
const SETUP_GROUPS = [
  { id: 'setup-talk', title: '会話設定', sub: 'マイクと、家トモとの話し方を決めて、話してみよう。' },
  { id: 'setup-note', title: '手元ノート設定', sub: 'ノートの入力元（手元カメラ・iPad・使わない）を選んで、家トモが読み取れるか試そう。' },
  { id: 'setup-face', title: '顔カメラ設定', sub: '授業で顔カメラを使うかを決めて、映り方を確かめよう。' },
] as const;

function SetupGroup({ id, children }: { id: (typeof SETUP_GROUPS)[number]['id']; children: ReactNode }) {
  const g = SETUP_GROUPS.find((x) => x.id === id)!;
  return (
    <section className="setup-group" id={id} aria-labelledby={`${id}-title`}>
      <div className="setup-group-head">
        <h2 className="setup-group-title" id={`${id}-title`}>{g.title}</h2>
        <p className="setup-sub">{g.sub}</p>
      </div>
      <div className="setup-grid">{children}</div>
    </section>
  );
}

function CardHead({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="setup-head">
      <div className="dev-ico">{icon}</div>
      <h3 className="h2" style={{ flex: '1 1 auto' }}>{title}</h3>
      {children}
    </div>
  );
}

/** 手元（ノート）：入力元（手元カメラ・iPad・使わない）を選んで確かめる（読み取りは隣の「手元ノートキャプチャ設定」で試す） */
function HandCard({ onVideo, onPadCapture }: { onVideo: (v: HTMLVideoElement | null) => void; onPadCapture: (c: Capture | null) => void }) {
  const [on, setOn] = useState(false);
  const [settings] = useSettings();
  const pad = settings.handSource === 'pad';
  const noteOff = settings.handSource === 'none';

  return (
    <section className="card setup-card" aria-label="ノートの入力元">
      <CardHead icon={<PhoneIcon />} title="ノートの入力元">
        <span className={`chip ${on && !noteOff ? 'chip-blue' : 'chip-gray'}`}>{noteOff ? '使わない' : on ? (pad ? 'iPad とつながっています' : '映っています') : pad ? 'iPad がつながっていません' : 'オフ'}</span>
      </CardHead>
      <HandSourceField onChange={() => setOn(false)} />
      {noteOff ? (
        <p className="setup-sub">授業で手元のノートを読み取りません。顔カメラを使うときは、下を向いたままの時間が長いと家トモが声をかけます。</p>
      ) : pad ? (
        <>
          <p className="setup-sub">iPad でこの QR コードを読んで、つないでください。</p>
          <PadNote pageKey="settings" onStatus={setOn} onCapture={onPadCapture} />
        </>
      ) : (
        <>
          <p className="setup-sub">カメラを手元に向けて、ノート全体が映るように置いてください。</p>
          <HandCamera onStatus={setOn} onVideo={onVideo} rotate={settings.handCameraRotate} />
          <div className="setup-sub-title">カメラの向き</div>
          <RotateControl />
          <p className="setup-note">ノートの文字がまっすぐ読める向きになるように合わせてください。授業でもこの向きで映し、読み取ります。</p>
        </>
      )}
    </section>
  );
}

/** 顔カメラ：表情の解析を確かめる（解析は端末の中だけ。映像はどこにも送らない） */
function FaceCard() {
  const [settings] = useSettings();
  const [view, setView] = useState<FaceView | null>(null);
  const on = settings.faceOn;

  return (
    <section className="card setup-card" aria-label="顔カメラ">
      <CardHead icon={<PcIcon />} title="顔カメラ（表情）">
        <span className={`chip ${!on || !view ? 'chip-gray' : FACE_VIEW_CHIP[view]}`}>{!on ? 'オフ' : !view ? '準備中' : FACE_VIEW_LABEL[view]}</span>
      </CardHead>
      <FaceOnField>授業で顔カメラを使う</FaceOnField>
      {on && (
        <>
          <p className="setup-sub">PC のカメラを顔に向けてください。顔の特徴点（青）が映像に重なれば読み取れています。顔が見えないときは、頭と肩の点（黄）で映っているかを見ます。</p>
          <FaceCamera detail onView={setView} />
        </>
      )}
      <p className="setup-note">顔の映像は保存せず、サーバーや AI には送りません。</p>
    </section>
  );
}

const FACE_VIEW_LABEL: Record<FaceView, string> = { face: '顔が見えています', body: '映っています（顔は見えません）', none: '映っていません' };
const FACE_VIEW_CHIP: Record<FaceView, string> = { face: 'chip-blue', body: 'chip-cream', none: 'chip-red' };

/** マイク：音量メーター（聞き取りは、家トモとの会話で確かめる） */
function MicCard() {
  const [settings, setSettings] = useSettings();
  const mic = useMicLevel(settings.micId, true);

  return (
    <section className="card setup-card" aria-label="マイク">
      <CardHead icon={<MicIcon />} title="マイク">
        <span className={`chip ${mic.error ? 'chip-gray' : 'chip-blue'}`}>{mic.error ? 'オフ' : 'つながっています'}</span>
      </CardHead>
      {mic.devices.length > 1 && (
        <label className="dev-select">
          <span>マイク</span>
          <select value={settings.micId || mic.current} onChange={(e) => setSettings({ micId: e.target.value })}>
            {mic.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `マイク ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      {mic.error ? (
        <div className="setup-error" role="alert">{mic.error}</div>
      ) : (
        <div className="meter" role="meter" aria-label="マイクの音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mic.level * 100)}>
          <i style={{ width: `${mic.level * 100}%` }} />
        </div>
      )}

    </section>
  );
}

/** 家トモ：話し方（会話モード・チャットモード）を選んで、話してみる */
function ChatCard({ ai, aiError }: { ai: AiStatus | null; aiError: boolean }) {
  const [settings] = useSettings();
  const voiceMode = settings.talkMode === 'voice';
  const purpose = ai?.purposes[voiceMode ? 'live' : 'chat']; // 会話モードは Gemini Live、チャットモードはチャットのモデル（「管理者設定」で選ぶ）
  const ready = !!purpose?.ready;

  return (
    <section className="card setup-card" aria-label="家トモとの会話">
      <CardHead icon={<TomoIcon size={28} />} title="家トモとの会話">
        {aiError ? <span className="chip chip-red">サーバーにつながりません</span>
          : !ai ? <span className="chip chip-gray">確認中…</span>
          : !ready ? <span className="chip chip-red">AI が未設定</span>
          : <span className="chip chip-blue">{purpose?.label}</span>}
      </CardHead>

      <div className="setup-sub-title">話し方</div>
      <TalkModeField />
      <p className="setup-note">
        {voiceMode
          ? '会話モード：家トモ（Gemini Live）と声だけで話します。チャット欄はありません。'
          : 'チャットモード：家トモと文字のチャットで話します。'}
      </p>

      {voiceMode && <LiveVoiceField />}

      {ai && !ready && (
        <div className="notice">
          {voiceMode ? 'Gemini Live' : 'チャットの AI'} が使えません。<code>server/.env</code> の設定を確認してください（<code>server/.env.example</code> を参照）。
        </div>
      )}

      {/* 話し方・声を変えたら、試している会話はやめて出しなおす（声はつなぐときに決まる） */}
      {voiceMode ? <VoiceTry key={`voice:${settings.liveVoice}`} ready={ready} /> : <ChatTry key="chat" ready={ready} />}
    </section>
  );
}

type Turn = { id: number; role: 'user' | 'tomo'; text: string };

function TryLog({ history, on, hint, children }: { history: Turn[]; on: boolean; hint: string; children?: ReactNode }) {
  return (
    <div className="chat-log" aria-live="polite">
      {!history.length && !on && <p className="muted" style={{ margin: 0 }}>{hint}</p>}
      {history.map((t) => (
        <div key={t.id} className={t.role === 'tomo' ? 'chat-tomo' : 'chat-me'}>
          <div className="me-label">{t.role === 'tomo' ? '家トモ' : 'あなた'}</div>
          <div className={t.role === 'tomo' ? 'bubble bubble-sm' : 'me-bubble'}>{t.text}</div>
        </div>
      ))}
      {children}
    </div>
  );
}

/** 会話モードを試す：Gemini Live と声で話してみる（授業と同じく文字の入力欄はない。書き起こしは確かめるために出す） */
function VoiceTry({ ready }: { ready: boolean }) {
  const [settings, setSettings] = useSettings();
  const [history, setHistory] = useState<Turn[]>([]);
  const [on, setOn] = useState(false); // 話してみている（Gemini Live につないでいる）
  const id = useRef(0);
  const add = (role: 'user' | 'tomo', t: string) => setHistory((h) => [...h, { id: ++id.current, role, text: t }]);
  const live = useLiveTomo({
    enabled: on,
    micOn: true,
    voiceOn: settings.voiceOn,
    micId: settings.micId,
    voice: settings.liveVoice,
    onStudent: (t) => add('user', t),
    onTomo: (t) => add('tomo', t),
  });

  function start() {
    setHistory([]);
    setOn(true);
  }
  // つなぎはじめたら、家トモからあいさつする（つながるまえに送ったものは、つながってから届く）
  useEffect(() => { if (on) live.say('こんにちは。いっしょにがんばろうね。声で話しかけてみて。'); }, [on, live.say]);

  return (
    <>
      <div className="row-wrap">
        <label className="toggle">
          <input type="checkbox" checked={settings.voiceOn} onChange={(e) => setSettings({ voiceOn: e.target.checked })} />
          家トモの声を出す
        </label>
        {on
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOn(false)}>やめる</button>
          : <button type="button" className="btn btn-primary btn-sm" disabled={!ready} onClick={start}>話してみる</button>}
        {on && (
          <span className="muted try-status" role={live.status === 'error' || live.micError ? 'alert' : undefined}>
            {live.status === 'error' ? live.error
              : live.status !== 'ready' ? 'つないでいます…'
              : live.micError || (live.speaking ? '家トモが話しています' : '聞いています。話しかけてね')}
          </span>
        )}
      </div>
      <TryLog history={history} on={on} hint="「話してみる」を押して、「因数分解ってなに？」のように声で話しかけてみよう。">
        {live.draft.student && <p className="muted" style={{ margin: 0 }}>{live.draft.student}</p>}
        {live.draft.tomo && <p className="muted" style={{ margin: 0 }}>{live.draft.tomo}</p>}
      </TryLog>
    </>
  );
}

/** チャットモードを試す：チャットのモデルと、文字（と文字にした声）で話してみる */
function ChatTry({ ready }: { ready: boolean }) {
  const [history, setHistory] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [on, setOn] = useState(false);
  const id = useRef(0);
  const add = (role: 'user' | 'tomo', t: string) => setHistory((h) => [...h, { id: ++id.current, role, text: t }]);
  const chat = useChatTomo();
  const listen = useListening(on && !chat.thinking, (t) => void send(t));

  async function send(t: string) {
    const said = t.trim();
    if (!said || chat.thinking) return;
    add('user', said);
    const r = await chat.ask(said);
    add('tomo', r ? r.reply : 'ごめんね、うまく答えられなかった。もう一度話しかけてみて。');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!on) return;
    const t = text;
    setText('');
    void send(t);
  }

  function start() {
    const hello = 'こんにちは。いっしょにがんばろうね。文字か声で話しかけてみて。';
    chat.reset();
    chat.remember(hello);
    setHistory([]);
    add('tomo', hello);
    setOn(true);
  }

  return (
    <>
      <div className="row-wrap">
        {on
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOn(false)}>やめる</button>
          : <button type="button" className="btn btn-primary btn-sm" disabled={!ready} onClick={start}>話してみる</button>}
        {on && (
          <span className="muted try-status" role={listen.error ? 'alert' : undefined}>
            {chat.thinking ? '家トモが考えています…'
              : listen.error ? listen.error
              : listen.listening ? '聞いています。声でも文字でも話しかけてね'
              : !speechSupported ? 'このブラウザは聞き取りに対応していません（Chrome か Edge で開いてください）。文字で話しかけてね'
              : '文字で話しかけてね'}
          </span>
        )}
      </div>
      <TryLog history={history} on={on} hint="「話してみる」を押して、「因数分解ってなに？」のように文字か声で話しかけてみよう。">
        {listen.interim && <p className="muted" style={{ margin: 0 }}>{listen.interim}</p>}
        {chat.thinking && <p className="muted" style={{ margin: 0 }}>考え中…</p>}
      </TryLog>
      <form className="field" onSubmit={onSubmit}>
        <div className="field-row">
          <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="文字で話しかける" disabled={!on} aria-label="家トモに話しかける" />
          <button type="submit" className="btn btn-primary" disabled={!on || !text.trim() || chat.thinking}>送る</button>
        </div>
      </form>
    </>
  );
}
