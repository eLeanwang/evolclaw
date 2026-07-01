/**
 * config-scope: 会话配置参数（model/effort/permissionMode）的多作用域读写与解析。
 *
 * 所有配置参数统一存储在 config.json/defaults.json/relation config.json 中。
 * 本模块是面向 CLI / 运行时的薄封装，把"作用域 + baseagent"语义映射到 ConfigManager。
 *
 * 作用域（越具体越优先）：关系 > 角色 > agent > global。
 *   global agents/defaults.json                                  → baseagents.<ba>.{model,effort}
 *   agent  agents/<self>/config.json                             → baseagents.<ba>.{model,effort}
 *   角色   agents/<self>/config.json 的 roles.<role> 块            → baseagents / permissionMode（内嵌）
 *   关系   agents/<self>/relations/<peerKey>/config.json          → baseagents / permissionMode
 *
 * 改任一作用域后，对应范围所有会话的下一条消息即时生效（运行时每条消息解析，不缓存）。
 *
 * 详见 docs/config/
 */

import { formatPeerKey, parsePeerKey } from '../relation/peer-identity.js';
import {
  ConfigTarget, ensureFile, read, resolveEffective, write,
} from '../../config/config-manager.js';
import type { AgentConfig, DefaultsConfig, RelationConfig, RoleOverride } from '../../types.js';

export type ModelScope = 'global' | 'agent' | 'role' | 'relation';

/** 关系级/角色级读出的 {model,effort,permissionMode} 视图。 */
export interface ModelPrefs {
  baseagents?: Record<string, any>;
  model?: string;
  effort?: string;
  permissionMode?: string;
  updatedAt?: number;
}

