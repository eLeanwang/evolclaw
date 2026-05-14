import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { ChannelLoader, type ChannelPlugin, type ChannelInstance } from '../../src/core/channel-loader.js';
import type { Config } from '../../src/types.js';

describe('Startup flow integration', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-startup-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config));
  }

  function makeMockPlugin(
    channelType: string,
    instanceConfigs: Array<{ name: string; shouldConnect?: boolean }> = []
  ): ChannelPlugin {
    return {
      name: channelType,
      isEnabled: (config: any) => {
        const block = config.channels?.[channelType];
        if (!block) return false;
        const instances = Array.isArray(block) ? block : [block];
        return instances.length > 0;
      },
      async createChannel(config: any) {
        const block = config.channels?.[channelType];
        const instances = Array.isArray(block) ? block : [block];
        if (instances.length === 0) throw new Error('no instances');
        const inst = instances[0];
        const matchedConfig = instanceConfigs.find(ic => ic.name === inst.name);
        const shouldConnect = matchedConfig?.shouldConnect ?? true;
        return {
          channelType,
          adapter: { channelName: inst.name ?? channelType, sendText: vi.fn() } as any,
          channel: {} as any,
          connect: shouldConnect
            ? vi.fn().mockResolvedValue(undefined)
            : vi.fn().mockRejectedValue(new Error('connect failed')),
          disconnect: vi.fn().mockResolvedValue(undefined),
        };
      },
      async createChannels(config: any) {
        const block = config.channels?.[channelType];
        if (!block) return [];
        const instances = Array.isArray(block) ? block : [block];
        return Promise.all(
          instances.map(async (inst: any) => {
            const matchedConfig = instanceConfigs.find(ic => ic.name === inst.name);
            const shouldConnect = matchedConfig?.shouldConnect ?? true;
            return {
              channelType,
              adapter: { channelName: inst.name ?? channelType, sendText: vi.fn() } as any,
              channel: {} as any,
              connect: shouldConnect
                ? vi.fn().mockResolvedValue(undefined)
                : vi.fn().mockRejectedValue(new Error('connect failed')),
              disconnect: vi.fn().mockResolvedValue(undefined),
            };
          })
        );
      },
    };
  }

  function globalConfig(channelInstances: any[] = []): Config {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: channelInstances.length > 0 ? { feishu: channelInstances } : {},
      projects: { defaultPath: '/tmp' },
    } as any;
  }

  /**
   * Mirror index.ts startup orchestration in a testable form.
   */
  async function runStartup(globalCfg: Config, plugin: ChannelPlugin) {
    const channelLoader = new ChannelLoader();
    channelLoader.register(plugin);

    const registry = new AgentRegistry(agentsDir);
    registry.loadAll(globalCfg);

    // Default channels
    const defaultInstances = await channelLoader.createAll(globalCfg);

    // Per-agent channels — mirror production index.ts: rewrite channel
    // instance names with agent prefix before passing to plugin.
    const agentInstances: ChannelInstance[] = [];
    for (const agent of registry.runnableAgents()) {
      const rewrittenChannels: Record<string, any> = {};
      for (const [type, raw] of Object.entries(agent.config.channels || {})) {
        if (type === 'defaultChannel') { rewrittenChannels[type] = raw; continue; }
        const instances = Array.isArray(raw) ? raw : [raw];
        const rewritten = instances.map((inst: any) => {
          if (!inst || typeof inst !== 'object') return inst;
          const effName = agent.effectiveChannelName(type, inst.name);
          return { ...inst, name: effName };
        });
        rewrittenChannels[type] = Array.isArray(raw) ? rewritten : rewritten[0];
      }
      const agentConfig = {
        agents: agent.config.agents,
        channels: rewrittenChannels,
        projects: agent.config.projects,
      } as any;
      try {
        const instances = await channelLoader.createAll(agentConfig);
        agentInstances.push(...instances);
      } catch (e) {
        agent.status = 'error';
        agent.error = `Channel creation failed: ${e}`;
      }
    }

    const channelInstances = [...defaultInstances, ...agentInstances];
    const connected = await channelLoader.connectAll(channelInstances);
    const connectedSet = new Set(connected);

    // Bind adapters
    for (const inst of channelInstances) {
      const agent = registry.resolveByChannel(inst.adapter.channelName);
      if (!agent || agent.status === 'error') continue;
      agent.channels.set(inst.adapter.channelName, inst.adapter);
      if (agent.status === 'stopped' && connectedSet.has(inst.adapter.channelName)) {
        agent.status = 'running';
      }
    }

    return { registry, channelInstances, connected, connectedSet };
  }

  it('with no agent.json, only DefaultAgent loads', async () => {
    const plugin = makeMockPlugin('feishu', [{ name: 'default-fs' }]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry, channelInstances } = await runStartup(cfg, plugin);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
    expect(channelInstances).toHaveLength(1);
  });

  it('agent.json with valid channel: agent transitions to running', async () => {
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'b', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    const plugin = makeMockPlugin('feishu', [{ name: 'default-fs' }, { name: 'bot-feishu-bot-fs' }]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry } = await runStartup(cfg, plugin);

    const bot = registry.get('bot')!;
    expect(bot.status).toBe('running');
    expect(bot.channels.has('bot-feishu-bot-fs')).toBe(true);
  });

  it('agent.json with failing channel: agent stays stopped', async () => {
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'b', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    const plugin = makeMockPlugin('feishu', [
      { name: 'default-fs' },
      { name: 'bot-feishu-bot-fs', shouldConnect: false }, // simulated connect failure
    ]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry } = await runStartup(cfg, plugin);

    const bot = registry.get('bot')!;
    expect(bot.status).toBe('stopped'); // not running because connect failed
  });

  it('disabled agent: no channels created', async () => {
    writeAgent('off', {
      name: 'off',
      enabled: false,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'off-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp' },
    });
    const plugin = makeMockPlugin('feishu', [{ name: 'default-fs' }]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry, channelInstances } = await runStartup(cfg, plugin);

    expect(registry.get('off')!.status).toBe('disabled');
    // Only default channel created
    expect(channelInstances.length).toBe(1);
    expect(channelInstances[0].adapter.channelName).toBe('default-fs');
  });

  it('error agent (conflict with default): no channels for it, default still works', async () => {
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      // Same appId as default — fingerprint conflict
      channels: { feishu: [{ name: 'bot-fs', appId: 'd', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    const plugin = makeMockPlugin('feishu', [{ name: 'default-fs' }, { name: 'bot-fs' }]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry } = await runStartup(cfg, plugin);

    expect(registry.get('bot')!.status).toBe('error');
    expect(registry.get('bot')!.error).toMatch(/conflict/i);
    // Default channel still up
    const defaultAgent = registry.list().find(i => i.isDefault);
    expect(defaultAgent?.status).toBeDefined();
  });

  it('multiple agents in parallel: each gets only their own channels bound', async () => {
    writeAgent('alice', {
      name: 'alice',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'alice-fs', appId: 'a1', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    writeAgent('bob', {
      name: 'bob',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bob-fs', appId: 'b1', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    const plugin = makeMockPlugin('feishu', [
      { name: 'default-fs' },
      { name: 'alice-feishu-alice-fs' },
      { name: 'bob-feishu-bob-fs' },
    ]);
    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);

    const { registry, channelInstances } = await runStartup(cfg, plugin);

    expect(channelInstances).toHaveLength(3);
    expect(registry.get('alice')!.channels.has('alice-feishu-alice-fs')).toBe(true);
    expect(registry.get('alice')!.channels.has('bob-feishu-bob-fs')).toBe(false);
    expect(registry.get('bob')!.channels.has('bob-feishu-bob-fs')).toBe(true);
    expect(registry.get('bob')!.channels.has('alice-feishu-alice-fs')).toBe(false);
  });

  it('agent createAll fails internally: failing agent stays stopped, healthy agent runs', async () => {
    // ChannelLoader.createAll catches plugin errors internally (per channel-loader.ts),
    // so when a plugin throws for one agent's config, the loader logs and returns [].
    // Result: no channels bound to crashy → status stays 'stopped'.
    // Healthy agent's createAll succeeds normally → status transitions to 'running'.
    writeAgent('crashy', {
      name: 'crashy',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'crashy-fs', appId: 'c', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });
    writeAgent('healthy', {
      name: 'healthy',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'healthy-fs', appId: 'h', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });

    // Plugin that throws when creating crashy-fs but works for everything else
    const plugin: ChannelPlugin = {
      name: 'feishu',
      isEnabled: (config: any) => !!config.channels?.feishu,
      async createChannel(config: any) {
        const block = config.channels.feishu;
        const inst = Array.isArray(block) ? block[0] : block;
        if (inst.name === 'crashy-feishu-crashy-fs') throw new Error('boom');
        return {
          channelType: 'feishu',
          adapter: { channelName: inst.name, sendText: vi.fn() } as any,
          channel: {} as any,
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
        };
      },
      async createChannels(config: any) {
        const block = config.channels.feishu;
        const instances = Array.isArray(block) ? block : [block];
        return Promise.all(
          instances.map(async (inst: any) => {
            if (inst.name === 'crashy-feishu-crashy-fs') throw new Error('boom');
            return {
              channelType: 'feishu',
              adapter: { channelName: inst.name, sendText: vi.fn() } as any,
              channel: {} as any,
              connect: vi.fn().mockResolvedValue(undefined),
              disconnect: vi.fn().mockResolvedValue(undefined),
            };
          })
        );
      },
    };

    const cfg = globalConfig([{ name: 'default-fs', appId: 'd', appSecret: 's' }]);
    const { registry, channelInstances } = await runStartup(cfg, plugin);

    // crashy got no channels (loader swallowed the error) → stays stopped
    expect(registry.get('crashy')!.status).toBe('stopped');
    expect(registry.get('crashy')!.channels.size).toBe(0);
    // healthy proceeds normally
    expect(registry.get('healthy')!.status).toBe('running');
    expect(registry.get('healthy')!.channels.has('healthy-feishu-healthy-fs')).toBe(true);
    // default + healthy created (crashy did not)
    expect(channelInstances.map(i => i.adapter.channelName).sort()).toEqual([
      'default-fs',
      'healthy-feishu-healthy-fs',
    ]);
  });
});
