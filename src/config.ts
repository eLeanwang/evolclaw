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

export function resolveAnthropicConfig(config: Config): AnthropicResolved {
  const settings = loadClaudeSettings();

  // 过滤占位符，视为未配置
  const configApiKey = config.agents?.claude?.apiKey;
  const isPlaceholderKey = !configApiKey ||
    configApiKey.includes('your-') ||
    configApiKey.includes('placeholder');

  const apiKey = (isPlaceholderKey ? null : configApiKey)
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of: agents.claude.apiKey, env ANTHROPIC_AUTH_TOKEN, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN'
    );
  }

  // baseUrl 也过滤占位符
  const configBaseUrl = config.agents?.claude?.baseUrl;
  const isPlaceholderUrl = configBaseUrl?.includes('api.anthropic.com');

  const baseUrl = (isPlaceholderUrl ? null : configBaseUrl)
    || process.env.ANTHROPIC_BASE_URL
    || settings.env?.ANTHROPIC_BASE_URL;

  const model = config.agents?.claude?.model
    || settings.model
    || 'sonnet';

  const effort = config.agents?.claude?.effort
    || settings.effortLevel
    || undefined;

  const configExecPath = config.agents?.claude?.pathToClaudeCodeExecutable;
  const isPlaceholderExec = !configExecPath || configExecPath.includes('your-') || configExecPath.includes('placeholder');
  const pathToClaudeCodeExecutable = isPlaceholderExec ? undefined : configExecPath;

  return { apiKey, baseUrl, model, effort, pathToClaudeCodeExecutable };
}

export interface OpenaiResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: string;
}

export function resolveOpenaiConfig(config: Config): OpenaiResolved {
  const codexSettings = loadCodexSettings();

  // 过滤占位符，视为未配置
  const configApiKey = config.agents?.codex?.apiKey;
  const isPlaceholderKey = !configApiKey ||
    configApiKey.includes('your-') ||
    configApiKey.includes('placeholder');

  const apiKey = (isPlaceholderKey ? null : configApiKey)
    || process.env.OPENAI_API_KEY
    || codexSettings.apiKey;

  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set one of: agents.codex.apiKey, env OPENAI_API_KEY, or ~/.codex/auth.json'
    );
  }

  // baseUrl 也过滤占位符（与 anthropic 保持一致：只检查默认域名）
  const configBaseUrl = config.agents?.codex?.baseUrl;
  const isPlaceholderUrl = configBaseUrl?.includes('api.openai.com');

  const baseUrl = (isPlaceholderUrl ? null : configBaseUrl)
    || process.env.OPENAI_BASE_URL
    || codexSettings.baseUrl
    || undefined;

  const model = config.agents?.codex?.model
    || codexSettings.model
    || 'gpt-5.2-codex';

  const effort = config.agents?.codex?.effort || config.agents?.codex?.reasoning || undefined;

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

