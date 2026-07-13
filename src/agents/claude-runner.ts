import { query, forkSession as sdkForkSession, getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { atomicReadJson, atomicWriteJson, ensureDir } from '../utils/atomic-write.js';
import { resolveAnthropicConfig } from './baseagent.js';
import type { Config, InteractionRequest } from '../types.js';
import { DEFAULT_PERMISSION_MODE } from '../types.js';
import { renderActionAsText } from '../core/interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from '../core/message/message-utils.js';
import type { PermissionGateway, PermissionDecision } from '../core/permission.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { checkBlacklist, checkReadonly, checkHClassWrite, isEvolclawHandoffReturnCommand, parseEvolclawSendCommand, summarizeToolInput, requestDangerousCommandPermission } from '../core/permission.js';
import { authorizeEcCommand } from '../core/command/ec-command-permission.js';
import { encodePath } from '../utils/cross-platform.js';
import { resolvePaths } from '../paths.js';
import { resolveEffective } from '../config/config-manager.js';
import { resolveClaudeCapabilityRunOptionsForProject } from '../core/capability/capability-manager.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { AgentEvent, ImageData, PermissionContext, PermissionModeInfo, AgentTokenUsage, AgentContextUsage, AgentLastModelCall, AgentModelCall, AgentRunOverrides } from './runner-types.js';
import type { GatewayPricingCache, PriceQuad } from '../stats/price-resolver.js';
import { contextTokensForUsage, usageForContext, numericToken, isClaudeContextUsageModel, isOneMillionContextModel, realContextWindowForModel, autoCompactWindowForModel } from './runner-types.js';
export type {
  AgentContextUsage,
  AgentEvent,
  AgentLastModelCall,
  AgentModelCall,
  AgentRunnerFull,
  AgentRunOverrides,
  AgentRunnerInterface,
  AgentTokenUsage,
  Compactable,
  ImageData,
  ModelSwitcher,
  PermissionContext,
  PermissionController,
  PermissionModeInfo,
  QueryRequest,
} from './runner-types.js';
export { hasCompact, hasModelSwitcher, hasPermissionController } from './runner-types.js';

// ── 模型别名解析 ──
// SDK 内置的别名表可能落后于代理实际可用的最新模型，
// 因此优先从 {baseUrl}/models 动态获取各系列最新版本，失败则使用持久化的最近成功值。
// 已验证可用但尚未出现在 /models 列表中的模型 ID 会被注入候选列表，
// 等列表更新后注入自动变为 no-op。

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'] as const;
type ModelFamily = (typeof MODEL_FAMILIES)[number];
type ModelAliases = Partial<Record<ModelFamily, string>>;

/** 已验证可用但可能尚未出现在 /models 列表中的模型 ID（注入候选） */
const INJECTED_MODELS: string[] = [];

/** 启动默认值：某网关尚无任何成功刷新记录时使用。 */
const BOOTSTRAP_MODEL_ALIASES: Record<ModelFamily, string> = {
  'opus': 'claude-opus-4-8',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
};

const MODEL_ALIAS_TTL_MS = 5 * 60 * 1000; // 5min
const MODEL_ALIAS_STORE_VERSION = 1;
interface AliasCacheEntry { aliases: ModelAliases; ids: string[]; fetchedAt: number; }
interface PersistedAliasEntry { aliases: ModelAliases; updatedAt: number; }
interface PersistedAliasStore {
  $schema_version: number;
  gateways: Record<string, PersistedAliasEntry>;
}
const modelAliasCache = new Map<string, AliasCacheEntry>(); // key: baseUrl
const modelAliasFallbacks = new Map<string, ModelAliases>(); // key: baseUrl，最近一次成功解析值
const modelAliasInFlight = new Set<string>();               // 去重并发刷新
const loadedModelAliasFallbacks = new Set<string>();        // key: store path + gateway hash

function normalizeModelGatewayUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function modelGatewayKey(baseUrl: string): string {
  return crypto.createHash('sha256').update(normalizeModelGatewayUrl(baseUrl)).digest('hex');
}

function modelAliasStorePath(): string {
  return resolvePaths().claudeModelCache;
}

function sanitizeModelAliases(value: unknown): ModelAliases {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const aliases: ModelAliases = {};
  for (const family of MODEL_FAMILIES) {
    const model = (value as Record<string, unknown>)[family];
    if (typeof model !== 'string') continue;
    const pattern = new RegExp(`^claude-${family}-[A-Za-z0-9._-]+$`);
    if (pattern.test(model)) aliases[family] = model;
  }
  return aliases;
}

function readPersistedAliasStore(): PersistedAliasStore {
  try {
    const value = atomicReadJson<unknown>(modelAliasStorePath());
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { $schema_version: MODEL_ALIAS_STORE_VERSION, gateways: {} };
    }
    const raw = value as Record<string, unknown>;
    if (raw.$schema_version !== MODEL_ALIAS_STORE_VERSION || !raw.gateways || typeof raw.gateways !== 'object' || Array.isArray(raw.gateways)) {
      return { $schema_version: MODEL_ALIAS_STORE_VERSION, gateways: {} };
    }
    const gateways: Record<string, PersistedAliasEntry> = {};
    for (const [key, entry] of Object.entries(raw.gateways as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const aliases = sanitizeModelAliases(record.aliases);
      if (Object.keys(aliases).length === 0) continue;
      gateways[key] = {
        aliases,
        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      };
    }
    return { $schema_version: MODEL_ALIAS_STORE_VERSION, gateways };
  } catch (error) {
    logger.warn(`[AgentRunner] Failed to load persisted model aliases: ${error instanceof Error ? error.message : String(error)}`);
    return { $schema_version: MODEL_ALIAS_STORE_VERSION, gateways: {} };
  }
}

function loadPersistedModelAliases(baseUrl: string): void {
  const cacheKey = normalizeModelGatewayUrl(baseUrl);
  const storePath = modelAliasStorePath();
  const gatewayKey = modelGatewayKey(cacheKey);
  const loadKey = `${storePath}\0${gatewayKey}`;
  if (loadedModelAliasFallbacks.has(loadKey)) return;
  loadedModelAliasFallbacks.add(loadKey);
  const persisted = readPersistedAliasStore().gateways[gatewayKey];
  if (!persisted) return;
  modelAliasFallbacks.set(cacheKey, persisted.aliases);
  logger.info(`[AgentRunner] Loaded persisted model aliases: ${JSON.stringify(persisted.aliases)}`);
}

function persistModelAliases(baseUrl: string, aliases: ModelAliases, updatedAt: number): void {
  try {
    const store = readPersistedAliasStore();
    store.gateways[modelGatewayKey(baseUrl)] = { aliases, updatedAt };
    atomicWriteJson(modelAliasStorePath(), store);
  } catch (error) {
    logger.warn(`[AgentRunner] Failed to persist model aliases: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 网关价格缓存（从 /v1/models 的 pricing/effective_pricing 提取）─────────────
// 与别名刷新同范式：按 baseUrl 缓存，1h TTL，stale-while-revalidate（缺失/过期时
// fire-and-forget 触发刷新，本轮先用旧值或回退，不阻塞查询）。
const GATEWAY_PRICING_TTL_MS = 60 * 60 * 1000; // 1h
interface PricingCacheEntry { cache: GatewayPricingCache; fetchedAt: number; }
const gatewayPricingCache = new Map<string, PricingCacheEntry>(); // key: baseUrl
const gatewayPricingInFlight = new Set<string>();                 // 去重并发刷新

/** 把 /v1/models 单个 model 的价格对象转为 PriceQuad（与 gateway-control 的 apiPricingToQuad 等价）。
 *  单位假设：接口价与 model-prices.jsonl 同口径（USD per 1M token），不做换算。 */
function apiPricingToQuad(p: any): PriceQuad | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const quad: PriceQuad = {
    input: n(p.input),
    output: n(p.output),
    cache_read: n(p.cache_read),
    cache_write: n(p.cache_write),
  };
  // 全空则视为无价
  if (quad.input === undefined && quad.output === undefined
    && quad.cache_read === undefined && quad.cache_write === undefined) return undefined;
  return quad;
}

/** 拉取网关 /v1/models 的官方价(pricing) + 网关价(effective_pricing)，写入 gatewayPricingCache。
 *  失败静默——保持回退到本地价表 / official。 */
async function refreshGatewayPricing(baseUrl: string, apiKey?: string): Promise<void> {
  if (gatewayPricingInFlight.has(baseUrl)) return;
  gatewayPricingInFlight.add(baseUrl);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(timer);
    if (!resp.ok) return;
    const json: any = await resp.json();
    const arr: any[] = Array.isArray(json?.data) ? json.data
                     : Array.isArray(json?.models) ? json.models : [];
    const official = new Map<string, PriceQuad>();
    const gateway = new Map<string, PriceQuad>();
    for (const m of arr) {
      const id = typeof m === 'string' ? m : (m?.id || m?.name || m?.model);
      if (!id || typeof m !== 'object') continue;
      const off = apiPricingToQuad(m.pricing);
      if (off) official.set(id, off);
      const gw = apiPricingToQuad(m.effective_pricing);
      if (gw) gateway.set(id, gw);
    }
    // 汇率：接口 usd_to_cny，缺失则留空（计费层默认用 7）
    const usdToCny = (typeof json?.usd_to_cny === 'number' && json.usd_to_cny > 0) ? json.usd_to_cny : undefined;
    if (official.size > 0 || gateway.size > 0) {
      gatewayPricingCache.set(baseUrl, { cache: { official, gateway, usdToCny }, fetchedAt: Date.now() });
      logger.info(`[AgentRunner] Refreshed gateway pricing from ${url}: official=${official.size} gateway=${gateway.size} usd_to_cny=${usdToCny ?? '(default 7)'}`);
    }
  } catch {
    // 网络/解析失败：保持回退，不打断查询
  } finally {
    gatewayPricingInFlight.delete(baseUrl);
  }
}

/** 从模型 ID 列表中提取各 claude 系列的最新版本（按 major.minor 取最高，minor 可省略） */
function deriveAliasesFromModelIds(ids: string[]): ModelAliases {
  // 注入已验证可用的模型（如果列表中已有则去重无影响）
  const allIds = [...new Set([...ids, ...INJECTED_MODELS])];
  const best: Record<string, { id: string; major: number; minor: number }> = {};
  for (const id of allIds) {
    const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
    if (!m) continue;
    const [, family, majorStr, minorStr] = m;
    const major = parseInt(majorStr, 10);
    const minor = minorStr ? parseInt(minorStr, 10) : 0;
    const cur = best[family];
    if (!cur || major > cur.major || (major === cur.major && minor > cur.minor)) {
      best[family] = { id, major, minor };
    }
  }
  const aliases: ModelAliases = {};
  for (const family of MODEL_FAMILIES) {
    const info = best[family];
    if (info) aliases[family] = info.id;
  }
  return aliases;
}

/** 异步刷新某 baseUrl 的别名缓存（失败静默，不抛出） */
async function refreshModelAliases(baseUrl: string, apiKey?: string): Promise<void> {
  const cacheKey = normalizeModelGatewayUrl(baseUrl);
  if (modelAliasInFlight.has(cacheKey)) return;
  modelAliasInFlight.add(cacheKey);
  loadPersistedModelAliases(cacheKey);
  try {
    const url = `${cacheKey}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    clearTimeout(timer);
    if (!resp.ok) return;
    const json: any = await resp.json();
    const ids: string[] = Array.isArray(json?.data)
      ? json.data.map((m: any) => m?.id).filter((x: any): x is string => typeof x === 'string')
      : [];
    const aliases = deriveAliasesFromModelIds(ids);
    if (ids.length > 0 || Object.keys(aliases).length > 0) {
      const updatedAt = Date.now();
      modelAliasCache.set(cacheKey, { aliases, ids, fetchedAt: updatedAt });
      if (Object.keys(aliases).length > 0) {
        const previousAliases = modelAliasFallbacks.get(cacheKey) || {};
        const latestAliases = { ...previousAliases, ...aliases };
        modelAliasFallbacks.set(cacheKey, latestAliases);
        persistModelAliases(cacheKey, latestAliases, updatedAt);
      }
      logger.info(`[AgentRunner] Refreshed models from ${url}: ${ids.length} ids, aliases ${JSON.stringify(aliases)}`);
    }
  } catch {
    // 网络/解析失败：保留该网关最近一次成功结果，不打断查询
  } finally {
    modelAliasInFlight.delete(cacheKey);
  }
}

/** 将短别名展开为完整 model ID，已是完整 ID 则原样返回 */
function resolveModelAlias(model: string, baseUrl?: string): string {
  // 非短别名（已经是完整 ID）直接返回
  if (!MODEL_FAMILIES.includes(model as any)) return model;
  const family = model as ModelFamily;

  // 优先使用动态缓存
  if (baseUrl) {
    const cacheKey = normalizeModelGatewayUrl(baseUrl);
    loadPersistedModelAliases(cacheKey);
    const cached = modelAliasCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt < MODEL_ALIAS_TTL_MS)) {
      return cached.aliases[family] || modelAliasFallbacks.get(cacheKey)?.[family] || BOOTSTRAP_MODEL_ALIASES[family];
    }
    return modelAliasFallbacks.get(cacheKey)?.[family] || BOOTSTRAP_MODEL_ALIASES[family];
  }

  return BOOTSTRAP_MODEL_ALIASES[family];
}

