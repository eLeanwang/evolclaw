/**
 * command-handler-gateway-control.ts — 网关（baseagent 后端）配置管理。
 *
 * "网关" = baseagent 的 baseUrl + apiKey + model 等接入配置。两级作用域：
 *   - 'defaults'：agents/defaults.json 的 baseagents 块（全局默认）
 *   - <aid>：agents/<aid>/config.json 的 baseagents 块（单 agent 覆盖）
 *
 * 设计要点：
 *   - 写入复用既有安全路径：saveDefaultsSafe（自动备份+深合并）/ saveAgent（校验）。
 *   - apiKey 永不明文出站：list 时掩码，update 仅接受 "$ENV:NAME" 引用。
 *   - test 在 daemon 内用 resolve*Config 解析真实 key 发请求，key 不离开进程。
 *   - 写后触发 evolagent.reload 让运行中的 runner 重新解析凭证。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { saveDefaultsSafe, saveAgent } from '../config-store.js';
import { resolveAnthropicConfig, resolveOpenaiConfig } from '../agents/baseagent.js';
import { resolvePriceRow } from '../stats/billing.js';
import { ipcQuery } from '../ipc.js';
import { logger } from '../utils/logger.js';
import type { Config } from '../types.js';

export type ExecResult = { data: any } | { error: string; code: string };

/** 已知 baseagent 类型（网关可管理范围）。 */
const GATEWAY_TYPES = ['claude', 'codex', 'gemini'] as const;
type GatewayType = typeof GATEWAY_TYPES[number];

const DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini',
};

/** 一条网关配置（出站形态，apiKey 已掩码）。 */
export interface GatewayEntry {
  scope: string;            // 'defaults' | <aid>
  type: GatewayType;
  name: string;
  baseUrl?: string;
  apiKeyMask?: string;      // "$ENV:NAME" 原样 | "***"（明文已存在但隐藏）| undefined（未配置）
  apiKeyIsEnvRef: boolean;  // true=值是 $ENV 引用；false=明文或缺失
  model?: string;
  effort?: string;          // claude/codex
  reasoning?: string;       // codex
  mode?: string;            // gemini: cli|sdk
  cliPath?: string;         // gemini
  useVertex?: boolean;      // gemini
  project?: string;         // gemini
  location?: string;        // gemini
}

// ── 掩码 ──

const ENV_PREFIX = '$ENV:';

function maskApiKey(raw: unknown): { mask?: string; isEnvRef: boolean } {
  if (typeof raw !== 'string' || !raw) return { mask: undefined, isEnvRef: false };
  if (raw.startsWith(ENV_PREFIX)) return { mask: raw, isEnvRef: true };  // $ENV 引用原样展示（非秘密）
  return { mask: '***', isEnvRef: false };                                // 明文：隐藏真实值
}

// ── 读取 ──

function readDefaultsRaw(): any {
  // loadDefaults 会展开 $ENV，掩码逻辑需看原始引用，故直接读盘
  try {
    const p = path.join(resolvePaths().agentsDir, 'defaults.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    logger.warn(`[gateway] read defaults.json failed: ${e}`);
  }
  return null;
}

function readAgentRaw(aid: string): any {
  try {
    const p = path.join(resolvePaths().agentsDir, aid, 'config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    logger.warn(`[gateway] read agents/${aid}/config.json failed: ${e}`);
  }
  return null;
}

function listAgentAids(): string[] {
  try {
    const dir = resolvePaths().agentsDir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'config.json')))
      .map(d => d.name);
  } catch {
    return [];
  }
}

function extractEntries(raw: any, scope: string): GatewayEntry[] {
  const out: GatewayEntry[] = [];
  const ba = raw?.baseagents;
  if (!ba || typeof ba !== 'object') return out;
  for (const type of GATEWAY_TYPES) {
    const c = ba[type];
    if (!c || typeof c !== 'object') continue;
    const { mask, isEnvRef } = maskApiKey(c.apiKey);
    out.push({
      scope,
      type,
      name: DISPLAY_NAMES[type] ?? type,
      baseUrl: c.baseUrl,
      apiKeyMask: mask,
      apiKeyIsEnvRef: isEnvRef,
      model: c.model,
      effort: c.effort,
      reasoning: c.reasoning,
      mode: c.mode,
      cliPath: c.cliPath,
      useVertex: c.useVertex,
      project: c.project,
      location: c.location,
    });
  }
  return out;
}

