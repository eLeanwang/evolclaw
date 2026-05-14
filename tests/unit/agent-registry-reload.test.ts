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

    expect(hooks.drainChannel).toHaveBeenCalledWith('aun');
    expect(hooks.disconnectChannel).toHaveBeenCalledWith('aun');
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
    expect(agent.channelInstanceNames()).toContain('aun');
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
    expect(reg.get('bot')!.channelInstanceNames()).toContain('bot-fs');
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
});
