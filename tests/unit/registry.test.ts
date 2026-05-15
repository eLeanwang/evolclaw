import { describe, it, expect } from 'vitest';
import { ChannelLoader } from '../../src/core/channel-loader.js';
import { AgentLoader } from '../../src/core/agent-loader.js';
import type { ChannelPlugin } from '../../src/core/channel-loader.js';
import type { AgentPlugin } from '../../src/core/agent-loader.js';

describe('ChannelLoader', () => {
  it('should register plugin and create enabled channels', async () => {
    const loader = new ChannelLoader();
    const mockPlugin: ChannelPlugin = {
      name: 'test',
      isEnabled: () => true,
      createChannel: async () => ({
        adapter: { channelName: 'test', sendText: async () => {} },
        channel: {},
        connect: async () => {},
        disconnect: async () => {},
      }),
    };

    loader.register(mockPlugin);
    const instances = await loader.createAll({} as any);

    expect(instances).toHaveLength(1);
    expect(instances[0].adapter.channelName).toBe('test');
  });

  it('should skip disabled plugins', async () => {
    const loader = new ChannelLoader();
    const mockPlugin: ChannelPlugin = {
      name: 'disabled',
      isEnabled: () => false,
      createChannel: async () => { throw new Error('should not be called'); },
    };

    loader.register(mockPlugin);
    const instances = await loader.createAll({} as any);

    expect(instances).toHaveLength(0);
  });

  it('should connect all instances', async () => {
    const loader = new ChannelLoader();
    let connected = false;
    const mockPlugin: ChannelPlugin = {
      name: 'test',
      isEnabled: () => true,
      createChannel: async () => ({
        adapter: { channelName: 'test', sendText: async () => {} },
        channel: {},
        connect: async () => { connected = true; },
        disconnect: async () => {},
      }),
    };

    loader.register(mockPlugin);
    const instances = await loader.createAll({} as any);
    const names = await loader.connectAll(instances);

    expect(connected).toBe(true);
    expect(names).toEqual(['test']);
  });
});

describe('AgentLoader', () => {
  // Minimal in-memory EvolAgent stub matching the parts AgentLoader reads
  function makeRegistryStub(agents: any[]) {
    return {
      get: (name: string) => agents.find(a => a.name === name) || null,
      runnableAgents: () => agents.filter(a => a.name !== '[default]'),
    } as any;
  }
  function makeAgent(name: string, baseagentDecls: Record<string, any> = { claude: {} }): any {
    return {
      name,
      isDefault: name === '[default]',
      config: { agents: baseagentDecls },
    };
  }

  it('should register plugin and create runners per (agent, baseagent)', () => {
    const loader = new AgentLoader();
    const created: string[] = [];
    const mockPlugin: AgentPlugin = {
      name: 'claude',
      isEnabled: (_g, agent) => !!agent.config.agents?.claude,
      createAgent: (_g, agent) => {
        created.push(agent.name);
        return { evolagentName: agent.name, baseagent: 'claude', agent: { name: 'r' } };
      },
    };

    loader.register(mockPlugin);
    const def = makeAgent('[default]');
    const review = makeAgent('review');
    const instances = loader.createAll({} as any, makeRegistryStub([def, review]), { onSessionIdUpdate: async () => {} });

    expect(instances).toHaveLength(2);
    expect(created).toEqual(['[default]', 'review']);
    expect(instances.map(i => `${i.evolagentName}::${i.baseagent}`)).toEqual([
      '[default]::claude',
      'review::claude',
    ]);
  });

  it('should skip plugins where isEnabled returns false', () => {
    const loader = new AgentLoader();
    const mockPlugin: AgentPlugin = {
      name: 'codex',
      isEnabled: () => false,
      createAgent: () => { throw new Error('should not be called'); },
    };

    loader.register(mockPlugin);
    const def = makeAgent('[default]');
    const instances = loader.createAll({} as any, makeRegistryStub([def]), { onSessionIdUpdate: async () => {} });

    expect(instances).toHaveLength(0);
  });

  it('should pass callbacks to createAgent', () => {
    const loader = new AgentLoader();
    let receivedCallbacks: any;
    const mockPlugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (_g, agent, callbacks) => {
        receivedCallbacks = callbacks;
        return { evolagentName: agent.name, baseagent: 'claude', agent: {} };
      },
    };

    const callbacks = { onSessionIdUpdate: async () => {} };
    loader.register(mockPlugin);
    loader.createAll({} as any, makeRegistryStub([makeAgent('[default]')]), callbacks);

    expect(receivedCallbacks).toBe(callbacks);
  });
});
