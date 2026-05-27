import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvolAgentRegistry, type ReloadHooks } from '../../src/core/evolagent-registry.js';
import { EvolAgent } from '../../src/core/evolagent.js';
import type { AgentConfig, MergedAgentConfig } from '../../src/types.js';

// Mock config-store — reload() calls loadAgent/loadDefaults/mergeForAgent/validateAgentConfig
vi.mock('../../src/config-store.js', () => ({
  loadDefaults: vi.fn(() => ({ $schema_version: 1, channels: [] })),
  loadAllAgents: vi.fn(() => ({ agents: [], skipped: [] })),
  loadAgent: vi.fn(),
  mergeForAgent: vi.fn((raw: any) => ({ ...raw })),
  validateAgentConfig: vi.fn(() => []),
  ensureAgentDirSkeleton: vi.fn(),
  saveAgent: vi.fn(),
}));

import { loadAgent, loadDefaults, mergeForAgent, validateAgentConfig } from '../../src/config-store.js';

const AID = 'test-agent.agentid.pub';

function makeRawConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    $schema_version: 1,
    aid: AID,
    enabled: true,
    channels: [],
    ...overrides,
  } as AgentConfig;
}

function makeMergedConfig(overrides: Partial<MergedAgentConfig> = {}): MergedAgentConfig {
  return {
    $schema_version: 1,
    aid: AID,
    enabled: true,
    channels: [],
    ...overrides,
  } as MergedAgentConfig;
}

function makeHooks(): ReloadHooks & {
  drainCalls: string[];
  disconnectCalls: string[];
  startCalls: string[];
} {
  const hooks = {
    drainCalls: [] as string[],
    disconnectCalls: [] as string[],
    startCalls: [] as string[],
    drainChannel: vi.fn(async (ch: string) => { hooks.drainCalls.push(ch); }),
    disconnectChannel: vi.fn(async (ch: string) => { hooks.disconnectCalls.push(ch); }),
    startChannel: vi.fn(async (_agent: any, ch: string) => { hooks.startCalls.push(ch); }),
  };
  return hooks;
}

/**
 * Helper: inject a pre-built EvolAgent into the registry's private agents map.
 * This avoids going through loadAll() which requires full config-store mocking.
 */
function injectAgent(registry: EvolAgentRegistry, agent: EvolAgent): void {
  (registry as any).agents.set(agent.aid, agent);
  // Rebuild channel index
  (registry as any).channelIndex.clear();
  (registry as any).buildChannelIndex();
}