/** gatewayList — 列出全部作用域的网关配置（apiKey 掩码）+ 每个 agent 的 effective 配置（带来源标注）。 */
export function gatewayList(): ExecResult {
  try {
    const gateways: GatewayEntry[] = [];
    const defaults = readDefaultsRaw();

    if (defaults) gateways.push(...extractEntries(defaults, 'defaults'));

    const aids = listAgentAids();

    for (const aid of aids) {
      const raw = readAgentRaw(aid);
      if (raw) gateways.push(...extractEntries(raw, aid));
    }

    // 计算每个 agent 的 effective 配置（含来源标注）
    const effective = computeEffective(defaults, aids);

    // 检测环境变量配置与全局配置的差异
    const envMismatch = detectEnvMismatch(defaults, aids);

    return { data: { gateways, scopes: ['defaults', ...aids], types: GATEWAY_TYPES, effective, envMismatch } };
  } catch (e) {
    logger.error('[gateway] gatewayList 执行出错:', e);
    throw e;
  }
}

// ── Effective 配置（每个 agent 实际生效的值 + 来源标注）──

type FieldSource = 'agent' | 'defaults' | 'env' | 'none';

interface EffectiveField {
  value?: string;
  source: FieldSource;
}

export interface EffectiveGateway {
  aid: string;
  type: string;
  name: string;
  activeBaseagent: string;     // 该 agent 的 active_baseagent（实际使用的后端）
  activeSource: FieldSource;   // active_baseagent 的来源（agent 自己配 / 继承 defaults）
  blockSource: FieldSource;    // 整个网关块的来源（agent 有覆盖 / 全继承 defaults）
  fields: Record<string, EffectiveField>;
}

/** 判断字段来源：agent 自己有 → 'agent'；defaults 有 → 'defaults'；否则 'none'。 */
function fieldSource(agentBlock: any, defaultsBlock: any, key: string): { value?: string; source: FieldSource } {
  const agentVal = agentBlock?.[key];
  if (agentVal !== undefined && agentVal !== null && agentVal !== '') {
    return { value: key === 'apiKey' ? maskApiKey(agentVal).mask : String(agentVal), source: 'agent' };
  }
  const defaultsVal = defaultsBlock?.[key];
  if (defaultsVal !== undefined && defaultsVal !== null && defaultsVal !== '') {
    return { value: key === 'apiKey' ? maskApiKey(defaultsVal).mask : String(defaultsVal), source: 'defaults' };
  }
  return { value: undefined, source: 'none' };
}

/** 为所有 agent 计算 effective 网关配置。
 *  聚焦每个 agent 的 active_baseagent（实际使用的后端）：
 *    - agent 自己配了该后端的网关块 → 用 agent 的（标注 'agent'）
 *    - 没配 → 回落 defaults 对应后端的默认网关（标注 'defaults'）
 *  active_baseagent 缺失时回落 defaults.active_baseagent，再回落 'claude'。 */
function computeEffective(defaults: any, aids: string[]): EffectiveGateway[] {
  const result: EffectiveGateway[] = [];
  const defaultsBa = defaults?.baseagents || {};
  const defaultsActive = defaults?.active_baseagent;

  for (const aid of aids) {
    const agentRaw = readAgentRaw(aid);
    const agentBa = agentRaw?.baseagents || {};

    // 该 agent 实际使用的后端
    const activeRaw = agentRaw?.active_baseagent || defaultsActive;
    if (!activeRaw) {
      logger.error(`[GatewayConfig] active_baseagent is empty for aid=${aid}, skipping`);
      continue;
    }
    if (!(GATEWAY_TYPES as readonly string[]).includes(activeRaw)) {
      logger.error(`[GatewayConfig] unknown baseagent type '${activeRaw}' for aid=${aid}, skipping`);
      continue;
    }
    const type = activeRaw as GatewayType;
    const activeSource: FieldSource = agentRaw?.active_baseagent ? 'agent' : 'defaults';

    const dBlock = defaultsBa[type] || {};
    const aBlock = agentBa[type] || {};

    // 整块来源：agent 配了该后端的网关块 → 'agent'；否则继承 defaults
    const blockSource: FieldSource = (aBlock && Object.keys(aBlock).length > 0) ? 'agent' : 'defaults';

    const keys = type === 'gemini'
      ? ['model', 'apiKey', 'mode', 'cliPath', 'useVertex', 'project', 'location']
      : ['baseUrl', 'apiKey', 'model', 'effort', ...(type === 'codex' ? ['reasoning'] : [])];

    const fields: Record<string, EffectiveField> = {};
    for (const k of keys) {
      fields[k] = fieldSource(aBlock, dBlock, k);
    }

    result.push({
      aid,
      type,
      name: DISPLAY_NAMES[type] ?? type,
      activeBaseagent: type,
      activeSource,
      blockSource,
      fields,
    });
  }
  return result;
}

