import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeOwnerToChannelInstance, setOwner, loadConfig } from '../../src/config.js';
import { _resetRoot } from '../../src/paths.js';

describe('setOwner routing', () => {
  let tmpDir: string;
  let configPath: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-owner-'));
    configPath = path.join(tmpDir, 'data', 'evolclaw.json');
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeOwnerToChannelInstance', () => {
    it('sets owner on array-form channel instance by name', () => {
      const root = {
        channels: { feishu: [{ name: 'review-fs', appId: 'r', appSecret: 's' }] },
      };
      const result = writeOwnerToChannelInstance(root, 'review-fs', 'user-123');
      expect(result).toBe(true);
      expect(root.channels.feishu[0]).toHaveProperty('owner', 'user-123');
    });

    it('sets owner on single-object channel instance by name', () => {
      const root = {
        channels: { feishu: { name: 'my-feishu', appId: 'a', appSecret: 'b' } },
      };
      const result = writeOwnerToChannelInstance(root, 'my-feishu', 'user-456');
      expect(result).toBe(true);
      expect(root.channels.feishu).toHaveProperty('owner', 'user-456');
    });

    it('sets owner on single-object channel using type as default name', () => {
      const root = {
        channels: { wechat: { token: 'tok' } },
      };
      const result = writeOwnerToChannelInstance(root, 'wechat', 'user-789');
      expect(result).toBe(true);
      expect(root.channels.wechat).toHaveProperty('owner', 'user-789');
    });

    it('returns false when instance not found', () => {
      const root = {
        channels: { feishu: [{ name: 'other-fs', appId: 'x' }] },
      };
      const result = writeOwnerToChannelInstance(root, 'nonexistent', 'user-000');
      expect(result).toBe(false);
    });

    it('returns false when channels is missing', () => {
      expect(writeOwnerToChannelInstance({}, 'foo', 'u')).toBe(false);
      expect(writeOwnerToChannelInstance(null, 'foo', 'u')).toBe(false);
    });
  });

  describe('setOwner integration', () => {
    it('writes to agent.json when channel belongs to an agent', () => {
      // Write evolclaw.json with a default channel
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { defaultAgent: 'claude', claude: {} },
        channels: { feishu: [{ name: 'default-fs', appId: 'd', appSecret: 's' }] },
        projects: { defaultPath: tmpDir },
      }));

      // Write agent.json with its own channel
      const agentPath = path.join(agentsDir, 'review.json');
      fs.writeFileSync(agentPath, JSON.stringify({
        name: 'review',
        agents: { claude: {} },
        channels: { feishu: [{ name: 'review-fs', appId: 'r', appSecret: 's' }] },
        projects: { defaultPath: tmpDir },
      }));

      const origHome = process.env.EVOLCLAW_HOME;
      process.env.EVOLCLAW_HOME = tmpDir;
      _resetRoot();
      try {
        const config = loadConfig(configPath);
        setOwner(config, 'review-fs', 'user-123', configPath);

        // Verify agent.json was updated
        const agent = JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
        expect(agent.channels.feishu[0].owner).toBe('user-123');

        // Verify evolclaw.json was NOT updated
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(cfg.channels.feishu[0].owner).toBeUndefined();
      } finally {
        if (origHome !== undefined) process.env.EVOLCLAW_HOME = origHome;
        else delete process.env.EVOLCLAW_HOME;
        _resetRoot();
      }
    });

    it('writes to evolclaw.json for default channels', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { defaultAgent: 'claude', claude: {} },
        channels: { feishu: [{ name: 'default-fs', appId: 'd', appSecret: 's' }] },
        projects: { defaultPath: tmpDir },
      }));

      const origHome = process.env.EVOLCLAW_HOME;
      process.env.EVOLCLAW_HOME = tmpDir;
      _resetRoot();
      try {
        const config = loadConfig(configPath);
        setOwner(config, 'default-fs', 'user-456', configPath);

        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(cfg.channels.feishu[0].owner).toBe('user-456');
      } finally {
        if (origHome !== undefined) process.env.EVOLCLAW_HOME = origHome;
        else delete process.env.EVOLCLAW_HOME;
        _resetRoot();
      }
    });

    it('skips malformed agent.json files gracefully', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        agents: { defaultAgent: 'claude', claude: {} },
        channels: { feishu: [{ name: 'default-fs', appId: 'd', appSecret: 's' }] },
        projects: { defaultPath: tmpDir },
      }));

      // Write a malformed agent.json
      fs.writeFileSync(path.join(agentsDir, 'bad.json'), 'not valid json{{{');

      const origHome = process.env.EVOLCLAW_HOME;
      process.env.EVOLCLAW_HOME = tmpDir;
      _resetRoot();
      try {
        const config = loadConfig(configPath);
        // Should not throw, should fall through to evolclaw.json
        setOwner(config, 'default-fs', 'user-789', configPath);

        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(cfg.channels.feishu[0].owner).toBe('user-789');
      } finally {
        if (origHome !== undefined) process.env.EVOLCLAW_HOME = origHome;
        else delete process.env.EVOLCLAW_HOME;
        _resetRoot();
      }
    });
  });
});
