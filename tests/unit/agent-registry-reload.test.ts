import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry, type ReloadHooks } from '../../src/core/agent-registry.js';

describe('AgentRegistry.reload', () => {
  let tmpDir: string;
  let agentsDir: string;
  let hooks: ReloadHooks;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-reload-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    hooks = {
      drainChannel: vi.fn().mockResolvedValue(undefined),
      disconnectChannel: vi.fn().mockResolvedValue(undefined),
      startChannel: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config));
  }

  function globalConfig(): any {
    return { agents: { defaultAgent: 'claude', claude: {} }, channels: {}, projects: { defaultPath: '/tmp' } };
  }

  it('reloads agent with updated model', async () => {
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: { model: 'sonnet' } },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Modify on disk
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: { model: 'opus' } },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    await reg.reload('bot', hooks);

    const agent = reg.get('bot')!;
    expect(agent.model).toBe('opus');
    expect(hooks.drainChannel).not.toHaveBeenCalled();
    expect(hooks.disconnectChannel).not.toHaveBeenCalled();
    expect(hooks.startChannel).not.toHaveBeenCalled();
  });

  it('detects kept channel with credential change and reconnects', async () => {
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'old-secret' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Change appSecret only — kept channel name, but credentials rotated
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'NEW-secret' }] },
      projects: { defaultPath: '/tmp' },
    });

    await reg.reload('bot', hooks);

    // Channel should have been drained, disconnected, and re-started
    expect(hooks.drainChannel).toHaveBeenCalledWith('bot-feishu-bot-fs');
    expect(hooks.disconnectChannel).toHaveBeenCalledWith('bot-feishu-bot-fs');
    expect(hooks.startChannel).toHaveBeenCalled();
  });

  it('keeps adapter when channel block unchanged (only model changed)', async () => {
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: { model: 'sonnet' } },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Change only model — channel block byte-identical
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: { model: 'opus' } },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });

    await reg.reload('bot', hooks);

    // No channel work — adapter transferred as-is
    expect(hooks.drainChannel).not.toHaveBeenCalled();
    expect(hooks.disconnectChannel).not.toHaveBeenCalled();
    expect(hooks.startChannel).not.toHaveBeenCalled();
  });

  it('drains and disconnects removed channels', async () => {
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: {
        feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }],
        aun: { aid: 'bot.agentid.pub' },
      },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Remove AUN channel
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    await reg.reload('bot', hooks);

    expect(hooks.drainChannel).toHaveBeenCalledWith('bot-aun');
    expect(hooks.disconnectChannel).toHaveBeenCalledWith('bot-aun');
  });

  it('starts new channels', async () => {
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Add AUN channel
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: {
        feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }],
        aun: { aid: 'new.agentid.pub' },
      },
      projects: { defaultPath: '/tmp' },
    });

    await reg.reload('bot', hooks);

    expect(hooks.startChannel).toHaveBeenCalled();
    const agent = reg.get('bot')!;
    expect(agent.channelInstanceNames()).toContain('bot-aun');
  });

  it('rejects reload with fingerprint conflict', async () => {
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });
    writeAgent('other', {
      name: 'other',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'other-fs', appId: 'c', appSecret: 'd' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Try to change bot's appId to conflict with other
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'c', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    await expect(reg.reload('bot', hooks)).rejects.toThrow(/conflict/i);
    // Original agent should be unchanged
    expect(reg.get('bot')!.channelInstanceNames()).toContain('bot-feishu-bot-fs');
  });

  it('rejects reload of nonexistent agent', async () => {
    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());
    await expect(reg.reload('ghost', hooks)).rejects.toThrow(/not found/i);
  });

  it('rejects reload with invalid config', async () => {
    writeAgent('bot', {
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Write invalid config (missing required fields)
    writeAgent('bot', { name: 'bot' });

    await expect(reg.reload('bot', hooks)).rejects.toThrow(/invalid/i);
  });

  it('rolls back when startChannel fails', async () => {
    // Setup: agent with channel A
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'a-fs', appId: 'a', appSecret: 's' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Sanity: original agent has only feishu, status not error
    const before = reg.get('bot')!;
    expect(before.channelInstanceNames()).toEqual(['bot-feishu-a-fs']);

    // Modify config: add channel aun
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: {
        feishu: [{ name: 'a-fs', appId: 'a', appSecret: 's' }],
        aun: { aid: 'new.agentid.pub' },
      },
      projects: { defaultPath: '/tmp' },
    });

    const failingHooks: ReloadHooks = {
      drainChannel: vi.fn().mockResolvedValue(undefined),
      disconnectChannel: vi.fn().mockResolvedValue(undefined),
      startChannel: vi.fn().mockRejectedValue(new Error('SDK timeout')),
    };

    await expect(reg.reload('bot', failingHooks)).rejects.toThrow(/SDK timeout/);

    // Verify: registry kept oldAgent — still has only feishu, not aun
    const after = reg.get('bot')!;
    expect(after.channelInstanceNames()).toEqual(['bot-feishu-a-fs']);
    // oldAgent is marked error after rollback
    expect(after.status).toBe('error');
    expect(after.error).toMatch(/SDK timeout/);
  });

  it('rolls back removed channels by re-starting them when add fails', async () => {
    // Setup: agent has channels A and B
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: {
        feishu: [{ name: 'a-fs', appId: 'a', appSecret: 's' }],
        aun: { aid: 'old.agentid.pub' },
      },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    // Modify: drop aun, add wechat (so aun gets removed, wechat startup will fail)
    writeAgent('bot', {
      name: 'bot',
      enabled: true,
      agents: { claude: {} },
      channels: {
        feishu: [{ name: 'a-fs', appId: 'a', appSecret: 's' }],
        wechat: { token: 'tok-new' },
      },
      projects: { defaultPath: '/tmp' },
    });

    const startCalls: string[] = [];
    const failingHooks: ReloadHooks = {
      drainChannel: vi.fn().mockResolvedValue(undefined),
      disconnectChannel: vi.fn().mockResolvedValue(undefined),
      startChannel: vi.fn().mockImplementation(async (_agent, ch: string) => {
        startCalls.push(ch);
        if (ch === 'bot-wechat') throw new Error('wechat start failed');
        // re-start of aun during rollback succeeds
      }),
    };

    await expect(reg.reload('bot', failingHooks)).rejects.toThrow(/wechat start failed/);

    // Rollback re-started 'aun' (the removed channel)
    expect(startCalls).toContain('bot-wechat');
    expect(startCalls).toContain('bot-aun');
  });
});
