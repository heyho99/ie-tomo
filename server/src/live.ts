import { Behavior, Modality, Type, type LiveServerMessage, type Session } from '@google/genai';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { userOf } from './auth.js';
import { getConfig, modelInfo } from './aiConfig.js';
import { liveClient, parseImage, toGeminiSchema, type Image } from './llm.js';
import { EVIDENCE_LABEL, liveSystem, NOTE_NOW_LABEL, SCREEN_NOW_LABEL, scriptTurn } from './prompts.js';
import { addMessage, liveResumeOf, saveLiveResume, type LiveResume, type Message, type Summary } from './sessions.js';
import { historyOf, historyText, summarize, SUMMARY_NOTICE, summaryThreshold } from './summary.js';
import { enabledTools, runTool, type ToolContext } from './tools/index.js';
import { fromWire, toWire, type TimerState } from './tools/timer.js';

// 家トモとの会話：Gemini Live で声で話す。学習画面と Gemini Live のあいだをこのサーバーが中継する
// （Agent Platform の認証情報は画面に渡せないため）。画面とは /api/live の WebSocket で、JSON のメッセージをやりとりする
// URL の session（学習の回の id）があれば、その回のこれまでの会話（要約＋要約より後の発言。summary.ts）を読んで、続きとして Gemini Live に渡す
// 生徒と家トモの発言（書き起こし・文字の話しかけ）は、ここで学習の回に保存する（セリフ・要約のお知らせは保存しない）
// 入力のトークン数がコンテキストウィンドウの 80% をこえたら、古い会話を要約して、要約＋直近の発言で新しいセッションにつなぎ直す
// Gemini Live の再開ハンドルは学習の回にも保存する（sessions.ts の live）。台が替わって（デプロイ・Cloud Run の60分タイムアウトなど）
// 画面がつなぎ直してきたら、そのハンドルで Gemini Live の続きにつなぐ（RESUME_TTL_MS より古い・モデルや声が変わった・使えなかったときは、会話履歴を渡して新しいセッションにする）
// 要約の進み具合は保存しない（要約そのものは学習の回にある。途中で台が替わっても、次に届く会話の量でまた要約を始める）
//
// 画面 → サーバー
//   audio   { data }              マイクの音声（16kHz・16bit の PCM を base64）
//   audioEnd                       マイクを止めた
//   text    { text }               生徒が文字で話しかけた（ヒントのボタンも）
//   say     { text }               家トモのセリフ（あいさつ・問題の出だしなど、台本どおりに言わせる）
//   nudge   { text, image, kind, screen } 声かけの合図（ノートが読み取れない・手が止まっている・眠そう・下を向いているなど）。何を言うかは家トモが考える。image は根拠になったノートの画像（data URL）
//                                  kind：興味・節目・回復の合図のとき（「（声かけの合図・興味）」などにする）。image は最後に読み取ったノート、screen は共有している画面のいまの1コマ
//   context { context }            勉強の様子（学習の回・画面共有をしているか）。変わったときに送る。Gemini Live には話す番を渡さずに送る（覚えさせるだけ）
//   screen  { id, image }          screenRequest への返事：共有している画面のいまの1コマ（data URL。共有していなければ null）
//   note    { id, image }          noteRequest への返事：手元のノートのいまの画像（data URL。使っていない・映っていなければ null）
//   timer   { state }              計っている時間（{ elapsedMs, minutes }。計っていなければ null）。つないだときと、画面で変えたとき（止めた・時間になった）に送る
//   notice  { text }               タイマーの知らせ（時間になった）。何を言うかは家トモが考える
//   check   { text }               続けるかの確認（勉強を続けて30分になる3分前）。何を言うかは家トモが考える
// サーバー → 画面
//   ready                          Gemini Live につながった（つなぎ直したときも送る）
//   audio   { data }              家トモの声（24kHz・16bit の PCM を base64）
//   transcript { who, text, scripted } 書き起こし（少しずつ届く）。scripted はセリフを言わせているとき（画面はもう表示している）
//   interrupted                    生徒が話しはじめたので、家トモが話すのをやめた（画面は再生中の声を捨てる）
//   turn                           家トモが話し終わった
//   summary { text }               会話が長くなったので、古い会話を要約する（text は家トモが言うこと。画面は会話の欄に出す）
//   usage   { tokens, summaryAt, compressAt, limit } いまの会話の量（トークン）。summaryAt：要約を始める量、compressAt：Gemini Live が古い会話を捨てる量、limit：コンテキストウィンドウ
//   screenRequest { id }           家トモが共有している画面を見たい（look_at_screen）。画面は screen で返す
//   noteRequest { id }             家トモが手元のノートを見たい（look_at_note）。ノートは note で返す
//   timer   { state }              家トモが時間を計りはじめた・やめた（timer）。形は画面 → サーバーの timer と同じ
//   study   { action }             家トモが一時中断する（pause）・続ける（continue）と決めた（pause_study）
//   error   { message }

