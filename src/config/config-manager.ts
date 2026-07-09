/**
 * ConfigManager 鈥斺€?鎵€鏈夐厤缃枃浠惰鍐?鍚堝苟鐨勭粺涓€褰掑彛锛堝叏椤圭洰鍞竴鍚堝苟瀹炵幇鐐癸級銆?
 *
 * 涓嶅厑璁告暎钀界殑 fs.readFileSync 鐩存帴鎿嶄綔閰嶇疆鏂囦欢銆?
 *
 * v3 璁捐锛?026-06-19锛夛細
 * - 瑕嗙洊閾撅細defaults.json 鈫?agent/config.json 鈫?relation/config.json
 * - 鎵€鏈夊弬鏁扮粺涓€鍦?config.json锛屼笉鍐嶆湁 behavior.json
 * - 杩涚▼绾?evolclaw.json锛氱嫭绔嬶紝涓嶅弬涓庤鐩栭摼
 *
 * 璇﹁ docs/config/01-overview.md
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
import { getBuiltinRolesConfig, isReservedRoleName } from './builtin-roles.js';
import type {
  ProcessConfig,
  DefaultsConfig,
  AgentConfig,
  RelationConfig,
  EffectiveAgentConfig,
} from '../types.js';

const USER_ROLE_NAME_RE = /^[a-z0-9_-]+$/;
const ROLE_USAGE_COST_BASIS = new Set(['gateway', 'official']);
const ROLE_USAGE_SCOPES = new Set(['subject', 'role']);
const ROLE_USAGE_RESET_MODES = new Set(['never', 'daily', 'weekly', 'monthly']);
const ROLE_USAGE_CURRENCIES = new Set(['CNY', 'USD']);

export enum ConfigTarget {
  Process = 'process',                  // evolclaw.json锛堢嫭绔嬶級
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
/** ConfigManager 鍒濆鍖栵紙棰勭暀鎵╁睍鐐癸級銆傚箓绛夈€?*/
export function initConfigManager(): void {
  if (_initialized) return;
  // 鍒濆鍖栭€昏緫锛堝闇€瑕侊級
  _initialized = true;
}

/**
 * 鍚姩鏃舵鏌?schema 鐗堟湰锛坉aemon 鍚姩鏃惰皟鐢級銆?
 * 鎵弿鎵€鏈夐厤缃枃浠讹紝濡傛湁鐗堟湰涓嶅尮閰嶅垯璀﹀憡涓€娆°€?
 */
export function checkSchemaVersionsOnStartup(selfAid?: string): void {
  schemaVersionWarningsEnabled = true;
  const p = resolvePaths();

  // 妫€鏌?process 灞?
  try { read(ConfigTarget.Process); } catch {}

  // 妫€鏌?defaults 灞?
  try { read(ConfigTarget.Defaults); } catch {}

  // 妫€鏌?agent 灞傦紙濡傛灉鎻愪緵浜?AID锛?
  if (selfAid) {
    try { read(ConfigTarget.Agent, { self: selfAid }); } catch {}
  }

  schemaVersionWarningsEnabled = false;
}

// Schema 鐗堟湰璀﹀憡鎺у埗锛氬彧鍦ㄥ惎鍔ㄦ椂妫€鏌ヤ竴娆?
let schemaVersionWarningsEnabled = false;

function configWarn(...args: unknown[]): void {
  console.warn(...args);
}

// 鈹€鈹€ 璺緞瑙ｆ瀽 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
  if (!sel?.self) throw new ConfigError('SELF_REQUIRED', `${target} 闇€瑕?selector.self`);
}
function requirePeer(sel: Selector | undefined, target: ConfigTarget): void {
  if (!sel?.self || !sel?.peerKey) throw new ConfigError('PEER_REQUIRED', `${target} 闇€瑕?selector.self + peerKey`);
}

// 鈹€鈹€ env 浣滅敤鍩?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function envScopeFor(sel?: Selector): EnvScope {
  const root = resolvePaths().root;
  const scope: EnvScope = { rootDir: root };
  if (sel?.self) scope.agentDir = agentDir(sel.self);
  if (sel?.self && sel?.peerKey) scope.relationDir = path.join(agentRelationsDir(sel.self), sel.peerKey);
  return scope;
}

