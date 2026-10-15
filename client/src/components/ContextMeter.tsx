import type { ContextUsage } from '../api';

// 学習画面の「会話の量」：いまの会話がコンテキストウィンドウのどのくらいかと、古い会話を要約した回数
// 線は要約を始める量（summaryAt）と、Gemini Live が古い会話を捨てはじめる量（compressAt。会話モードだけ）

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const pct = (n: number, limit: number) => `${Math.min(100, (n / limit) * 100)}%`;

/** usage：まだ届いていなければ null。summaries：この画面を開いてから要約した回数 */
export function ContextMeter({ usage, summaries }: { usage: ContextUsage | null; summaries: number }) {
  if (!usage) return <div className="ctx-meter"><div className="ctx-meter-text">会話の量：まだわかりません（家トモが話すとわかります）</div></div>;
  const { tokens, summaryAt, compressAt, limit } = usage;
  const level = compressAt && tokens >= compressAt ? ' over' : tokens >= summaryAt ? ' warn' : '';
  return (
    <div className="ctx-meter" title={`要約：${k(summaryAt)} トークンをこえたら古い会話を要約する${compressAt ? `\n圧縮：${k(compressAt)} トークンをこえたら Gemini Live が古い会話を捨てる` : ''}`}>
      <div className="ctx-meter-text">
        <span>会話の量 {k(tokens)} / {k(limit)} トークン（{Math.round((tokens / limit) * 100)}%）</span>
        <span>要約 {summaries} 回</span>
      </div>
      <div className={`ctx-meter-bar${level}`} role="meter" aria-label="会話の量" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={tokens}>
        <i style={{ width: pct(tokens, limit) }} />
        <b style={{ left: pct(summaryAt, limit) }} />
        {compressAt && <b className="compress" style={{ left: pct(compressAt, limit) }} />}
      </div>
    </div>
  );
}
