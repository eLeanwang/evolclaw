/**
 * model-scope: 模型/推理强度的三级作用域读写与解析。
 *
 * 作用域（越具体越优先）：
 *   关系级  >  agent级  >  全局
 *
 * 存储位置：
 *   全局   agents/defaults.json          → baseagents.<ba>.{model,effort}
 *   agent  agents/<self>/config.json     → baseagents.<ba>.{model,effort}
 *   关系   agents/<self>/relations/<peerKey>/preferences.json → {model,effort}
 *
 * 改关系级/agent级/全局后，对应范围所有会话的下一条消息即时生效
 * （运行时每条消息按 关系>agent>全局 解析，不缓存、不绑会话）。
 *
 * 详见 docs/model-command-design.md。
 */

import fs from 'fs';
import path from 'path';
import { agentRelationsDir, agentConfig as agentConfigPath, resolvePaths } from '../../paths.js';
import { loadDefaults, saveDefaultsSafe, loadAgent, saveAgent } from '../../config-store.js';
import { formatPeerKey, parsePeerKey } from '../relation/peer-key.js';
import { fileCache } from '../cache/file-cache.js';
import type { BaseagentsBlock, AgentConfig, DefaultsConfig } from '../../types.js';

export type ModelScope = 'global' | 'agent' | 'relation';

// ── mtime 门控缓存 ─────────────────────────────────────────────────────
//
// resolveEffectiveModel 每条消息按 关系>agent>全局 解析，原本每次都
// loadAgent()/loadDefaults()/读 preferences.json —— 一条消息最多读盘 5 次。
//
// model-scope 被 CLI 子进程与 daemon 共用，CLI 改文件后 daemon 无失效通知，
// 故靠 mtime 门控：每次只 statSync 比对 mtime，未变用缓存，变了才真正重读 +
// 重解析。跨进程天然正确（文件 mtime 变即感知），改配置即时生效不变；
// statSync 远比 read+JSON.parse 便宜。loader 仍走原 loadAgent/loadDefaults，
// 保留 expandEnvRefs / 校验等处理。

interface MtimeCacheEntry<T> { mtimeMs: number | null; value: T; }

function makeMtimeCache<T>(loader: (file: string) => T) {
  const cache = new Map<string, MtimeCacheEntry<T>>();
  return (file: string): T => {
    let mtimeMs: number | null;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      mtimeMs = null;  // 文件不存在
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = loader(file);
    cache.set(file, { mtimeMs, value });
    return value;
  };
}

// agent config.json：按文件路径 → AgentConfig（保留 loadAgent 的 env 展开/校验）
const loadAgentCached = (() => {
  const get = makeMtimeCache<AgentConfig | null>((file) => {
    const aid = path.basename(path.dirname(file));
    return loadAgent(aid);
  });
  return (self: string): AgentConfig | null => get(agentConfigPath(self));
})();

// defaults.json：单文件
const loadDefaultsCached = (() => {
  const get = makeMtimeCache<DefaultsConfig | null>(() => loadDefaults());
  return (): DefaultsConfig | null => get(resolvePaths().defaultsConfig);
})();

// 关系级 preferences.json —— 走统一 FileCache（mtime 门控，带外改 + 不 reload）。
// CLI 进程的 fileCache 是独立空实例、随进程退出，等同直读最新盘值，安全。
const readPrefsCached = (file: string): ModelPrefs | null =>
  fileCache.get<ModelPrefs | null>(
    file,
    (raw) => (raw === null ? null : safeParsePrefs(raw)),
    { policy: 'mtime', group: 'relation-prefs' },
  );

function safeParsePrefs(raw: string): ModelPrefs | null {
  try { return JSON.parse(raw) as ModelPrefs; } catch { return null; }
}

/** 关系级扁平文件的内容结构 */
export interface ModelPrefs {
  model?: string;
  effort?: string;
  updatedAt?: number;
}

/** 作用域选择器：由 CLI 参数解析得到 */
export interface ScopeSelector {
  /** 本端 aid；缺省 = 全局 */
  self?: string;
  /** 规范化后的 peerKey（channel#urlEncode(id)）；需配 self */
  peerKey?: string;
}

export class ModelScopeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ModelScopeError';
  }
}

// ── peer 归一化 ────────────────────────────────────────────────────────

