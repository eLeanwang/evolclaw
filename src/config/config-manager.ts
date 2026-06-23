/**
 * ConfigManager —— 所有配置文件读写/合并的统一归口（全项目唯一合并实现点）。
 *
 * 不允许散落的 fs.readFileSync 直接操作配置文件。
 *
 * 覆盖链（三级）：defaults.json → agent/config.json → relation/config.json
 * 进程级 evolclaw.json：独立，不参与覆盖链。
 *
 * 详见 docs/config/01-overview.md
 */

import fs from 'fs';
import path from 'path';
import {
  resolvePaths,
  agentConfig as agentConfigPath,
  agentRelationConfig,
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
  if (sel?.self && target === ConfigTarget.Agent) {
    return `config:${sel.self}`;
  }
  if (target === ConfigTarget.Relation) {
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

// ── effective（合并视图）────────────────────────────────────────────────────

/**
 * 覆盖链合并：defaults → agent/config → relation/config
 * 所有参数统一在 config.json。
 */
export function resolveEffective(sel: Selector, opts: ReadOpts = {}): EffectiveAgentConfig {
  const config = resolveAgentConfig(sel, opts);
  const effective: EffectiveAgentConfig = {
    $schema_version: config.$schema_version ?? currentVersion('agent-config'),
    aid: config.aid ?? sel.self ?? '',
    enabled: config.enabled,
    initialized: config.initialized,
    owners: config.owners,
    admins: config.admins,
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
  return mergeBehaviorIntoEffective(effective, sel, opts);
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
 * 给定 selector 作用域 + 顶层字段名，判定写入落点。
 * 所有参数统一在 config.json。
 */
export function routeField(
  topField: string,
  scope: 'process' | 'defaults' | 'agent' | 'relation',
): FieldRoute {
  if (scope === 'process') return routeIn('evolclaw', ConfigTarget.Process, topField);
  if (scope === 'defaults') return routeIn('defaults', ConfigTarget.Defaults, topField);
  if (scope === 'agent') return routeIn('agent-config', ConfigTarget.Agent, topField);
  return routeIn('relation-config', ConfigTarget.Relation, topField);
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
  if (scope === 'agent') { add('agent-config', ConfigTarget.Agent); return out; }
  add('relation-config', ConfigTarget.Relation); return out;
}

export { ConfigTarget as Target };
