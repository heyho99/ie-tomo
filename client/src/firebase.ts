import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { firebaseConfig } from './firebaseConfig';

// Firebase（ログインだけに使う）。設定値は firebaseConfig.ts（公開してよい値）
export const auth = getAuth(initializeApp(firebaseConfig));
