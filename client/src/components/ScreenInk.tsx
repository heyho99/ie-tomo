import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { INK_COLORS, drawInk, type InkStroke, type InkTool } from '../screenInk';

// 共有している画面を映し、その上に書き込み（ペン・図形）を重ねる
// ScreenStage：映像と書き込み（edit があれば、ペンで書ける）。ScreenDraw：大きく映して書く画面

type Edit = { tool: InkTool; color: string; onAdd: (s: InkStroke) => void };

/**
 * 共有している画面の映像と書き込み。書き込みの位置が映像とずれないよう、映像と同じ縦横比の枠に重ねる
 * fit：親の大きさにおさまるように映す（大きく映すとき）。ないときは幅いっぱい
 */
export function ScreenStage({ stream, strokes, edit, fit = false }: { stream: MediaStream | null; strokes: InkStroke[]; edit?: Edit; fit?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<InkStroke | null>(null); // 書いている途中の線
  const [ratio, setRatio] = useState(16 / 10); // 映像の 幅 / 高さ
  const [box, setBox] = useState<{ w: number; h: number } | null>(null); // fit のときの枠の大きさ

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
    // 共有するタブを切り替えると、映像の大きさが変わる
    const onSize = () => { if (v.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight); };
    v.addEventListener('loadedmetadata', onSize);
    v.addEventListener('resize', onSize);
    return () => { v.removeEventListener('loadedmetadata', onSize); v.removeEventListener('resize', onSize); };
  }, [stream]);

  // fit：親の大きさに、映像の縦横比のままおさめる
  useLayoutEffect(() => {
    const parent = wrap.current?.parentElement;
    if (!fit || !parent) return;
    const measure = () => {
      const { width: pw, height: ph } = parent.getBoundingClientRect();
      const w = Math.min(pw, ph * ratio);
      setBox({ w, h: w / ratio });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [fit, ratio]);

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    drawInk(g, drawing.current ? [...strokes, drawing.current] : strokes, w, h);
  }, [strokes]);

  useLayoutEffect(() => {
    redraw();
    const c = canvas.current;
    if (!c) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw, ratio, box]);

  /** ポインターの位置（枠の幅・高さを 1 とした割合） */
  const at = (e: PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!edit || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { tool: edit.tool, color: edit.color, points: [at(e)] };
    redraw();
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const s = drawing.current;
    if (!s) return;
    const p = at(e);
    if (s.tool === 'pen' || s.tool === 'marker') s.points.push(p);
    else s.points = [s.points[0], p];
    redraw();
  };
  const onUp = () => {
    const s = drawing.current;
    drawing.current = null;
    if (s && edit) edit.onAdd(s);
    else redraw();
  };

  const style = (fit && box ? { width: box.w, height: box.h } : { aspectRatio: String(ratio) }) as CSSProperties;
  return (
    <div ref={wrap} className={`screen-view${edit ? ' screen-edit' : ''}`} style={style}>
      <video ref={video} autoPlay playsInline muted aria-label="共有している画面の映像" />
      <canvas
        ref={canvas}
        aria-label={edit ? '共有している画面に書き込む' : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  );
}

const TOOLS: { tool: InkTool; name: string }[] = [
  { tool: 'pen', name: 'ペン' },
  { tool: 'marker', name: 'マーカー' },
  { tool: 'rect', name: '四角' },
  { tool: 'ellipse', name: '丸' },
  { tool: 'arrow', name: '矢印' },
];

type Ink = { strokes: InkStroke[]; add: (s: InkStroke) => void; undo: () => void; clear: () => void };

/** 共有している画面を大きく映して、ペンで書き込む。書いたものは家トモに渡す1コマにも重なる */
export function ScreenDraw({ stream, ink, onClose }: { stream: MediaStream | null; ink: Ink; onClose: () => void }) {
  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState(INK_COLORS[0].color);

  // Esc で閉じる。Ctrl+Z（⌘Z）でひとつ戻す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); ink.undo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, ink.undo]);

  return (
    <div className="ink-overlay" role="dialog" aria-modal="true" aria-label="画面に書き込む">
      <div className="ink-bar">
        <div className="ink-group" role="radiogroup" aria-label="書くもの">
          {TOOLS.map((t) => (
            <button key={t.tool} type="button" role="radio" aria-checked={tool === t.tool} className={`btn btn-sm ${tool === t.tool ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTool(t.tool)}>{t.name}</button>
          ))}
        </div>
        <div className="ink-group" role="radiogroup" aria-label="色">
          {INK_COLORS.map((c) => (
            <button key={c.color} type="button" role="radio" aria-checked={color === c.color} aria-label={c.name} title={c.name} className={`ink-color${color === c.color ? ' on' : ''}`} style={{ background: c.color }} onClick={() => setColor(c.color)} />
          ))}
        </div>
        <div className="ink-group">
          <button type="button" className="btn btn-ghost btn-sm" disabled={!ink.strokes.length} onClick={ink.undo}>ひとつ戻す</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!ink.strokes.length} onClick={ink.clear}>ぜんぶ消す</button>
        </div>
        <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>閉じる</button>
      </div>
      <p className="ink-hint">書いたものは、家トモが画面を見るときにいっしょに見えます。書きながら声で「ここ」と聞けます（チャットは閉じてから）。</p>
      <div className="ink-area">
        <ScreenStage stream={stream} strokes={ink.strokes} edit={{ tool, color, onAdd: ink.add }} fit />
      </div>
    </div>
  );
}
