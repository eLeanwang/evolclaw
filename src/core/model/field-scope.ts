/**
 * field-scope: 顶层配置字段的多作用域读写（通用框架）。
 *
 * 与 config-scope.ts（model 专用，深耦合 baseagents/behavior.json）互补：
 *   - config-scope：model/effort/permissionMode → behavior.json 的嵌套结构
 *   - field-scope：顶层字段（如 response_modes）→ config.json（H 链）
 *
 * 复用 config-scope 的作用域判定与 peer 归一化（同一套语义，不重复造）。
 *
 * 作用域（越具体越优先）：关系 > agent > 全局(defaults)。
 *   defaults  agents/defaults.json
 *   agent     agents/<self>/config.json
 *   relation  agents/<self>/relations/<peerKey>/config.json
 *
 * 读写单个顶层字段：read-modify-write（整文件读出 → 改字段 → 写回，带 schema 校验）。
 * 改任一作用域后，对应范围所有会话的下一条消息即时生效（运行时每条消息解析）。
 */

import { ConfigTarget, read, write } from '../../config/config-manager.js';
import { normalizePeer, determineScope, ModelScopeError, type ScopeSelector } from './config-scope.js';
import type { AgentConfig, RelationConfig, DefaultsConfig } from '../../types.js';

/** 作用域（与 config-scope 的 ModelScope 对齐，去掉 role——顶层字段无角色级） */
export type FieldScope = 'defaults' | 'agent' | 'relation';

/** 把 ScopeSelector 映射到 FieldScope（顶层字段不支持 role 级，role 视为 agent 级） */
export function determineFieldScope(sel: ScopeSelector): FieldScope {
  const scope = determineScope(sel);
  if (scope === 'global') return 'defaults';
  if (scope === 'role') return 'agent'; // 顶层字段无角色级，落 agent
  return scope; // 'agent' | 'relation'
}

/** scope → ConfigTarget */
function targetFor(scope: FieldScope): ConfigTarget {
  switch (scope) {
    case 'defaults': return ConfigTarget.Defaults;
    case 'agent': return ConfigTarget.Agent;
    case 'relation': return ConfigTarget.Relation;
  }
}

type AnyConfig = AgentConfig | RelationConfig | DefaultsConfig;

/**
 * 读取指定作用域的某个顶层字段（未设返回 undefined）。不抛出。
 */
export function readField<T = any>(scope: FieldScope, sel: ScopeSelector, field: string): T | undefined {
  try {
    const target = targetFor(scope);
    const cfg = read<AnyConfig>(target, sel, { cache: true });
    return cfg ? (cfg as any)[field] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写入指定作用域的某个顶层字段（read-modify-write，带 schema 校验）。
 * value 为 undefined 时删除该字段。
 */
export function writeField(scope: FieldScope, sel: ScopeSelector, field: string, value: any): void {
  if (scope === 'agent' && !sel.self) {
    throw new ModelScopeError('SELF_REQUIRED', 'agent 作用域必须提供 --self');
  }
  if (scope === 'relation' && (!sel.self || !sel.peerKey)) {
    throw new ModelScopeError('PEER_WITHOUT_SELF', 'relation 作用域必须提供 --self 和 --peer');
  }

  const target = targetFor(scope);
  const cur = (read<AnyConfig>(target, sel) || {}) as any;

  if (value === undefined) {
    delete cur[field];
  } else {
    cur[field] = value;
  }

  write(target, cur, sel);
}

/**
 * 清除指定作用域的某个顶层字段（等价于 writeField(..., undefined)）。
 */
export function clearField(scope: FieldScope, sel: ScopeSelector, field: string): void {
  writeField(scope, sel, field, undefined);
}

// re-export 复用 config-scope 的 peer 归一化（同一套语义）
export { normalizePeer, ModelScopeError, type ScopeSelector };
