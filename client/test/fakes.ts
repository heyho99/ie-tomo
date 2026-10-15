import { vi } from 'vitest';

// ブラウザの API の偽物（jsdom にないもの）

/** WebSocket の偽物。instances に作られた順に入る。sent：画面が送ったもの */
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(s: string) {
    if (this.readyState !== 1) throw new Error('まだつながっていない');
    this.sent.push(JSON.parse(s));
  }
  close() { this.readyState = 3; }
  /** サーバーにつながった */
  open() { this.readyState = 1; this.onopen?.(); }
  /** サーバーから届いた */
  receive(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
  /** サーバーから切られた */
  drop() { this.readyState = 3; this.onclose?.(); }
  of(type: string) { return this.sent.filter((m) => m.type === type); }
  static last() { return FakeWebSocket.instances.at(-1)!; }
}

/** 声を鳴らす AudioContext の偽物（鳴らさない） */
export class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createGain() { return { gain: { value: 1 }, connect: vi.fn() }; }
  createBuffer(_ch: number, n: number, rate: number) { return { duration: n / rate, getChannelData: () => new Float32Array(n) }; }
  createBufferSource() { return { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

export function installBrowserFakes() {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
}
