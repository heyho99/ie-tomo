import type { DocumentReference } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db.js';

// 家トモが使えるツール（tools/）のオン・オフと、AI に渡す説明（管理者設定で変える。全員に同じ）
// オン・オフ：Firestore の appSettings/tools に { ツール名: true/false }。保存していないツールはオン
// 説明：appSettings/toolDescriptions に { ツール名: 説明 }。保存していないツールは、コードに書いた説明（ToolDef の description）
// 変更を受け取ってメモリの値を更新する（どの台で変えても全台に届く）

const doc = db.collection('appSettings').doc('tools');
const descDoc = db.collection('appSettings').doc('toolDescriptions');
let saved: Record<string, unknown> = {};
let descs: Record<string, unknown> = {};

/** MAX_DESCRIPTION：説明の長さの上限（文字） */
export const MAX_DESCRIPTION = 2000;

/** ref の値を読み込み、以後の変更を受け取りつづける。最初の読み込みが終わったら解決する */
function watch(ref: DocumentReference, what: string, onData: (data: Record<string, unknown>) => void) {
  return new Promise<void>((resolve, reject) => {
    let first = true;
    ref.onSnapshot((snap) => {
      onData(snap.data() ?? {});
      if (first) { first = false; resolve(); }
    }, (e) => {
      console.error(`ツールの${what}を Firestore から読めません：`, e.message);
      if (first) { first = false; reject(e); }
    });
  });
}

/** 保存されたオン・オフと説明を読み込み、以後の変更を受け取りつづける（起動時に待つ） */
export async function watchToolConfig() {
  await Promise.all([watch(doc, 'オン・オフ', (d) => { saved = d; }), watch(descDoc, '説明', (d) => { descs = d; })]);
}

export const toolEnabled = (name: string) => saved[name] !== false;

/** AI に渡す説明。管理者が保存していなければ fallback（コードに書いた説明） */
export const toolDescription = (name: string, fallback: string) => {
  const d = descs[name];
  return typeof d === 'string' && d ? d : fallback;
};

/** names：知っているツールの名前。それ以外の項目と、true/false でない値は捨てる */
export async function setToolsEnabled(raw: unknown, names: string[]): Promise<Record<string, boolean>> {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const next = Object.fromEntries(names.map((n) => [n, typeof v[n] === 'boolean' ? v[n] as boolean : toolEnabled(n)]));
  saved = next; // 自分の台にはすぐ反映する（ほかの台には onSnapshot で届く）
  await doc.set(next);
  return next;
}

/** 説明を保存する。空か fallback と同じなら、保存した説明を消してコードに書いた説明に戻す。保存後の説明を返す */
export async function setToolDescription(name: string, raw: unknown, fallback: string): Promise<string> {
  const text = typeof raw === 'string' ? raw.trim().slice(0, MAX_DESCRIPTION) : '';
  const reset = !text || text === fallback;
  descs = { ...descs, [name]: reset ? undefined : text }; // 自分の台にはすぐ反映する
  await descDoc.set({ [name]: reset ? FieldValue.delete() : text }, { merge: true });
  return toolDescription(name, fallback);
}