// 鈹€鈹€ read 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface ReadOpts {
  /** 鏄惁灞曞紑 ${VAR}锛堜粎杩愯鏃跺唴閮ㄦ秷璐硅矾寰勭疆 true锛汣LI 璇昏矾寰勯粯璁?false锛夈€?*/
  expand?: boolean;
  /** 鏄惁璧?mtime 闂ㄦ帶缂撳瓨锛坉aemon 鐑矾寰勶級銆侰LI 瀛愯繘绋嬬暀榛樿 false銆?*/
  cache?: boolean;
}

/** 璇诲崟涓厤缃枃浠讹紝杩斿洖寮虹被鍨嬪璞★紱涓嶅瓨鍦ㄨ繑鍥?null锛堜笉鑷姩鍒涘缓锛夈€傛湭鐭ュ瓧娈典繚鐣欎絾涓嶆牎楠屻€?*/
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
  // schema 鐗堟湰杩佺Щ锛坮ead 鏃惰嫢 $schema_version < current锛?
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

  // AID 鏍￠獙锛堝鏋滄彁渚涗簡 aid锛?
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

  // 娓呯悊 projects.defaultPath 灏鹃儴鏂滄潬
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

// 鈹€鈹€ write 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface WriteOpts {
  /** 璺宠繃 schema 鏍￠獙锛堣縼绉诲唴閮ㄥ啓鍥炵敤锛夈€?*/
  skipValidate?: boolean;
  /** Allow trusted internal migrations to persist configs that would be downgraded at runtime. */
  allowRoleConstraintViolations?: boolean;
}

function normalizeAgentConfigForWrite<T extends Record<string, any>>(value: T): T {
  const mutable = { ...value } as Record<string, any>;

  // AID 鏍煎紡鏍￠獙
  if (mutable.aid && !isValidAid(mutable.aid)) {
    throw new ConfigError(
      'VALIDATION_ERROR',
      `Invalid aid "${mutable.aid}" (must be a valid multi-level domain like mybot.agentid.pub)`
    );
  }

  // 瑙勮寖鍖?projects 瀛楁锛氬彧淇濈暀 rootPath 鍜?defaultPath
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

function validateRoleConfigForTarget(target: ConfigTarget, value: Record<string, any>, sel?: Selector): void {
  if (!value || typeof value !== 'object') return;
  if (target === ConfigTarget.Agent) {
    validateAgentRolePolicy(value);
    return;
  }
  if (target === ConfigTarget.Relation) {
    validateRelationRoleAssignments(value, sel);
  }
}

function validateAgentRolePolicy(value: Record<string, any>): void {
  const policy = value.roles;
  if (!policy || typeof policy !== 'object') return;

  const definitions = policy.definitions && typeof policy.definitions === 'object'
    ? policy.definitions as Record<string, unknown>
    : {};
  const validRoleNames = new Set(Object.keys(getBuiltinRolesConfig().roles));

  for (const roleName of Object.keys(definitions)) {
    if (!isValidUserRoleNameLocal(roleName)) {
      throw new ConfigError('VALIDATION_ERROR', `Invalid user role definition: ${roleName}`);
    }
    validateRoleUsageLimits((definitions as Record<string, any>)[roleName]?.usageLimits, `roles.definitions.${roleName}.usageLimits`);
    validRoleNames.add(roleName);
  }

  const defaults = policy.defaultRoles && typeof policy.defaultRoles === 'object'
    ? policy.defaultRoles as Record<string, unknown>
    : {};
  for (const key of ['private', 'group']) {
    const role = defaults[key];
    if (role === undefined || role === null) continue;
    if (typeof role !== 'string' || !validRoleNames.has(role)) {
      throw new ConfigError('VALIDATION_ERROR', `Invalid default role for ${key}: ${String(role)}`);
    }
  }
}

function validateRoleUsageLimits(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('VALIDATION_ERROR', `${field} must be an object`);
  }
  const limits = value as Record<string, unknown>;
  if (limits.enabled !== undefined && typeof limits.enabled !== 'boolean') {
    throw new ConfigError('VALIDATION_ERROR', `${field}.enabled must be a boolean`);
  }
  if (limits.resetMode !== undefined && !ROLE_USAGE_RESET_MODES.has(String(limits.resetMode))) {
    throw new ConfigError('VALIDATION_ERROR', `${field}.resetMode must be never, daily, weekly, or monthly`);
  }
  if (limits.currency !== undefined && !ROLE_USAGE_CURRENCIES.has(String(limits.currency))) {
    throw new ConfigError('VALIDATION_ERROR', `${field}.currency must be CNY or USD`);
  }
  const amount = limits.limitAmount;
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new ConfigError('VALIDATION_ERROR', `${field}.limitAmount must be a non-negative number or null`);
    }
  }
  if (limits.costBasis !== undefined && !ROLE_USAGE_COST_BASIS.has(String(limits.costBasis))) {
    throw new ConfigError('VALIDATION_ERROR', `${field}.costBasis must be gateway or official`);
  }
  if (limits.scope !== undefined && !ROLE_USAGE_SCOPES.has(String(limits.scope))) {
    throw new ConfigError('VALIDATION_ERROR', `${field}.scope must be subject or role`);
  }
}

