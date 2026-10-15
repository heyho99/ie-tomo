import { enabledTools, type Feature, type ToolDef } from './index.js';

// 家トモに何ができるかを説明する。いまオンのツールの一覧（管理者設定）をもとに、決まった形の文を作って AI に渡す
// 一覧に出すのはオンのツールの機能だけ（ツールでない会話や見守りの声かけは出さない）
// チャットではその文をそのまま返してもらう（表示がそろうように）。会話モードでは声なので、要点だけ話してもらう

/**
 * 生徒に見せる文。1つの機能を1行にする
 * いまできることです。
 * ・タイマー：「10分計って」
 * …
 */
export function featureText(features: Feature[]) {
  if (!features.length) return 'いまは使える機能がありません。';
  return ['いまできることです。', ...features.map((f) => `・${f.name}：${f.hint}`), '使いたいものがあれば、話しかけてください。'].join('\n');
}

export const whatCanYouDo: ToolDef = {
  name: 'what_can_you_do',
  label: '何ができるかを説明する',
  description: '家トモに何ができるかを調べる。生徒が「何ができるの？」「どんなことを頼める？」「使い方を教えて」のように、家トモにできることを聞いたときに呼ぶ。呼ぶと、いま使える機能の一覧が届く。一覧にないことを、できるように話さない',
  features: [],
  async run() {
    const features = enabledTools().flatMap((t) => t.features);
    return { result: {
      result: '文字のチャットなら、text をそのまま（改行もそのまま）返事にする。前後に文を足したり、言いかえたり、並べかえたりしない。声の会話なら、text を読み上げず、主なできることを2〜3文で短く伝える',
      text: featureText(features),
    } };
  },
};
