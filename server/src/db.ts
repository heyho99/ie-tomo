import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Firestore（学習の回・管理者設定・iPad のノートの線）。サーバーが何台あっても同じデータを読み書きできる
// 認証は ADC（ローカルは gcloud auth application-default login、Cloud Run はサービスアカウント）
// FIRESTORE_EMULATOR_HOST があればエミュレータにつなぐ（Admin SDK が自動で見る）
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });
