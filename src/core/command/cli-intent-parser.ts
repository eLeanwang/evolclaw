import type { CommandIntent, CommandScope, CommandSource } from '../../types.js';
import { parseConfigSelector, type ConfigSelectorParseResult } from '../../cli/config-selector.js';
import { normalizeCliArgv } from '../../cli/cli-argv.js';
import { resolveConfigOperation, type ResolvedConfigOp } from '../../config/resolved-config-op.js';
export { normalizeCliArgv } from '../../cli/cli-argv.js';

export type CliIntentParseResult =
  | { kind: 'recognized'; intent: CommandIntent; resolvedConfigOp?: ResolvedConfigOp }
  | { kind: 'raw'; intent: CommandIntent; reason: string }
  | { kind: 'invalid'; code: string; reason: string };

export interface DefaultRelationContext {
  self?: string;
  peer?: string;
}

const MODEL_RELATION_DEFAULT_SUBCOMMANDS = new Set(['list', 'current', 'info', 'use', 'effort', 'reset']);

export function withDefaultRelationContext(
  inputArgv: string[],
  defaults: DefaultRelationContext
): string[] {
  const argv = normalizeCliArgv(inputArgv);
  const isModelCommand = argv[0] === 'model' && MODEL_RELATION_DEFAULT_SUBCOMMANDS.has(argv[1] || '');
  if (!isModelCommand) return argv;
  if (!defaults.self || !defaults.peer) return argv;

  const parsed = parseArgs(argv.slice(2));
  if (parsed.args.self !== undefined || parsed.args.peer !== undefined || parsed.args.role !== undefined) {
    return argv;
  }

  return [...argv, '--self', defaults.self, '--peer', defaults.peer];
}

export function parseCliIntent(
  inputArgv: string[],
  source: CommandSource = 'menu.cli',
  options: { defaultRelation?: DefaultRelationContext } = {},
): CliIntentParseResult {
  if (!inputArgv || inputArgv.length === 0) {
    return { kind: 'invalid', code: 'MISSING_ARGV', reason: 'Missing command argv' };
  }
  const argv = normalizeCliArgv(inputArgv);

  const cmd = argv[0];
  if (cmd === 'model') return parseModelCommand(argv, source);
  if (cmd === 'config') return parseConfigCommand(argv, source, options.defaultRelation);
  if (cmd === 'stats') return parseStatsCommand(argv, source);
  if (cmd === 'agent') return parseAgentCommand(argv, source);
  if (cmd === 'aid') return parseAidCommand(argv, source);
  if (cmd === 'storage') return parseStorageCommand(argv, source);

  if (cmd === 'status') {
    return recognized('system.status', 'process', source, parseArgs(argv.slice(1)), argv);
  }

  return raw(source, argv, `Unknown command: ${cmd}`);
}

export function rawCliIntent(
  argv: string[],
  source: CommandSource = 'menu.cli'
): CommandIntent {
  return {
    operation: 'cli.exec.raw',
    scope: 'raw-cli',
    source,
    args: {},
    rawArgv: argv,
    dangerous: true,
  };
}

function parseModelCommand(argv: string[], source: CommandSource): CliIntentParseResult {
  const subcmd = argv[1];
  const parsed = parseArgs(argv.slice(2));
  const args = parsed.args;

  if (args.role !== undefined) {
    return { kind: 'invalid', code: 'FORBIDDEN_FLAG', reason: 'Remote CLI cannot pass --role' };
  }

  let scope: CommandScope = 'agent';
  if (args.self && args.peer) scope = 'relation';
  else if (args.self && args.role) scope = 'role';
  else if (args.self) scope = 'agent';

  switch (subcmd) {
    case 'list':
      return parsed.positionals.length === 0 ? recognized('model.list', scope, source, args, argv) : raw(source, argv, 'Unexpected positional args for model list');
    case 'current':
      return parsed.positionals.length === 0 ? recognized('model.current', scope, source, args, argv) : raw(source, argv, 'Unexpected positional args for model current');
    case 'info':
      if (parsed.positionals.length > 1) return raw(source, argv, 'Ambiguous model info positional args');
      if (parsed.positionals[0]) args.model = parsed.positionals[0];
      return recognized('model.info', scope, source, args, argv);
    case 'check':
      return parsed.positionals.length === 0 ? recognized('model.check', 'agent', source, args, argv) : raw(source, argv, 'Unexpected positional args for model check');
    case 'use':
      if (parsed.positionals.length !== 1) return raw(source, argv, 'model use requires exactly one model argument');
      args.model = parsed.positionals[0];
      return recognized('model.use', scope, source, args, argv);
    case 'effort':
      if (parsed.positionals.length > 1) return raw(source, argv, 'Ambiguous model effort positional args');
      if (parsed.positionals[0]) args.effort = parsed.positionals[0];
      return recognized('model.effort', scope, source, args, argv);
    case 'reset':
      return parsed.positionals.length === 0 ? recognized('model.reset', scope, source, args, argv) : raw(source, argv, 'Unexpected positional args for model reset');
    default:
      return raw(source, argv, `Unknown model subcommand: ${subcmd}`);
  }
}

