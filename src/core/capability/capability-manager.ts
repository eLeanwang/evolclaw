import { ConfigTarget, read, write } from '../../config/config-manager.js';
import type { AgentConfig, EffectiveAgentConfig } from '../../types.js';
import { ClaudeCapabilityProvider } from './providers/claude-capability-provider.js';
import { CodexCapabilityProvider } from './providers/codex-capability-provider.js';
import { GeminiCapabilityProvider } from './providers/gemini-capability-provider.js';
import {
  CAPABILITY_TYPES,
  isCapabilityType,
  normalizeCapabilityTypeConfig,
  resolveCapabilityEnabled,
  type CapabilityConfigByBaseagent,
  type CapabilityContext,
  type CapabilityItemValue,
  type CapabilityMode,
  type CapabilityRawItem,
  type CapabilityOption,
  type CapabilityOverride,
  type CapabilityProvider,
  type CapabilityType,
  type CapabilityTypeConfig,
  type CapabilityTypeState,
} from './types.js';

export interface ResolveCapabilityContextInput {
  aid?: string;
  baseagent?: string | null;
  projectPath?: string | null;
  config?: EffectiveAgentConfig | AgentConfig | null;
  sessionProjectPath?: string | null;
  sessionBaseagent?: string | null;
}

export interface CapabilityQueryResult {
  scope: 'project';
  projectPath: string;
  baseagent: string;
  capabilities: Partial<Record<CapabilityType, CapabilityTypeState>>;
}

export interface CapabilityUpdateResult {
  type: CapabilityType;
  mode?: CapabilityMode;
  name?: string;
  override?: CapabilityOverride | null;
  saved: true;
}

const PROVIDERS: Record<string, CapabilityProvider> = {
  claude: new ClaudeCapabilityProvider(),
  codex: new CodexCapabilityProvider(),
  gemini: new GeminiCapabilityProvider(),
};

export { CAPABILITY_TYPES, isCapabilityType, resolveCapabilityEnabled };

function defaultTypeConfig(): Required<CapabilityTypeConfig> {
  return { mode: 'inherit', overrides: {} };
}

function resolveBaseagent(input: ResolveCapabilityContextInput): string {
  return input.baseagent
    || input.sessionBaseagent
    || input.config?.active_baseagent
    || 'claude';
}

export function resolveCapabilityContext(input: ResolveCapabilityContextInput): CapabilityContext | { error: string; code: string } {
  const aid = input.aid || input.config?.aid;
  if (!aid) return { error: '当前 channel 无绑定 agent', code: 'FORBIDDEN' };
  const projectPath = input.config?.projects?.defaultPath || input.projectPath || input.sessionProjectPath || null;
  if (!projectPath) return { error: '无法解析当前 agent projectPath', code: 'NO_PROJECT' };
  return {
    aid,
    baseagent: resolveBaseagent(input),
    projectPath,
  };
}

export function getProvider(baseagent: string): CapabilityProvider {
  return PROVIDERS[baseagent] ?? {
    baseagent,
    getSupport: () => ({ mode: 'inherit', canUpdate: false, reason: `baseagent ${baseagent} 尚未支持 capability 管理` }),
    discover: async () => [],
  };
}

export function getAgentCapabilityConfig(config: AgentConfig | EffectiveAgentConfig | null | undefined, baseagent: string, type: CapabilityType): Required<CapabilityTypeConfig> {
  const root = (config?.capabilities ?? {}) as CapabilityConfigByBaseagent;
  return normalizeCapabilityTypeConfig(root[baseagent]?.[type]);
}

export function queryCapabilityTypes(
  ctx: CapabilityContext,
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  onlyType?: CapabilityType,
): CapabilityQueryResult {
  const provider = getProvider(ctx.baseagent);
  const types = onlyType ? [onlyType] : [...CAPABILITY_TYPES];
  const capabilities: Partial<Record<CapabilityType, CapabilityTypeState>> = {};
  for (const type of types) {
    const policy = getAgentCapabilityConfig(config, ctx.baseagent, type);
    const support = provider.getSupport(type);
    capabilities[type] = { ...support, mode: policy.mode };
  }
  return {
    scope: 'project',
    projectPath: ctx.projectPath,
    baseagent: ctx.baseagent,
    capabilities,
  };
}

