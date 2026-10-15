import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { authQuery } from '../auth';
import { debugLog, useDebugLog, type ApiEntry, type DebugEntry, type LlmEntry } from '../debug';
import { apiUrl } from '../serverUrl';

// 開発者用：デバッグ授業の右に出す記録。AI（LLM）に送ったデータ・返ってきたデータ、API の呼び出し、授業の画面で起きたことを時刻順に並べる
// 「LLM ごと」では、AI の呼び出しを用途（ノートの読み取り・会話など）ごとの列に分けて並べる

type Filter = 'columns' | 'all' | DebugEntry['kind'];
const FILTERS: [Filter, string][] = [['columns', 'LLM ごと'], ['all', 'すべて'], ['llm', 'LLM'], ['api', 'API'], ['event', 'イベント']];
const KIND_LABEL: Record<DebugEntry['kind'], string> = { llm: 'LLM', api: 'API', event: 'イベント' };
const PURPOSE_LABEL: Record<string, string> = { note: 'ノートの読み取り', chat: 'チャットモードの会話' };
const PURPOSE_ORDER = ['note', 'chat'];

const time = (at: number) => {
  const d = new Date(at);
  return `${d.toLocaleTimeString('ja-JP', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/** 構造化出力（JSON の文字列）なら中身を、そうでなければそのまま */
const parseMaybe = (t: string) => {
  try { return JSON.parse(t) as unknown; } catch { return t; }
};

/**
 * 読みやすい形に整える。JSON とほぼ同じだが、改行をふくむ文字列（プロンプトなど）は \n にせず、そのまま改行して見せる
 * コピーするときは正しい JSON にする（copy ボタン）
 */
function pretty(v: unknown, ind = ''): string {
  const next = `${ind}  `;
  if (typeof v === 'string') {
    return v.includes('\n') ? `"""\n${next}${v.replace(/\n/g, `\n${next}`)}\n${ind}"""` : JSON.stringify(v);
  }
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => next + pretty(x, next)).join(',\n')}\n${ind}]` : '[]';
  if (v && typeof v === 'object') {
    const es = Object.entries(v).filter(([, x]) => x !== undefined);
    return es.length ? `{\n${es.map(([k, x]) => `${next}${JSON.stringify(k)}: ${pretty(x, next)}`).join(',\n')}\n${ind}}` : '{}';
  }
  return String(v);
}

