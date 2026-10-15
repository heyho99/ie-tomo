import { useEffect, useRef, useState } from 'react';
import { useFaceNudge, useFaceTracker, type FaceFrame, type FaceNudge, type FaceView } from '../face';
import { useNudgeRules } from '../nudgeRules';
import { useSettings } from '../settings';

// 顔カメラ（PC の内蔵カメラ）の映像を映し、表情と頭の向きを解析する（face.ts）。解析はブラウザの中だけで、映像はどこにも送らない
// 使うカメラは設定（faceCameraId）に保存し、授業と「設定」で同じものを使う。映像は鏡のように左右を反転して映す
// detail：数値の一覧を出す（「設定」）。onNudge：眠そう・下を向いているの声かけの合図（授業）。quiet のあいだは合図を数えない
type Status = 'off' | 'starting' | 'on' | 'denied' | 'none' | 'error';

const MESSAGE: Record<Exclude<Status, 'on'>, string> = {
  off: '顔カメラは止まっています',
  starting: '顔カメラを準備しています…',
  denied: 'カメラが許可されていません。ブラウザのアドレスバーからカメラを許可してください。',
  none: 'カメラが見つかりませんでした。',
  error: 'カメラを開けませんでした。ほかのアプリが使っていないか確認してください。',
};

type Props = {
  active?: boolean;
  detail?: boolean;
  quiet?: boolean;
  /** 下を向きつづけていたら合図を出すか（手元ノートがオンならノートに変化がないとき、オフならいつも。学習画面が決める） */
  downNudge?: boolean;
  onNudge?: (n: FaceNudge) => void;
  /** カメラに何が映っているか（カメラが止まっている・解析の準備中は null） */
  onView?: (view: FaceView | null) => void;
  /** 下を向いているか（変わったときに知らせる。カメラが止まっているときは false） */
  onDown?: (down: boolean) => void;
  /** 目を閉じているか（変わったときに知らせる。カメラが止まっているときは false） */
  onClosed?: (closed: boolean) => void;
  className?: string;
};

export function FaceCamera({ active = true, detail = false, quiet = false, downNudge = false, onNudge, onView, onDown, onClosed, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [settings, setSettings] = useSettings();
  const [status, setStatus] = useState<Status>('starting');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [current, setCurrent] = useState('');
  const deviceId = settings.faceCameraId;

  useEffect(() => {
    if (!active) { setStatus('off'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('error'); return; }
    let stream: MediaStream | null = null;
    let alive = true;
    setStatus('starting');
    // 表情の解析には 640×480 で十分（大きいと遅くなる）
    navigator.mediaDevices
      .getUserMedia({ video: { ...(deviceId && { deviceId: { exact: deviceId } }), width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then(async (s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCurrent(s.getVideoTracks()[0]?.getSettings().deviceId ?? '');
        setStatus('on');
        const all = await navigator.mediaDevices.enumerateDevices();
        if (alive) setDevices(all.filter((d) => d.kind === 'videoinput'));
      })
      .catch((e: DOMException) => {
        if (!alive) return;
        setStatus(e.name === 'NotAllowedError' ? 'denied' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'none' : 'error');
      });
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active, deviceId]);

  const { frame, error } = useFaceTracker(status === 'on' ? videoRef.current : null, status === 'on');
  const rules = useNudgeRules();
  useFaceNudge(frame, quiet, downNudge, rules?.face ?? null, (n) => onNudge?.(n));
  const view = status === 'on' && frame ? frame.view : null;
  useEffect(() => { onView?.(view); }, [view, onView]);
  useEffect(() => () => onView?.(null), [onView]); // 外したら「止まっている」にもどす
  const down = view !== null && !!frame?.down;
  useEffect(() => { onDown?.(down); }, [down, onDown]);
  const closed = view !== null && !!frame?.closed;
  useEffect(() => { onClosed?.(closed); }, [closed, onClosed]);

  // 顔の特徴点（顔が見えないときは姿勢の頭と肩の点）を映像の上に重ねる
  useEffect(() => {
    const canvas = canvasRef.current, video = videoRef.current;
    if (!canvas || !video) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const points = frame?.landmarks ?? frame?.pose;
    if (!frame || !points) return;
    ctx.fillStyle = frame.pose ? '#FFE08A' : '#9FD3FF';
    const r = Math.max(1, canvas.width / (frame.pose ? 80 : 400)); // 姿勢の点は数が少ないので大きく
    for (const p of points) ctx.fillRect(p.x * canvas.width - r / 2, p.y * canvas.height - r / 2, r, r);
  }, [frame]);

  return (
    <div className={`cam face-cam ${className ?? ''}`}>
      <div className="cam-view">
        <video ref={videoRef} autoPlay playsInline muted hidden={status !== 'on'} />
        <canvas ref={canvasRef} hidden={status !== 'on'} />
        {status !== 'on' && <div className="cam-msg">{MESSAGE[status]}</div>}
      </div>
      {error && <div className="setup-error" role="alert">{error}</div>}
      {detail && status === 'on' && devices.length > 1 && (
        <label className="dev-select">
          <span>カメラ</span>
          <select value={deviceId || current} onChange={(e) => setSettings({ faceCameraId: e.target.value })}>
            {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `カメラ ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      {status === 'on' && (detail ? <FaceNumbers frame={frame} /> : <div className="row-wrap"><FaceChips frame={frame} /></div>)}
    </div>
  );
}

/** いまの様子のチップ（何が映っているか・目を閉じている・下を向いている） */
function FaceChips({ frame }: { frame: FaceFrame | null }) {
  if (!frame) return <span className="chip chip-gray">解析を準備しています…</span>;
  if (frame.view === 'body') return <span className="chip chip-cream">映っている（顔は見えない）</span>;
  if (frame.view === 'none') return <span className="chip chip-red">映っていない</span>;
  return (
    <>
      <span className="chip chip-blue">顔：見えている</span>
      {frame.closed && <span className="chip chip-cream">目を閉じている</span>}
      {frame.down && <span className="chip chip-gray">下を向いている</span>}
    </>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const deg = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}°`;

/** 解析した数値の一覧（しきい値は face.ts の FACE_RULES） */
function FaceNumbers({ frame }: { frame: FaceFrame | null }) {
  return (
    <div className="face-nums">
      <div className="row-wrap"><FaceChips frame={frame} /></div>
      {frame?.present && (
        <dl className="note-props num">
          <dt>目の開き</dt><dd>{pct(frame.eyeOpen)}</dd>
          <dt>眉の寄せ</dt><dd>{pct(frame.browDown)}</dd>
          <dt>頭の向き</dt><dd>左右 {deg(frame.yaw)}・上下 {deg(frame.pitch)}</dd>
          <dt>目の向き（左右）</dt><dd>{Math.round(frame.gazeH * 100) / 100}</dd>
        </dl>
      )}
    </div>
  );
}
