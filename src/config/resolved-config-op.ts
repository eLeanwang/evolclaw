import type { CommandScope } from '../types.js';
import { normalizeCliArgv } from '../cli/cli-argv.js';
import { parseConfigSelector, type ConfigSelectorScope } from '../cli/config-selector.js';
import {
  parseConfigFieldValue,
  resolveConfigFieldRule,
  type ConfigFieldRule,
} from './config-field-policy.js';
import { ConfigError, routeFieldPath, type FieldRoute } from './config-manager.js';

export type ConfigFieldSubcommand = 'get' | 'set' | 'unset';
export type ConfigScopedSubcommand = 'show' | 'effective' | 'fields' | 'validate' | 'init';
export type ConfigGlobalSubcommand = 'list' | 'snapshot' | 'prune' | 'history' | 'diff' | 'restore' | 'current' | 'boots';
export type ConfigSubcommand = ConfigFieldSubcommand | ConfigScopedSubcommand | ConfigGlobalSubcommand;

export type ConfigOperationId =
  | 'config.get'
  | 'config.set'
  | 'config.unset'
  | 'config.read'
  | 'config.write';

export type ConfigManagementOperationId =
  | 'config.show'
  | 'config.effective'
  | 'config.fields'
  | 'config.validate'
  | 'config.init'
  | 'config.list'
  | 'config.snapshot'
  | 'config.prune'
  | 'config.history'
  | 'config.diff'
  | 'config.restore'
  | 'config.current'
  | 'config.boots';

export interface ResolvedConfigOp {
  kind: 'field';
  canonicalArgv: string[];
  subcommand: ConfigFieldSubcommand;
  configScope: ConfigSelectorScope;
  commandScope: CommandScope;
  operationId: ConfigOperationId;
  dangerous: boolean;
  field: string;
  fieldRule: ConfigFieldRule;
  route?: FieldRoute;
  self?: string;
  peerKey?: string;
  rawValue?: string;
  value?: unknown;
  format?: string;
}

export interface ResolvedScopedConfigCommand {
  kind: 'scoped';
  canonicalArgv: string[];
  subcommand: ConfigScopedSubcommand;
  configScope: ConfigSelectorScope;
  commandScope: CommandScope;
  operationId: Extract<ConfigManagementOperationId,
    'config.show' | 'config.effective' | 'config.fields' | 'config.validate' | 'config.init'>;
  dangerous: true;
  self?: string;
  peerKey?: string;
  field?: string;
  format?: string;
}

export interface ResolvedGlobalConfigCommand {
  kind: 'global';
  canonicalArgv: string[];
  subcommand: ConfigGlobalSubcommand;
  configScope: 'process';
  commandScope: 'process';
  operationId: Extract<ConfigManagementOperationId,
    'config.list' | 'config.snapshot' | 'config.prune' | 'config.history' | 'config.diff'
    | 'config.restore' | 'config.current' | 'config.boots'>;
  dangerous: true;
  self?: never;
  peerKey?: never;
  format?: string;
  full?: boolean;
  description?: string;
  yes?: boolean;
  keepFull?: number;
  keepDelta?: number;
  versions?: [string, string];
  version?: string;
  count?: number;
}

export type ResolvedConfigCommand = ResolvedConfigOp | ResolvedScopedConfigCommand | ResolvedGlobalConfigCommand;

export type ResolveConfigCommandResult =
  | { ok: true; command: ResolvedConfigCommand }
  | { ok: false; code: string; reason: string };

export type ResolveConfigOperationResult =
  | { ok: true; op: ResolvedConfigOp }
  | { ok: false; code: string; reason: string };

export interface ResolveConfigOperationOptions {
  defaultRelation?: { self?: string; peerKey?: string };
}

const SELECTOR_OPTIONS: Record<string, 'boolean' | 'value'> = {
  '--self': 'value',
  '--peer': 'value',
  '--default': 'boolean',
  '--process': 'boolean',
  '--evolclaw': 'boolean',
};

const FIELD_OPTIONS: Record<string, 'boolean' | 'value'> = {
  ...SELECTOR_OPTIONS,
  '--format': 'value',
};

const SCOPED_SUBCOMMANDS = new Set<ConfigScopedSubcommand>(['show', 'effective', 'fields', 'validate', 'init']);
const GLOBAL_SUBCOMMANDS = new Set<ConfigGlobalSubcommand>(['list', 'snapshot', 'prune', 'history', 'diff', 'restore', 'current', 'boots']);

