/**
 * ConfigManager —— 所有配置文件读写/合并的统一归口（全项目唯一合并实现点）。
 *
 * 不允许散落的 fs.readFileSync 直接操作配置文件。
 *
 * 两条覆盖链（design §一/§三，addendum D1 加进程级）：
 *   H 链（三级）：  defaults.json → agent/config.json → relation/config.json
 *   HA 链（含角色）：agent/behavior.json → role(behavior.roles.<role>) → relation/behavior.json
 *   进程级 evolclaw.json：链外单 H 作用域。
 *
 * 详见 docs/config-system-design-v2.md + addendum。
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
} from '../../paths.js';
import { atomicReadJson, atomicWriteJson } from '../../utils/atomic-write.js';
import { fileCache } from '../daemon-file-cache.js';
import {
  loadSchema,
  currentVersion,
  assertDisjointFields,
  type LogicalSchemaName,
  type SchemaEntry,
} from './schema-registry.js';
import { mergeLayers, expandVars, buildEnvResolver, type EnvScope } from './merge.js';
import type {
  ProcessConfig,
  DefaultsConfig,
  AgentConfig,
  RelationConfig,
  BehaviorConfig,
  EffectiveAgentConfig,
  MergedAgentConfig,
} from '../../types.js';

export enum ConfigTarget {
  Process = 'process',                  // evolclaw.json（链外 H）
  Defaults = 'defaults',                // agents/defaults.json（H）
  Agent = 'agent',                      // agents/{aid}/config.json（H）
  AgentBehavior = 'agent-behavior',     // agents/{aid}/behavior.json（HA）
  Relation = 'relation',                // agents/{aid}/relations/{peerKey}/config.json（H）
  RelationBehavior = 'relation-behavior', // .../{peerKey}/behavior.json（HA）
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
  [ConfigTarget.AgentBehavior]: 'behavior',
  [ConfigTarget.Relation]: 'relation-config',
  [ConfigTarget.RelationBehavior]: 'behavior',
};

export class ConfigError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

let _initialized = false;
/** 一次性加载期硬约束校验（字段不相交）。幂等。 */
export function initConfigManager(): void {
  if (_initialized) return;
  assertDisjointFields();
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
    case ConfigTarget.AgentBehavior:
      requireSelf(sel, target);
      return agentBehaviorConfig(sel!.self!);
    case ConfigTarget.Relation:
      requirePeer(sel, target);
      return agentRelationConfig(sel!.self!, sel!.peerKey!);
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
  if (!opts.expand) return migrated;
  const resolver = buildEnvResolver(envScopeFor(sel));
  return expandVars(migrated, resolver);
}

