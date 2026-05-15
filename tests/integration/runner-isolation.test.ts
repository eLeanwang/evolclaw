import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EvolAgentRegistry } from '../../src/core/evolagent-registry.js';
import { AgentLoader } from '../../src/core/agent-loader.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../../src/core/agent-loader.js';
import type { EvolAgent } from '../../src/core/evolagent.js';
import type { Config } from '../../src/types.js';

/**
 * Integration test: real EvolAgentRegistry + AgentLoader wiring.
 *
 * Verifies:
 * - Per-agent runner instances are created with correct composite keys
 * - DefaultAgent + EvolAgent runners are independent
 * - Credentials from agent.json override global config
 * - /model isolation: setModel on one runner doesn't affect another
 * - Interrupt routing via composite key
 */

function makeMockPlugin(name: string): AgentPlugin {
  return {
    name,
    isEnabled: (_g: Config, agent: EvolAgent) => !!agent.config.agents?.[name],
    createAgent: (globalConfig: Config, agent: EvolAgent, _callbacks: AgentCallbacks): AgentInstance | null => {
      const override = agent.config.agents?.[name] || {};
      const globalBlock = (globalConfig.agents as any)?.[name] || {};
      const merged = { ...globalBlock, ...override };
      const runner = {
        name,
        model: merged.model || 'default-model',
        apiKey: merged.apiKey || 'global-key',
        baseUrl: merged.baseUrl,
        effort: merged.effort,
        _setModelCalls: [] as string[],
        setModel(m: string) { this.model = m; this._setModelCalls.push(m); },
        getModel() { return this.model; },
        setEffort(e: string) { this.effort = e; },
        getEffort() { return this.effort; },
        hasActiveStream: vi.fn().mockReturnValue(false),
        interrupt: vi.fn(),
      };
      return { evolagentName: agent.name, baseagent: name, agent: runner };
    },
  };
}

