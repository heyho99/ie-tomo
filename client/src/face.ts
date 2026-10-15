import { useEffect, useRef, useState } from 'react';
import type { NudgeRules } from './api';
import type { FaceLandmarker, FaceLandmarkerResult, NormalizedLandmark, PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision';

// 顔カメラ（PC の内蔵カメラ）の映像から、表情と頭の向きを数値にする。解析はブラウザの中だけで行い、顔の映像はどこにも送らない
// 顔が見えないとき（下を向いている・映っていないなど）は、姿勢（Pose Landmarker）で人が映っているかを見る
// MediaPipe の WASM とモデルは、このアプリのサーバー（public/mediapipe）から読む（scripts/copy-mediapipe.mjs）
// AI（Gemini Live・チャット）に渡すのは「眠そう」「下を向いている」のような様子の文だけ

/** カメラに何が映っているか。face：顔が見える、body：人は映っているが顔が見えない（下・横を向いているなど）、none：人が映っていない */
export type FaceView = 'face' | 'body' | 'none';

/** 1コマの解析結果。present：顔が見えているか（view が face）。数値は顔が見えていないときは 0 */
export type FaceFrame = {
  view: FaceView;
  present: boolean;
  eyeOpen: number; // 目の開き（0〜1。両目の eyeBlink の平均を 1 から引く）
  browDown: number; // 眉の寄せ（0〜1。困ったとき・考えているときに大きくなる）
  yaw: number; // 頭の左右の向き（度。正面が 0。左右どちらが正かはカメラによる）
  pitch: number; // 頭の上下の向き（度。上が正、下（ノートを見る）が負）
  gazeH: number; // 目の左右の向き（-1〜1）
  closed: boolean; // 目を閉じている（下を向いているときは、まぶたが閉じて見えるので数えない）
  down: boolean; // 下を向いている（顔が見えて頭が downPitch より下を向いている、または人は映っているが顔が見えない）
  landmarks: NormalizedLandmark[] | null; // 顔の特徴点（478点。画面の表示用）
  pose: NormalizedLandmark[] | null; // 姿勢の頭と肩の点（顔が見えないときだけ。画面の表示用）
};

/** 判定のしきい値（機能一覧 5章）。使ってみて合わせる。声かけの合図を出す秒数・クールタイムは管理者設定（nudgeRules.ts） */
export const FACE_RULES = {
  closedEye: 0.35, // 目の開きがこれより小さければ「目を閉じている」
  downPitch: -15, // 頭がこれより下を向いていたら「下を向いている」。目を閉じているとは数えない（まぶたが閉じて見えるので）
  bodyVisible: 0.5, // 姿勢の頭か肩の点の visibility がこれより大きければ「人が映っている」
};

const BASE = `${import.meta.env.BASE_URL}mediapipe`;
let loading: Promise<{ face: FaceLandmarker; pose: PoseLandmarker }> | null = null;

/** Face Landmarker と Pose Landmarker を読み込む（1回だけ。顔カメラを使うときに読む。GPU が使えなければ CPU で動かす） */
export function loadLandmarkers() {
  loading ??= (async () => {
    const { FaceLandmarker, PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    const gpuOrCpu = async <T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>) => { try { return await make('GPU'); } catch { return await make('CPU'); } };
    const [face, pose] = await Promise.all([
      gpuOrCpu((delegate) => FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/face_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })),
      gpuOrCpu((delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_lite.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      })),
    ]);
    return { face, pose };
  })();
  loading.catch(() => { loading = null; }); // 失敗したら次はもう一度ためす
  return loading;
}

const NO_FACE: FaceFrame = { view: 'none', present: false, eyeOpen: 0, browDown: 0, yaw: 0, pitch: 0, gazeH: 0, closed: false, down: false, landmarks: null, pose: null };
const HEAD_AND_SHOULDERS = 13; // 姿勢の点の 0〜10 が頭（鼻・目・耳・口）、11・12 が肩
const NO_BODY = { view: 'none' as const, pose: null };

/** 姿勢の結果から、人が映っているかを見る（頭か肩の点が1つでも見えていれば映っている） */
export function analyzePose(r: PoseLandmarkerResult): { view: 'body' | 'none'; pose: NormalizedLandmark[] | null } {
  const pose = r.landmarks[0]?.slice(0, HEAD_AND_SHOULDERS);
  if (!pose?.some((p) => p.visibility > FACE_RULES.bodyVisible)) return NO_BODY;
  return { view: 'body', pose };
}
const DEG = 180 / Math.PI;

