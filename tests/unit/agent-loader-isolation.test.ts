import { describe, it, expect } from 'vitest';
import { AgentLoader } from '../../src/core/agent-loader.js';
import type { AgentPlugin } from '../../src/core/agent-loader.js';

/**
 * H1 fix: each (EvolAgent × baseagent) combination must produce its own
 * runner instance, so per-agent runtime state (model/effort/permissionMode)
 * is fully isolated.
 *
 * H2 fix: per-agent overrides (apiKey/baseUrl/model) declared in agent.json
 * must be visible to the plugin when creating the runner.
 */

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

describe('AgentLoader per-EvolAgent isolation (H1)', () => {
  it('produces a separate runner instance per (agent, baseagent) pair', () => {
    const loader = new AgentLoader();
    let counter = 0;
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: (_g, agent) => !!agent.config.agents?.claude,
      createAgent: (_g, agent) => ({
        evolagentName: agent.name,
        baseagent: 'claude',
        agent: { id: ++counter, model: 'sonnet' },
      }),
    };
    loader.register(plugin);

    const def = makeAgent('[default]');
    const review = makeAgent('review');
    const writer = makeAgent('writer');
    const instances = loader.createAll({} as any, makeRegistryStub([def, review, writer]), { onSessionIdUpdate: async () => {} });

    expect(instances).toHaveLength(3);
    // Each runner is a distinct object (id increments)
    const ids = instances.map(i => i.agent.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('mutating one runner.model does not bleed into another', () => {
    const loader = new AgentLoader();
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (_g, agent) => {
        const runner: any = {
          model: 'sonnet',
          setModel(m: string) { this.model = m; },
          getModel() { return this.model; },
        };
        return { evolagentName: agent.name, baseagent: 'claude', agent: runner };
      },
    };
    loader.register(plugin);

    const instances = loader.createAll({} as any, makeRegistryStub([makeAgent('[default]'), makeAgent('review')]), { onSessionIdUpdate: async () => {} });
    const def = instances.find(i => i.evolagentName === '[default]')!.agent;
    const review = instances.find(i => i.evolagentName === 'review')!.agent;

    review.setModel('opus');
    expect(review.getModel()).toBe('opus');
    expect(def.getModel()).toBe('sonnet'); // not affected
  });

  it('skips plugins not declared in agent.config.agents', () => {
    const loader = new AgentLoader();
    const claudePlugin: AgentPlugin = {
      name: 'claude',
      isEnabled: (_g, agent) => !!agent.config.agents?.claude,
      createAgent: (_g, agent) => ({ evolagentName: agent.name, baseagent: 'claude', agent: {} }),
    };
    const codexPlugin: AgentPlugin = {
      name: 'codex',
      isEnabled: (_g, agent) => !!agent.config.agents?.codex,
      createAgent: (_g, agent) => ({ evolagentName: agent.name, baseagent: 'codex', agent: {} }),
    };
    loader.register(claudePlugin);
    loader.register(codexPlugin);

    const def = makeAgent('[default]', { claude: {} });
    const codexAgent = makeAgent('codexer', { codex: {} });
    const instances = loader.createAll({} as any, makeRegistryStub([def, codexAgent]), { onSessionIdUpdate: async () => {} });

    expect(instances).toHaveLength(2);
    expect(instances.find(i => i.evolagentName === '[default]')?.baseagent).toBe('claude');
    expect(instances.find(i => i.evolagentName === 'codexer')?.baseagent).toBe('codex');
  });

  it('DefaultAgent with multiple baseagents creates runners for all (R4 fix)', () => {
    const loader = new AgentLoader();
    const claudePlugin: AgentPlugin = {
      name: 'claude',
      isEnabled: (_g, agent) => !!agent.config.agents?.claude,
      createAgent: (_g, agent) => ({ evolagentName: agent.name, baseagent: 'claude', agent: { name: 'claude' } }),
    };
    const codexPlugin: AgentPlugin = {
      name: 'codex',
      isEnabled: (_g, agent) => !!agent.config.agents?.codex,
      createAgent: (_g, agent) => ({ evolagentName: agent.name, baseagent: 'codex', agent: { name: 'codex' } }),
    };
    loader.register(claudePlugin);
    loader.register(codexPlugin);

    // DefaultAgent declares both claude and codex
    const def = makeAgent('[default]', { claude: { model: 'sonnet' }, codex: { model: 'gpt-5.2' } });
    const instances = loader.createAll({} as any, makeRegistryStub([def]), { onSessionIdUpdate: async () => {} });

    expect(instances).toHaveLength(2);
    expect(instances.map(i => `${i.evolagentName}::${i.baseagent}`).sort()).toEqual([
      '[default]::claude',
      '[default]::codex',
    ]);
  });

  it('handles plugin.createAgent returning null gracefully', () => {
    const loader = new AgentLoader();
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: () => null,
    };
    loader.register(plugin);

    const instances = loader.createAll({} as any, makeRegistryStub([makeAgent('[default]')]), { onSessionIdUpdate: async () => {} });
    expect(instances).toHaveLength(0);
  });

  it('handles plugin.createAgent throwing without crashing other agents', () => {
    const loader = new AgentLoader();
    let callCount = 0;
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (_g, agent) => {
        callCount++;
        if (agent.name === 'broken') throw new Error('bad config');
        return { evolagentName: agent.name, baseagent: 'claude', agent: {} };
      },
    };
    loader.register(plugin);

    const instances = loader.createAll(
      {} as any,
      makeRegistryStub([makeAgent('[default]'), makeAgent('broken'), makeAgent('good')]),
      { onSessionIdUpdate: async () => {} }
    );

    expect(callCount).toBe(3);
    expect(instances).toHaveLength(2); // default + good, broken skipped
    expect(instances.map(i => i.evolagentName).sort()).toEqual(['[default]', 'good']);
  });

  it('empty registry produces no runners', () => {
    const loader = new AgentLoader();
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (_g, agent) => ({ evolagentName: agent.name, baseagent: 'claude', agent: {} }),
    };
    loader.register(plugin);

    const instances = loader.createAll({} as any, makeRegistryStub([]), { onSessionIdUpdate: async () => {} });
    expect(instances).toHaveLength(0);
  });
});

