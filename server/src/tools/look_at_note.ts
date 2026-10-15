import type { ToolDef } from './index.js';

/** 生徒の手元のノートを見る。ノートの画像はブラウザからもらう（ctx.note） */
export const lookAtNote: ToolDef = {
  name: 'look_at_note',
  label: '手元のノートを見る',
  description: '生徒の手元のノート（手元カメラか iPad に書いたもの）を見る。生徒がノートについて話したとき（「このノート見て」「ここ合ってる？」「この式どう？」「書いたの見て」など）に呼び、推測で答えずに見てから答える。呼ぶと、いまのノートの画像が届く',
  features: [{ name: 'ノートを見る', hint: '「このノート見て」「ここ合ってる？」' }],
  async run(ctx) {
    const image = await ctx.note();
    return image
      ? { result: { result: '生徒の手元の、いまのノートの画像です。画像を見て答える' }, image }
      : { result: { error: '生徒の手元のノートが見えません（手元ノートを使わない設定か、手元カメラ・iPad がつながっていない）。見えないことを伝え、必要なら設定やカメラを確かめてもらう' } };
  },
};
