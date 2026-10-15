import type { ToolDef } from './index.js';

// 勉強の一時中断と、続けるかの確認への返事
// 放置されないよう、ブラウザが勉強の時間を数えていて、30分ごとの3分前に「（続けるかの確認）」を家トモに送る（client/src/continueCheck.ts）
// 生徒が続けると答えたら continue（一時中断する時刻を30分のばす）。3分のうちに continue が来なければ、ブラウザが一時中断する
// pause は、続けないと答えたときや、生徒が休むと言ったとき。家トモが話し終わってから、ブラウザが一時中断する

export type StudyAction = 'pause' | 'continue';

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['continue', 'pause'],
      description: 'continue：勉強を続ける（「（続けるかの確認）」に続けると答えた）。pause：一時中断する（続けない・休む・やめると答えた、または休みたいと言った）',
    },
  },
  required: ['action'],
};

export const pauseStudy: ToolDef = {
  name: 'pause_study',
  label: '一時中断・続けるかの確認',
  description: '勉強を一時中断する・続ける。「（続けるかの確認）」のあとで、生徒が続けると答えたら action を continue にして呼ぶ（呼ばないと、確認から3分たつと一時中断になる）。続けない・休む・やめると答えたとき、または生徒が「ちょっと休憩します」「一時中断して」と言ったときは、ひとこと声をかけてから action を pause にして呼ぶ（話し終わると学習画面が一時中断になり、カメラ・マイク・読み上げが止まる。生徒が画面のボタンで再開する）。生徒の返事がはっきりしないときは呼ばずに、もう一度たずねる',
  parameters: PARAMETERS,
  features: [{ name: '一時中断', hint: '「ちょっと休憩します」' }],
  async run(ctx, args) {
    switch (args.action) {
      case 'continue':
        ctx.study('continue');
        return { result: { result: '勉強を続けます。また30分たったら確認します' } };
      case 'pause':
        ctx.study('pause');
        return { result: { result: '話し終わったら、学習画面が一時中断になります' } };
      default:
        return { result: { error: 'action は continue・pause のどちらかにしてください' } };
    }
  },
};
