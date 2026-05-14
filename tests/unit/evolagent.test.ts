import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

describe('EvolAgent owner/admin/showActivities', () => {
  const baseConfig = {
    name: 'review-bot',
    enabled: true,
    agents: { claude: {} },
    channels: {
      feishu: [{ name: 'fs', appId: 'a', appSecret: 's', owner: 'user1', admins: ['user2'] }],
    },
    projects: { defaultPath: '/tmp' },
  };

  it('findChannelInstance matches by explicit name', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.findChannelInstance('fs')).toBeTruthy();
    expect(agent.findChannelInstance('nope')).toBeNull();
  });

  it('findChannelInstance matches single-object form by channel-type key', () => {
    const agent = new EvolAgent('/p', {
      ...baseConfig,
      channels: { aun: { aid: 'x.agentid.pub', owner: 'u1' } },
    });
    expect(agent.findChannelInstance('aun')).toBeTruthy();
  });

  it('getOwner returns the owner of the channel', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.getOwner('fs')).toBe('user1');
    expect(agent.getOwner('nope')).toBeUndefined();
  });

  it('isOwner returns true for matching owner', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.isOwner('fs', 'user1')).toBe(true);
    expect(agent.isOwner('fs', 'user2')).toBe(false);
    expect(agent.isOwner('nope', 'user1')).toBe(false);
  });

  it('isAdmin includes owner and listed admins', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.isAdmin('fs', 'user1')).toBe(true);  // owner is admin
    expect(agent.isAdmin('fs', 'user2')).toBe(true);  // listed admin
    expect(agent.isAdmin('fs', 'user3')).toBe(false); // unrelated
  });

  it('getShowActivities defaults to "all"', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.getShowActivities('fs')).toBe('all');
  });

  it('getShowActivities reads instance value when set', () => {
    const agent = new EvolAgent('/p', {
      ...baseConfig,
      channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 's', showActivities: 'dm-only' }] },
    });
    expect(agent.getShowActivities('fs')).toBe('dm-only');
  });

  it('setOwner persists to configPath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-owner-'));
    const file = path.join(tmp, 'review-bot.json');
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    agent.setOwner('fs', 'newOwner');
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written.channels.feishu[0].owner).toBe('newOwner');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setShowActivities persists to configPath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-sa-'));
    const file = path.join(tmp, 'review-bot.json');
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    agent.setShowActivities('fs', 'none');
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written.channels.feishu[0].showActivities).toBe('none');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setOwner on DefaultAgent throws (no configPath)', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(() => agent.setOwner('fs', 'u1')).toThrow(/DefaultAgent/);
  });

  it('setShowActivities on DefaultAgent throws', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(() => agent.setShowActivities('fs', 'none')).toThrow(/DefaultAgent/);
  });

  it('setOwner with unknown channel name is a no-op (no persist)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-noop-'));
    const file = path.join(tmp, 'review-bot.json');
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    const beforeMtime = fs.statSync(file).mtimeMs;
    agent.setOwner('does-not-exist', 'whoever');
    // File should be unchanged
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after).toEqual(cfg);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
