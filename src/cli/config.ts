import { isHelpFlag, getArgValue } from './help.js';
import { ConfigTarget, initConfigManager } from '../config/config-manager.js';
import { resolveConfigCommand } from '../config/resolved-config-op.js';
import { executeResolvedConfigCommand, type ConfigExecutionResult } from '../config/config-operation-service.js';
import { ipcQuery, type IpcConfigOpResponse } from '../ipc.js';
import { resolvePaths } from '../paths.js';
import { AGENT_DELEGATION_TOKEN_ENV } from '../core/auth/agent-delegation.js';

function emit(formatJson: boolean, payload: unknown, text: () => string): void {
  if (formatJson) console.log(JSON.stringify(payload, null, 2));
  else console.log(text());
}

function fail(formatJson: boolean, code: string, message: string): never {
  if (formatJson) console.log(JSON.stringify({ ok: false, code, error: message }, null, 2));
  else console.error(`Error: ${message} (${code})`);
  process.exit(1);
}

function formatPermission(permission: string): string {
  if (permission === 'H') return 'human-only';
  if (permission === 'HA') return 'configurable';
  return permission;
}

function isAgentEnv(): boolean {
  return !!process.env.EVOLCLAW_SESSION_ID;
}

function renderConfigExecution(result: ConfigExecutionResult, formatJson: boolean): void {
  if (!result.ok) fail(formatJson, result.code, result.error);

  switch (result.subcommand) {
    case 'get': {
      const payload = {
        ok: true,
        field: result.field,
        value: result.value,
        scope: result.scope,
        ...(result.source ? { source: result.source } : {}),
      };
      return emit(formatJson, payload, () => {
        if (!result.source) return `${result.field} = ${JSON.stringify(result.value)} (${result.scope})`;
        return `${result.field} = ${JSON.stringify(result.value)} [source: ${result.source.target}]`;
      });
    }
    case 'set':
      return emit(formatJson, {
        ok: true,
        field: result.field,
        value: result.value,
        scope: result.scope,
        permission: formatPermission(result.permission),
        file: result.file,
      }, () => `Set ${result.field} = ${JSON.stringify(result.value)} [${result.scope}]`);
    case 'unset':
      return emit(formatJson, {
        ok: true,
        field: result.field,
        removed: result.removed,
        ...(result.removed ? { scope: result.scope } : {}),
      }, () => result.removed ? `Removed ${result.field} from ${result.scope}` : `${result.field} was not set`);
    case 'show':
      return emit(formatJson, { ok: true, scope: result.scope, configs: result.configs }, () => JSON.stringify(result.configs, null, 2));
    case 'effective':
      return emit(formatJson, { ok: true, scope: result.scope, effective: result.effective }, () => JSON.stringify(result.effective, null, 2));
    case 'fields': {
      const fields = formatJson
        ? result.fields.map(field => ({ ...field, permission: formatPermission(field.permission) }))
        : result.fields;
      return emit(formatJson, { ok: true, scope: result.scope, fields }, () =>
        result.fields.map(field => `${field.field} ${formatPermission(field.permission)} merge=${field.merge}`).join('\n'));
    }
    case 'validate':
      return emit(formatJson, { ok: result.valid, results: result.results }, () =>
        result.results.map(item => `${item.ok ? 'OK' : 'ERROR'} ${item.target}${item.error ? ` ${item.error}` : ''}`).join('\n'));
    case 'init':
      return emit(formatJson, { ok: true, scope: result.scope }, () => `Initialized ${result.scope} config`);
    case 'list':
      return emit(formatJson, { ok: true, files: result.files }, () => result.files.join('\n'));
    case 'snapshot': {
      const { subcommand: _subcommand, ...payload } = result;
      return emit(formatJson, payload, () => result.created ? `Created snapshot ${result.version}` : `No snapshot created: ${result.reason}`);
    }
    case 'prune': {
      const { subcommand: _subcommand, ...payload } = result;
      return emit(formatJson, payload, () => result.dryRun
        ? `[dry-run] would delete ${result.wouldDelete.join(', ')}`
        : `Deleted ${result.deleted.join(', ')}`);
    }
    case 'history':
      return emit(formatJson, { ok: true, versions: result.versions }, () =>
        result.versions.map(version => `${version.version} ${version.type} ${version.createdAt}`).join('\n'));
    case 'diff': {
      const { subcommand: _subcommand, ...payload } = result;
      return emit(formatJson, payload, () => [
        ...result.added.map(file => `+ ${file}`),
        ...result.modified.map(file => `~ ${file}`),
        ...result.deleted.map(file => `- ${file}`),
      ].join('\n'));
    }
    case 'restore':
      return emit(formatJson, { ok: true, version: result.version, appliedFiles: result.appliedFiles }, () =>
        `Restored ${result.version} (${result.appliedFiles} files)`);
    case 'current':
      return emit(formatJson, { ok: true, current: result.current, lastBoot: result.lastBoot }, () =>
        result.current ? `Current version: ${result.current.delta} (full ${result.current.full})` : '(no current.json)');
    case 'boots':
      return emit(formatJson, { ok: true, boots: result.boots }, () =>
        result.boots.map(boot => `${boot.bootedAt} ${boot.startMethod}`).join('\n'));
  }
}

async function runManagedConfig(args: string[], formatJson: boolean): Promise<void> {
  const sessionId = process.env.EVOLCLAW_SESSION_ID;
  if (!sessionId) fail(formatJson, 'NO_SESSION', 'EVOLCLAW_SESSION_ID is not set');
  const delegationToken = process.env[AGENT_DELEGATION_TOKEN_ENV];
  if (!delegationToken) {
    fail(formatJson, 'DELEGATION_REQUIRED', `${AGENT_DELEGATION_TOKEN_ENV} is not set for the active task`);
  }

  let response: IpcConfigOpResponse | null;
  try {
    response = await ipcQuery<IpcConfigOpResponse>(resolvePaths().socket, {
      type: 'config.op',
      argv: ['config', ...args],
      sessionId,
      delegationToken,
    }, 10_000);
  } catch {
    response = null;
  }
  if (!response) fail(formatJson, 'DAEMON_UNAVAILABLE', 'Unable to connect to the evolclaw daemon');
  if (!response.ok || !response.result) {
    fail(formatJson, response.code || 'CONFIG_AUTH_FAILED', response.error || 'config operation failed');
  }
  renderConfigExecution(response.result, formatJson);
}

const HELP = `Usage: evolclaw config <command> [options]

Fields:
  get <field>
  set <field> <value>
  unset <field>

Scoped commands:
  show | effective | fields [field] | validate | init

Global commands:
  list | snapshot | prune | history | diff | restore | current | boots

Selectors:
  --self <aid> [--peer <peerKey>] | --default | --process

Output:
  --format json`;

export async function cmdConfig(args: string[]): Promise<void> {
  const subcommand = args[0];
  const formatJson = getArgValue(args, '--format') === 'json';
  if (!subcommand || isHelpFlag(subcommand)) {
    console.log(HELP);
    return;
  }

  if (isAgentEnv()) {
    await runManagedConfig(args, formatJson);
    return;
  }

  try {
    initConfigManager();
  } catch (error) {
    fail(formatJson, 'SCHEMA_INIT_FAILED', error instanceof Error ? error.message : String(error));
  }

  const resolved = resolveConfigCommand(['config', ...args]);
  if (!resolved.ok) fail(formatJson, resolved.code, resolved.reason);
  renderConfigExecution(executeResolvedConfigCommand(resolved.command), formatJson);
}
