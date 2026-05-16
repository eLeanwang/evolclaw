import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config } from './types.js';
import { logger } from './utils/logger.js';
import { resolvePaths, getPackageRoot as _getPackageRoot } from './paths.js';
import { commandExists } from './utils/cross-platform.js';

// Re-export path utilities for backward compatibility
export { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';

export interface AnthropicResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  pathToClaudeCodeExecutable?: string;
}

function loadClaudeSettings(): { env?: Record<string, string>; model?: string; effortLevel?: 'low' | 'medium' | 'high' } {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {}
  return {};
}

function loadCodexSettings(): { apiKey?: string; baseUrl?: string; model?: string } {
  try {
    // Read auth.json for API key
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    let apiKey: string | undefined;
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      apiKey = auth.OPENAI_API_KEY;
    }

    // Read config.toml for model and baseUrl (simple TOML parsing)
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let model: string | undefined;
    let baseUrl: string | undefined;
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
      if (modelMatch) model = modelMatch[1];

      // Extract base_url from model_providers section
      const providerMatch = content.match(/^model_provider\s*=\s*"([^"]+)"/m);
      if (providerMatch) {
        const provider = providerMatch[1];
        const baseUrlMatch = content.match(new RegExp(`\\[model_providers\\.${provider}\\][\\s\\S]*?base_url\\s*=\\s*"([^"]+)"`, 'm'));
        if (baseUrlMatch) baseUrl = baseUrlMatch[1];
      }
    }

    return { apiKey, baseUrl, model };
  } catch {}
  return {};
}

/**
 * Resolve anthropic credentials with optional override (from agent.json).
 *
 * Priority: override > globalConfig.agents.claude > env > ~/.claude/settings.json
 *
 * Override is matched against the same shape as `config.agents.claude` so
 * EvolAgent's `agents.claude` block is wired in directly.
 */
export function resolveAnthropicConfig(
  config: Config,
  override?: { apiKey?: string; baseUrl?: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; pathToClaudeCodeExecutable?: string }
): AnthropicResolved {
  const settings = loadClaudeSettings();

  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  // apiKey: override → global → env → settings.json
  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(config.agents?.claude?.apiKey) ? undefined : config.agents?.claude?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of: agents.claude.apiKey (per-agent or global), env ANTHROPIC_AUTH_TOKEN, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN'
    );
  }

  const isPlaceholderUrl = (v?: string) => !v || v.includes('api.anthropic.com');
  const overrideBaseUrl = isPlaceholderUrl(override?.baseUrl) ? undefined : override?.baseUrl;
  const globalBaseUrl = isPlaceholderUrl(config.agents?.claude?.baseUrl) ? undefined : config.agents?.claude?.baseUrl;
  const baseUrl = overrideBaseUrl
    || globalBaseUrl
    || process.env.ANTHROPIC_BASE_URL
    || settings.env?.ANTHROPIC_BASE_URL;

  const model = override?.model
    || config.agents?.claude?.model
    || settings.model
    || 'sonnet';

  const effort = override?.effort
    || config.agents?.claude?.effort
    || settings.effortLevel
    || undefined;

  const pickExec = (v?: string) => (!v || v.includes('your-') || v.includes('placeholder')) ? undefined : v;
  const pathToClaudeCodeExecutable = pickExec(override?.pathToClaudeCodeExecutable)
    || pickExec(config.agents?.claude?.pathToClaudeCodeExecutable);

  return { apiKey, baseUrl, model, effort, pathToClaudeCodeExecutable };
}

export interface OpenaiResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: string;
}

