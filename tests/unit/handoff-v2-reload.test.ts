import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReloadHooks } from '../../src/core/channel-loader.js';
import { EvolAgentRegistry, type ReloadHooks } from '../../src/core/evolagent-registry.js';
import { ensureAgentDirSkeleton, saveAgent } from '../../src/config-store.js';
import { _resetRoot, resolvePaths } from '../../src/paths.js';
import type { AgentConfig } from '../../src/types.js';

const roots: string[] = [];
const originalEvolclawHome = process.env.EVOLCLAW_HOME;
const originalAunHome = process.env.AUN_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalEvolclawHome === undefined) delete process.env.EVOLCLAW_HOME;
  else process.env.EVOLCLAW_HOME = originalEvolclawHome;
  if (originalAunHome === undefined) delete process.env.AUN_HOME;
  else process.env.AUN_HOME = originalAunHome;
  _resetRoot();
});

function makeHooks(overrides: { recover?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const handoffRuntime = {
    pauseAgent: vi.fn((aid: string) => { calls.push(`pause:${aid}`); }),
    drainAgent: vi.fn(async (aid: string, timeoutMs?: number) => { calls.push(`drain:${aid}:${timeoutMs}`); }),
    recover: vi.fn(async (aids: string[]) => {
      calls.push(`recover:${aids.join(',')}`);
      await overrides.recover?.();
    }),
    resumeAgent: vi.fn((aid: string) => { calls.push(`resume:${aid}`); }),
  };
  const hooks = buildReloadHooks({
    channelLoader: {} as any,
    channelInstances: [],
    registerChannelInstance: () => {},
    handoffRuntime,
    drainTimeoutMs: 1234,
  });
  return { hooks, handoffRuntime, calls };
}

describe('Handoff reload coordination', () => {
  it('pauses and drains before reload, then recovers before resume', async () => {
    const { hooks, calls } = makeHooks();

    await hooks.prepareHandoffReload?.('self.agentid.pub');
    await hooks.completeHandoffReload?.('self.agentid.pub');

    expect(calls).toEqual([
      'pause:self.agentid.pub',
      'drain:self.agentid.pub:1234',
      'recover:self.agentid.pub',
      'resume:self.agentid.pub',
    ]);
  });

  it('does not resume when recovery fails', async () => {
    const { hooks, handoffRuntime } = makeHooks({
      recover: async () => { throw new Error('recovery failed'); },
    });

    await hooks.prepareHandoffReload?.('self.agentid.pub');
    await expect(hooks.completeHandoffReload?.('self.agentid.pub')).rejects.toThrow('recovery failed');

    expect(handoffRuntime.resumeAgent).not.toHaveBeenCalled();
  });

  it('runs coordination around registry reload and leaves disabled agents paused', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-reload-'));
    roots.push(root);
    process.env.EVOLCLAW_HOME = root;
    process.env.AUN_HOME = path.join(root, '.aun');
    _resetRoot();
    const config: AgentConfig = {
      $schema_version: 2,
      aid: 'self.agentid.pub',
      enabled: true,
      channels: [],
      projects: { defaultPath: '/tmp' },
      active_baseagent: 'claude',
      baseagents: { claude: {} },
    };
    saveAgent(config);
    ensureAgentDirSkeleton(config.aid);
    const registry = new EvolAgentRegistry(resolvePaths().agentsDir);
    registry.loadAll();
    const calls: string[] = [];
    const hooks: ReloadHooks = {
      drainChannel: async () => {},
      disconnectChannel: async () => {},
      startChannel: async () => {},
      prepareHandoffReload: async aid => { calls.push(`prepare:${aid}`); },
      completeHandoffReload: async aid => { calls.push(`complete:${aid}`); },
    };

    await registry.reload(config.aid, hooks);
    expect(calls).toEqual(['prepare:self.agentid.pub', 'complete:self.agentid.pub']);

    const disconnectAfterTimeout = vi.fn(async () => {});
    await expect(registry.reload(config.aid, {
      drainChannel: async () => {},
      disconnectChannel: disconnectAfterTimeout,
      startChannel: async () => {},
      prepareHandoffReload: async () => { throw new Error('Handoff drain timeout'); },
    })).rejects.toThrow('Handoff drain timeout');
    expect(disconnectAfterTimeout).not.toHaveBeenCalled();

    calls.length = 0;
    saveAgent({ ...config, enabled: false });
    await registry.reload(config.aid, hooks);
    expect(calls).toEqual(['prepare:self.agentid.pub']);
    expect(registry.get(config.aid)?.status).toBe('disabled');
  });
});
