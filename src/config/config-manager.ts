/**
 * ConfigManager —— 所有配置文件读写/合并的统一归口（全项目唯一合并实现点）。
 *
 * 不允许散落的 fs.readFileSync 直接操作配置文件。
 *
 * H 覆盖链：defaults.json → agent/config.json → relation/config.json。
 * HA 行为链：agent/behavior.json → role → relation/behavior.json。
 * 进程级 evolclaw.json：独立，不参与覆盖链。
 *
 * 详见 docs/config/01-overview.md
 */

import fs from 'fs';
import path from 'path';
import {
  resolvePaths,
  agentConfig as agentConfigPath,
  agentBehaviorConfig,
  agentRelationConfig,
  agentRelationBehaviorConfig,
  agentDir,
  agentRelationsDir,
} from '../paths.js';
import { atomicReadJson, atomicWriteJson } from '../utils/atomic-write.js';
import { fileCache } from '../core/daemon-file-cache.js';
import {
  loadSchema,
  currentVersion,
  type LogicalSchemaName,
  type SchemaEntry,
} from './schema-registry.js';
import { mergeLayers, expandVars, buildEnvResolver, type EnvScope } from './merge.js';
import { mergeBehaviorIntoEffective } from './behavior.js';
import { normalizeAgentLifecycle } from './lifecycle.js';
import { resolveUserRole } from './role-resolver.js';
import { mergeWithRoleConstraints } from './role-constraints.js';
import type {
  ProcessConfig,
  DefaultsConfig,
  AgentConfig,
  RelationConfig,
  EffectiveAgentConfig,
} from '../types.js';

export enum ConfigTarget {
  Process = 'process',                  // evolclaw.json（独立）
  Defaults = 'defaults',                // agents/defaults.json
  Agent = 'agent',                      // agents/{aid}/config.json
  Relation = 'relation',                // agents/{aid}/relations/{peerKey}/config.json
  Behavior = 'behavior',                // agents/{aid}/behavior.json
  RelationBehavior = 'relation-behavior', // agents/{aid}/relations/{peerKey}/behavior.json
}

export interface Selector {
  self?: string;
  peerKey?: string;
  role?: string;
}

const TARGET_SCHEMA: Record<ConfigTarget, LogicalSchemaName> = {
  [ConfigTarget.Process]: 'evolclaw',
  [ConfigTarget.Defaults]: 'defaults',
  [ConfigTarget.Agent]: 'agent-config',
  [ConfigTarget.Relation]: 'relation-config',
  [ConfigTarget.Behavior]: 'behavior',
  [ConfigTarget.RelationBehavior]: 'behavior',
};

export class ConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

let _initialized = false;
/** ConfigManager 初始化（预留扩展点）。幂等。 */
export function initConfigManager(): void {
  if (_initialized) return;
  // 初始化逻辑（如需要）
  _initialized = true;
}

// ── 路径解析 ──────────────────────────────────────────────────────────────

function targetPath(target: ConfigTarget, sel?: Selector): string {
  const p = resolvePaths();
  switch (target) {
    case ConfigTarget.Process: return p.evolclawJson;
    case ConfigTarget.Defaults: return p.defaultsConfig;
    case ConfigTarget.Agent:
      requireSelf(sel, target);
      return agentConfigPath(sel!.self!);
    case ConfigTarget.Relation:
      requirePeer(sel, target);
      return agentRelationConfig(sel!.self!, sel!.peerKey!);
    case ConfigTarget.Behavior:
      requireSelf(sel, target);
      return agentBehaviorConfig(sel!.self!);
    case ConfigTarget.RelationBehavior:
      requirePeer(sel, target);
      return agentRelationBehaviorConfig(sel!.self!, sel!.peerKey!);
  }
}

function requireSelf(sel: Selector | undefined, target: ConfigTarget): void {
  if (!sel?.self) throw new ConfigError('SELF_REQUIRED', `${target} 需要 selector.self`);
}
function requirePeer(sel: Selector | undefined, target: ConfigTarget): void {
  if (!sel?.self || !sel?.peerKey) throw new ConfigError('PEER_REQUIRED', `${target} 需要 selector.self + peerKey`);
}

