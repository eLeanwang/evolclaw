import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentRegistry } from '../../src/core/agent-registry.js';

describe('CLI agent list (cold mode)', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-cli-agent-'));
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, config: any): void {
    fs.writeFileSync(path.join(agentsDir, `${name}.json`), JSON.stringify(config));
  }

  it('reads agents from disk and returns AgentInfo list', () => {
    writeAgent('review', {
      name: 'review',
      agents: { claude: { model: 'opus' } },
      channels: { feishu: [{ name: 'review-fs', appId: 'a', appSecret: 'b' }] },
      projects: { defaultPath: '/home/user/review' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll({
      agents: { defaultAgent: 'claude', claude: {} },
      channels: {},
      projects: { defaultPath: '/tmp' },
    } as any);

    const list = reg.list();
    const review = list.find(i => i.name === 'review');
    expect(review).toBeDefined();
    expect(review!.baseagent).toBe('claude');
    expect(review!.channels).toContain('review-fs');
  });

  it('shows disabled agents', () => {
    writeAgent('off', {
      name: 'off',
      enabled: false,
      agents: { claude: {} },
      channels: { feishu: [{ name: 'off-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp' },
    });

    const reg = new AgentRegistry(agentsDir);
    reg.loadAll({ agents: { defaultAgent: 'claude', claude: {} }, channels: {}, projects: { defaultPath: '/tmp' } } as any);

    const off = reg.list().find(i => i.name === 'off');
    expect(off?.status).toBe('disabled');
  });
});