/** いまオンのツール（管理者設定）。つなぐたびに作る */
const liveTools = () => [{
  functionDeclarations: enabledTools().map((t) => ({ name: t.name, description: t.description, ...(t.parameters && { parameters: toGeminiSchema(t.parameters) }), behavior: Behavior.BLOCKING })),
}];
const IMAGE_TIMEOUT_MS = 5000; // 画面・ノートの画像が届くまで待つ時間

/** これまでの会話。summary：古い会話の要約、recent：要約より後の発言 */
type Memory = { summary: Summary | null; recent: Message[] };
/** 学習の回（会話を読む・要約するのに使う）。session がない・ログインしていないときは null */
type Owner = { uid: string; sessionId: string } | null;

/** 興味・節目・回復の合図の種類（画面が kind で送る） */
const CUE_KINDS = ['興味', '節目', '回復'];

/** 家トモの書き起こしから、セリフの印（AI がまねして付けることがある）を外す（画面の live.ts と同じ） */
const cleanTomo = (t: string) => t.trim().replace(/^（家トモのセリフ）/, '').replace(/^「([^」]*)」?$/, '$1').trim();

type TurnPart = { text: string } | { inlineData: { mimeType: string; data: string } };

type FromClient =
  | { type: 'audio'; data: string }
  | { type: 'audioEnd' }
  | { type: 'text'; text: string }
  | { type: 'say'; text: string }
  | { type: 'nudge'; text: string; image?: string; kind?: string; screen?: string }
  | { type: 'context'; context: string }
  | { type: 'screen' | 'note'; id: number; image: string | null }
  | { type: 'timer'; state: unknown }
  | { type: 'notice' | 'check'; text: string };

/** モデルのコンテキストウィンドウ（トークン） */
const contextTokens = (model: string) => modelInfo(model)?.contextTokens ?? 128_000;
/** Gemini Live が古い会話を捨てはじめるトークン数（contextWindowCompression） */
const compressAt = (model: string) => Math.floor(contextTokens(model) * 0.9);

const MAX_RETRY = 3; // 続けてつなぎ直しに失敗したらあきらめる
const NOTICE_WAIT_MS = 15_000; // 要約のお知らせを言い終わるのを待つ時間（言い終わらなくても要約する）
const SUMMARY_RETRY_MS = 2 * 60_000; // 要約に失敗したら、この時間はためさない（そのあいだは slidingWindow が古い会話を捨てる）
const RESUME_TTL_MS = 2 * 60 * 60_000; // 保存した再開ハンドルを使う期間（Gemini Live のハンドルは、切れてから2時間使える）

