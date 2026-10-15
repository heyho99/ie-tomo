import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ERASER_WIDTH, PEN_WIDTH, drawPaper, drawStroke, usePadSocket, type Stroke } from '../pad';

// iPad のノート：iPad の Safari で開く手書きのページ（PC の授業画面の QR コードから開く）
// Apple Pencil で書いた線を1本ずつ PC に送る。指では書かない（手のひらが当たっても線にならないように）。「指でも書く」をオンにすると指でも書ける
// 用紙は最初につないだときの画面の広さ。問題が変わると PC が白紙にする

const FINGER_KEY = 'tonari-sensei:padFinger';
const loadFinger = () => { try { return localStorage.getItem(FINGER_KEY) === '1'; } catch { return false; } };

export function Pad() {
  const { room = '' } = useParams();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 }); // 書ける広さ（CSS px）
  const areaNow = useRef(area);
  areaNow.current = area;
  const [tool, setTool] = useState<Stroke['tool']>('pen');
  const [finger, setFinger] = useState(loadFinger);
  const [confirmClear, setConfirmClear] = useState(false);
  const drawing = useRef<{ pointerId: number; stroke: Stroke } | null>(null);
  const pad = usePadSocket('pad', room, (send) => {
    const { w, h } = areaNow.current;
    if (w && h) send({ type: 'hello', w, h });
  });
  const { connected, strokes, setStrokes, send } = pad;
  const paper = pad.paper ?? (area.w && area.h ? area : null);
  const fit = paper ? Math.min(area.w / paper.w, area.h / paper.h) : 1; // 用紙を画面に収める縮め方

  // 書ける広さを計る。向きを変えたら知らせる（次に白紙になったときから、その向きの用紙になる）
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => setArea({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (area.w && area.h) send({ type: 'hello', w: area.w, h: area.h }); }, [area.w, area.h, send]);

  // 用紙と線をすべて描きなおす（書いている途中の線も）
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !paper) return;
    const k = fit * (window.devicePixelRatio || 1);
    canvas.width = Math.round(paper.w * k);
    canvas.height = Math.round(paper.h * k);
    const ctx = canvas.getContext('2d')!;
    drawPaper(ctx, paper, strokes, k);
    if (drawing.current) drawStroke(ctx, drawing.current.stroke);
  }, [paper?.w, paper?.h, fit, strokes]);

  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  /** 画面の位置を用紙の上の座標にする（小数1けたに丸めて、送る量を減らす） */
  const toPaper = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / fit) * 10) / 10, Math.round(((e.clientY - r.top) / fit) * 10) / 10];
  };

  function onDown(e: PointerEvent<HTMLCanvasElement>) {
    if (drawing.current || !connected || !paper) return;
    if (e.pointerType === 'touch' && !finger) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const stroke: Stroke = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, tool, w: tool === 'eraser' ? ERASER_WIDTH : PEN_WIDTH, pts: toPaper(e) };
    drawing.current = { pointerId: e.pointerId, stroke };
    const ctx = canvasRef.current!.getContext('2d')!;
    drawStroke(ctx, stroke);
  }

  function onMove(e: PointerEvent<HTMLCanvasElement>) {
    const d = drawing.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const pts = d.stroke.pts;
    // Apple Pencil は1回の描画のあいだに何点も動くので、まとめて受け取る
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.strokeStyle = d.stroke.tool === 'eraser' ? '#fff' : '#1a1a1a';
    ctx.lineWidth = d.stroke.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[pts.length - 2], pts[pts.length - 1]);
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const [x, y] = toPaper(ev);
      if (x === pts[pts.length - 2] && y === pts[pts.length - 1]) continue;
      pts.push(x, y);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function onUp(e: PointerEvent<HTMLCanvasElement>) {
    const d = drawing.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drawing.current = null;
    setStrokes((s) => [...s, d.stroke]);
    send({ type: 'add', stroke: d.stroke });
  }

  function toggleFinger() {
    const v = !finger;
    setFinger(v);
    try { localStorage.setItem(FINGER_KEY, v ? '1' : '0'); } catch { /* 保存できなくても動く */ }
  }

  return (
    <div className="pad" onContextMenu={(e) => e.preventDefault()}>
      <div className="pad-bar">
        <div className="pills">
          <button type="button" className="pill" aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>ペン</button>
          <button type="button" className="pill" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>消しゴム</button>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!connected || !strokes.length} onClick={() => send({ type: 'undo' })}>1つ戻す</button>
        <button type="button" className={`btn btn-sm ${confirmClear ? 'btn-primary' : 'btn-ghost'}`} disabled={!connected || !strokes.length}
          onClick={() => { if (confirmClear) { send({ type: 'clear' }); setConfirmClear(false); } else setConfirmClear(true); }}>
          {confirmClear ? 'もう一度押すと全部消えます' : '全部消す'}
        </button>
        <label className="toggle">
          <input type="checkbox" checked={finger} onChange={toggleFinger} />
          指でも書く
        </label>
        <span className={`chip ${connected ? 'chip-blue' : 'chip-red'}`} style={{ marginLeft: 'auto' }}>
          {connected ? 'PC とつながっています' : 'PC につないでいます…'}
        </span>
      </div>
      <div className="pad-area" ref={areaRef}>
        {paper && (
          <canvas ref={canvasRef} className="pad-canvas" style={{ width: paper.w * fit, height: paper.h * fit }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        )}
        {!connected && (
          <div className="pad-msg">
            PC とつながっていません。つなぎ直しています…<br />
            PC で授業の画面が開いているか、PC と iPad が同じ Wi-Fi につながっているかを確かめてください。
          </div>
        )}
      </div>
    </div>
  );
}
