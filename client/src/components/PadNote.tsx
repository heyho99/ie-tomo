import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { Capture } from '../capture';
import { drawPaper, padRoom, usePadSocket } from '../pad';
import { apiUrl } from '../serverUrl';

// iPad のノート（PC の画面）：iPad で書いた線をそのまま映す。iPad がつながっていないあいだは、iPad で開く QR コードを出す
// pageKey：いまの問題。変わったら iPad のノートを白紙にする（同じなら、読み込み直しても続きを出す）

type Props = {
  pageKey: string;
  /** iPad がつながったら、読み取り用に画像を作る関数を渡す。切れたら null */
  onCapture?: (capture: Capture | null) => void;
  onStatus?: (on: boolean) => void;
};

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

export function PadNote({ pageKey, onCapture, onStatus }: Props) {
  const room = useMemo(padRoom, []);
  const pageRef = useRef(pageKey);
  pageRef.current = pageKey;
  const { connected, paper, strokes, pads, send } = usePadSocket('view', room, (s) => s({ type: 'page', key: pageRef.current }));
  useEffect(() => { send({ type: 'page', key: pageKey }); }, [pageKey, send]);
  const on = connected && pads > 0;

  // iPad から開く URL。PC を localhost で開いているときは、LAN 内の IP アドレスに置きかえる
  const [addresses, setAddresses] = useState<{ name: string; address: string }[] | null>(null);
  const [addrIdx, setAddrIdx] = useState(0);
  const local = LOCAL.includes(location.hostname);
  // Wi-Fi をつなぎかえると IP アドレスが変わるので、QR コードを出しているあいだは調べなおす
  useEffect(() => {
    if (!local || on) return;
    const load = () => fetch(apiUrl('/api/pad/addresses')).then((r) => r.json())
      .then((d: { addresses: { name: string; address: string }[] }) => setAddresses((old) => (JSON.stringify(old) === JSON.stringify(d.addresses) ? old : d.addresses)))
      .catch(() => setAddresses([]));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [local, on]);
  useEffect(() => { if (addresses && addrIdx >= addresses.length) setAddrIdx(0); }, [addresses, addrIdx]);
  const host = local ? (addresses?.[addrIdx] ? `${addresses[addrIdx].address}${location.port ? `:${location.port}` : ''}` : '') : location.host;
  const url = host ? `${location.protocol}//${host}/pad/${room}` : '';
  const [qr, setQr] = useState('');
  useEffect(() => {
    if (!url) { setQr(''); return; }
    QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(''));
  }, [url]);

  // 枠に収まるように用紙を縮めて描く
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const update = () => setView({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  const fit = paper && view.w ? Math.min(view.w / paper.w, view.h / paper.h) : 0;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !paper || !fit) return;
    const k = fit * (window.devicePixelRatio || 1);
    canvas.width = Math.round(paper.w * k);
    canvas.height = Math.round(paper.h * k);
    drawPaper(canvas.getContext('2d')!, paper, strokes, k);
  }, [paper, strokes, fit, on]);

  // 読み取り用の画像：用紙を長い辺が maxSide になるように描いて JPEG にする（縮めないときは2倍で描く）
  const latest = useRef({ paper, strokes });
  latest.current = { paper, strokes };
  const capture = useCallback<Capture>(({ maxSide, quality }) => {
    const { paper: p, strokes: s } = latest.current;
    if (!p) return null;
    const k = Math.min(2, maxSide / Math.max(p.w, p.h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(p.w * k);
    canvas.height = Math.round(p.h * k);
    drawPaper(canvas.getContext('2d')!, p, s, k);
    return { image: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
  }, []);

  useEffect(() => { onStatus?.(on); }, [on, onStatus]);
  useEffect(() => {
    onCapture?.(on && paper ? capture : null);
  }, [on, !!paper, capture, onCapture]);
  useEffect(() => () => onCapture?.(null), [onCapture]);

  if (on) {
    return (
      <div className="cam">
        <div className="cam-view pad-view" ref={viewRef}>
          <canvas ref={canvasRef} style={paper && fit ? { width: paper.w * fit, height: paper.h * fit } : undefined} />
          {!strokes.length && <div className="pad-empty">iPad に書くと、ここに出ます</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="cam">
      <div className="pad-connect">
        {!connected ? (
          <p className="muted">サーバーにつないでいます…</p>
        ) : (
          <>
            {qr ? <img className="pad-qr" src={qr} alt="iPad で開く QR コード" width={180} height={180} />
              : <div className="pad-qr pad-qr-none">{local && !addresses ? '準備中…' : 'URL を作れません'}</div>}
            <ol className="pad-steps">
              <li>PC と iPad を同じ Wi-Fi につなぐ</li>
              <li>iPad のカメラでこの QR コードを読み、Safari で開く</li>
              <li>開いたページに Apple Pencil で書く</li>
            </ol>
          </>
        )}
      </div>
      {connected && url && <div className="pad-url num">{url}</div>}
      {connected && local && addresses && addresses.length === 0 && (
        <p className="setup-error" role="alert">PC の IP アドレスが見つかりません。Wi-Fi につながっているか確かめてください。</p>
      )}
      {connected && local && addresses && addresses.length > 1 && (
        <label className="dev-select">
          <span>PC のアドレス</span>
          <select value={addrIdx} onChange={(e) => setAddrIdx(Number(e.target.value))}>
            {addresses.map((a, i) => <option key={a.address} value={i}>{a.address}（{a.name}）</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