const CONFIG_SELECTOR_OPTIONS: OptionDefinitions = {
  '--self': 'value',
  '--peer': 'value',
  '--default': 'boolean',
  '--process': 'boolean',
  '--evolclaw': 'boolean',
  '--format': 'value',
};

const CONFIG_SELECTOR_READ_SUBCOMMANDS = new Set(['show', 'effective', 'fields', 'validate']);
const CONFIG_GLOBAL_READ_SUBCOMMANDS = new Set(['list', 'history', 'current']);

function parseConfigCommand(
  argv: string[],
  source: CommandSource,
  defaultRelation?: DefaultRelationContext,
): CliIntentParseResult {
  const subcmd = argv[1];
  if (!subcmd) return raw(source, argv, 'Missing config subcommand');

  if (subcmd === 'get' || subcmd === 'set' || subcmd === 'unset') {
    const resolved = resolveConfigOperation(argv, {
      ...(defaultRelation ? { defaultRelation: { self: defaultRelation.self, peerKey: defaultRelation.peer } } : {}),
    });
    if (!resolved.ok) return { kind: 'invalid', code: resolved.code, reason: resolved.reason };
    return recognizedConfig(resolved.op, source);
  }

  if (CONFIG_SELECTOR_READ_SUBCOMMANDS.has(subcmd) || subcmd === 'init') {
    const options = parseCanonicalOptions(argv.slice(2), CONFIG_SELECTOR_OPTIONS);
    if (!options.ok) return options.result;
    const selector = parseConfigSelector(argv.slice(2), { requireSelector: subcmd === 'init' });
    if (!selector.ok) return selectorInvalid(selector);
    const scope: CommandScope = selector.scope === 'defaults' ? 'process' : selector.scope;
    const args = configSelectorArgs(selector, options.args);
    return recognized(subcmd === 'init' ? 'config.write' : 'config.read', scope, source, args, argv, true);
  }

  if (CONFIG_GLOBAL_READ_SUBCOMMANDS.has(subcmd)) {
    const options = parseCanonicalOptions(argv.slice(2), { '--format': 'value' });
    if (!options.ok) return options.result;
    return recognized('config.read', 'process', source, options.args, argv, true);
  }

  if (subcmd === 'boots') {
    const options = parseCanonicalOptions(argv.slice(2), { '-n': 'value', '--num': 'value', '--format': 'value' });
    if (!options.ok) return options.result;
    return recognized('config.read', 'process', source, options.args, argv, true);
  }

  if (subcmd === 'diff') {
    const business = parseLeadingPositionals(argv.slice(2), 2, 'config diff');
    if (!business.ok) return business.result;
    const options = parseCanonicalOptions(business.rest, { '--format': 'value' });
    if (!options.ok) return options.result;
    return recognized('config.read', 'process', source, {
      fromVersion: business.values[0],
      toVersion: business.values[1],
      ...options.args,
    }, argv, true);
  }

  if (subcmd === 'snapshot') {
    const options = parseCanonicalOptions(argv.slice(2), { '--full': 'boolean', '--desc': 'value', '--format': 'value' });
    if (!options.ok) return options.result;
    return recognized('config.write', 'process', source, options.args, argv, true);
  }

  if (subcmd === 'prune') {
    const options = parseCanonicalOptions(argv.slice(2), {
      '--keep-full': 'value',
      '--keep-delta': 'value',
      '--yes': 'boolean',
      '--format': 'value',
    });
    if (!options.ok) return options.result;
    return recognized('config.write', 'process', source, options.args, argv, true);
  }

  if (subcmd === 'restore') {
    const business = parseLeadingPositionals(argv.slice(2), 1, 'config restore');
    if (!business.ok) return business.result;
    const options = parseCanonicalOptions(business.rest, { '--format': 'value' });
    if (!options.ok) return options.result;
    return recognized('config.write', 'process', source, {
      version: business.values[0],
      ...options.args,
    }, argv, true);
  }

  return raw(source, argv, `Unknown config subcommand: ${subcmd}`);
}