/** 画面1つぶんの会話。Gemini Live の接続は約10分で切られるので、続きのハンドルでつなぎ直す */
class LiveLesson {
  private session: Session | null = null;
  private handle: string | undefined; // 会話の続きからつなぎ直すためのハンドル
  private model = ''; // いまつないでいるモデル（ハンドルといっしょに保存する）
  private resumeLoaded = false; // 学習の回に保存したハンドルを読んだ（はじめてつなぐときだけ読む）
  private queue: FromClient[] = []; // つながるまでのあいだに届いたメッセージ（音声は捨てる）
  private closed = false;
  private retries = 0;
  private pendingContext = ''; // 家トモが話し終わるまで送らずにおく勉強の様子（話しているところに送ると、話がとぎれる）
  private sentContext = '';
  private talking = false; // 家トモが話している（声が届きはじめてから、話し終わるまで）
  private scripted = false; // いまの家トモの発話はセリフを言わせたものか
  private imageId = 0;
  private imageWaits = new Map<number, (image: string | null) => void>(); // 画面・ノートの画像を待っている look_at_screen・look_at_note
  private timer: TimerState | null = null; // 計っている時間（timer）。画面と送り合う
  private memory: Memory = { summary: null, recent: [] }; // 新しいセッションでつなぐときに渡す、これまでの会話
  private summary: 'none' | 'wanted' | 'notice' | 'running' = 'none'; // 要約の進み具合。wanted：話し終わったら始める、notice：お知らせを言っている
  private summaryFailedAt = -Infinity;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private heard = { student: '', tomo: '' }; // 言いおわるまでためている書き起こし（言いおわったら保存する）