// ── 环境变量配置差异检测 ──

interface EnvMismatch {
  hasMismatch: boolean;
  mismatches: Array<{
    aid: string;
    type: string;
    field: string;
    envValue: string;
    configValue: string;
    envVarName?: string;  // 环境变量名
    processValue?: string;  // 进程环境变量的值
  }>;
  debug?: {
    processEnv: Record<string, string>;
    rootEnvFile: Record<string, string>;
    defaultsConfig: any;
  };
}

/** 检测环境变量配置与本地 .env 文件的差异 */
function detectEnvMismatch(defaults: any, aids: string[]): EnvMismatch {
  const result: EnvMismatch = { hasMismatch: false, mismatches: [] };
  const defaultsBa = defaults?.baseagents || {};

  // 读取全局 .env 文件
  const rootEnvPath = path.join(resolvePaths().root, '.env');
  const rootEnvVars = parseEnvFileSync(rootEnvPath);

  // 标准环境变量映射
  const standardEnvKeys: Record<string, string> = {
    apiKey: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'ANTHROPIC_BASE_URL',
  };

  // 记录进程环境变量
  const processEnvDebug = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '(未设置)',
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '(未设置)',
  };

  // 收集调试信息返回给前端
  result.debug = {
    processEnv: processEnvDebug,
    rootEnvFile: rootEnvVars,
    defaultsConfig: defaultsBa,
  };

  // 检测全局默认配置中的环境变量
  for (const type of GATEWAY_TYPES) {
    const block = defaultsBa[type];
    if (!block) continue;

    for (const [field, val] of Object.entries(block)) {
      // 情况1：配置值是 $ENV 引用
      if (typeof val === 'string' && val.startsWith(ENV_PREFIX)) {
        const envVarName = val.slice(ENV_PREFIX.length);
        const fileValue = rootEnvVars[envVarName];
        const processValue = process.env[envVarName];

        // .env 文件中未设置，但进程环境中有值
        if (!fileValue && processValue) {
          result.hasMismatch = true;
          result.mismatches.push({
            aid: 'defaults',
            type,
            field,
            envValue: '(.env 中未设置)',
            configValue: val,
          });
        }
      }
      // 情况2：配置值是实际值（非 $ENV 引用），检查是否应该使用环境变量
      else if (typeof val === 'string' && val && standardEnvKeys[field]) {
        const envVarName = standardEnvKeys[field];
        const fileValue = rootEnvVars[envVarName];
        const processValue = process.env[envVarName];

        // 如果进程环境中有值，但配置中的值与进程环境不一致
        if (processValue && val !== processValue) {
          // 同时检查 .env 文件：如果 .env 也没有这个值，说明需要同步
          if (!fileValue || fileValue !== processValue) {
            result.hasMismatch = true;
            result.mismatches.push({
              aid: 'defaults',
              type,
              field,
              envValue: fileValue || '(.env 中未设置)',
              configValue: val,
              envVarName,
              processValue,
            });
          }
        }
      }
    }
  }

  // 检测每个 agent 的配置
  for (const aid of aids) {
    const agentRaw = readAgentRaw(aid);
    const agentBa = agentRaw?.baseagents || {};

    // 读取该 agent 的 .env 文件
    const agentEnvPath = path.join(resolvePaths().agentsDir, aid, '.env');
    const agentEnvVars = parseEnvFileSync(agentEnvPath);

    for (const type of GATEWAY_TYPES) {
      const block = agentBa[type];
      if (!block) continue;

      for (const [field, val] of Object.entries(block)) {
        // 情况1：配置值是 $ENV 引用
        if (typeof val === 'string' && val.startsWith(ENV_PREFIX)) {
          const envVarName = val.slice(ENV_PREFIX.length);
          const fileValue = agentEnvVars[envVarName];
          const processValue = process.env[envVarName];

          if (!fileValue && processValue) {
            result.hasMismatch = true;
            result.mismatches.push({
              aid,
              type,
              field,
              envValue: '(.env 中未设置)',
              configValue: val,
            });
          }
        }
        // 情况2：配置值是实际值
        else if (typeof val === 'string' && val && standardEnvKeys[field]) {
          const envVarName = standardEnvKeys[field];
          const fileValue = agentEnvVars[envVarName];
          const processValue = process.env[envVarName];

          if (processValue && val !== processValue) {
            if (!fileValue || fileValue !== processValue) {
              result.hasMismatch = true;
              result.mismatches.push({
                aid,
                type,
                field,
                envValue: fileValue || '(.env 中未设置)',
                configValue: `配置值与环境变量 ${envVarName} 不一致`,
              });
            }
          }
        }
      }
    }
  }

  return result;
}