export function resolveConfigCommand(
  inputArgv: string[],
  options: ResolveConfigOperationOptions = {},
): ResolveConfigCommandResult {
  let argv = normalizeCliArgv(inputArgv);
  if (argv[0] !== 'config') {
    return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: 'Expected a config command' };
  }

  const subcommand = argv[1] as ConfigSubcommand | undefined;
  if (!subcommand) {
    return { ok: false, code: 'MISSING_ARG', reason: 'A config subcommand is required' };
  }

  if (options.defaultRelation?.self && options.defaultRelation.peerKey
    && isScopedConfigSubcommand(subcommand)
    && !hasExplicitConfigSelector(argv)) {
    argv = [...argv, '--self', options.defaultRelation.self, '--peer', options.defaultRelation.peerKey];
  }

  if (subcommand === 'get' || subcommand === 'set' || subcommand === 'unset') {
    const field = resolveFieldCommand(argv, subcommand);
    return field.ok ? { ok: true, command: field.op } : field;
  }
  if (SCOPED_SUBCOMMANDS.has(subcommand as ConfigScopedSubcommand)) {
    return resolveScopedCommand(argv, subcommand as ConfigScopedSubcommand);
  }
  if (GLOBAL_SUBCOMMANDS.has(subcommand as ConfigGlobalSubcommand)) {
    return resolveGlobalCommand(argv, subcommand as ConfigGlobalSubcommand);
  }
  return {
    ok: false,
    code: 'UNKNOWN_CONFIG_SUBCOMMAND',
    reason: `Unknown config subcommand: ${subcommand}`,
  };
}

export function resolveConfigOperation(
  inputArgv: string[],
  options: ResolveConfigOperationOptions = {},
): ResolveConfigOperationResult {
  const resolved = resolveConfigCommand(inputArgv, options);
  if (!resolved.ok) return resolved;
  if (resolved.command.kind !== 'field') {
    return {
      ok: false,
      code: 'NOT_CONFIG_FIELD_COMMAND',
      reason: `Config subcommand ${resolved.command.subcommand} is not field-scoped`,
    };
  }
  return { ok: true, op: resolved.command };
}

export function isResolvedConfigMutation(command: ResolvedConfigCommand): boolean {
  if (command.kind === 'field') return command.subcommand !== 'get';
  if (command.kind === 'scoped') return command.subcommand === 'init';
  return command.subcommand === 'snapshot' || command.subcommand === 'prune' || command.subcommand === 'restore';
}

function resolveFieldCommand(argv: string[], subcommand: ConfigFieldSubcommand): ResolveConfigOperationResult {
  const businessCount = subcommand === 'set' ? 2 : 1;
  const business = parseLeadingPositionals(argv.slice(2), businessCount, `config ${subcommand}`);
  if (!business.ok) return business;
  const parsedOptions = parseOptions(business.rest, FIELD_OPTIONS);
  if (!parsedOptions.ok) return parsedOptions;
  const formatCheck = validateOutputFormat(parsedOptions.values.format);
  if (!formatCheck.ok) return formatCheck;

  const selector = parseConfigSelector(business.rest, { requireSelector: subcommand !== 'get' });
  if (!selector.ok) return { ok: false, code: selector.code, reason: selector.reason };
  if (subcommand === 'unset' && selector.scope === 'process') {
    return { ok: false, code: 'UNSET_PROCESS_REJECT', reason: 'evolclaw.json has no lower config layer to fall back to' };
  }

  const field = business.values[0].trim();
  if (!field) return { ok: false, code: 'MISSING_ARG', reason: `config ${subcommand} requires a field` };
  const fieldRule = resolveConfigFieldRule(field);
  if (subcommand !== 'get' && fieldRule.class === 'safe-readonly-object') {
    return {
      ok: false,
      code: 'UNSUPPORTED_CONFIG_VALUE',
      reason: `Config field ${field} does not support object writes`,
    };
  }

  const commandScope: CommandScope = selector.scope === 'defaults' ? 'process' : selector.scope;
  const isSafe = fieldRule.class === 'safe-scalar' || fieldRule.class === 'safe-readonly-object';
  const isManagementOperation = commandScope === 'process' || !isSafe;
  const operationId: ConfigOperationId = isManagementOperation
    ? subcommand === 'get' ? 'config.read' : 'config.write'
    : `config.${subcommand}`;

  let route: FieldRoute | undefined;
  const routeRequired = subcommand !== 'get' || !isManagementOperation;
  try {
    route = routeFieldPath(field, selector.scope);
  } catch (error) {
    if (routeRequired) return configErrorResult(error);
  }

  const rawValue = subcommand === 'set' ? business.values[1] : undefined;
  let value: unknown;
  if (subcommand === 'set') {
    if (fieldRule.class === 'safe-scalar') {
      const parsedValue = parseConfigFieldValue(field, rawValue);
      if (!parsedValue.ok) return { ok: false, code: 'INVALID_CONFIG_VALUE', reason: parsedValue.reason };
      value = parsedValue.value;
    } else {
      if (!route) return { ok: false, code: 'UNKNOWN_FIELD', reason: `Unknown config field: ${field}` };
      value = coerceConfigValue(rawValue!, route);
    }
  }

  return {
    ok: true,
    op: {
      kind: 'field',
      canonicalArgv: buildFieldCanonicalArgv(subcommand, field, rawValue, selector, parsedOptions.values.format),
      subcommand,
      configScope: selector.scope,
      commandScope,
      operationId,
      dangerous: operationId === 'config.read' || operationId === 'config.write',
      field,
      fieldRule,
      route,
      ...(selector.self ? { self: selector.self } : {}),
      ...(selector.peerKey ? { peerKey: selector.peerKey } : {}),
      ...(rawValue !== undefined ? { rawValue, value } : {}),
      ...(parsedOptions.values.format ? { format: parsedOptions.values.format } : {}),
    },
  };
}

