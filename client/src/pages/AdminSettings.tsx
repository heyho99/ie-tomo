import { useEffect, useState } from 'react';
import { aiApi, type AdminTool, type AiConfig, type AiLevel, type AiPurpose, type AiSettings as Settings, type NudgeRules } from '../api';
import { Header } from '../components/Header';
import { saveNudgeRules, useNudgeRules } from '../nudgeRules';

// 管理者設定：管理者だけが変えられる、全員に効く設定をまとめる（サーバーも requireAdmin で断る）
// AI の設定：チャットモードの会話・会話モードの会話・ノートの読み取りのそれぞれで、モデルと考える深さなどを選ぶ。会話モードの会話は Gemini Live のモデル、それ以外はふつうのモデルから選ぶ
// ツール：家トモ（会話モード・チャットモード）が使えるツールのオン・オフと、AI に渡す説明（いつ呼ぶかを AI はこれで決める）
// 声かけの基準：ノートを読み取る間隔、ノートの合図は直前何回の判定で出すか、顔カメラの合図は何秒続いたら出すかとクールタイム
// 変えるとすぐサーバーに保存され、次の呼び出し（声かけの基準は、次に授業を開いたとき）から使われる

const LEVELS: { key: AiLevel; label: string }[] = [
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' },
];

/** 用途ごとの説明（どんな設定がよいかの目安） */
const HINTS: Record<AiPurpose, string> = {
  chat: 'チャットモードで家トモが返事をします。生徒と話しながら使うので、返事の速さが大事です。考える深さは「低」がおすすめ。',
  live: '会話モードで家トモと声で話します。Gemini Live のモデルだけ選べます（考える深さは選べません）。',
  note: 'くり返し読み取るので、速さと安さが大事です。手書きの細かい字を読むには解像度「高」がおすすめ。',
};

export function AdminSettings() {
  const [data, setData] = useState<Settings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    aiApi.settings().then(setData).catch(() => setError('設定を読み込めませんでした。サーバーが起動しているか確認してください。'));
  }, []);

  const missing = data ? data.models.filter((m) => !m.ready) : [];

  return (
    <div className="page">
      <Header right={<span className="debug-badge">管理者用</span>} />
      <main className="setup">
        <div>
          <h1 className="h1-setup">管理者設定</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>全員の授業に効く設定です。変えるとすぐ保存されます。</p>
        </div>
        <section className="setup-group" aria-labelledby="admin-ai-title">
          <div className="setup-group-head">
            <h2 className="setup-group-title" id="admin-ai-title">AI の設定</h2>
            <p className="setup-sub">用途ごとに、使うモデルと考える深さなどを選びます。次の呼び出しから使われます。</p>
          </div>
          {error && <div className="setup-error" role="alert">{error}</div>}
          {missing.length > 0 && data && (
            <div className="notice">
              {missing.map((m) => <div key={m.id}><b>{m.label}</b> は使えません：{data.notConfigured[m.provider]}</div>)}
            </div>
          )}
          <div className="setup-grid">
            {data?.purposes.map((p) => (
              <PurposeCard key={p.key} purpose={p.key} label={p.label} media={p.media} initial={p.config} models={data.models.filter((m) => m.kind === p.kind)} />
            ))}
          </div>
        </section>
        <section className="setup-group" aria-labelledby="admin-tools-title">
          <div className="setup-group-head">
            <h2 className="setup-group-title" id="admin-tools-title">家トモのツール</h2>
            <p className="setup-sub">会話モード・チャットモードの家トモが使えるツールです。オフにすると家トモにはツールも説明も渡りません。説明は家トモがいつツールを使うかを決める手がかりです。チャットモードは次の発言から、会話モードは次につなぐとき（授業を開き直す）から変わります。</p>
          </div>
          <ToolsCard />
        </section>
        <section className="setup-group" aria-labelledby="admin-nudge-title">
          <div className="setup-group-head">
            <h2 className="setup-group-title" id="admin-nudge-title">声かけの基準</h2>
            <p className="setup-sub">ノートを読み取る間隔と、家トモに声かけの合図を出す基準です。授業を開き直すと使われます。</p>
          </div>
          <NudgeCard />
        </section>
      </main>
    </div>
  );
}