/** 同步解析 .env 文件（复用 merge.ts 的逻辑） */
function parseEnvFileSync(file: string): Record<string, string> {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

// ── 写入 ──

/** 校验 type 合法。 */
function validateType(type: unknown): type is GatewayType {
  return typeof type === 'string' && (GATEWAY_TYPES as readonly string[]).includes(type);
}

/** 从 patch 提取允许写入的字段。apiKey 仅接受 $ENV 引用。 */
function buildPatch(type: GatewayType, patch: any): { fields: Record<string, unknown> } | { error: string } {
  const f: Record<string, unknown> = {};
  if (patch.baseUrl !== undefined) f.baseUrl = String(patch.baseUrl).trim() || undefined;
  if (patch.model !== undefined) f.model = String(patch.model).trim() || undefined;

  if (patch.apiKey !== undefined && patch.apiKey !== '') {
    const v = String(patch.apiKey).trim();
    // 掩码占位符（未修改）忽略；其余必须是 $ENV 引用，拒绝明文
    if (v === '***') { /* 未修改，跳过 */ }
    else if (v.startsWith(ENV_PREFIX)) f.apiKey = v;
    else return { error: 'apiKey 仅接受 "$ENV:NAME" 环境变量引用，不接受明文' };
  }

  if (type === 'claude' || type === 'codex') {
    if (patch.effort !== undefined) f.effort = String(patch.effort).trim() || undefined;
  }
  if (type === 'codex') {
    if (patch.reasoning !== undefined) f.reasoning = String(patch.reasoning).trim() || undefined;
  }
  if (type === 'gemini') {
    if (patch.mode !== undefined) f.mode = (patch.mode === 'sdk' ? 'sdk' : 'cli');
    if (patch.cliPath !== undefined) f.cliPath = String(patch.cliPath).trim() || undefined;
    if (patch.useVertex !== undefined) f.useVertex = !!patch.useVertex;
    if (patch.project !== undefined) f.project = String(patch.project).trim() || undefined;
    if (patch.location !== undefined) f.location = String(patch.location).trim() || undefined;
  }
  return { fields: f };
}

/** 触发 reload：defaults 改动影响全部 agent（resync），单 agent 改动只 reload 它。 */
async function triggerReload(scope: string): Promise<boolean> {
  const sock = resolvePaths().socket;
  try {
    if (scope === 'defaults') {
      const r = await ipcQuery(sock, { type: 'evolagent.resync' }) as any;
      return !!r?.ok;
    }
    const r = await ipcQuery(sock, { type: 'evolagent.reload', name: scope }) as any;
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** gatewayUpdate — 写入/更新一条网关配置。 */
export async function gatewayUpdate(args: any): Promise<ExecResult> {
  const scope = String(args?.scope ?? '').trim();
  const type = args?.type;
  if (!scope) return { error: '缺少 scope', code: 'INVALID_ARGS' };
  if (!validateType(type)) return { error: `无效 type: ${type}（可选 ${GATEWAY_TYPES.join('/')}）`, code: 'INVALID_ARGS' };

  const built = buildPatch(type, args?.patch ?? {});
  if ('error' in built) return { error: built.error, code: 'INVALID_ARGS' };

  try {
    if (scope === 'defaults') {
      const cur = readDefaultsRaw() ?? {};
      const baseagents = { ...(cur.baseagents ?? {}) };
      baseagents[type] = { ...(baseagents[type] ?? {}), ...built.fields };
      saveDefaultsSafe({ baseagents } as any);
    } else {
      const cfg = readAgentRaw(scope);
      if (!cfg) return { error: `Agent "${scope}" 不存在`, code: 'NOT_FOUND' };
      if (!cfg.baseagents) cfg.baseagents = {};
      cfg.baseagents[type] = { ...(cfg.baseagents[type] ?? {}), ...built.fields };
      saveAgent(cfg);  // 含 aid/owners/admins 校验
    }
  } catch (e: any) {
    return { error: e?.message || String(e), code: 'EXEC_FAILED' };
  }

  const reloaded = await triggerReload(scope);
  return { data: { scope, type, reloaded } };
}

/** gatewayDelete — 删除一条网关配置。 */
export async function gatewayDelete(args: any): Promise<ExecResult> {
  const scope = String(args?.scope ?? '').trim();
  const type = args?.type;
  if (!scope) return { error: '缺少 scope', code: 'INVALID_ARGS' };
  if (!validateType(type)) return { error: `无效 type: ${type}`, code: 'INVALID_ARGS' };

  try {
    if (scope === 'defaults') {
      const cur = readDefaultsRaw();
      if (cur?.baseagents?.[type]) {
        const baseagents = { ...cur.baseagents };
        delete baseagents[type];
        // saveDefaultsSafe 是深合并不会删键，故直接整块覆盖 baseagents
        saveDefaultsSafe({ baseagents } as any);
      }
    } else {
      const cfg = readAgentRaw(scope);
      if (!cfg) return { error: `Agent "${scope}" 不存在`, code: 'NOT_FOUND' };
      if (cfg.baseagents?.[type]) {
        delete cfg.baseagents[type];
        saveAgent(cfg);
      }
    }
  } catch (e: any) {
    return { error: e?.message || String(e), code: 'EXEC_FAILED' };
  }

  const reloaded = await triggerReload(scope);
  return { data: { scope, type, deleted: true, reloaded } };
}

/** 解析某 scope/type 的真实 baseUrl + apiKey（在 daemon 内展开 $ENV，不出站）。 */
function resolveGatewayCreds(scope: string, type: GatewayType): { baseUrl?: string; apiKey?: string } | { error: string; code: string } {
  const raw = scope === 'defaults' ? readDefaultsRaw() : readAgentRaw(scope);
  const block = raw?.baseagents?.[type];
  if (!block) return { error: `${scope}/${type} 未配置`, code: 'NOT_FOUND' };

  const expanded = expandEnv(block);
  try {
    const synth = { agents: { [type]: expanded } } as unknown as Config;
    if (type === 'codex') {
      const r = resolveOpenaiConfig(synth, expanded);
      return { baseUrl: r.baseUrl, apiKey: r.apiKey };
    } else if (type === 'claude') {
      const r = resolveAnthropicConfig(synth, expanded);
      return { baseUrl: r.baseUrl, apiKey: r.apiKey };
    }
    return { error: 'gemini 暂不支持 HTTP 探测（CLI 后端）', code: 'NOT_SUPPORTED' };
  } catch (e: any) {
    return { error: `凭证解析失败：${e?.message || e}`, code: 'EXEC_FAILED' };
  }
}

/** gatewayTest — 连通性测试。在 daemon 内解析真实 key（不出站）发 /v1/models。 */
export async function gatewayTest(args: any): Promise<ExecResult> {
  const scope = String(args?.scope ?? '').trim();
  const type = args?.type;
  if (!validateType(type)) return { error: `无效 type: ${type}`, code: 'INVALID_ARGS' };

  const creds = resolveGatewayCreds(scope, type);
  if ('error' in creds) return creds;
  const { baseUrl, apiKey } = creds;
  if (!baseUrl) return { error: '未配置 baseUrl（或为官方占位地址）', code: 'INVALID_ARGS' };

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latency = Date.now() - start;
    if (!resp.ok) return { data: { ok: false, latency, error: `HTTP ${resp.status}` } };
    const json: any = await resp.json().catch(() => null);
    const arr: any[] = Array.isArray(json?.data) ? json.data
                     : Array.isArray(json?.models) ? json.models : [];
    const models = arr.map((m: any) => (typeof m === 'string' ? m : (m?.id || m?.name || m?.model))).filter(Boolean);
    return { data: { ok: true, latency, modelCount: models.length, models } };
  } catch (e: any) {
    return { data: { ok: false, latency: Date.now() - start, error: e?.message || String(e) } };
  }
}

// ── 模型 + 价格 ──

interface PriceQuad { input?: number; output?: number; cache_read?: number; cache_write?: number; }

/** 从 model-prices.jsonl 的 PriceRecord 提取展示用价格四元组。 */
function priceRowToQuad(row: any): PriceQuad | undefined {
  if (!row) return undefined;
  return {
    input: typeof row.price_input === 'number' ? row.price_input : undefined,
    output: typeof row.price_output === 'number' ? row.price_output : undefined,
    cache_read: typeof row.price_cache_read === 'number' ? row.price_cache_read : undefined,
    cache_write: typeof row.price_cache_creation === 'number' ? row.price_cache_creation : undefined,
  };
}

/** 从接口 pricing 对象提取四元组。 */
function apiPricingToQuad(p: any): PriceQuad | undefined {
  if (!p || typeof p !== 'object') return undefined;
  return {
    input: typeof p.input === 'number' ? p.input : undefined,
    output: typeof p.output === 'number' ? p.output : undefined,
    cache_read: typeof p.cache_read === 'number' ? p.cache_read : undefined,
    cache_write: typeof p.cache_write === 'number' ? p.cache_write : undefined,
  };
}

/** gatewayModels — 拉取该网关模型列表 + 官方价格 + 网关价格（接口缺失则回退 model-prices.jsonl）。 */
export async function gatewayModels(args: any): Promise<ExecResult> {
  const scope = String(args?.scope ?? '').trim();
  const type = args?.type;
  if (!validateType(type)) return { error: `无效 type: ${type}`, code: 'INVALID_ARGS' };

  const creds = resolveGatewayCreds(scope, type);
  if ('error' in creds) return creds;
  const { baseUrl, apiKey } = creds;
  if (!baseUrl) return { error: '未配置 baseUrl（或为官方占位地址）', code: 'INVALID_ARGS' };

  let arr: any[] = [];
  let usdToCny = 7; // 默认汇率

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { error: `HTTP ${resp.status}`, code: 'EXEC_FAILED' };
    const json: any = await resp.json().catch(() => null);
    arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];

    // 提取汇率（usd_to_cny），如果没有则使用默认值 7
    if (typeof json?.usd_to_cny === 'number') {
      usdToCny = json.usd_to_cny;
    }
  } catch (e: any) {
    return { error: `请求失败：${e?.message || e}`, code: 'EXEC_FAILED' };
  }

  const evolclawHome = resolvePaths().root;
  const now = Date.now();

  const models = arr.map((m: any) => {
    const id = typeof m === 'string' ? m : (m?.id || m?.name || m?.model);
    if (!id) return null;
    const name = (m && typeof m === 'object' && m.name) ? m.name : id;
    const group = (m && typeof m === 'object' && m.group) ? m.group : undefined;

    // 官方价格：接口 pricing 优先，缺失回退 model-prices.jsonl
    let official = apiPricingToQuad(m?.pricing);
    let officialSource: 'gateway' | 'local' | 'none' = official ? 'gateway' : 'none';
    if (!official) {
      const row = resolvePriceRow(evolclawHome, id, now);
      const quad = priceRowToQuad(row);
      if (quad) { official = quad; officialSource = 'local'; }
    }

    // 网关价格：接口 effective_pricing；缺失则留空（用户可手动设）
    const gatewayPrice = apiPricingToQuad(m?.effective_pricing);

    return { id, name, group, official: official ?? null, officialSource, gateway: gatewayPrice ?? null };
  }).filter(Boolean);

  return { data: { scope, type, models, usdToCny } };
}

