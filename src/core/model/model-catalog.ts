/**
 * model-catalog: 模型目录与单模型元数据。
 *
 * 目录来源（按序回退）：
 *   {baseUrl}/v1/models  →  {baseUrl}/models  →  内置 mock catalog
 *
 * baseUrl/apiKey 复用 baseagent 凭据解析链（与发消息同源），命令不接收 url/key 参数。
 * 单模型详情（info）现阶段全部为 mock，{baseUrl}/models 接口补全字段后自动接真实数据。
 *
 * 详见 docs/model-command-design.md。
 */

import { loadDefaults, loadAgent } from '../../config-store.js';
import { resolveAnthropicConfig, resolveOpenaiConfig } from '../../agents/resolve.js';
import { activeBaseagent } from './model-scope.js';
import type { BaseagentsBlock } from '../../types.js';

export interface ModelCatalogEntry {
  id: string;
  owned_by?: string;
  created?: number;
}

export interface ModelInfo {
  id: string;
  owned_by: string;
  context_window: number | null;
  max_output_tokens: number | null;
  pricing: { input_per_mtok: number | null; output_per_mtok: number | null; currency: string } | null;
  modalities: string[];
  supports_effort: boolean;
  status: string;
  mocked: boolean;
}

/** 取指定 baseagent 的 baseUrl + apiKey（复用现有解析链）。 */
function resolveCreds(self?: string, ba?: string): { baseUrl?: string; apiKey?: string } {
  const baseagent = ba || activeBaseagent(self);
  const agentCfg = self ? loadAgent(self) : null;
  const defaults = loadDefaults();
  const block = (agentCfg?.baseagents || defaults?.baseagents || {}) as BaseagentsBlock;

  try {
    if (baseagent === 'codex') {
      const c = (block as any).codex;
      const r = resolveOpenaiConfig({ agents: { codex: c } } as any, c);
      return { baseUrl: r.baseUrl, apiKey: r.apiKey };
    }
    const c = (block as any).claude;
    const r = resolveAnthropicConfig({ agents: { claude: c } } as any, c);
    return { baseUrl: r.baseUrl, apiKey: r.apiKey };
  } catch {
    return {};
  }
}

// ── 模型列表解析 ───────────────────────────────────────────────────────
//
// 不同 AI 网关的 /models 返回格式不一。解析分两层：
//   1. 网关专用 parser（GATEWAY_PARSERS）：按 URL 匹配，处理该网关的特异格式。
//   2. 通用容错 parser（genericParse）：覆盖最常见的容器与字段别名。
// 默认走通用解析（当前 ModelGate 即 OpenAI list 风格，通用解析已覆盖）。
// 接入返回异形格式的新网关时，往 GATEWAY_PARSERS 加一条规则即可，无需动主流程。

type ModelListParser = (json: any) => ModelCatalogEntry[];

interface GatewayParserRule {
  /** 网关标识（仅用于日志/调试） */
  name: string;
  /** 命中条件：按请求 URL 或响应结构判定 */
  match: (url: string, json: any) => boolean;
  parse: ModelListParser;
}