/**
 * 为支持 1M 上下文的模型追加 `[1m]` 后缀——仅在交给 SDK query() 时调用。
 * 目录与校验层始终使用不带后缀的基础 ID，避免与网关 /models 返回值（无 `[1m]`）冲突。
 */
function applyContextWindow(modelId: string): string {
  if (/\[1m\]$/.test(modelId)) return modelId; // 已带后缀
  if (isOneMillionContextModel(modelId)) return `${modelId}[1m]`;
  return modelId;
}

/** 解析别名 + 追加 1M 后缀，得到最终交给 SDK 的 model 串。 */
function resolveSdkModel(model: string, baseUrl?: string): string {
  return applyContextWindow(resolveModelAlias(model, baseUrl));
}

// ── SDK 消息流（Claude Agent SDK 专有格式）──

interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;
  };
  parent_tool_use_id: null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageData[]): void {
    let content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        >;

    if (images && images.length > 0) {
      logger.debug('[MessageStream] Creating multimodal message with', images.length, 'images');
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType || 'image/png',
            data: img.data,
          },
        })),
      ];
    } else {
      content = text;
    }

    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };

    this.queue.push(message);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}


export class AgentRunner {
  readonly name: string = 'claude';
  readonly capabilities = { clear: true, compact: true, fork: true, askUserQuestion: true, planApproval: true, fileRewind: 'checkpoint' as const };
  private apiKey: string;
  private model: string;
  private effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  private permissionMode: string = DEFAULT_PERMISSION_MODE;
  private baseUrl?: string;
  private config?: Config;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeMessageStreams = new Map<string, MessageStream>();
  private interruptFns = new Map<string, () => Promise<void>>();
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContexts = new Map<string, PermissionContext>();
  private currentEvolclawSessionId?: string;
  private claudeExecutablePath?: string;
  /** 每个 session 最近的子进程 stderr 行（环形缓冲），用于子进程崩溃时还原真正原因 */
  private recentStderr = new Map<string, string[]>();
  private static readonly STDERR_BUFFER_MAX = 80;

  constructor(
    apiKey: string,
    model?: string,
    onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void,
    baseUrl?: string,
    config?: Config
  ) {
    this.apiKey = apiKey;
    this.model = model || 'sonnet';
    this.effort = undefined;
    this.baseUrl = baseUrl;
    this.config = config;
    this.onSessionIdUpdate = onSessionIdUpdate;
    if (config) {
      const anthropic = resolveAnthropicConfig(config);
      this.claudeExecutablePath = anthropic.pathToClaudeCodeExecutable;
    }
  }

