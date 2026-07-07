/**
 * ConfigManager —— 所有配置文件读写/合并的统一归口（全项目唯一合并实现点）。
 *
 * 不允许散落的 fs.readFileSync 直接操作配置文件。
 *
 * v3 设计（2026-06-19）：
 * - 覆盖链：defaults.json → agent/config.json → relation/config.json
 * - 所有参数统一在 config.json，不再有 behavior.json
 * - 进程级 evolclaw.json：独立，不参与覆盖链
 *
 * 详见 docs/config/01-overview.md
 */

import fs from 'fs';
import path from 'path';
import {
  resolvePaths,
  agentConfig as agentConfigPath,
  agentRoleAssignmentsConfig,
  agentRelationConfig,
  agentDir,
  agentRelationsDir,
  rolesConfig,
} from '../paths.js';
import { atomicReadJson, atomicWriteJson } from '../utils/atomic-write.js';
import { fileCache } from '../core/daemon-file-cache.js';
import { isValidAid } from '../aun/aid/validation.js';
import {
  loadSchema,
  currentVersion,
  type LogicalSchemaName,
  type SchemaEntry,
} from './schema-registry.js';
import { mergeLayers, expandVars, buildEnvResolver, type EnvScope } from './merge.js';
import { normalizeAgentLifecycle } from './lifecycle.js';
import { mergeWithRoleConstraints } from './role-constraints.js';
import { mergeRolesConfig, diffRolesConfig } from './roles-merge.js';
import { getBuiltinRolesConfig } from './builtin-roles.js';
import { clearRolesCache } from './roles-cache.js';
import {
  normalizeRelationBehaviorForAssignedRole,
  syncNoOverrideRoleModelsForAllAgents,
} from './role-model-sync.js';
import type {
  ProcessConfig,
  DefaultsConfig,
  AgentConfig,
  RelationConfig,
  EffectiveAgentConfig,
  RolesConfig,
} from '../types.js';

