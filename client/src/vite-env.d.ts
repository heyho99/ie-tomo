/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** サーバー（Cloud Run）の Origin。WebSocket・長くかかる API・SSE を直接つなぐ（本番だけ。serverUrl.ts） */
  readonly VITE_API_ORIGIN?: string;
  /** ログイン（Firebase）の設定値。client/.env から読む（firebaseConfig.ts） */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}