/** gatewaySetPrice — 把用户改的网关价格 append 到用户覆盖层 model-prices.jsonl。 */
export function gatewaySetPrice(args: any): ExecResult {
  const modelId = String(args?.modelId ?? '').trim();
  if (!modelId) return { error: '缺少 modelId', code: 'INVALID_ARGS' };
  const p = args?.pricing;
  if (!p || typeof p !== 'object') return { error: '缺少 pricing', code: 'INVALID_ARGS' };

  const num = (v: any) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : undefined;
  const record: any = {
    model: modelId,
    effective_from: Date.now(),
    billing_fn: 'per_token_v1',
    currency: 'USD',
  };
  if (num(p.input) !== undefined) record.price_input = num(p.input);
  if (num(p.output) !== undefined) record.price_output = num(p.output);
  if (num(p.cache_read) !== undefined) record.price_cache_read = num(p.cache_read);
  if (num(p.cache_write) !== undefined) record.price_cache_creation = num(p.cache_write);

  if (record.price_input === undefined && record.price_output === undefined
    && record.price_cache_read === undefined && record.price_cache_creation === undefined) {
    return { error: '至少需提供一个有效价格字段', code: 'INVALID_ARGS' };
  }

  try {
    const dir = path.join(resolvePaths().root, 'data', 'stats');
    fs.mkdirSync(dir, { recursive: true });
    // 写入网关价格覆盖层（price-resolver 的「优先级1 用户手动设置网关价」读此文件）。
    // 注意：必须是 model-prices-gateway.jsonl，不是 model-prices.jsonl（后者是官方价表）。
    const file = path.join(dir, 'model-prices-gateway.jsonl');
    const mode = 0o600; // owner-only read/write for security
    const fd = fs.openSync(file, 'a', mode);
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    logger.info(`[gateway] 网关价格已更新: ${modelId}（写入网关价覆盖层 model-prices-gateway.jsonl）`);
  } catch (e: any) {
    return { error: e?.message || String(e), code: 'EXEC_FAILED' };
  }

  return { data: { modelId, saved: true } };
}