function groupFor(target: ConfigTarget, sel?: Selector): string {
  if (sel?.self && (target === ConfigTarget.Agent || target === ConfigTarget.AgentBehavior)) {
    return `config:${sel.self}`;
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

/** 写入：① schema 校验 ② ensureFile 目录 ③ 原子写入。H 类快照由调用方/启动流程统筹。 */
export function write<T = any>(target: ConfigTarget, value: T, sel?: Selector, opts: WriteOpts = {}): void {
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const withVer = ensureSchemaVersion(value as any, schema.version);
  if (!opts.skipValidate) {
    validateOrThrow(schema, withVer, target);
  }
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

// ── HA 链解析（resolveBehavior，含角色层）──────────────────────────────────────

/**
 * HA 链合并：agent/behavior → role(behavior.roles.<role>) → relation/behavior。
 * 无 defaults 层。角色层条件性参与（无 role 退化）。
 * role 覆盖：取 agent/behavior 与 relation/behavior 各自的 roles.<role> 块，按层序插入。
 */
export function resolveBehavior(sel: Selector, opts: ReadOpts = {}): BehaviorConfig {
  const fields = loadSchema('behavior').fields;
  const agentB = sel.self ? read<BehaviorConfig>(ConfigTarget.AgentBehavior, sel, opts) : null;
  const relB = (sel.self && sel.peerKey) ? read<BehaviorConfig>(ConfigTarget.RelationBehavior, sel, opts) : null;

  // 角色覆盖块：从 agent/behavior.roles.<role> 抽出（角色层是 HA 链一环，坐在 agent 与 relation 之间）。
  const roleBlock = (sel.role && agentB?.roles?.[sel.role]) ? roleToBehavior(agentB.roles[sel.role]) : null;

  // 层序（低 → 高）：agent/behavior → role → relation/behavior
  const layers: Array<Partial<BehaviorConfig> | null> = [
    stripRoles(agentB),
    roleBlock,
    stripRoles(relB),
  ];
  return mergeLayers<BehaviorConfig>(layers, fields);
}

/** 把 RoleOverride（{baseagents, permissionMode}）摊平成 BehaviorConfig 片段。 */
function roleToBehavior(ov: { baseagents?: any; permissionMode?: string } | undefined): Partial<BehaviorConfig> | null {
  if (!ov) return null;
  const out: Partial<BehaviorConfig> = {};
  if (ov.baseagents) out.baseagents = ov.baseagents;
  if (ov.permissionMode) out.permissionMode = ov.permissionMode;
  return Object.keys(out).length > 0 ? out : null;
}

/** 合并时排除 roles 字段本身（roles 只作角色寻址用，不参与最终 effective 合并）。 */
function stripRoles(b: BehaviorConfig | null): Partial<BehaviorConfig> | null {
  if (!b) return null;
  if (!b.roles) return b;
  const { roles: _omit, ...rest } = b;
  return rest;
}

// ── effective（H + behavior 合并视图）────────────────────────────────────────

export function resolveEffective(sel: Selector, opts: ReadOpts = {}): EffectiveAgentConfig {
  const h = resolveAgentConfig(sel, opts);
  const behavior = resolveBehavior(sel, opts);
  return {
    $schema_version: h.$schema_version ?? currentVersion('agent-config'),
    aid: h.aid ?? sel.self ?? '',
    enabled: h.enabled,
    initialized: h.initialized,
    owners: h.owners,
    admins: h.admins,
    aun: h.aun,
    channels: h.channels ?? [],
    models: h.models,
    projects: h.projects,
    debug: h.debug,
    observable: h.observable,
    extra_backup: h.extra_backup,
    behavior,
  };
}

/**
 * 运行时扁平视图：H 链 + HA 链平铺合并（兼容既有 `.config.<field>` 消费方）。
 * agent 级快照（无 peer/role）给 EvolAgent.config；带 peer/role 的逐消息解析另走 resolveBehavior。
 */
export function resolveMerged(sel: Selector, opts: ReadOpts = {}): MergedAgentConfig {
  const h = resolveAgentConfig(sel, opts);
  const behavior = resolveBehavior(sel, opts);
  return { ...behavior, ...h } as MergedAgentConfig;
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

/**
 * 给定 selector 作用域 + 顶层字段名，判定写入落点（config H vs behavior HA）。
 * scope 决定 agent/relation/defaults/process；字段归属决定 config vs behavior。
 */
export function routeField(
  topField: string,
  scope: 'process' | 'defaults' | 'agent' | 'relation',
): FieldRoute {
  // process / defaults 是单 H 文件，无 behavior 对偶
  if (scope === 'process') return routeIn('evolclaw', ConfigTarget.Process, topField);
  if (scope === 'defaults') return routeIn('defaults', ConfigTarget.Defaults, topField);

  // agent / relation：先查 config(H) schema，再查 behavior(HA)
  if (scope === 'agent') {
    const cfg = loadSchema('agent-config');
    if (cfg.fields.has(topField)) return mkRoute(cfg, ConfigTarget.Agent, topField);
    const beh = loadSchema('behavior');
    if (beh.fields.has(topField)) return mkRoute(beh, ConfigTarget.AgentBehavior, topField);
  } else {
    const cfg = loadSchema('relation-config');
    if (cfg.fields.has(topField)) return mkRoute(cfg, ConfigTarget.Relation, topField);
    const beh = loadSchema('behavior');
    if (beh.fields.has(topField)) return mkRoute(beh, ConfigTarget.RelationBehavior, topField);
  }
  throw new ConfigError('UNKNOWN_FIELD', `未知配置字段: ${topField}（${scope} 作用域）`);
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
export function listFields(scope: 'process' | 'defaults' | 'agent' | 'relation'): FieldRoute[] {
  const out: FieldRoute[] = [];
  const add = (name: LogicalSchemaName, target: ConfigTarget) => {
    const s = loadSchema(name);
    for (const f of s.fields.keys()) out.push(mkRoute(s, target, f));
  };
  if (scope === 'process') { add('evolclaw', ConfigTarget.Process); return out; }
  if (scope === 'defaults') { add('defaults', ConfigTarget.Defaults); return out; }
  if (scope === 'agent') { add('agent-config', ConfigTarget.Agent); add('behavior', ConfigTarget.AgentBehavior); return out; }
  add('relation-config', ConfigTarget.Relation); add('behavior', ConfigTarget.RelationBehavior); return out;
}

export { ConfigTarget as Target };