  private getAgentEnv(runtimeEnv?: Record<string, string>): Record<string, string | undefined> {
    // SDK 0.3.x 起，CLI 在以 root 运行时会拒绝 --dangerously-skip-permissions
    // （bypassPermissions 模式映射而来），报错 "cannot be used with root/sudo privileges"
    // 并以 code 1 退出。IS_SANDBOX=1 是 CLI 提供的 root 守卫豁免开关。
    // 仅在以 root 运行时注入，非 root 部署行为不变。
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    return {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      PATH: process.env.PATH,
      DISABLE_AUTOUPDATER: '1',
      ...(isRoot ? { IS_SANDBOX: '1' } : {}),
      ...(this.baseUrl ? { ANTHROPIC_BASE_URL: this.baseUrl } : {}),
      ...(this.currentEvolclawSessionId ? { EVOLCLAW_SESSION_ID: this.currentEvolclawSessionId } : {}),
      ...(runtimeEnv ?? {}),
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  /** 返回当前网关 /v1/models 的价格缓存（1h TTL，stale-while-revalidate）。
   *  缺失/过期时 fire-and-forget 触发刷新，本轮先返回旧值或 undefined（回退本地价表）。 */
  getGatewayPricing(): GatewayPricingCache | undefined {
    if (!this.baseUrl) return undefined;
    const entry = gatewayPricingCache.get(this.baseUrl);
    if (!entry || Date.now() - entry.fetchedAt > GATEWAY_PRICING_TTL_MS) {
      refreshGatewayPricing(this.baseUrl, this.apiKey); // 不 await，stale-while-revalidate
    }
    return entry?.cache;
  }

  private async resolveCapabilityRunOptions(projectPath: string): Promise<Record<string, unknown>> {
    const claudeConfig = this.config?.agents?.claude;
    let agentConfig = claudeConfig?.evolclawAgentConfig;
    if (claudeConfig?.evolclawAgentAid) {
      try {
        agentConfig = resolveEffective({ self: claudeConfig.evolclawAgentAid }, { cache: true });
      } catch {}
    }
    return await resolveClaudeCapabilityRunOptionsForProject(agentConfig, projectPath, 'claude');
  }

  async listModels(): Promise<string[]> {
    if (this.baseUrl) {
      const cacheKey = normalizeModelGatewayUrl(this.baseUrl);
      loadPersistedModelAliases(cacheKey);
      let cached = modelAliasCache.get(cacheKey);
      const stale = !cached || (Date.now() - cached.fetchedAt > MODEL_ALIAS_TTL_MS);
      // 缓存为空（首次打开）→ 等待刷新；缓存仅过期 → 后台刷新不阻塞
      if (!cached) {
        await refreshModelAliases(this.baseUrl, this.apiKey);
        cached = modelAliasCache.get(cacheKey);
      } else if (stale) {
        refreshModelAliases(this.baseUrl, this.apiKey);
      }
      // 有缓存时返回网关 /models 的全量原始 ID
      if (cached && cached.ids.length > 0) return cached.ids;
    }
    // 无 baseUrl / 刷新超时或失败 → 回退短别名
    const fallback = this.baseUrl ? modelAliasFallbacks.get(normalizeModelGatewayUrl(this.baseUrl)) : undefined;
    return Object.values({ ...BOOTSTRAP_MODEL_ALIASES, ...fallback });
  }

  /** 将短别名解析为当前代理实际使用的完整 model ID（仅用于展示，不改变持久化值） */
  resolveModelId(model: string): string {
    return resolveModelAlias(model, this.baseUrl);
  }

  setEffort(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined): void {
    this.effort = effort;
  }

  getEffort(): string | undefined {
    return this.effort;
  }

  // ── PermissionController 接口 ──

  setMode(mode: string): void {
    this.permissionMode = mode;
  }

  getMode(): string {
    return this.permissionMode;
  }

  listModes(): PermissionModeInfo[] {
    // readonly 模式暂时禁用：与 proactive 模式系统提示词存在语义冲突，
    // 且 READONLY_WRITE_PATTERNS 未覆盖 evolclaw ctl send/file，契约不稳固
    return [
      { key: 'auto', nameZh: '自动', description: 'AI 分类器自动判断', available: true },
      { key: 'bypass', nameZh: '放行', description: '跳过 AI 判断，危险操作仍需确认', available: true },
      { key: 'request', nameZh: '审批', description: '部分自动，部分询问', available: true },
      { key: 'edit', nameZh: '编辑', description: '自动接受编辑，其他询问', available: true },
      { key: 'plan', nameZh: '规划', description: '只规划不执行', available: true },
      { key: 'noask', nameZh: '静默', description: '未批准则拒绝', available: true },
    ];
  }

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  setSendPrompt(fn: (text: string) => Promise<void>): void {
    this.sendPromptFn = fn;
  }

  setPermissionContext(sessionId: string, context: PermissionContext): void {
    this.permissionContexts.set(sessionId, context);
  }

  private toSdkPermissionMode(mode?: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
    const map: Record<string, 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'> = {
      'auto': 'auto',         // AI 分类器自动判断
      'bypass': 'bypassPermissions',  // 跳过 SDK 分类器，canUseTool/Hook 仍保留安全检查
      'request': 'default',   // 部分自动，部分询问
      'edit': 'acceptEdits',
      'plan': 'plan',
      'noask': 'dontAsk',
      'readonly': 'default',
    };
    return map[mode ?? this.permissionMode] || 'auto';
  }

  // ── Compactable 接口 ──

  async compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    return this.compactSession(sessionId, agentSessionId, projectPath);
  }