export function resolveGoogleConfig(config: Config): GoogleResolved {
  const googleCfg = config.agents?.gemini;

  // CLI path: config → which gemini
  let cliPath = googleCfg?.cliPath || '';
  if (!cliPath) {
    cliPath = commandExists('gemini') ? 'gemini' : '';
  }

  // Model: config → default
  const model = googleCfg?.model || 'gemini-2.5-flash';

  // API key: config → env (optional, CLI has OAuth)
  const configApiKey = googleCfg?.apiKey;
  const isPlaceholder = !configApiKey || configApiKey.includes('your-') || configApiKey.includes('placeholder');
  const apiKey = (isPlaceholder ? undefined : configApiKey)
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || undefined;

  const mode = googleCfg?.mode || 'cli';
  const useVertex = googleCfg?.useVertex || false;
  const project = googleCfg?.project || process.env.GOOGLE_CLOUD_PROJECT || undefined;
  const location = googleCfg?.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

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
  const p = resolvePaths();
  const agentsDir = p.agentsDir;

  // 1. Try agent.json files first
  if (fs.existsSync(agentsDir)) {
    try {
      for (const file of fs.readdirSync(agentsDir)) {
        if (!file.endsWith('.json')) continue;
        const agentFile = path.join(agentsDir, file);
        let raw: any;
        try {
          raw = JSON.parse(fs.readFileSync(agentFile, 'utf-8'));
        } catch {
          // Parse error — skip silently (likely malformed user edit)
          continue;
        }
        if (writeOwnerToChannelInstance(raw, instanceName, userId)) {
          try {
            // M1: trailing newline; M2: log fs errors instead of swallowing
            fs.writeFileSync(agentFile, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
          } catch (e) {
            logger.error(`[setOwner] Failed to write ${agentFile}: ${e}`);
            throw e;
          }
          return;
        }
      }
    } catch (e) {
      logger.error(`[setOwner] Failed to scan ${agentsDir}: ${e}`);
    }
  }

  // 2. Fallback: write to evolclaw.json
  if (!config.channels) config.channels = {};

  if (writeOwnerToChannelInstance(config, instanceName, userId)) {
    saveConfig(config, configPath);
    return;
  }

  // 3. Last resort: if instanceName matches a channel type with no config, create it
  if (channelTypes.includes(instanceName as any)) {
    (config.channels as any)[instanceName] = { owner: userId };
    saveConfig(config, configPath);
    return;
  }

  // 4. I4: No match anywhere — warn (don't silently lose owner)
  logger.warn(`[setOwner] Channel instance "${instanceName}" not found in any agent.json or evolclaw.json. Owner ${userId} not persisted.`);
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
  // 检查 agent.json 中的 owner（agent-owned channels）
  return isOwnerInAgents(channelOrType, userId);
}

function isOwnerInAgents(channelOrType: string, userId: string): boolean {
  const agentsDir = resolvePaths().agentsDir;
  if (!fs.existsSync(agentsDir)) return false;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.json')) continue;
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf-8')); }
    catch { continue; }
    const channels = raw?.channels;
    if (!channels || typeof channels !== 'object') continue;
    for (const type of channelTypes) {
      const block = channels[type];
      if (block === undefined) continue;
      const instances = Array.isArray(block) ? block : [block];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        const instName = (inst as any).name ?? type;
        // Match by instance name OR by channel type
        if ((instName === channelOrType || type === channelOrType) && (inst as any).owner === userId) {
          return true;
        }
      }
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
  // 检查 agent.json 中的 admins
  return isAdminInAgents(channelOrType, userId);
}

function isAdminInAgents(channelOrType: string, userId: string): boolean {
  const agentsDir = resolvePaths().agentsDir;
  if (!fs.existsSync(agentsDir)) return false;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.json')) continue;
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(path.join(agentsDir, file), 'utf-8')); }
    catch { continue; }
    const channels = raw?.channels;
    if (!channels || typeof channels !== 'object') continue;
    for (const type of channelTypes) {
      const block = channels[type];
      if (block === undefined) continue;
      const instances = Array.isArray(block) ? block : [block];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        const instName = (inst as any).name ?? type;
        if (instName !== channelOrType && type !== channelOrType) continue;
        const admins: string[] = (inst as any).admins || [];
        if (admins.includes(userId)) return true;
      }
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

  // channels — 单通道时自动推断，无需显式 defaultChannel
  const defaultChannel = config.channels?.defaultChannel;
  if (!defaultChannel) {
    const channelKeys = channelTypes.filter(t => config.channels?.[t]);
    if (channelKeys.length === 0) {
      reasons.push('Missing channels.defaultChannel (no channels configured)');
    }
  } else {
    if (!config.channels?.[defaultChannel]) {
      reasons.push(`channels.defaultChannel='${defaultChannel}' but channels.${defaultChannel} does not exist`);
    }
  }

  // projects
  if (!config.projects?.defaultPath) {
    reasons.push('Missing projects.defaultPath');
  }

  return { valid: reasons.length === 0, reasons };
}
