import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiApi, type AiConfig, type AiLevel, type AiStatus, type NoteProgress, type TokenUsage } from '../api';
import { PROGRESS_CHIP, PROGRESS_LABEL } from '../noteReader';
import { useSettings } from '../settings';
import type { Capture } from '../capture';
import { CameraSizeField, NoteImageFields } from './SettingFields';

// 手元ノートキャプチャ設定（「設定」の「手元ノート設定」に置く）。手元カメラでも iPad のノートでも試せる
// 映像の大きさ・AI に送る画像の大きさと画質を変えて、ノートの様子をどこまで判定できるか・かかった時間・トークン数を確かめる
// 「読み取る」を押すたびに1回読み取る（続けて読み取ることはしない。授業で読み取る間隔は管理者設定）
// 2回目からは、前回送った画像もいっしょに送る（授業と同じ）
// ここで変えた設定は保存し、授業でも使う

export const MAX_SIDES = [640, 1024, 1280, 1920, 0]; // 0 は縮めない
export const QUALITIES = [0.7, 0.85, 0.95];
const LEVEL_LABEL: Record<AiLevel, string> = { low: '低', medium: '中', high: '高' };
const MAX_RESULTS = 30;

/** 画像の切り出し方（AI のモデル・考える深さ・解像度は「管理者設定」のノートの読み取りの設定を使う） */
type Options = { maxSide: number; quality: number };

type Result = {
  id: number;
  at: Date;
  image: string; // 送った画像（data URL）
  imageW: number;
  imageH: number;
  imageKb: number;
  options: Options;
  rotate: number; // 送る前に回した角度
  withPrev: boolean; // 前回の画像もいっしょに送ったか
  observation: string;
  readable: boolean;
  unreadableReason: string;
  progress: NoteProgress;
  ms: number;
  usage: TokenUsage;
  model: string;
  config: AiConfig; // サーバーが使った AI の設定
};

type Props = {
  /** 手元カメラの映像（映像の大きさを出すため。iPad のノートは null） */
  video: HTMLVideoElement | null;
  /** 読み取り用の画像を作る関数（手元カメラ・iPad のノート） */
  capture: Capture | null;
  ai: AiStatus | null;
};

