import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextUsage } from './api';
import { authQuery } from './auth';
import { debugLog } from './debug';
import { micErrorText, openMic } from './speech';
import type { CueKind } from './interestNudge';
import type { TimerWire } from './timer';
import { wsUrl } from './serverUrl';

// 家トモとの会話：Gemini Live で声で話す（サーバーの live.ts が中継する）
// マイクの音声は 16kHz の PCM にして送りつづけ、家トモの声（24kHz の PCM）は届いたそばから再生する
// 話しはじめ・話しおわりの判定や、家トモの話をさえぎるのは Gemini Live がする

export type LiveStatus = 'off' | 'connecting' | 'ready' | 'error';

type FromServer =
  | { type: 'ready' }
  | { type: 'audio'; data: string }
  | { type: 'transcript'; who: 'tomo' | 'student'; text: string; scripted?: boolean }
  | { type: 'interrupted' }
  | { type: 'turn' }
  | { type: 'screenRequest' | 'noteRequest'; id: number }
  | { type: 'timer'; state: TimerWire | null }
  | { type: 'study'; action: 'pause' | 'continue' }
  | { type: 'summary'; text: string }
  | ({ type: 'usage' } & ContextUsage)
  | { type: 'error'; message: string };

type Options = {
  enabled: boolean; // つなぐ（授業を開いている・「設定」で話してみている）
  sessionId?: string; // 学習の回の id。サーバーがその回のこれまでの会話を読んで、続きとして Gemini Live に渡す
  micOn: boolean; // マイクの音を送る（ミュート・一時中断・マイクの許可がないときは送らない）
  voiceOn: boolean; // 家トモの声を出す（ミュートでも会話は続く）
  micId: string;
  voice: string; // 家トモの声（Gemini Live のプリセットの声の名前）。変えたらつなぎ直す
  onStudent: (text: string) => void; // 生徒が声で言ったこと（言いおわったら1回）
  onTomo: (text: string) => void; // 家トモが自分で考えて話したこと（セリフは画面がもう表示しているので来ない）
  captureScreen?: () => string | null; // 共有している画面のいまの1コマ（家トモが look_at_screen で見たいとき）。共有していなければ null
  captureNote?: () => string | null; // 手元のノートのいまの画像（家トモが look_at_note で見たいとき）。使っていない・映っていなければ null
  timerNow?: () => TimerWire | null; // いま計っている時間（つないだときにサーバーに知らせる）
  onTimer?: (state: TimerWire | null) => void; // 家トモが時間を計りはじめた・やめた（timer）
  onStudy?: (action: 'pause' | 'continue') => void; // 家トモが一時中断する・続けると決めた（pause_study）
  onSummary?: (text: string) => void; // 会話が長くなったので、サーバーが古い会話を要約する（text は家トモが言うこと。声はサーバーが Gemini Live に言わせる）
  onUsage?: (usage: ContextUsage) => void; // いまの会話の量（Gemini Live が返事をするたびに届く）
};

// マイクの音声を 100ms ずつ 16bit の PCM にして送る（AudioContext を 16kHz で作るので、ブラウザが変換してくれる）
const WORKLET = `
class Pcm extends AudioWorkletProcessor {
  buf = new Int16Array(1600);
  n = 0;
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (const v of ch) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm', Pcm);`;

/** 家トモの書き起こしから、セリフの印（AI がまねして付けることがある）を外す */
const cleanTomo = (t: string) => t.trim().replace(/^（家トモのセリフ）/, '').replace(/^「([^」]*)」?$/, '$1').trim();

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * 家トモの声を、届いた順にすきまなく再生する
 * Gemini Live の声はほぼ実時間のペースで少しずつ届くので、届くのが少し遅れるとすぐ途切れる。
 * そこで、少しためてから再生する。途中で足りなくなったら（途切れたら）、細かく途切れないよう、もう一度ためてから続け、ためる量も増やす
 */
const LEAD_START = 0.3; // 話しはじめにためる秒数
const LEAD_MAX = 1;
const LEAD_WAIT_MS = 1500; // ためきる前に声が来なくなったら、ここまで待って再生する（短い返事のとき）

class Player {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private gain = this.ctx.createGain();
  private next = 0; // 次の声を鳴らしはじめる時刻（ctx の時計）
  private sources = new Set<AudioBufferSourceNode>();
  private pending: AudioBuffer[] = []; // ためている声
  private lead = LEAD_START;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private playing = false;
  private fresh = true; // 話しはじめ（まだ何も鳴らしていない）
  constructor(private onPlaying: (playing: boolean) => void) { this.gain.connect(this.ctx.destination); }

  play(b64: string) {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = this.ctx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      ch[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
    }
    this.setPlaying(true);
    // 鳴らしている声がまだ十分残っていれば、そのうしろにつなぐ
    if (!this.pending.length && this.next > this.ctx.currentTime + 0.02) { this.schedule(buf); return; }
    // 足りなくなった（途切れた）。話しはじめでなければ、次からはもっとためる
    if (!this.pending.length && !this.fresh) this.lead = Math.min(this.lead * 1.5, LEAD_MAX);
    this.pending.push(buf);
    const stored = this.pending.reduce((t, b) => t + b.duration, 0);
    if (stored >= this.lead) this.flush();
    else if (!this.waitTimer) this.waitTimer = setTimeout(() => this.flush(), LEAD_WAIT_MS);
  }

  /** ためている声を鳴らす（話しおわりが届いたときも呼ぶ） */
  flush() {
    clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    if (!this.pending.length) return;
    this.next = Math.max(this.next, this.ctx.currentTime + 0.02);
    for (const b of this.pending.splice(0)) this.schedule(b);
    this.fresh = false;
  }

  /** 話しおわった。ためている声はもう待たずに鳴らし、次の声は話しはじめとして扱う */
  endTurn() {
    this.flush();
    this.fresh = true;
  }

  private schedule(buf: AudioBuffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.next);
    this.next += buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size && !this.pending.length) this.setPlaying(false);
    };
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    this.onPlaying(p);
  }

  /** 再生中・再生待ちの声を捨てる（生徒が話しはじめたとき、一時中断したとき） */
  stop() {
    clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.pending = [];
    for (const s of this.sources) { s.onended = null; s.stop(); }
    this.sources.clear();
    this.next = 0;
    this.fresh = true;
    this.setPlaying(false);
  }

  setMuted(m: boolean) { this.gain.gain.value = m ? 0 : 1; }
  close() { this.stop(); void this.ctx.close(); }
}

// 予期せず切れたら（Cloud Run の60分の上限・デプロイなど）、待つ時間をのばしながら自動でつなぎ直す（会話の続きはサーバーが Firestore から読み直す）
const RETRY_MAX = 5;
const retryWait = (n: number) => Math.min(1000 * 2 ** n, 30_000);

