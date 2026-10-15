import { useCallback, useEffect, useRef, useState } from 'react';

// マイクまわり：マイクの音量（「設定」のメーター）と、チャットモードの聞き取り（ブラウザの音声認識。Web Speech API）
// 会話モードの声のやりとりは Gemini Live（live.ts）。音声認識はブラウザの既定のマイクを使う（Chrome / Edge で動く）

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const speechSupported = !!Ctor;

const ERROR: Record<string, string> = {
  'not-allowed': 'マイクが許可されていません',
  'no-speech': '声が聞こえませんでした',
  'audio-capture': 'マイクが見つかりません',
  network: '音声認識につながりませんでした',
};

/** 話しかけを1回聞き取る。言い終わると onFinal に文字が渡る */
export function useSpeechRecognition(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [code, setCode] = useState(''); // エラーの種類（no-speech など）。聞き続けるときに、やり直すかを決める
  const rec = useRef<Recognition | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => rec.current?.stop(), []);
  /** 聞き取りをやめる（聞きかけの言葉は捨てる） */
  const abort = useCallback(() => rec.current?.abort(), []);
  const clearError = useCallback(() => { setError(''); setCode(''); }, []);
  const start = useCallback(() => {
    if (!Ctor) return;
    rec.current?.abort();
    const r = new Ctor();
    r.lang = 'ja-JP';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) { setInterim(''); onFinalRef.current(res[0].transcript); return; }
        text += res[0].transcript;
      }
      setInterim(text);
    };
    r.onerror = (e) => {
      if (e.error === 'aborted') return;
      setCode(e.error);
      setError(ERROR[e.error] ?? `音声認識のエラー（${e.error}）`);
    };
    r.onend = () => { if (rec.current === r) { setListening(false); setInterim(''); } }; // やめた前の聞き取りの終了通知は無視する
    rec.current = r;
    setError('');
    setCode('');
    setListening(true);
    r.start();
  }, []);

  useEffect(() => () => rec.current?.abort(), []);
  return { listening, interim, error, code, start, stop, abort, clearError };
}

/** マイクが許可されていないなど、やり直しても聞けないエラー */
const MIC_FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

/**
 * active のあいだ聞き続け、言い終わるたびに onFinal に文字を渡す（チャットモードの声での話しかけ）
 * 1回の聞き取りは言い終わるか、しばらく黙ると終わるので、すぐに聞きなおす（エラーのあとは少し待つ）
 */
export function useListening(active: boolean, onFinal: (text: string) => void) {
  const rec = useSpeechRecognition(onFinal);
  const blocked = MIC_FATAL.has(rec.code);
  const listen = speechSupported && active;
  useEffect(() => {
    if (!listen) { rec.abort(); return; }
    if (rec.listening || blocked) return;
    const t = setTimeout(rec.start, rec.code && rec.code !== 'no-speech' ? 1500 : 200);
    return () => clearTimeout(t);
  }, [listen, rec.listening, rec.code, blocked, rec.start, rec.abort]);
  return { listening: listen && !blocked, interim: rec.interim, error: blocked ? rec.error : '', code: rec.code, clearError: rec.clearError };
}


/** マイクを開く。選んだマイクが見つからなければ（抜いた・ID が変わった）既定のマイクにする */
export async function openMic(deviceId: string, audio: MediaTrackConstraints = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'SecurityError'); // http://<IP> で開くと使えない（localhost か https だけ）
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, ...(deviceId && { deviceId: { exact: deviceId } }) }, video: false });
  } catch (e) {
    if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes((e as DOMException).name)) throw e;
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }
}

/** マイクを開けなかった理由 */
export function micErrorText(e: unknown): string {
  switch ((e as DOMException)?.name) {
    case 'NotAllowedError': return 'マイクが許可されていません。ブラウザのアドレスバーと、Windows の「設定 → プライバシーとセキュリティ → マイク」を確かめてください。';
    case 'NotReadableError': return 'マイクを開けませんでした。ほかのアプリ（Zoom・Teams など）が使っていないか確かめてください。';
    case 'NotFoundError': return 'マイクが見つかりません。つながっているか確かめてください。';
    case 'SecurityError': return 'このアドレスではマイクを使えません。PC では http://localhost:5173 で開いてください。';
    default: return `マイクを開けませんでした（${(e as Error)?.name || e}）`;
  }
}

/** マイクの音量（0〜1）。active のあいだだけマイクを開く */
export function useMicLevel(deviceId: string, active: boolean) {
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    if (!active) { setLevel(0); return; }
    let alive = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    openMic(deviceId)
      .then(async (s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setError('');
        setCurrent(s.getAudioTracks()[0]?.getSettings().deviceId ?? '');
        const all = await navigator.mediaDevices.enumerateDevices();
        if (alive) setDevices(all.filter((d) => d.kind === 'audioinput'));
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const loop = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
          raf = requestAnimationFrame(loop);
        };
        loop();
      })
      .catch((e) => { if (alive) setError(micErrorText(e)); });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close();
    };
  }, [deviceId, active]);

  return { level, error, devices, current };
}