/** 作用域选择器：由 CLI 参数解析或运行时上下文得到 */
export interface ScopeSelector {
  self?: string;
  peerKey?: string;
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
 *   - `channelType#channelId`（统一 round-trip 重编码）
 *   - 裸 aid（无 '#'）→ 视为 `aun#<aid>`
 */
export function normalizePeer(input: string): string {
  const raw = (input || '').trim();
  if (!raw) throw new ModelScopeError('INVALID_PEER', '--peer 不能为空');
  if (raw.includes('#')) {
    let parsed: { channelType: string; channelId: string };
    try { parsed = parsePeerKey(raw); }
    catch { throw new ModelScopeError('INVALID_PEER', `无法解析 --peer: ${raw}`); }
    if (!parsed.channelType || !parsed.channelId) {
      throw new ModelScopeError('INVALID_PEER', `无法解析 --peer: ${raw}`);
    }
    return formatPeerKey(parsed.channelType, parsed.channelId);
  }
  return formatPeerKey('aun', raw);
}

// ── 作用域判定（CLI 写入目标）─────────────────────────────────────────────

/**
 * 由选择器判定**写入目标**作用域。依赖：peerKey/role 须配 self。
 * 运行时解析（resolveEffectiveModel）不用此函数——它在内部按 order 遍历。
 */
export function determineScope(sel: ScopeSelector): ModelScope {
  const hasSelf = !!sel.self;
  if (sel.peerKey && !hasSelf) throw new ModelScopeError('PEER_WITHOUT_SELF', '--peer 必须配合 --self 使用');
  if (sel.role && !hasSelf) throw new ModelScopeError('ROLE_WITHOUT_SELF', '--role 必须配合 --self 使用');
  if (sel.peerKey) return 'relation';
  if (sel.role) return 'role';
  if (hasSelf) return 'agent';
  return 'global';
}

// ── baseagent 解析 ───────────────────────────────────────────────────────

/** 取本端的活跃 baseagent（从 agent/config 读 active_baseagent）；缺省 'claude'。 */
export function activeBaseagent(self?: string): string {
  try {
    if (self) {
      const config = resolveEffective({ self }, { cache: true });
      if (config.active_baseagent) return config.active_baseagent;
    } else {
      const defaults = read<DefaultsConfig>(ConfigTarget.Defaults, undefined, { cache: true });
      if (defaults?.active_baseagent) return defaults.active_baseagent;
    }
  } catch { /* fall through */ }
  return 'claude';
}

// ── 读：单作用域 ──────────────────────────────────────────────────────

/** 读取指定作用域当前存的 {model,effort,permissionMode}（未设为空对象）。不抛出。 */
export function readScope(scope: ModelScope, sel: ScopeSelector, ba: string): ModelPrefs {
  try {
    switch (scope) {
      case 'global': {
        const c = read<DefaultsConfig>(ConfigTarget.Defaults, undefined, { cache: true });
        return prefsFromConfig(c, ba);
      }
      case 'agent': {
        const c = sel.self ? read<AgentConfig>(ConfigTarget.Agent, { self: sel.self }, { cache: true }) : null;
        return prefsFromConfig(c, ba);
      }
      case 'role': {
        const config = sel.self ? read<AgentConfig>(ConfigTarget.Agent, { self: sel.self }, { cache: true }) : null;
        const ov = (config?.roles || {})[sel.role!] as RoleOverride | undefined;
        const baConfig = ((ov?.baseagents || {}) as any)[ba] || {};
        return { model: baConfig.model, effort: baConfig.effort ?? baConfig.reasoning, permissionMode: ov?.permissionMode };
      }
      case 'relation': {
        const c = (sel.self && sel.peerKey)
          ? read<RelationConfig>(ConfigTarget.Relation, { self: sel.self, peerKey: sel.peerKey }, { cache: true })
          : null;
        return prefsFromConfig(c, ba);
      }
    }
  } catch {
    return {};
  }
}

// ── 写：单作用域 ──────────────────────────────────────────────────────

/** 写入指定作用域。patch 中 undefined 不动；显式 null 删除字段。 */
export function writeScope(
  scope: ModelScope,
  sel: ScopeSelector,
  ba: string,
  patch: { model?: string | null; effort?: string | null },
): void {
  if (scope === 'global') {
    const cur = mutableDefaultsConfig();
    applyBaPatch(cur, ba, patch);
    write(ConfigTarget.Defaults, cur);
    return;
  }
  if (scope === 'agent') {
    requireSelf(sel);
    const cur = mutableAgentConfig(sel.self!);
    applyBaPatch(cur, ba, patch);
    write(ConfigTarget.Agent, cur, { self: sel.self! });
    return;
  }
  if (scope === 'role') {
    requireSelf(sel);
    const cur = mutableAgentConfig(sel.self!);
    cur.roles = cur.roles || {};
    const ov: RoleOverride = (cur.roles[sel.role!] = cur.roles[sel.role!] || {});
    ov.baseagents = ov.baseagents || {};
    applyBaPatchTo(ov.baseagents as any, ba, patch);
    write(ConfigTarget.Agent, cur, { self: sel.self! });
    return;
  }
  // relation
  requirePeer(sel);
  const cur = mutableRelationConfig(sel.self!, sel.peerKey!);
  applyBaPatch(cur, ba, patch);
  write(ConfigTarget.Relation, cur, { self: sel.self!, peerKey: sel.peerKey! });
}

type ModelConfigBlock = {
  baseagents?: Record<string, any>;
  permissionMode?: string;
  roles?: Record<string, RoleOverride>;
};

function applyBaPatch(cfg: ModelConfigBlock, ba: string, patch: { model?: string | null; effort?: string | null }): void {
  cfg.baseagents = cfg.baseagents || {};
  applyBaPatchTo(cfg.baseagents as any, ba, patch);
}
function applyBaPatchTo(block: Record<string, any>, ba: string, patch: { model?: string | null; effort?: string | null }): void {
  block[ba] = block[ba] || {};
  const sub = block[ba];
  if (patch.model === null) delete sub.model;
  else if (patch.model !== undefined) sub.model = patch.model;
  if (patch.effort === null) {
    delete sub.effort;
    delete sub.reasoning;
  } else if (patch.effort !== undefined) {
    sub.effort = patch.effort;
    delete sub.reasoning;
  }
}

/** 写关系级 permissionMode（供 /perm 命令使用）。null 删除字段。 */
export function writeRelationPermissionMode(self: string, peerKey: string, mode: string | null): void {
  const cur = mutableRelationConfig(self, peerKey);
  if (mode === null) delete cur.permissionMode;
  else cur.permissionMode = mode;
  write(ConfigTarget.Relation, cur, { self, peerKey });
}

// ── 清除：单作用域 ────────────────────────────────────────────────────

/** 清除指定作用域的 model+effort（保留 permissionMode 等其他字段）。 */
export function clearScope(scope: ModelScope, sel: ScopeSelector, ba: string): void {
  writeScope(scope, sel, ba, { model: null, effort: null });
}

// ── permissionMode 解析 ────────────────────────────────────────────────────

const BUILTIN_PERMISSION_BY_ROLE: Record<string, string> = {
  owner: 'bypass', admin: 'bypass', guest: 'readonly', anonymous: 'readonly',
};
const FALLBACK_PERMISSION_MODE = 'auto';

/**
 * 解析实际生效的 permissionMode。不抛出——运行时 per-message 调用。
 * 链：关系 > 角色(roles.<role>) > 出厂默认[role] > 'auto'。
 */
export function resolvePermissionMode(sel: ScopeSelector): string {
  try {
    const relation = sel.self && sel.peerKey ? readScope('relation', sel, activeBaseagent(sel.self)) : {};
    if (relation.permissionMode) return relation.permissionMode;
    const role = sel.self && sel.role ? readScope('role', sel, activeBaseagent(sel.self)) : {};
    if (role.permissionMode) return role.permissionMode;
    if (sel.role && BUILTIN_PERMISSION_BY_ROLE[sel.role]) return BUILTIN_PERMISSION_BY_ROLE[sel.role];
    return FALLBACK_PERMISSION_MODE;
  } catch {
    if (sel.role && BUILTIN_PERMISSION_BY_ROLE[sel.role]) return BUILTIN_PERMISSION_BY_ROLE[sel.role];
    return FALLBACK_PERMISSION_MODE;
  }
}

// ── 解析：多级优先级（model/effort）──────────────────────────────────────────

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
  effortSource?: ModelScope;
  chain: ResolvedChainEntry[];
}