  private syncFromUserSettings(): void {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return;

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      // agent config 显式配置优先，不被 settings.json 覆盖
      const configModel = this.config?.agents?.claude?.model;
      if (!configModel && settings.model && settings.model !== this.model) {
        logger.info(`[AgentRunner] Synced model from ~/.claude/settings.json: ${settings.model}`);
        this.model = settings.model;
      }

      const configEffort = this.config?.agents?.claude?.effort;
      if (!configEffort) {
        const newEffort = settings.effortLevel || undefined;
        if (newEffort !== this.effort) {
          logger.info(`[AgentRunner] Synced effort from ~/.claude/settings.json: ${newEffort ?? 'auto'}`);
          this.effort = newEffort;
        }
      }
    } catch (error) {
      logger.debug(`[AgentRunner] Failed to sync from ~/.claude/settings.json:`, error);
    }
  }

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  /**
   * 处理 AskUserQuestion 工具调用：将 SDK 问题转换为飞书 action 卡片，逐个收集用户答案
   * SDK 期望返回 updatedInput 中包含 answers 字段：{ [questionText]: selectedLabel | selectedLabel[] }
   */
  private async handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; [key: string]: any }
  ): Promise<any> {
    const questions = input.questions as Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;

    // 没有交互上下文（无渠道适配器），回退到纯文本
    const permCtx = this.permissionContexts.get(sessionId);
    if (!permCtx?.adapter || !permCtx?.channelId) {
      return this.handleAskUserQuestionFallback(sessionId, input, questions);
    }
    const adapterHasInteractionPath = !!permCtx.adapter.send;
    if (!adapterHasInteractionPath) {
      return this.handleAskUserQuestionFallback(sessionId, input, questions);
    }

    // 立即暂停 idle 监控，不等卡片发完再 register
    permCtx.interactionRouter?.markWaiting(sessionId);
    let waitMarked = true;

    const answers: Record<string, string | string[]> = {};

    const sendPrompt = permCtx.adapter && permCtx.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cardTitle = q.header ? `💬 ${q.header}` : `💬 问题 ${i + 1}/${questions.length}`;

      let interaction: InteractionRequest;

      if (q.multiSelect) {
        // 多选：使用 checkers + form 提交（JSON 2.0 CardKit 路径）
        interaction = {
          type: 'interaction',
          id: requestId,
          kind: {
            kind: 'action',
            title: cardTitle,
            body: q.question,
            checkers: q.options.map(opt => ({
              key: opt.label,
              label: opt.label,
              description: opt.description,
            })),
            buttons: [
              { key: 'submit', label: '✅ 确认选择', style: 'primary' as const },
            ],
            allowCustomInput: true,
          },
          channelId: permCtx.channelId,
          sessionId,
        };
      } else {
        // 单选：保持按钮模式
        const bodyLines = [q.question];
        if (q.options.some(opt => opt.description)) {
          bodyLines.push('');
          q.options.forEach((opt, idx) => {
            bodyLines.push(`${idx + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`);
          });
        }
        interaction = {
          type: 'interaction',
          id: requestId,
          kind: {
            kind: 'action',
            title: cardTitle,
            body: bodyLines.join('\n'),
            buttons: q.options.map(opt => ({
              key: opt.label,
              label: opt.label,
              style: 'default' as const,
            })),
            allowCustomInput: true,
          },
          channelId: permCtx.channelId,
          sessionId,
        };
      }

      let cardSent = false;
      try {
        await permCtx.flushPending?.();
        const envelope = buildEnvelope({
          taskId: permCtx.taskId,
          channel: permCtx.channel ?? permCtx.adapter.channelName,
          channelId: permCtx.channelId,
          agentName: permCtx.agentName,
          chatmode: permCtx.chatmode,
          replyContext: permCtx.replyContext,
        });
        const optionLines = q.options.map((o, idx) => `  ${idx + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
        const fallbackText = `💬 ${q.header || q.question}\n${q.header ? q.question + '\n' : ''}${optionLines}`;
        const result = await sendInteractionPayload(
          permCtx.adapter,
          envelope,
          interaction,
          fallbackText,
          permCtx.replyContext,
        );
        cardSent = !!result;
      } catch (err) {
        logger.warn(`[AgentRunner] AskUserQuestion card send failed for q${i}:`, err);
      }

      if (!cardSent) {
        await permCtx.flushPending?.();
        const firstLabel = q.options[0]?.label || '';
        answers[q.question] = q.multiSelect ? [firstLabel] : firstLabel;
        if (sendPrompt) {
          const optText = q.options.map((o, idx) => `  ${idx + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
          await sendPrompt(`💬 ${q.header || q.question}\n${q.header ? q.question + '\n' : ''}${optText}\n  → 自动选择：${firstLabel}`);
        }
        continue;
      }

      // 等待用户交互：先 register 接管计数，再 unmark 占位，消除空窗期
      // （unmark 必须在 register 之后，否则计数短暂降为 0 触发 onWaitEnd→resume，idle 时钟被重置）
      const answer = await new Promise<string | string[] | null>((resolve) => {
        permCtx?.interactionRouter?.register(requestId, sessionId, (action: string, values?: Record<string, any>) => {
          if (action === 'cancel') {
            resolve(null);
          } else if (action === '_custom_input') {
            // 用户通过追加的 input 提交了自定义文本
            const customText = values?.custom_text;
            resolve(typeof customText === 'string' && customText.trim() ? customText.trim() : null);
          } else if (action === '_show_input') {
            // 无内嵌输入框的渠道（如 AUN）：点「手动输入」→ 拦截下一条消息作为答案。
            // router handler 已被消费（decPending 已触发），重新 markWaiting 保持 idle 暂停。
            if (permCtx?.interceptNextMessage) {
              permCtx.interactionRouter?.markWaiting(sessionId);
              sendPrompt?.('✏️ 请直接发送你的自定义回复').catch(() => {});
              permCtx.interceptNextMessage(sessionId, (msg) => {
                permCtx.interactionRouter?.unmarkWaiting(sessionId);
                const text = (msg.content || '').trim();
                resolve(text || null);
              });
            } else {
              resolve(null);
            }
          } else if (action === 'submit' && q.multiSelect && values) {
            // checker 多选提交：从 form_value 收集 checked 选项
            const selected: string[] = [];
            q.options.forEach((opt, idx) => {
              if (values[`opt_${idx}`] === true) {
                selected.push(opt.label);
              }
            });
            resolve(selected.length > 0 ? selected : null);
          } else {
            resolve(action);
          }
        });
        // register 已接管计数（计数 +1），现在才能安全释放 markWaiting 占位（计数 -1），避免空窗
        if (waitMarked) {
          permCtx?.interactionRouter?.unmarkWaiting(sessionId);
          waitMarked = false;
        }
      });

      if (answer === null) {
        const firstLabel = q.options[0]?.label || '';
        answers[q.question] = q.multiSelect ? [firstLabel] : firstLabel;
      } else {
        answers[q.question] = answer;
      }
    }

    if (waitMarked) {
      permCtx?.interactionRouter?.unmarkWaiting(sessionId);
    }
    const updatedInput = { ...input, answers };
    return { behavior: 'allow' as const, updatedInput, decisionClassification: 'user_temporary' as const };
  }

  /**
   * AskUserQuestion 纯文本 fallback：发送选项列表，等待用户通过 /ask 命令选择
   * 注册到 interactionRouter，用户回复 /ask 1 或 /ask 自定义内容
   */
  private async handleAskUserQuestionFallback(
    sessionId: string,
    input: Record<string, unknown>,
    questions: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>
  ): Promise<any> {
    const permCtx = this.permissionContexts.get(sessionId);
    const sendPrompt = permCtx?.adapter && permCtx?.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    const answers: Record<string, string> = {};

    if (questions?.length) {
      for (const q of questions) {
        if (sendPrompt && permCtx?.interactionRouter) {
          const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId: permCtx.channelId || '',
            sessionId,
            initiatorId: permCtx.userId,
            kind: {
              kind: 'action',
              title: `💬 ${q.question}`,
              body: q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'),
              buttons: q.options.map((o, i) => ({ key: `opt-${i}`, label: o.label })),
            },
            fallback: {
              command: 'ask',
              buttonArgMap: Object.fromEntries(q.options.map((_, i) => [`opt-${i}`, String(i + 1)])),
              acceptFreeText: true,
              freeTextHint: '或回复 /ask <自定义内容>',
            },
          };
          await sendPrompt(renderActionAsText(interaction));
          const answer = await new Promise<string>((resolve) => {
            permCtx.interactionRouter!.register(requestId, sessionId, (action: string) => {
              const num = parseInt(action.trim(), 10);
              if (num >= 1 && num <= q.options.length) {
                resolve(q.options[num - 1].label);
              } else {
                resolve(action.trim());
              }
            }, { initiatorId: permCtx.userId, fallbackCommand: 'ask' });
          });
          answers[q.question] = answer;
        } else {
          const firstLabel = q.options[0]?.label || '';
          answers[q.question] = firstLabel;
          if (sendPrompt) {
            const optText = q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
            await sendPrompt(`💬 ${q.question}\n${optText}\n\n  → 自动选择：${firstLabel}`);
          }
        }
      }
    }

    const updatedInput = { ...input, answers };
    return { behavior: 'allow' as const, updatedInput, decisionClassification: 'user_temporary' as const };
  }

  /**
   * 处理 ExitPlanMode 工具调用：plan mode 审批，等待用户批准后才继续执行
   */
  private async handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; [key: string]: any }
  ): Promise<any> {
    const permCtx = this.permissionContexts.get(sessionId);
    const sendPrompt = permCtx?.adapter && permCtx?.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    // 无任何交互能力，直接 allow
    if (!permCtx?.channelId || !sendPrompt) {
      return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const };
    }

    // 立即暂停 idle 监控，不等卡片发完再 register
    permCtx.interactionRouter?.markWaiting(sessionId);

    // 尝试发送交互卡片
    let cardSent = false;
    if (permCtx.adapter?.send) {
      // 发送计划内容：找 plans 目录中最新修改的 .md 文件
      if (sendPrompt) {
        try {
          const plansDir = path.join(process.env.HOME || '/root', '.claude', 'plans');
          const files = fs.readdirSync(plansDir)
            .filter((f: string) => f.endsWith('.md'))
            .map((f: string) => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
            .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
          if (files.length > 0) {
            const planContent = fs.readFileSync(path.join(plansDir, files[0].name), 'utf-8');
            if (planContent.trim()) {
              await sendPrompt(`📋 **计划内容**\n\n${planContent}`);
            }
          }
        } catch {
          // 读取失败不影响后续审批流程
        }
      }

      const requestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: requestId,
        kind: {
          kind: 'action',
          title: '📋 计划审批',
          body: 'AI 已完成规划，等待审批。\n请查看以上计划内容后决定。',
          buttons: [
            { key: 'approve', label: '✅ 批准执行', style: 'primary' },
            { key: 'reject', label: '❌ 拒绝', style: 'danger' },
          ],
          allowCustomInput: true,
        },
        channelId: permCtx.channelId,
        sessionId,
        initiatorId: permCtx.userId,
        fallback: {
          command: 'ask',
          buttonArgMap: { approve: '1', reject: '2' },
        },
      };

      try {
        await permCtx.flushPending?.();
        const envelope = buildEnvelope({
          taskId: permCtx.taskId,
          channel: permCtx.channel ?? permCtx.adapter.channelName,
          channelId: permCtx.channelId,
          agentName: permCtx.agentName,
          chatmode: permCtx.chatmode,
          replyContext: permCtx.replyContext,
        });
        const fallbackText = '📋 计划审批：AI 已完成规划，等待审批。\n回复 /ask 1 批准 / /ask 2 拒绝';
        const result = await sendInteractionPayload(
          permCtx.adapter,
          envelope,
          interaction,
          fallbackText,
          permCtx.replyContext,
        );
        cardSent = !!result;
      } catch (err) {
        logger.warn('[AgentRunner] ExitPlanMode card send failed:', err);
      }

      if (cardSent) {
        permCtx.interactionRouter?.unmarkWaiting(sessionId);
        return new Promise((resolve) => {
          permCtx.interactionRouter?.register(requestId, sessionId, (action: string, values?: Record<string, any>) => {
            const trimmed = action.trim();
            if (trimmed === '_custom_input') {
              const feedback = typeof values?.custom_text === 'string' ? values.custom_text.trim() : '';
              resolve({ behavior: 'deny' as const, message: feedback || '用户提交了反馈', decisionClassification: 'user_reject' as const });
            } else if (trimmed === '_show_input') {
              // 无内嵌输入框的渠道（如 AUN）：点「手动输入」→ 拦截下一条消息作为反馈。
              if (permCtx.interceptNextMessage) {
                permCtx.interactionRouter?.markWaiting(sessionId);
                sendPrompt?.('✏️ 请直接发送你的反馈意见').catch(() => {});
                permCtx.interceptNextMessage(sessionId, (msg) => {
                  permCtx.interactionRouter?.unmarkWaiting(sessionId);
                  const feedback = (msg.content || '').trim();
                  resolve({ behavior: 'deny' as const, message: feedback || '用户提交了反馈', decisionClassification: 'user_reject' as const });
                });
              } else {
                resolve({ behavior: 'deny' as const, message: '用户提交了反馈', decisionClassification: 'user_reject' as const });
              }
            } else if (trimmed === '2' || trimmed.toLowerCase() === 'reject' || trimmed === '拒绝') {
              resolve({ behavior: 'deny' as const, message: '用户拒绝了计划', decisionClassification: 'user_reject' as const });
            } else {
              resolve({ behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const });
            }
          }, { initiatorId: permCtx.userId, fallbackCommand: 'ask' });
        });
      }
    }

    // 文本 fallback：注册到 interactionRouter，等待用户 /ask 回复
    if (permCtx.interactionRouter) {
      const fallbackRequestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fallbackInteraction: InteractionRequest = {
        type: 'interaction',
        id: fallbackRequestId,
        channelId: permCtx.channelId || '',
        sessionId,
        initiatorId: permCtx.userId,
        kind: {
          kind: 'action',
          title: '📋 计划审批',
          body: 'AI 已完成规划，等待审批。',
          buttons: [
            { key: 'approve', label: '✅ 批准执行', style: 'primary' },
            { key: 'reject', label: '❌ 拒绝', style: 'danger' },
          ],
        },
        fallback: {
          command: 'ask',
          buttonArgMap: { approve: '1', reject: '2' },
        },
      };
      await permCtx.flushPending?.();
      await sendPrompt(renderActionAsText(fallbackInteraction));
      permCtx.interactionRouter.unmarkWaiting(sessionId);
      return new Promise((resolve) => {
        permCtx.interactionRouter!.register(fallbackRequestId, sessionId, (action: string) => {
          const trimmed = action.trim();
          if (trimmed === '2' || trimmed.toLowerCase() === 'reject' || trimmed === '拒绝') {
            resolve({ behavior: 'deny' as const, message: '用户拒绝了计划', decisionClassification: 'user_reject' as const });
          } else {
            resolve({ behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const });
          }
        }, { initiatorId: permCtx.userId, fallbackCommand: 'ask' });
      });
    }

    // 无交互能力，发提示后直接 allow
    (permCtx as any)?.interactionRouter?.unmarkWaiting(sessionId);
    await permCtx.flushPending?.();
    await sendPrompt('📋 计划审批\nAI 已完成规划，自动批准执行。');
    return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const };
  }

  /**
   * SDK 原始事件 → 标准 AgentEvent 转换
   * 所有 SDK 特有的事件类型引用封装在此方法内
   */
  private async *transformStream(sdkStream: AsyncIterable<any>, sessionId: string, callModel?: string, callEffort?: string, sdkModel?: string): AsyncGenerator<AgentEvent> {
    let lastSessionId: string | undefined;
    // tool_use_id → tool_name 映射，用于从 SDKUserMessage 的 tool_result 块中还原工具名
    const toolUseNames = new Map<string, string>();
    let turnCount = 0;
    const seenMessageIds = new Set<string>();
    let lastModelCall: AgentLastModelCall | undefined;
    // 流式收集各次大模型调用（fallback：SDK iterations 为空时使用）
    const collectedCalls: AgentModelCall[] = [];

    try {
      for await (const event of sdkStream) {
      // 提取 session_id（任意 SDK 事件都可能携带）
      if (event.session_id && event.session_id !== lastSessionId) {
        lastSessionId = event.session_id;
        this.updateSessionId(sessionId, event.session_id);
        yield { type: 'session_id', sessionId: event.session_id };
      }

      if (event.type === 'stream_event') {
        const streamEvent = event.event;
        if (streamEvent?.type === 'message_start' && streamEvent.message?.usage) {
          lastModelCall = {
            uuid: event.uuid,
            model: streamEvent.message.model,
            tokenUsage: streamEvent.message.usage,
          };
          // 流式收集：每个 message_start = 一次新的大模型调用
          collectedCalls.push({
            call_index: collectedCalls.length,
            model: streamEvent.message.model ?? callModel ?? this.model,
            request_id: (event as any).request_id,
            tokenUsage: { ...streamEvent.message.usage },
          });
        } else if (streamEvent?.type === 'message_delta' && streamEvent.usage) {
          lastModelCall = {
            ...lastModelCall,
            uuid: lastModelCall?.uuid ?? event.uuid,
            tokenUsage: {
              ...(lastModelCall?.tokenUsage ?? {}),
              ...streamEvent.usage,
            },
          };
          // 将 message_delta 的 usage 合并进当前(最后一次)收集的调用
          const last = collectedCalls[collectedCalls.length - 1];
          if (last) last.tokenUsage = { ...last.tokenUsage, ...streamEvent.usage };
        }
        continue;
      }

      // system: compact_boundary → compact
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        yield {
          type: 'compact',
          preTokens: event.compact_metadata?.pre_tokens || 0,
          postTokens: event.compact_metadata?.post_tokens,
          durationMs: event.compact_metadata?.duration_ms,
        };
      }

      // system: task_progress → task_progress
      if (event.type === 'system' && event.subtype === 'task_progress') {
        yield {
          type: 'task_progress',
          summary: event.summary,
          toolUses: event.tool_uses,
          durationMs: event.duration_ms,
        };
      }

      // system: session_state_changed → state_changed
      if (event.type === 'system' && event.subtype === 'session_state_changed') {
        yield { type: 'state_changed', state: event.state };
      }

      // assistant: 提取 tool_use 和文本（仅无 text_delta 时提取文本）
      if (event.type === 'assistant' && event.message?.content) {
        const msgId = event.message.id;
        if (!msgId || !seenMessageIds.has(msgId)) {
          if (msgId) seenMessageIds.add(msgId);
          turnCount++;
        }
        if (event.message.usage) {
          lastModelCall = {
            ...lastModelCall,
            messageId: event.message.id,
            requestId: event.request_id,
            model: event.message.model,
            tokenUsage: {
              ...event.message.usage,
              ...(lastModelCall?.tokenUsage ?? {}),
            },
          };
        }
        // 统计本轮 base agent 全部输出字符数（text + tool_use input）
        let turnOutputChars = 0;
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            const inputStr = typeof content.input === 'string' ? content.input : JSON.stringify(content.input || '');
            turnOutputChars += inputStr.length;
          } else if (content.type === 'text' && content.text) {
            turnOutputChars += content.text.length;
          }
        }
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            if (content.id) toolUseNames.set(content.id, content.name);
            yield { type: 'tool_use', name: content.name, input: content.input, callId: content.id, turn: turnCount, outputTokens: turnOutputChars };
          } else if (content.type === 'text' && content.text) {
            yield { type: 'text', text: content.text, outputTokens: turnOutputChars, turn: turnCount };
          }
        }
      }

      // user: 提取 tool_result 块（SDK 将工具结果嵌套在 SDKUserMessage 中）
      if (event.type === 'user' && event.message?.content) {
        const contentArray = Array.isArray(event.message.content) ? event.message.content : [];
        for (const block of contentArray) {
          if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
            const toolName = toolUseNames.get(block.tool_use_id) || '';
            const resultContent = typeof block.content === 'string'
              ? block.content
              : block.content != null ? JSON.stringify(block.content) : '';
            yield {
              type: 'tool_result',
              name: toolName,
              result: resultContent,
              isError: block.is_error === true,
              error: block.is_error === true ? resultContent : undefined,
              callId: block.tool_use_id,
            };
          }
        }
      }

      // result → complete（含 permission_denials 提取）
      if (event.type === 'result') {
        // 先发出被拒绝的权限事件
        if (Array.isArray(event.permission_denials)) {
          for (const denial of event.permission_denials) {
            yield {
              type: 'tool_result',
              name: denial.tool_name || '',
              result: '',
              isError: true,
              error: `权限被拒绝: ${denial.tool_name}`,
            };
          }
        }

        // 剥离 SDK result 中混入的 <thinking>...</thinking> 块
        const cleanResult = typeof event.result === 'string'
          ? event.result.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim()
          : event.result;

        // 从 usage 求当前上下文占用。
        // Claude：input_tokens 是净输入（不含 cache），三项求和 = 实际上下文长度。
        // 非 Claude（DeepSeek/OpenAI 兼容）：cache_read 是服务端 KV cache 不占上下文窗口，
        // input_tokens 本身就是完整的上下文输入量。
        const u = event.usage as AgentTokenUsage | undefined;
        const effectiveModel = callModel ?? this.model;
        const isClaudeModel = isClaudeContextUsageModel(effectiveModel);
        const totalTokens = contextTokensForUsage(u, !!isClaudeModel);
        const contextWindowTokens = realContextWindowForModel(sdkModel);
        const autoCompactTokens   = autoCompactWindowForModel(sdkModel);
        const contextUsage = totalTokens > 0 ? {
          totalTokens,
          maxTokens: contextWindowTokens,
          percentage: Math.round((totalTokens / contextWindowTokens) * 100),
          autoCompactTokens,
          model: callModel ?? this.model,
          effort: callEffort ?? this.effort,
        } : undefined;
        if (lastModelCall?.tokenUsage) {
          const lastUsageForContext = usageForContext(lastModelCall.tokenUsage);
          const lastTotalTokens = contextTokensForUsage(lastUsageForContext, !!isClaudeModel);
          lastModelCall = {
            ...lastModelCall,
            contextUsage: lastTotalTokens > 0 ? {
              totalTokens: lastTotalTokens,
              maxTokens: contextWindowTokens,
              percentage: Math.round((lastTotalTokens / contextWindowTokens) * 100),
              autoCompactTokens,
              model: callModel ?? this.model,
              effort: callEffort ?? this.effort,
            } : undefined,
          };
        }

        const contextUsageForCall = (usage: AgentTokenUsage): AgentContextUsage | undefined => {
          const callTotalTokens = contextTokensForUsage(usageForContext(usage), !!isClaudeModel);
          return callTotalTokens > 0 ? {
            totalTokens: callTotalTokens,
            maxTokens: contextWindowTokens,
            percentage: Math.round((callTotalTokens / contextWindowTokens) * 100),
            autoCompactTokens,
            model: callModel ?? this.model,
            effort: callEffort ?? this.effort,
          } : undefined;
        };

        // 组装 modelCalls：优先 SDK iterations，fallback 流式收集，兜底降级单行。
        const callModel_ = callModel ?? this.model;
        let modelCalls: AgentModelCall[] | undefined;
        const iterArr = Array.isArray(u?.iterations) && u!.iterations!.length > 0 ? u!.iterations! : null;
        if (iterArr) {
          modelCalls = iterArr.map((it, i) => ({
            call_index: i, model: callModel_, tokenUsage: it, contextUsage: contextUsageForCall(it),
          }));
        } else if (collectedCalls.length > 0) {
          modelCalls = collectedCalls.map(call => ({
            ...call,
            contextUsage: contextUsageForCall(call.tokenUsage),
          }));
        } else if (u) {
          // 降级：无逐次数据，写一条累计行
          modelCalls = [{ call_index: 0, model: callModel_, tokenUsage: u, contextUsage: contextUsageForCall(u), degraded: true }];
        }

        yield {
          type: 'complete',
          result: cleanResult,
          subtype: event.subtype,
          isError: event.is_error,
          errors: event.errors,
          durationMs: event.duration_ms,
          ttftMs: event.ttft_ms,
          costUsd: event.total_cost_usd,
          terminalReason: event.terminal_reason,
          sessionTitle: event.session_title,
          numTurns: event.num_turns,
          tokenUsage: event.usage,
          contextUsage,
          lastModelCall,
          modelCalls,
        };
        // result 是 SDK 流的终结事件，不再等待后续（防止 interrupt 后流不关闭导致挂起）
        return;
      }
    }
    } catch (err) {
      // 子进程崩溃（如 exited with code 1）时，把缓冲的 stderr 打出来还原真实原因。
      // SDK 包装后的错误信息不含子进程实际报错，缓冲区才是根因所在。
      const buf = this.recentStderr.get(sessionId);
      if (buf && buf.length > 0) {
        logger.error(`[AgentRunner] Subprocess stream failed (session=${sessionId}). Last ${buf.length} stderr line(s):\n${buf.join('\n')}`);
      } else {
        logger.error(`[AgentRunner] Subprocess stream failed (session=${sessionId}) with no captured stderr.`);
      }
      throw err;
    } finally {
      this.recentStderr.delete(sessionId);
    }
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string, sessionManager?: any, modelOverride?: AgentRunOverrides, runtimeEnv?: Record<string, string>): Promise<AsyncIterable<AgentEvent>> {
    // 记录当前 evolclaw session ID，用于 Agent ctl 环境变量注入
    this.currentEvolclawSessionId = sessionId;

    // 同步用户级配置到内存
    this.syncFromUserSettings();

    // 异步刷新模型别名缓存（fire-and-forget，不阻塞查询）
    if (this.baseUrl) {
      const cacheKey = normalizeModelGatewayUrl(this.baseUrl);
      const cached = modelAliasCache.get(cacheKey);
      if (!cached || (Date.now() - cached.fetchedAt > MODEL_ALIAS_TTL_MS)) {
        refreshModelAliases(this.baseUrl, this.apiKey);
      }
      // 顺带预热网关价格缓存（1h TTL），让本轮结束写库时已就绪
      const pricing = gatewayPricingCache.get(this.baseUrl);
      if (!pricing || (Date.now() - pricing.fetchedAt > GATEWAY_PRICING_TTL_MS)) {
        refreshGatewayPricing(this.baseUrl, this.apiKey);
      }
    }

    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 agentSessionId（从数据库恢复），否则使用内存中的
    const disableTools = modelOverride?.disableTools === true;
    let agentSessionId = disableTools ? undefined : (initialClaudeSessionId || this.activeSessions.get(sessionId));

    // 验证会话文件是否存在且有效（仅在有 agentSessionId 时）
    if (agentSessionId) {
      const homeDir = os.homedir();
      const encodedProjectPath = encodePath(projectPath);
      const sessionFile = path.join(homeDir, '.claude', 'projects', encodedProjectPath, `${agentSessionId}.jsonl`);

      let isValid = false;
      if (fs.existsSync(sessionFile)) {
        try {
          const content = fs.readFileSync(sessionFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          // 查找第一个包含 sessionId 和 version 的行（跳过 queue-operation）
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.sessionId && data.version) {
                isValid = true;
                break;
              }
            } catch {}
          }
          if (!isValid) {
            logger.warn(`[AgentRunner] Session file missing session data: ${sessionFile}`);
          }
        } catch (error) {
          logger.warn(`[AgentRunner] Session file corrupted: ${sessionFile}`);
        }
      }

      if (!isValid) {
        logger.warn(`[AgentRunner] Invalid session file, starting new session`);
        agentSessionId = undefined;
        this.activeSessions.delete(sessionId);
        if (this.onSessionIdUpdate) {
          this.onSessionIdUpdate(sessionId, '');
        }
      }
    }

    // PreCompact Hook - 在压缩开始时触发
    const preCompactHook = async () => {
      if (this.onCompactStart) {
        this.onCompactStart(sessionId);
      }
      return {};
    };

    // 本次调用使用的权限模式：优先 permissionModeOverride（message-processor 按 关系>角色>出厂默认 解析后传入），
    // 缺省回落 agent 级 this.permissionMode。作为 per-call 入参（hook/canUseTool 闭包捕获），
    // 不写实例字段，多对端并发互不污染（与 model/effort 同构）。
    const callPermissionMode = modelOverride?.permissionMode || this.permissionMode;

    // PreToolUse Hook - 黑名单检查 + input 修正（不可绕过，所有模式都走）
    const preToolUseHook = async (input: any) => {
      // proactive 模式行为策略（首次工具调用必须是 ec msg send）
      const policyResult = this.permissionContexts.get(sessionId)?.policyHook?.(input.tool_name, input.tool_input || {});
      if (policyResult?.block) {
        return { decision: 'block' as const, reason: policyResult.reason };
      }

      const result = await checkBlacklist(input.tool_name, input.tool_input || {});
      if (result.behavior === 'deny') {
        return { decision: 'block' as const, reason: result.message };
      }

      // H 类文件保护检查（所有权限模式都生效）
      const permCtx = this.permissionContexts.get(sessionId);
      const hClassContext = {
        sessionId,
        channel: permCtx?.channel,
        peerId: permCtx?.userId,
        role: permCtx?.role,
      };
      const hResult = checkHClassWrite(input.tool_name, input.tool_input || {}, hClassContext);
      if (hResult.behavior === 'deny') {
        return { decision: 'block' as const, reason: hResult.message };
      }

      // ec 命令权限控制（ec msg send / ec group send / ec ctl send|file）
      // 优先于只读模式检查，因为 ec 命令有独立的角色权限策略（commandPermissions）
      if (input.tool_name === 'Bash') {
        const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
        if (isEvolclawHandoffReturnCommand(command)) {
          return {};
        }
        const permCtx = this.permissionContexts.get(sessionId);
        const ecAuthCtx = {
          actorId: permCtx?.userId,
          channel: permCtx?.channel,
          channelId: permCtx?.channelId,
          chatType: permCtx?.chatType,
          selfAid: permCtx?.selfAid,
          peerKey: permCtx?.peerKey,
          role: permCtx?.role || 'none',
          isDaemonOwner: false, // claude-runner 在会话内执行，不是 daemon owner 操作
          fromControlChannel: permCtx?.channel?.startsWith('control#') || false,
        };
        const ecDecision = authorizeEcCommand(command, ecAuthCtx);
        if (ecDecision) {
          // 这是一条被识别的 ec 命令，必须依据鉴权结果放行或拒绝
          if (!ecDecision.allow) {
            const reason = `🔒 EC 命令权限拒绝: ${ecDecision.reason}`;
            return { decision: 'block' as const, reason };
          }
          // ec 命令鉴权通过，放行（跳过后续只读检查和危险命令检查，避免误伤）
          return {};
        }
        // 非 ec 命令或无法识别的 ec 子命令，继续走后续逻辑
      }

      if (callPermissionMode === 'readonly') {
        const permCtx = this.permissionContexts.get(sessionId);
        const readonlyContext = {
          sessionId,
          channel: permCtx?.channel,
          peerId: permCtx?.userId,
          role: permCtx?.role,
        };
        const roResult = checkReadonly(input.tool_name, input.tool_input || {}, projectPath, readonlyContext);
        if (roResult.behavior === 'deny') {
          return { decision: 'block' as const, reason: roResult.message };
        }
      }

      // 修正 SDK schema 不兼容问题：部分工具被 system prompt 或 skills 指示传入
      // SDK 未定义的参数（如 EnterPlanMode 的 reason），导致 InputValidationError
      const toolInput = input.tool_input || {};
      const sanitizeRules: Record<string, string[]> = {
        'EnterPlanMode': ['reason'],
        'ExitPlanMode': ['reason'],
        'ExitWorktree': ['reason'],
      };
      const fieldsToRemove = sanitizeRules[input.tool_name];
      if (fieldsToRemove && fieldsToRemove.some((f: string) => f in toolInput)) {
        const cleaned = { ...toolInput };
        for (const f of fieldsToRemove) delete cleaned[f];
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            updatedInput: cleaned
          }
        };
      }

      // gpt-5.5 等非 Claude 模型调用 Read 时会传 pages:"", SDK 校验器拒绝空字符串
      if (input.tool_name === 'Read' && toolInput.pages === '') {
        const cleaned = { ...toolInput };
        delete cleaned.pages;
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            updatedInput: cleaned
          }
        };
      }

      return {};
    };

    // PermissionDenied Hook - auto 模式下 SDK 拒绝操作时通知用户
    const permissionDeniedHook = async (input: any) => {
      if (callPermissionMode === 'auto' && this.sendPromptFn) {
        const toolName = input.tool_name || '未知工具';
        const reason = input.reason || 'AI 判断此操作有风险';
        const message = `⚠️ 操作已自动拦截\n工具: ${toolName}\n原因: ${reason}`;
        try {
          await this.sendPromptFn(message);
        } catch (err) {
          logger.error('[PermissionDenied] Failed to send notification:', err);
        }
      }
      return {};
    };

    // SDK-level canUseTool 回调：接入 PermissionGateway 的用户审批入口
    // 黑名单已在 PreToolUse hook 拦截，危险命令在此处进入审批流程
    const canUseToolCallback = async (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; title?: string; description?: string; decisionReason?: string; toolUseID: string; [key: string]: any }
    ) => {
      // 特殊处理：AskUserQuestion 工具（SDK 内置的用户交互工具）
      // 这不是权限审批，而是收集用户答案，需要构造表单卡片
      if (toolName === 'AskUserQuestion') {
        return await this.handleAskUserQuestion(sessionId, input, options);
      }

      // 特殊处理：ExitPlanMode 工具（plan mode 审批）
      if (toolName === 'ExitPlanMode') {
        return await this.handleExitPlanMode(sessionId, input, options);
      }

      // bypass 模式：跳过 SDK/AI 分类器，但保留人工维护的危险命令审批规则。
      if (callPermissionMode === 'bypass') {
        const dangerDecision = await requestDangerousCommandPermission(
          this.permissionGateway,
          sessionId,
          toolName,
          input,
          this.sendPromptFn,
          this.permissionContexts.get(sessionId)
        );
        if (dangerDecision.matched) {
          if (dangerDecision.decision === 'deny') {
            return { behavior: 'deny' as const, message: '用户拒绝了危险操作', decisionClassification: 'user_reject' as const };
          }
          return {
            behavior: 'allow' as const,
            updatedInput: input,
            decisionClassification: dangerDecision.decision === 'always' ? 'user_permanent' as const : 'user_temporary' as const
          };
        }
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // evolclaw ctl send/file 白名单：proactive 模式下 agent 必须通过这些命令发送消息，
      // 任何权限模式下都不应拦截，否则 agent 无法回复用户
      if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        if (parseEvolclawSendCommand(cmd)?.scope === 'ctl' || isEvolclawHandoffReturnCommand(cmd)) {
          return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
        }
      }

      // 危险命令检测：需要用户审批的高风险操作（rm -rf, sudo 等）
      const dangerDecision = await requestDangerousCommandPermission(
        this.permissionGateway,
        sessionId,
        toolName,
        input,
        this.sendPromptFn,
        this.permissionContexts.get(sessionId)
      );
      if (dangerDecision.matched) {
        if (dangerDecision.decision === 'deny') {
          return { behavior: 'deny' as const, message: '用户拒绝了危险操作', decisionClassification: 'user_reject' as const };
        }
        return {
          behavior: 'allow' as const,
          updatedInput: input,
          decisionClassification: dangerDecision.decision === 'always' ? 'user_permanent' as const : 'user_temporary' as const
        };
      }

      // readonly 模式：二次拦截（belt-and-suspenders）
      if (callPermissionMode === 'readonly') {
        const permCtx = this.permissionContexts.get(sessionId);
        const readonlyContext = {
          sessionId,
          channel: permCtx?.channel,
          peerId: permCtx?.userId,
          role: permCtx?.role,
        };
        const roResult = checkReadonly(toolName, input, projectPath, readonlyContext);
        if (roResult.behavior === 'deny') {
          return { behavior: 'deny' as const, message: roResult.message, decisionClassification: 'user_reject' as const };
        }
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // auto 模式：SDK 内置分类器自动判断，正常情况下不会触发 canUseTool 回调。
      // 防御性兜底：确保即使 SDK 边界场景或版本变化意外调用了此回调，也不会阻塞流程。
      if (callPermissionMode === 'auto') {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // 如果 PermissionGateway 未设置（如测试环境），回退到一律 allow
      if (!this.permissionGateway || !this.sendPromptFn) {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // always-allow 缓存命中：直接放行
      if (this.permissionGateway.isAlwaysAllowed(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      const summary = options.title
        || options.description
        || summarizeToolInput(toolName, input);

      const decision: PermissionDecision = await this.permissionGateway.requestPermission(
        sessionId,
        toolName,
        input,
        this.sendPromptFn,
        this.permissionContexts.get(sessionId),
        summary,
        options.decisionReason
      );

      if (decision === 'deny') {
        return { behavior: 'deny' as const, message: '用户拒绝或审批超时', decisionClassification: 'user_reject' as const };
      }
      return {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionClassification: decision === 'always' ? 'user_permanent' as const : 'user_temporary' as const
      };
    };

    const useSettingSources = this.config?.agents?.claude?.useSettingSources !== false;
    const enableSummaries = this.config?.agents?.claude?.agentProgressSummaries !== false;
    const excludeDynamic = this.config?.agents?.claude?.excludeDynamicSections === true;

    // 公共 options（新旧模式共用）
    const sdkPermissionMode = this.toSdkPermissionMode(callPermissionMode);
    // 本次调用使用的模型/强度：优先 modelOverride（message-processor 按 关系>agent>全局 解析后传入），
    // 缺省回落 agent 级 this.model。作为 per-call 入参传入，无共享状态，多对端并发互不污染。
    const callModel = modelOverride?.model || this.model;
    const callEffort = (modelOverride?.effort ?? this.effort) as ('low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined);
    logger.info(`[AgentRunner] runQuery model=${callModel} effort=${callEffort ?? 'auto'} permMode=${callPermissionMode} sdkMode=${sdkPermissionMode}`);
    if (systemPromptAppend) {
      logger.info(`[AgentRunner] systemPromptAppend: ${systemPromptAppend.length} chars`);
    } else {
      logger.info(`[AgentRunner] systemPromptAppend: none`);
    }
    const sdkModel = resolveSdkModel(callModel, this.baseUrl);
    const capabilityOptions = disableTools ? {} : await this.resolveCapabilityRunOptions(projectPath);
    const commonOptions = {
      cwd: projectPath,
      model: sdkModel,
      ...capabilityOptions,
      ...(disableTools ? { tools: [] as string[], mcpServers: {}, skills: [] as string[] } : {}),
      ...(callEffort ? { effort: callEffort } : {}),
      ...(this.claudeExecutablePath ? { pathToClaudeCodeExecutable: this.claudeExecutablePath } : {}),
      autoCompactWindow: autoCompactWindowForModel(sdkModel),
      advisorModel: 'haiku',
      canUseTool: canUseToolCallback,
      permissionMode: sdkPermissionMode,
      persistSession: modelOverride?.persistSession !== false,
      includePartialMessages: true,
      enableFileCheckpointing: true,
      hooks: {
        PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }],
        PreToolUse: [{ matcher: '.*', hooks: [preToolUseHook] }],
        PermissionDenied: [{ matcher: '.*', hooks: [permissionDeniedHook] }]
      },
      ...(enableSummaries ? { agentProgressSummaries: true } : {}),
      stderr: (msg: string) => {
        const trimmed = msg.trim();
        if (trimmed) {
          // 环形缓冲：保留最近 N 行，供子进程崩溃时还原真实原因
          let buf = this.recentStderr.get(sessionId);
          if (!buf) { buf = []; this.recentStderr.set(sessionId, buf); }
          buf.push(trimmed);
          if (buf.length > AgentRunner.STDERR_BUFFER_MAX) buf.shift();
        }
        if (msg.includes('[ERROR]') || msg.includes('[WARN]') || msg.includes('Stream started')) {
          logger.info(`[Claude-stderr] ${trimmed}`);
        } else {
          logger.debug(`[Claude-stderr] ${trimmed}`);
        }
      },
      env: this.getAgentEnv(runtimeEnv)
    };

    const createQuery = (promptInput: string | MessageStream, resumeSessionId?: string, resumeAt?: string) => {
      if (useSettingSources) {
        // 新方式：SDK 自动加载 CLAUDE.md 和 MCP 配置
        return query({
          prompt: promptInput as any,
          options: {
            ...commonOptions,
            settingSources: disableTools ? [] : ['project', 'user'],
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              ...(excludeDynamic ? { excludeDynamicSections: true } : {}),
              ...(systemPromptAppend ? { append: systemPromptAppend } : {})
            },
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
          }
        });
      } else {
        // 旧方式：手动加载 CLAUDE.md 和 MCP 配置（保留用于回滚）
        const globalClaudeMd = (() => {
          try {
            const globalPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
            if (fs.existsSync(globalPath)) {
              return fs.readFileSync(globalPath, 'utf-8').trim();
            }
          } catch {}
          return '';
        })();

        const projectClaudeMds = [
          path.join(projectPath, 'CLAUDE.md'),
          path.join(projectPath, '.claude', 'CLAUDE.md'),
        ].map(p => {
          try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : ''; } catch { return ''; }
        }).filter(Boolean);

        const globalMcpServers = (() => {
          if (disableTools) return {};
          try {
            const mcpPath = path.join(os.homedir(), '.claude', 'mcp.json');
            if (fs.existsSync(mcpPath)) {
              const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
              return config.mcpServers || {};
            }
          } catch {}
          return {};
        })();

        const fullAppend = [
          ...(disableTools ? [] : projectClaudeMds),
          ...(disableTools ? [] : [globalClaudeMd]),
          systemPromptAppend,
        ].filter(Boolean).join('\n\n');

        return query({
          prompt: promptInput as any,
          options: {
            ...commonOptions,
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
            ...(Object.keys(globalMcpServers).length > 0 ? { mcpServers: globalMcpServers } : {}),
            ...(fullAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: fullAppend
              }
            } : {}),
          }
        });
      }
    };

    // 检查待处理的 resumeAt（由 /rewind N chat 设置）
    let resumeAt: string | undefined;
    if (sessionManager && agentSessionId) {
      try {
        const currentSession = await sessionManager.getSessionById?.(sessionId);
        if (currentSession?.metadata?.resumeAt) {
          resumeAt = currentSession.metadata.resumeAt;
          const newMeta = { ...currentSession.metadata };
          delete newMeta.resumeAt;
          await sessionManager.updateSession(sessionId, { metadata: newMeta });
          logger.info(`[AgentRunner] Consuming resumeAt: ${resumeAt}`);
        }
      } catch (err) {
        logger.warn('[AgentRunner] Failed to check resumeAt:', err);
      }
    }

    let sdkStream;
    const msgStream = new MessageStream();
    if (images && images.length > 0) {
      logger.info('[AgentRunner] Creating query with images:', images.length, 'first image size:', images[0]?.data?.length ?? 0);
      logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');
      msgStream.push(prompt, images);
      msgStream.end();
      sdkStream = createQuery(msgStream);
    } else {
      logger.debug('[AgentRunner] Creating query with text only, agentSessionId:', initialClaudeSessionId);
      msgStream.push(prompt);
      sdkStream = createQuery(msgStream, agentSessionId, resumeAt);
    }
    this.activeMessageStreams.set(sessionId, msgStream);
    // 保存 interrupt 能力（不写 activeStreams，由 registerStream 管理活跃状态）
    if ('interrupt' in sdkStream && typeof (sdkStream as any).interrupt === 'function') {
      this.interruptFns.set(sessionId, () => (sdkStream as any).interrupt());
    }
    // 返回标准 AgentEvent 流（重试由 MessageProcessor 层负责）
    return this.transformStream(sdkStream, sessionId, callModel, callEffort, sdkModel);
  }

  async interrupt(sessionId: string): Promise<void> {
    const fn = this.interruptFns.get(sessionId);
    if (fn) {
      try {
        await fn();
        logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
      } catch (error) {
        logger.warn(`[AgentRunner] Interrupt failed (transport closed): ${sessionId}`);
      }
    }
    this.interruptFns.delete(sessionId);
    this.activeStreams.delete(sessionId);
  }

  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(sessionId: string): void {
    this.activeMessageStreams.get(sessionId)?.end();
    this.activeMessageStreams.delete(sessionId);
    this.activeStreams.delete(sessionId);
    this.interruptFns.delete(sessionId);
    this.recentStderr.delete(sessionId);
  }

  injectUserMessage(sessionId: string, text: string): void {
    this.activeMessageStreams.get(sessionId)?.push(text);
  }

  updateSessionId(sessionId: string, agentSessionId: string): void {
    logger.info(`[AgentRunner] updateSessionId called: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    this.activeSessions.set(sessionId, agentSessionId);
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, agentSessionId);
    }
  }

  private runSessionCommand(prompt: string, agentSessionId: string, projectPath: string) {
    return query({
      prompt,
      options: {
        cwd: projectPath,
        model: resolveSdkModel(this.model, this.baseUrl),
        resume: agentSessionId,
        maxTurns: 1,
        permissionMode: this.toSdkPermissionMode(),
        env: this.getAgentEnv()
      }
    });
  }

  /**
   * 主动压缩会话上下文
   */
  async compactSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    try {
      logger.info(`[AgentRunner] Compacting session: ${agentSessionId}`);
      const stream = this.runSessionCommand('/compact', agentSessionId, projectPath);
      this.activeStreams.set(sessionId, stream);
      try {
        let receivedBoundary = false;
        for await (const event of stream) {
          if (event.type === 'system' && event.subtype === 'compact_boundary') {
            logger.info(`[AgentRunner] Compact completed, pre_tokens: ${event.compact_metadata?.pre_tokens}`);
            receivedBoundary = true;
          }
        }
        if (!receivedBoundary) {
          logger.warn(`[AgentRunner] Compact stream ended without compact_boundary event`);
        }
        return receivedBoundary;
      } finally {
        this.activeStreams.delete(sessionId);
      }
    } catch (error) {
      logger.error('[AgentRunner] Compact failed:', error);
      return false;
    }
  }

  /**
   * 通过 SDK /clear 命令清空会话历史
   */
  async clearSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    try {
      logger.info(`[AgentRunner] Clearing session via SDK: ${agentSessionId}`);
      const stream = this.runSessionCommand('/clear', agentSessionId, projectPath);
      this.activeStreams.set(sessionId, stream);
      try {
        let cleared = false;
        for await (const event of stream) {
          logger.debug(`[AgentRunner] Clear event: type=${event.type}, subtype=${(event as any).subtype || 'none'}`);
          if (event.session_id && event.session_id !== agentSessionId) {
            cleared = true;
          }
        }
        if (cleared) {
          this.activeSessions.delete(sessionId);
          this.onSessionIdUpdate?.(sessionId, '');
        } else {
          logger.warn('[AgentRunner] Clear stream ended without session reset signal');
        }
        return cleared;
      } finally {
        this.activeStreams.delete(sessionId);
      }
    } catch (error) {
      logger.error('[AgentRunner] Clear session failed:', error);
      return false;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
    this.interruptFns.delete(sessionId);
    this.permissionContexts.delete(sessionId);
  }

  resolveSessionFile(agentSessionId: string, projectPath: string): string | null {
    const encodedProjectPath = encodePath(projectPath);
    const sessionFile = path.join(os.homedir(), '.claude', 'projects', encodedProjectPath, `${agentSessionId}.jsonl`);
    return fs.existsSync(sessionFile) ? sessionFile : null;
  }

  async forkSession(agentSessionId: string, projectPath: string, title?: string): Promise<string> {
    const result = await sdkForkSession(agentSessionId, { dir: projectPath, title });
    return result.sessionId;
  }

  async getSessionMessages(agentSessionId: string, projectPath: string) {
    return sdkGetSessionMessages(agentSessionId, { dir: projectPath });
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string) {
    logger.info(`[RewindFiles] agentSessionId=${agentSessionId} userMessageId=${userMessageId}`);
    const stderrChunks: string[] = [];
    const tempQuery = query({
      prompt: '',
      options: {
        cwd: projectPath,
        resume: agentSessionId,
        enableFileCheckpointing: true,
        permissionMode: this.toSdkPermissionMode(),
        stderr: (data: string) => { stderrChunks.push(data); },
        env: this.getAgentEnv(),
      }
    });
    try {
      for await (const _msg of tempQuery) {
        const dryResult = await tempQuery.rewindFiles(userMessageId, { dryRun: true });
        logger.info('[RewindFiles] dryRun result:', JSON.stringify(dryResult));
        if (!dryResult.canRewind) return dryResult;
        const result = await tempQuery.rewindFiles(userMessageId);
        logger.info('[RewindFiles] rewind result:', JSON.stringify(result));
        return {
          ...result,
          filesChanged: dryResult.filesChanged ?? result.filesChanged,
          insertions: dryResult.insertions ?? result.insertions,
          deletions: dryResult.deletions ?? result.deletions,
        };
      }
      throw new Error('Query stream ended before rewindFiles could be called');
    } catch (error) {
      if (stderrChunks.length > 0) {
        logger.error('[RewindFiles] subprocess stderr:', stderrChunks.join(''));
      }
      throw error;
    } finally {
      tempQuery.close();
    }
  }
}

// Plugin implementation
export class ClaudeAgentPlugin implements AgentPlugin {
  readonly name = 'claude';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    return !!agent.config.baseagents?.claude;
  }

  createAgent(agent: import('../core/evolagent.js').EvolAgent, callbacks: AgentCallbacks): AgentInstance | null {
    const override = agent.config.baseagents?.claude as
      | { apiKey?: string; baseUrl?: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; pathToClaudeCodeExecutable?: string }
      | undefined;
    const syntheticConfig = { agents: { claude: override } } as Config;
    const anthropic = resolveAnthropicConfig(syntheticConfig, override);
    const merged: Config = {
      agents: { claude: { ...(override || {}), evolclawAgentAid: agent.aid, evolclawAgentConfig: agent.config } },
    } as Config;
    const agentRunner = new AgentRunner(
      anthropic.apiKey,
      anthropic.model,
      callbacks.onSessionIdUpdate,
      anthropic.baseUrl,
      merged
    );
    if (anthropic.effort) {
      agentRunner.setEffort(anthropic.effort);
    }
    return { evolagentName: agent.name, baseagent: 'claude', agent: agentRunner };
  }
}