/** gatewaySyncEnv — 同步环境变量到配置文件（将进程环境变量的值写入配置文件） */
export async function gatewaySyncEnv(args: any): Promise<ExecResult> {
  const syncType = args?.syncType; // 'global' | 'all-agents' | 'specific-agents'
  const targetAids = args?.targetAids || []; // 指定的 agent IDs（仅 specific-agents 时使用）

  if (!['global', 'all-agents', 'specific-agents'].includes(syncType)) {
    return { error: '无效的 syncType，可选值：global / all-agents / specific-agents', code: 'INVALID_ARGS' };
  }

  if (syncType === 'specific-agents' && (!Array.isArray(targetAids) || targetAids.length === 0)) {
    return { error: 'specific-agents 模式需要提供 targetAids 数组', code: 'INVALID_ARGS' };
  }

  try {
    const synced: string[] = [];

    // 1. 同步全局配置
    if (syncType === 'global' || syncType === 'all-agents' || syncType === 'specific-agents') {
      const defaults = readDefaultsRaw();
      if (defaults?.baseagents) {
        let hasChanges = false;
        for (const type of GATEWAY_TYPES) {
          const block = defaults.baseagents[type];
          if (!block) continue;

          for (const [field, val] of Object.entries(block)) {
            // 检测配置值是否与进程环境变量不一致
            if (typeof val === 'string') {
              // 情况1：引用型 $ENV:XXX
              if (val.startsWith(ENV_PREFIX)) {
                const varName = val.slice(ENV_PREFIX.length);
                const processValue = process.env[varName];
                if (processValue) {
                  // 将引用改为实际值
                  block[field] = processValue;
                  hasChanges = true;
                }
              }
              // 情况2：实际值型，但与进程环境变量不一致
              else {
                const standardEnvKey = field === 'apiKey' ? 'ANTHROPIC_AUTH_TOKEN' : field === 'baseUrl' ? 'ANTHROPIC_BASE_URL' : null;
                if (standardEnvKey) {
                  const processValue = process.env[standardEnvKey];
                  if (processValue && val !== processValue) {
                    block[field] = processValue;
                    hasChanges = true;
                  }
                }
              }
            }
          }
        }

        if (hasChanges) {
          const defaultsPath = path.join(resolvePaths().agentsDir, 'defaults.json');
          fs.writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2), 'utf-8');
          synced.push('全局配置 (defaults.json)');
        }
      }
    }

    // 2. 同步 agent 配置
    if (syncType === 'all-agents' || syncType === 'specific-agents') {
      const aids = syncType === 'all-agents' ? listAgentAids() : targetAids;

      for (const aid of aids) {
        const agentRaw = readAgentRaw(aid);
        if (!agentRaw?.baseagents) continue;

        let hasChanges = false;
        for (const type of GATEWAY_TYPES) {
          const block = agentRaw.baseagents[type];
          if (!block) continue;

          for (const [field, val] of Object.entries(block)) {
            if (typeof val === 'string') {
              // 情况1：引用型
              if (val.startsWith(ENV_PREFIX)) {
                const varName = val.slice(ENV_PREFIX.length);
                const processValue = process.env[varName];
                if (processValue) {
                  block[field] = processValue;
                  hasChanges = true;
                }
              }
              // 情况2：实际值型
              else {
                const standardEnvKey = field === 'apiKey' ? 'ANTHROPIC_AUTH_TOKEN' : field === 'baseUrl' ? 'ANTHROPIC_BASE_URL' : null;
                if (standardEnvKey) {
                  const processValue = process.env[standardEnvKey];
                  if (processValue && val !== processValue) {
                    block[field] = processValue;
                    hasChanges = true;
                  }
                }
              }
            }
          }
        }

        if (hasChanges) {
          const agentConfigPath = path.join(resolvePaths().agentsDir, aid, 'config.json');
          fs.writeFileSync(agentConfigPath, JSON.stringify(agentRaw, null, 2), 'utf-8');
          synced.push(`${aid} (config.json)`);
        }
      }
    }

    return { data: { synced, count: synced.length } };
  } catch (e: any) {
    return { error: e?.message || String(e), code: 'EXEC_FAILED' };
  }
}

