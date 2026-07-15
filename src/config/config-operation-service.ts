import {
  ConfigError,
  ConfigTarget,
  ensureFile,
  listFields,
  read,
  resolveEffectiveFieldWithSource,
  resolveEffectiveWithSources,
  validateConfigFile,
  write,
  type EffectiveFieldSource,
  type FieldRoute,
  type Selector,
} from './config-manager.js';
import {
  collectConfigFiles,
  diffVersions,
  listAllVersions,
  prune,
  readCurrent,
  restore,
  snapshot,
  type CurrentPointer,
  type PruneResult,
  type SnapshotMeta,
  type SnapshotResult,
  type VersionDiff,
} from './snapshot.js';
import { readBootLog, type BootLogEntry } from './boot-log.js';
import {
  currentVersion,
  fieldSchemaDefault,
  isSchemaName,
  listSchemaNames,
  listSchemaVersions,
  readRawSchema,
  schemaHistoryEntry,
  type LogicalSchemaName,
} from './schema-registry.js';
import fs from 'fs';
import path from 'path';
import { resolvePaths, agentDir, agentRelationConfig } from '../paths.js';
import type {
  ResolvedConfigCommand,
  ResolvedConfigOp,
  ResolvedGlobalConfigCommand,
  ResolvedScopedConfigCommand,
} from './resolved-config-op.js';

export type ConfigExecutionResult =
  | {
      ok: true;
      subcommand: 'get';
      field: string;
      value: unknown;
      scope: ResolvedConfigOp['configScope'];
      source?: { target: EffectiveFieldSource; file?: string };
      schemaDefault?: boolean;
      note?: string;
    }
  | {
      ok: true;
      subcommand: 'set';
      field: string;
      value: unknown;
      scope: ResolvedConfigOp['configScope'];
      file: string;
    }
  | {
      ok: true;
      subcommand: 'unset';
      field: string;
      removed: boolean;
      scope: ResolvedConfigOp['configScope'];
    }
  | { ok: true; subcommand: 'show'; scope: string; configs: Record<string, unknown> }
  | { ok: true; subcommand: 'effective'; scope: string; effective: Record<string, unknown> }
  | { ok: true; subcommand: 'fields'; scope: string; fields: FieldRoute[] }
  | { ok: true; subcommand: 'validate'; valid: boolean; results: Array<{ target: string; ok: boolean; error?: string }> }
  | { ok: true; subcommand: 'init'; scope: string }
  | { ok: true; subcommand: 'list'; files: string[] }
  | ({ ok: true; subcommand: 'snapshot' } & SnapshotResult)
  | ({ ok: true; subcommand: 'prune'; dryRun: boolean } & PruneResult)
  | { ok: true; subcommand: 'history'; versions: SnapshotMeta[] }
  | ({ ok: true; subcommand: 'diff' } & VersionDiff)
  | { ok: true; subcommand: 'restore'; version: string; appliedFiles: number }
  | { ok: true; subcommand: 'current'; current: CurrentPointer | null; lastBoot: BootLogEntry | null }
  | { ok: true; subcommand: 'boots'; boots: BootLogEntry[] }
  | { ok: true; subcommand: 'schema'; mode: 'overview'; schemas: Array<{ name: string; current: number }> }
  | {
      ok: true;
      subcommand: 'schema';
      mode: 'versions';
      name: string;
      current: number;
      versions: Array<{ version: number; current: boolean; date?: string; description?: string }>;
    }
  | { ok: true; subcommand: 'schema'; mode: 'content'; name: string; version: number; current: boolean; content: unknown }
  | { ok: false; code: string; error: string };

export interface ConfigExecutionOptions {
  role?: string;
}