function validateRelationRoleAssignments(value: Record<string, any>, sel?: Selector): void {
  const roles = value.roles;
  if (!roles || typeof roles !== 'object') return;
  const selfAid = sel?.self;

  const assigned = roles.assigned;
  if (assigned !== undefined && assigned !== null) {
    validateAssignedUserRole(assigned, selfAid, 'roles.assigned');
  }

  const members = roles.members;
  if (!members || typeof members !== 'object') return;
  for (const [aid, role] of Object.entries(members)) {
    if (!aid || typeof aid !== 'string') {
      throw new ConfigError('VALIDATION_ERROR', `Invalid roles.members key: ${String(aid)}`);
    }
    if (role === null) continue;
    validateAssignedUserRole(role, selfAid, `roles.members.${aid}`);
  }
}

function validateAssignedUserRole(role: unknown, selfAid: string | undefined, field: string): void {
  if (typeof role !== 'string' || !isValidUserRoleNameLocal(role) || isReservedRoleName(role)) {
    throw new ConfigError('VALIDATION_ERROR', `${field} must be a user role, got ${String(role)}`);
  }
  if (selfAid && !roleExistsInAgentPolicy(role, selfAid)) {
    throw new ConfigError('VALIDATION_ERROR', `${field} references unknown role: ${role}`);
  }
}

function isValidUserRoleNameLocal(role: unknown): role is string {
  return typeof role === 'string'
    && USER_ROLE_NAME_RE.test(role)
    && !isReservedRoleName(role);
}

function roleExistsInAgentPolicy(role: string, selfAid: string): boolean {
  if (!isValidUserRoleNameLocal(role)) return false;
  if (Object.prototype.hasOwnProperty.call(getBuiltinRolesConfig().roles, role)) return true;
  const agent = read<AgentConfig>(ConfigTarget.Agent, { self: selfAid }, { cache: true });
  return !!agent?.roles?.definitions
    && Object.prototype.hasOwnProperty.call(agent.roles.definitions, role);
}

