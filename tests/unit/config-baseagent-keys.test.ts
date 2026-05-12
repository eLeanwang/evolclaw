import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { resolveAnthropicConfig, resolveOpenaiConfig, resolveGoogleConfig } from '../../src/config.js';

describe('baseagent key naming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads claude config from agents.claude', () => {
    const config = { agents: { claude: { model: 'opus', apiKey: 'sk-test-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } } } as any;
    const resolved = resolveAnthropicConfig(config);
    expect(resolved.model).toBe('opus');
  });

  it('reads codex config from agents.codex', () => {
    const config = { agents: { codex: { model: 'gpt-5', apiKey: 'sk-test-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } } } as any;
    const resolved = resolveOpenaiConfig(config);
    expect(resolved.model).toBe('gpt-5');
  });

  it('reads gemini config from agents.gemini', () => {
    const config = { agents: { gemini: { model: 'gemini-2.5-flash', apiKey: 'test-key' } } } as any;
    const resolved = resolveGoogleConfig(config);
    expect(resolved.model).toBe('gemini-2.5-flash');
  });

  it('ignores old agents.anthropic key (no fallback)', () => {
    const origToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    // Block settings.json fallback so the old key has nowhere to be rescued from
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).includes('settings.json')) return false;
      return fs.existsSync(p);
    });
    try {
      const config = { agents: { anthropic: { model: 'opus', apiKey: 'sk-old-key' } } } as any;
      // Old key is ignored — should throw due to missing API key
      expect(() => resolveAnthropicConfig(config)).toThrow();
    } finally {
      if (origToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = origToken;
    }
  });
});