/** Face Landmarker の結果を、判定に使う数値にする */
export function analyze(r: FaceLandmarkerResult): FaceFrame {
  const landmarks = r.faceLandmarks[0];
  if (!landmarks) return NO_FACE;
  const b: Record<string, number> = {};
  for (const c of r.faceBlendshapes[0]?.categories ?? []) b[c.categoryName] = c.score;
  const eyeOpen = 1 - ((b.eyeBlinkLeft ?? 0) + (b.eyeBlinkRight ?? 0)) / 2;
  const browDown = ((b.browDownLeft ?? 0) + (b.browDownRight ?? 0)) / 2;
  // 左を見る：左目は外、右目は内。右を見る：左目は内、右目は外
  const gazeH = ((b.eyeLookOutLeft ?? 0) + (b.eyeLookInRight ?? 0) - (b.eyeLookInLeft ?? 0) - (b.eyeLookOutRight ?? 0)) / 2;
  // 顔の正面の向き＝回転行列の3列目（行列は列ごとに並んでいる）
  const m = r.facialTransformationMatrixes[0]?.data;
  const [fx, fy, fz] = m ? [m[8], m[9], m[10]] : [0, 0, 1];
  const yaw = Math.atan2(fx, fz) * DEG;
  const pitch = Math.atan2(fy, Math.hypot(fx, fz)) * DEG;
  const R = FACE_RULES;
  return {
    view: 'face', present: true, pose: null, eyeOpen, browDown, yaw, pitch, gazeH,
    closed: eyeOpen < R.closedEye && pitch > R.downPitch,
    down: pitch < R.downPitch,
    landmarks,
  };
}

const FACE_SEC = 0.1; // 顔は 0.1 秒ごと（10 コマ／秒）に解析する
const POSE_SEC = 0.5; // 姿勢は、顔が見えないときだけ 0.5 秒ごとに解析する（あいだのコマは前の結果を使う）

/** video の映像を解析しつづける。enabled が false か video が null のあいだは止まる。error：読み込めなかったとき */
export function useFaceTracker(video: HTMLVideoElement | null, enabled: boolean) {
  const [frame, setFrame] = useState<FaceFrame | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setFrame(null);
    if (!video || !enabled) return;
    let alive = true;
    let timer = 0;
    let last = -1; // 最後に解析した映像の時刻（同じコマは解析しない）
    let poseAt = -Infinity; // 最後に姿勢を解析した時刻
    let body: ReturnType<typeof analyzePose> = NO_BODY; // 最後の姿勢の結果
    loadLandmarkers().then((lm) => {
      if (!alive) return;
      setError('');
      const tick = () => {
        if (!alive) return;
        if (video.readyState >= 2 && video.currentTime !== last) {
          last = video.currentTime;
          try {
            const now = performance.now();
            const f = analyze(lm.face.detectForVideo(video, now));
            if (f.present) poseAt = -Infinity; // 顔が見えなくなったら、すぐに姿勢を見る
            else if (now - poseAt >= POSE_SEC * 1000) { poseAt = now; body = analyzePose(lm.pose.detectForVideo(video, now)); }
            setFrame(f.present ? f : { ...f, ...body, down: body.view === 'body' });
          } catch { /* 映像の切りかわり中など。次のコマでまたためす */ }
        }
        timer = window.setTimeout(tick, FACE_SEC * 1000);
      };
      tick();
    }).catch((e) => alive && setError(`顔の解析を準備できませんでした（${(e as Error).message}）`));
    return () => { alive = false; clearTimeout(timer); };
  }, [video, enabled]);

  return { frame, error };
}

export type FaceNudgeKind = 'sleepy' | 'down';
/** 顔の様子の声かけの合図。sec：その様子が何秒続いたか */
export type FaceNudge = { kind: FaceNudgeKind; sec: number };

/**
 * 顔の様子から声かけの合図を出す（何を言うかは会話・チャットの AI が考える）
 * 眠そう：目を閉じているのが続いたら
 * 下を向いている：downNudge のあいだ、下を向いているのが続いたら（downNudge をいつ true にするかは学習画面が決める。手元ノートがオンならノートに変化がないとき、オフならいつも）
 * 何秒続いたら出すか・クールタイム（合図を出してから、次に出せるまでの秒数）は rules（管理者設定）。読めるまでは null で、合図を出さない
 * quiet のあいだ（家トモが話している・考えているなど）は数えなおす。眠そうは顔が見えないあいだも、下を向いているは downNudge が false のあいだも数えなおす
 */
export function useFaceNudge(frame: FaceFrame | null, quiet: boolean, downNudge: boolean, rules: NudgeRules['face'] | null, nudge: (n: FaceNudge) => void) {
  const since = useRef({ closed: 0, down: 0 }); // その様子が始まった時刻（0 は続いていない）
  const lastAt = useRef<Record<FaceNudgeKind, number>>({ sleepy: -Infinity, down: -Infinity });
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  useEffect(() => {
    const s = since.current;
    if (!frame || quiet || !rules) { s.closed = s.down = 0; return; }
    const now = performance.now(), R = rules;
    s.closed = frame.closed ? s.closed || now : 0;
    s.down = downNudge && frame.down ? s.down || now : 0;
    const sec = (t: number) => (t ? (now - t) / 1000 : 0);
    const fire = (kind: FaceNudgeKind, cooldown: number, n: FaceNudge) => {
      if (now - lastAt.current[kind] < cooldown * 1000) return;
      lastAt.current[kind] = now;
      nudgeRef.current(n);
    };
    if (sec(s.closed) >= R.sleepySec) { fire('sleepy', R.sleepyCooldownSec, { kind: 'sleepy', sec: Math.round(sec(s.closed)) }); s.closed = 0; }
    if (sec(s.down) >= R.downSec) { fire('down', R.downCooldownSec, { kind: 'down', sec: Math.round(sec(s.down)) }); s.down = 0; }
  }, [frame, quiet, downNudge, rules]);
}