/** 鍐欏叆锛氣憼 schema 鏍￠獙 鈶?ensureFile 鐩綍 鈶?鍘熷瓙鍐欏叆銆傚揩鐓х敱璋冪敤鏂?鍚姩娴佺▼缁熺銆?*/
export function write<T = any>(target: ConfigTarget, value: T, sel?: Selector, opts: WriteOpts = {}): void {
  const schema = loadSchema(TARGET_SCHEMA[target]);
  const withVer = ensureSchemaVersion(value as any, schema.version);
  const file = targetPath(target, sel);
  const migrated = withVer;

  // Agent config 鍐欏叆瑙勮寖鍖栵紙aid 鏍￠獙銆乸rojects 瀛楁娓呯悊锛?
  const normalized = target === ConfigTarget.Agent
    ? normalizeAgentConfigForWrite(migrated as any) as any
    : migrated;

  validateRoleConfigForTarget(target, normalized as any, sel);

  // 1. Schema 鏍￠獙
  if (!opts.skipValidate) {
    validateOrThrow(schema, normalized, target);
  }

  // 2. 瑙掕壊绾︽潫鏍￠獙锛堜粎瀵?Relation锛?
  if (target === ConfigTarget.Relation && sel?.self && sel?.peerKey) {
    try {
      const validation = validateConfigWrite(target, normalized as any, sel);
      if (!validation.valid) {
        console.warn(`[config-manager] Role constraint violations on write:`,
          validation.violations.map(v => `${v.field}: ${v.reason}`));
        if (sel.role && !opts.allowRoleConstraintViolations) {
          throw new ConfigError('ROLE_VIOLATION', 'Config violates role constraints');
        }
      }
    } catch (err) {
      if (err instanceof ConfigError && err.code === 'ROLE_VIOLATION') throw err;
      console.warn('[config-manager] Failed to validate role constraints on write:', err);
      // 楠岃瘉澶辫触涓嶉樆姝㈠啓鍏ワ紝鍙褰曡鍛?
    }
  }

  // 3. 鍐欏叆鏂囦欢
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
    throw new ConfigError('SCHEMA_INVALID', `${target} 閰嶇疆涓嶅悎 schema(${schema.logicalName}.v${schema.version}): ${errs}`);
  }
}

/**
 * 绾?schema 鏍￠獙锛堜笉鍐欑洏銆佹棤鍓綔鐢級銆傝繑鍥為敊璇俊鎭暟缁勶紝绌烘暟缁?閫氳繃銆?
 * 渚?config-store.validateAgentConfig 绛夊彧鏍￠獙涓嶈惤鐩樼殑鍦烘櫙浣跨敤銆?
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

// 鈹€鈹€ ensureFile 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 鎸?schema 鐨?required/default 鐢熸垚楠ㄦ灦骞跺啓鍏ワ紙骞傜瓑锛氬凡瀛樺湪涓嶈鐩栵級銆?*/
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

// 鈹€鈹€ schema 鐗堟湰杩佺Щ 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// 鍚屾璺緞鍙仛"鐗堟湰鍙峰垽鏂?+ 鏍囪"锛涚湡姝ｉ€愮増鏈縼绉诲嚱鏁版槸 .ts锛堝姩鎬?import 寮傛锛夈€?
// 褰撳墠鎵€鏈?schema 鍧囦负 v1锛屾棤杩佺Щ鍑芥暟鈥斺€旀澶勪粎鍦ㄧ増鏈惤鍚庢椂 warn锛岀暀 seam銆?

function migrateIfNeeded<T>(target: ConfigTarget, raw: T, file: string): T {
  const logical = TARGET_SCHEMA[target];
  const cur = currentVersion(logical);
  const have = (raw as any)?.$schema_version;
  if (typeof have === 'number' && have < cur && schemaVersionWarningsEnabled) {
    // P0锛氳縼绉诲嚱鏁板皻鏈瓨鍦紙鍏?v1锛夈€傜暀 seam锛氭湭鏉ュ湪姝?require migrations/{logical}.{N}-to-{N+1}.
    configWarn(`[config] ${file}: $schema_version ${have} < current ${cur} for "${logical}" 鈥?migration pending (seam)`);
  }
  return raw;
}

export function resolveAgentConfig(sel: { self?: string; peerKey?: string }, opts: ReadOpts = {}): AgentConfig {
  // Use agent-config as the H-chain field table, but static owners only come from agent config.
  const fields = loadSchema('agent-config').fields;
  const agentConfig = sel.self ? read<AgentConfig>(ConfigTarget.Agent, sel, opts) : null;
  const relationConfig = (sel.self && sel.peerKey) ? read<RelationConfig>(ConfigTarget.Relation, sel, opts) as any : null;
  const layers: Array<Partial<AgentConfig> | null> = [
    stripStaticOwnerField(read<DefaultsConfig>(ConfigTarget.Defaults, undefined, opts) as any),
    agentConfig,
    stripRelationRoleField(stripStaticOwnerField(relationConfig)),
  ];
  const merged = mergeLayers<AgentConfig>(layers, fields);
  return merged;
}

