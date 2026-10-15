import { Router } from 'express';
import { requireAdmin } from './auth.js';
import { getAllConfigs, getConfig, isPurpose, MODELS, modelInfo, PURPOSES, setConfig } from './aiConfig.js';
import { getNudgeRules, setNudgeRules } from './nudgeConfig.js';
import { NOT_CONFIGURED, providerReady } from './llm.js';
import { setToolDescription, setToolsEnabled, toolDescription, toolEnabled } from './toolConfig.js';
import { TOOLS } from './tools/index.js';

// 管理者設定の API（AI の設定・ツール・声かけの基準）と、AI・ツールが使えるか。ai.ts が /api/ai にのせる（URL は /api/ai/settings など）

export const admin = Router();

/** 用途ごとに、AI が使えるか（選んだモデルの認証が設定されているか） */
admin.get('/status', (_req, res) => {
  const purposes = Object.fromEntries(PURPOSES.map(({ key }) => {
    const m = modelInfo(getConfig(key).model)!;
    return [key, { ready: providerReady(m.provider), model: m.id, label: m.label }];
  }));
  const tools = Object.fromEntries(TOOLS.map((t) => [t.name, toolEnabled(t.name)]));
  res.json({ purposes, tools });
});

// 管理者設定：AI の設定（用途ごとのモデルと考える深さなど）。見るのも変えるのも管理者だけ（ADMIN_UIDS）
admin.get('/settings', requireAdmin, (_req, res) => {
  const configs = getAllConfigs();
  res.json({
    models: MODELS.map((m) => ({ ...m, ready: providerReady(m.provider) })),
    purposes: PURPOSES.map((p) => ({ ...p, config: configs[p.key] })),
    notConfigured: NOT_CONFIGURED,
  });
});

// 変えると全員の AI が変わる
admin.put('/settings/:purpose', requireAdmin, async (req, res) => {
  if (!isPurpose(req.params.purpose)) { res.status(404).json({ error: '用途が見つかりません' }); return; }
  res.json(await setConfig(req.params.purpose, req.body));
});

// 管理者設定：家トモが使えるツールのオン・オフと、AI に渡す説明（toolConfig.ts）。変えると全員の家トモが変わる（会話モードは次につなぐときから）
// description：いま AI に渡す説明、defaultDescription：コードに書いた説明（管理者が保存していなければこれを使う）
admin.get('/tools', requireAdmin, (_req, res) => {
  res.json(TOOLS.map((t) => ({ name: t.name, label: t.label, description: toolDescription(t.name, t.description), defaultDescription: t.description, enabled: toolEnabled(t.name) })));
});
admin.put('/tools', requireAdmin, async (req, res) => { res.json(await setToolsEnabled(req.body, TOOLS.map((t) => t.name))); });
// 説明を変える。空にするとコードに書いた説明に戻る
admin.put('/tools/:name/description', requireAdmin, async (req, res) => {
  const t = TOOLS.find((x) => x.name === req.params.name);
  if (!t) { res.status(404).json({ error: 'ツールが見つかりません' }); return; }
  res.json({ description: await setToolDescription(t.name, req.body?.description, t.description) });
});

// 声かけの合図を出す基準（nudgeConfig.ts）。授業の画面が使うので、読むのは誰でもできる。変えるのは管理者だけ（全員の基準が変わる）
admin.get('/nudge', (_req, res) => { res.json(getNudgeRules()); });
admin.put('/nudge', requireAdmin, async (req, res) => { res.json(await setNudgeRules(req.body)); });