export function CameraLab({ video, capture, ai }: Props) {
  const [videoSize, setVideoSize] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [settings] = useSettings(); // 映像の大きさ・画像の大きさ・画質・向きは授業と同じ設定
  const pad = settings.handSource === 'pad'; // iPad のノート（映像の大きさと向きは使わない）
  const options: Options = useMemo(() => ({ maxSide: settings.noteMaxSide, quality: settings.noteQuality }), [settings.noteMaxSide, settings.noteQuality]);
  const inFlight = useRef(false);
  const prev = useRef<{ image: string; at: number } | null>(null); // 前回送った画像
  const nextId = useRef(1);


  // 実際の映像の大きさ（カメラが希望どおりの大きさに対応しているとは限らない）
  useEffect(() => {
    if (!video) { setVideoSize(''); return; }
    const update = () => setVideoSize(video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '');
    update();
    video.addEventListener('resize', update);
    video.addEventListener('loadedmetadata', update);
    return () => { video.removeEventListener('resize', update); video.removeEventListener('loadedmetadata', update); };
  }, [video]);

  // AI を呼ぶたびに結果を1件残す（前の読み取り中なら何もしない）
  const readOnce = useCallback(async () => {
    if (!capture || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const send = async (rotate: number) => {
      const c = capture({ maxSide: options.maxSide || Infinity, quality: options.quality, rotate });
      if (!c) return null;
      const { image } = c;
      const at = Date.now();
      const p = prev.current;
      const r = await aiApi.readNote(image, p ? { image: p.image, elapsed: (at - p.at) / 1000 } : undefined, pad ? 'pad' : 'camera');
      prev.current = { image, at };
      const result: Result = {
        id: nextId.current++,
        at: new Date(),
        image,
        imageW: c.width,
        imageH: c.height,
        imageKb: Math.round((image.length - image.indexOf(',') - 1) * 0.75 / 1024),
        options,
        rotate,
        withPrev: !!p,
        observation: r.observation,
        readable: r.readable,
        unreadableReason: r.unreadableReason,
        progress: r.progress,
        ms: r.ms,
        usage: r.usage,
        model: r.model,
        config: r.config,
      };
      setResults((rs) => [result, ...rs].slice(0, MAX_RESULTS));
      return r;
    };
    try {
      await send(pad ? 0 : settings.handCameraRotate);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [capture, options, pad, settings.handCameraRotate, settings.handSource]);

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ready = !!ai?.purposes.note.ready;

  async function copyResults() {
    const data = results.map((r) => ({
      at: r.at.toISOString(),
      model: r.model,
      thinking: r.config.thinking,
      mediaResolution: r.config.mediaResolution,
      source: settings.handSource,
      camera: pad ? undefined : videoSize,
      image: `${r.imageW}x${r.imageH} (${r.imageKb}KB)`,
      ...r.options,
      rotate: r.rotate,
      withPrev: r.withPrev,
      ms: r.ms,
      usage: r.usage,
      observation: r.observation,
      readable: r.readable,
      unreadableReason: r.unreadableReason,
      progress: r.progress,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify({ results: data }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(`コピーできませんでした：${(e as Error).message}`);
    }
  }

  return (
    <>
      <div className="ct-opts">
        {!pad && (
          <CameraSizeField><span className="num">実際 {videoSize || '—'}</span></CameraSizeField>
        )}
        <NoteImageFields />
      </div>

      <div className="row-wrap">
        <button type="button" className="btn btn-primary" disabled={!capture || busy || !ready} onClick={readOnce}>
          {busy ? '読み取り中…' : '読み取る'}
        </button>
        {results.length > 0 && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyResults}>{copied ? 'コピーしました' : '結果をコピー（JSON）'}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResults([]); prev.current = null; }}>クリア</button>
          </>
        )}
      </div>
      {error && <div className="setup-error" role="alert">{error}</div>}

      {results.length > 0 && (
        <div className="ct-summary num">
          <div><span>回数</span><b>{results.length}</b></div>
          <div><span>平均の時間</span><b>{(avg(results.map((r) => r.ms)) / 1000).toFixed(1)} 秒</b></div>
          <div><span>平均のトークン</span><b>{Math.round(avg(results.map((r) => r.usage.total)))}</b></div>
        </div>
      )}
      <ol className="ct-results">
        {results.map((r) => (
          <li key={r.id} className="ct-result">
            <a className="ct-thumb" href={r.image} download={`camera-test-${r.id}.jpg`} title="送った画像を保存">
              <img src={r.image} alt={`${r.id} 回目に送った画像`} />
            </a>
            <div className="ct-body">
              <div className="ct-meta">
                <b>#{r.id}</b>
                <span className="muted num">{r.at.toLocaleTimeString()}</span>
                <span className="chip chip-gray num">{(r.ms / 1000).toFixed(1)} 秒</span>
                <span className={`chip ${r.readable ? 'chip-blue' : 'chip-red'}`}>{r.readable ? '読み取れる' : '読み取れない'}</span>
                <span className={`chip ${PROGRESS_CHIP[r.progress]}`}>{PROGRESS_LABEL[r.progress]}</span>
                {!r.withPrev && <span className="chip chip-gray">前回の画像なし</span>}
              </div>
              <div className="ct-params muted num">
                画像 {r.imageW}×{r.imageH}・{r.imageKb}KB・画質 {r.options.quality}{r.rotate ? `・${r.rotate}° 回転` : ''}／{r.model}・考える深さ {LEVEL_LABEL[r.config.thinking]}{r.model.startsWith('gemini') ? `・解像度 ${LEVEL_LABEL[r.config.mediaResolution]}` : ''}／トークン 入力 {r.usage.prompt}・出力 {r.usage.output}・思考 {r.usage.thoughts}
              </div>
              <p style={{ margin: 0 }}>{r.observation || <span className="muted">（様子の説明なし）</span>}</p>
              {r.unreadableReason && <p className="setup-note">読み取れない理由：{r.unreadableReason}</p>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
