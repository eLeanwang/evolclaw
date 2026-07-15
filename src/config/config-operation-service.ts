import {
  ConfigError,
  ConfigTarget,
  ensureFile,
  listFields,
  read,
  readFieldWithSource,
  resolveEffectiveWithSources,
  validateConfigFile,
  write,
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
  isSchemaName,
  listSchemaNames,
  listSchemaVersions,
  readRawSchema,
  schemaHistoryEntry,
  type LogicalSchemaName,
} from './schema-registry.js';
import { resolvePaths } from '../paths.js';
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
      source?: { target: ConfigTarget; file: string };
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

export function executeResolvedConfigCommand(command: ResolvedConfigCommand): ConfigExecutionResult {
  try {
    if (command.kind === 'field') return executeResolvedConfigOperation(command);
    if (command.kind === 'scoped') return executeScoped(command);
    return executeGlobal(command);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 'CONFIG_ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

export function executeResolvedConfigOperation(op: ResolvedConfigOp): ConfigExecutionResult {
  try {
    if (op.subcommand === 'get') return executeGet(op);
    if (op.subcommand === 'set') return executeSet(op);
    return executeUnset(op);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 'CONFIG_ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

function executeScoped(command: ResolvedScopedConfigCommand): ConfigExecutionResult {
  const selector = selectorFor(command);
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
      effective[key] = { value: item.value, source: item.source.target };
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

function executeGet(op: ResolvedConfigOp): ConfigExecutionResult {
  const selector = selectorFor(op);
  if (op.configScope === 'process') {
    const config = read<Record<string, unknown>>(ConfigTarget.Process, selector) || {};
    return {
      ok: true,
      subcommand: 'get',
      field: op.field,
      value: getNested(config, op.field) ?? null,
      scope: op.configScope,
    };
  }

  const withSource = readFieldWithSource(op.field, selector);
  return {
    ok: true,
    subcommand: 'get',
    field: op.field,
    value: withSource?.value ?? null,
    scope: op.configScope,
    ...(withSource ? { source: { target: withSource.source.target, file: withSource.source.file } } : {}),
  };
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

function selectorFor(command: Pick<ResolvedConfigCommand, 'self' | 'peerKey'>): Selector {
  return {
    ...(command.self ? { self: command.self } : {}),
    ...(command.peerKey ? { peerKey: command.peerKey } : {}),
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