// ── env 作用域 ──────────────────────────────────────────────────────────────

function envScopeFor(sel?: Selector): EnvScope {
  const root = resolvePaths().root;
  const scope: EnvScope = { rootDir: root };
  if (sel?.self) scope.agentDir = agentDir(sel.self);
  if (sel?.self && sel?.peerKey) scope.relationDir = path.join(agentRelationsDir(sel.self), sel.peerKey);
  return scope;
}

// ── read ──────────────────────────────────────────────────────────────────

export interface ReadOpts {
  /** 是否展开 ${VAR}（仅运行时内部消费路径置 true；CLI 读路径默认 false）。 */
  expand?: boolean;
  /** 是否走 mtime 门控缓存（daemon 热路径）。CLI 子进程留默认 false。 */
  cache?: boolean;
}

/** 读单个配置文件，返回强类型对象；不存在返回 null（不自动创建）。未知字段保留但不校验。 */
export function read<T = any>(target: ConfigTarget, sel?: Selector, opts: ReadOpts = {}): T | null {
  const file = targetPath(target, sel);
  let raw: T | null;
  if (opts.cache) {
    raw = fileCache.get<T | null>(
      file,
      () => atomicReadJson<T>(file),
      { policy: 'mtime', group: groupFor(target, sel) },
    );
  } else {
    raw = atomicReadJson<T>(file);
  }
  if (raw === null) return null;
  // schema 版本迁移（read 时若 $schema_version < current）
  const migrated = migrateIfNeeded(target, raw, file);
  const normalized = target === ConfigTarget.Agent
    ? normalizeAgentLifecycle(migrated as any) as T
    : migrated;
  if (!opts.expand) return normalized;
  const resolver = buildEnvResolver(envScopeFor(sel));
  return expandVars(normalized, resolver);
}

function groupFor(target: ConfigTarget, sel?: Selector): string {
  if (sel?.self && target === ConfigTarget.Agent) {
    return `config:${sel.self}`;
  }
  if (sel?.self && target === ConfigTarget.Behavior) {
    return `behavior:${sel.self}`;
  }
  if (target === ConfigTarget.Relation || target === ConfigTarget.RelationBehavior) {
    return 'relation-prefs';
  }
  return 'config';
}

// ── write ───────────────────────────────────────────────────────────────────

export interface WriteOpts {
  /** 跳过 schema 校验（迁移内部写回用）。 */
  skipValidate?: boolean;
}

/** 写入：① schema 校验 ② ensureFile 目录 ③ 原子写入。快照由调用方/启动流程统筹。 */
export function write<T = any>(target: ConfigTarget, value: T, sel?: Selector, opts: WriteOpts = {}): void {
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const withVer = ensureSchemaVersion(value as any, schema.version);

  // 1. Schema 校验
  if (!opts.skipValidate) {
    validateOrThrow(schema, withVer, target);
  }

  // 2. 角色约束校验（仅对 RelationBehavior）
  if (target === ConfigTarget.RelationBehavior && sel?.self && sel?.peerKey) {
    try {
      const validation = validateConfigWrite(target, withVer as any, sel);
      if (!validation.valid) {
        console.warn(`[config-manager] Role constraint violations on write:`,
          validation.violations.map(v => `${v.field}: ${v.reason}`));
        // 注意：当前为警告模式，不阻止写入
        // 未来可以通过环境变量启用严格模式：
        // if (process.env.EVOLCLAW_STRICT_ROLE_MODE === 'true') {
        //   throw new ConfigError('ROLE_VIOLATION', 'Config violates role constraints');
        // }
      }
    } catch (err) {
      console.warn('[config-manager] Failed to validate role constraints on write:', err);
      // 验证失败不阻止写入，只记录警告
    }
  }

  // 3. 写入文件
  const file = targetPath(target, sel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, withVer);
  if (fileCacheAvailable()) fileCache.invalidate(file);
}

function ensureSchemaVersion(value: any, version: number): any {
  if (value && typeof value === 'object' && typeof value.$schema_version !== 'number') {
    return { $schema_version: version, ...value };
  }
  return value;
}