export function resolveOpenaiConfig(
  config: Config,
  override?: { apiKey?: string; baseUrl?: string; model?: string; effort?: string; reasoning?: string }
): OpenaiResolved {
  const codexSettings = loadCodexSettings();
  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(config.agents?.codex?.apiKey) ? undefined : config.agents?.codex?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.OPENAI_API_KEY
    || codexSettings.apiKey;

  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set one of: agents.codex.apiKey (per-agent or global), env OPENAI_API_KEY, or ~/.codex/auth.json'
    );
  }

  const isPlaceholderUrl = (v?: string) => !v || v.includes('api.openai.com');
  const overrideBaseUrl = isPlaceholderUrl(override?.baseUrl) ? undefined : override?.baseUrl;
  const globalBaseUrl = isPlaceholderUrl(config.agents?.codex?.baseUrl) ? undefined : config.agents?.codex?.baseUrl;
  const baseUrl = overrideBaseUrl
    || globalBaseUrl
    || process.env.OPENAI_BASE_URL
    || codexSettings.baseUrl
    || undefined;

  const model = override?.model
    || config.agents?.codex?.model
    || codexSettings.model
    || 'gpt-5.2-codex';

  const effort = override?.effort
    || override?.reasoning
    || config.agents?.codex?.effort
    || config.agents?.codex?.reasoning
    || undefined;

  return { apiKey, baseUrl, model, effort };
}

// ── Google (Gemini) config ──

export interface GoogleResolved {
  cliPath: string;    // gemini CLI 可执行文件路径
  model: string;
  apiKey?: string;
  mode: 'cli' | 'sdk';
  useVertex?: boolean;
  project?: string;
  location?: string;
}

export function resolveGoogleConfig(
  config: Config,
  override?: { cliPath?: string; model?: string; apiKey?: string; mode?: 'cli' | 'sdk'; useVertex?: boolean; project?: string; location?: string }
): GoogleResolved {
  const googleCfg = config.agents?.gemini;
  const isPlaceholder = (v?: string) => !v || v.includes('your-') || v.includes('placeholder');

  let cliPath = override?.cliPath || googleCfg?.cliPath || '';
  if (!cliPath) {
    cliPath = commandExists('gemini') ? 'gemini' : '';
  }

  const model = override?.model || googleCfg?.model || 'gemini-2.5-flash';

  const overrideApiKey = isPlaceholder(override?.apiKey) ? undefined : override?.apiKey;
  const globalApiKey = isPlaceholder(googleCfg?.apiKey) ? undefined : googleCfg?.apiKey;
  const apiKey = overrideApiKey
    || globalApiKey
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || undefined;

  const mode = override?.mode || googleCfg?.mode || 'cli';
  const useVertex = override?.useVertex ?? googleCfg?.useVertex ?? false;
  const project = override?.project || googleCfg?.project || process.env.GOOGLE_CLOUD_PROJECT || undefined;
  const location = override?.location || googleCfg?.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

  return { cliPath, model, apiKey, mode, useVertex, project, location };
}

export function loadConfig(configPath: string = resolvePaths().config): Config {
  if (!fs.existsSync(configPath)) {
    // Try to recover from backup files
    const dataDir = path.dirname(configPath);
    const backupPath = path.join(dataDir, 'evolclaw.backup.json');
    if (fs.existsSync(backupPath)) {
      logger.warn(`Config file missing, restoring from backup: ${backupPath}`);
      fs.copyFileSync(backupPath, configPath);
    } else {
      // Look for timestamped backups (evolclaw-YYYYMMDD-HHMMSS.json)
      const timestampedBackups = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir)
            .filter(f => /^evolclaw-\d{8}-\d{6}\.json$/.test(f))
            .sort()
            .reverse()
        : [];
      if (timestampedBackups.length > 0) {
        const latest = path.join(dataDir, timestampedBackups[0]);
        logger.warn(`Config file missing, restoring from timestamped backup: ${latest}`);
        fs.copyFileSync(latest, configPath);
      } else {
        // Create minimal config from sample
        const samplePath = path.join(_getPackageRoot(), 'data', 'evolclaw.sample.json');
        if (fs.existsSync(samplePath)) {
          logger.warn(`Config file missing, creating from sample: ${samplePath}`);
          const sample = JSON.parse(fs.readFileSync(samplePath, 'utf-8'));
          // Set a usable defaultPath
          const defaultProjectDir = path.join(os.homedir(), 'projects', 'default');
          sample.projects.defaultPath = defaultProjectDir;
          if (!fs.existsSync(defaultProjectDir)) {
            fs.mkdirSync(defaultProjectDir, { recursive: true });
          }
          fs.writeFileSync(configPath, JSON.stringify(sample, null, 2), 'utf-8');
        } else {
          throw new Error(`Config file not found: ${configPath}`);
        }
      }
    }
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  if (migrateAgentsKeys(config)) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.warn(`Config migrated: agents.{anthropic,openai,google} → {claude,codex,gemini} in ${configPath}`);
  }

  validateConfig(config);
  return config;
}

