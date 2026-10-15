import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { login, onUser } from '../auth';

// ログインの入り口：ログインしていなければ、メールアドレスとパスワードを入れてもらう（auth.ts）。ログインしたら中身を出す
// 新規登録の画面はない（アカウントは Firebase コンソールで作る）

export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => onUser((u) => setState(u ? 'in' : 'out')), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email.trim(), password);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setError(
        ['auth/invalid-credential', 'auth/invalid-email', 'auth/user-not-found', 'auth/wrong-password'].includes(code) ? 'メールアドレスかパスワードがちがいます'
        : code === 'auth/too-many-requests' ? '失敗が続いたので、しばらく待ってからためしてください'
        : `ログインできませんでした：${(err as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (state === 'in') return <>{children}</>;
  if (state === 'checking') return <main className="access"><div className="card empty">読み込み中…</div></main>;
  return (
    <main className="access">
      <form className="card access-card" onSubmit={submit}>
        <h1 className="access-title">ログイン</h1>
        <div className="field">
          <label htmlFor="login-email">メールアドレス</label>
          <input id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="login-password">パスワード</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>ログイン</button>
        {error && <p className="make-error" role="alert">{error}</p>}
      </form>
    </main>
  );
}
