import { describe, it, expect } from 'vitest';
import { validateEvolAgentConfig } from '../../src/core/evolagent-schema.js';

describe('validateEvolAgentConfig', () => {
  it('accepts a minimal valid config', () => {
    const config = {
      name: 'review-bot',
      agents: { claude: { model: 'sonnet' } },
      channels: { feishu: [{ name: 'feishu-review', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/home/user/review' },
    };
    const result = validateEvolAgentConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing name', () => {
    const result = validateEvolAgentConfig({
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/name/);
  });

  it('rejects multiple baseagent blocks', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {}, codex: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/single baseagent|exactly one/i);
  });

  it('rejects empty channels', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: {},
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/channel/);
  });

  it('rejects non-absolute projects.defaultPath', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: 'relative/path' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/absolute/);
  });

  it('accepts optional chatmode block', () => {
    const result = validateEvolAgentConfig({
      name: 'ok',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
      chatmode: { private: 'interactive', group: 'proactive' },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid chatmode values', () => {
    const result = validateEvolAgentConfig({
      name: 'bad',
      agents: { claude: {} },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
      chatmode: { private: 'weird' },
    });
    expect(result.valid).toBe(false);
  });

  it('accepts hermes baseagent', () => {
    const result = validateEvolAgentConfig({
      name: 'h',
      agents: { hermes: { model: 'mixtral' } },
      channels: { feishu: { appId: 'x', appSecret: 'y' } },
      projects: { defaultPath: '/x' },
    });
    expect(result.valid).toBe(true);
  });
});
