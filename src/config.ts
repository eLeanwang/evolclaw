import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config } from './types.js';
import { logger } from './utils/logger.js';
import { resolvePaths } from './paths.js';

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

export function getOwner(config: Config, channel: string): string | undefined {
  const ch = (config.channels as any)?.[channel];
  return ch?.owner;
}

export function setOwner(config: Config, channel: string, userId: string, configPath: string = resolvePaths().config): void {
  if (!config.channels) config.channels = {};
  const channels = config.channels as any;
  if (!channels[channel]) channels[channel] = {};
  channels[channel].owner = userId;
  saveConfig(config, configPath);
}

export function isOwner(config: Config, channel: string, userId: string): boolean {
  return getOwner(config, channel) === userId;
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
const agentKeyMap: Record<string, string> = { claude: 'anthropic', codex: 'openai' };

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
