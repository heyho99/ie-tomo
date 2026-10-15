import { useEffect, useRef, useState } from 'react';
import type { Capture } from '../capture';
import { useSettings } from '../settings';

// 手元カメラの映像をそのまま映す。いまは PC につないだカメラ（会議カメラを手元に向ける想定）を使う
// 使うカメラは設定（handCameraId）に保存し、授業と「設定」で同じものを使う
// active が false のあいだはカメラを止める（一時中断）。画面からはずれたときも止まる
type Status = 'off' | 'starting' | 'on' | 'denied' | 'none' | 'error';

const MESSAGE: Record<Exclude<Status, 'on'>, string> = {
  off: 'カメラは止まっています',
  starting: 'カメラを準備しています…',
  denied: 'カメラが許可されていません。ブラウザのアドレスバーからカメラを許可してください。',
  none: 'カメラが見つかりませんでした。カメラをつないでください。',
  error: 'カメラを開けませんでした。ほかのアプリが使っていないか確認してください。',
};

/** 映像の大きさの選択肢（カメラが対応していなければ近い大きさになる） */
export const CAMERA_SIZES = [
  { key: '720p', label: '1280×720', width: 1280, height: 720 },
  { key: '1080p', label: '1920×1080', width: 1920, height: 1080 },
  { key: '4k', label: '3840×2160', width: 3840, height: 2160 },
];

type Props = {
  active?: boolean;
  onStatus?: (on: boolean) => void;
  /** 映像が出たら video 要素を渡す（読み取り用に1コマ切り出すため）。止まったら null */
  onVideo?: (video: HTMLVideoElement | null) => void;
  /** 映す映像を時計回りに回す角度（送る画像と同じ向きで確かめるため）。枠に収まるように縮める */
  rotate?: number;
};

export function HandCamera({ active = true, onStatus, onVideo, rotate = 0 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [settings, setSettings] = useSettings();
  const [status, setStatus] = useState<Status>('starting');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [current, setCurrent] = useState(''); // 実際に使っているカメラ
  const deviceId = settings.handCameraId;
  const { width, height } = CAMERA_SIZES.find((s) => s.key === settings.handCameraSize) ?? CAMERA_SIZES[0]; // 大きさは設定（handCameraSize）

  useEffect(() => {
    if (!active) { setStatus('off'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('error'); return; }
    let stream: MediaStream | null = null;
    let alive = true;
    setStatus('starting');
    navigator.mediaDevices
      .getUserMedia({ video: { ...(deviceId && { deviceId: { exact: deviceId } }), width: { ideal: width }, height: { ideal: height } }, audio: false })
      .then(async (s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCurrent(s.getVideoTracks()[0]?.getSettings().deviceId ?? '');
        setStatus('on');
        // ラベルは許可のあとでないと取れないので、ここで一覧を作る
        const all = await navigator.mediaDevices.enumerateDevices();
        if (alive) setDevices(all.filter((d) => d.kind === 'videoinput'));
      })
      .catch((e: DOMException) => {
        if (!alive) return;
        // 保存したカメラが見つからない（抜いた等）なら、既定のカメラでやり直す
        if (deviceId && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) { setSettings({ handCameraId: '' }); return; }
        setStatus(e.name === 'NotAllowedError' ? 'denied' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'none' : 'error');
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [deviceId, active, setSettings, width, height]);

  // 回した映像が枠からはみ出さない縮め方（枠の大きさ・映像の大きさが変わったら計り直す）
  useEffect(() => {
    const view = viewRef.current, video = videoRef.current;
    if (!rotate || !view || !video || status !== 'on') { setFit(1); return; }
    const update = () => {
      const W = view.clientWidth, H = view.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
      if (!W || !H || !vw || !vh) return;
      const k = Math.min(W / vw, H / vh); // object-fit: contain で映る大きさ
      const box = rotatedSize(vw * k, vh * k, rotate);
      setFit(Math.min(1, W / box.width, H / box.height));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(view);
    video.addEventListener('resize', update);
    return () => { ro.disconnect(); video.removeEventListener('resize', update); };
  }, [rotate, status]);

  useEffect(() => { onStatus?.(status === 'on'); }, [status, onStatus]);
  useEffect(() => { onVideo?.(status === 'on' ? videoRef.current : null); }, [status, onVideo]);

  return (
    <div className="cam">
      <div className="cam-view" ref={viewRef}>
        <video ref={videoRef} autoPlay playsInline muted hidden={status !== 'on'} style={rotate ? { transform: `rotate(${rotate}deg) scale(${fit})` } : undefined} />
        {status !== 'on' && <div className="cam-msg">{MESSAGE[status]}</div>}
      </div>
      {status === 'on' && devices.length > 1 && (
        <label className="dev-select">
          <span>カメラ</span>
          <select value={deviceId || current} onChange={(e) => setSettings({ handCameraId: e.target.value, handCameraRotate: 0 })}>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `カメラ ${i + 1}`}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

const PRESETS = [0, 90, 180, 270];

/** 手元カメラの向き（handCameraRotate）を変える。ボタンで 90° ずつ、バーで 1° ずつ。授業と「設定」で同じ設定を使う */
export function RotateControl() {
  const [settings, setSettings] = useSettings();
  const deg = settings.handCameraRotate;
  return (
    <div className="rot">
      <div className="pills">
        {PRESETS.map((v) => (
          <button key={v} type="button" className="pill" aria-pressed={deg === v} onClick={() => setSettings({ handCameraRotate: v })}>{v ? `${v}° 回す` : 'そのまま'}</button>
        ))}
      </div>
      <div className="rot-bar">
        <input type="range" min={0} max={359} step={1} value={deg} aria-label="回す角度" onChange={(e) => setSettings({ handCameraRotate: Number(e.target.value) })} />
        <b className="num">{deg}°</b>
      </div>
    </div>
  );
}

/** w×h の画像を rotate 度回したときに、はみ出さずに収まる大きさ */
export function rotatedSize(w: number, h: number, rotate: number) {
  const r = (rotate * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return { width: Math.round(w * c + h * s), height: Math.round(w * s + h * c) };
}

/** 映像から1コマを JPEG（data URL）で切り出す。長い辺を maxSide に縮める。rotate（時計回りの角度。何度でもよい）で向きを直す。斜めのときのすき間は白で埋める */
export function captureFrame(video: HTMLVideoElement, maxSide = 1280, quality = 0.85, rotate = 0): string | null {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  const out = rotatedSize(dw, dh, rotate);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 手元カメラの映像から、読み取り用の画像を作る関数（iPad のノートと同じ形にする） */
export function cameraCapture(video: HTMLVideoElement): Capture {
  return ({ maxSide, quality, rotate }) => {
    const image = captureFrame(video, maxSide, quality, rotate);
    if (!image) return null;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const { width, height } = rotatedSize(Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale), rotate);
    return { image, width, height };
  };
}