export async function listCapabilityOptions(
  ctx: CapabilityContext,
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  type: CapabilityType,
): Promise<CapabilityOption[]> {
  const provider = getProvider(ctx.baseagent);
  const policy = getAgentCapabilityConfig(config, ctx.baseagent, type);
  const discovered = await provider.discover(ctx, type);
  return discovered
    .map(item => ({
      value: item.id,
      label: item.label || item.id,
      desc: item.desc,
      source: item.source ?? 'unknown',
      status: item.status,
      enabled: resolveCapabilityEnabled(policy, item.id),
      override: policy.overrides[item.id] ?? null,
      runtimeEnabled: item.runtimeEnabled,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function ensureMutableCapabilityConfig(config: AgentConfig, baseagent: string, type: CapabilityType): Required<CapabilityTypeConfig> {
  const root = ((config as any).capabilities ??= {}) as CapabilityConfigByBaseagent;
  const base = (root[baseagent] ??= {});
  const current = normalizeCapabilityTypeConfig(base[type]);
  base[type] = current;
  return current;
}

export function updateCapabilityPolicy(aid: string, baseagent: string, type: CapabilityType, value: CapabilityMode | CapabilityItemValue, name?: string): CapabilityUpdateResult {
  const provider = getProvider(baseagent);
  const support = provider.getSupport(type);
  if (!support.canUpdate) {
    throw Object.assign(new Error(support.reason || '当前 baseagent 不支持 capability 更新'), { code: 'NOT_SUPPORTED' });
  }

  const sel = { self: aid };
  const config = read<AgentConfig>(ConfigTarget.Agent, sel) ?? ({ aid, channels: [] } as unknown as AgentConfig);
  const target = ensureMutableCapabilityConfig(config, baseagent, type);

  if (name) {
    if (value !== 'enabled' && value !== 'disabled' && value !== 'inherit') {
      throw Object.assign(new Error('单项级 value 只能是 enabled / disabled / inherit'), { code: 'INVALID_ARGS' });
    }
    if (value === 'inherit') delete target.overrides[name];
    else target.overrides[name] = value;
    write(ConfigTarget.Agent, config, sel);
    return { type, name, override: value === 'inherit' ? null : value, saved: true };
  }

  if (value !== 'inherit' && value !== 'all' && value !== 'none') {
    throw Object.assign(new Error('类型级 value 只能是 inherit / all / none'), { code: 'INVALID_ARGS' });
  }
  target.mode = value;
  write(ConfigTarget.Agent, config, sel);
  return { type, mode: value, saved: true };
}

type CapabilityCatalog = Partial<Record<CapabilityType, CapabilityRawItem[]>>;

function mergeJsonObject(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && current
      && typeof current === 'object'
      && !Array.isArray(current)
    ) {
      target[key] = mergeJsonObject({ ...(current as Record<string, unknown>) }, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function resolveCapabilityIds(policy: Required<CapabilityTypeConfig>, catalog: CapabilityRawItem[]): string[] | null {
  const ids = new Set<string>();
  if (policy.mode === 'all') {
    for (const item of catalog) ids.add(item.id);
  } else if (policy.mode === 'none') {
    for (const [id, override] of Object.entries(policy.overrides)) {
      if (override === 'enabled') ids.add(id);
    }
    return [...ids];
  } else {
    for (const item of catalog) ids.add(item.id);
  }

  for (const [id, override] of Object.entries(policy.overrides)) {
    if (override === 'enabled') ids.add(id);
    else ids.delete(id);
  }

  if (policy.mode === 'inherit' && Object.keys(policy.overrides).length === 0) return null;
  return [...ids];
}

async function discoverCatalogForPolicy(
  provider: CapabilityProvider,
  ctx: CapabilityContext,
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  baseagent: string,
): Promise<CapabilityCatalog> {
  const catalog: CapabilityCatalog = {};
  for (const type of CAPABILITY_TYPES) {
    const policy = getAgentCapabilityConfig(config, baseagent, type);
    if (policy.mode !== 'inherit' || Object.keys(policy.overrides).length > 0) {
      try { catalog[type] = await provider.discover(ctx, type); }
      catch { catalog[type] = []; }
    }
  }
  return catalog;
}

export async function resolveClaudeCapabilityRunOptionsForProject(
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  projectPath: string,
  baseagent = 'claude',
): Promise<Record<string, unknown>> {
  const provider = getProvider(baseagent);
  const ctx: CapabilityContext = { aid: config?.aid ?? '', baseagent, projectPath };
  const catalog: CapabilityCatalog = {};
  for (const type of CAPABILITY_TYPES) {
    const policy = getAgentCapabilityConfig(config, baseagent, type);
    if (policy.mode === 'none' || (type === 'plugin' && policy.mode === 'all')) {
      try { catalog[type] = await provider.discover(ctx, type); }
      catch { catalog[type] = []; }
    }
  }
  return resolveClaudeCapabilityRunOptions(config, baseagent, catalog);
}

export function resolveClaudeCapabilityRunOptions(
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  baseagent = 'claude',
  catalog: CapabilityCatalog = {},
): Record<string, unknown> {
  const skill = getAgentCapabilityConfig(config, baseagent, 'skill');
  const mcp = getAgentCapabilityConfig(config, baseagent, 'mcp');
  const plugin = getAgentCapabilityConfig(config, baseagent, 'plugin');
  const options: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};

  const enabledSkills = Object.entries(skill.overrides).filter(([, v]) => v === 'enabled').map(([id]) => id);
  if (skill.mode === 'all') {
    options.skills = 'all';
  } else if (skill.mode === 'none') {
    options.skills = enabledSkills;
  }
  const skillOverrides: Record<string, 'on' | 'off'> = {};
  for (const [id, value] of Object.entries(skill.overrides)) {
    skillOverrides[id] = value === 'enabled' ? 'on' : 'off';
  }
  if (Object.keys(skillOverrides).length > 0) settings.skillOverrides = skillOverrides;

  const enabledMcp = Object.entries(mcp.overrides).filter(([, v]) => v === 'enabled').map(([id]) => id);
  const disabledMcp = Object.entries(mcp.overrides).filter(([, v]) => v === 'disabled').map(([id]) => id);
  if (mcp.mode === 'none') {
    settings.enableAllProjectMcpServers = false;
    settings.enabledMcpjsonServers = enabledMcp;
    settings.allowedMcpServers = enabledMcp.map(serverName => ({ serverName }));
  } else {
    if (mcp.mode === 'all') settings.enableAllProjectMcpServers = true;
    if (enabledMcp.length > 0) settings.enabledMcpjsonServers = enabledMcp;
    if (disabledMcp.length > 0) settings.disabledMcpjsonServers = disabledMcp;
    if (disabledMcp.length > 0) settings.deniedMcpServers = disabledMcp.map(serverName => ({ serverName }));
  }

  const enabledPlugins: Record<string, boolean> = {};
  if (plugin.mode === 'all') {
    for (const item of catalog.plugin ?? []) {
      enabledPlugins[item.id] = true;
    }
  }
  if (plugin.mode === 'none') {
    for (const item of catalog.plugin ?? []) {
      enabledPlugins[item.id] = false;
    }
  }
  for (const [id, value] of Object.entries(plugin.overrides)) {
    enabledPlugins[id] = value === 'enabled';
  }
  if (Object.keys(enabledPlugins).length > 0) settings.enabledPlugins = enabledPlugins;

  if (Object.keys(settings).length > 0) options.settings = settings;
  return options;
}

export async function resolveCodexCapabilityThreadConfigForProject(
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  projectPath: string,
  baseagent = 'codex',
): Promise<Record<string, unknown>> {
  const provider = getProvider(baseagent);
  const ctx: CapabilityContext = { aid: config?.aid ?? '', baseagent, projectPath };
  const catalog = await discoverCatalogForPolicy(provider, ctx, config, baseagent);
  return resolveCodexCapabilityThreadConfig(config, baseagent, catalog);
}

export function resolveCodexCapabilityThreadConfig(
  config: AgentConfig | EffectiveAgentConfig | null | undefined,
  baseagent = 'codex',
  catalog: CapabilityCatalog = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skill = getAgentCapabilityConfig(config, baseagent, 'skill');
  const mcp = getAgentCapabilityConfig(config, baseagent, 'mcp');
  const plugin = getAgentCapabilityConfig(config, baseagent, 'plugin');

  const skillEntries: Array<{ name: string; enabled: boolean }> = [];
  const skillCatalog = catalog.skill ?? [];
  if (skill.mode === 'none') {
    for (const item of skillCatalog) skillEntries.push({ name: item.id, enabled: false });
  }
  for (const [name, override] of Object.entries(skill.overrides)) {
    const existing = skillEntries.find(entry => entry.name === name);
    if (existing) existing.enabled = override === 'enabled';
    else skillEntries.push({ name, enabled: override === 'enabled' });
  }
  if (skillEntries.length > 0) {
    mergeJsonObject(out, { skills: { config: skillEntries } });
  }

  const mcpCatalog = catalog.mcp ?? [];
  const selectedMcpIds = resolveCapabilityIds(mcp, mcpCatalog);
  if (selectedMcpIds) {
    const entries = Object.fromEntries(
      mcpCatalog
        .filter(item => selectedMcpIds.includes(item.id) && item.data && typeof item.data === 'object' && !Array.isArray(item.data))
        .map(item => [item.id, item.data as Record<string, unknown>])
    );
    mergeJsonObject(out, { mcp_servers: entries });
  }

  const pluginCatalog = catalog.plugin ?? [];
  const pluginConfig: Record<string, unknown> = {};
  if (plugin.mode === 'all') {
    for (const item of pluginCatalog) pluginConfig[item.id] = { enabled: true };
  } else if (plugin.mode === 'none') {
    for (const item of pluginCatalog) pluginConfig[item.id] = { enabled: false };
  }
  for (const [id, override] of Object.entries(plugin.overrides)) {
    pluginConfig[id] = { enabled: override === 'enabled' };
  }
  if (Object.keys(pluginConfig).length > 0) {
    mergeJsonObject(out, { plugins: pluginConfig });
  }

  return out;
}
