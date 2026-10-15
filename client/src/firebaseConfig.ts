// Firebase の Web アプリの設定値。client/.env（client/.env.example を写して作る）から読む
// ブラウザに配られる公開の値で、秘密ではない（守りは、新規登録 OFF・サーバーでのトークン確認・Firestore ルールで行う）
// 値は firebase apps:sdkconfig WEB --project <プロジェクト ID> で出る。開発と本番で同じ値を使う
const { VITE_FIREBASE_API_KEY: apiKey, VITE_FIREBASE_PROJECT_ID: projectId, VITE_FIREBASE_APP_ID: appId } = import.meta.env;
if (!apiKey || !projectId || !appId) throw new Error('Firebase の設定がありません：client/.env.example を client/.env に写して値を書いてください');

export const firebaseConfig = { apiKey, authDomain: `${projectId}.firebaseapp.com`, projectId, appId };