export function useLiveTomo(o: Options) {
  const [status, setStatus] = useState<LiveStatus>('off');
  const [error, setError] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [micError, setMicError] = useState('');
  // 話している途中の書き起こし（言いおわるまで画面に出しておく）
  const [draft, setDraft] = useState({ student: '', tomo: '' });
  const [attempt, setAttempt] = useState(0); // つなぎ直すたびに増やす
  const ws = useRef<WebSocket | null>(null);
  const outbox = useRef<string[]>([]); // つながるまえに送ろうとしたもの（つなぎ直すあいだも、ためておく）
  const retries = useRef(0); // 続けて自動でつなぎ直した回数（つながったら 0 に戻す）
  const lastContext = useRef(''); // つなぎ直したときに、授業の様子を知らせなおす
  const player = useRef<Player | null>(null);
  const cb = useRef(o);
  cb.current = o;

  const post = useCallback((m: object) => {
    if (!cb.current.enabled) return;
    const s = JSON.stringify(m);
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(s);
    else outbox.current.push(s);
  }, []);

  // 接続。enabled のあいだつなぎっぱなしにする（会話の続きはサーバーが持つ）
  useEffect(() => {
    if (!o.enabled) { setStatus('off'); outbox.current = []; retries.current = 0; return; }
    const p = new Player(setSpeaking);
    player.current = p;
    p.setMuted(!cb.current.voiceOn);
    const session = cb.current.sessionId ? `&session=${encodeURIComponent(cb.current.sessionId)}` : '';
    const sock = new WebSocket(wsUrl(`/api/live?${authQuery()}${session}&voice=${encodeURIComponent(cb.current.voice)}`));
    ws.current = sock;
    if (lastContext.current && !outbox.current.includes(lastContext.current)) outbox.current.unshift(lastContext.current);
    setStatus('connecting');
    setError('');
    let failed = false; // サーバーが error を送ってきた（設定の誤りなどなので、自動ではつなぎ直さない）
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let student = '';
    let tomo = '';
    let scripted = ''; // セリフとして実際に話した内容（画面には出さず、デバッグで台本と比べる）
    const flushScripted = () => {
      if (scripted.trim()) debugLog.event('Live：セリフとして話した内容', cleanTomo(scripted));
      scripted = '';
    };
    const flushStudent = () => {
      if (student.trim()) cb.current.onStudent(student.trim());
      student = '';
      setDraft((d) => ({ ...d, student: '' }));
    };
    const flushTomo = () => {
      const t = cleanTomo(tomo);
      if (t) cb.current.onTomo(t);
      tomo = '';
      setDraft((d) => ({ ...d, tomo: '' }));
    };
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'timer', state: cb.current.timerNow?.() ?? null }));
      for (const s of outbox.current.splice(0)) sock.send(s);
    };
    sock.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as FromServer;
      switch (m.type) {
        case 'ready':
          setStatus('ready');
          retries.current = 0;
          debugLog.event('Live：接続');
          break;
        case 'audio':
          p.play(m.data);
          break;
        case 'transcript':
          if (m.who === 'student') {
            student += m.text;
            setDraft((d) => ({ ...d, student }));
          } else {
            flushStudent(); // 家トモが返事を始めたら、生徒は言いおわっている
            if (m.scripted) { scripted += m.text; break; }
            tomo += m.text;
            setDraft((d) => ({ ...d, tomo: cleanTomo(tomo) }));
          }
          break;
        case 'interrupted':
          p.stop();
          flushScripted();
          flushTomo();
          debugLog.event('Live：生徒が話しはじめたので、家トモの話を止めた');
          break;
        case 'turn':
          p.endTurn();
          flushStudent();
          flushScripted();
          flushTomo();
          break;
        case 'screenRequest': {
          const image = cb.current.captureScreen?.() ?? null;
          debugLog.event('Live：家トモが画面を見た', image ? `画像 ${Math.round((image.length * 3) / 4 / 1024)}KB` : '共有していない');
          // 共有していなくても返事はする（サーバーが待っているので）
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'screen', id: m.id, image }));
          break;
        }
        case 'noteRequest': {
          const image = cb.current.captureNote?.() ?? null;
          debugLog.event('Live：家トモがノートを見た', image ? `画像 ${Math.round((image.length * 3) / 4 / 1024)}KB` : '見えない');
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'note', id: m.id, image }));
          break;
        }
        case 'timer':
          debugLog.event('Live：家トモが時間を計る', m.state ? JSON.stringify(m.state) : 'やめた');
          cb.current.onTimer?.(m.state);
          break;
        case 'study':
          debugLog.event(`Live：家トモが${m.action === 'pause' ? '一時中断する' : '勉強を続ける'}と決めた`);
          cb.current.onStudy?.(m.action);
          break;
        case 'summary':
          debugLog.event('Live：会話が長くなったので、古い会話を要約する');
          cb.current.onSummary?.(m.text);
          break;
        case 'usage':
          cb.current.onUsage?.({ tokens: m.tokens, summaryAt: m.summaryAt, compressAt: m.compressAt, limit: m.limit });
          break;
        case 'error':
          failed = true;
          setStatus('error');
          setError(m.message);
          debugLog.event('Live：エラー', m.message);
          break;
      }
    };
    sock.onclose = () => {
      ws.current = null;
      p.stop();
      flushScripted();
      flushTomo();
      if (failed) return;
      if (retries.current >= RETRY_MAX) {
        setStatus('error');
        setError('Gemini Live との接続が切れました');
        return;
      }
      const wait = retryWait(retries.current++);
      debugLog.event('Live：切れたので、つなぎ直す', `${wait / 1000}秒後・${retries.current}回目`);
      setStatus('connecting');
      retryTimer = setTimeout(() => setAttempt((n) => n + 1), wait);
    };
    return () => {
      clearTimeout(retryTimer);
      sock.onclose = null;
      sock.close();
      ws.current = null;
      p.close();
      player.current = null;
      setSpeaking(false);
      setDraft({ student: '', tomo: '' });
    };
  }, [o.enabled, attempt, o.voice]); // 声はつなぐときに決まるので、変えたらつなぎ直す（会話の続きはサーバーが持つ）

  useEffect(() => { player.current?.setMuted(!o.voiceOn); }, [o.voiceOn, status]);

  // マイク。ミュート・一時中断のあいだは止める（一時中断のときは、家トモの声も止める）
  const sendMic = o.enabled && o.micOn && status === 'ready';
  useEffect(() => {
    if (!sendMic) return;
    let alive = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    (async () => {
      try {
        // 家トモの声を拾わないよう、エコー除去をかける
        stream = await openMic(cb.current.micId, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
        if (!alive) return;
        ctx = new AudioContext({ sampleRate: 16000 });
        await ctx.audioWorklet.addModule(url);
        if (!alive) return;
        const node = new AudioWorkletNode(ctx, 'pcm');
        node.port.onmessage = (e) => post({ type: 'audio', data: toBase64(e.data as ArrayBuffer) });
        ctx.createMediaStreamSource(stream).connect(node);
        setMicError('');
      } catch (e) {
        if (alive) setMicError(micErrorText(e));
      }
    })();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      URL.revokeObjectURL(url);
      post({ type: 'audioEnd' });
    };
  }, [sendMic, o.micId, post]);

  /** 家トモのセリフ（台本どおりに言わせる） */
  const say = useCallback((text: string) => { if (text) post({ type: 'say', text }); }, [post]);
  /** 生徒が文字で話しかけた */
  const text = useCallback((t: string) => post({ type: 'text', text: t }), [post]);
  /**
   * 声かけの合図（ノートの様子）。何を言うかは Gemini Live が考える。image は根拠になったノートの画像（data URL）
   * kind：興味・節目・回復の合図のとき（image は最後に読み取ったノート、screen は共有している画面のいまの1コマ）
   */
  const nudge = useCallback((t: string, image?: string, kind?: CueKind, screen?: string) => post({ type: 'nudge', text: t, image, kind, screen }), [post]);
  /** 勉強の様子（学習の回・画面共有をしているか） */
  const context = useCallback((c: string) => {
    const m = { type: 'context', context: c };
    lastContext.current = JSON.stringify(m);
    post(m);
  }, [post]);
  /** 計っている時間を画面で変えた（止めた・時間になった）。計っていなければ null */
  const timer = useCallback((state: TimerWire | null) => post({ type: 'timer', state }), [post]);
  /** タイマーの知らせ（時間になった）。何を言うかは Gemini Live が考える */
  const notice = useCallback((t: string) => post({ type: 'notice', text: t }), [post]);
  /** 続けるかの確認（何を言うかは家トモが考える） */
  const check = useCallback((t: string) => post({ type: 'check', text: t }), [post]);
  /** 自動でつなぎ直せなかったときに、手でつなぎ直す（会話の続きはサーバーが読み直す） */
  const reconnect = useCallback(() => { retries.current = 0; setAttempt((n) => n + 1); }, []);
  /** 家トモの声を止める（一時中断） */
  const hush = useCallback(() => player.current?.stop(), []);

  return { status, error, micError, speaking, draft, say, text, nudge, context, timer, notice, check, hush, reconnect };
}