export enum ConfigTarget {
  Process = 'process',                  // evolclaw.json（独立）
  Defaults = 'defaults',                // agents/defaults.json
  Agent = 'agent',                      // agents/{aid}/config.json
  Relation = 'relation',                // agents/{aid}/relations/{peerKey}/config.json
  Roles = 'roles',                      // roles.json（全局角色定义，overlay 模型）
  RoleAssignments = 'role-assignments',  // agents/{aid}/role-assignments.json
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
  [ConfigTarget.Roles]: 'roles',
  [ConfigTarget.RoleAssignments]: 'role-assignments',
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

/**
 * 启动时检查 schema 版本（daemon 启动时调用）。
 * 扫描所有配置文件，如有版本不匹配则警告一次。
 */
export function checkSchemaVersionsOnStartup(selfAid?: string): void {
  schemaVersionWarningsEnabled = true;
  const p = resolvePaths();

  // 检查 process 层
  try { read(ConfigTarget.Process); } catch {}

  // 检查 defaults 层
  try { read(ConfigTarget.Defaults); } catch {}

  // 检查 agent 层（如果提供了 AID）
  if (selfAid) {
    try { read(ConfigTarget.Agent, { self: selfAid }); } catch {}
  }

  schemaVersionWarningsEnabled = false;
}

// Schema 版本警告控制：只在启动时检查一次
let schemaVersionWarningsEnabled = false;

function configWarn(...args: unknown[]): void {
  console.warn(...args);
}

// ── 路径解析 ──────────────────────────────────────────────────────────────

function targetPath(target: ConfigTarget, sel?: Selector): string {
  const p = resolvePaths();
  switch (target) {
    case ConfigTarget.Process: return p.evolclawJson;
    case ConfigTarget.Defaults: return p.defaultsConfig;
    case ConfigTarget.Roles: return rolesConfig();
    case ConfigTarget.RoleAssignments:
      requireSelf(sel, target);
      return agentRoleAssignmentsConfig(sel!.self!);
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
  const normalized = target === ConfigTarget.Agent
    ? normalizeAgentConfigForRead(migrated as any, sel?.self) as T
    : migrated;
  if (!opts.expand) return normalized;
  const resolver = buildEnvResolver(envScopeFor(sel));
  return expandVars(normalized, resolver);
}

function normalizeAgentConfigForRead<T extends Record<string, any>>(value: T, aid?: string): T {
  const config = normalizeAgentLifecycle(value) as T;
  const mutable = config as Record<string, any>;

  // AID 校验（如果提供了 aid）
  if (aid && mutable.aid && mutable.aid !== aid) {
    const filePath = targetPath(ConfigTarget.Agent, { self: aid });
    throw new ConfigError(
      'VALIDATION_ERROR',
      `${filePath}: aid field "${mutable.aid}" != directory name "${aid}"`
    );
  }

  // Legacy configs used top-level "agents" for baseagent settings.
  // Keep read compatibility, but never write the obsolete field back.
  if (mutable.agents && typeof mutable.agents === 'object' && !Array.isArray(mutable.agents)) {
    mutable.baseagents = mutable.baseagents && typeof mutable.baseagents === 'object' && !Array.isArray(mutable.baseagents)
      ? { ...mutable.agents, ...mutable.baseagents }
      : mutable.agents;
    delete mutable.agents;
  }

  // 清理 projects.defaultPath 尾部斜杠
  if (mutable.projects?.defaultPath && typeof mutable.projects.defaultPath === 'string') {
    mutable.projects.defaultPath = mutable.projects.defaultPath.replace(/[/\\]+$/, '');
  }

  return config;
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

function normalizeAgentConfigForWrite<T extends Record<string, any>>(value: T): T {
  const mutable = { ...value } as Record<string, any>;

  // AID 格式校验
  if (mutable.aid && !isValidAid(mutable.aid)) {
    throw new ConfigError(
      'VALIDATION_ERROR',
      `Invalid aid "${mutable.aid}" (must be a valid multi-level domain like mybot.agentid.pub)`
    );
  }

  // 规范化 projects 字段：只保留 rootPath 和 defaultPath
  if (mutable.projects && typeof mutable.projects === 'object') {
    const projects = mutable.projects as Record<string, any>;
    const normalized: Record<string, any> = {};
    if (typeof projects.rootPath === 'string') normalized.rootPath = projects.rootPath;
    if (typeof projects.defaultPath === 'string') normalized.defaultPath = projects.defaultPath;
    if (Object.keys(normalized).length > 0) {
      mutable.projects = normalized;
    } else {
      delete mutable.projects;
    }
  }

  return mutable as T;
}

/** 写入：① schema 校验 ② ensureFile 目录 ③ 原子写入。快照由调用方/启动流程统筹。 */
export function write<T = any>(target: ConfigTarget, value: T, sel?: Selector, opts: WriteOpts = {}): void {
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const withVer = ensureSchemaVersion(value as any, schema.version);
  const file = targetPath(target, sel);
  const migrated = target === ConfigTarget.Roles
    ? migrateIfNeeded(target, withVer, file)
    : withVer;

  // Agent config 写入规范化（aid 校验、projects 字段清理）
  const normalized = target === ConfigTarget.Agent
    ? normalizeAgentConfigForWrite(migrated as any) as any
    : migrated;

  // 1. Schema 校验
  if (!opts.skipValidate) {
    validateOrThrow(schema, normalized, target);
  }

  // 2. 角色约束校验（仅对 Relation）
  if (target === ConfigTarget.Relation && sel?.self && sel?.peerKey) {
    try {
      const validation = validateConfigWrite(target, normalized as any, sel);
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, normalized);
  if (fileCacheAvailable()) fileCache.invalidate(file);
}

function ensureSchemaVersion(value: any, version: number): any {
  if (value && typeof value === 'object' && typeof value.$schema_version !== 'number') {
    return { $schema_version: version, ...value };
  }
  return value;
}

// ── roles（overlay 模型）─────────────────────────────────────────────────────
//
// roles.json 存的是相对内置基线的 diff（overlay）。读取时与 getBuiltinRolesConfig()
// 深合并（per-FieldPermission），写入时算 diff 只落改动。跨进程一致性靠 read 的
// 'mtime' 缓存策略（ecweb 写后 daemon statSync 自动感知）。

/**
 * 读取并合并 roles 配置：内置基线 + 用户 overlay。
 * - 内置新增字段自动补全；用户未改字段跟随内置最新；用户改过的保留；自定义角色保留。
 */
export function resolveRoles(opts: ReadOpts = {}): RolesConfig {
  const base = getBuiltinRolesConfig();
  const overlay = read<RolesConfig>(ConfigTarget.Roles, undefined, opts);
  return mergeRolesConfig(base, overlay);
}

/**
 * 写入 roles 配置：传入完整视图，内部算 diff 后只落改动。
 * 自动 schema 校验 + 原子写 + fileCache 失效 + 清本进程 ROLES_CACHE。
 */
export function writeRoles(full: RolesConfig, opts: WriteOpts = {}): void {
  const diff = diffRolesConfig(getBuiltinRolesConfig(), full);
  write(ConfigTarget.Roles, diff, undefined, opts);
  clearRolesCache();
  syncNoOverrideRoleModelsForAllAgents(full); // v3: 传入 roles 参数
}

function validateOrThrow(schema: SchemaEntry, value: unknown, target: ConfigTarget): void {
  const ok = schema.validate(value);
  if (!ok) {
    const errs = (schema.validate.errors || [])
      .map(e => {
        const extra = typeof (e.params as any)?.additionalProperty === 'string'
          ? ` (additionalProperty=${(e.params as any).additionalProperty})`
          : '';
        return `${e.instancePath || '/'} ${e.message}${extra}`;
      })
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
  return (schema.validate.errors || []).map(e => {
    const extra = typeof (e.params as any)?.additionalProperty === 'string'
      ? ` (additionalProperty=${(e.params as any).additionalProperty})`
      : '';
    return `${e.instancePath || '/'} ${e.message}${extra}`;
  });
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
  // roles：格式迁移（全量 → overlay），与版本号无关
  if (target === ConfigTarget.Roles) {
    let migrated = migrateRolesToOverlay(raw as any, file) as T;
    // v1 → v2 → v3 → v4 schema 版本迁移
    const have = (migrated as any)?.$schema_version;
    if (typeof have === 'number' && have < 4) {
      if (have < 3) {
        migrated = migrateRolesToV3(migrated as any, file) as T;
      }
      migrated = migrateRolesToV4(migrated as any, file) as T;
      try {
        atomicWriteJson(file, migrated as any);
        if (fileCacheAvailable()) fileCache.invalidate(file);
      } catch (err) {
        configWarn(`[config] roles.json migration write-back failed:`, err);
      }
    }
    return migrated;
  }

  const logical = TARGET_SCHEMA[target];
  const cur = currentVersion(logical);
  const have = (raw as any)?.$schema_version;
  if (typeof have === 'number' && have < cur && schemaVersionWarningsEnabled) {
    // P0：迁移函数尚未存在（全 v1）。留 seam：未来在此 require migrations/{logical}.{N}-to-{N+1}.
    configWarn(`[config] ${file}: $schema_version ${have} < current ${cur} for "${logical}" — migration pending (seam)`);
  }
  return raw;
}

/**
 * roles.json 格式迁移：旧的全量格式 → overlay（diff）格式。
 *
 * 启发式检测全量：某内置 role 的 permission 字段数 ≥ 内置该 role 字段数的 80% → 判为全量。
 * 全量则与内置 diff，备份原文件后写回精简 overlay。已是 overlay 则原样返回。
 * 直接 atomicWriteJson 写回（绕过 ConfigManager.write 避免递归）。
 */
function migrateRolesToOverlay(raw: RolesConfig, file: string): RolesConfig {
  if (!raw || !raw.roles) return raw;

  const builtin = getBuiltinRolesConfig();
  let looksFull = false;
  for (const roleName of Object.keys(builtin.roles)) {
    const userRole = raw.roles[roleName];
    const builtinRole = builtin.roles[roleName];
    if (userRole?.permissions && builtinRole?.permissions) {
      const userCount = Object.keys(userRole.permissions).length;
      const builtinCount = Object.keys(builtinRole.permissions).length;
      if (builtinCount > 0 && userCount >= builtinCount * 0.8) {
        looksFull = true;
        break;
      }
    }
  }

  if (!looksFull) return raw;

  const overlay = diffRolesConfig(builtin, raw);

  // 备份原全量文件
  try {
    const backup = `${file}.pre-overlay.${Date.now()}`;
    fs.copyFileSync(file, backup);
    configWarn(`[config] roles.json 全量→overlay 迁移：备份 ${backup}`);
  } catch (err) {
    configWarn(`[config] roles.json 迁移备份失败:`, err);
  }

  // 直接写回 overlay（绕过 write 避免递归触发 migrateIfNeeded）
  try {
    atomicWriteJson(file, overlay);
    if (fileCacheAvailable()) fileCache.invalidate(file);
    configWarn(`[config] roles.json 已转为 overlay 格式（${Object.keys(overlay.roles).length} 个角色含改动）`);
  } catch (err) {
    configWarn(`[config] roles.json overlay 写回失败:`, err);
  }

  return overlay;
}

/**
 * roles v1 → v2 schema 迁移：添加 defaultRole (top-level) 和 allowAccess (per-role)。
 * v1 缺失这两个字段，v2 schema 为其提供默认值：defaultRole='anonymous'，allowAccess 按角色（anonymous=false 其他=true）。
 * 迁移策略：overlay 里只存用户改动，未改的字段继承内置。所以只需升 $schema_version，字段留空让合并时从 builtin 补全。
 */
function migrateRolesToV3(raw: any, file: string): RolesConfig {
  configWarn(`[config] roles.json -> v3 migration: ${file}`);
  const migrated: RolesConfig = {
    ...raw,
    $schema_version: 3,
    defaultRoles: {
      private: raw.defaultRoles?.private || 'anonymous',
      group: raw.defaultRoles?.group || 'guest',
    },
  };
  delete (migrated as any).defaultRole;
  return migrated;
}

/**
 * roles v3 → v4 schema 迁移：添加 commandPermissions 支持。
 * v3 没有 commandPermissions 字段，v4 schema 为每个角色添加命令权限配置。
 * 迁移策略：overlay 里只存用户改动，未改的字段继承内置。所以只需升 $schema_version，
 * commandPermissions 留空让合并时从 builtin 补全。
 */
function migrateRolesToV4(raw: any, file: string): RolesConfig {
  configWarn(`[config] roles.json -> v4 migration: ${file}`);
  const migrated: RolesConfig = {
    ...raw,
    $schema_version: 4,
  };
  // commandPermissions 字段留空，让 mergeRolesConfig 从内置基线补全
  return migrated;
}

export function resolveAgentConfig(sel: { self?: string; peerKey?: string }, opts: ReadOpts = {}): AgentConfig {
  // Use agent-config as the H-chain field table, but static owners only come from agent config.
  const fields = loadSchema('agent-config').fields;
  const agentConfig = sel.self ? read<AgentConfig>(ConfigTarget.Agent, sel, opts) : null;
  const relationConfig = (sel.self && sel.peerKey) ? read<RelationConfig>(ConfigTarget.Relation, sel, opts) as any : null;
  const layers: Array<Partial<AgentConfig> | null> = [
    stripStaticOwnerField(read<DefaultsConfig>(ConfigTarget.Defaults, undefined, opts) as any),
    agentConfig,
    stripStaticOwnerField(relationConfig),
  ];
  const merged = mergeLayers<AgentConfig>(layers, fields);
  return merged;
}

function stripStaticOwnerField<T extends Record<string, any>>(config: T | null): T | null {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'owners')) return config;
  const { owners: _owners, ...rest } = config;
  return rest as T;
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
 * 合并视图：合并覆盖链（defaults → agent/config → relation/config），
 * 然后应用角色约束（如有）。v3 设计所有参数统一在 config.json。
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
    aun: config.aun,
    channels: config.channels ?? [],
    models: config.models,
    projects: config.projects,
    capabilities: config.capabilities,
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

  // v3 设计：直接返回 effective，然后应用角色约束（如有）
  let result = effective;

  // 如果有 peerKey，应用角色约束（优先使用 sel.role）
  if (sel.self && sel.peerKey && sel.role) {
    try {
      const role = sel.role;

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
 * 仅对 Relation 进行角色约束检查
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
  // v3 设计：只对 Relation 进行角色约束检查
  if (target !== ConfigTarget.Relation) {
    return { valid: true, violations: [], effectiveConfig: config };
  }

  if (!sel.self || !sel.peerKey) {
    throw new ConfigError('SELECTOR_REQUIRED', 'Relation requires self and peerKey');
  }

  try {
    const role = sel.role || 'guest';
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
  'group_venue_sync',
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
 * v3 设计：所有参数统一在 config.json，按作用域路由到对应层级。
 */
export function routeFieldPath(
  fieldPath: string,
  scope: ConfigScope,
): FieldRoute {
  const topField = fieldPath.split('.')[0];
  if (scope === 'process') return routeIn('evolclaw', ConfigTarget.Process, topField);
  if (scope === 'defaults') return routeIn('defaults', ConfigTarget.Defaults, topField);

  if (isBehaviorFieldPath(fieldPath)) {
    // v3 设计：行为字段按作用域路由到对应的 schema
    if (scope === 'agent') {
      return routeIn('agent-config', ConfigTarget.Agent, topField);
    }
    // relation 作用域：行为字段在 relation-config 中
    return routeIn('relation-config', ConfigTarget.Relation, topField);
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
  // $schema_version 是元数据字段，特殊处理
  if (topField === '$schema_version') {
    return {
      field: topField,
      target,
      schema: name,
      permission: 'H',
      merge: 'replace' as const,
      enum: undefined
    };
  }

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
    return out;
  }
  // relation
  add('relation-config', ConfigTarget.Relation);
  return out;
}

export { ConfigTarget as Target };
