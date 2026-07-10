import {
  ConfigError,
  ConfigTarget,
  ensureFile,
  read,
  readFieldWithSource,
  write,
  type Selector,
} from './config-manager.js';
import type { ResolvedConfigOp } from './resolved-config-op.js';

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
      permission: string;
      file: string;
    }
  | {
      ok: true;
      subcommand: 'unset';
      field: string;
      removed: boolean;
      scope: ResolvedConfigOp['configScope'];
    }
  | { ok: false; code: string; error: string };

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
    permission: op.route.permission,
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

function selectorFor(op: ResolvedConfigOp): Selector {
  return {
    ...(op.self ? { self: op.self } : {}),
    ...(op.peerKey ? { peerKey: op.peerKey } : {}),
  };
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