describe('Integration: EvolAgentRegistry + AgentLoader runner isolation', () => {
  let tmpAgentsDir: string;

  beforeEach(() => {
    tmpAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolagent-integ-'));
  });

  afterEach(() => {
    fs.rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  function writeAgentJson(name: string, config: any) {
    fs.writeFileSync(path.join(tmpAgentsDir, `${name}.json`), JSON.stringify(config, null, 2));
  }

  it('creates independent runners for DefaultAgent and EvolAgent with same baseagent', () => {
    writeAgentJson('review', {
      name: 'review',
      enabled: true,
      agents: { claude: { model: 'opus', apiKey: 'review-key', baseUrl: 'https://review.proxy/v1' } },
      channels: { aun: [{ name: 'review-aun', aid: 'review.agentid.pub' }] },
      projects: { defaultPath: '/tmp/review' },
    });

    const globalConfig: Config = {
      agents: { defaultAgent: 'claude', claude: { model: 'sonnet', apiKey: 'global-key' } },
      channels: { aun: [{ name: 'main', aid: 'main.agentid.pub' }] },
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));

    const callbacks = { onSessionIdUpdate: async () => {} };
    const instances = loader.createAll(globalConfig, registry, callbacks);

    // Should have 2 runners: [default]::claude + review::claude
    expect(instances).toHaveLength(2);

    const agentMap = new Map<string, any>();
    for (const inst of instances) {
      agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);
    }

    const defaultRunner = agentMap.get('[default]::claude');
    const reviewRunner = agentMap.get('review::claude');

    expect(defaultRunner).toBeDefined();
    expect(reviewRunner).toBeDefined();
    expect(defaultRunner).not.toBe(reviewRunner);

    // Verify credentials isolation (H2)
    expect(defaultRunner.apiKey).toBe('global-key');
    expect(defaultRunner.model).toBe('sonnet');
    expect(reviewRunner.apiKey).toBe('review-key');
    expect(reviewRunner.model).toBe('opus');
    expect(reviewRunner.baseUrl).toBe('https://review.proxy/v1');
  });

  it('setModel on one runner does not affect the other (H1)', () => {
    writeAgentJson('writer', {
      name: 'writer',
      enabled: true,
      agents: { claude: { model: 'sonnet' } },
      channels: { aun: [{ name: 'writer-aun', aid: 'writer.agentid.pub' }] },
      projects: { defaultPath: '/tmp/writer' },
    });

    const globalConfig: Config = {
      agents: { defaultAgent: 'claude', claude: { model: 'sonnet' } },
      channels: { aun: [{ name: 'main', aid: 'main.agentid.pub' }] },
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));
    const instances = loader.createAll(globalConfig, registry, { onSessionIdUpdate: async () => {} });

    const agentMap = new Map<string, any>();
    for (const inst of instances) agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);

    const defaultRunner = agentMap.get('[default]::claude');
    const writerRunner = agentMap.get('writer::claude');

    // Both start at sonnet
    expect(defaultRunner.getModel()).toBe('sonnet');
    expect(writerRunner.getModel()).toBe('sonnet');

    // Writer switches to opus
    writerRunner.setModel('opus');
    expect(writerRunner.getModel()).toBe('opus');
    expect(defaultRunner.getModel()).toBe('sonnet'); // NOT affected
  });

  it('multiple baseagents on DefaultAgent all get runners', () => {
    const globalConfig: Config = {
      agents: {
        defaultAgent: 'claude',
        claude: { model: 'sonnet' },
        codex: { model: 'gpt-5.2' },
      },
      channels: {},
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));
    loader.register(makeMockPlugin('codex'));
    const instances = loader.createAll(globalConfig, registry, { onSessionIdUpdate: async () => {} });

    const keys = instances.map(i => `${i.evolagentName}::${i.baseagent}`).sort();
    expect(keys).toEqual(['[default]::claude', '[default]::codex']);
  });

  it('interrupt routes to correct runner via composite key', () => {
    writeAgentJson('review', {
      name: 'review',
      enabled: true,
      agents: { claude: {} },
      channels: { aun: [{ name: 'review-aun', aid: 'review.agentid.pub' }] },
      projects: { defaultPath: '/tmp/review' },
    });

    const globalConfig: Config = {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { aun: [{ name: 'main', aid: 'main.agentid.pub' }] },
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));
    const instances = loader.createAll(globalConfig, registry, { onSessionIdUpdate: async () => {} });

    const agentMap = new Map<string, any>();
    for (const inst of instances) agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);

    const defaultRunner = agentMap.get('[default]::claude');
    const reviewRunner = agentMap.get('review::claude');

    // Simulate interrupt targeting review agent
    reviewRunner.hasActiveStream.mockReturnValue(true);
    const key = 'review::claude';
    const runner = agentMap.get(key);
    if (runner?.hasActiveStream('session-123')) {
      runner.interrupt('session-123');
    }

    expect(reviewRunner.interrupt).toHaveBeenCalledWith('session-123');
    expect(defaultRunner.interrupt).not.toHaveBeenCalled();
  });

  it('disabled EvolAgent does not get a runner', () => {
    writeAgentJson('disabled-bot', {
      name: 'disabled-bot',
      enabled: false,
      agents: { claude: {} },
      channels: { aun: [{ name: 'disabled-aun', aid: 'disabled.agentid.pub' }] },
      projects: { defaultPath: '/tmp/disabled' },
    });

    const globalConfig: Config = {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: {},
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));
    const instances = loader.createAll(globalConfig, registry, { onSessionIdUpdate: async () => {} });

    // Only DefaultAgent runner, disabled-bot skipped
    expect(instances).toHaveLength(1);
    expect(instances[0].evolagentName).toBe('[default]');
  });

  it('error EvolAgent (invalid config) does not get a runner', () => {
    // Missing required fields → validation error → status='error' → not runnable
    writeAgentJson('broken', {
      name: 'broken',
      enabled: true,
      agents: {},  // no baseagent declared → validation error
      channels: { aun: [{ name: 'broken-aun', aid: 'broken.agentid.pub' }] },
      projects: { defaultPath: '/tmp/broken' },
    });

    const globalConfig: Config = {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: {},
      projects: { defaultPath: '/tmp/default' },
    } as any;

    const registry = new EvolAgentRegistry(tmpAgentsDir);
    registry.loadAll(globalConfig);

    const loader = new AgentLoader();
    loader.register(makeMockPlugin('claude'));
    const instances = loader.createAll(globalConfig, registry, { onSessionIdUpdate: async () => {} });

    // Only DefaultAgent runner
    expect(instances).toHaveLength(1);
    expect(instances[0].evolagentName).toBe('[default]');
  });
});
