import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import type { Config } from '../../src/types.js';

describe('IPC evolagent handlers (via AgentRegistry)', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-ipc-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function globalConfig(): Config {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: {},
      projects: { defaultPath: '/tmp' },
    } as any;
  }

  it('list returns all agents including default', () => {
    fs.writeFileSync(path.join(agentsDir, 'bot.json'), JSON.stringify({
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp' },
    }));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    expect(list.length).toBeGreaterThanOrEqual(2); // bot + default
    expect(list.find(i => i.name === 'bot')).toBeDefined();
    expect(list.find(i => i.isDefault)).toBeDefined();
  });

  it('get returns specific agent', () => {
    fs.writeFileSync(path.join(agentsDir, 'bot.json'), JSON.stringify({
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp' },
    }));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    expect(reg.get('bot')?.name).toBe('bot');
    expect(reg.get('nonexistent')).toBeNull();
  });

  it('list includes agent metadata used by IPC handlers', () => {
    fs.writeFileSync(path.join(agentsDir, 'bot.json'), JSON.stringify({
      name: 'bot',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'bot-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp/bot' },
    }));

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll(globalConfig());

    const list = reg.list();
    const bot = list.find(i => i.name === 'bot');
    expect(bot).toBeDefined();
    expect(bot!.baseagent).toBe('claude');
    expect(bot!.channels).toContain('bot-feishu-bot-fs');
    expect(bot!.projectPath).toBe('/tmp/bot');
  });
});
