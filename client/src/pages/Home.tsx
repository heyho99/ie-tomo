import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type StudySession } from '../api';
import { Header } from '../components/Header';
import { SproutIcon } from '../components/Icons';
import { isAdmin } from '../auth';

// はじめる：新しく勉強をはじめるか、過去の学習の回の続きをする

const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
const timeLabel = (iso: string) => {
  const d = new Date(iso);
  return `${dateLabel(iso)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function Home() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<StudySession[] | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const cancelRename = useRef(false);

  useEffect(() => {
    api.sessions().then(setSessions).catch(() => setError('学習の記録を読み込めませんでした。サーバーが起動しているか確認してください。'));
  }, []);

  async function start() {
    setStarting(true);
    try {
      const s = await api.createSession(`${dateLabel(new Date().toISOString())}の勉強`);
      navigate(`/study/${s.id}`);
    } catch (e) {
      setError(`はじめられませんでした：${(e as Error).message}`);
      setStarting(false);
    }
  }

  // 名前を変える。空のまま・変更なしなら何もしない
  async function rename() {
    if (!editing || cancelRename.current) return;
    const { id, title } = editing;
    setEditing(null);
    const current = sessions?.find((x) => x.id === id);
    if (!title.trim() || title.trim() === current?.title) return;
    try {
      const s = await api.renameSession(id, title.trim());
      setSessions((list) => list && list.map((x) => (x.id === id ? s : x)));
    } catch (e) {
      setError(`名前を変えられませんでした：${(e as Error).message}`);
    }
  }

  async function remove(s: StudySession) {
    if (!confirm(`「${s.title}」を消しますか？`)) return;
    try {
      await api.removeSession(s.id);
      setSessions((list) => list && list.filter((x) => x.id !== s.id));
    } catch (e) {
      setError(`消せませんでした：${(e as Error).message}`);
    }
  }

  return (
    <div className="page">
      <Header />
      <main className="start">
        <section className="lessons" aria-label="これまでの勉強">
          <div className="home-head">
            <h1 className="home-title">これまでの勉強</h1>
            <button type="button" className="btn btn-primary btn-start" onClick={start} disabled={starting}>
              <SproutIcon size={20} />{starting ? '準備しています…' : '新しくはじめる'}
            </button>
          </div>
          {error && <div className="card empty" role="alert">{error}</div>}
          {!error && !sessions && <div className="card empty">読み込み中…</div>}
          {sessions && !sessions.length && <div className="card empty">まだ記録はありません。「新しくはじめる」から勉強をはじめましょう。</div>}
          {sessions?.map((s) => (
            <div key={s.id} className="card lesson">
              <div className="lesson-body">
                {editing?.id === s.id ? (
                  <input
                    className="lesson-title-input"
                    aria-label="勉強の名前"
                    value={editing.title}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditing({ id: s.id, title: e.target.value })}
                    onBlur={rename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
                      if (e.key === 'Escape') { cancelRename.current = true; setEditing(null); }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="lesson-title lesson-title-edit"
                    title="クリックして名前を変える"
                    onClick={() => { cancelRename.current = false; setEditing({ id: s.id, title: s.title }); }}
                  >
                    {s.title}
                  </button>
                )}
                <div className="lesson-prog">
                  <span>作成 {timeLabel(s.createdAt)}</span>
                  <span>最終学習 {timeLabel(s.updatedAt)}</span>
                </div>
              </div>
              <div className="lesson-actions">
                <Link className="btn" to={`/study/${s.id}`}>続きから</Link>
                {/* 開発者用（管理者だけ）：同じ学習画面を、AI とのやりとりを見ながら進める */}
                {isAdmin() && <Link className="btn btn-ghost btn-sm" to={`/study/${s.id}/debug`} title="AI に送ったデータ・返ってきたデータを見ながら勉強する">デバッグ</Link>}
                <button type="button" className="btn btn-ghost btn-sm btn-remove" onClick={() => remove(s)}>消す</button>
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