function validateOrThrow(schema: SchemaEntry, value: unknown, target: ConfigTarget): void {
  const ok = schema.validate(value);
  if (!ok) {
    const errs = (schema.validate.errors || [])
      .map(e => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new ConfigError('SCHEMA_INVALID', `${target} 配置不合 schema(${schema.logicalName}.v${schema.version}): ${errs}`);
  }
}

/**
 * 纯 schema 校验（不写盘、无副作用）。返回错误信息数组，空数组=通过。
 * 供 config-store.validateAgentConfig 等只校验不落盘的场景使用。
 */
export function validateConfig(target: ConfigTarget, value: unknown): string[] {
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const withVer = ensureSchemaVersion(value as any, schema.version);
  const ok = schema.validate(withVer);
  if (ok) return [];
  return (schema.validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
}

function fileCacheAvailable(): boolean {
  try { return !!fileCache; } catch { return false; }
}

// ── ensureFile ───────────────────────────────────────────────────────────────

/** 按 schema 的 required/default 生成骨架并写入（幂等：已存在不覆盖）。 */
export function ensureFile(target: ConfigTarget, sel?: Selector): void {
  const file = targetPath(target, sel);
  if (fs.existsSync(file)) return;
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const skeleton: Record<string, any> = { $schema_version: schema.version };
  const props = schema.raw.properties || {};
  const required: string[] = schema.raw.required || [];
  for (const key of required) {
    if (key === '$schema_version') continue;
    if (key === 'aid' && sel?.self) { skeleton.aid = sel.self; continue; }
    const spec = props[key];
    if (spec && 'default' in spec) skeleton[key] = spec.default;
    else if (spec?.type === 'array') skeleton[key] = [];
    else if (spec?.type === 'object') skeleton[key] = {};
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, skeleton);
}

// ── schema 版本迁移 ──────────────────────────────────────────────────────────
//
// 同步路径只做"版本号判断 + 标记"；真正逐版本迁移函数是 .ts（动态 import 异步）。
// 当前所有 schema 均为 v1，无迁移函数——此处仅在版本落后时 warn，留 seam。

function migrateIfNeeded<T>(target: ConfigTarget, raw: T, file: string): T {
  const logical = TARGET_SCHEMA[target];
  const cur = currentVersion(logical);
  const have = (raw as any)?.$schema_version;
  if (typeof have === 'number' && have < cur) {
    if (target === ConfigTarget.Agent && have === 1 && cur === 2) {
      return raw;
    }
    // P0：迁移函数尚未存在（全 v1）。留 seam：未来在此 require migrations/{logical}.{N}-to-{N+1}.
    console.warn(`[config] ${file}: $schema_version ${have} < current ${cur} for "${logical}" — migration pending (seam)`);
  }
  return raw;
}

// ── H 链解析（resolveAgentConfig，三级）──────────────────────────────────────

/** H 链合并：defaults → agent/config → relation/config（逐级类型驱动深合并）。 */
export function resolveAgentConfig(sel: { self?: string; peerKey?: string }, opts: ReadOpts = {}): AgentConfig {
  // 字段表用 agent-config（H 链主 schema；relation-config 字段是其子集 owners/admins/extra_backup，merge 语义一致）
  const fields = loadSchema('agent-config').fields;
  const layers: Array<Partial<AgentConfig> | null> = [
    read<DefaultsConfig>(ConfigTarget.Defaults, undefined, opts) as any,
    sel.self ? read<AgentConfig>(ConfigTarget.Agent, sel, opts) : null,
    (sel.self && sel.peerKey) ? read<RelationConfig>(ConfigTarget.Relation, sel, opts) as any : null,
  ];
  const merged = mergeLayers<AgentConfig>(layers, fields);
  return merged;
}

// ── effective（合并视图）────────────────────────────────────────────────────

/**
 * 深度合并辅助函数
 * 用于合并角色约束结果，避免覆盖嵌套对象
 */
function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;
  if (Array.isArray(source)) return source; // 数组直接替换

  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(result[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * 合并视图：先合并 H 链，再叠加 HA 行为链，最后应用角色约束。
 * 同名行为字段以 behavior.json 链为高优先级。
 */
export function resolveEffective(sel: Selector, opts: ReadOpts = {}): EffectiveAgentConfig {
  const config = resolveAgentConfig(sel, opts);
  const effective: EffectiveAgentConfig = {
    $schema_version: config.$schema_version ?? currentVersion('agent-config'),
    aid: config.aid ?? sel.self ?? '',
    enabled: config.enabled,
    lifecycle: config.lifecycle,
    initialized: config.initialized,
    owners: config.owners,
    admins: config.admins,
    members: config.members,
    aun: config.aun,
    channels: config.channels ?? [],
    models: config.models,
    projects: config.projects,
    debug: config.debug,
    observable: config.observable,
    extra_backup: config.extra_backup,
    // Runtime configuration parameters
    active_baseagent: config.active_baseagent,
    baseagents: config.baseagents,
    chatmode: config.chatmode,
    response_modes: config.response_modes,
    flush_delay: config.flush_delay,
    debounce: config.debounce,
    dispatch: config.dispatch,
    show_activities: config.show_activities,
    proactive: config.proactive,
    render: config.render,
    enable_rich_content: config.enable_rich_content,
    permissionMode: config.permissionMode,
    roles: config.roles,
  };

  // 先合并行为链
  let result = mergeBehaviorIntoEffective(effective, sel, opts);

  // 如果有 peerKey，应用角色约束（优先使用 sel.role）
  if (sel.self && sel.peerKey) {
    try {
      const role = sel.role || resolveUserRole(sel.self, sel.peerKey);

      // 提取行为字段作为 relationConfig
      const behaviorFields: Record<string, any> = {};
      const behaviorFieldNames = [
        'permissionMode',
        'active_baseagent',
        'baseagents.claude.model',
        'baseagents.claude.effort',
        'chatmode',
        'dispatch',
        'show_activities',
        'flush_delay',
        'debounce',
        'enable_rich_content',
        'proactive',
        'render'
      ];

      for (const field of behaviorFieldNames) {
        if (field.includes('.')) {
          // 嵌套字段，提取为扁平键
          const parts = field.split('.');
          let value = result as any;
          for (const part of parts) {
            if (value && typeof value === 'object') {
              value = value[part];
            } else {
              value = undefined;
              break;
            }
          }
          if (value !== undefined) {
            behaviorFields[field] = value;
          }
        } else {
          // 顶层字段
          if ((result as any)[field] !== undefined) {
            behaviorFields[field] = (result as any)[field];
          }
        }
      }

      // 应用角色约束
      const constrained = mergeWithRoleConstraints(role, behaviorFields);

      if (!constrained.valid) {
        console.warn(`[config-manager] Role constraint violations for ${sel.peerKey} (${role}):`,
          constrained.violations.map(v => `${v.field}: ${v.reason}`));
      }

      // 将约束后的配置深度合并回 result（避免覆盖嵌套对象）
      result = deepMerge(result, constrained.effectiveConfig);
    } catch (err) {
      console.warn('[config-manager] Failed to apply role constraints:', err);
      // 失败时继续，不阻塞配置解析
    }
  }

  return normalizeEffectiveCompatibility(result);
}

/**
 * 配置写入前的角色约束校验
 * 仅对 RelationBehavior 进行角色约束检查
 *
 * @param target 配置目标
 * @param config 待写入配置
 * @param sel 选择器
 * @returns 约束检查结果
 */
export function validateConfigWrite(
  target: ConfigTarget,
  config: Record<string, any>,
  sel: Selector
): { valid: boolean; violations: any[]; effectiveConfig: any } {
  // 只对 RelationBehavior 进行角色约束检查
  if (target !== ConfigTarget.RelationBehavior) {
    return { valid: true, violations: [], effectiveConfig: config };
  }

  if (!sel.self || !sel.peerKey) {
    throw new ConfigError('SELECTOR_REQUIRED', 'RelationBehavior requires self and peerKey');
  }

  try {
    const role = resolveUserRole(sel.self, sel.peerKey);
    return mergeWithRoleConstraints(role, config);
  } catch (err) {
    console.warn('[config-manager] Failed to validate config write:', err);
    // 验证失败时，允许写入但记录警告
    return { valid: true, violations: [], effectiveConfig: config };
  }
}

function normalizeEffectiveCompatibility<T extends EffectiveAgentConfig>(effective: T): T {
  if ((effective as any).dispatch === 'all' || (effective as any).dispatch === 'none') {
    (effective as any).dispatch = 'broadcast';
  }
  return effective;
}

// ── 字段 → target 路由（按 schema 归属判定）──────────────────────────────────

export interface FieldRoute {
  field: string;
  target: ConfigTarget;
  schema: LogicalSchemaName;
  permission: 'H' | 'HA';
  merge: string;
  enum?: string[];
}

type ConfigScope = 'process' | 'defaults' | 'agent' | 'relation';

const BEHAVIOR_TOP_FIELDS = new Set([
  'active_baseagent',
  'chatmode',
  'flush_delay',
  'debounce',
  'dispatch',
  'show_activities',
  'proactive',
  'render',
  'enable_rich_content',
  'permissionMode',
  'roles',
]);

const BASEAGENT_BEHAVIOR_FIELDS = new Set([
  'model',
  'effort',
  'reasoning',
  'agentProgressSummaries',
  'excludeDynamicSections',
  'enableRequestUserInput',
  'approvalsReviewer',
  'mode',
  'useVertex',
]);

/**
 * 给定 selector 作用域 + 顶层字段名，判定写入落点。
 * 兼容旧调用：仅按顶层字段路由。新写入请优先使用 routeFieldPath()。
 */
export function routeField(
  topField: string,
  scope: ConfigScope,
): FieldRoute {
  return routeFieldPath(topField, scope);
}

/**
 * 给定 selector 作用域 + 完整字段路径，判定 canonical 写入落点。
 * H 字段写 config/defaults/evolclaw；HA 行为字段写 behavior.json。
 */
export function routeFieldPath(
  fieldPath: string,
  scope: ConfigScope,
): FieldRoute {
  const topField = fieldPath.split('.')[0];
  if (scope === 'process') return routeIn('evolclaw', ConfigTarget.Process, topField);
  if (scope === 'defaults') return routeIn('defaults', ConfigTarget.Defaults, topField);

  if (isBehaviorFieldPath(fieldPath)) {
    const target = scope === 'relation' ? ConfigTarget.RelationBehavior : ConfigTarget.Behavior;
    return routeIn('behavior', target, topField);
  }

  if (scope === 'agent') return routeIn('agent-config', ConfigTarget.Agent, topField);
  return routeIn('relation-config', ConfigTarget.Relation, topField);
}

function isBehaviorFieldPath(fieldPath: string): boolean {
  const parts = fieldPath.split('.');
  const top = parts[0];
  if (top === 'baseagents') {
    const field = parts[2];
    return !!field && BASEAGENT_BEHAVIOR_FIELDS.has(field);
  }
  return BEHAVIOR_TOP_FIELDS.has(top);
}

function routeIn(name: LogicalSchemaName, target: ConfigTarget, topField: string): FieldRoute {
  const s = loadSchema(name);
  if (!s.fields.has(topField)) throw new ConfigError('UNKNOWN_FIELD', `未知配置字段: ${topField}（${name}）`);
  return mkRoute(s, target, topField);
}

function mkRoute(s: SchemaEntry, target: ConfigTarget, topField: string): FieldRoute {
  const spec = s.fields.get(topField)!;
  return { field: topField, target, schema: s.logicalName, permission: s.permission, merge: spec.merge, enum: spec.enum };
}

/** 列出某作用域下所有可设字段（ec config fields 用）。 */
export function listFields(scope: ConfigScope): FieldRoute[] {
  const out: FieldRoute[] = [];
  const add = (name: LogicalSchemaName, target: ConfigTarget) => {
    const s = loadSchema(name);
    for (const f of s.fields.keys()) out.push(mkRoute(s, target, f));
  };
  if (scope === 'process') { add('evolclaw', ConfigTarget.Process); return out; }
  if (scope === 'defaults') { add('defaults', ConfigTarget.Defaults); return out; }
  if (scope === 'agent') {
    add('agent-config', ConfigTarget.Agent);
    add('behavior', ConfigTarget.Behavior);
    return out;
  }
  add('relation-config', ConfigTarget.Relation);
  add('behavior', ConfigTarget.RelationBehavior);
  return out;
}

export { ConfigTarget as Target };
