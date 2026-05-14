import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import type { Config } from '../../src/types.js';

describe('AgentRegistry', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-registry-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config, null, 2));
  }

  function baseConfig(name: string, appId: string) {
    return {
      name,
      agents: { claude: {} },
      channels: { feishu: [{ name: `${name}-fs`, appId, appSecret: 's' }] },
      projects: { defaultPath: '/home/user/p' },
    };
  }

  function globalConfig(): Config {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { feishu: [{ name: 'default-fs', appId: 'default-id', appSecret: 's' }] },
      projects: { defaultPath: '/home/user/default' },
    } as any;
  }

  it('loads valid agents from directory', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    writeAgent('scrum', baseConfig('scrum', 'app-scrum'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const names = list.map(i => i.name).sort();
    expect(names).toContain('review');
    expect(names).toContain('scrum');
    expect(names).toContain('[default]');
  });

  it('resolves by channel instance name', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const agent = reg.resolveByChannel('review-feishu-review-fs');
    expect(agent?.name).toBe('review');
    expect(agent?.isDefault).toBe(false);
  });

  it('resolves default channel to DefaultAgent', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const agent = reg.resolveByChannel('default-fs');
    expect(agent?.isDefault).toBe(true);
  });

  it('flags agents with fingerprint conflicts', () => {
    writeAgent('a', baseConfig('a', 'shared-app'));
    writeAgent('b', baseConfig('b', 'shared-app'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const a = list.find(i => i.name === 'a')!;
    const b = list.find(i => i.name === 'b')!;
    expect(a.status).toBe('error');
    expect(b.status).toBe('error');
    expect(a.error).toMatch(/conflict/i);
  });

  it('skips agents with invalid schema', () => {
    writeAgent('bad', { name: 'bad' });
    writeAgent('good', baseConfig('good', 'app-good'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const bad = list.find(i => i.name === 'bad');
    const good = list.find(i => i.name === 'good');
    expect(bad?.status).toBe('error');
    expect(good?.status).toBe('stopped');
  });

  it('disabled agents have status=disabled', () => {
    writeAgent('quiet', { ...baseConfig('quiet', 'app-quiet'), enabled: false });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const info = reg.list().find(i => i.name === 'quiet');
    expect(info?.status).toBe('disabled');
  });

  it('handles empty agents directory (only DefaultAgent)', () => {
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  it('handles missing agents directory gracefully', () => {
    const missingDir = path.join(tmpDir, 'nonexistent');
    const reg = new AgentRegistry(missingDir);
    expect(() => reg.loadAll(globalConfig())).not.toThrow();
    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  it('detects conflict between agent and default channel', () => {
    writeAgent('a', baseConfig('a', 'default-id'));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const a = reg.list().find(i => i.name === 'a');
    expect(a?.status).toBe('error');
  });

  it('get() returns agent by name', () => {
    writeAgent('review', baseConfig('review', 'app-review'));
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    expect(reg.get('review')?.name).toBe('review');
    expect(reg.get('[default]')?.isDefault).toBe(true);
    expect(reg.get('nonexistent')).toBeNull();
  });

  it('runnableAgents() returns only stopped agents', () => {
    writeAgent('active', baseConfig('active', 'app-active'));
    writeAgent('off', { ...baseConfig('off', 'app-off'), enabled: false });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const runnable = reg.runnableAgents();
    expect(runnable.map(a => a.name)).toContain('active');
    expect(runnable.map(a => a.name)).not.toContain('off');
  });

  describe('isOwner / isAdmin / setChannelOwner routing', () => {
    function configWithOwner(): Config {
      return {
        agents: { defaultAgent: 'claude', claude: {} },
        channels: {
          feishu: [{ name: 'default-fs', appId: 'default-id', appSecret: 's', owner: 'def-owner', admins: ['def-admin'] }],
        },
        projects: { defaultPath: '/home/user/default' },
      } as any;
    }

    it('isOwner routes to agent for agent-owned channel', () => {
      writeAgent('review', {
        ...baseConfig('review', 'app-review'),
        channels: { feishu: [{ name: 'review-fs', appId: 'app-review', appSecret: 's', owner: 'agent-owner' }] },
      });
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());

      const fallback = () => false;  // agent-owned channel must NOT hit fallback
      expect(reg.isOwner('review-feishu-review-fs', 'agent-owner', fallback)).toBe(true);
      expect(reg.isOwner('review-feishu-review-fs', 'def-owner', fallback)).toBe(false);
    });

    it('isOwner falls back for default channel', () => {
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());
      const cfg = configWithOwner();
      const fallback = (ch: string, uid: string) => {
        const inst = (cfg.channels as any).feishu.find((i: any) => i.name === ch);
        return inst?.owner === uid;
      };
      expect(reg.isOwner('default-fs', 'def-owner', fallback)).toBe(true);
      expect(reg.isOwner('default-fs', 'agent-owner', fallback)).toBe(false);
    });

    it('isAdmin includes owner for agent-owned', () => {
      writeAgent('rb', {
        ...baseConfig('rb', 'rb-app'),
        channels: { feishu: [{ name: 'rb-fs', appId: 'rb-app', appSecret: 's', owner: 'o', admins: ['adm'] }] },
      });
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());
      const fallback = () => false;
      expect(reg.isAdmin('rb-feishu-rb-fs', 'o', fallback)).toBe(true);
      expect(reg.isAdmin('rb-feishu-rb-fs', 'adm', fallback)).toBe(true);
      expect(reg.isAdmin('rb-feishu-rb-fs', 'other', fallback)).toBe(false);
    });

    it('setChannelOwner persists to agent.json for named agent', () => {
      writeAgent('rb', {
        ...baseConfig('rb', 'rb-app'),
        channels: { feishu: [{ name: 'rb-fs', appId: 'rb-app', appSecret: 's' }] },
      });
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());

      reg.setChannelOwner('rb-feishu-rb-fs', 'new-owner');

      const written = JSON.parse(fs.readFileSync(path.join(agentsDir, 'rb.json'), 'utf-8'));
      expect(written.channels.feishu[0].owner).toBe('new-owner');
    });

    it('setChannelOwner routes to globalWriter for default channel', () => {
      const calls: Array<[string, string]> = [];
      const reg = new AgentRegistry(agentsDir, {
        setOwner: (ch, uid) => calls.push([ch, uid]),
      });
      reg.loadAll(configWithOwner());

      reg.setChannelOwner('default-fs', 'global-owner');

      expect(calls).toEqual([['default-fs', 'global-owner']]);
    });

    it('setShowActivities persists to agent.json', () => {
      writeAgent('rb', {
        ...baseConfig('rb', 'rb-app'),
        channels: { feishu: [{ name: 'rb-fs', appId: 'rb-app', appSecret: 's' }] },
      });
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());

      reg.setShowActivities('rb-feishu-rb-fs', 'none');

      const written = JSON.parse(fs.readFileSync(path.join(agentsDir, 'rb.json'), 'utf-8'));
      expect(written.channels.feishu[0].showActivities).toBe('none');
    });

    it('getOwner returns agent owner for named-agent channel', () => {
      writeAgent('rb', {
        ...baseConfig('rb', 'rb-app'),
        channels: { feishu: [{ name: 'rb-fs', appId: 'rb-app', appSecret: 's', owner: 'rb-owner' }] },
      });
      const reg = new AgentRegistry(agentsDir);
      reg.loadAll(configWithOwner());

      expect(reg.getOwner('rb-feishu-rb-fs')).toBe('rb-owner');
      // Default channel is mirrored in DefaultAgent's config so getOwner works there too
      expect(reg.getOwner('default-fs')).toBe('def-owner');
      expect(reg.getOwner('nope')).toBeUndefined();
    });
  });
});
