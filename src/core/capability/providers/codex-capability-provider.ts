import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { CapabilityContext, CapabilityProvider, CapabilityRawItem, CapabilityType, CapabilityTypeState } from '../types.js';

function listDirectories(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function discoverSkills(ctx: CapabilityContext): CapabilityRawItem[] {
  const roots = [
    { dir: path.join(ctx.projectPath, '.codex', 'skills'), source: 'project' as const },
    { dir: path.join(os.homedir(), '.codex', 'skills'), source: 'user' as const },
    { dir: path.join(os.homedir(), '.codex', 'skills', '.system'), source: 'system' as const },
  ];
  const seen = new Set<string>();
  const out: CapabilityRawItem[] = [];
  for (const root of roots) {
    for (const id of listDirectories(root.dir)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: id, source: root.source });
    }
  }
  return out;
}

function runCodexJson(args: string[]): any | null {
  try {
    const output = execFileSync('codex', args, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function describeMcpEntry(entry: any): string | undefined {
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  if (command) return `stdio: ${path.basename(command)}`;
  const rawUrl = typeof entry.url === 'string' ? entry.url : typeof entry.serverUrl === 'string' ? entry.serverUrl : undefined;
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return `remote: ${url.origin}${url.pathname}`;
  } catch {
    return 'remote';
  }
}

function normalizeMcpServerConfig(entry: any): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const config: Record<string, unknown> = {};
  for (const key of [
    'command',
    'args',
    'env',
    'cwd',
    'url',
    'serverUrl',
    'bearer_token_env_var',
    'bearerTokenEnvVar',
    'http_headers',
    'httpHeaders',
    'startup_timeout_sec',
    'startupTimeoutSec',
    'startup_timeout_ms',
    'startupTimeoutMs',
    'enabled_tools',
    'enabledTools',
    'disabled_tools',
    'disabledTools',
    'tools',
    'scope',
    'oauth',
    'oauth_resource',
    'oauthResource',
  ]) {
    if (entry[key] !== undefined) config[key] = entry[key];
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function discoverMcp(): CapabilityRawItem[] {
  const parsed = runCodexJson(['mcp', 'list', '--json']);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
  return list.map((entry: any) => {
    const id = String(entry.name ?? entry.id ?? '').trim();
    if (!id) return null;
    return {
      id,
      label: String(entry.label ?? entry.name ?? id),
      desc: describeMcpEntry(entry),
      source: entry.source === 'project' ? 'project' : 'user',
      status: String(entry.status ?? 'configured'),
      runtimeEnabled: entry.enabled !== false,
      data: normalizeMcpServerConfig(entry),
    };
  }).filter(Boolean) as CapabilityRawItem[];
}

function discoverPlugins(): CapabilityRawItem[] {
  const parsed = runCodexJson(['plugin', 'list', '--json']);
  const installed = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.installed) ? parsed.installed : [];
  return installed.map((entry: any) => {
    const id = String(entry.id ?? entry.name ?? entry.pluginId ?? '').trim();
    if (!id) return null;
    return {
      id,
      label: String(entry.name ?? entry.label ?? id),
      desc: typeof entry.description === 'string' ? entry.description : undefined,
      source: 'plugin',
      status: entry.enabled === false ? 'disabled' : 'installed',
      runtimeEnabled: entry.enabled !== false,
    };
  }).filter(Boolean) as CapabilityRawItem[];
}

export class CodexCapabilityProvider implements CapabilityProvider {
  readonly baseagent = 'codex';

  getSupport(type: CapabilityType): CapabilityTypeState {
    void type;
    return {
      mode: 'inherit',
      canUpdate: true,
    };
  }

  async discover(ctx: CapabilityContext, type: CapabilityType): Promise<CapabilityRawItem[]> {
    if (type === 'skill') return discoverSkills(ctx);
    if (type === 'mcp') return discoverMcp();
    return discoverPlugins();
  }
}
