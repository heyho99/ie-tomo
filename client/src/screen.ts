import { useCallback, useEffect, useRef, useState } from 'react';
import { debugLog } from './debug';
import { drawInk, type InkStroke } from './screenInk';

// 画面共有：生徒が別タブで見ている教材を、家トモに見せる（getDisplayMedia）
// 映像は送りつづけず、家トモが見たいとき（生徒が画面について聞いたとき）だけ、いまの1コマを JPEG にして渡す
// チャットモードは発言といっしょに1コマを送っておき、家トモが見たいときだけサーバーが AI に渡す
// 生徒がペンで書き込んだ線・図形（ink）は、画面の上に重ねて映し、1コマにも重ねて渡す

const MAX_SIDE = 1280; // AI に渡す画像の長い辺（px）
const QUALITY = 0.7;

export const screenShareSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

export function useScreenShare() {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<MediaStream | null>(null); // 学習画面に小さく映す映像
  const [label, setLabel] = useState(''); // 共有しているタブ・ウィンドウの名前
  const [lastLook, setLastLook] = useState<number | null>(null); // 家トモが最後に画面を見た時刻
  const [strokes, setStrokes] = useState<InkStroke[]>([]); // 画面への書き込み
  const strokesRef = useRef<InkStroke[]>([]);
  strokesRef.current = strokes;
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setSharing(false);
    setShown(null);
    setLabel('');
    setLastLook(null);
    setStrokes([]);
  }, []);

  /** 共有をはじめる。共有するタブは生徒が選ぶ */
  const start = useCallback(async () => {
    setError('');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' }, // はじめにタブを選ぶ画面を出す
        audio: false,
        selfBrowserSurface: 'exclude', // この学習画面のタブは選べないようにする
        surfaceSwitching: 'include', // 共有中に別のタブへ切り替えられる
      } as DisplayMediaStreamOptions);
      stop();
      stream.current = s;
      const v = video.current ?? (video.current = Object.assign(document.createElement('video'), { muted: true, playsInline: true }));
      v.srcObject = s;
      await v.play();
      // ブラウザの「共有を停止」で止められたとき
      s.getVideoTracks()[0]?.addEventListener('ended', () => { if (stream.current === s) { stop(); debugLog.event('画面共有：止められた'); } });
      setSharing(true);
      setShown(s);
      setLabel(s.getVideoTracks()[0]?.label ?? '');
      debugLog.event('画面共有：はじめた', s.getVideoTracks()[0]?.label);
    } catch (e) {
      const name = (e as Error).name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') setError(`画面を共有できませんでした：${(e as Error).message}`);
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  /** いま共有している画面の1コマ（JPEG の data URL。書き込みも重ねる）。共有していなければ null */
  const capture = useCallback((): string | null => {
    const v = video.current;
    if (!stream.current || !v || !v.videoWidth) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, c.width, c.height);
    drawInk(g, strokesRef.current, c.width, c.height);
    return c.toDataURL('image/jpeg', QUALITY);
  }, []);

  /** 画面への書き込み：足す・ひとつ戻す・ぜんぶ消す */
  const ink = {
    strokes,
    add: useCallback((s: InkStroke) => setStrokes((a) => [...a, s]), []),
    undo: useCallback(() => setStrokes((a) => a.slice(0, -1)), []),
    clear: useCallback(() => setStrokes([]), []),
  };

  /** 家トモが画面を見た（画面に時刻を出す） */
  const looked = useCallback(() => setLastLook(Date.now()), []);

  return { sharing, error, stream: shown, label, lastLook, start, stop, capture, looked, ink };
}
