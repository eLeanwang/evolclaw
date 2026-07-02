/**
 * agentChannelUpsert 单元测试
 *
 * 覆盖：
 * - AUN type 拒绝
 * - 不在白名单的 type 拒绝
 * - 非法 channel name（含 #）拒绝
 * - agent 不存在 → 错误
 * - mode='add' + 不存在 → push
 * - mode='add' + 同 (type, name) 已存在 → 错误
 * - mode='overwrite' + 找不到 → 错误
 * - mode='overwrite' + 找到 → 替换
 * - daemon 未运行时 reloaded:false 但 ok:true
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { agentChannelUpsert } from '../../src/cli/agent.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';

describe('agentChannelUpsert', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-upsert-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    const agentsDir = resolvePaths().agentsDir;
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.EVOLCLAW_HOME;
    _resetRoot();
  });

  function writeAgentConfig(aid: string, channels: any[] = []): void {
    const dir = path.join(resolvePaths().agentsDir, aid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      $schema_version: 1,
      aid,
      enabled: true,
      initialized: false,
      owners: [],
      channels,
      active_baseagent: 'claude',
      baseagents: { claude: {} },
      projects: { defaultPath: tmpRoot },
    }));
  }

  it('rejects AUN channel type', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'aun', name: 'main', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/AUN/);
    }
  });

  it('rejects unsupported channel type', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'evil', name: 'main', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/Unsupported channel type/);
    }
  });

  it('rejects empty channel name', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: '', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/Invalid channel name/);
    }
  });

  it('rejects channel name containing #', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'bad#name', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
  });

  it('returns error when agent not found', async () => {
    const result = await agentChannelUpsert({
      aid: 'ghost.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/not found/);
    }
  });

  it('add mode appends a new channel instance', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(true);
    const cfgPath = path.join(resolvePaths().agentsDir, 'mybot.agentid.pub', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.channels).toHaveLength(1);
    expect(cfg.channels[0].type).toBe('feishu');
    expect(cfg.channels[0].appId).toBe('a');
  });

  it('add mode rejects duplicate (type, name)', async () => {
    writeAgentConfig('mybot.agentid.pub', [
      { type: 'feishu', name: 'main', appId: 'old', appSecret: 'old', enabled: true },
    ]);
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/already exists/);
    }
  });

  it('add mode allows different name for same type', async () => {
    writeAgentConfig('mybot.agentid.pub', [
      { type: 'feishu', name: 'main', appId: 'old', appSecret: 'old', enabled: true },
    ]);
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'backup', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(true);
    const cfgPath = path.join(resolvePaths().agentsDir, 'mybot.agentid.pub', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.channels).toHaveLength(2);
  });

  it('overwrite mode replaces existing channel', async () => {
    writeAgentConfig('mybot.agentid.pub', [
      { type: 'feishu', name: 'main', appId: 'old', appSecret: 'old', enabled: true },
    ]);
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'new', appSecret: 'new', enabled: true } as any,
      mode: 'overwrite',
    });
    expect(result.ok).toBe(true);
    const cfgPath = path.join(resolvePaths().agentsDir, 'mybot.agentid.pub', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.channels).toHaveLength(1);
    expect(cfg.channels[0].appId).toBe('new');
  });

  it('overwrite mode errors when (type, name) not found', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'overwrite',
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/not found/);
    }
  });

  it('returns reloaded:false when daemon not running', async () => {
    writeAgentConfig('mybot.agentid.pub');
    const result = await agentChannelUpsert({
      aid: 'mybot.agentid.pub',
      channel: { type: 'feishu', name: 'main', appId: 'a', appSecret: 'b', enabled: true } as any,
      mode: 'add',
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.reloaded).toBe(false);
      expect(result.channelKey).toBe('feishu#mybot.agentid.pub#main');
    }
  });
});