describe('AgentLoader per-EvolAgent credentials (H2)', () => {
  it('passes per-agent override into createAgent so plugin can use it', () => {
    const loader = new AgentLoader();
    const seenOverrides: Array<{ name: string; apiKey?: string; baseUrl?: string }> = [];
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (_g, agent) => {
        const block = agent.config.agents?.claude || {};
        seenOverrides.push({ name: agent.name, apiKey: block.apiKey, baseUrl: block.baseUrl });
        return { evolagentName: agent.name, baseagent: 'claude', agent: {} };
      },
    };
    loader.register(plugin);

    const def = makeAgent('[default]', { claude: { apiKey: 'global-key' } });
    const review = makeAgent('review', { claude: { apiKey: 'review-key', baseUrl: 'https://review.proxy/v1' } });
    loader.createAll({} as any, makeRegistryStub([def, review]), { onSessionIdUpdate: async () => {} });

    expect(seenOverrides).toEqual([
      { name: '[default]', apiKey: 'global-key', baseUrl: undefined },
      { name: 'review', apiKey: 'review-key', baseUrl: 'https://review.proxy/v1' },
    ]);
  });

  it('per-agent config fields (useSettingSources etc) are visible via merged config (R6 fix)', () => {
    const loader = new AgentLoader();
    const seenConfigs: Array<{ name: string; useSettingSources?: boolean }> = [];
    const plugin: AgentPlugin = {
      name: 'claude',
      isEnabled: () => true,
      createAgent: (globalConfig, agent) => {
        // Simulate what ClaudeAgentPlugin does: merge override into globalConfig
        const override = agent.config.agents?.claude || {};
        const merged = {
          ...globalConfig,
          agents: { ...(globalConfig.agents || {}), claude: { ...(globalConfig.agents?.claude || {}), ...override } },
        };
        seenConfigs.push({ name: agent.name, useSettingSources: (merged as any).agents.claude.useSettingSources });
        return { evolagentName: agent.name, baseagent: 'claude', agent: {} };
      },
    };
    loader.register(plugin);

    const globalConfig = { agents: { claude: { useSettingSources: true } } } as any;
    const def = makeAgent('[default]', { claude: { useSettingSources: true } });
    const review = makeAgent('review', { claude: { useSettingSources: false } });
    loader.createAll(globalConfig, makeRegistryStub([def, review]), { onSessionIdUpdate: async () => {} });

    expect(seenConfigs).toEqual([
      { name: '[default]', useSettingSources: true },
      { name: 'review', useSettingSources: false },
    ]);
  });
});
