import { GoogleGenAI, MediaResolution, ThinkingLevel, type Content, type Schema } from '@google/genai';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { getConfig, modelInfo, type AiConfig, type Level, type Provider, type Purpose } from './aiConfig.js';
import { traceLlm } from './debug.js';

// AI の呼び出しをモデルの種類（Gemini・Claude）によらず同じ形にする。どのモデルを使うかは用途ごとの設定（aiConfig）で決める
// どちらも GCP の Agent Platform（旧 Vertex AI）経由で呼ぶ。認証は server/.env で
//   Gemini … GOOGLE_CLOUD_API_KEY（API キー）か、GOOGLE_CLOUD_PROJECT（＋ gcloud の ADC）
//   Claude … GOOGLE_CLOUD_PROJECT（＋ gcloud の ADC か GOOGLE_APPLICATION_CREDENTIALS のサービスアカウント）。API キーは使えない
//           Model Garden で「Claude Sonnet 5.5」を有効にしておく

const API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GEMINI_LOCATION = process.env.GOOGLE_CLOUD_LOCATION ?? 'global';
const CLAUDE_REGION = process.env.CLAUDE_REGION ?? 'global'; // Sonnet 5.5 は global・us・eu だけ
// 会話モード（live.ts）の Gemini Live。モデルは「管理者設定」の live で選ぶ。Live のモデルは global では使えないので、リージョンを指定する
const LIVE_LOCATION = process.env.LIVE_LOCATION ?? 'us-central1';

/** 認証が設定されていないときの理由（設定されていれば空文字） */
export const NOT_CONFIGURED: Record<Provider, string> = {
  gemini: API_KEY || PROJECT ? '' : 'server/.env に GOOGLE_CLOUD_API_KEY か GOOGLE_CLOUD_PROJECT が設定されていません',
  claude: PROJECT ? '' : 'server/.env に GOOGLE_CLOUD_PROJECT が設定されていません（Claude は API キーでは使えません。gcloud の ADC かサービスアカウントで認証します）',
};

export const providerReady = (p: Provider) => !NOT_CONFIGURED[p];

let gemini: GoogleGenAI | null = null;
let claude: AnthropicVertex | null = null;

/** 渡す中身。画像は base64 */
export type Part = { text: string } | { image: { mimeType: string; data: string } };
export type Turn = { role: 'user' | 'model'; parts: Part[] };
/** thoughts は考えたぶんのトークン数（Claude は出力に含まれていて分けられないので 0） */
export type Usage = { prompt: number; output: number; thoughts: number; total: number };
export type Generated = { text: string; usage: Usage; ms: number; model: string; config: AiConfig };

/** generate で呼ぶ用途（live は live.ts で Gemini Live につなぐ） */
export type TextPurpose = Exclude<Purpose, 'live'>;

/** 画像は base64 */
export type Image = { mimeType: string; data: string };

/** 画像（data URL）を MIME と base64 に分ける。画像でなければ null */
export function parseImage(image: unknown) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(image ?? ''));
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** 関数の結果。result は関数の結果、image があれば結果といっしょに AI に見せる */
export type ToolResult = { result: Record<string, unknown>; image?: Image };
/**
 * AI が呼べる関数。関数の中身は tools/ にある。parameters：引数（JSON Schema の object。なければ引数なし）
 * 関数が呼ばれたら結果を返して続きを生成する（MAX_TOOL_ROUNDS 回まで）
 */
export type Tool = { name: string; description: string; parameters?: object; run: (args: Record<string, unknown>) => Promise<ToolResult> };
type Request = { system?: string; turns: Turn[]; schema?: object; tools?: Tool[] };
const MAX_TOOL_ROUNDS = 3;

const addUsage = (a: Usage, b: Usage): Usage => ({ prompt: a.prompt + b.prompt, output: a.output + b.output, thoughts: a.thoughts + b.thoughts, total: a.total + b.total });

/** 用途の設定どおりのモデルで生成する。schema を渡すと JSON の文字列が返る */
export async function generate(purpose: TextPurpose, req: Request): Promise<Generated> {
  const config = getConfig(purpose);
  const m = modelInfo(config.model)!;
  if (!providerReady(m.provider)) throw Object.assign(new Error(NOT_CONFIGURED[m.provider]), { status: 503 });
  const started = Date.now();
  const r = m.provider === 'gemini' ? await viaGemini(config, req, purpose) : await viaClaude(config, req, purpose);
  return { ...r, ms: Date.now() - started, model: config.model, config };
}

