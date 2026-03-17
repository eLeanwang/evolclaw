import fs from 'fs';
import path from 'path';
import { Config } from './types.js';
import { logger } from './utils/logger.js';

export function loadConfig(configPath: string = './data/config.json'): Config {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);

  validateConfig(config);
  return config;
}

export function saveConfig(config: Config, configPath: string = './data/config.json'): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function getOwner(config: Config, channel: 'feishu' | 'acp'): string | undefined {
  return config.owners?.[channel];
}

export function setOwner(config: Config, channel: 'feishu' | 'acp', userId: string, configPath: string = './data/config.json'): void {
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
  if (!config.anthropic?.apiKey) throw new Error('Missing anthropic.apiKey');

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