function resolveScopedCommand(
  argv: string[],
  subcommand: ConfigScopedSubcommand,
): ResolveConfigCommandResult {
  const positionalCount = subcommand === 'fields' ? { min: 0, max: 1 } : { min: 0, max: 0 };
  const parsed = parseStructuredArgs(argv.slice(2), {
    options: { ...SELECTOR_OPTIONS, '--format': 'value' },
    ...positionalCount,
  });
  if (!parsed.ok) return parsed;
  const formatCheck = validateOutputFormat(parsed.values.format);
  if (!formatCheck.ok) return formatCheck;

  const selector = parseConfigSelector(argv.slice(2), { requireSelector: subcommand !== 'fields' });
  if (!selector.ok) return { ok: false, code: selector.code, reason: selector.reason };
  const commandScope: CommandScope = selector.scope === 'defaults' ? 'process' : selector.scope;
  const format = parsed.values.format;
  const field = parsed.positionals[0];
  return {
    ok: true,
    command: {
      kind: 'scoped',
      canonicalArgv: buildScopedCanonicalArgv(subcommand, selector, field, format),
      subcommand,
      configScope: selector.scope,
      commandScope,
      operationId: `config.${subcommand}`,
      dangerous: true,
      ...(selector.self ? { self: selector.self } : {}),
      ...(selector.peerKey ? { peerKey: selector.peerKey } : {}),
      ...(field ? { field } : {}),
      ...(format ? { format } : {}),
    },
  };
}