/**
 * Rename legacy agent config keys to runner names.
 * Returns true if any rename happened.
 */
function migrateAgentsKeys(config: any): boolean {
  const agents = config?.agents;
  if (!agents || typeof agents !== 'object') return false;

  const renames: Array<[string, string]> = [
    ['anthropic', 'claude'],
    ['openai', 'codex'],
    ['google', 'gemini'],
  ];

  let changed = false;
  for (const [oldKey, newKey] of renames) {
    if (agents[oldKey] === undefined) continue;
    if (agents[newKey] === undefined) {
      agents[newKey] = agents[oldKey];
    } else {
      logger.warn(`Config has both agents.${oldKey} and agents.${newKey}; keeping new key, dropping legacy one`);
    }
    delete agents[oldKey];
    changed = true;
  }
  return changed;
}

export function saveConfig(config: Config, configPath: string = resolvePaths().config): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ── Channel instance normalization ──

export const channelTypes = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom'] as const;

/**
 * Normalize a channel config value (single object, array, or undefined) into an array
 * where every element has a `name` field.
 * - undefined → []
 * - single object → [{ ...obj, name: obj.name ?? defaultName }]
 * - array → passthrough (names must already be present)
 */
export function normalizeChannelInstances<T extends { name?: string }>(
  cfg: T | T[] | undefined,
  defaultName: string,
): (T & { name: string })[] {
  if (cfg === undefined || cfg === null) return [];
  if (Array.isArray(cfg)) {
    return cfg.map((item, i) => ({
      ...item,
      name: item.name ?? (cfg.length === 1 ? defaultName : `${defaultName}-${i + 1}`),
    })) as (T & { name: string })[];
  }
  return [{ ...cfg, name: cfg.name ?? defaultName } as T & { name: string }];
}

/**
 * Parse a defaultChannel reference. Supports:
 *   "feishu"           → { type: "feishu" }
 *   "feishu/feilun"    → { type: "feishu", instance: "feilun" }
 */
export function parseDefaultChannelRef(ref: string): { type: string; instance?: string } {
  const slash = ref.indexOf('/');
  if (slash < 0) return { type: ref };
  return { type: ref.slice(0, slash), instance: ref.slice(slash + 1) };
}

/**
 * Validate a defaultChannel reference against a channels config block.
 * Returns an error message string if invalid, or null if OK.
 *   - type must be in channelTypes
 *   - type must have at least one instance configured
 *   - if instance specified, must match an existing instance.name
 *   - if instance omitted, type must have exactly 1 instance (else ambiguous)
 */
export function validateDefaultChannelRef(ref: string, channelsBlock: any): string | null {
  const { type, instance } = parseDefaultChannelRef(ref);
  if (!channelTypes.includes(type as any)) {
    return `channels.defaultChannel='${ref}' references unknown channel type '${type}'`;
  }
  const instances = normalizeChannelInstances(channelsBlock?.[type], type);
  if (instances.length === 0) {
    return `channels.defaultChannel='${ref}' but channels.${type} has no instances`;
  }
  if (instance) {
    if (!instances.some(i => i.name === instance)) {
      return `channels.defaultChannel='${ref}' but channels.${type} has no instance named '${instance}'`;
    }
  } else if (instances.length > 1) {
    const names = instances.map(i => i.name).join(', ');
    return `channels.defaultChannel='${ref}' is ambiguous: channels.${type} has ${instances.length} instances (${names}); use 'type/instanceName' form`;
  }
  return null;
}

/**
 * Validate that all channel instance names are unique across all channel types.
 * Throws if duplicate names are found.
 */
