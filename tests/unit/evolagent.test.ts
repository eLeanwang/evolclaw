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
    const ctx = agent.getContext('review-bot-feishu-feishu-review', 'private');
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
    expect(agent.getContext('review-bot-feishu-feishu-review', 'private').chatMode).toBe('proactive');
    expect(agent.getContext('review-bot-feishu-feishu-review', 'group').chatMode).toBe('interactive');
  });

  it('falls back to global chatmode when agent chatmode absent', () => {
    const agent = new EvolAgent('/path/review.json', baseConfig);
    const globalChatmode = { private: 'interactive' as const, group: 'proactive' as const };
    expect(agent.getContext('review-bot-feishu-feishu-review', 'group', globalChatmode).chatMode).toBe('proactive');
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
    expect(agent.channelInstanceNames()).toEqual(['review-bot-feishu-feishu-review']);
  });

  it('handles object-form channel with default name', () => {
    const config = {
      ...baseConfig,
      channels: { aun: { aid: 'review.agentid.pub', owner: 'owner.agentid.pub' } },
    };
    const agent = new EvolAgent('/path', config);
    expect(agent.channelInstanceNames()).toEqual(['review-bot-aun']);
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
    expect(agent.channelInstanceNames().sort()).toEqual(['review-bot-aun', 'review-bot-feishu-fs-1', 'review-bot-feishu-fs-2']);
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
    expect(agent.findChannelInstance('review-bot-feishu-fs')).toBeTruthy();
    expect(agent.findChannelInstance('nope')).toBeNull();
  });

  it('findChannelInstance matches single-object form by channel-type key', () => {
    const agent = new EvolAgent('/p', {
      ...baseConfig,
      channels: { aun: { aid: 'x.agentid.pub', owner: 'u1' } },
    });
    expect(agent.findChannelInstance('review-bot-aun')).toBeTruthy();
  });

  it('getOwner returns the owner of the channel', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.getOwner('review-bot-feishu-fs')).toBe('user1');
    expect(agent.getOwner('nope')).toBeUndefined();
  });

  it('isOwner returns true for matching owner', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.isOwner('review-bot-feishu-fs', 'user1')).toBe(true);
    expect(agent.isOwner('review-bot-feishu-fs', 'user2')).toBe(false);
    expect(agent.isOwner('nope', 'user1')).toBe(false);
  });

  it('isAdmin includes owner and listed admins', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.isAdmin('review-bot-feishu-fs', 'user1')).toBe(true);  // owner is admin
    expect(agent.isAdmin('review-bot-feishu-fs', 'user2')).toBe(true);  // listed admin
    expect(agent.isAdmin('review-bot-feishu-fs', 'user3')).toBe(false); // unrelated
  });

  it('getShowActivities defaults to "all"', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.getShowActivities('review-bot-feishu-fs')).toBe('all');
  });

  it('getShowActivities reads instance value when set', () => {
    const agent = new EvolAgent('/p', {
      ...baseConfig,
      channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 's', showActivities: 'dm-only' }] },
    });
    expect(agent.getShowActivities('review-bot-feishu-fs')).toBe('dm-only');
  });

  it('setOwner persists to configPath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-owner-'));
    const file = path.join(tmp, 'review-bot.json');
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    agent.setOwner('review-bot-feishu-fs', 'newOwner');
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
    agent.setShowActivities('review-bot-feishu-fs', 'none');
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