function PurposeCard({ purpose, label, media, initial, models }: { purpose: AiPurpose; label: string; media: boolean; initial: AiConfig; models: Settings['models'] }) {
  const [config, setConfig] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const model = models.find((m) => m.id === config.model);
  const isGemini = model?.provider === 'gemini';
  const isLive = model?.kind === 'live';

  async function save(patch: Partial<AiConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    setState('saving');
    try {
      setConfig(await aiApi.saveSettings(purpose, next));
      setState('saved');
      setError('');
    } catch (e) {
      setState('error');
      setError((e as Error).message);
    }
  }

  return (
    <section className="card setup-card" aria-label={label}>
      <div className="setup-head">
        <h2 className="h2" style={{ flex: '1 1 auto' }}>{label}</h2>
        {state === 'saving' ? <span className="chip chip-gray">保存中…</span>
          : state === 'saved' ? <span className="chip chip-blue">保存しました</span>
          : model && !model.ready ? <span className="chip chip-red">使えません</span> : null}
      </div>
      <p className="setup-sub">{HINTS[purpose]}</p>

      <label className="dev-select">
        <span>モデル</span>
        <select value={config.model} onChange={(e) => save({ model: e.target.value })}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.ready ? '' : '（未設定）'}</option>)}
        </select>
      </label>

      {!isLive && (
        <div className="ct-opt">
          <span>考える深さ</span>
          <div className="pills">
            {LEVELS.map((l) => (
              <button key={l.key} type="button" className="pill" aria-pressed={config.thinking === l.key} onClick={() => save({ thinking: l.key })}>{l.label}</button>
            ))}
          </div>
        </div>
      )}

      {media && (
        <div className="ct-opt">
          <span>画像の解像度</span>
          <div className="pills">
            {LEVELS.map((l) => (
              <button key={l.key} type="button" className="pill" aria-pressed={config.mediaResolution === l.key} disabled={!isGemini} onClick={() => save({ mediaResolution: l.key })}>{l.label}</button>
            ))}
          </div>
        </div>
      )}

      <p className="setup-note">
        {isLive ? '変えると、次に Gemini Live につなぐときから使われます（授業を開き直す）。'
          : isGemini
          ? `考える深さは Gemini の thinkingLevel${media ? '、画像の解像度は mediaResolution' : ''} です。`
          : `考える深さは Claude の effort です。${media ? 'Claude には画像の解像度の設定はありません。' : ''}`}
      </p>
      {state === 'error' && <div className="setup-error" role="alert">{error}</div>}
    </section>
  );
}

