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
import { resolvePaths } from '../../paths.js';
import { saveDefaultsSafe, saveAgent } from '../../config-store.js';
import { resolveAnthropicConfig, resolveOpenaiConfig } from '../../agents/baseagent.js';
import { ipcQuery } from '../../ipc.js';
import { logger } from '../../utils/logger.js';
import type { Config } from '../../types.js';

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

/** gatewayList — 列出全部作用域的网关配置（apiKey 掩码）。 */
export function gatewayList(): ExecResult {
  const gateways: GatewayEntry[] = [];
  const defaults = readDefaultsRaw();
  if (defaults) gateways.push(...extractEntries(defaults, 'defaults'));

  const aids = listAgentAids();
  for (const aid of aids) {
    const raw = readAgentRaw(aid);
    if (raw) gateways.push(...extractEntries(raw, aid));
  }
  return { data: { gateways, scopes: ['defaults', ...aids], types: GATEWAY_TYPES } };
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

/** gatewayTest — 连通性测试。在 daemon 内解析真实 key（不出站）发 /v1/models。 */
export async function gatewayTest(args: any): Promise<ExecResult> {
  const scope = String(args?.scope ?? '').trim();
  const type = args?.type;
  if (!validateType(type)) return { error: `无效 type: ${type}`, code: 'INVALID_ARGS' };

  // 取该作用域的原始 baseagent 块，构造 syntheticConfig 交给既有 resolver
  const raw = scope === 'defaults' ? readDefaultsRaw() : readAgentRaw(scope);
  const block = raw?.baseagents?.[type];
  if (!block) return { error: `${scope}/${type} 未配置`, code: 'NOT_FOUND' };

  // $ENV 引用需展开成真实值（resolver 吃展开后的 config）
  const expanded = expandEnv(block);
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  try {
    const synth = { agents: { [type]: expanded } } as unknown as Config;
    if (type === 'codex') {
      const r = resolveOpenaiConfig(synth, expanded);
      baseUrl = r.baseUrl; apiKey = r.apiKey;
    } else if (type === 'claude') {
      const r = resolveAnthropicConfig(synth, expanded);
      baseUrl = r.baseUrl; apiKey = r.apiKey;
    } else {
      // gemini 多为 CLI，无统一 /v1/models HTTP 探测口径
      return { error: 'gemini 暂不支持连通性测试（CLI 后端）', code: 'NOT_SUPPORTED' };
    }
  } catch (e: any) {
    return { error: `凭证解析失败：${e?.message || e}`, code: 'EXEC_FAILED' };
  }

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
    const count = Array.isArray(json?.data) ? json.data.length
                : Array.isArray(json?.models) ? json.models.length : 0;
    return { data: { ok: true, latency, modelCount: count } };
  } catch (e: any) {
    return { data: { ok: false, latency: Date.now() - start, error: e?.message || String(e) } };
  }
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