function stripStaticOwnerField<T extends Record<string, any>>(config: T | null): T | null {
  if (!config) return config;
  if (!Object.prototype.hasOwnProperty.call(config, 'owners') && !Object.prototype.hasOwnProperty.call(config, 'admins')) return config;
  const { owners: _owners, admins: _admins, ...rest } = config;
  return rest as T;
}

function stripRelationRoleField<T extends Record<string, any>>(config: T | null): T | null {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'roles')) return config;
  const { roles: _roles, ...rest } = config;
  return rest as T;
}

// 鈹€鈹€ effective锛堝悎骞惰鍥撅級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 娣卞害鍚堝苟杈呭姪鍑芥暟
 * 鐢ㄤ簬鍚堝苟瑙掕壊绾︽潫缁撴灉锛岄伩鍏嶈鐩栧祵濂楀璞?
 */
function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') return source;
  if (Array.isArray(source)) return source; // 鏁扮粍鐩存帴鏇挎崲

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
 * 鍚堝苟瑙嗗浘锛氬悎骞惰鐩栭摼锛坉efaults 鈫?agent/config 鈫?relation/config锛夛紝
 * 鐒跺悗搴旂敤瑙掕壊绾︽潫锛堝鏈夛級銆倂3 璁捐鎵€鏈夊弬鏁扮粺涓€鍦?config.json銆?
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
    sessionManifests: config.sessionManifests,
    enable_rich_content: config.enable_rich_content,
    permissionMode: config.permissionMode,
    roles: config.roles,
  };

  // v3 璁捐锛氱洿鎺ヨ繑鍥?effective锛岀劧鍚庡簲鐢ㄨ鑹茬害鏉燂紙濡傛湁锛?
  let result = effective;

  // 濡傛灉鏈?peerKey锛屽簲鐢ㄨ鑹茬害鏉燂紙浼樺厛浣跨敤 sel.role锛?
  if (sel.self && sel.peerKey && sel.role) {
    try {
      const role = sel.role;

      // 鎻愬彇琛屼负瀛楁浣滀负 relationConfig
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
        'render',
        'sessionManifests'
      ];

      for (const field of behaviorFieldNames) {
        if (field.includes('.')) {
          // 宓屽瀛楁锛屾彁鍙栦负鎵佸钩閿?
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
          // 椤跺眰瀛楁
          if ((result as any)[field] !== undefined) {
            behaviorFields[field] = (result as any)[field];
          }
        }
      }

      // 搴旂敤瑙掕壊绾︽潫
      const constrained = mergeWithRoleConstraints(role, behaviorFields, sel.self);

      if (!constrained.valid) {
        console.warn(`[config-manager] Role constraint violations for ${sel.peerKey} (${role}):`,
          constrained.violations.map(v => `${v.field}: ${v.reason}`));
      }

      // 灏嗙害鏉熷悗鐨勯厤缃繁搴﹀悎骞跺洖 result锛堥伩鍏嶈鐩栧祵濂楀璞★級
      result = deepMerge(result, constrained.effectiveConfig);
    } catch (err) {
      console.warn('[config-manager] Failed to apply role constraints:', err);
      // 澶辫触鏃剁户缁紝涓嶉樆濉為厤缃В鏋?
    }
  }

  return normalizeEffectiveCompatibility(result);
}

/**
 * 閰嶇疆鍐欏叆鍓嶇殑瑙掕壊绾︽潫鏍￠獙
 * 浠呭 Relation 杩涜瑙掕壊绾︽潫妫€鏌?
 *
 * @param target 閰嶇疆鐩爣
 * @param config 寰呭啓鍏ラ厤缃?
 * @param sel 閫夋嫨鍣?
 * @returns 绾︽潫妫€鏌ョ粨鏋?
 */
