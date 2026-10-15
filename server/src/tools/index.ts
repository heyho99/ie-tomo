import type { Image, Tool, ToolResult } from '../llm.js';
import { lookAtNote } from './look_at_note.js';
import { lookAtScreen } from './look_at_screen.js';
import { howToStart } from './how_to_start.js';
import { pauseStudy, type StudyAction } from './pause_study.js';
import { timer, type TimerState } from './timer.js';
import { whatCanYouDo } from './what_can_you_do.js';
import { toolDescription, toolEnabled } from '../toolConfig.js';

// 家トモが呼べる関数の一覧（チャットモード・会話モード共通）。関数を足すときは、1つ1ファイルで書いてここに並べる（what_can_you_do はこの一覧をもとに説明する）
// チャットモード（ai.ts）は forChat、会話モード（live.ts）は enabledTools と runTool で使う
// 管理者設定でオフにしたツールは AI に渡さず、呼ばれても動かさない。AI に渡す説明も管理者設定で変えられる（toolConfig.ts）

/** 生徒向けの、できること1つ。name：機能の名前、hint：頼み方の例（「」つき）か短い説明 */
export type Feature = { name: string; hint: string };

/** 関数が使える、ブラウザや会話の手段。モードごとに用意する */
export type ToolContext = {
  /** 共有している画面のいまの1コマ（共有していなければ null） */
  screen: () => Promise<Image | null>;
  /** 手元のノートのいまの画像（手元ノートを使っていない・映っていなければ null） */
  note: () => Promise<Image | null>;
  /** 計っている時間（timer）。計っていなければ null */
  timer: { get: () => TimerState | null; set: (s: TimerState | null) => void };
  /** 勉強を一時中断する・続ける（pause_study）。ブラウザに知らせる */
  study: (action: StudyAction) => void;
};

/**
 * 家トモが呼べる関数。label：管理者設定に出す名前
 * description：AI に渡す関数の説明（何をするか・いつ呼ぶか・何が届くか）。管理者設定で変えていなければこれを使う
 * parameters：引数（JSON Schema の object）。なければ引数なし
 * features：生徒向けの、できることの一覧（what_can_you_do で見せる）。機能がいくつかあるツールは、それぞれを並べる
 */
export type ToolDef = { name: string; label: string; description: string; parameters?: object; features: Feature[]; run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult> };

export const TOOLS: ToolDef[] = [lookAtScreen, lookAtNote, timer, pauseStudy, howToStart, whatCanYouDo];

/** いまオンのツール。description は管理者設定で変えたものに置きかえる */
export const enabledTools = (): ToolDef[] => TOOLS.filter((t) => toolEnabled(t.name)).map((t) => ({ ...t, description: toolDescription(t.name, t.description) }));

/** 関数を呼ぶ。知らない関数・オフの関数ならエラーを結果にする */
export async function runTool(name: string | undefined, ctx: ToolContext, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const t = enabledTools().find((x) => x.name === name);
  return t ? t.run(ctx, args) : { result: { error: `${name} という関数は使えません` } };
}

/** チャットモード（llm.ts の generate）に渡す形にする */
export function forChat(ctx: ToolContext): Tool[] {
  return enabledTools().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, run: (args) => t.run(ctx, args) }));
}