function Code({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(typeof value === 'string' ? value : JSON.stringify(value, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  return (
    <div className="dbg-code">
      <button type="button" className="btn btn-ghost btn-sm dbg-copy" onClick={copy}>{copied ? 'コピーした' : 'コピー'}</button>
      <pre>{typeof value === 'string' ? value : pretty(value)}</pre>
    </div>
  );
}

function Images({ images }: { images: string[] }) {
  const [big, setBig] = useState<number | null>(null);
  if (!images.length) return null;
  return (
    <div className="dbg-images">
      {images.map((src, i) => (
        <button key={i} type="button" className={big === i ? 'big' : ''} title="クリックで拡大／縮小" onClick={() => setBig(big === i ? null : i)}>
          <img src={src} alt={`送った画像 #${i + 1}`} />
          <span>#{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

/** 中身をタブで切りかえて見る */
function Tabs({ tabs }: { tabs: [string, React.ReactNode][] }) {
  const [cur, setCur] = useState(0);
  const shown = tabs[Math.min(cur, tabs.length - 1)];
  return (
    <div className="dbg-tabs">
      <div className="pills">
        {tabs.map(([label], i) => (
          <button key={label} type="button" className="pill" aria-pressed={i === cur} onClick={() => setCur(i)}>{label}</button>
        ))}
      </div>
      {shown[1]}
    </div>
  );
}

function tokens(u: unknown) {
  const t = u as { prompt?: number; output?: number; thoughts?: number } | undefined;
  return t ? `入力 ${t.prompt ?? 0} / 出力 ${t.output ?? 0}${t.thoughts ? ` / 思考 ${t.thoughts}` : ''} tok` : '';
}

function LlmBody({ e }: { e: LlmEntry }) {
  const tabs: [string, React.ReactNode][] = [
    ['送信データ', <Code key="req" value={e.request} />],
  ];
  if (e.images.length) tabs.push([`画像（${e.images.length}）`, <Images key="img" images={e.images} />]);
  if (e.end?.text !== undefined) tabs.push(['出力', <Code key="out" value={parseMaybe(e.end.text)} />]);
  if (e.end?.response !== undefined) tabs.push(['レスポンス（生）', <Code key="res" value={e.end.response} />]);
  tabs.push(['設定', <Code key="cfg" value={{ purpose: e.purpose, provider: e.provider, model: e.model, endpoint: e.endpoint, config: e.config, usage: e.end?.usage }} />]);
  return (
    <>
      {e.end?.error && <p className="dbg-err" role="alert">{e.end.error}</p>}
      <Tabs tabs={tabs} />
    </>
  );
}

function ApiBody({ e }: { e: ApiEntry }) {
  const tabs: [string, React.ReactNode][] = [['送信データ', <Code key="req" value={e.body} />]];
  if (e.images.length) tabs.push([`画像（${e.images.length}）`, <Images key="img" images={e.images} />]);
  if (e.end) tabs.push(['レスポンス', <Code key="res" value={e.end.response} />]);
  return (
    <>
      {e.end?.error && <p className="dbg-err" role="alert">{e.end.error}</p>}
      <Tabs tabs={tabs} />
    </>
  );
}

/** 出力（構造化出力なら各項目）を1行に縮める */
function outputLine(text: string) {
  const v = parseMaybe(text);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('　');
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** 1行の要約（開くと中身）。inColumn は「LLM ごと」の列の中（用途は列の見出しにあるので出さず、出力を出す） */
function Summary({ e, inColumn }: { e: DebugEntry; inColumn?: boolean }) {
  if (e.kind === 'event') {
    const text = typeof e.detail === 'string' ? e.detail : e.detail === undefined ? '' : JSON.stringify(e.detail);
    return <><b>{e.label}</b>{text && <span className="dbg-sum">{text}</span>}</>;
  }
  const status = !e.end ? <span className="dbg-busy">送信中…</span>
    : e.end.error ? <span className="dbg-bad">エラー</span>
    : <span className="muted">{e.end.ms}ms</span>;
  if (e.kind === 'llm' && inColumn) {
    return (
      <>
        {status}{e.end?.usage !== undefined && <span className="muted">{tokens(e.end.usage)}</span>}
        {e.end?.text && <span className="dbg-out">{outputLine(e.end.text)}</span>}
      </>
    );
  }
  if (e.kind === 'llm') {
    return <><b>{e.purpose}</b><span className="dbg-sum">{e.model}</span>{status}{e.end?.usage !== undefined && <span className="muted">{tokens(e.end.usage)}</span>}</>;
  }
  return <><b>{e.method} {e.url.replace(/^\/api/, '')}</b>{e.end && <span className={e.end.status >= 400 || !e.end.status ? 'dbg-bad' : 'muted'}>{e.end.status || '接続失敗'}</span>}{status}</>;
}

const order = (p: string) => (PURPOSE_ORDER.includes(p) ? PURPOSE_ORDER.indexOf(p) : PURPOSE_ORDER.length);

/** 記録の1件。要約を開くと中身 */
function Item({ e, inColumn }: { e: DebugEntry; inColumn?: boolean }) {
  return (
    <details className={`dbg-item dbg-${e.kind}`}>
      <summary>
        <span className="num dbg-time">{time(e.at)}</span>
        {!inColumn && <span className="dbg-kind">{KIND_LABEL[e.kind]}</span>}
        <Summary e={e} inColumn={inColumn} />
      </summary>
      <div className="dbg-body">
        {e.kind === 'llm' ? <LlmBody e={e} /> : e.kind === 'api' ? <ApiBody e={e} /> : <Code value={e.detail ?? ''} />}
      </div>
    </details>
  );
}

export function DebugPanel({ session, hidden, onClose }: { session: string; hidden?: boolean; onClose: () => void }) {
  const { entries, state } = useDebugLog();
  const [filter, setFilter] = useState<Filter>('columns');
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // サーバーから AI の送受信を受け取る
  useEffect(() => {
    const es = new EventSource(apiUrl(`/api/debug/stream?session=${encodeURIComponent(session)}&${authQuery()}`));
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // 切れても EventSource が自動でつなぎなおす
    es.onmessage = (m) => debugLog.llm(JSON.parse(m.data));
    return () => es.close();
  }, [session]);

  const shown = filter === 'columns' ? [] : entries.filter((e) => filter === 'all' || e.kind === filter);
  const llms = entries.filter((e): e is LlmEntry => e.kind === 'llm');
  const purposes = [...new Set(llms.map((e) => e.purpose))].sort((a, b) => order(a) - order(b));

  // 新しい記録が来たら下までスクロール（「自動スクロール」がオンのとき）
  useLayoutEffect(() => {
    const el = listRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [shown.length, follow]);
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useLayoutEffect(() => {
    if (!follow) return;
    for (const el of Object.values(colRefs.current)) if (el) el.scrollTop = el.scrollHeight;
  }, [llms.length, follow, filter]);

  const save = () => {
    const blob = new Blob([JSON.stringify({ session, state, entries }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `debug-${session}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const llmCount = entries.filter((e) => e.kind === 'llm').length;
  const pending = entries.filter((e) => e.kind !== 'event' && !e.end).length;

  return (
    <aside className="dbg" aria-label="デバッグ" hidden={hidden}>
      <div className="dbg-head">
        <div className="dbg-title">
          <h2 className="h2">デバッグ</h2>
          <span className={`chip ${live ? 'chip-blue' : 'chip-gray'}`} title={`セッション ${session}`}>{live ? 'サーバー接続中' : 'サーバー未接続'}</span>
          <span className="muted num" style={{ fontSize: 12 }}>LLM {llmCount} 回{pending ? `・応答待ち ${pending}` : ''}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} title="デバッグ表示をたたむ">たたむ</button>
        </div>
        <div className="dbg-tools">
          <div className="pills">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className="pill" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <label className="dbg-check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />自動スクロール</label>
          <button type="button" className="btn btn-ghost btn-sm" onClick={save} disabled={!entries.length}>JSON で保存</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={debugLog.clear} disabled={!entries.length}>クリア</button>
        </div>
      </div>

      <details className="dbg-state">
        <summary>学習画面のいまの状態</summary>
        <Code value={state} />
      </details>

      {filter === 'columns' ? (
        <div className="dbg-cols">
          {!purposes.length && <p className="muted dbg-empty">まだ AI の呼び出しはありません。勉強を進めると、用途ごとの列に出ます。</p>}
          {purposes.map((p) => {
            const es = llms.filter((e) => e.purpose === p);
            const done = es.filter((e) => e.end && !e.end.error);
            const avg = done.length ? Math.round(done.reduce((a, e) => a + e.end!.ms, 0) / done.length) : 0;
            return (
              <section key={p} className="dbg-col" aria-label={PURPOSE_LABEL[p] ?? p}>
                <div className="dbg-col-head">
                  <b>{PURPOSE_LABEL[p] ?? p}</b>
                  <span className="muted">{es[es.length - 1].model}</span>
                  <span className="muted num">{es.length} 回{avg ? `・平均 ${avg}ms` : ''}</span>
                </div>
                <div className="dbg-col-list" ref={(el) => { colRefs.current[p] = el; }}>
                  {es.map((e) => <Item key={e.id} e={e} inColumn />)}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="dbg-list" ref={listRef}>
          {!shown.length && <p className="muted dbg-empty">まだ記録はありません。勉強を進めると、ここに AI とのやりとりが出ます。</p>}
          {shown.map((e) => <Item key={e.id} e={e} />)}
        </div>
      )}
    </aside>
  );
}
