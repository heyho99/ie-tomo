// 共有している画面への書き込み（ペン・図形）。画面の上に重ねて映し、家トモに渡す1コマにも重ねる
// 位置は画面の幅・高さを 1 とした割合で持つ（小さく映すときも、大きく映すときも、AI に渡す画像でも同じ所に重なる）

export type InkTool = 'pen' | 'marker' | 'rect' | 'ellipse' | 'arrow';
export type InkStroke = {
  tool: InkTool;
  color: string;
  /** 点（割合）。ペン・マーカーは通った点、図形ははじめと終わりの2点 */
  points: [number, number][];
};

export const INK_COLORS = [
  { color: '#E5243B', name: '赤' },
  { color: '#1F6FEB', name: '青' },
  { color: '#16A34A', name: '緑' },
  { color: '#F5B700', name: '黄' },
];

/** 線の太さ（画面の幅に対する割合） */
const WIDTH: Record<InkTool, number> = { pen: 0.004, marker: 0.018, rect: 0.004, ellipse: 0.004, arrow: 0.004 };

/** 書き込みを描く。w・h は画面（映像）を描いた大きさ（px） */
export function drawInk(g: CanvasRenderingContext2D, strokes: InkStroke[], w: number, h: number) {
  for (const s of strokes) {
    if (!s.points.length) continue;
    const pts = s.points.map(([x, y]) => [x * w, y * h] as const);
    const lw = Math.max(1.5, WIDTH[s.tool] * w);
    g.save();
    g.strokeStyle = s.color;
    g.fillStyle = s.color;
    g.lineWidth = lw;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (s.tool === 'marker') g.globalAlpha = 0.35;
    const [x0, y0] = pts[0];
    const [x1, y1] = pts[pts.length - 1];
    g.beginPath();
    if (s.tool === 'pen' || s.tool === 'marker') {
      if (pts.length === 1) { // 点を打っただけ
        g.arc(x0, y0, lw / 2, 0, Math.PI * 2);
        g.fill();
        g.restore();
        continue;
      }
      g.moveTo(x0, y0);
      for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    } else if (s.tool === 'rect') {
      g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else if (s.tool === 'ellipse') {
      g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    } else {
      // 矢印：はじめから終わりへ。終わりに矢じり
      const a = Math.atan2(y1 - y0, x1 - x0);
      const head = lw * 4;
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.moveTo(x1 - head * Math.cos(a - Math.PI / 6), y1 - head * Math.sin(a - Math.PI / 6));
      g.lineTo(x1, y1);
      g.lineTo(x1 - head * Math.cos(a + Math.PI / 6), y1 - head * Math.sin(a + Math.PI / 6));
    }
    g.stroke();
    g.restore();
  }
}
