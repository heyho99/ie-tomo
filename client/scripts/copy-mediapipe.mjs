// 顔の解析（MediaPipe Face Landmarker・Pose Landmarker）に使うファイルを public/mediapipe に用意する（dev・build の前に自動で動く）
// ・WASM：node_modules の @mediapipe/tasks-vision から public/mediapipe/wasm にコピーする
// ・モデル（*.task）：Google の配布元から1回だけダウンロードする（リポジトリには入れない）
// ブラウザは WASM とモデルをこのサーバーから読むので、外部の CDN にはつながない
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const from = join(dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mediapipe');
const to = join(dir, 'wasm');
mkdirSync(to, { recursive: true });
// forVisionTasks が使うのは SIMD 版と非 SIMD 版だけ（module 版は使わない）
for (const name of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  const src = join(from, name), dst = join(to, name);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
}

const MODELS = {
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};
for (const [name, url] of Object.entries(MODELS)) {
  const dst = join(dir, name);
  if (existsSync(dst)) continue;
  console.log(`MediaPipe のモデルをダウンロードします：${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} をダウンロードできませんでした（${res.status}）：${url}`);
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
}