export function validateChannelInstanceNames(config: Config): void {
  const seen = new Map<string, string>(); // name → channel type
  for (const type of channelTypes) {
    const instances = normalizeChannelInstances(
      (config.channels as any)?.[type],
      type,
    );
    for (const inst of instances) {
      const prev = seen.get(inst.name);
      if (prev !== undefined) {
        throw new Error(
          `Duplicate channel instance name "${inst.name}" (found in ${prev} and ${type})`,
        );
      }
      seen.set(inst.name, type);
    }
  }
}

export function getOwner(config: Config, channelOrType: string): string | undefined {
  for (const type of channelTypes) {
    const raw = (config.channels as any)?.[type];
    const instances = normalizeChannelInstances(raw, type);

    // 按实例名查找
    const found = instances.find((inst) => inst.name === channelOrType);
    if (found) return (found as any).owner;

    // 按 channelType 查找：返回该类型下第一个有 owner 的实例
    if (type === channelOrType) {
      for (const inst of instances) {
        if ((inst as any).owner) return (inst as any).owner;
      }
    }
  }
  return undefined;
}

/**
 * Find a channel instance by name in a config-like object and set its owner.
 * Returns true if the instance was found and updated.
 */
export function writeOwnerToChannelInstance(root: any, instanceName: string, userId: string): boolean {
  const channels = root?.channels;
  if (!channels || typeof channels !== 'object') return false;

  for (const type of channelTypes) {
    const raw = channels[type];
    if (raw === undefined) continue;

    if (Array.isArray(raw)) {
      const inst = raw.find((item: any) => item.name === instanceName);
      if (inst) {
        inst.owner = userId;
        return true;
      }
    } else {
      const effectiveName = raw.name ?? type;
      if (effectiveName === instanceName) {
        raw.owner = userId;
        return true;
      }
    }
  }
  return false;
}

export function setOwner(config: Config, instanceName: string, userId: string, configPath: string = resolvePaths().config): void {
  if (!config.channels) config.channels = {};

  // 1. Try writing to evolclaw.json (default-agent channels)
  if (writeOwnerToChannelInstance(config, instanceName, userId)) {
    saveConfig(config, configPath);
    return;
  }

  // 2. Last resort: if instanceName matches a channel type with no config, create it
  if (channelTypes.includes(instanceName as any)) {
    (config.channels as any)[instanceName] = { owner: userId };
    saveConfig(config, configPath);
    return;
  }

  // 3. I4: No match — warn (don't silently lose owner). Callers managing
  // agent-owned channels should route through EvolAgent.setOwner before
  // falling back to this global setter.
  logger.warn(`[setOwner] Channel instance "${instanceName}" not found in evolclaw.json. Owner ${userId} not persisted.`);
}

type ShowActivitiesMode = 'all' | 'dm-only' | 'owner-dm-only' | 'none';

export function getChannelShowActivities(config: Config, instanceName: string): ShowActivitiesMode {
  for (const type of channelTypes) {
    const raw = (config.channels as any)?.[type];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      const inst = raw.find((item: any) => item.name === instanceName);
      if (inst) return inst.showActivities ?? config.showActivities ?? 'all';
    } else {
      const effectiveName = raw.name ?? type;
      if (effectiveName === instanceName) return raw.showActivities ?? config.showActivities ?? 'all';
    }
  }
  return config.showActivities ?? 'all';
}

export function setChannelShowActivities(config: Config, instanceName: string, mode: ShowActivitiesMode): void {
  if (!config.channels) config.channels = {};
  const channels = config.channels as any;

  for (const type of channelTypes) {
    const raw = channels[type];
    if (raw === undefined) continue;

    if (Array.isArray(raw)) {
      const inst = raw.find((item: any) => item.name === instanceName);
      if (inst) {
        inst.showActivities = mode;
        saveConfig(config);
        return;
      }
    } else {
      const effectiveName = raw.name ?? type;
      if (effectiveName === instanceName) {
        raw.showActivities = mode;
        saveConfig(config);
        return;
      }
    }
  }
}

/**
 * 读取全局 chatmode 配置的默认 sessionMode
 * 按 chatType 返回对应模式，未配置时返回 undefined（由 session-manager 回退到 'interactive'）
 */