export function validateConfigWrite(
  target: ConfigTarget,
  config: Record<string, any>,
  sel: Selector
): { valid: boolean; violations: any[]; effectiveConfig: any } {
  // v3 璁捐锛氬彧瀵?Relation 杩涜瑙掕壊绾︽潫妫€鏌?
  if (target !== ConfigTarget.Relation) {
    return { valid: true, violations: [], effectiveConfig: config };
  }

  if (!sel.self || !sel.peerKey) {
    throw new ConfigError('SELECTOR_REQUIRED', 'Relation requires self and peerKey');
  }

  try {
    if (!sel.role) return { valid: true, violations: [], effectiveConfig: config };
    const { roles: _roles, ...behaviorConfig } = config;
    return mergeWithRoleConstraints(sel.role, behaviorConfig, sel.self);
  } catch (err) {
    console.warn('[config-manager] Failed to validate config write:', err);
    // 楠岃瘉澶辫触鏃讹紝鍏佽鍐欏叆浣嗚褰曡鍛?
    return { valid: true, violations: [], effectiveConfig: config };
  }
}

function normalizeEffectiveCompatibility<T extends EffectiveAgentConfig>(effective: T): T {
  if ((effective as any).dispatch === 'all' || (effective as any).dispatch === 'none') {
    (effective as any).dispatch = 'broadcast';
  }
  const behavior: Record<string, unknown> = {};
  for (const field of EFFECTIVE_BEHAVIOR_FIELDS) {
    if ((effective as any)[field] !== undefined) behavior[field] = (effective as any)[field];
  }
  if (Object.keys(behavior).length > 0) {
    (effective as any).behavior = behavior;
  }
  return effective;
}

// 鈹€鈹€ 瀛楁 鈫?target 璺敱锛堟寜 schema 褰掑睘鍒ゅ畾锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
  'sessionManifests',
  'enable_rich_content',
  'permissionMode',
]);

const EFFECTIVE_BEHAVIOR_FIELDS = [
  'active_baseagent',
  'baseagents',
  'chatmode',
  'flush_delay',
  'debounce',
  'dispatch',
  'show_activities',
  'proactive',
  'render',
  'sessionManifests',
  'enable_rich_content',
  'permissionMode',
  'roles',
];

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
 * 缁欏畾 selector 浣滅敤鍩?+ 椤跺眰瀛楁鍚嶏紝鍒ゅ畾鍐欏叆钀界偣銆?
 * 鍏煎鏃ц皟鐢細浠呮寜椤跺眰瀛楁璺敱銆傛柊鍐欏叆璇蜂紭鍏堜娇鐢?routeFieldPath()銆?
 */
export function routeField(
  topField: string,
  scope: ConfigScope,
): FieldRoute {
  return routeFieldPath(topField, scope);
}

/**
 * 缁欏畾 selector 浣滅敤鍩?+ 瀹屾暣瀛楁璺緞锛屽垽瀹?canonical 鍐欏叆钀界偣銆?
 * v3 璁捐锛氭墍鏈夊弬鏁扮粺涓€鍦?config.json锛屾寜浣滅敤鍩熻矾鐢卞埌瀵瑰簲灞傜骇銆?
 */
