import { describe, it, expect } from 'vitest';
import { resolveAnthropicConfig, resolveOpenaiConfig, resolveGoogleConfig } from '../../src/config.js';

describe('baseagent key naming', () => {
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
});