/** 从配置中提取所有环境变量引用 */
function extractEnvVarsFromConfig(baseagents: any): Array<{ varName: string; currentValue: string }> {
  const envVars: Array<{ varName: string; currentValue: string }> = [];
  const seen = new Set<string>();

  for (const type of GATEWAY_TYPES) {
    const block = baseagents[type];
    if (!block) continue;

    for (const val of Object.values(block)) {
      if (typeof val === 'string' && val.startsWith(ENV_PREFIX)) {
        const varName = val.slice(ENV_PREFIX.length);
        if (!seen.has(varName)) {
          seen.add(varName);
          const currentValue = process.env[varName] || '';
          envVars.push({ varName, currentValue });
        }
      }
    }
  }

  return envVars;
}

/** 同步环境变量到 .env 文件（保留现有内容，更新或追加变量） */
async function syncEnvFile(envPath: string, envVars: Array<{ varName: string; currentValue: string }>): Promise<void> {
  let existingContent = '';
  const existingVars = new Map<string, string>();

  // 读取现有 .env 文件
  if (fs.existsSync(envPath)) {
    existingContent = fs.readFileSync(envPath, 'utf-8');
    const lines = existingContent.split(/\r?\n/);

    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      existingVars.set(key, line); // 保留原始行（含格式）
    }
  }

  // 构建新内容
  const newLines: string[] = [];
  const updatedVars = new Set<string>();

  // 保留现有内容，更新匹配的变量
  if (existingContent) {
    const lines = existingContent.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) {
        newLines.push(line);
        continue;
      }

      const eq = t.indexOf('=');
      if (eq <= 0) {
        newLines.push(line);
        continue;
      }

      const key = t.slice(0, eq).trim();
      const envVar = envVars.find(v => v.varName === key);

      if (envVar && envVar.currentValue) {
        // 更新为当前进程环境变量的值
        newLines.push(`${key}=${envVar.currentValue}`);
        updatedVars.add(key);
      } else {
        newLines.push(line);
      }
    }
  }

  // 追加新的环境变量
  for (const envVar of envVars) {
    if (!updatedVars.has(envVar.varName) && envVar.currentValue) {
      newLines.push(`${envVar.varName}=${envVar.currentValue}`);
    }
  }

  // 写入文件
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, newLines.join('\n') + '\n', 'utf-8');
  logger.info(`[gateway] 已同步环境变量到: ${envPath}`);
}


/** 递归展开 $ENV 引用（仅用于 test 的临时解析，不落盘）。 */
function expandEnv(obj: any): any {
  if (typeof obj === 'string') {
    if (obj.startsWith(ENV_PREFIX)) return process.env[obj.slice(ENV_PREFIX.length)] ?? '';
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = expandEnv(v);
    return out;
  }
  return obj;
}