/**
 * 按 关系>角色>agent>global 解析实际生效的 model/effort。
 * final 值遵循 ConfigManager 覆盖链语义；chain 逐层展示可见来源。
 * chain 仅就可达作用域逐层展示（用于 CLI 来源标注）。
 */
export function resolveEffectiveModel(sel: ScopeSelector, ba?: string): ResolvedModel {
  const baseagent = ba || activeBaseagent(sel.self);

  // 逐层 chain（仅展示；命中标记按从高到低首个非空）
  const order: ModelScope[] = [];
  if (sel.peerKey && sel.self) order.push('relation');
  if (sel.role && sel.self) order.push('role');
  if (sel.self) order.push('agent');
  order.push('global');

  const chain: ResolvedChainEntry[] = [];
  let modelSource: ModelScope | undefined;
  let effortSource: ModelScope | undefined;
  let finalModel: string | undefined;
  let finalEffort: string | undefined;
  for (const scope of order) {
    const prefs = readScope(scope, sel, baseagent);
    const modelHit = !!prefs.model && modelSource === undefined;
    if (modelHit) modelSource = scope;
    if (modelHit) finalModel = prefs.model;
    const effortHit = !!prefs.effort && effortSource === undefined;
    if (effortHit) effortSource = scope;
    if (effortHit) finalEffort = prefs.effort;
    chain.push({ scope, model: prefs.model, effort: prefs.effort, hit: modelHit });
  }

  return {
    model: finalModel,
    effort: finalEffort,
    source: modelSource,
    effortSource,
    chain,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function requireSelf(sel: ScopeSelector): void {
  if (!sel.self) throw new ModelScopeError('AGENT_NOT_FOUND', 'agent 作用域需要 --self');
}
function requirePeer(sel: ScopeSelector): void {
  if (!sel.self || !sel.peerKey) throw new ModelScopeError('PEER_WITHOUT_SELF', '关系作用域需要 --self + --peer');
}

function prefsFromConfig(config: ModelConfigBlock | null | undefined, ba: string): ModelPrefs {
  const c = ((config?.baseagents || {}) as any)[ba] || {};
  return {
    model: c.model,
    effort: c.effort ?? c.reasoning,
    permissionMode: config?.permissionMode,
  };
}

function mutableDefaultsConfig(): DefaultsConfig {
  ensureFile(ConfigTarget.Defaults);
  return read<DefaultsConfig>(ConfigTarget.Defaults) || { $schema_version: 1 };
}

function mutableAgentConfig(self: string): AgentConfig {
  ensureFile(ConfigTarget.Agent, { self });
  const cur = read<AgentConfig>(ConfigTarget.Agent, { self });
  if (!cur) throw new ModelScopeError('AGENT_NOT_FOUND', `agent 配置不存在: ${self}`);
  return cur;
}

function mutableRelationConfig(self: string, peerKey: string): RelationConfig {
  ensureFile(ConfigTarget.Relation, { self, peerKey });
  return read<RelationConfig>(ConfigTarget.Relation, { self, peerKey }) || { $schema_version: 1 };
}