/** 从对象/字符串条目里提取 id（兼容 id/name/model 字段）。 */
function pickId(item: any): string | undefined {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const v = item.id ?? item.name ?? item.model;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/** 从对象条目里提取厂商（兼容 owned_by/owner/provider）。 */
function pickOwner(item: any): string | undefined {
  if (item && typeof item === 'object') {
    const v = item.owned_by ?? item.owner ?? item.provider;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * 通用容错解析：
 *   - 容器：json.data[] | json.models[] | json.data.models[] | 裸数组
 *   - 条目：字符串 或 {id|name|model, owned_by|owner|provider, created}
 */
function genericParse(json: any): ModelCatalogEntry[] {
  const arr: any[] =
    Array.isArray(json) ? json
    : Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
    : Array.isArray(json?.data?.models) ? json.data.models
    : [];
  const out: ModelCatalogEntry[] = [];
  for (const item of arr) {
    const id = pickId(item);
    if (!id) continue;
    out.push({ id, owned_by: pickOwner(item), created: typeof item?.created === 'number' ? item.created : undefined });
  }
  return out;
}

/**
 * 网关专用 parser 注册表（扩展点）。
 * 当前为空：ModelGate 是标准 OpenAI list 风格，genericParse 已覆盖。
 * 示例（接入异形网关时取消注释并按实际格式实现）：
 *   {
 *     name: 'some-gateway',
 *     match: (url) => url.includes('some-gateway.example.com'),
 *     parse: (json) => (json?.result?.modelList ?? []).map((m: any) => ({ id: m.code, owned_by: m.vendor })),
 *   }
 */
const GATEWAY_PARSERS: GatewayParserRule[] = [];

/** 选择 parser 并解析（专用优先，否则通用容错）。 */
export function parseModelList(json: any, url: string): ModelCatalogEntry[] {
  for (const rule of GATEWAY_PARSERS) {
    try {
      if (rule.match(url, json)) return rule.parse(json);
    } catch { /* 专用 parser 失败则继续尝试通用解析 */ }
  }
  return genericParse(json);
}

async function fetchModelList(url: string, apiKey?: string): Promise<ModelCatalogEntry[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const entries = parseModelList(json, url);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** 内置 mock catalog（接口未就绪时的兜底；实测可用模型，见 docs 附录 A）。 */
const MOCK_CATALOG: ModelCatalogEntry[] = [
  { id: 'claude-opus-4-7', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', owned_by: 'anthropic' },
  { id: 'deepseek-v4-pro', owned_by: 'deepseek' },
  { id: 'deepseek-v4-flash', owned_by: 'deepseek' },
  { id: 'kimi-k2.6', owned_by: 'moonshot' },
  { id: 'kimi-k2.5', owned_by: 'moonshot' },
  { id: 'glm-5.1', owned_by: 'zhipu' },
  { id: 'glm-5', owned_by: 'zhipu' },
  { id: 'glm-4.7', owned_by: 'zhipu' },
  { id: 'MiniMax-M2.7', owned_by: 'minimax' },
];

export interface CatalogResult {
  models: ModelCatalogEntry[];
  source: 'v1/models' | 'models' | 'remote' | 'mock';
}

/**
 * 远端模型目录接口（临时）。本地 baseUrl 的 /v1/models、/models 尚未实现，
 * 自动降级到此接口拉取真实可用模型列表；待本地接口就绪后此级自然不再命中。
 */
const REMOTE_CATALOG_URL = 'https://mg-new.evolai.cn/claude-proxy/models';

/**
 * 各 baseagent 的稳定别名（cc/SDK 自动解析到最新版本）。
 * 这些是一等公民——defaults.json 默认就存别名（如 "opus"），必须可选可校验。
 */
const KNOWN_ALIASES: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: [],
  gemini: [],
};

/** 把别名作为虚拟条目并入目录头部（owned_by 标 alias，便于展示与校验）。 */
function withAliases(models: ModelCatalogEntry[], ba: string): ModelCatalogEntry[] {
  const aliases = KNOWN_ALIASES[ba] || [];
  const existing = new Set(models.map(m => m.id));
  const aliasEntries: ModelCatalogEntry[] = aliases
    .filter(a => !existing.has(a))
    .map(a => ({ id: a, owned_by: 'alias' }));
  return [...aliasEntries, ...models];
}

/** 拉取模型目录：v1/models → models → 远端接口 → mock，并并入别名。 */
export async function getCatalog(self?: string, ba?: string): Promise<CatalogResult> {
  const baseagent = ba || activeBaseagent(self);
  const { baseUrl, apiKey } = resolveCreds(self, baseagent);
  if (baseUrl) {
    const base = baseUrl.replace(/\/+$/, '');
    const v1 = await fetchModelList(`${base}/v1/models`, apiKey);
    if (v1) return { models: withAliases(v1, baseagent), source: 'v1/models' };
    const plain = await fetchModelList(`${base}/models`, apiKey);
    if (plain) return { models: withAliases(plain, baseagent), source: 'models' };
  }
  // 本地接口未实现 → 降级到远端目录接口（无需鉴权）
  const remote = await fetchModelList(REMOTE_CATALOG_URL, apiKey);
  if (remote) return { models: withAliases(remote, baseagent), source: 'remote' };
  return { models: withAliases(MOCK_CATALOG, baseagent), source: 'mock' };
}

/** claude 系判定：完整 ID 或别名（opus/sonnet/haiku）。 */
function isClaudeFamily(id: string): boolean {
  return /^claude-/.test(id) || ['opus', 'sonnet', 'haiku'].includes(id);
}

/** 单模型详情（现阶段 mock）。 */
export async function getModelInfo(modelId: string, self?: string, ba?: string): Promise<ModelInfo> {
  const cat = await getCatalog(self, ba);
  const entry = cat.models.find(m => m.id === modelId);
  const claudeFamily = isClaudeFamily(modelId);
  // 远端目录把所有模型的 owned_by 标成网关名 'ModelGate'，别名标成 'alias'，
  // 两者都不是真实厂商 → 回退到按 ID 推断。
  const NON_VENDOR = new Set(['alias', 'ModelGate', '']);
  const rawOwner = entry?.owned_by;
  const owner = claudeFamily
    ? 'anthropic'
    : (rawOwner && !NON_VENDOR.has(rawOwner) ? rawOwner : inferOwner(modelId));
  return {
    id: modelId,
    owned_by: owner,
    context_window: claudeFamily ? 200000 : 128000,
    max_output_tokens: 8192,
    pricing: { input_per_mtok: null, output_per_mtok: null, currency: 'USD' },
    modalities: ['text'],
    supports_effort: claudeFamily,
    status: entry ? 'available' : 'unknown',
    mocked: true,
  };
}

function inferOwner(id: string): string {
  if (/^claude-/.test(id)) return 'anthropic';
  if (/^gpt-/.test(id)) return 'openai';
  if (/^gemini-/.test(id)) return 'google';
  if (/^deepseek-/.test(id)) return 'deepseek';
  if (/^kimi-/.test(id)) return 'moonshot';
  if (/^glm-/.test(id)) return 'zhipu';
  if (/^MiniMax-/i.test(id)) return 'minimax';
  return 'unknown';
}
