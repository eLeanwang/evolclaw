import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAnthropicConfig, resolveOpenaiConfig } from '../../src/config.js';
import type { Config } from '../../src/types.js';

/**
 * H2 fix: per-agent overrides (apiKey/baseUrl/model/effort) take precedence
 * over global config when resolving credentials.
 */

describe('resolveAnthropicConfig override priority', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses override apiKey when provided', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'global-key' } } } as any;
    const r = resolveAnthropicConfig(cfg, { apiKey: 'override-key' });
    expect(r.apiKey).toBe('override-key');
  });

  it('falls back to global apiKey when override is absent', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'global-key' } } } as any;
    const r = resolveAnthropicConfig(cfg);
    expect(r.apiKey).toBe('global-key');
  });

  it('falls back to env when override and global are placeholders', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-key';
    const cfg: Config = { agents: { claude: { apiKey: 'your-api-key' } } } as any;
    const r = resolveAnthropicConfig(cfg, { apiKey: 'placeholder-here' });
    expect(r.apiKey).toBe('env-key');
  });

  it('uses override baseUrl when provided', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'k', baseUrl: 'https://global/v1' } } } as any;
    const r = resolveAnthropicConfig(cfg, { baseUrl: 'https://review.proxy/v1' });
    expect(r.baseUrl).toBe('https://review.proxy/v1');
  });

  it('uses override model when provided', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'k', model: 'sonnet' } } } as any;
    const r = resolveAnthropicConfig(cfg, { model: 'opus' });
    expect(r.model).toBe('opus');
  });

  it('uses override effort when provided', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'k' } } } as any;
    const r = resolveAnthropicConfig(cfg, { effort: 'high' });
    expect(r.effort).toBe('high');
  });

  it('placeholder override does NOT win over real global', () => {
    const cfg: Config = { agents: { claude: { apiKey: 'global-real' } } } as any;
    const r = resolveAnthropicConfig(cfg, { apiKey: 'your-key-here' });
    expect(r.apiKey).toBe('global-real');
  });
});

describe('resolveOpenaiConfig override priority', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses override apiKey when provided', () => {
    const cfg: Config = { agents: { codex: { apiKey: 'global-key' } } } as any;
    const r = resolveOpenaiConfig(cfg, { apiKey: 'override-key' });
    expect(r.apiKey).toBe('override-key');
  });

  it('uses override model when provided', () => {
    const cfg: Config = { agents: { codex: { apiKey: 'k', model: 'gpt-5.2' } } } as any;
    const r = resolveOpenaiConfig(cfg, { model: 'gpt-5.2-codex' });
    expect(r.model).toBe('gpt-5.2-codex');
  });

  it('reasoning alias is honored in override', () => {
    const cfg: Config = { agents: { codex: { apiKey: 'k' } } } as any;
    const r = resolveOpenaiConfig(cfg, { reasoning: 'high' });
    expect(r.effort).toBe('high');
  });
});