export function executeResolvedConfigCommand(
  command: ResolvedConfigCommand,
  options: ConfigExecutionOptions = {},
): ConfigExecutionResult {
  try {
    const missingAgent = selectedAgentError(command);
    if (missingAgent) return missingAgent;
    if (command.kind === 'field') return executeResolvedConfigOperation(command, options);
    if (command.kind === 'scoped') return executeScoped(command, options);
    return executeGlobal(command);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 'CONFIG_ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

export function executeResolvedConfigOperation(
  op: ResolvedConfigOp,
  options: ConfigExecutionOptions = {},
): ConfigExecutionResult {
  try {
    const missingAgent = selectedAgentError(op);
    if (missingAgent) return missingAgent;
    if (op.subcommand === 'get') return executeGet(op, options);
    if (op.subcommand === 'set') return executeSet(op);
    return executeUnset(op);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 'CONFIG_ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

function selectedAgentError(command: Pick<ResolvedConfigCommand, 'self'>): ConfigExecutionResult | undefined {
  if (!command.self || fs.existsSync(agentDir(command.self))) return undefined;
  return {
    ok: false,
    code: 'AGENT_NOT_FOUND',
    error: `Agent "${command.self}" does not exist. Create it with "ec agent create --aid ${command.self}".`,
  };
}

function executeScoped(command: ResolvedScopedConfigCommand, options: ConfigExecutionOptions): ConfigExecutionResult {
  const selector = selectorFor(command, options);
  const target = targetForScope(command.configScope);
  if (command.subcommand === 'show') {
    return {
      ok: true,
      subcommand: 'show',
      scope: command.configScope,
      configs: { [target]: read(target, selector) || {} },
    };
  }
  if (command.subcommand === 'effective') {
    if (command.configScope === 'process') {
      return {
        ok: true,
        subcommand: 'effective',
        scope: command.configScope,
        effective: read<Record<string, unknown>>(ConfigTarget.Process, selector) || {},
      };
    }
    const effective: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(resolveEffectiveWithSources(selector))) {
      effective[key] = { value: item.value, source: item.source };
    }
    return { ok: true, subcommand: 'effective', scope: command.configScope, effective };
  }
  if (command.subcommand === 'fields') {
    let fields = listFields(command.configScope);
    if (command.field) {
      fields = fields.filter(route => route.field === command.field || route.field.startsWith(`${command.field}.`));
    }
    return { ok: true, subcommand: 'fields', scope: command.configScope, fields };
  }
  if (command.subcommand === 'validate') {
    const validation = validateConfigFile(target, selector);
    const errors = validation.errors;
    return {
      ok: true,
      subcommand: 'validate',
      valid: errors.length === 0,
      results: [{
        target,
        ok: errors.length === 0,
        ...(!validation.exists ? { error: '(not found, skipped)' } : {}),
        ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      }],
    };
  }

  ensureFile(target, selector);
  return { ok: true, subcommand: 'init', scope: command.configScope };
}

function executeGlobal(command: ResolvedGlobalConfigCommand): ConfigExecutionResult {
  if (command.subcommand === 'list') {
    return { ok: true, subcommand: 'list', files: collectConfigFiles(resolvePaths().root) };
  }
  if (command.subcommand === 'snapshot') {
    return {
      ok: true,
      subcommand: 'snapshot',
      ...snapshot('manual', { full: command.full, description: command.description }),
    };
  }
  if (command.subcommand === 'prune') {
    const dryRun = !command.yes;
    return {
      ok: true,
      subcommand: 'prune',
      dryRun,
      ...prune({ keepFull: command.keepFull, keepDelta: command.keepDelta, dryRun }),
    };
  }
  if (command.subcommand === 'history') {
    return { ok: true, subcommand: 'history', versions: listAllVersions() };
  }
  if (command.subcommand === 'diff') {
    const [first, second] = command.versions!;
    const result = diffVersions(first, second);
    if ('error' in result) return { ok: false, code: 'VERSION_NOT_FOUND', error: result.error };
    return { ok: true, subcommand: 'diff', ...result };
  }
  if (command.subcommand === 'restore') {
    const result = restore(command.version!);
    if (!result.ok || !result.version) {
      return { ok: false, code: 'RESTORE_FAILED', error: result.error || 'restore failed' };
    }
    return {
      ok: true,
      subcommand: 'restore',
      version: result.version,
      appliedFiles: result.appliedFiles ?? 0,
    };
  }
  if (command.subcommand === 'current') {
    return {
      ok: true,
      subcommand: 'current',
      current: readCurrent(),
      lastBoot: readBootLog(1)[0] ?? null,
    };
  }
  if (command.subcommand === 'schema') {
    return executeSchema(command);
  }
  return { ok: true, subcommand: 'boots', boots: readBootLog(command.count ?? 10) };
}

function executeSchema(command: ResolvedGlobalConfigCommand): ConfigExecutionResult {
  // 无 name：列出全部 schema 及各自当前版本
  if (!command.schemaName) {
    return {
      ok: true,
      subcommand: 'schema',
      mode: 'overview',
      schemas: listSchemaNames().map(name => ({ name, current: currentVersion(name) })),
    };
  }

  const name = command.schemaName;
  if (!isSchemaName(name)) {
    return {
      ok: false,
      code: 'UNKNOWN_SCHEMA',
      error: `Unknown schema: ${name} (known: ${listSchemaNames().join(', ')})`,
    };
  }

  const current = currentVersion(name);

  // --list：列出磁盘上全部版本，标记当前，附 history 元信息
  if (command.schemaList) {
    const versions = listSchemaVersions(name).map(version => {
      const history = schemaHistoryEntry(name, version);
      return {
        version,
        current: version === current,
        ...(history ? { date: history.date, description: history.description } : {}),
      };
    });
    return { ok: true, subcommand: 'schema', mode: 'versions', name, current, versions };
  }

  // 内容：指定版本，缺省取当前版本
  const version = command.schemaVersion ?? current;
  if (!listSchemaVersions(name).includes(version)) {
    return {
      ok: false,
      code: 'SCHEMA_VERSION_NOT_FOUND',
      error: `Schema ${name} has no version ${version} (available: ${listSchemaVersions(name).join(', ')})`,
    };
  }
  return {
    ok: true,
    subcommand: 'schema',
    mode: 'content',
    name,
    version,
    current: version === current,
    content: readRawSchema(name as LogicalSchemaName, version),
  };
}

function executeGet(op: ResolvedConfigOp, options: ConfigExecutionOptions): ConfigExecutionResult {
  const selector = selectorFor(op, options);
  if (op.configScope === 'process') {
    const config = read<Record<string, unknown>>(ConfigTarget.Process, selector) || {};
    const stored = getNested(config, op.field);
    if (stored !== undefined) {
      return { ok: true, subcommand: 'get', field: op.field, value: stored, scope: op.configScope };
    }
    return getWithSchemaDefault(op, null);
  }

  const withSource = resolveEffectiveFieldWithSource(op.field, selector);
  // 关系级作用域下始终诊断 relation 层的贡献情况：命中非 relation 层时解释回退原因
  // （对端不存在/无配置文件/未设值），命中 relation 层但值非法时给出告警。
  const note = op.configScope === 'relation'
    ? diagnoseRelationLayer(op, withSource.source === 'relation')
    : undefined;
  if (withSource.source) {
    return {
      ok: true,
      subcommand: 'get',
      field: op.field,
      value: withSource.value,
      scope: op.configScope,
      source: {
        target: withSource.source,
        ...(withSource.file ? { file: withSource.file } : {}),
      },
      ...(note ? { note } : {}),
    };
  }
  return getWithSchemaDefault(op, null, note);
}

/**
 * 关系级取值时诊断 relation 层。
 * @param hitRelation 最终取值是否来自 relation 层。
 *   - 未命中 relation：解释为何回退（对端不存在 / 无配置文件 / JSON 损坏 / 该字段未设）。
 *   - 命中 relation：正常无需说明；但若该值不在 schema 候选清单内，给出"非法值"告警。
 */
function diagnoseRelationLayer(op: ResolvedConfigOp, hitRelation: boolean): string | undefined {
  if (!op.self || !op.peerKey) return undefined;
  const relFile = agentRelationConfig(op.self, op.peerKey);
  if (!fs.existsSync(relFile)) {
    return hitRelation ? undefined
      : `relation layer skipped: peer "${op.peerKey}" has no config file (${relPath(relFile)})`;
  }
  let relConfig: Record<string, unknown>;
  try {
    relConfig = JSON.parse(fs.readFileSync(relFile, 'utf-8'));
  } catch (error) {
    return `relation config ${relPath(relFile)} is not readable JSON (${error instanceof Error ? error.message : String(error)})`;
  }
  const stored = getNested(relConfig, op.field);
  if (stored === undefined) {
    return hitRelation ? undefined
      : `relation layer skipped: "${op.field}" not set for peer "${op.peerKey}"`;
  }
  const allowed = op.route?.enum;
  if (allowed && !allowed.includes(stored as string)) {
    return `relation value ${JSON.stringify(stored)} is not a valid ${op.field} (expected: ${allowed.join(' | ')})`;
  }
  return undefined;
}

function relPath(absolute: string): string {
  return path.relative(resolvePaths().root, absolute);
}

/**
 * 各存储层都无值时的兜底：若 schema 为该字段声明了 `default`，展示出厂默认并标记
 * schemaDefault=true（仅影响 `ec config get` 的展示；运行时 resolveEffective 不受影响，
 * 未设值仍为 undefined，以保留协议层回退等既有语义）。
 */
function getWithSchemaDefault(op: ResolvedConfigOp, absent: null, note?: string): ConfigExecutionResult {
  const nt = note ? { note } : {};
  const schemaDefault = op.route ? fieldSchemaDefault(op.route.schema, op.field) : undefined;
  if (schemaDefault !== undefined) {
    return { ok: true, subcommand: 'get', field: op.field, value: schemaDefault, scope: op.configScope, schemaDefault: true, ...nt };
  }
  return { ok: true, subcommand: 'get', field: op.field, value: absent, scope: op.configScope, ...nt };
}

function executeSet(op: ResolvedConfigOp): ConfigExecutionResult {
  if (!op.route) return { ok: false, code: 'UNKNOWN_FIELD', error: `Unknown config field: ${op.field}` };
  const selector = selectorFor(op);
  const existing = read<Record<string, any>>(op.route.target, selector) || {};
  if (op.route.merge === 'list') {
    const previous = getNested(existing, op.field);
    const previousItems = Array.isArray(previous) ? previous : [];
    const nextItems = Array.isArray(op.value) ? op.value : [op.value];
    const merged = [...new Set([...previousItems, ...nextItems].map(value =>
      typeof value === 'object' ? JSON.stringify(value) : value))]
      .map(value => {
        try { return typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value; }
        catch { return value; }
      });
    setNested(existing, op.field, merged);
  } else {
    setNested(existing, op.field, op.value);
  }
  ensureFile(op.route.target, selector);
  write(op.route.target, existing, selector);
  return {
    ok: true,
    subcommand: 'set',
    field: op.field,
    value: op.value,
    scope: op.configScope,
    file: op.route.schema,
  };
}

function executeUnset(op: ResolvedConfigOp): ConfigExecutionResult {
  if (!op.route) return { ok: false, code: 'UNKNOWN_FIELD', error: `Unknown config field: ${op.field}` };
  const selector = selectorFor(op);
  const existing = read<Record<string, any>>(op.route.target, selector);
  if (!existing) {
    return { ok: true, subcommand: 'unset', field: op.field, removed: false, scope: op.configScope };
  }
  const parts = op.field.split('.');
  let current: any = existing;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null) break;
    current = current[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  const removed = !!current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, leaf);
  if (removed) delete current[leaf];
  write(op.route.target, existing, selector);
  return { ok: true, subcommand: 'unset', field: op.field, removed, scope: op.configScope };
}

function selectorFor(
  command: Pick<ResolvedConfigCommand, 'self' | 'peerKey'>,
  options: ConfigExecutionOptions = {},
): Selector {
  return {
    ...(command.self ? { self: command.self } : {}),
    ...(command.peerKey ? { peerKey: command.peerKey } : {}),
    ...(options.role ? { role: options.role } : {}),
  };
}

function targetForScope(scope: ResolvedScopedConfigCommand['configScope']): ConfigTarget {
  if (scope === 'process') return ConfigTarget.Process;
  if (scope === 'defaults') return ConfigTarget.Defaults;
  if (scope === 'agent') return ConfigTarget.Agent;
  return ConfigTarget.Relation;
}

function setNested(object: Record<string, any>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current = object;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getNested(object: any, dotPath: string): unknown {
  return dotPath.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}