function resolveGlobalCommand(
  argv: string[],
  subcommand: ConfigGlobalSubcommand,
): ResolveConfigCommandResult {
  const specs: Record<ConfigGlobalSubcommand, StructuredArgSpec> = {
    list: { min: 0, max: 0, options: { '--format': 'value' } },
    snapshot: { min: 0, max: 0, options: { '--full': 'boolean', '--desc': 'value', '--format': 'value' } },
    prune: { min: 0, max: 0, options: { '--keep-full': 'value', '--keep-delta': 'value', '--yes': 'boolean', '--format': 'value' } },
    history: { min: 0, max: 0, options: { '--format': 'value' } },
    diff: { min: 2, max: 2, options: { '--format': 'value' } },
    restore: { min: 1, max: 1, options: { '--format': 'value' } },
    current: { min: 0, max: 0, options: { '--format': 'value' } },
    boots: { min: 0, max: 0, options: { '-n': 'value', '--num': 'value', '--format': 'value' }, aliases: [['-n', '--num']] },
  };
  const parsed = parseStructuredArgs(argv.slice(2), specs[subcommand]);
  if (!parsed.ok) return parsed;
  const formatCheck = validateOutputFormat(parsed.values.format);
  if (!formatCheck.ok) return formatCheck;

  const format = parsed.values.format;
  const command: ResolvedGlobalConfigCommand = {
    kind: 'global',
    canonicalArgv: [],
    subcommand,
    configScope: 'process',
    commandScope: 'process',
    operationId: `config.${subcommand}`,
    dangerous: true,
    ...(format ? { format } : {}),
  };

  if (subcommand === 'snapshot') {
    command.full = parsed.flags.has('full');
    if (parsed.values.desc !== undefined) command.description = parsed.values.desc;
  } else if (subcommand === 'prune') {
    command.yes = parsed.flags.has('yes');
    const keepFull = parseNonNegativeInteger(parsed.values.keepFull, '--keep-full');
    if (!keepFull.ok) return keepFull;
    const keepDelta = parseNonNegativeInteger(parsed.values.keepDelta, '--keep-delta');
    if (!keepDelta.ok) return keepDelta;
    if (keepFull.value !== undefined) command.keepFull = keepFull.value;
    if (keepDelta.value !== undefined) command.keepDelta = keepDelta.value;
  } else if (subcommand === 'diff') {
    command.versions = [parsed.positionals[0], parsed.positionals[1]];
  } else if (subcommand === 'restore') {
    command.version = parsed.positionals[0];
  } else if (subcommand === 'boots') {
    const count = parsePositiveInteger(parsed.values.n ?? parsed.values.num, '-n/--num');
    if (!count.ok) return count;
    command.count = count.value ?? 10;
  }
  command.canonicalArgv = buildGlobalCanonicalArgv(command);
  return { ok: true, command };
}

function isScopedConfigSubcommand(subcommand: ConfigSubcommand): boolean {
  return subcommand === 'get' || subcommand === 'set' || subcommand === 'unset'
    || SCOPED_SUBCOMMANDS.has(subcommand as ConfigScopedSubcommand);
}

function hasExplicitConfigSelector(argv: string[]): boolean {
  const selectors = new Set(['--self', '--peer', '--default', '--process', '--evolclaw']);
  return argv.some(arg => selectors.has(arg));
}

function parseLeadingPositionals(
  argv: string[],
  count: number,
  command: string,
): { ok: true; values: string[]; rest: string[] } | { ok: false; code: string; reason: string } {
  const values = argv.slice(0, count);
  if (values.length !== count || values.some(value => !value || value.startsWith('-'))) {
    return {
      ok: false,
      code: 'MISSING_ARG',
      reason: `${command} requires exactly ${count} positional argument${count === 1 ? '' : 's'}`,
    };
  }
  const rest = argv.slice(count);
  if (rest[0] && !rest[0].startsWith('-')) {
    return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: `Unexpected positional argument for ${command}: ${rest[0]}` };
  }
  return { ok: true, values, rest };
}

interface StructuredArgSpec {
  min: number;
  max: number;
  options: Record<string, 'boolean' | 'value'>;
  aliases?: string[][];
}

type ParsedStructuredArgs = {
  ok: true;
  positionals: string[];
  values: Record<string, string>;
  flags: Set<string>;
};

function parseOptions(
  argv: string[],
  options: Record<string, 'boolean' | 'value'>,
): { ok: true; values: Record<string, string>; flags: Set<string> }
  | { ok: false; code: string; reason: string } {
  const parsed = parseStructuredArgs(argv, { min: 0, max: 0, options, aliases: [['--process', '--evolclaw']] });
  if (!parsed.ok) return parsed;
  return { ok: true, values: parsed.values, flags: parsed.flags };
}

function parseStructuredArgs(
  argv: string[],
  spec: StructuredArgSpec,
): ParsedStructuredArgs | { ok: false; code: string; reason: string } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const seen = new Set<string>();
  const aliasGroups = spec.aliases ?? [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: '-- is not supported in config commands' };
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const kind = spec.options[arg];
    if (!kind) return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: `Unexpected config argument: ${arg}` };
    const aliasGroup = aliasGroups.find(group => group.includes(arg));
    if (seen.has(arg) || aliasGroup?.some(alias => seen.has(alias))) {
      return { ok: false, code: 'SELECTOR_CONFLICT', reason: `Duplicate config option: ${arg}` };
    }
    seen.add(arg);
    const key = optionKey(arg);
    if (kind === 'boolean') {
      flags.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) {
      return { ok: false, code: 'MISSING_FLAG_VALUE', reason: `${arg} requires a value` };
    }
    values[key] = value;
    i += 1;
  }

  if (positionals.length < spec.min) {
    return { ok: false, code: 'MISSING_ARG', reason: `Config command requires ${spec.min} positional argument${spec.min === 1 ? '' : 's'}` };
  }
  if (positionals.length > spec.max) {
    return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: `Unexpected positional argument: ${positionals[spec.max]}` };
  }
  return { ok: true, positionals, values, flags };
}

