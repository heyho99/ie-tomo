import { useEffect, useState, type CSSProperties, type PointerEvent } from 'react';
import { DebugPanel } from '../components/DebugPanel';
import { debugLog } from '../debug';
import { Study } from './Study';

// 開発者用：デバッグ授業。授業の画面はふつうの授業（Study）をそのまま使い、右にデバッグの記録を並べる
// Study を変えれば、デバッグ授業の画面も同じように変わる

const MIN_W = 320;

export function DebugLesson() {
  const [session] = useState(() => `dbg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  // 記録を始めてから Study を出す（Study の最初の動きから記録するため）
  const [ready, setReady] = useState(false);
  useEffect(() => {
    debugLog.start(session);
    setReady(true);
    return () => debugLog.stop();
  }, [session]);

  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(520);

  // 仕切りをドラッグして記録の幅を変える
  const onDown = (e: PointerEvent<HTMLDivElement>) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setWidth(Math.round(Math.max(MIN_W, Math.min(window.innerWidth - e.clientX, window.innerWidth - 360))));
  };

  return (
    <div className="dbg-shell" style={{ '--dbg-w': `${width}px` } as CSSProperties}>
      <div className="dbg-app">
        {ready && <Study />}
      </div>
      {/* たたんでもサーバーとのつながりは切らない（そのあいだの記録も残す） */}
      <div className="dbg-split" hidden={!open} role="separator" aria-orientation="vertical" aria-label="デバッグの幅を変える"
        title="ドラッグで幅を変える" onPointerDown={onDown} onPointerMove={onMove} />
      <DebugPanel session={session} hidden={!open} onClose={() => setOpen(false)} />
      {!open && <button type="button" className="btn btn-primary btn-sm dbg-open" onClick={() => setOpen(true)}>デバッグを開く</button>}
    </div>
  );
}
