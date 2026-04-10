import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config } from './types.js';
import { logger } from './utils/logger.js';
import { resolvePaths, getPackageRoot as _getPackageRoot } from './paths.js';

// Re-export path utilities for backward compatibility
export { resolveRoot, resolvePaths, ensureDataDirs, getPackageRoot } from './paths.js';

export interface AnthropicResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
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
  const configApiKey = config.agents?.anthropic?.apiKey;
  const isPlaceholderKey = !configApiKey ||
    configApiKey.includes('your-') ||
    configApiKey.includes('placeholder');

  const apiKey = (isPlaceholderKey ? null : configApiKey)
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of: agents.anthropic.apiKey, env ANTHROPIC_AUTH_TOKEN, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN'
    );
  }

  // baseUrl 也过滤占位符
  const configBaseUrl = config.agents?.anthropic?.baseUrl;
  const isPlaceholderUrl = configBaseUrl?.includes('api.anthropic.com');

  const baseUrl = (isPlaceholderUrl ? null : configBaseUrl)
    || process.env.ANTHROPIC_BASE_URL
    || settings.env?.ANTHROPIC_BASE_URL;

  const model = config.agents?.anthropic?.model
    || settings.model
    || 'sonnet';

  const effort = config.agents?.anthropic?.effort
    || settings.effortLevel
    || undefined;

  return { apiKey, baseUrl, model, effort };
}

export interface OpenaiResolved {
  apiKey: string;
  baseUrl?: string;
  model: string;
  reasoning?: string;
}

export function resolveOpenaiConfig(config: Config): OpenaiResolved {
  const codexSettings = loadCodexSettings();

  // 过滤占位符，视为未配置
  const configApiKey = config.agents?.openai?.apiKey;
  const isPlaceholderKey = !configApiKey ||
    configApiKey.includes('your-') ||
    configApiKey.includes('placeholder');

  const apiKey = (isPlaceholderKey ? null : configApiKey)
    || process.env.OPENAI_API_KEY
    || codexSettings.apiKey;

  if (!apiKey) {
    throw new Error(
      'No OpenAI API key found. Set one of: agents.openai.apiKey, env OPENAI_API_KEY, or ~/.codex/auth.json'
    );
  }

  // baseUrl 也过滤占位符（与 anthropic 保持一致：只检查默认域名）
  const configBaseUrl = config.agents?.openai?.baseUrl;
  const isPlaceholderUrl = configBaseUrl?.includes('api.openai.com');

  const baseUrl = (isPlaceholderUrl ? null : configBaseUrl)
    || process.env.OPENAI_BASE_URL
    || codexSettings.baseUrl
    || undefined;

  const model = config.agents?.openai?.model
    || codexSettings.model
    || 'gpt-5.2-codex';

  const reasoning = config.agents?.openai?.reasoning || undefined;

  return { apiKey, baseUrl, model, reasoning };
}

// ── Hermes config ──

export interface HermesResolved {
  pythonPath: string;
  bridgePath: string;
  hermesProjectPath: string;  // hermes-agent 项目路径（传给 bridge 做 sys.path）
  model: string;
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}

function loadHermesSettings(): { apiKey?: string; baseUrl?: string; model?: string; provider?: string } {
  try {
    const envPath = path.join(os.homedir(), '.hermes', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const apiKeyMatch = content.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
      return { apiKey: apiKeyMatch?.[1]?.trim() };
    }
  } catch {}
  return {};
}

export function resolveHermesConfig(config: Config): HermesResolved {
  const hermesSettings = loadHermesSettings();
  const hermesCfg = config.agents?.hermes;

  // Hermes project path: from projects list or default
  const hermesProjectPath = config.projects?.list?.['hermes']
    || path.join(os.homedir(), 'projects', 'hermes-agent');

  // Python path: config → hermes project venv
  const pythonPath = hermesCfg?.pythonPath
    || path.join(hermesProjectPath, '.venv', 'bin', 'python');

  // Bridge path: config → evolclaw project's hermes/hermes_bridge.py
  const defaultBridgePath = path.join(_getPackageRoot(), 'hermes', 'hermes_bridge.py');
  const bridgePath = hermesCfg?.bridgePath || defaultBridgePath;

  // API key: config → env → ~/.hermes/.env
  const configApiKey = hermesCfg?.apiKey;
  const isPlaceholder = !configApiKey || configApiKey.includes('your-') || configApiKey.includes('placeholder');
  const apiKey = (isPlaceholder ? undefined : configApiKey)
    || process.env.HERMES_API_KEY
    || hermesSettings.apiKey
    || undefined;

  // Base URL
  const baseUrl = hermesCfg?.baseUrl
    || process.env.HERMES_BASE_URL
    || hermesSettings.baseUrl
    || undefined;

  const model = hermesCfg?.model || 'Claude-Sonnet-4.6';
  const provider = hermesCfg?.provider || hermesSettings.provider || 'custom';

  return { pythonPath, bridgePath, hermesProjectPath, model, provider, baseUrl, apiKey };
}