describe('EvolAgentRegistry.reload() — state transitions', () => {
  let registry: EvolAgentRegistry;
  let hooks: ReturnType<typeof makeHooks>;

  beforeEach(() => {
    registry = new EvolAgentRegistry('/tmp/test-agents');
    hooks = makeHooks();
    vi.mocked(loadDefaults).mockReturnValue({ $schema_version: 1, channels: [] } as any);
    vi.mocked(validateAgentConfig).mockReturnValue([]);
  });

  afterEach(() => {
    delete (globalThis as any).__evolclaw_hotLoadAgent;
    vi.clearAllMocks();
  });

  // ── disabled → enabled ──────────────────────────────────────────────

  describe('disabled → enabled transition', () => {
    it('calls __evolclaw_hotLoadAgent and removes old agent from registry', async () => {
      // Setup: agent is disabled in registry
      const raw = makeRawConfig({ enabled: false });
      const merged = makeMergedConfig({ enabled: false });
      const agent = new EvolAgent(raw, merged);
      expect(agent.status).toBe('disabled');
      injectAgent(registry, agent);

      // Disk config now has enabled: true (user edited it)
      const newRaw = makeRawConfig({ enabled: true });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: true }));

      // Setup hotLoad handler
      let hotLoadCalledWith: string | null = null;
      (globalThis as any).__evolclaw_hotLoadAgent = async (aid: string) => {
        hotLoadCalledWith = aid;
        // Simulate what hotLoad does: loadNewAgent + connect
        const newAgent = new EvolAgent(newRaw, makeMergedConfig({ enabled: true }));
        newAgent.status = 'running';
        (registry as any).agents.set(aid, newAgent);
      };

      await registry.reload(AID, hooks);

      expect(hotLoadCalledWith).toBe(AID);
      // Agent should now be in registry with running status
      const reloaded = registry.get(AID);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.status).toBe('running');
    });

    it('throws if __evolclaw_hotLoadAgent is not initialized', async () => {
      const raw = makeRawConfig({ enabled: false });
      const merged = makeMergedConfig({ enabled: false });
      const agent = new EvolAgent(raw, merged);
      injectAgent(registry, agent);

      const newRaw = makeRawConfig({ enabled: true });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: true }));

      // No hotLoad handler set
      await expect(registry.reload(AID, hooks)).rejects.toThrow('hot-load handler not initialized');
    });

    it('does not call drain/disconnect hooks (disabled agent has no active channels)', async () => {
      const raw = makeRawConfig({ enabled: false });
      const merged = makeMergedConfig({ enabled: false });
      const agent = new EvolAgent(raw, merged);
      injectAgent(registry, agent);

      const newRaw = makeRawConfig({ enabled: true });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: true }));

      (globalThis as any).__evolclaw_hotLoadAgent = async () => {
        const newAgent = new EvolAgent(newRaw, makeMergedConfig({ enabled: true }));
        newAgent.status = 'running';
        (registry as any).agents.set(AID, newAgent);
      };

      await registry.reload(AID, hooks);

      expect(hooks.drainCalls).toHaveLength(0);
      expect(hooks.disconnectCalls).toHaveLength(0);
    });
  });

  // ── enabled → disabled ──────────────────────────────────────────────

  describe('enabled → disabled transition', () => {
    it('disconnects all channels and sets status to disabled', async () => {
      const raw = makeRawConfig({ enabled: true });
      const merged = makeMergedConfig({ enabled: true });
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      // Disk config now has enabled: false
      const newRaw = makeRawConfig({ enabled: false });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: false }));

      await registry.reload(AID, hooks);

      const result = registry.get(AID);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('disabled');
      // AUN channel is implicit — should have been drained/disconnected
      expect(hooks.drainCalls.length).toBeGreaterThan(0);
      expect(hooks.disconnectCalls.length).toBeGreaterThan(0);
    });

    it('removes agent from channel index after disabling', async () => {
      const raw = makeRawConfig({ enabled: true });
      const merged = makeMergedConfig({ enabled: true });
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      const aunKey = `aun#${AID}#main`;
      // Verify it's in the index before
      expect(registry.resolveByChannel(aunKey)).not.toBeNull();

      const newRaw = makeRawConfig({ enabled: false });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: false }));

      await registry.reload(AID, hooks);

      // After disabling, channel should not be routable
      expect(registry.resolveByChannel(aunKey)).toBeNull();
    });

    it('tolerates drain/disconnect errors gracefully', async () => {
      const raw = makeRawConfig({ enabled: true });
      const merged = makeMergedConfig({ enabled: true });
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      const newRaw = makeRawConfig({ enabled: false });
      vi.mocked(loadAgent).mockReturnValue(newRaw);
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: false }));

      // Make hooks throw
      hooks.drainChannel.mockRejectedValue(new Error('drain failed'));
      hooks.disconnectChannel.mockRejectedValue(new Error('disconnect failed'));

      // Should not throw
      await registry.reload(AID, hooks);
      expect(registry.get(AID)!.status).toBe('disabled');
    });
  });

  // ── Normal reload (enabled → enabled) ──────────────────────────────

  describe('normal reload (no state transition)', () => {
    it('sets status to running after successful reload', async () => {
      const raw = makeRawConfig({ enabled: true });
      const merged = makeMergedConfig({ enabled: true });
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      // Same config, no changes
      vi.mocked(loadAgent).mockReturnValue(makeRawConfig({ enabled: true }));
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: true }));

      await registry.reload(AID, hooks);

      expect(registry.get(AID)!.status).toBe('running');
    });

    it('does not call hotLoad for enabled → enabled reload', async () => {
      const raw = makeRawConfig({ enabled: true });
      const merged = makeMergedConfig({ enabled: true });
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      vi.mocked(loadAgent).mockReturnValue(makeRawConfig({ enabled: true }));
      vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ enabled: true }));

      let hotLoadCalled = false;
      (globalThis as any).__evolclaw_hotLoadAgent = async () => { hotLoadCalled = true; };

      await registry.reload(AID, hooks);

      expect(hotLoadCalled).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('throws if agent not found', async () => {
      await expect(registry.reload('nonexistent.agentid.pub', hooks))
        .rejects.toThrow('not found');
    });

    it('throws if config.json missing on disk', async () => {
      const raw = makeRawConfig();
      const merged = makeMergedConfig();
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      vi.mocked(loadAgent).mockReturnValue(null as any);

      await expect(registry.reload(AID, hooks))
        .rejects.toThrow('config.json missing');
    });

    it('throws if config validation fails', async () => {
      const raw = makeRawConfig();
      const merged = makeMergedConfig();
      const agent = new EvolAgent(raw, merged);
      agent.status = 'running';
      injectAgent(registry, agent);

      vi.mocked(loadAgent).mockReturnValue(makeRawConfig());
      vi.mocked(validateAgentConfig).mockReturnValue(['aid is required']);

      await expect(registry.reload(AID, hooks))
        .rejects.toThrow('Invalid config');
    });
  });
});

