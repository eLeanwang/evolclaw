import { describe, it, expect } from 'vitest';
import { EvolAgent } from '../../src/core/evolagent.js';

describe('EvolAgent', () => {
  const baseConfig = {
    name: 'review-bot',
    enabled: true,
    agents: { claude: { model: 'opus', effort: 'high' } },
    channels: { feishu: [{ name: 'feishu-review', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/review' },
  };

  it('constructs from valid config', () => {
    const agent = new EvolAgent('/path/to/review-bot.json', baseConfig);
    expect(agent.name).toBe('review-bot');
    expect(agent.status).toBe('stopped');
    expect(agent.isDefault).toBe(false);
    expect(agent.baseagent).toBe('claude');
  });

  it('getContext returns correct defaults for agent-owned channel', () => {
    const agent = new EvolAgent('/path/review-bot.json', baseConfig);
    const ctx = agent.getContext('feishu-review', 'private');
    expect(ctx.name).toBe('review-bot');
    expect(ctx.isOwned).toBe(true);
    expect(ctx.baseagent).toBe('claude');
    expect(ctx.model).toBe('opus');
    expect(ctx.effort).toBe('high');
    expect(ctx.projectPath).toBe('/home/user/review');
    expect(ctx.chatMode).toBe('interactive');
  });

  it('resolves chatmode by chatType from agent config', () => {
    const config = { ...baseConfig, chatmode: { private: 'proactive' as const, group: 'interactive' as const } };
    const agent = new EvolAgent('/path/review.json', config);
    expect(agent.getContext('feishu-review', 'private').chatMode).toBe('proactive');
    expect(agent.getContext('feishu-review', 'group').chatMode).toBe('interactive');
  });

  it('falls back to global chatmode when agent chatmode absent', () => {
    const agent = new EvolAgent('/path/review.json', baseConfig);
    const globalChatmode = { private: 'interactive' as const, group: 'proactive' as const };
    expect(agent.getContext('feishu-review', 'group', globalChatmode).chatMode).toBe('proactive');
  });

  it('DefaultAgent flag exposed via isDefault', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(agent.isDefault).toBe(true);
    expect(agent.getContext('any', 'private').isOwned).toBe(false);
  });

  it('enabled: false reflected in status', () => {
    const agent = new EvolAgent('/path', { ...baseConfig, enabled: false });
    expect(agent.status).toBe('disabled');
  });

  it('lists channel instance names', () => {
    const agent = new EvolAgent('/path', baseConfig);
    expect(agent.channelInstanceNames()).toEqual(['feishu-review']);
  });

  it('handles object-form channel with default name', () => {
    const config = {
      ...baseConfig,
      channels: { aun: { aid: 'review.agentid.pub', owner: 'owner.agentid.pub' } },
    };
    const agent = new EvolAgent('/path', config);
    expect(agent.channelInstanceNames()).toEqual(['aun']);
  });

  it('handles multiple channel types', () => {
    const config = {
      ...baseConfig,
      channels: {
        feishu: [{ name: 'fs-1', appId: 'a', appSecret: 'b' }, { name: 'fs-2', appId: 'c', appSecret: 'd' }],
        aun: { aid: 'x.agentid.pub' },
      },
    };
    const agent = new EvolAgent('/path', config);
    expect(agent.channelInstanceNames().sort()).toEqual(['aun', 'fs-1', 'fs-2']);
  });
});