/** デバッグ授業なら、送るデータと返ってきたデータを記録しながら呼ぶ（debug.ts） */
async function traced<R extends { text: string; usage: Usage }>(
  info: { purpose: Purpose; provider: Provider; config: AiConfig; endpoint: string; request: unknown },
  call: () => Promise<{ result: R; response: unknown }>,
): Promise<R> {
  const t = traceLlm({ ...info, model: info.config.model });
  try {
    const { result, response } = await call();
    t?.end({ text: result.text, usage: result.usage, response });
    return result;
  } catch (e) {
    t?.fail(e);
    throw e;
  }
}

/** Gemini Live のクライアント。API キーのときはリージョンのエンドポイントを指定する（指定しないと global になって Live につながらない） */
let live: GoogleGenAI | null = null;
export function liveClient() {
  if (!providerReady('gemini')) throw Object.assign(new Error(NOT_CONFIGURED.gemini), { status: 503 });
  return live ??= API_KEY
    ? new GoogleGenAI({ enterprise: true, apiKey: API_KEY, httpOptions: { baseUrl: `https://${LIVE_LOCATION}-aiplatform.googleapis.com/` } })
    : new GoogleGenAI({ enterprise: true, project: PROJECT, location: LIVE_LOCATION });
}

// ---- Gemini ----

const THINKING_LEVEL: Record<Level, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }; // 3.8 Flash は MINIMAL 非対応
const MEDIA_RESOLUTION: Record<Level, MediaResolution> = {
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  high: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

async function viaGemini(config: AiConfig, req: Request, purpose: TextPurpose) {
  const client = gemini ??= API_KEY
    ? new GoogleGenAI({ enterprise: true, apiKey: API_KEY })
    : new GoogleGenAI({ enterprise: true, project: PROJECT, location: GEMINI_LOCATION });
  const contents: Content[] = req.turns.map((t) => ({
    role: t.role,
    parts: t.parts.map((p) => ('text' in p ? { text: p.text } : { inlineData: p.image })),
  }));
  const config_ = {
    ...(req.system && { systemInstruction: req.system }),
    ...(req.schema && { responseMimeType: 'application/json', responseJsonSchema: req.schema }),
    ...(req.tools?.length && { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, ...(t.parameters && { parameters: toGeminiSchema(t.parameters) }) })) }] }),
    thinkingConfig: { thinkingLevel: THINKING_LEVEL[config.thinking] },
    mediaResolution: MEDIA_RESOLUTION[config.mediaResolution],
  };
  let usage: Usage = { prompt: 0, output: 0, thoughts: 0, total: 0 };
  for (let round = 0; ; round++) {
    const params = { model: config.model, contents: [...contents], config: config_ };
    const r = await traced({ purpose, provider: 'gemini', config, endpoint: 'models.generateContent', request: params }, async () => {
      const r = await client.models.generateContent(params);
      const u = r.usageMetadata;
      const result = {
        text: r.text ?? '',
        usage: { prompt: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0, thoughts: u?.thoughtsTokenCount ?? 0, total: u?.totalTokenCount ?? 0 },
        response: r,
      };
      return { result, response: r };
    });
    usage = addUsage(usage, r.usage);
    const calls = r.response.functionCalls ?? [];
    const content = r.response.candidates?.[0]?.content;
    if (!calls.length || !content || round >= MAX_TOOL_ROUNDS) return { text: r.text, usage };
    // 関数を呼んだ。呼んだ発言（考えた中身の署名も含む）をそのまま残し、結果を返して続きを生成する
    contents.push(content);
    contents.push({
      role: 'user',
      parts: await Promise.all(calls.map(async (c) => {
        const out = await runTool(req.tools, c.name, c.args);
        return { functionResponse: { id: c.id, name: c.name, response: out.result, ...(out.image && { parts: [{ inlineData: out.image }] }) } };
      })),
    });
  }
}