export function routeFieldPath(
  fieldPath: string,
  scope: ConfigScope,
): FieldRoute {
  const topField = fieldPath.split('.')[0];
  if (scope === 'process') return routeIn('evolclaw', ConfigTarget.Process, topField);
  if (scope === 'defaults') {
    if (isBehaviorFieldPath(fieldPath)) {
      throw new ConfigError('DEFAULT_BEHAVIOR_REJECT', `--default 不支持行为字段: ${fieldPath}`);
    }
    return routeIn('defaults', ConfigTarget.Defaults, topField);
  }

  if (isBehaviorFieldPath(fieldPath)) {
    // v3 璁捐锛氳涓哄瓧娈垫寜浣滅敤鍩熻矾鐢卞埌瀵瑰簲鐨?schema
    if (scope === 'agent') {
      return routeIn('agent-config', ConfigTarget.Agent, topField);
    }
    // relation 浣滅敤鍩燂細琛屼负瀛楁鍦?relation-config 涓?
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
  // $schema_version 鏄厓鏁版嵁瀛楁锛岀壒娈婂鐞?
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
  if (!s.fields.has(topField)) throw new ConfigError('UNKNOWN_FIELD', `Unknown config field: ${topField} (${name})`);
  return mkRoute(s, target, topField);
}

function mkRoute(s: SchemaEntry, target: ConfigTarget, topField: string): FieldRoute {
  const spec = s.fields.get(topField)!;
  return { field: topField, target, schema: s.logicalName, permission: s.permission, merge: spec.merge, enum: spec.enum };
}

/** 鍒楀嚭鏌愪綔鐢ㄥ煙涓嬫墍鏈夊彲璁惧瓧娈碉紙ec config fields 鐢級銆?*/
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

// 鈹€鈹€ 鏉ユ簮杩借釜锛圫ource Tracking锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 瀛楁鏉ユ簮淇℃伅 */
export interface FieldSource {
  target: ConfigTarget;
  file: string;  // 鐩稿浜?root 鐨勮矾寰?
}

/** 甯︽潵婧愮殑鍊?*/
export interface ValueWithSource<T = any> {
  value: T;
  source: FieldSource;
}

/**
 * 璇诲彇鍗曚釜瀛楁骞惰繑鍥炴潵婧愪俊鎭€?
 * 娌胯鐩栭摼鏌ユ壘锛岃繑鍥炵涓€涓畾涔夎瀛楁鐨勫眰绾с€?
 */
export function readFieldWithSource(
  field: string,
  sel: Selector,
  opts: ReadOpts = {}
): ValueWithSource | null {
  const parts = field.split('.');
  const topField = parts[0];

  // 鎸夎鐩栭摼椤哄簭鏌ユ壘锛歳elation 鈫?agent 鈫?defaults
  const targets: ConfigTarget[] = [];
  if (sel.peerKey) targets.push(ConfigTarget.Relation);
  if (sel.self) targets.push(ConfigTarget.Agent);
  targets.push(ConfigTarget.Defaults);

  for (const target of targets) {
    const config = read<any>(target, sel, opts);
    if (!config) continue;

    // 妫€鏌ラ《灞傚瓧娈垫槸鍚﹀瓨鍦?
    if (!(topField in config)) continue;

    // 鎻愬彇瀛楁鍊硷紙鏀寔宓屽锛?
    let value = config[topField];
    for (let i = 1; i < parts.length; i++) {
      if (value && typeof value === 'object' && parts[i] in value) {
        value = value[parts[i]];
      } else {
        value = undefined;
        break;
      }
    }

    // 濡傛灉鍊煎瓨鍦紝杩斿洖甯︽潵婧?
    if (value !== undefined) {
      const file = path.relative(resolvePaths().root, targetPath(target, sel));
      return {
        value,
        source: { target, file }
      };
    }
  }

  return null;
}

/**
 * 瑙ｆ瀽 effective 閰嶇疆骞舵爣娉ㄦ瘡瀛楁鏉ユ簮銆?
 * 杩斿洖涓€涓璞★紝姣忎釜瀛楁閮藉甫鏈?value 鍜?source銆?
 */
export function resolveEffectiveWithSources(
  sel: Selector,
  opts: ReadOpts = {}
): Record<string, ValueWithSource> {
  const effective = resolveEffective(sel, opts);
  const result: Record<string, ValueWithSource> = {};

  // 瀵规瘡涓《灞傚瓧娈垫煡鎵炬潵婧?
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined) continue;

    const withSource = readFieldWithSource(key, sel, opts);
    if (withSource) {
      result[key] = withSource;
    } else {
      // 濡傛灉鎵句笉鍒版潵婧愶紙鍙兘鏄粯璁ゅ€硷級锛屾爣璁颁负 agent
      const file = path.relative(resolvePaths().root, targetPath(ConfigTarget.Agent, sel));
      result[key] = {
        value,
        source: { target: ConfigTarget.Agent, file }
      };
    }
  }

  return result;
}