  constructor(private ws: WebSocket, private owner: Promise<Owner>, private voice: string) {
    ws.on('message', (raw) => {
      let m: FromClient;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'screen' || m.type === 'note') { this.imageWaits.get(m.id)?.(m.image); return; }
      if (m.type === 'timer') { this.timer = fromWire(m.state); return; }
      if (m.type === 'text') void this.save('me', m.text);
      if (this.session) this.dispatch(m);
      else if (m.type !== 'audio') this.queue.push(m);
    });
    ws.on('close', () => {
      clearTimeout(this.noticeTimer);
      this.closed = true;
      this.session?.close();
      this.saveHeard('student');
      this.saveHeard('tomo');
    });
    void this.connect();
  }

  private send(m: object) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** ハンドルがない（はじめて・要約したあと）ときは、新しいセッションにこれまでの会話（要約＋要約より後の発言）を渡す */
  private async connect() {
    try {
      const model = this.model = getConfig('live').model; // 「管理者設定」の live。つなぎ直すたびに読む
      if (!this.resumeLoaded) await this.loadResume(model);
      if (!this.handle) await this.loadMemory();
      const s = await liveClient().live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: liveSystem(historyText(this.memory.summary, this.memory.recent)),
          speechConfig: { languageCode: 'ja-JP', voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: liveTools(),
          sessionResumption: { handle: this.handle },
          // 要約（80%）が間に合わなかったときの安全策。古い会話から捨てる（既定の 80% だと要約より先に動くので 90%）
          contextWindowCompression: { triggerTokens: String(compressAt(model)), slidingWindow: {} },
        },
        callbacks: {
          onmessage: (m) => this.onMessage(m),
          onerror: (e) => console.error('[live] error', e.message),
          onclose: (e) => this.onClose(s, e.code, e.reason),
        },
      });
      if (this.closed) { s.close(); return; }
      this.session = s;
      this.talking = false;
      this.send({ type: 'ready' });
      for (const m of this.queue.splice(0)) this.dispatch(m);
    } catch (e) {
      console.error('[live] connect', e);
      // ハンドルが使えない（古い・ほかのモデルのものなど）ときは、ハンドルを捨てて会話履歴を渡す新しいセッションでつなぐ
      if (this.handle && !this.closed) { this.dropHandle(); void this.connect(); return; }
      this.fail(`Gemini Live につながりませんでした：${(e as Error).message}`);
    }
  }

  /** 学習の回に保存したハンドルがあれば、それで続きにつなぐ（RESUME_TTL_MS より古い・モデルや声が変わっていれば使わない） */
  private async loadResume(model: string) {
    this.resumeLoaded = true;
    const o = await this.owner;
    if (!o) return;
    try {
      const r = await liveResumeOf(o.uid, o.sessionId);
      if (r && Date.now() - r.at < RESUME_TTL_MS && r.model === model && r.voice === this.voice) this.handle = r.handle;
    } catch (e) {
      console.error('[live] 会話の続きを読めません', (e as Error).message);
    }
  }

  /** 新しいハンドルを学習の回に保存する（null はハンドルを使わないことにする）。保存できなくても会話は続ける（台が替わったら、会話履歴でつなぐ） */
  private async saveResume(live: LiveResume | null) {
    const o = await this.owner;
    if (!o) return;
    await saveLiveResume(o.uid, o.sessionId, live).catch((e) => console.error('[live] 会話の続きを保存できません', (e as Error).message));
  }

  /** ハンドルを捨てる（次は会話履歴を渡して新しいセッションでつなぐ） */
  private dropHandle() {
    this.handle = undefined;
    void this.saveResume(null);
  }

  /** 切れたら、続きのハンドルでつなぎ直す（goAway で切られる予告が来たときも） */
  private onClose(s: Session, code: number, reason: string) {
    if (this.session !== s) return; // つなぎ直したあとの、前の接続の通知
    this.session = null;
    if (this.closed) return;
    console.log('[live] closed', code, reason);
    // ハンドルがなければ、これまでの会話を渡して新しいセッションでつなぐ
    if (++this.retries > MAX_RETRY) { this.fail(`Gemini Live が切れました（${code} ${reason}）`); return; }
    // ハンドルでつないでも切れつづけるときは、最後はハンドルを捨てて会話履歴でつなぐ
    if (this.retries === MAX_RETRY && this.handle) this.dropHandle();
    void this.connect();
  }

  /** これまでの会話を読む。読めなければ前に読んだまま（会話は続けられる） */
  private async loadMemory() {
    const o = await this.owner;
    if (!o) return;
    try {
      this.memory = await historyOf(o.uid, o.sessionId);
    } catch (e) {
      console.error('[live] これまでの会話を読めません', (e as Error).message);
    }
  }

  /** いまの会話の量を画面に知らせる（画面はメーターに出す） */
  private sendUsage(tokens: number | undefined) {
    if (!tokens) return;
    const model = getConfig('live').model;
    this.send({ type: 'usage', tokens, summaryAt: summaryThreshold('live'), compressAt: compressAt(model), limit: contextTokens(model) });
  }

  /** 入力のトークン数が要約のしきい値をこえたら、話し終わってから要約を始める */
  private checkUsage(tokens: number | undefined) {
    if (!tokens || this.summary !== 'none' || Date.now() - this.summaryFailedAt < SUMMARY_RETRY_MS) return;
    if (tokens <= summaryThreshold('live')) return;
    console.log('[live] 会話が長くなったので要約する', tokens);
    this.summary = 'wanted';
    if (!this.talking) this.startSummary();
  }

  /** お知らせを言ってから、要約する */
  private startSummary() {
    this.summary = 'notice';
    this.send({ type: 'summary', text: SUMMARY_NOTICE });
    this.scripted = true;
    this.sendTurns([...this.takeContext(), scriptTurn(SUMMARY_NOTICE)]);
    this.noticeTimer = setTimeout(() => void this.compact(), NOTICE_WAIT_MS);
  }

  /** 古い会話を要約して、要約＋直近の発言で新しいセッションにつなぎ直す（ハンドルでつなぐと、古い会話がそのまま残るため） */
  private async compact() {
    if (this.summary !== 'notice') return;
    clearTimeout(this.noticeTimer);
    this.summary = 'running';
    const o = await this.owner;
    try {
      if (!o) throw new Error('学習の回がわかりません');
      this.memory = await summarize(o.uid, o.sessionId);
    } catch (e) {
      console.error('[live] 要約できません', (e as Error).message);
      this.summaryFailedAt = Date.now();
      this.summary = 'none';
      return;
    }
    this.summary = 'none';
    this.dropHandle(); // 保存したハンドルも、古い会話が残っているので使わない
    // 新しいセッションに、いまの勉強の様子を知らせなおす
    if (this.sentContext && !this.pendingContext) this.pendingContext = this.sentContext;
    this.sentContext = '';
    const s = this.session;
    this.session = null;
    s?.close();
    void this.connect();
  }

  private reconnect() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.close();
    void this.connect();
  }

  /** 発言を学習の回に保存する。学習の回がない・保存できなくても会話は続ける */
  private async save(who: Message['who'], text: string) {
    const o = await this.owner;
    if (!o) return;
    try {
      await addMessage(o.uid, o.sessionId, who, text);
    } catch (e) {
      console.error('[live] 会話を保存できません', (e as Error).message);
    }
  }

  /** ためていた書き起こしを、言いおわった発言として保存する */
  private saveHeard(who: 'student' | 'tomo') {
    const text = who === 'tomo' ? cleanTomo(this.heard.tomo) : this.heard.student.trim();
    this.heard[who] = '';
    if (text) void this.save(who === 'tomo' ? 'tomo' : 'me', text);
  }

  private fail(message: string) {
    this.send({ type: 'error', message });
    this.ws.close();
  }

  private dispatch(m: FromClient) {
    try {
      this.forward(m);
    } catch (e) {
      console.error('[live] send', e); // 切れかけの接続に送ったときなど。つなぎ直しは onClose がする
    }
  }

  private forward(m: FromClient) {
    const s = this.session!;
    switch (m.type) {
      case 'audio':
        s.sendRealtimeInput({ audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } });
        break;
      case 'audioEnd':
        s.sendRealtimeInput({ audioStreamEnd: true });
        break;
      case 'text':
        this.flushContext();
        this.scripted = false;
        s.sendRealtimeInput({ text: m.text });
        break;
      case 'say':
        // まだ送っていない勉強の様子（話しているあいだに変わったもの）があれば、同じメッセージで送る
        this.scripted = true;
        this.sendTurns([...this.takeContext(), scriptTurn(m.text)]);
        break;
      case 'nudge': {
        this.scripted = false;
        const kind = m.kind && CUE_KINDS.includes(m.kind) ? m.kind : '';
        const image = parseImage(m.image);
        const screen = kind ? parseImage(m.screen) : null;
        this.sendTurns([...this.takeContext(), [
          { text: `（声かけの合図${kind && `・${kind}`}）${m.text}` },
          ...(image ? [{ text: kind ? NOTE_NOW_LABEL : EVIDENCE_LABEL }, { inlineData: image }] : []),
          ...(screen ? [{ text: SCREEN_NOW_LABEL }, { inlineData: screen }] : []),
        ]]);
        break;
      }
      case 'notice':
        this.scripted = false;
        this.sendTurns([...this.takeContext(), `（タイマーの知らせ）${m.text}`]);
        break;
      case 'check':
        this.scripted = false;
        this.sendTurns([...this.takeContext(), `（続けるかの確認）${m.text}`]);
        break;
      case 'screen':
      case 'note':
      case 'timer':
        break; // ws.on('message') で受ける
      case 'context': {
        const text = `（勉強の様子）${m.context}`;
        this.pendingContext = text === this.sentContext ? '' : text;
        // 話していないときはすぐ送る（話す番は渡さないので返事はしない）。話しているときは、話し終わってから送る
        if (!this.talking) this.flushContext();
        break;
      }
    }
  }

  /** turns：1つずつ user turn にする（文字だけなら string）。turnComplete：話す番を Gemini Live に渡すか（false なら会話に足すだけで、返事はしない） */
  private sendTurns(turns: (string | TurnPart[])[], turnComplete = true) {
    if (turns.length) this.session?.sendClientContent({ turns: turns.map((t) => ({ role: 'user', parts: typeof t === 'string' ? [{ text: t }] : t })), turnComplete });
  }

  /** まだ送っていない勉強の様子（なければ空） */
  private takeContext() {
    const c = this.pendingContext;
    if (!c) return [];
    this.sentContext = c;
    this.pendingContext = '';
    return [c];
  }

  /** まだ送っていない勉強の様子を、話す番を渡さずに送る */
  private flushContext() {
    this.sendTurns(this.takeContext(), false);
  }

  private onMessage(m: LiveServerMessage) {
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts ?? []) {
        if (p.inlineData?.data) { this.talking = true; this.send({ type: 'audio', data: p.inlineData.data }); }
      }
      if (sc.inputTranscription?.text) {
        this.scripted = false; // 生徒が話したので、このあとの返事はセリフではない
        this.heard.student += sc.inputTranscription.text;
        this.send({ type: 'transcript', who: 'student', text: sc.inputTranscription.text });
      }
      if (sc.outputTranscription?.text) {
        this.saveHeard('student'); // 家トモが返事を始めたら、生徒は言いおわっている
        if (!this.scripted) this.heard.tomo += sc.outputTranscription.text; // セリフは保存しない
        this.send({ type: 'transcript', who: 'tomo', text: sc.outputTranscription.text, scripted: this.scripted });
      }
      if (sc.interrupted) this.send({ type: 'interrupted' });
      if (sc.turnComplete || sc.interrupted) {
        this.saveHeard('student');
        this.saveHeard('tomo');
        this.talking = false;
        if (sc.turnComplete) this.send({ type: 'turn' });
        if (this.summary === 'notice') { void this.compact(); return; } // お知らせを言い終わった
        this.flushContext();
        if (this.summary === 'wanted') this.startSummary();
      }
    }
    this.sendUsage(m.usageMetadata?.totalTokenCount);
    this.checkUsage(m.usageMetadata?.totalTokenCount);
    if (m.toolCall?.functionCalls?.length) void this.onToolCall(m.toolCall.functionCalls);
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      this.handle = m.sessionResumptionUpdate.newHandle;
      this.retries = 0;
      void this.saveResume({ handle: this.handle, at: Date.now(), model: this.model, voice: this.voice });
    }
    if (m.goAway) this.reconnect();
  }

  private async onToolCall(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    const responses = await Promise.all(calls.map(async (c) => {
      const r = await runTool(c.name, this.tools, c.args ?? {});
      return { id: c.id, name: c.name, response: r.result, ...(r.image && { parts: [{ inlineData: r.image }] }) };
    }));
    this.scripted = false;
    this.session?.sendToolResponse({ functionResponses: responses });
  }

  /** 関数が使う手段。画像は関数の結果（parts）に入れて返す（sendRealtimeInput の video で先に送っても、関数の結果を待っているあいだの画像は見てくれなかった） */
  private tools: ToolContext = {
    screen: () => this.requestImage('screenRequest'),
    note: () => this.requestImage('noteRequest'),
    timer: { get: () => this.timer, set: (s) => { this.timer = s; this.send({ type: 'timer', state: toWire(s) }); } },
    study: (action) => this.send({ type: 'study', action }),
  };

  /** ブラウザに、共有している画面のいまの1コマ（screenRequest）か、手元のノートのいまの画像（noteRequest）を頼む */
  private async requestImage(type: 'screenRequest' | 'noteRequest'): Promise<Image | null> {
    const id = ++this.imageId;
    const raw = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { this.imageWaits.delete(id); resolve(null); }, IMAGE_TIMEOUT_MS);
      this.imageWaits.set(id, (image) => { clearTimeout(timer); this.imageWaits.delete(id); resolve(image); });
      this.send({ type, id });
    });
    return parseImage(raw);
  }
}

