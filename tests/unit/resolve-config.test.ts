import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveAnthropicConfig } from '../../src/config.js';
import { Config } from '../../src/types.js';

// 保存原始环境变量
const originalEnv = { ...process.env };

function makeConfig(anthropic?: Config['anthropic']): Config {
  return {
    anthropic,
    feishu: { appId: 'test', appSecret: 'test' },
    aun: { domain: 'test', agentName: 'test' },
    projects: { defaultPath: '/tmp', autoCreate: false },
  };
}

describe('resolveAnthropicConfig', () => {
  beforeEach(() => {
    // 清理相关环境变量
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('should use config values when all provided', () => {
    const result = resolveAnthropicConfig(makeConfig({
      apiKey: 'config-key',
      baseUrl: 'https://config-url',
      model: 'haiku',
    }));

    expect(result.apiKey).toBe('config-key');
    expect(result.baseUrl).toBe('https://config-url');
    expect(result.model).toBe('haiku');
  });

  it('should fallback to env for apiKey', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-key';

    // Mock settings.json 不存在
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).includes('settings.json')) return false;
      return fs.existsSync(p);
    });

    const result = resolveAnthropicConfig(makeConfig());

    expect(result.apiKey).toBe('env-key');
  });

  it('should fallback to settings.json for apiKey', () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === settingsPath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (String(p) === settingsPath) {
        return JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'settings-key', ANTHROPIC_BASE_URL: 'https://settings-url' },
          model: 'opus',
        });
      }
      throw new Error('not found');
    });

    const result = resolveAnthropicConfig(makeConfig());

    expect(result.apiKey).toBe('settings-key');
    expect(result.baseUrl).toBe('https://settings-url');
    expect(result.model).toBe('opus');
  });

  it('should throw when no apiKey found anywhere', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).includes('settings.json')) return false;
      return false;
    });

    expect(() => resolveAnthropicConfig(makeConfig())).toThrow('No API key found');
  });

  it('should respect priority: config > env > settings', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-key';
    process.env.ANTHROPIC_BASE_URL = 'https://env-url';

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === settingsPath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (String(p) === settingsPath) {
        return JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'settings-key', ANTHROPIC_BASE_URL: 'https://settings-url' },
          model: 'haiku',
        });
      }
      throw new Error('not found');
    });

    // config 值应该优先
    const result = resolveAnthropicConfig(makeConfig({
      apiKey: 'config-key',
      baseUrl: 'https://config-url',
      model: 'sonnet',
    }));

    expect(result.apiKey).toBe('config-key');
    expect(result.baseUrl).toBe('https://config-url');
    expect(result.model).toBe('sonnet');
  });

  it('should fallback model to sonnet when nothing set', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'some-key';

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).includes('settings.json')) return false;
      return false;
    });

    const result = resolveAnthropicConfig(makeConfig());

    expect(result.model).toBe('sonnet');
  });

  it('should use settings.model when config.model not set', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'some-key';

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === settingsPath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (String(p) === settingsPath) {
        return JSON.stringify({ model: 'opus' });
      }
      throw new Error('not found');
    });

    const result = resolveAnthropicConfig(makeConfig());

    expect(result.model).toBe('opus');
  });

  it('should handle corrupted settings.json gracefully', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-key';

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === settingsPath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, _enc) => {
      if (String(p) === settingsPath) return '{invalid json';
      throw new Error('not found');
    });

    // 不应该抛错，应该 fallback 到 env
    const result = resolveAnthropicConfig(makeConfig());
    expect(result.apiKey).toBe('env-key');
    expect(result.model).toBe('sonnet');
  });

  it('should handle env fallback for baseUrl only', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env-url';

    const result = resolveAnthropicConfig(makeConfig({
      apiKey: 'config-key',
    }));

    expect(result.apiKey).toBe('config-key');
    expect(result.baseUrl).toBe('https://env-url');
  });
});