describe('EvolAgent setBaseagentModel / setBaseagentEffort', () => {
  function makeTmpAgent(initialConfig: any) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-baseagent-'));
    const file = path.join(tmp, `${initialConfig.name}.json`);
    const cfg = JSON.parse(JSON.stringify(initialConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    return { tmp, file, agent };
  }

  const claudeConfig = {
    name: 'claude-bot',
    enabled: true,
    agents: { claude: { model: 'sonnet', effort: 'medium' } },
    channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/p' },
  };

  const codexConfig = {
    name: 'codex-bot',
    enabled: true,
    agents: { codex: { model: 'gpt-5', reasoning: 'high' } },
    channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/p' },
  };

  it('setBaseagentModel writes config.agents[baseagent].model and persists', () => {
    const { tmp, file, agent } = makeTmpAgent(claudeConfig);
    agent.setBaseagentModel('opus');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.agents.claude.model).toBe('opus');
    expect(agent.model).toBe('opus');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setBaseagentModel(undefined) deletes the model field and persists', () => {
    const { tmp, file, agent } = makeTmpAgent(claudeConfig);
    agent.setBaseagentModel(undefined);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.agents.claude.model).toBeUndefined();
    expect('model' in onDisk.agents.claude).toBe(false);
    expect(agent.model).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setBaseagentModel on DefaultAgent throws (no configPath)', () => {
    const agent = new EvolAgent(null, claudeConfig, { isDefault: true });
    expect(() => agent.setBaseagentModel('opus')).toThrow(/DefaultAgent/);
  });

  it('setBaseagentEffort on claude writes effort field', () => {
    const { tmp, file, agent } = makeTmpAgent(claudeConfig);
    agent.setBaseagentEffort('high');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.agents.claude.effort).toBe('high');
    expect(agent.effort).toBe('high');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setBaseagentEffort on codex writes reasoning field (alias)', () => {
    const { tmp, file, agent } = makeTmpAgent(codexConfig);
    agent.setBaseagentEffort('low');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.agents.codex.reasoning).toBe('low');
    // codex stores under 'reasoning', not 'effort'
    expect(onDisk.agents.codex.effort).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setBaseagentEffort(undefined) on claude deletes effort field', () => {
    const { tmp, file, agent } = makeTmpAgent(claudeConfig);
    agent.setBaseagentEffort(undefined);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect('effort' in onDisk.agents.claude).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setBaseagentEffort(undefined) on codex deletes reasoning field', () => {
    const { tmp, file, agent } = makeTmpAgent(codexConfig);
    agent.setBaseagentEffort(undefined);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect('reasoning' in onDisk.agents.codex).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('EvolAgent getProjects / addProject', () => {
  function makeTmpAgent(initialConfig: any) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-projects-'));
    const file = path.join(tmp, `${initialConfig.name}.json`);
    const cfg = JSON.parse(JSON.stringify(initialConfig));
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const agent = new EvolAgent(file, cfg);
    return { tmp, file, agent };
  }

  const baseConfig = {
    name: 'pbot',
    enabled: true,
    agents: { claude: {} },
    channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/review' },
  };

  it('getProjects returns projects.list when populated', () => {
    const cfg = { ...baseConfig, projects: { defaultPath: '/home/user/review', list: { alpha: '/home/u/a', beta: '/home/u/b' } } };
    const agent = new EvolAgent('/p/pbot.json', cfg);
    expect(agent.getProjects()).toEqual({ alpha: '/home/u/a', beta: '/home/u/b' });
  });

  it('getProjects falls back to single entry from defaultPath when list absent', () => {
    const agent = new EvolAgent('/p/pbot.json', baseConfig);
    // basename('/home/user/review') === 'review'
    expect(agent.getProjects()).toEqual({ review: '/home/user/review' });
  });

  it('getProjects falls back to single entry from defaultPath when list empty', () => {
    const cfg = { ...baseConfig, projects: { defaultPath: '/home/user/review', list: {} } };
    const agent = new EvolAgent('/p/pbot.json', cfg);
    expect(agent.getProjects()).toEqual({ review: '/home/user/review' });
  });

  it('addProject adds entry to projects.list and persists', () => {
    const { tmp, file, agent } = makeTmpAgent({
      ...baseConfig,
      projects: { defaultPath: '/home/user/review', list: { alpha: '/home/u/a' } },
    });
    agent.addProject('beta', '/home/u/b');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.projects.list).toEqual({ alpha: '/home/u/a', beta: '/home/u/b' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('addProject initializes projects.list when absent', () => {
    const { tmp, file, agent } = makeTmpAgent(baseConfig);
    agent.addProject('first', '/home/u/first');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.projects.list).toEqual({ first: '/home/u/first' });
    expect(onDisk.projects.defaultPath).toBe('/home/user/review'); // unchanged
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('addProject overwrites existing entry with same name', () => {
    const { tmp, file, agent } = makeTmpAgent({
      ...baseConfig,
      projects: { defaultPath: '/home/user/review', list: { alpha: '/home/u/old' } },
    });
    agent.addProject('alpha', '/home/u/new');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.projects.list.alpha).toBe('/home/u/new');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('EvolAgent effectiveChannelName', () => {
  const baseConfig = {
    name: 'review-bot',
    enabled: true,
    agents: { claude: {} },
    channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 'b' }] },
    projects: { defaultPath: '/home/user/p' },
  };

  it('DefaultAgent without rawName returns type', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(agent.effectiveChannelName('feishu', undefined)).toBe('feishu');
  });

  it('DefaultAgent with rawName returns rawName', () => {
    const agent = new EvolAgent(null, baseConfig, { isDefault: true });
    expect(agent.effectiveChannelName('feishu', 'feilun')).toBe('feilun');
  });

  it('EvolAgent without rawName returns ${name}-${type}', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.effectiveChannelName('aun', undefined)).toBe('review-bot-aun');
  });

  it('EvolAgent with rawName returns ${name}-${type}-${rawName}', () => {
    const agent = new EvolAgent('/p', baseConfig);
    expect(agent.effectiveChannelName('feishu', 'fs')).toBe('review-bot-feishu-fs');
  });
});