/**
 * 把 `--peer` 入参归一为规范 peerKey。
 * 接受两种形态：
 *   - `channelType#channelId`（channelId 可能已 urlEncode，统一 round-trip 重编码）
 *   - 裸 aid（无 '#'）→ 视为 `aun#<aid>`
 */
export function normalizePeer(input: string): string {
  const raw = (input || '').trim();
  if (!raw) throw new ModelScopeError('INVALID_PEER', '--peer 不能为空');

  if (raw.includes('#')) {
    let parsed: { channelType: string; channelId: string };
    try {
      parsed = parsePeerKey(raw);
    } catch {
      throw new ModelScopeError('INVALID_PEER', `无法解析 --peer: ${raw}`);
    }
    if (!parsed.channelType || !parsed.channelId) {
      throw new ModelScopeError('INVALID_PEER', `无法解析 --peer: ${raw}`);
    }
    return formatPeerKey(parsed.channelType, parsed.channelId);
  }

  // 裸 aid → AUN 原生对端
  return formatPeerKey('aun', raw);
}

// ── 作用域判定 ────────────────────────────────────────────────────────

/**
 * 由选择器判定作用域，并校验参数依赖关系。
 * 依赖：peerKey 须配 self。
 */
export function determineScope(sel: ScopeSelector): ModelScope {
  const hasSelf = !!sel.self;
  const hasPeer = !!sel.peerKey;

  if (hasPeer && !hasSelf) {
    throw new ModelScopeError('PEER_WITHOUT_SELF', '--peer 必须配合 --self 使用');
  }

  if (hasPeer) return 'relation';
  if (hasSelf) return 'agent';
  return 'global';
}

// ── baseagent 解析（global/agent 级模型挂在 baseagents.<ba> 下）──────────

/** 取本端的活跃 baseagent；无 self 时取全局默认。 */
export function activeBaseagent(self?: string): string {
  try {
    if (self) {
      const cfg = loadAgentCached(self);
      if (cfg?.active_baseagent) return cfg.active_baseagent;
    }
    const d = loadDefaultsCached();
    if (d?.active_baseagent) return d.active_baseagent;
  } catch { /* fall through */ }
  return 'claude';
}

/** codex 的推理强度字段名是 reasoning，其余是 effort。 */
function effortField(ba: string): 'effort' | 'reasoning' {
  return ba === 'codex' ? 'reasoning' : 'effort';
}

// ── 关系级文件路径 ─────────────────────────────────────────────────────

function relationPrefsPath(self: string, peerKey: string): string {
  return path.join(agentRelationsDir(self), peerKey, 'preferences.json');
}

function readJsonSafe(file: string): ModelPrefs | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ModelPrefs;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, data: ModelPrefs): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// ── 读：单作用域 ──────────────────────────────────────────────────────

/** 读取指定作用域当前存的 {model,effort}（未设为空对象）。 */
export function readScope(scope: ModelScope, sel: ScopeSelector, ba: string): ModelPrefs {
  switch (scope) {
    case 'global': {
      const block = (loadDefaultsCached()?.baseagents || {}) as BaseagentsBlock;
      const c = (block as any)[ba] || {};
      return { model: c.model, effort: c[effortField(ba)] };
    }
    case 'agent': {
      const cfg = sel.self ? loadAgentCached(sel.self) : null;
      const c = ((cfg?.baseagents || {}) as any)[ba] || {};
      return { model: c.model, effort: c[effortField(ba)] };
    }
    case 'relation': {
      const p = readPrefsCached(relationPrefsPath(sel.self!, sel.peerKey!));
      return { model: p?.model, effort: p?.effort };
    }
  }
}

// ── 写：单作用域 ──────────────────────────────────────────────────────

/**
 * 写入指定作用域。patch 中 undefined 的字段不动；显式 null 删除该字段。
 */
export function writeScope(
  scope: ModelScope,
  sel: ScopeSelector,
  ba: string,
  patch: { model?: string | null; effort?: string | null },
): void {
  switch (scope) {
    case 'global':
      writeConfigBlock(scope, sel, ba, patch);
      return;
    case 'agent':
      writeConfigBlock(scope, sel, ba, patch);
      return;
    case 'relation':
      writeFlatFile(relationPrefsPath(sel.self!, sel.peerKey!), patch);
      return;
  }
}

