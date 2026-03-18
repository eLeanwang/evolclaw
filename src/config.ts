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
}

function loadClaudeSettings(): { env?: Record<string, string>; model?: string } {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {}
  return {};
}

export function resolveAnthropicConfig(config: Config): AnthropicResolved {
  const settings = loadClaudeSettings();

  const apiKey = config.anthropic?.apiKey
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!apiKey) {
    throw new Error(
      'No API key found. Set one of: config.anthropic.apiKey, env ANTHROPIC_AUTH_TOKEN, or ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN'
    );
  }

  const baseUrl = config.anthropic?.baseUrl
    || process.env.ANTHROPIC_BASE_URL
    || settings.env?.ANTHROPIC_BASE_URL;

  const model = config.anthropic?.model
    || settings.model
    || 'sonnet';

  return { apiKey, baseUrl, model };
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

export function getOwner(config: Config, channel: 'feishu' | 'acp'): string | undefined {
  return config.owners?.[channel];
}

export function setOwner(config: Config, channel: 'feishu' | 'acp', userId: string, configPath: string = resolvePaths().config): void {
  if (!config.owners) {
    config.owners = {};
  }
  config.owners[channel] = userId;
  saveConfig(config, configPath);
}

export function isOwner(config: Config, channel: 'feishu' | 'acp', userId: string): boolean {
  return config.owners?.[channel] === userId;
}

function validateConfig(config: any): asserts config is Config {
  // anthropic 部分不再强制校验，由 resolveAnthropicConfig() 处理

  // Feishu 配置可选，但如果配置了就要完整
  if (config.feishu) {
    if (!config.feishu.appId || config.feishu.appId.startsWith('YOUR_')) {
      logger.warn('⚠ Feishu appId not configured (Feishu channel will be disabled)');
    }
    if (!config.feishu.appSecret || config.feishu.appSecret.startsWith('YOUR_')) {
      logger.warn('⚠ Feishu appSecret not configured (Feishu channel will be disabled)');
    }
  }

  if (!config.acp?.domain) throw new Error('Missing acp.domain');
  if (!config.acp?.agentName) throw new Error('Missing acp.agentName');
  if (!config.projects?.defaultPath) throw new Error('Missing projects.defaultPath');
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}