/** /api/live の WebSocket。http サーバーへのつなぎ方は index.ts（ほかの WebSocket と同じ http サーバーで受けるため、パスで振り分ける） */
export function liveSocket() {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req: IncomingMessage) => { new LiveLesson(ws, ownerOf(req), voiceOf(req)); });
  return wss;
}

/** 選べる家トモの声（Gemini Live のプリセットの声の名前）。画面の「設定」で選ぶ（client/src/settings.ts の LIVE_VOICES と同じ名前） */
const VOICES = ['Puck', 'Charon', 'Orus', 'Fenrir', 'Kore', 'Aoede', 'Leda', 'Zephyr', 'Sulafat', 'Vindemiatrix', 'Achernar'];

/** URL の voice の声。ない・知らない名前なら Puck（Gemini Live の既定の声） */
function voiceOf(req: IncomingMessage) {
  const v = new URL(req.url ?? '', 'http://x').searchParams.get('voice') ?? '';
  return VOICES.includes(v) ? v : 'Puck';
}

/** URL の session の学習の回と、ログインしているユーザー。わからなければ null（会話は続けられる） */
async function ownerOf(req: IncomingMessage): Promise<Owner> {
  const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('session');
  if (!sessionId) return null;
  try {
    const uid = await userOf(req);
    return uid ? { uid, sessionId } : null;
  } catch (e) {
    console.error('[live] ユーザーがわかりません', (e as Error).message);
    return null;
  }
}
