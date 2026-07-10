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
export type ConfigOperationId =
  | 'config.get'
  | 'config.set'
  | 'config.unset'
  | 'config.read'
  | 'config.write';

export interface ResolvedConfigOp {
  canonicalArgv: string[];
  subcommand: ConfigFieldSubcommand;
  configScope: ConfigSelectorScope;
  commandScope: CommandScope;
  operationId: ConfigOperationId;
  field: string;
  fieldRule: ConfigFieldRule;
  route?: FieldRoute;
  self?: string;
  peerKey?: string;
  rawValue?: string;
  value?: unknown;
}

export type ResolveConfigOperationResult =
  | { ok: true; op: ResolvedConfigOp }
  | { ok: false; code: string; reason: string };

export interface ResolveConfigOperationOptions {
  defaultRelation?: { self?: string; peerKey?: string };
}

const CONFIG_OPTIONS: Record<string, 'boolean' | 'value'> = {
  '--self': 'value',
  '--peer': 'value',
  '--default': 'boolean',
  '--process': 'boolean',
  '--evolclaw': 'boolean',
  '--format': 'value',
};

export function resolveConfigOperation(
  inputArgv: string[],
  options: ResolveConfigOperationOptions = {},
): ResolveConfigOperationResult {
  let argv = normalizeCliArgv(inputArgv);
  if (argv[0] !== 'config') {
    return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: 'Expected a config command' };
  }

  const subcommand = argv[1];
  if (subcommand !== 'get' && subcommand !== 'set' && subcommand !== 'unset') {
    return { ok: false, code: 'NOT_CONFIG_FIELD_COMMAND', reason: `Config subcommand ${subcommand || '(missing)'} is not field-scoped` };
  }

  if (options.defaultRelation?.self && options.defaultRelation.peerKey && !hasExplicitConfigSelector(argv)) {
    argv = [...argv, '--self', options.defaultRelation.self, '--peer', options.defaultRelation.peerKey];
  }

  const businessCount = subcommand === 'set' ? 2 : 1;
  const business = parseLeadingPositionals(argv.slice(2), businessCount, `config ${subcommand}`);
  if (!business.ok) return business;
  const parsedOptions = parseCanonicalOptions(business.rest);
  if (!parsedOptions.ok) return parsedOptions;

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
      canonicalArgv: buildCanonicalArgv(subcommand, field, rawValue, selector, parsedOptions.format),
      subcommand,
      configScope: selector.scope,
      commandScope,
      operationId,
      field,
      fieldRule,
      route,
      ...(selector.self ? { self: selector.self } : {}),
      ...(selector.peerKey ? { peerKey: selector.peerKey } : {}),
      ...(rawValue !== undefined ? { rawValue, value } : {}),
    },
  };
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

function parseCanonicalOptions(
  argv: string[],
): { ok: true; format?: string } | { ok: false; code: string; reason: string } {
  const seen = new Set<string>();
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    const kind = CONFIG_OPTIONS[option];
    if (!kind) return { ok: false, code: 'INVALID_CONFIG_COMMAND', reason: `Unexpected config argument: ${option}` };
    if (seen.has(option) || ((option === '--process' || option === '--evolclaw') && (seen.has('--process') || seen.has('--evolclaw')))) {
      return { ok: false, code: 'SELECTOR_CONFLICT', reason: `Duplicate config option: ${option}` };
    }
    seen.add(option);
    if (kind === 'boolean') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) {
      return { ok: false, code: 'MISSING_FLAG_VALUE', reason: `${option} requires a value` };
    }
    if (option === '--format') format = value;
    i += 1;
  }
  return { ok: true, ...(format ? { format } : {}) };
}

function buildCanonicalArgv(
  subcommand: ConfigFieldSubcommand,
  field: string,
  rawValue: string | undefined,
  selector: Extract<ReturnType<typeof parseConfigSelector>, { ok: true }>,
  format?: string,
): string[] {
  const argv = ['config', subcommand, field];
  if (rawValue !== undefined) argv.push(rawValue);
  if (selector.scope === 'process') argv.push('--process');
  if (selector.scope === 'defaults') argv.push('--default');
  if (selector.self) argv.push('--self', selector.self);
  if (selector.peerKey) argv.push('--peer', selector.peerKey);
  if (format) argv.push('--format', format);
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
