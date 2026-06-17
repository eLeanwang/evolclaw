/**
 * config-scope: 会话配置参数（model/effort/permissionMode）的多作用域读写与解析。
 *
 * 配置体系 v2 后：model/effort/permissionMode/roles 是 HA 字段，落 behavior.json。
 * 存储经 ConfigManager（全项目唯一合并实现点）。本模块是面向 CLI / 运行时的薄封装：
 * 把"作用域 + baseagent"语义映射到 behavior 链的读写。
 *
 * 作用域（越具体越优先）：关系 > 角色 > agent。
 *   agent  agents/<self>/behavior.json                          → baseagents.<ba>.{model,effort}
 *   角色   agents/<self>/behavior.json 的 roles.<role> 块         → baseagents / permissionMode（内嵌）
 *   关系   agents/<self>/relations/<peerKey>/behavior.json       → baseagents / permissionMode
 *   global（历史保留）：HA 链无 defaults 层——全局 model 作用域已退场，只读 agent 兜底。
 *
 * 改任一作用域后，对应范围所有会话的下一条消息即时生效（运行时每条消息解析，不缓存）。
 *
 * 详见 docs/config-system-design-v2.md（§七 HA 链 + 角色层）、docs/model-command-design.md。
 */

import { formatPeerKey, parsePeerKey } from '../relation/peer-identity.js';
import {
  ConfigTarget, read, write, ensureFile, resolveBehavior,
  type Selector,
} from '../../config/config-manager.js';
import type { BehaviorConfig, RoleOverride } from '../../types.js';

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

/** 取本端的活跃 baseagent（从 agent/behavior 读 active_baseagent）；缺省 'claude'。 */
export function activeBaseagent(self?: string): string {
  try {
    if (self) {
      const b = read<BehaviorConfig>(ConfigTarget.AgentBehavior, { self }, { cache: true });
      if (b?.active_baseagent) return b.active_baseagent;
    }
  } catch { /* fall through */ }
  return 'claude';
}

/** codex 的推理强度字段名是 reasoning，其余是 effort。 */
function effortField(ba: string): 'effort' | 'reasoning' {
  return ba === 'codex' ? 'reasoning' : 'effort';
}

// ── 读：单作用域 ──────────────────────────────────────────────────────