export function getDefaultSessionMode(config: Config, chatType: string): 'interactive' | 'proactive' | undefined {
  const cm = config.chatmode;
  if (!cm) return undefined;
  if (chatType === 'group') return cm.group;
  return cm.private;
}

export function isOwner(config: Config, channelOrType: string, userId: string): boolean {
  // 按实例名精确匹配（evolclaw.json）
  if (getOwner(config, channelOrType) === userId) return true;
  // 按 channelType 匹配：检查该类型下所有实例（evolclaw.json）
  for (const type of channelTypes) {
    if (type !== channelOrType) continue;
    const raw = (config.channels as any)?.[type];
    const instances = normalizeChannelInstances(raw, type);
    for (const inst of instances) {
      if ((inst as any).owner === userId) return true;
    }
  }
  return false;
}

export function isAdmin(config: Config, channelOrType: string, userId: string): boolean {
  // 按实例名精确匹配
  for (const type of channelTypes) {
    const raw = (config.channels as any)?.[type];
    const instances = normalizeChannelInstances(raw, type);
    const found = instances.find((inst) => inst.name === channelOrType);
    if (found) {
      const admins: string[] = (found as any).admins || [];
      return admins.includes(userId);
    }
  }
  // 按 channelType 匹配：检查该类型下所有实例
  for (const type of channelTypes) {
    if (type !== channelOrType) continue;
    const raw = (config.channels as any)?.[type];
    const instances = normalizeChannelInstances(raw, type);
    for (const inst of instances) {
      const admins: string[] = (inst as any).admins || [];
      if (admins.includes(userId)) return true;
    }
  }
  return false;
}