type OptionDefinitions = Record<string, 'boolean' | 'value'>;

type CanonicalOptionsResult =
  | { ok: true; args: Record<string, unknown> }
  | InvalidConfigParseResult;

function parseCanonicalOptions(argv: string[], definitions: OptionDefinitions): CanonicalOptionsResult {
  const args: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    const kind = definitions[option];
    if (!kind) {
      return invalidConfigGrammar(`Unexpected config argument: ${option}`);
    }
    if (seen.has(option) || ((option === '--process' || option === '--evolclaw') && (seen.has('--process') || seen.has('--evolclaw')))) {
      return invalidConfigGrammar(`Duplicate config option: ${option}`, 'SELECTOR_CONFLICT');
    }
    seen.add(option);
    const key = option.replace(/^-+/, '').replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    if (kind === 'boolean') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) {
      return invalidConfigGrammar(`${option} requires a value`, 'MISSING_FLAG_VALUE');
    }
    args[key] = value;
    i += 1;
  }
  return { ok: true, args };
}

type LeadingPositionalsResult =
  | { ok: true; values: string[]; rest: string[] }
  | InvalidConfigParseResult;

type InvalidConfigParseResult = { ok: false; result: CliIntentParseResult };

function parseLeadingPositionals(argv: string[], count: number, command: string): LeadingPositionalsResult {
  const values = argv.slice(0, count);
  if (values.length !== count || values.some(value => !value || value.startsWith('-'))) {
    return invalidConfigGrammar(`${command} requires exactly ${count} positional argument${count === 1 ? '' : 's'}`, 'MISSING_ARG');
  }
  const rest = argv.slice(count);
  if (rest[0] && !rest[0].startsWith('-')) {
    return invalidConfigGrammar(`Unexpected positional argument for ${command}: ${rest[0]}`);
  }
  return { ok: true, values, rest };
}

function invalidConfigGrammar(reason: string, code = 'INVALID_CONFIG_COMMAND'): InvalidConfigParseResult {
  return { ok: false, result: { kind: 'invalid', code, reason } };
}

function selectorInvalid(selector: Extract<ConfigSelectorParseResult, { ok: false }>): CliIntentParseResult {
  return { kind: 'invalid', code: selector.code, reason: selector.reason };
}

function configSelectorArgs(
  selector: Extract<ConfigSelectorParseResult, { ok: true }>,
  parsedArgs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...parsedArgs,
    configScope: selector.scope,
    ...(selector.self ? { self: selector.self } : {}),
    ...(selector.peerKey ? { peer: selector.peerKey, peerKey: selector.peerKey } : {}),
    ...(selector.scope === 'process' ? { process: true } : {}),
    ...(selector.scope === 'defaults' ? { default: true } : {}),
  };
}