/** 関数を呼ぶ。知らない関数ならエラーを結果にする */
async function runTool(tools: Tool[] | undefined, name: string | undefined, args: unknown): ReturnType<Tool['run']> {
  const t = tools?.find((x) => x.name === name);
  return t ? t.run(args && typeof args === 'object' ? args as Record<string, unknown> : {}) : { result: { error: `${name} という関数はありません` } };
}

/** 関数の引数の JSON Schema を Gemini の形にする（type を大文字にする。会話モードの Gemini Live でも使う） */
export function toGeminiSchema(s: unknown): Schema {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s as Schema;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k,
    k === 'type' && typeof v === 'string' ? v.toUpperCase()
      : k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toGeminiSchema(pv)]))
      : k === 'items' ? toGeminiSchema(v) : v])) as Schema;
}

// ---- Claude ----

/** 出力の上限（考えたぶんも含む） */
const CLAUDE_MAX_TOKENS: Record<TextPurpose, number> = { chat: 8000, note: 8000 };

/**
 * Claude の構造化出力で使えない項目を外す（配列の個数の制限など）。object には additionalProperties: false が要る
 * 外した制限は、受け取ったあとサーバーで確かめている（図の座標など）
 */
function toClaudeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toClaudeSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'minItems' || k === 'maxItems') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toClaudeSchema(pv)])) : toClaudeSchema(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

async function viaClaude(config: AiConfig, req: Request, purpose: TextPurpose) {
  const client = claude ??= new AnthropicVertex({ projectId: PROJECT, region: CLAUDE_REGION });
  const messages: Anthropic.MessageParam[] = req.turns.map((t) => ({
    role: t.role === 'model' ? 'assistant' : 'user',
    content: t.parts.map((p): Anthropic.ContentBlockParam =>
      'text' in p ? { type: 'text', text: p.text }
        : { type: 'image', source: { type: 'base64', media_type: p.image.mimeType as 'image/jpeg', data: p.image.data } }),
  }));
  // 会話はユーザーの発言から始める（家トモが先に話した履歴のとき）
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '（勉強を始めます）' });
  // 長い出力でも途中で切れないよう、ストリームで受けて最後にまとめる
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.model,
    max_tokens: CLAUDE_MAX_TOKENS[purpose],
    ...(req.system && { system: req.system }),
    messages,
    thinking: { type: 'adaptive' }, // Sonnet 5.5 は考えないようにはできない。深さは effort で決める
    output_config: {
      effort: config.thinking,
      ...(req.schema && { format: { type: 'json_schema', schema: toClaudeSchema(req.schema) as Record<string, unknown> } }),
    },
  };
  if (req.tools?.length) params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: (t.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema }));
  let usage: Usage = { prompt: 0, output: 0, thoughts: 0, total: 0 };
  for (let round = 0; ; round++) {
    const body = { ...params, messages: [...messages] };
    const r = await traced({ purpose, provider: 'claude', config, endpoint: 'messages.stream', request: body }, async () => {
      const r = await client.messages.stream(body).finalMessage();
      // 断られた・切れたときも、返ってきた中身はデバッグで見られるようにしてから失敗にする
      if (r.stop_reason === 'refusal') throw Object.assign(new Error('Claude が回答を断りました'), { response: r });
      if (r.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude の出力が長すぎて途中で切れました'), { response: r });
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const u = r.usage;
      const prompt = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      return { result: { text, usage: { prompt, output: u.output_tokens, thoughts: 0, total: prompt + u.output_tokens }, response: r }, response: r };
    });
    usage = addUsage(usage, r.usage);
    const calls = r.response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (r.response.stop_reason !== 'tool_use' || !calls.length || round >= MAX_TOOL_ROUNDS) return { text: r.text, usage };
    // 関数を呼んだ。呼んだ発言（考えた中身も含む）をそのまま残し、結果を返して続きを生成する
    messages.push({ role: 'assistant', content: r.response.content });
    messages.push({
      role: 'user',
      content: await Promise.all(calls.map(async (c): Promise<Anthropic.ToolResultBlockParam> => {
        const out = await runTool(req.tools, c.name, c.input);
        return {
          type: 'tool_result',
          tool_use_id: c.id,
          content: [
            { type: 'text', text: JSON.stringify(out.result) },
            ...(out.image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: out.image.mimeType as 'image/jpeg', data: out.image.data } }] : []),
          ],
        };
      })),
    });
  }
}