/** 读取指定作用域当前存的 {model,effort,permissionMode}（未设为空对象）。不抛出。 */
export function readScope(scope: ModelScope, sel: ScopeSelector, ba: string): ModelPrefs {
  const ef = effortField(ba);
  try {
    switch (scope) {
      case 'global':
        // HA 链无 defaults 层——全局 model 作用域已退场，返回空。
        return {};
      case 'agent': {
        const b = sel.self ? read<BehaviorConfig>(ConfigTarget.AgentBehavior, { self: sel.self }, { cache: true }) : null;
        const c = ((b?.baseagents || {}) as any)[ba] || {};
        return { model: c.model, effort: c[ef] };
      }
      case 'role': {
        const b = sel.self ? read<BehaviorConfig>(ConfigTarget.AgentBehavior, { self: sel.self }, { cache: true }) : null;
        const ov = (b?.roles || {})[sel.role!] as RoleOverride | undefined;
        const c = ((ov?.baseagents || {}) as any)[ba] || {};
        return { model: c.model, effort: c[ef], permissionMode: ov?.permissionMode };
      }
      case 'relation': {
        const b = (sel.self && sel.peerKey)
          ? read<BehaviorConfig>(ConfigTarget.RelationBehavior, { self: sel.self, peerKey: sel.peerKey }, { cache: true })
          : null;
        const c = ((b?.baseagents || {}) as any)[ba] || {};
        return { model: c.model, effort: c[ef], permissionMode: b?.permissionMode };
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
  const ef = effortField(ba);
  if (scope === 'global') {
    throw new ModelScopeError('NO_GLOBAL_SCOPE', 'HA 链无 defaults 层：model/effort 请用 --self 逐 agent 设置');
  }
  if (scope === 'agent') {
    requireSelf(sel);
    const target = ConfigTarget.AgentBehavior;
    const cur = (read<BehaviorConfig>(target, { self: sel.self }) as BehaviorConfig) || {};
    applyBaPatch(cur, ba, ef, patch);
    ensureFile(target, { self: sel.self });
    write(target, cur, { self: sel.self });
    return;
  }
  if (scope === 'role') {
    requireSelf(sel);
    const target = ConfigTarget.AgentBehavior;
    const cur = (read<BehaviorConfig>(target, { self: sel.self }) as BehaviorConfig) || {};
    cur.roles = cur.roles || {};
    const ov: RoleOverride = (cur.roles[sel.role!] = cur.roles[sel.role!] || {});
    ov.baseagents = ov.baseagents || {};
    applyBaPatchTo(ov.baseagents as any, ba, ef, patch);
    ensureFile(target, { self: sel.self });
    write(target, cur, { self: sel.self });
    return;
  }
  // relation
  requirePeer(sel);
  const target = ConfigTarget.RelationBehavior;
  const selr: Selector = { self: sel.self, peerKey: sel.peerKey };
  const cur = (read<BehaviorConfig>(target, selr) as BehaviorConfig) || {};
  applyBaPatch(cur, ba, ef, patch);
  ensureFile(target, selr);
  write(target, cur, selr);
}

function applyBaPatch(cfg: BehaviorConfig, ba: string, ef: string, patch: { model?: string | null; effort?: string | null }): void {
  cfg.baseagents = cfg.baseagents || {};
  applyBaPatchTo(cfg.baseagents as any, ba, ef, patch);
}
function applyBaPatchTo(block: Record<string, any>, ba: string, ef: string, patch: { model?: string | null; effort?: string | null }): void {
  block[ba] = block[ba] || {};
  const sub = block[ba];
  if (patch.model === null) delete sub.model;
  else if (patch.model !== undefined) sub.model = patch.model;
  if (patch.effort === null) delete sub[ef];
  else if (patch.effort !== undefined) sub[ef] = patch.effort;
}

/** 写关系级 permissionMode（供 /perm 命令使用）。null 删除字段。 */
export function writeRelationPermissionMode(self: string, peerKey: string, mode: string | null): void {
  const target = ConfigTarget.RelationBehavior;
  const sel: Selector = { self, peerKey };
  const cur = (read<BehaviorConfig>(target, sel) as BehaviorConfig) || {};
  if (mode === null) delete cur.permissionMode;
  else cur.permissionMode = mode;
  ensureFile(target, sel);
  write(target, cur, sel);
}

// ── 清除：单作用域 ────────────────────────────────────────────────────

/** 清除指定作用域的 model+effort（保留 permissionMode 等其他字段）。 */
export function clearScope(scope: ModelScope, sel: ScopeSelector, ba: string): void {
  if (scope === 'global') return;
  writeScope(scope, sel, ba, { model: null, effort: null });
}

// ── permissionMode 解析 ────────────────────────────────────────────────────

const BUILTIN_PERMISSION_BY_ROLE: Record<string, string> = {
  owner: 'bypass', admin: 'bypass', guest: 'readonly', anonymous: 'readonly',
};
const FALLBACK_PERMISSION_MODE = 'auto';

/**
 * 解析实际生效的 permissionMode。不抛出——运行时 per-message 调用。
 * 链：关系 > 角色(roles.<role>) > agent > 出厂默认[role] > 'auto'。
 * 经 ConfigManager.resolveBehavior（含角色层）取合并后的 permissionMode。
 */
export function resolvePermissionMode(sel: ScopeSelector): string {
  try {
    const beh = resolveBehavior(toSelector(sel), { cache: true });
    if (beh.permissionMode) return beh.permissionMode;
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
 * 按 关系>角色>agent 解析实际生效的 model/effort（model 与 effort 各自独立回退）。
 * 经 ConfigManager.resolveBehavior（HA 链含角色层）取合并后的 baseagents.<ba>。
 * chain 仅就可达作用域逐层展示（用于 CLI 来源标注）。
 */
export function resolveEffectiveModel(sel: ScopeSelector, ba?: string): ResolvedModel {
  const baseagent = ba || activeBaseagent(sel.self);
  const ef = effortField(baseagent);

  // 合并后的最终值（含角色层）
  const beh = safeResolveBehavior(toSelector(sel));
  const mergedBa = ((beh.baseagents || {}) as any)[baseagent] || {};
  const finalModel: string | undefined = mergedBa.model;
  const finalEffort: string | undefined = mergedBa[ef];

  // 逐层 chain（仅展示；命中标记按从高到低首个非空）
  const order: ModelScope[] = [];
  if (sel.peerKey && sel.self) order.push('relation');
  if (sel.role && sel.self) order.push('role');
  if (sel.self) order.push('agent');

  const chain: ResolvedChainEntry[] = [];
  let modelSource: ModelScope | undefined;
  let effortSource: ModelScope | undefined;
  for (const scope of order) {
    const prefs = readScope(scope, sel, baseagent);
    const modelHit = !!prefs.model && modelSource === undefined;
    if (modelHit) modelSource = scope;
    if (!!prefs.effort && effortSource === undefined) effortSource = scope;
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

function toSelector(sel: ScopeSelector): Selector {
  return { self: sel.self, peerKey: sel.peerKey, role: sel.role };
}
function safeResolveBehavior(sel: Selector): BehaviorConfig {
  try { return resolveBehavior(sel, { cache: true }); } catch { return {}; }
}
function requireSelf(sel: ScopeSelector): void {
  if (!sel.self) throw new ModelScopeError('AGENT_NOT_FOUND', 'agent 作用域需要 --self');
}
function requirePeer(sel: ScopeSelector): void {
  if (!sel.self || !sel.peerKey) throw new ModelScopeError('PEER_WITHOUT_SELF', '关系作用域需要 --self + --peer');
}
