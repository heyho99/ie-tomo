// ログイン（Firebase Authentication のメール／パスワード）。パスワードは Firebase へ直接送られ、自分のサーバーは通らない
// サーバーの API には ID トークンを付ける（server/src/auth.ts）。fetch は Authorization ヘッダー、
// ヘッダーを付けられない EventSource・WebSocket は ?token= で送る
// トークンの期限は1時間。onIdTokenChanged で見ていると、SDK が切れる前に自動で更新して知らせてくれるので、いつも新しいものを持っておく
import { onIdTokenChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';
import { apiUrl } from './serverUrl';

let token = '';
let admin = false;
let adminOf = ''; // admin を調べたユーザーの uid（トークンの更新のたびに調べなおさない）

export const login = (email: string, password: string) => signInWithEmailAndPassword(auth, email, password);
export const logout = () => signOut(auth);
export const currentEmail = () => auth.currentUser?.email ?? '';
/** 管理者か（管理者設定を出すかどうか。守りはサーバー側） */
export const isAdmin = () => admin;

/** ログインの状態が変わったら知らせる。ログインしているなら、トークンと管理者かどうかを持ってから知らせる */
export const onUser = (cb: (user: User | null) => void) =>
  onIdTokenChanged(auth, async (user) => {
    token = user ? await user.getIdToken() : '';
    if (user?.uid !== adminOf) {
      admin = user ? await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : null)).then((m) => !!m?.admin).catch(() => false) : false;
      adminOf = user?.uid ?? '';
    }
    cb(user);
  });

/** fetch 用。期限が切れていれば、その場で更新してから付ける（PC がスリープしていたときなど） */
export const authHeader = async () => ({ Authorization: `Bearer ${(await auth.currentUser?.getIdToken()) ?? ''}` });
/** EventSource・WebSocket 用。その場でつなぐので、持っているトークンを使う */
export const authQuery = () => `token=${encodeURIComponent(token)}`;