/** 家トモのツールのオン・オフと説明。オン・オフは切りかえるとすぐ保存する */
function ToolsCard() {
  const [tools, setTools] = useState<AdminTool[] | null>(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { aiApi.tools().then(setTools).catch((e) => setError((e as Error).message)); }, []);

  async function toggle(t: AdminTool, enabled: boolean) {
    setSaving(t.name);
    setError('');
    try {
      const saved = await aiApi.saveTools({ [t.name]: enabled });
      setTools((ts) => ts && ts.map((x) => ({ ...x, enabled: saved[x.name] ?? x.enabled })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving('');
    }
  }

  return (
    <section className="card setup-card" aria-label="家トモのツール">
      {!tools && !error && <p className="muted">読み込み中…</p>}
      {tools?.map((t) => (
        <div key={t.name} className="nudge-row">
          <label className="toggle nudge-label">
            <input type="checkbox" checked={t.enabled} disabled={saving === t.name} onChange={(e) => toggle(t, e.target.checked)} />
            {t.label}
            <span className={`chip ${t.enabled ? 'chip-blue' : 'chip-gray'}`}>{saving === t.name ? '保存中…' : t.enabled ? 'オン' : 'オフ'}</span>
          </label>
          <ToolDescription tool={t} onSaved={(description) => setTools((ts) => ts && ts.map((x) => (x.name === t.name ? { ...x, description } : x)))} />
        </div>
      ))}
      {error && <div className="setup-error" role="alert">{error}</div>}
    </section>
  );
}

/** AI に渡すツールの説明を書きかえる。「保存」で全員に効く。「最初の説明に戻す」でコードに書いた説明に戻る */
function ToolDescription({ tool, onSaved }: { tool: AdminTool; onSaved: (description: string) => void }) {
  const [draft, setDraft] = useState(tool.description);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const dirty = draft.trim() !== tool.description;
  const isDefault = tool.description === tool.defaultDescription;

  async function save(text: string) {
    setState('saving');
    try {
      const { description } = await aiApi.saveToolDescription(tool.name, text);
      onSaved(description);
      setDraft(description);
      setState('saved');
      setError('');
    } catch (e) {
      setState('error');
      setError((e as Error).message);
    }
  }

  return (
    <div className="tool-desc">
      <label className="tool-desc-label" htmlFor={`tool-desc-${tool.name}`}>
        <code>{tool.name}</code> の説明（AI に渡す）
      </label>
      <textarea id={`tool-desc-${tool.name}`} className="tool-desc-input" rows={4} maxLength={2000} value={draft}
        onChange={(e) => { setDraft(e.target.value); setState('idle'); }} />
      <div className="row-wrap">
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || state === 'saving'} onClick={() => save(draft)}>{state === 'saving' ? '保存中…' : '説明を保存'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!dirty} onClick={() => { setDraft(tool.description); setState('idle'); }}>元に戻す</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={isDefault || state === 'saving'} onClick={() => save('')}>最初の説明に戻す</button>
        {state === 'saved' && !dirty && <span className="chip chip-blue">保存しました</span>}
      </div>
      {state === 'error' && <div className="setup-error" role="alert">{error}</div>}
    </div>
  );
}

type NoteKey = keyof NudgeRules['note'];
type FaceKey = keyof NudgeRules['face'];

/** ノートの合図：直前何回の判定が同じ状態なら出すか */
const NOTE_ITEMS: { key: NoteKey; label: string }[] = [
  { key: 'unreadable', label: 'ノートが読み取れない' },
  { key: 'stuck', label: '手が止まっている' },
];
/** 顔カメラの合図：何秒続いたら出すか・クールタイム（秒）。when：何が続いたら合図を出すか（場合ごと） */
const FACE_ITEMS: { label: string; sec: FaceKey; cooldown: FaceKey; when: { tag?: string; text: string }[] }[] = [
  { label: '眠そう', sec: 'sleepySec', cooldown: 'sleepyCooldownSec', when: [{ text: '目を閉じている' }] },
  {
    label: '下を向いている', sec: 'downSec', cooldown: 'downCooldownSec',
    when: [
      { tag: '手元ノート オン', text: 'ノートに変化がないまま、下を向いている' },
      { tag: '手元ノート オフ', text: '下を向いている（使わない・カメラを切っているときは、手元が見えないため）' },
    ],
  },
];

/** 声かけの合図を出す基準。数を変えて「保存」で全員に効く */
function NudgeCard() {
  const saved = useNudgeRules();
  const [rules, setRules] = useState<NudgeRules | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  useEffect(() => { if (saved && !rules) setRules(saved); }, [saved, rules]);

  if (!rules) return <div className="card setup-card"><p className="muted">読み込み中…</p></div>;
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const interval = rules.noteIntervalSec;
  const setNote = (k: NoteKey, v: number) => { setRules({ ...rules, note: { ...rules.note, [k]: v } }); setState('idle'); };
  const setFace = (k: FaceKey, v: number) => { setRules({ ...rules, face: { ...rules.face, [k]: v } }); setState('idle'); };
  const setInterest = <K extends keyof NudgeRules['interest']>(k: K, v: Partial<NudgeRules['interest'][K]>) => {
    setRules({ ...rules, interest: { ...rules.interest, [k]: { ...rules.interest[k], ...v } } });
    setState('idle');
  };
  const { quiet, milestone, recovered } = rules.interest;

  async function save() {
    setState('saving');
    try {
      setRules(await saveNudgeRules(rules!));
      setState('saved');
      setError('');
    } catch (e) {
      setState('error');
      setError((e as Error).message);
    }
  }

  return (
    <div className="setup-grid">
      <section className="card setup-card" aria-label="ノートの読み取りと合図">
        <div className="setup-head"><h3 className="h2" style={{ flex: '1 1 auto' }}>ノートの読み取りと合図</h3></div>
        <p className="setup-sub">授業で手元のノートを読み取る間隔と、直前何回の判定が同じ状態なら声をかけるか。声をかけたら数えなおします。</p>
        <label className="ct-interval">
          <span>読み取る間隔</span>
          <input type="range" min={1} max={180} step={1} value={interval} onChange={(e) => { setRules({ ...rules, noteIntervalSec: Number(e.target.value) }); setState('idle'); }} />
          <b className="num">{duration(interval)}</b>
        </label>
        {NOTE_ITEMS.map((i) => (
          <div key={i.key} className="row-wrap">
            <NumberField label={i.label} unit="回" value={rules.note[i.key]} onChange={(v) => setNote(i.key, v)} />
            <span className="muted num" style={{ fontSize: 13 }}>約 {duration(interval * rules.note[i.key])}</span>
          </div>
        ))}
      </section>
      <section className="card setup-card" aria-label="顔カメラの合図">
        <div className="setup-head"><h3 className="h2" style={{ flex: '1 1 auto' }}>顔カメラの合図</h3></div>
        <p className="setup-sub">何秒続いたら声をかけるかと、声をかけてから次に声をかけられるまでの秒数（クールタイム）。</p>
        {FACE_ITEMS.map((i) => (
          <div key={i.sec} className="nudge-row">
            <span className="nudge-label">{i.label}</span>
            <ul className="nudge-when">
              {i.when.map((w) => (
                <li key={w.text}>{w.tag && <span className="chip chip-gray">{w.tag}</span>}<span>{w.text}</span></li>
              ))}
            </ul>
            <NumberField label="が続いたら" unit="秒" value={rules.face[i.sec]} onChange={(v) => setFace(i.sec, v)} />
            <NumberField label="クールタイム" unit="秒" value={rules.face[i.cooldown]} onChange={(v) => setFace(i.cooldown, v)} />
          </div>
        ))}
      </section>
      <section className="card setup-card" aria-label="興味の合図">
        <div className="setup-head"><h3 className="h2" style={{ flex: '1 1 auto' }}>興味の合図</h3></div>
        <p className="setup-sub">順調に勉強しているあいだも、勉強している内容に興味をもって声をかけます。</p>
        <div className="nudge-row">
          <label className="dev-select nudge-label">
            <input type="checkbox" checked={quiet.on} onChange={(e) => setInterest('quiet', { on: e.target.checked })} />
            <span>しばらく話していない</span>
          </label>
          <p className="setup-sub">話していない時間がこのあいだのランダムな秒数をこえたら、内容に興味をもって声をかけます。返事があれば短く、なければ長くしていきます。</p>
          <NumberField label="最短" unit="秒" value={quiet.minSec} disabled={!quiet.on} onChange={(v) => setInterest('quiet', { minSec: v })} />
          <NumberField label="最長" unit="秒" value={quiet.maxSec} disabled={!quiet.on} onChange={(v) => setInterest('quiet', { maxSec: v })} />
        </div>
        <div className="nudge-row">
          <label className="dev-select nudge-label">
            <input type="checkbox" checked={milestone.on} onChange={(e) => setInterest('milestone', { on: e.target.checked })} />
            <span>経過時間の節目</span>
          </label>
          <p className="setup-sub">勉強を始めてから決まった間隔ごとに、集中していることに感心して声をかけます。</p>
          <NumberField label="" unit="分ごと" value={milestone.everyMin} disabled={!milestone.on} onChange={(v) => setInterest('milestone', { everyMin: v })} />
        </div>
        <div className="nudge-row">
          <label className="dev-select nudge-label">
            <input type="checkbox" checked={recovered.on} onChange={(e) => setInterest('recovered', { on: e.target.checked })} />
            <span>状態がよくなった</span>
          </label>
          <p className="setup-sub">手が止まっていた・下を向いていた・目を閉じていた（眠そう）あとで、また取り組みはじめたら、声をかけます。</p>
          <NumberField label="クールタイム" unit="秒" value={recovered.cooldownSec} disabled={!recovered.on} onChange={(v) => setInterest('recovered', { cooldownSec: v })} />
        </div>
      </section>
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" disabled={!dirty || state === 'saving'} onClick={save}>{state === 'saving' ? '保存中…' : '声かけの基準を保存'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!dirty} onClick={() => { setRules(saved); setState('idle'); }}>元に戻す</button>
        {state === 'saved' && !dirty && <span className="chip chip-blue">保存しました</span>}
        {state === 'error' && <div className="setup-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

/** 秒数を「45 秒」「2 分 30 秒」のように */
function duration(sec: number) {
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分${sec % 60 ? ` ${sec % 60} 秒` : ''}`;
}

function NumberField({ label, unit, value, disabled, onChange }: { label: string; unit: string; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className="dev-select">
      {label && <span>{label}</span>}
      <input type="number" className="ct-count num" min={1} step={1} value={value} disabled={disabled}
        onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
      <span>{unit}</span>
    </label>
  );
}