function validateConfig(config: any): asserts config is Config {
  // anthropic 部分不再强制校验，由 resolveAnthropicConfig() 处理

  // Feishu 配置可选，但如果配置了就要完整（支持 array / object 两种格式）
  const feishuInstances = normalizeChannelInstances(config.channels?.feishu, 'feishu');
  for (const inst of feishuInstances) {
    if ((inst as any).enabled === false) continue;
    const appId = (inst as any).appId || '';
    const appSecret = (inst as any).appSecret || '';
    if (!appId && !appSecret) continue;
    const label = feishuInstances.length > 1 ? ` [${inst.name}]` : '';
    if (!appId || appId.startsWith('YOUR_')) {
      logger.warn(`⚠ Feishu${label} appId not configured (Feishu channel will be disabled)`);
    }
    if (!appSecret || appSecret.startsWith('YOUR_')) {
      logger.warn(`⚠ Feishu${label} appSecret not configured (Feishu channel will be disabled)`);
    }
  }

  // AUN 配置可选，但如果配置了就要有 aid（支持 array / object 两种格式）
  const aunInstances = normalizeChannelInstances(config.channels?.aun, 'aun');
  for (const inst of aunInstances) {
    if ((inst as any).enabled === false) continue;
    const label = aunInstances.length > 1 ? ` [${inst.name}]` : '';
    if (!(inst as any).aid) {
      logger.warn(`⚠ AUN${label} aid not configured (AUN channel will be disabled)`);
    }
  }

  if (!config.projects?.defaultPath) throw new Error('Missing projects.defaultPath');

  // WeChat 配置可选，但如果启用了就需要 token（支持 array / object 两种格式）
  const wechatInstances = normalizeChannelInstances(config.channels?.wechat, 'wechat');
  for (const inst of wechatInstances) {
    if ((inst as any).enabled && !(inst as any).token) {
      const label = wechatInstances.length > 1 ? ` [${inst.name}]` : '';
      logger.warn(`⚠ WeChat${label} enabled but token not configured (WeChat channel will be disabled)`);
    }
  }

  // DingTalk 配置可选，但如果配置了就需要 clientId + clientSecret
  const dingtalkInstances = normalizeChannelInstances(config.channels?.dingtalk, 'dingtalk');
  for (const inst of dingtalkInstances) {
    if ((inst as any).enabled === false) continue;
    const label = dingtalkInstances.length > 1 ? ` [${inst.name}]` : '';
    const hasClientId = !!(inst as any).clientId && !(inst as any).clientId.includes('your-');
    const hasClientSecret = !!(inst as any).clientSecret && !(inst as any).clientSecret.includes('your-');
    if (hasClientId !== hasClientSecret) {
      logger.warn(`⚠ DingTalk${label} clientId/clientSecret incomplete (DingTalk channel will be disabled)`);
    }
  }

  // QQBot 配置可选，但如果配置了就需要 appId + clientSecret
  const qqbotInstances = normalizeChannelInstances(config.channels?.qqbot, 'qqbot');
  for (const inst of qqbotInstances) {
    if ((inst as any).enabled === false) continue;
    const label = qqbotInstances.length > 1 ? ` [${inst.name}]` : '';
    const hasAppId = !!(inst as any).appId && !(inst as any).appId.includes('your-');
    const hasSecret = !!(inst as any).clientSecret && !(inst as any).clientSecret.includes('your-');
    if (hasAppId !== hasSecret) {
      logger.warn(`⚠ QQBot${label} appId/clientSecret incomplete (QQBot channel will be disabled)`);
    }
  }
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Append a new AUN instance to the config's channels.aun array and save.
 * Handles upgrade from single-object to array format.
 */
export function appendAunInstance(config: any, inst: { name: string; aid: string; owner?: string; enabled?: boolean }): void {
  if (!config.channels) config.channels = {};

  const newInst = {
    name: inst.name,
    enabled: inst.enabled ?? true,
    aid: inst.aid,
    ...(inst.owner && { owner: inst.owner }),
  };

  if (Array.isArray(config.channels.aun)) {
    config.channels.aun.push(newInst);
  } else if (config.channels.aun) {
    const oldInst = { ...config.channels.aun, name: config.channels.aun.name || 'aun' };
    config.channels.aun = [oldInst, newInst];
  } else {
    config.channels.aun = [newInst];
  }

  fs.writeFileSync(resolvePaths().config, JSON.stringify(config, null, 2) + '\n');
}

/**
 * 配置结构完整性校验（不校验凭据有效性）。
 * 要求 agents/channels/projects 三段同时具备必要的锚点字段。
 */
export function validateConfigIntegrity(config: any): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // agents — 单 agent 时自动推断，无需显式 defaultAgent
  const defaultAgent = config.agents?.defaultAgent;
  if (!defaultAgent) {
    const agentKeys = Object.keys(config.agents || {}).filter(k => k !== 'defaultAgent');
    const configuredAgents = agentKeys.filter(k => (config.agents as any)?.[k]);
    if (configuredAgents.length === 0 && agentKeys.length !== 1) {
      reasons.push('Missing agents.defaultAgent (multiple or no agents configured)');
    }
  } else {
    if (!config.agents?.[defaultAgent]) {
      reasons.push(`agents.defaultAgent='${defaultAgent}' but agents.${defaultAgent} does not exist`);
    }
  }

  // channels — 单实例自动推断，多实例必填 defaultChannel
  // 支持两种形式：
  //   "feishu"           → type 级，要求该 type 下只有 1 个实例
  //   "feishu/feilun"    → type/instanceName，精确指向实例
  const totalInstances = channelTypes.reduce((acc, t) => {
    return acc + normalizeChannelInstances((config.channels as any)?.[t], t).length;
  }, 0);

  if (totalInstances === 0) {
    reasons.push('Missing channels: no channel instances configured');
  } else if (totalInstances === 1) {
    // 单实例：defaultChannel 可省略（自动推断）
    const dc = config.channels?.defaultChannel;
    if (dc) {
      const err = validateDefaultChannelRef(dc, config.channels as any);
      if (err) reasons.push(err);
    }
  } else {
    // 多实例：defaultChannel 必填
    const dc = config.channels?.defaultChannel;
    if (!dc) {
      reasons.push('Missing channels.defaultChannel (multiple channel instances configured; must specify "type" or "type/instanceName")');
    } else {
      const err = validateDefaultChannelRef(dc, config.channels as any);
      if (err) reasons.push(err);
    }
  }

  // projects
  if (!config.projects?.defaultPath) {
    reasons.push('Missing projects.defaultPath');
  }

  return { valid: reasons.length === 0, reasons };
}