export function loadConfig(configPath: string = resolvePaths().config): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  validateConfig(config);
  return config;
}

export function saveConfig(config: Config, configPath: string = resolvePaths().config): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ── Channel instance normalization ──

export const channelTypes = ['feishu', 'wechat', 'aun'] as const;

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
    return cfg as (T & { name: string })[];
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

export function getOwner(config: Config, instanceName: string): string | undefined {
  for (const type of channelTypes) {
    const raw = (config.channels as any)?.[type];
    const instances = normalizeChannelInstances(raw, type);
    const found = instances.find((inst) => inst.name === instanceName);
    if (found) return (found as any).owner;
  }
  return undefined;
}

export function setOwner(config: Config, instanceName: string, userId: string, configPath: string = resolvePaths().config): void {
  if (!config.channels) config.channels = {};
  const channels = config.channels as any;

  for (const type of channelTypes) {
    const raw = channels[type];
    if (raw === undefined) continue;

    if (Array.isArray(raw)) {
      const inst = raw.find((item: any) => item.name === instanceName);
      if (inst) {
        inst.owner = userId;
        saveConfig(config, configPath);
        return;
      }
    } else {
      // Single-object form: match if name matches (or defaults to type name)
      const effectiveName = raw.name ?? type;
      if (effectiveName === instanceName) {
        raw.owner = userId;
        saveConfig(config, configPath);
        return;
      }
    }
  }

  // Fallback: if instanceName matches a channel type with no config, create it
  if (channelTypes.includes(instanceName as any)) {
    channels[instanceName] = { owner: userId };
    saveConfig(config, configPath);
    return;
  }
}

export function isOwner(config: Config, instanceName: string, userId: string): boolean {
  return getOwner(config, instanceName) === userId;
}

function validateConfig(config: any): asserts config is Config {
  // anthropic 部分不再强制校验，由 resolveAnthropicConfig() 处理

  // Feishu 配置可选，但如果配置了就要完整
  if (config.channels?.feishu) {
    if (!config.channels.feishu.appId || config.channels.feishu.appId.startsWith('YOUR_')) {
      logger.warn('⚠ Feishu appId not configured (Feishu channel will be disabled)');
    }
    if (!config.channels.feishu.appSecret || config.channels.feishu.appSecret.startsWith('YOUR_')) {
      logger.warn('⚠ Feishu appSecret not configured (Feishu channel will be disabled)');
    }
  }

  // AUN 配置可选，但如果配置了就要有 domain 和 agentName
  if (config.channels?.aun?.enabled !== false && config.channels?.aun) {
    if (!config.channels.aun.domain) {
      logger.warn('⚠ AUN domain not configured (AUN channel will be disabled)');
    }
    if (!config.channels.aun.agentName) {
      logger.warn('⚠ AUN agentName not configured (AUN channel will be disabled)');
    }
  }

  if (!config.projects?.defaultPath) throw new Error('Missing projects.defaultPath');

  // WeChat 配置可选，但如果启用了就需要 token
  if (config.channels?.wechat?.enabled && !config.channels?.wechat?.token) {
    logger.warn('⚠ WeChat enabled but token not configured (WeChat channel will be disabled)');
  }
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// agents.defaultAgent → config key 映射
const agentKeyMap: Record<string, string> = { claude: 'anthropic', codex: 'openai', hermes: 'hermes' };

/**
 * 配置结构完整性校验（不校验凭据有效性）。
 * 要求 agents/channels/projects 三段同时具备必要的锚点字段。
 */
export function validateConfigIntegrity(config: any): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // agents
  const defaultAgent = config.agents?.defaultAgent;
  if (!defaultAgent) {
    reasons.push('Missing agents.defaultAgent');
  } else {
    const key = agentKeyMap[defaultAgent] || defaultAgent;
    if (!config.agents?.[key]) {
      reasons.push(`agents.defaultAgent='${defaultAgent}' but agents.${key} does not exist`);
    }
  }

  // channels
  const defaultChannel = config.channels?.defaultChannel;
  if (!defaultChannel) {
    reasons.push('Missing channels.defaultChannel');
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