function optionKey(option: string): string {
  return option.replace(/^-+/, '').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseNonNegativeInteger(
  raw: string | undefined,
  option: string,
): { ok: true; value?: number } | { ok: false; code: string; reason: string } {
  if (raw === undefined) return { ok: true };
  if (!/^\d+$/.test(raw)) return { ok: false, code: 'INVALID_CONFIG_VALUE', reason: `${option} requires a non-negative integer` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, code: 'INVALID_CONFIG_VALUE', reason: `${option} is outside the supported integer range` };
  }
  return { ok: true, value };
}

function parsePositiveInteger(
  raw: string | undefined,
  option: string,
): { ok: true; value?: number } | { ok: false; code: string; reason: string } {
  const parsed = parseNonNegativeInteger(raw, option);
  if (!parsed.ok || parsed.value === undefined) return parsed;
  if (parsed.value < 1) return { ok: false, code: 'INVALID_CONFIG_VALUE', reason: `${option} requires a positive integer` };
  return parsed;
}

function validateOutputFormat(
  format: string | undefined,
): { ok: true } | { ok: false; code: string; reason: string } {
  if (format === undefined || format === 'json' || format === 'text') return { ok: true };
  return { ok: false, code: 'INVALID_CONFIG_VALUE', reason: `Unsupported config output format: ${format}` };
}

function buildFieldCanonicalArgv(
  subcommand: ConfigFieldSubcommand,
  field: string,
  rawValue: string | undefined,
  selector: Extract<ReturnType<typeof parseConfigSelector>, { ok: true }>,
  format?: string,
): string[] {
  const argv = ['config', subcommand, field];
  if (rawValue !== undefined) argv.push(rawValue);
  appendCanonicalSelector(argv, selector);
  if (format) argv.push('--format', format);
  return argv;
}

function buildScopedCanonicalArgv(
  subcommand: ConfigScopedSubcommand,
  selector: Extract<ReturnType<typeof parseConfigSelector>, { ok: true }>,
  field?: string,
  format?: string,
): string[] {
  const argv = ['config', subcommand];
  if (field) argv.push(field);
  appendCanonicalSelector(argv, selector);
  if (format) argv.push('--format', format);
  return argv;
}

function appendCanonicalSelector(
  argv: string[],
  selector: Extract<ReturnType<typeof parseConfigSelector>, { ok: true }>,
): void {
  if (selector.scope === 'process') argv.push('--process');
  if (selector.scope === 'defaults') argv.push('--default');
  if (selector.self) argv.push('--self', selector.self);
  if (selector.peerKey) argv.push('--peer', selector.peerKey);
}

function buildGlobalCanonicalArgv(command: ResolvedGlobalConfigCommand): string[] {
  const argv = ['config', command.subcommand];
  if (command.subcommand === 'diff' && command.versions) argv.push(...command.versions);
  if (command.subcommand === 'restore' && command.version) argv.push(command.version);
  if (command.subcommand === 'snapshot') {
    if (command.full) argv.push('--full');
    if (command.description !== undefined) argv.push('--desc', command.description);
  }
  if (command.subcommand === 'prune') {
    if (command.keepFull !== undefined) argv.push('--keep-full', String(command.keepFull));
    if (command.keepDelta !== undefined) argv.push('--keep-delta', String(command.keepDelta));
    if (command.yes) argv.push('--yes');
  }
  if (command.subcommand === 'boots' && command.count !== undefined) argv.push('-n', String(command.count));
  if (command.format) argv.push('--format', command.format);
  return argv;
}

function coerceConfigValue(raw: string, route: FieldRoute): unknown {
  if (route.merge === 'list') return [raw];
  if (route.enum) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function configErrorResult(error: unknown): { ok: false; code: string; reason: string } {
  if (error instanceof ConfigError) return { ok: false, code: error.code, reason: error.message };
  return { ok: false, code: 'CONFIG_ERROR', reason: error instanceof Error ? error.message : String(error) };
}