function writeConfigBlock(
  scope: 'global' | 'agent',
  sel: ScopeSelector,
  ba: string,
  patch: { model?: string | null; effort?: string | null },
): void {
  const ef = effortField(ba);
  if (scope === 'global') {
    const block: any = {};
    const sub: any = {};
    if (patch.model !== undefined) sub.model = patch.model === null ? undefined : patch.model;
    if (patch.effort !== undefined) sub[ef] = patch.effort === null ? undefined : patch.effort;
    block[ba] = sub;
    // saveDefaultsSafe 做深合并；删除字段需读改写
    if (patch.model === null || patch.effort === null) {
      const d = loadDefaults() || ({ $schema_version: 1 } as any);
      d.baseagents = d.baseagents || {};
      d.baseagents[ba] = d.baseagents[ba] || {};
      if (patch.model === null) delete d.baseagents[ba].model;
      else if (patch.model !== undefined) d.baseagents[ba].model = patch.model;
      if (patch.effort === null) delete d.baseagents[ba][ef];
      else if (patch.effort !== undefined) d.baseagents[ba][ef] = patch.effort;
      saveDefaultsSafe({ baseagents: d.baseagents });
    } else {
      saveDefaultsSafe({ baseagents: block });
    }
    return;
  }

  // agent 级
  const cfg = loadAgent(sel.self!);
  if (!cfg) throw new ModelScopeError('AGENT_NOT_FOUND', `agent 不存在: ${sel.self}`);
  cfg.baseagents = cfg.baseagents || {};
  (cfg.baseagents as any)[ba] = (cfg.baseagents as any)[ba] || {};
  const sub = (cfg.baseagents as any)[ba];
  if (patch.model === null) delete sub.model;
  else if (patch.model !== undefined) sub.model = patch.model;
  if (patch.effort === null) delete sub[ef];
  else if (patch.effort !== undefined) sub[ef] = patch.effort;
  saveAgent(cfg);
}

function writeFlatFile(file: string, patch: { model?: string | null; effort?: string | null }): void {
  const cur = readJsonSafe(file) || {};
  if (patch.model === null) delete cur.model;
  else if (patch.model !== undefined) cur.model = patch.model;
  if (patch.effort === null) delete cur.effort;
  else if (patch.effort !== undefined) cur.effort = patch.effort;
  cur.updatedAt = Date.now();
  writeJsonAtomic(file, cur);
}

// ── 清除：单作用域 ────────────────────────────────────────────────────

/** 清除指定作用域的 model+effort（关系级直接删文件）。 */
export function clearScope(scope: ModelScope, sel: ScopeSelector, ba: string): void {
  if (scope === 'relation') {
    try { fs.unlinkSync(relationPrefsPath(sel.self!, sel.peerKey!)); } catch { /* already gone */ }
    return;
  }
  writeScope(scope, sel, ba, { model: null, effort: null });
}

// ── 解析：三级优先级 ──────────────────────────────────────────────────

export interface ResolvedChainEntry {
  scope: ModelScope;
  model?: string;
  effort?: string;
  hit: boolean;
}

export interface ResolvedModel {
  model?: string;
  effort?: string;
  source?: ModelScope;
  chain: ResolvedChainEntry[];
}

/**
 * 按 关系>agent>全局 解析实际生效的 model（首个有 model 的作用域命中）。
 * 仅就给定选择器可达的作用域参与：无 peer 不读关系级，无 self 只读全局。
 * 不读 ~/.claude/settings.json，不使用硬编码默认。
 *
 * 运行时（message-processor）每条消息调用本函数，结果直接传入 runQuery，
 * 不缓存、不绑会话——故改关系级/agent级后该范围所有会话下条消息即时生效。
 */
export function resolveEffectiveModel(sel: ScopeSelector, ba?: string): ResolvedModel {
  const baseagent = ba || activeBaseagent(sel.self);
  const order: ModelScope[] = [];
  if (sel.peerKey && sel.self) order.push('relation');
  if (sel.self) order.push('agent');
  order.push('global');

  const chain: ResolvedChainEntry[] = [];
  let resolved: ResolvedModel = { chain };
  for (const scope of order) {
    const prefs = readScope(scope, sel, baseagent);
    const hit = !!prefs.model && resolved.source === undefined;
    chain.push({ scope, model: prefs.model, effort: prefs.effort, hit });
    if (hit) {
      resolved.model = prefs.model;
      resolved.effort = prefs.effort;
      resolved.source = scope;
    }
  }
  return resolved;
}