function recognizedConfig(op: ResolvedConfigOp, source: CommandSource): CliIntentParseResult {
  const dangerous = op.operationId === 'config.read' || op.operationId === 'config.write';
  return {
    kind: 'recognized',
    resolvedConfigOp: op,
    intent: {
      operation: op.operationId,
      scope: op.commandScope,
      source,
      args: {
        field: op.field,
        ...(op.subcommand === 'set' ? { value: op.value } : {}),
        configScope: op.configScope,
        ...(op.self ? { self: op.self } : {}),
        ...(op.peerKey ? { peer: op.peerKey, peerKey: op.peerKey } : {}),
        ...(op.configScope === 'process' ? { process: true } : {}),
        ...(op.configScope === 'defaults' ? { default: true } : {}),
      },
      rawArgv: op.canonicalArgv,
      ...(dangerous ? { dangerous: true } : {}),
    },
  };
}

function parseStatsCommand(argv: string[], source: CommandSource): CliIntentParseResult {
  const parsed = parseArgs(argv.slice(1));
  const args = parsed.args;
  if (parsed.positionals.length > 0) return raw(source, argv, 'Unexpected stats positional args');

  if (args.sql !== undefined) return recognized('stats.sqlReadonly', 'control', source, args, argv, true);
  if (args.rebuild !== undefined) return recognized('stats.rebuild', 'process', source, args, argv, true);
  if (args.peers !== undefined) return recognized('stats.peers', 'control', source, args, argv);
  if (args.groups !== undefined) return recognized('stats.groups', 'control', source, args, argv);
  if (args.session !== undefined) return recognized('stats.session', 'relation', source, args, argv);
  if (args.context !== undefined) return recognized('stats.context', 'relation', source, args, argv);
  return recognized('stats.summary', 'relation', source, args, argv);
}

function parseAgentCommand(argv: string[], source: CommandSource): CliIntentParseResult {
  const subcmd = argv[1];
  const parsed = parseArgs(argv.slice(2));
  const args = parsed.args;
  if (parsed.positionals.length > 0) return raw(source, argv, 'Unexpected agent positional args');

  if (subcmd === 'list') return recognized('agent.list', 'control', source, args, argv);
  if (subcmd === 'show') return recognized('agent.show', args.aid ? 'control' : 'agent', source, args, argv);
  if (subcmd === 'get') return recognized('agent.getConfig', 'control', source, args, argv, true);
  return raw(source, argv, `Unknown agent subcommand: ${subcmd}`);
}

function parseAidCommand(argv: string[], source: CommandSource): CliIntentParseResult {
  const subcmd = argv[1];
  const parsed = parseArgs(argv.slice(2));
  const args = parsed.args;
  if (parsed.positionals.length > 0) return raw(source, argv, 'Unexpected aid positional args');

  if (subcmd === 'list') return recognized('aid.listLocal', 'control', source, args, argv, true);
  if (subcmd === 'show') return recognized('aid.showLocal', 'control', source, args, argv, true);
  if (subcmd === 'lookup') return recognized('aid.lookupRemote', 'control', source, args, argv);
  return raw(source, argv, `Unknown aid subcommand: ${subcmd}`);
}

function parseStorageCommand(argv: string[], source: CommandSource): CliIntentParseResult {
  const subcmd = argv[1];
  const parsed = parseArgs(argv.slice(2));
  const args = parsed.args;
  if (parsed.positionals.length > 0) return raw(source, argv, 'Unexpected storage positional args');

  if (subcmd === 'ls') return recognized('storage.list', 'control', source, args, argv);
  if (subcmd === 'quota') return recognized('storage.quota', 'control', source, args, argv);
  return raw(source, argv, `Unknown storage subcommand: ${subcmd}`);
}

function recognized(
  operation: string,
  scope: CommandScope,
  source: CommandSource,
  args: Record<string, unknown>,
  rawArgv: string[],
  dangerous?: boolean
): CliIntentParseResult {
  return {
    kind: 'recognized',
    intent: { operation, scope, source, args, rawArgv, ...(dangerous ? { dangerous: true } : {}) },
  };
}

function raw(source: CommandSource, argv: string[], reason: string): CliIntentParseResult {
  return { kind: 'raw', intent: rawCliIntent(argv, source), reason };
}

function parseArgs(argv: string[]): { args: Record<string, unknown>; positionals: string[] } {
  const args: Record<string, unknown> = {};
  const positionals: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!key) {
        positionals.push(arg);
        i += 1;
        continue;
      }
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  return { args, positionals };
}
