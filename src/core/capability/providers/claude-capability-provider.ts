import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { CapabilityContext, CapabilityProvider, CapabilityRawItem, CapabilityType, CapabilityTypeState } from '../types.js';

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

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

function readSkillDescription(skillDir: string): string | undefined {
  const file = path.join(skillDir, 'SKILL.md');
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const firstBodyLine = text.split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#') && !line.startsWith('---') && !line.includes(':'));
    return firstBodyLine ? firstBodyLine.slice(0, 180) : undefined;
  } catch {
    return undefined;
  }
}

function describeMcpSpec(spec: any): string | undefined {
  const command = typeof spec?.command === 'string' ? spec.command : undefined;
  if (command) return `stdio: ${path.basename(command)}`;
  const rawUrl = typeof spec?.url === 'string' ? spec.url : typeof spec?.serverUrl === 'string' ? spec.serverUrl : undefined;
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return `remote: ${url.origin}${url.pathname}`;
  } catch {
    return 'remote';
  }
}

function discoverSkills(projectPath: string): CapabilityRawItem[] {
  const roots = [
    { dir: path.join(projectPath, '.claude', 'skills'), source: 'project' as const },
    { dir: path.join(os.homedir(), '.claude', 'skills'), source: 'user' as const },
  ];
  const seen = new Set<string>();
  const items: CapabilityRawItem[] = [];
  for (const root of roots) {
    for (const name of listDirectories(root.dir)) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        id: name,
        label: name,
        desc: readSkillDescription(path.join(root.dir, name)),
        source: root.source,
      });
    }
  }
  return items;
}

function readMcpServers(projectPath: string): CapabilityRawItem[] {
  const candidates = [
    { file: path.join(projectPath, '.mcp.json'), source: 'project' as const },
    { file: path.join(projectPath, '.claude', 'mcp.json'), source: 'project' as const },
    { file: path.join(os.homedir(), '.claude', 'mcp.json'), source: 'user' as const },
  ];
  const seen = new Set<string>();
  const items: CapabilityRawItem[] = [];
  for (const candidate of candidates) {
    const config = readJson(candidate.file);
    const servers = config?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, spec] of Object.entries<any>(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        id: name,
        label: name,
        desc: describeMcpSpec(spec),
        source: candidate.source,
        status: 'configured',
        runtimeEnabled: true,
        data: spec && typeof spec === 'object' && !Array.isArray(spec) ? { ...spec } : undefined,
      });
    }
  }
  return items;
}

function discoverPlugins(projectPath: string): CapabilityRawItem[] {
  const settingsFiles = [
    { file: path.join(projectPath, '.claude', 'settings.json'), source: 'project' as const },
    { file: path.join(projectPath, '.claude', 'settings.local.json'), source: 'project' as const },
    { file: path.join(os.homedir(), '.claude', 'settings.json'), source: 'user' as const },
  ];
  const seen = new Set<string>();
  const items: CapabilityRawItem[] = [];
  for (const candidate of settingsFiles) {
    const settings = readJson(candidate.file);
    const plugins = settings?.enabledPlugins;
    if (!plugins || typeof plugins !== 'object') continue;
    for (const [id, enabled] of Object.entries<any>(plugins)) {
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        label: id,
        source: candidate.source,
        status: enabled === false ? 'disabled' : 'configured',
        runtimeEnabled: enabled !== false,
      });
    }
  }
  return items;
}

async function discoverPluginsFromCli(): Promise<CapabilityRawItem[]> {
  try {
    const output = execFileSync('claude', ['plugin', 'list', '--json'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.installed) ? parsed.installed : [];
    return list.map((entry: any) => {
      const id = String(entry.id ?? entry.name ?? entry.pluginId ?? '').trim();
      return id ? {
        id,
        label: String(entry.name ?? entry.label ?? id),
        desc: typeof entry.description === 'string' ? entry.description : undefined,
        source: 'plugin' as const,
        status: entry.enabled === false ? 'disabled' : 'installed',
        runtimeEnabled: entry.enabled !== false,
      } : null;
    }).filter(Boolean) as CapabilityRawItem[];
  } catch {
    return [];
  }
}

export class ClaudeCapabilityProvider implements CapabilityProvider {
  readonly baseagent = 'claude';

  getSupport(type: CapabilityType): CapabilityTypeState {
    void type;
    return { mode: 'inherit', canUpdate: true };
  }

  async discover(ctx: CapabilityContext, type: CapabilityType): Promise<CapabilityRawItem[]> {
    if (type === 'skill') return discoverSkills(ctx.projectPath);
    if (type === 'mcp') return readMcpServers(ctx.projectPath);
    const fromSettings = discoverPlugins(ctx.projectPath);
    if (fromSettings.length > 0) return fromSettings;
    return await discoverPluginsFromCli();
  }
}
