// 手元（ノート）の1コマを AI に送る画像にする関数。手元カメラ（HandCamera）と iPad のノート（PadNote）が作る
// maxSide：長い辺（px。Infinity なら縮めない）、quality：JPEG の画質、rotate：手元カメラの向き（iPad のノートは使わない）
export type CaptureOptions = { maxSide: number; quality: number; rotate: number };
/** image は JPEG の data URL。width・height は画像の大きさ */
export type Captured = { image: string; width: number; height: number };
export type Capture = (o: CaptureOptions) => Captured | null;