describe('EvolAgentRegistry.loadNewAgent() — conflict detection', () => {
  let registry: EvolAgentRegistry;

  beforeEach(() => {
    registry = new EvolAgentRegistry('/tmp/test-agents');
    vi.mocked(loadDefaults).mockReturnValue({ $schema_version: 1, channels: [] } as any);
    vi.mocked(validateAgentConfig).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads a new agent successfully when no conflicts', () => {
    const newAid = 'new-agent.agentid.pub';
    const newRaw = makeRawConfig({ aid: newAid, channels: [] });
    vi.mocked(loadAgent).mockReturnValue(newRaw);
    vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({ aid: newAid, channels: [] }));

    const result = registry.loadNewAgent(newAid);

    expect(result).not.toBeNull();
    expect(result!.aid).toBe(newAid);
    expect(registry.get(newAid)).not.toBeNull();
  });

  it('returns existing agent if already loaded', () => {
    const raw = makeRawConfig();
    const merged = makeMergedConfig();
    const agent = new EvolAgent(raw, merged);
    agent.status = 'running';
    injectAgent(registry, agent);

    const result = registry.loadNewAgent(AID);

    expect(result).toBe(agent);
  });

  it('returns null if config.json not found', () => {
    vi.mocked(loadAgent).mockReturnValue(null as any);

    const result = registry.loadNewAgent('missing.agentid.pub');

    expect(result).toBeNull();
  });

  it('returns null if validation fails', () => {
    vi.mocked(loadAgent).mockReturnValue(makeRawConfig({ aid: 'bad.agentid.pub' }));
    vi.mocked(validateAgentConfig).mockReturnValue(['missing required field']);

    const result = registry.loadNewAgent('bad.agentid.pub');

    expect(result).toBeNull();
  });

  it('returns null when channel fingerprint conflicts with existing agent', () => {
    // Setup: existing agent with feishu channel using appId "app123"
    const existingRaw = makeRawConfig({
      aid: 'existing.agentid.pub',
      channels: [{ type: 'feishu', name: 'main', appId: 'app123', appSecret: 'secret', enabled: true }] as any,
    });
    const existingMerged = makeMergedConfig({
      aid: 'existing.agentid.pub',
      channels: [{ type: 'feishu', name: 'main', appId: 'app123', appSecret: 'secret', enabled: true }] as any,
    });
    const existingAgent = new EvolAgent(existingRaw, existingMerged);
    existingAgent.status = 'running';
    injectAgent(registry, existingAgent);

    // New agent tries to use the same feishu appId
    const conflictAid = 'conflict.agentid.pub';
    const conflictRaw = makeRawConfig({
      aid: conflictAid,
      channels: [{ type: 'feishu', name: 'main', appId: 'app123', appSecret: 'other', enabled: true }] as any,
    });
    vi.mocked(loadAgent).mockReturnValue(conflictRaw);
    vi.mocked(validateAgentConfig).mockReturnValue([]);

    const result = registry.loadNewAgent(conflictAid);

    expect(result).toBeNull();
    expect(registry.get(conflictAid)).toBeNull();
  });

  it('allows loading when fingerprints do not conflict', () => {
    // Existing agent with feishu appId "app123"
    const existingRaw = makeRawConfig({
      aid: 'existing.agentid.pub',
      channels: [{ type: 'feishu', name: 'main', appId: 'app123', appSecret: 'secret', enabled: true }] as any,
    });
    const existingMerged = makeMergedConfig({
      aid: 'existing.agentid.pub',
      channels: [{ type: 'feishu', name: 'main', appId: 'app123', appSecret: 'secret', enabled: true }] as any,
    });
    const existingAgent = new EvolAgent(existingRaw, existingMerged);
    existingAgent.status = 'running';
    injectAgent(registry, existingAgent);

    // New agent uses a different feishu appId
    const newAid = 'new.agentid.pub';
    const newRaw = makeRawConfig({
      aid: newAid,
      channels: [{ type: 'feishu', name: 'main', appId: 'app456', appSecret: 'other', enabled: true }] as any,
    });
    vi.mocked(loadAgent).mockReturnValue(newRaw);
    vi.mocked(mergeForAgent).mockReturnValue(makeMergedConfig({
      aid: newAid,
      channels: [{ type: 'feishu', name: 'main', appId: 'app456', appSecret: 'other', enabled: true }] as any,
    }));

    const result = registry.loadNewAgent(newAid);

    expect(result).not.toBeNull();
    expect(result!.aid).toBe(newAid);
  });
});
