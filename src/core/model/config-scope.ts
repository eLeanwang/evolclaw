/**
 * config-scope: 会话配置参数（model/effort/permissionMode）的多作用域读写与解析。
 *
 * 作用域（越具体越优先）：
 *   关系级  >  角色级  >  agent级  >  全局
 *
 * 存储位置：
 *   全局   agents/defaults.json                              → baseagents.<ba>.{model,effort} / roles.<role>
 *   agent  agents/<self>/config.json                         → baseagents.<ba>.{model,effort} / roles.<role>
 *   角色   agents/<self>/config.json 的 roles.<role> 块       → baseagents.<ba>.{model,effort} / permissionMode（内嵌，非独立文件）
 *   关系   agents/<self>/relations/<peerKey>/config.json     → {baseagents/model/effort/permissionMode}
 *
 * 改任一作用域后，对应范围所有会话的下一条消息即时生效
 * （运行时每条消息解析，不缓存、不绑会话）。
 *
 * 角色级是内嵌作用域：不是独立文件，而是 agent/defaults config 内的 roles.<role> 块。
 * 故 readScope('role') 复用 agent/global 的 loader，只是取 roles.<role> 子块。
 *
 * 详见 docs/role-relation-config-plan.md、docs/model-command-design.md。
 */

import fs from 'fs';
import path from 'path';
import { agentRelationsDir, agentConfig as agentConfigPath, resolvePaths } from '../../paths.js';
import { loadDefaults, saveDefaultsSafe, loadAgent, saveAgent } from '../../config-store.js';
import { formatPeerKey, parsePeerKey } from '../relation/peer-identity.js';
import { fileCache } from '../daemon-file-cache.js';
import type { BaseagentsBlock, AgentConfig, DefaultsConfig, RoleOverride } from '../../types.js';

export type ModelScope = 'global' | 'agent' | 'role' | 'relation';

// ── mtime 门控缓存（统一走 FileCache）─────────────────────────────────────
//
// resolveEffectiveModel 每条消息按 关系>agent>全局 解析，原本每次都
// loadAgent()/loadDefaults()/读 preferences.json —— 一条消息最多读盘 5 次。
//
// model-scope 被 CLI 子进程与 daemon 共用，CLI 改文件后 daemon 无失效通知，
// 故靠 mtime 门控：每次只 statSync 比对 mtime，未变用缓存，变了才真正重读 +
// 重解析。跨进程天然正确（文件 mtime 变即感知），改配置即时生效不变；
// statSync 远比 read+JSON.parse 便宜。CLI 进程的 fileCache 是独立空实例、随进程
// 退出，等同直读最新盘值，安全。
//
// config/defaults 与 relation-prefs 三者统一走 daemon 单例 FileCache（消除原先
// 第二套 makeMtimeCache），读取计数一并进监控。config/defaults 的实际读盘 + 解析
// 仍委托原 loadAgent/loadDefaults（保留 atomicRead 崩溃恢复 + expandEnvRefs/校验），
// 故传 noopRead 让 FileCache 只做 mtime 门控、不重复读盘（loader 忽略 raw）。

/** FileCache 的 read 钩子占位：config/defaults 的真实读盘在 loader 里（loadAgent/
 *  loadDefaults，含崩溃恢复），此处返回 null 避免 FileCache 再读一遍。 */
const noopRead = (): string | null => null;

// agent config.json：mtime 门控，per-agent 分组（config:<aid>）便于 per-agent 监控视图。
const loadAgentCached = (self: string): AgentConfig | null =>
  fileCache.get<AgentConfig | null>(
    agentConfigPath(self),
    () => loadAgent(self),
    { policy: 'mtime', group: `config:${self}`, read: noopRead },
  );

// defaults.json：单文件，mtime 门控。
const loadDefaultsCached = (): DefaultsConfig | null =>
  fileCache.get<DefaultsConfig | null>(
    resolvePaths().defaultsConfig,
    () => loadDefaults(),
    { policy: 'mtime', group: 'config', read: noopRead },
  );

