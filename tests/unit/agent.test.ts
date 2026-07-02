import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// IPC mock must be at module top-level (hoisted by Vitest)
vi.mock('../../src/ipc.js', () => ({
  ipcQuery: vi.fn().mockRejectedValue(new Error('daemon offline')),
}));

import {
  agentList, agentShow, agentGet, agentSet,
  agentEnable, agentDisable, agentDelete, agentRename,
  agentSyncAids, agentReload,
} from '../../src/cli/agent.js';
import { saveAgent, ensureAgentDirSkeleton } from '../../src/config-store.js';
import { ConfigTarget, write as cfgWrite } from '../../src/core/config/config-manager.js';
import { _resetRoot } from '../../src/paths.js';
import type { AgentConfig } from '../../src/types.js';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-agent-'));
  process.env.EVOLCLAW_HOME = root;
  process.env.AUN_HOME = path.join(root, '.aun');
  _resetRoot();
  return root;
}

function createTestAgent(aid: string, enabled = true): void {
  // 配置体系 v2：H 字段进 config.json，HA 字段（active_baseagent/baseagents）进 behavior.json。
  const config: AgentConfig = {
    $schema_version: 1,
    aid,
    enabled,
    channels: [],
    projects: { defaultPath: '/tmp/test' },
  };
  saveAgent(config);
  cfgWrite(ConfigTarget.AgentBehavior, { active_baseagent: 'claude', baseagents: { claude: {} } }, { self: aid });
  ensureAgentDirSkeleton(aid);
}

function createTestAgentMd(aid: string, name: string, description: string): void {
  const root = process.env.EVOLCLAW_HOME || path.join(os.homedir(), '.evolclaw');
  const aidDir = path.join(root, 'AIDs', aid);
  fs.mkdirSync(aidDir, { recursive: true });
  const content = `---
aid: "${aid}"
name: "${name}"
description: "${description}"
---
`;
  fs.writeFileSync(path.join(aidDir, 'agent.md'), content);
}

describe('agent module', () => {
  beforeEach(() => {
    setupHome();
  });

  describe('agentList', () => {
    it('returns empty list when no agents', async () => {
      const result = await agentList();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agents).toEqual([]);
      }
    });

    it('lists all agents', async () => {
      createTestAgent('alice.agentid.pub');
      createTestAgent('bob.agentid.pub', false);

      const result = await agentList();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.agents).toHaveLength(2);
        expect(result.agents.map(a => a.aid)).toContain('alice.agentid.pub');
        expect(result.agents.map(a => a.aid)).toContain('bob.agentid.pub');
      }
    });
  });

  describe('agentShow', () => {
    it('returns error for non-existent agent', async () => {
      const result = await agentShow('missing.agentid.pub');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/not found/);
      }
    });

    it('shows agent details', async () => {
      createTestAgent('alice.agentid.pub');
      createTestAgentMd('alice.agentid.pub', 'Alice', 'Test agent');

      const result = await agentShow('alice.agentid.pub');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.aid).toBe('alice.agentid.pub');
        expect(result.identity.name).toBe('Alice');
        expect(result.identity.description).toBe('Test agent');
        expect(result.config.baseagent).toBe('claude');
        expect(result.paths.config).toMatch(/alice\.agentid\.pub/);
        expect(result.paths.agent_md).toMatch(/alice\.agentid\.pub/);
      }
    });

    it('normalizes paths to forward slashes', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentShow('alice.agentid.pub');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths.config).not.toMatch(/\\/);
        expect(result.paths.agent_md).not.toMatch(/\\/);
        expect(result.paths.data).not.toMatch(/\\/);
      }
    });
  });

  describe('agentGet', () => {
    it('returns error for non-existent agent', async () => {
      const result = await agentGet('missing.agentid.pub', 'enabled');
      expect(result.ok).toBe(false);
    });

    it('gets top-level field', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentGet('alice.agentid.pub', 'enabled');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('gets nested field with dot path', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentGet('alice.agentid.pub', 'projects.defaultPath');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('/tmp/test');
      }
    });
  });

  describe('agentSet', () => {
    it('returns error for non-existent agent', async () => {
      const result = await agentSet('missing.agentid.pub', 'enabled', 'false');
      expect(result.ok).toBe(false);
    });

    it('sets boolean field', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentSet('alice.agentid.pub', 'enabled', 'false');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }

      const getResult = await agentGet('alice.agentid.pub', 'enabled');
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe(false);
      }
    });

    it('sets nested field with dot path', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentSet('alice.agentid.pub', 'projects.defaultPath', '/new/path');
      expect(result.ok).toBe(true);

      const getResult = await agentGet('alice.agentid.pub', 'projects.defaultPath');
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe('/new/path');
      }
    });
  });

  describe('agentEnable / agentDisable', () => {
    it('enables a disabled agent', async () => {
      createTestAgent('alice.agentid.pub', false);
      const result = await agentEnable('alice.agentid.pub');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.enabled).toBe(true);
      }
    });

    it('disables an enabled agent', async () => {
      createTestAgent('alice.agentid.pub', true);
      const result = await agentDisable('alice.agentid.pub');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.enabled).toBe(false);
      }

      const getResult = await agentGet('alice.agentid.pub', 'enabled');
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe(false);
      }
    });
  });

  describe('agentDelete', () => {
    it('deletes agent config (no purge)', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentDelete('alice.agentid.pub', false);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.purged).toBe(false);
      }

      const showResult = await agentShow('alice.agentid.pub');
      expect(showResult.ok).toBe(false);
    });

    it('purges agent directory with --purge', async () => {
      createTestAgent('alice.agentid.pub');
      const agentDir = path.join(process.env.EVOLCLAW_HOME!, 'agents', 'alice.agentid.pub');
      expect(fs.existsSync(agentDir)).toBe(true);

      const result = await agentDelete('alice.agentid.pub', true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.purged).toBe(true);
      }
      expect(fs.existsSync(agentDir)).toBe(false);
    });
  });

  describe('agentRename', () => {
    it('returns error if agent.md missing', async () => {
      createTestAgent('alice.agentid.pub');
      const result = await agentRename('alice.agentid.pub', 'NewName');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/agent\.md not found/);
      }
    });

    it('updates name in agent.md', async () => {
      createTestAgent('alice.agentid.pub');
      createTestAgentMd('alice.agentid.pub', 'OldName', 'Test');

      const result = await agentRename('alice.agentid.pub', 'NewName');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.name).toBe('NewName');
      }

      const showResult = await agentShow('alice.agentid.pub');
      expect(showResult.ok).toBe(true);
      if (showResult.ok) {
        expect(showResult.identity.name).toBe('NewName');
      }
    });
  });

  describe('agentSyncAids', () => {
    it('returns empty when no local AIDs', async () => {
      const result = await agentSyncAids();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.created).toEqual([]);
      }
    });
  });

  describe('agentReload', () => {
    it('returns error when daemon offline', async () => {
      const result = await agentReload();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/未运行/);
      }
    });
  });
});