// 关系级 config.json —— 走统一 FileCache（mtime 门控，带外改 + 不 reload）。
const readPrefsCached = (file: string): ModelPrefs | null =>
  fileCache.get<ModelPrefs | null>(
    file,
    (raw) => (raw === null ? null : safeParsePrefs(raw)),
    { policy: 'mtime', group: 'relation-prefs' },
  );

function safeParsePrefs(raw: string): ModelPrefs | null {
  try { return JSON.parse(raw) as ModelPrefs; } catch { return null; }
}

/** 关系级配置文件的内容结构（agents/<self>/relations/<peerKey>/config.json） */
export interface ModelPrefs {
  baseagents?: BaseagentsBlock;
  /** 兼容旧扁平结构：顶层 model/effort（新数据写入 baseagents.<ba>） */
  model?: string;
  effort?: string;
  permissionMode?: string;
  updatedAt?: number;
}

/** 作用域选择器：由 CLI 参数解析或运行时上下文得到 */
export interface ScopeSelector {
  /** 本端 aid；缺省 = 全局 */
  self?: string;
  /** 规范化后的 peerKey（channel#urlEncode(id)）；需配 self */
  peerKey?: string;
  /** 角色（owner/admin/guest/anonymous）；需配 self，与 peerKey 不互斥（运行时两者可同时存在） */
  role?: string;
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
 * 由选择器判定**写入目标**作用域（CLI 专用），并校验参数依赖关系。
 * 依赖：peerKey 须配 self；role 须配 self。
 * 运行时解析（resolveEffectiveModel）不用此函数——它在内部按 order 遍历。
 */
export function determineScope(sel: ScopeSelector): ModelScope {
  const hasSelf = !!sel.self;
  const hasPeer = !!sel.peerKey;
  const hasRole = !!sel.role;

  if (hasPeer && !hasSelf) {
    throw new ModelScopeError('PEER_WITHOUT_SELF', '--peer 必须配合 --self 使用');
  }
  if (hasRole && !hasSelf) {
    throw new ModelScopeError('ROLE_WITHOUT_SELF', '--role 必须配合 --self 使用');
  }

  if (hasPeer) return 'relation';
  if (hasRole) return 'role';
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
  return path.join(agentRelationsDir(self), peerKey, 'config.json');
}

/**
 * 读取角色级覆盖块（roles.<role>）。
 * 角色级是内嵌作用域：优先 agent config 的 roles.<role>，回退 defaults 的 roles.<role>。
 * 两者由 mergeForAgent 在 daemon 侧已合并，但本函数被 CLI 子进程也用到，
 * 故直接读两个 loader 并就地浅合并（agent 覆盖 defaults）。
 */
function readRoleOverride(self?: string, role?: string): RoleOverride | undefined {
  if (!role) return undefined;
  try {
    const agentRoles = self ? loadAgentCached(self)?.roles : undefined;
    const globalRoles = loadDefaultsCached()?.roles;
    const a = agentRoles?.[role];
    const g = globalRoles?.[role];
    if (!a && !g) return undefined;
    // 深合并 baseagents：per-baseagent 级别 agent 覆盖 defaults（未覆盖字段继承 defaults）
    const gBa = g?.baseagents || {};
    const aBa = a?.baseagents || {};
    const allBaKeys = new Set([...Object.keys(gBa), ...Object.keys(aBa)]);
    const mergedBa: Record<string, any> = {};
    for (const ba of allBaKeys) {
      mergedBa[ba] = { ...((gBa as any)[ba] || {}), ...((aBa as any)[ba] || {}) };
    }
    return {
      baseagents: allBaKeys.size > 0 ? mergedBa as any : undefined,
      permissionMode: a?.permissionMode ?? g?.permissionMode,
    };
  } catch {
    return undefined;  // 配置缺失/损坏时按"无角色覆盖"处理，绝不抛出（per-message 调用）
  }
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

/** 读取指定作用域当前存的 {model,effort}（未设为空对象）。不抛出——运行时 per-message 调用。 */
export function readScope(scope: ModelScope, sel: ScopeSelector, ba: string): ModelPrefs {
  try {
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
      case 'role': {
        const ov = readRoleOverride(sel.self, sel.role);
        const c = ((ov?.baseagents || {}) as any)[ba] || {};
        return { model: c.model, effort: c[effortField(ba)], permissionMode: ov?.permissionMode };
      }
      case 'relation': {
        const p = readPrefsCached(relationPrefsPath(sel.self!, sel.peerKey!));
        // 新结构：baseagents.<ba>.{model,effort}；兼容旧扁平结构顶层 model/effort
        const c = ((p?.baseagents || {}) as any)[ba] || {};
        return {
          model: c.model ?? p?.model,
          effort: c[effortField(ba)] ?? p?.effort,
          permissionMode: p?.permissionMode,
        };
      }
    }
  } catch {
    // 配置缺失/损坏时返回空（运行时 per-message 调用不应中断处理）
    return { model: undefined, effort: undefined, permissionMode: undefined };
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
    case 'role':
      writeRoleBlock(sel, ba, patch);
      return;
    case 'relation':
      writeRelationFile(relationPrefsPath(sel.self!, sel.peerKey!), ba, patch);
      return;
  }
}

/** 写角色级：agent config.json 的 roles.<role>.baseagents.<ba>.{model,effort} */
function writeRoleBlock(
  sel: ScopeSelector,
  ba: string,
  patch: { model?: string | null; effort?: string | null },
): void {
  const cfg = loadAgent(sel.self!);
  if (!cfg) throw new ModelScopeError('AGENT_NOT_FOUND', `agent 不存在: ${sel.self}`);
  const ef = effortField(ba);
  cfg.roles = cfg.roles || {};
  const ov = (cfg.roles[sel.role!] = cfg.roles[sel.role!] || {});
  ov.baseagents = ov.baseagents || {};
  (ov.baseagents as any)[ba] = (ov.baseagents as any)[ba] || {};
  const sub = (ov.baseagents as any)[ba];
  if (patch.model === null) delete sub.model;
  else if (patch.model !== undefined) sub.model = patch.model;
  if (patch.effort === null) delete sub[ef];
  else if (patch.effort !== undefined) sub[ef] = patch.effort;
  saveAgent(cfg);
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

/** 写关系级 config.json：baseagents.<ba>.{model,effort}（新结构）。 */
function writeRelationFile(
  file: string,
  ba: string,
  patch: { model?: string | null; effort?: string | null },
): void {
  const cur = readJsonSafe(file) || {};
  const ef = effortField(ba);
  cur.baseagents = cur.baseagents || {};
  (cur.baseagents as any)[ba] = (cur.baseagents as any)[ba] || {};
  const sub = (cur.baseagents as any)[ba];
  if (patch.model === null) delete sub.model;
  else if (patch.model !== undefined) sub.model = patch.model;
  if (patch.effort === null) delete sub[ef];
  else if (patch.effort !== undefined) sub[ef] = patch.effort;
  // 清理旧扁平字段（迁移）
  delete cur.model;
  delete cur.effort;
  cur.updatedAt = Date.now();
  writeJsonAtomic(file, cur);
}

/** 写关系级 permissionMode（供 /perm 命令使用）。null 删除字段。 */
export function writeRelationPermissionMode(self: string, peerKey: string, mode: string | null): void {
  const file = relationPrefsPath(self, peerKey);
  const cur = readJsonSafe(file) || {};
  if (mode === null) delete cur.permissionMode;
  else cur.permissionMode = mode;
  cur.updatedAt = Date.now();
  writeJsonAtomic(file, cur);
}

// ── 清除：单作用域 ────────────────────────────────────────────────────

/** 清除指定作用域的 model+effort。
 * 关系级：只清 model/effort 字段（保留 permissionMode 等其他字段），文件不删。
 */
export function clearScope(scope: ModelScope, sel: ScopeSelector, ba: string): void {
  writeScope(scope, sel, ba, { model: null, effort: null });
}

// ── permissionMode 内置出厂默认（角色派生，沉到链条最底）──────────────────
//
// 仅当 关系/角色/agent/全局 全链皆空时兜底。区别于 owner 显式写的 roles.<role>：
// 显式角色文件坐在解析链里（更具体者优先），出厂默认沉底当安全网。
const BUILTIN_PERMISSION_BY_ROLE: Record<string, string> = {
  owner: 'bypass',
  admin: 'bypass',
  guest: 'readonly',
  anonymous: 'readonly',
};
const FALLBACK_PERMISSION_MODE = 'auto';

/**
 * 解析实际生效的 permissionMode。不抛出——运行时 per-message 调用。
 * 链：关系 > 角色(roles.<role>) > agent顶层(暂无) > 全局(暂无) > 出厂默认[role] > 'auto'
 * 当前 permissionMode 只在关系级与角色级存储；agent/全局顶层暂不设此字段。
 */
export function resolvePermissionMode(sel: ScopeSelector): string {
  try {
    // 关系级（需要 self + peerKey 定位文件）
    if (sel.peerKey && sel.self) {
      const p = readPrefsCached(relationPrefsPath(sel.self, sel.peerKey));
      if (p?.permissionMode) return p.permissionMode;
    }
    // 角色级：readRoleOverride 自身已处理 self 为 undefined 的情况（读 defaults.roles）
    if (sel.role) {
      const ov = readRoleOverride(sel.self, sel.role);
      if (ov?.permissionMode) return ov.permissionMode;
    }
    // 出厂默认（按角色）→ 最终兜底
    if (sel.role && BUILTIN_PERMISSION_BY_ROLE[sel.role]) {
      return BUILTIN_PERMISSION_BY_ROLE[sel.role];
    }
    return FALLBACK_PERMISSION_MODE;
  } catch {
    // 配置损坏时返回安全兜底（按角色 builtin，再兜 auto）
    if (sel.role && BUILTIN_PERMISSION_BY_ROLE[sel.role]) {
      return BUILTIN_PERMISSION_BY_ROLE[sel.role];
    }
    return FALLBACK_PERMISSION_MODE;
  }
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
  source?: ModelScope;       // model 的来源作用域
  effortSource?: ModelScope; // effort 的来源作用域（独立于 model）
  chain: ResolvedChainEntry[];
}

/**
 * 按 关系>角色>agent>全局 解析实际生效的 model/effort。
 * model 和 effort 各自独立回退（关系级只设 model 时，effort 继续向下找）。
 * 仅就给定选择器可达的作用域参与：无 peer 不读关系级，无 role 不读角色级，无 self 只读全局。
 * 不读 ~/.claude/settings.json，不使用硬编码默认（到顶为 undefined，交 SDK）。
 *
 * 运行时（message-processor）每条消息调用本函数，结果直接传入 runQuery，
 * 不缓存、不绑会话——故改任一作用域后该范围所有会话下条消息即时生效。
 */
export function resolveEffectiveModel(sel: ScopeSelector, ba?: string): ResolvedModel {
  const baseagent = ba || activeBaseagent(sel.self);
  const order: ModelScope[] = [];
  if (sel.peerKey && sel.self) order.push('relation');
  if (sel.role && sel.self) order.push('role');
  if (sel.self) order.push('agent');
  order.push('global');

  const chain: ResolvedChainEntry[] = [];
  const resolved: ResolvedModel = { chain };
  for (const scope of order) {
    const prefs = readScope(scope, sel, baseagent);
    const modelHit = !!prefs.model && resolved.model === undefined;
    const effortHit = !!prefs.effort && resolved.effort === undefined;
    // hit 标记表示 model 命中（保留向后兼容的语义）
    chain.push({ scope, model: prefs.model, effort: prefs.effort, hit: modelHit });
    if (modelHit) {
      resolved.model = prefs.model;
      resolved.source = scope;  // source 仍指 model 来源
    }
    if (effortHit) {
      resolved.effort = prefs.effort;
      resolved.effortSource = scope;
    }
  }
  return resolved;
}
