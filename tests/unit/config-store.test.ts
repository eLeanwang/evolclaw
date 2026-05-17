import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadDefaults, saveDefaults, loadAgent, saveAgent, loadAllAgents,
  mergeForAgent, validateAgentConfig, ensureAgentDirSkeleton, expandEnvRefs,
} from '../../src/config-store.js';
import { _resetRoot } from '../../src/paths.js';
import type { AgentConfig, DefaultsConfig } from '../../src/types.js';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-cs-'));
  process.env.EVOLCLAW_HOME = root;
  _resetRoot();
  return root;
}

describe('config-store', () => {
  beforeEach(() => {
    setupHome();
  });

  describe('validateAgentConfig', () => {
    it('accepts a minimal valid config', () => {
      const c: AgentConfig = {
        $schema_version: 1,
        aid: 'alice.agentid.pub',
        channels: [{ type: 'aun', name: 'main' } as any],
      };
      expect(validateAgentConfig(c)).toEqual([]);
    });

    it('rejects invalid aid', () => {
      const c: AgentConfig = {
        $schema_version: 1,
        aid: 'bad',
        channels: [],
      };
      const errs = validateAgentConfig(c);
      expect(errs.some(e => /invalid aid/.test(e))).toBe(true);
    });

    it('rejects channels with empty / # name', () => {
      const c: AgentConfig = {
        $schema_version: 1,
        aid: 'alice.agentid.pub',
        channels: [{ type: 'feishu', name: 'has#bad', appId: '', appSecret: '' } as any],
      };
      const errs = validateAgentConfig(c);
      expect(errs.some(e => /name invalid/.test(e))).toBe(true);
    });

    it('rejects multiple AUN instances', () => {
      const c: AgentConfig = {
        $schema_version: 1,
        aid: 'alice.agentid.pub',
        channels: [
          { type: 'aun', name: 'main' } as any,
          { type: 'aun', name: 'second' } as any,
        ],
      };
      const errs = validateAgentConfig(c);
      expect(errs.some(e => /at most one channels.*'aun'/.test(e))).toBe(true);
    });

    it('rejects duplicate name within same type', () => {
      const c: AgentConfig = {
        $schema_version: 1,
        aid: 'alice.agentid.pub',
        channels: [
          { type: 'feishu', name: 'main', appId: '', appSecret: '' } as any,
          { type: 'feishu', name: 'main', appId: '', appSecret: '' } as any,
        ],
      };
      const errs = validateAgentConfig(c);
      expect(errs.some(e => /duplicate name/.test(e))).toBe(true);
    });
  });

  describe('mergeForAgent', () => {
    const agentBase: AgentConfig = {
      $schema_version: 1,
      aid: 'alice.agentid.pub',
      channels: [{ type: 'aun', name: 'main' } as any],
    };

    it('returns agent unchanged when defaults is null', () => {
      const m = mergeForAgent(agentBase, null);
      expect(m.aid).toBe('alice.agentid.pub');
    });

    it('deep-merges baseagents block', () => {
      const defaults: DefaultsConfig = {
        $schema_version: 1,
        baseagents: { claude: { apiKey: 'D-KEY', effort: 'high' } },
      };
      const agent: AgentConfig = {
        ...agentBase,
        baseagents: { claude: { apiKey: 'A-KEY' } },
      };
      const m = mergeForAgent(agent, defaults);
      expect(m.baseagents?.claude?.apiKey).toBe('A-KEY');     // per-agent override
      expect(m.baseagents?.claude?.effort).toBe('high');      // inherited from defaults
    });

    it('merges admins arrays with dedup', () => {
      const defaults: DefaultsConfig = { $schema_version: 1, admins: ['x.agentid.pub', 'y.agentid.pub'] };
      const agent: AgentConfig = { ...agentBase, admins: ['y.agentid.pub', 'z.agentid.pub'] };
      const m = mergeForAgent(agent, defaults);
      expect(m.admins?.sort()).toEqual(['x.agentid.pub', 'y.agentid.pub', 'z.agentid.pub']);
    });

    it('per-agent scalar overrides defaults', () => {
      const defaults: DefaultsConfig = { $schema_version: 1, flush_delay: 4 };
      const agent: AgentConfig = { ...agentBase, flush_delay: 1 };
      expect(mergeForAgent(agent, defaults).flush_delay).toBe(1);
    });

    it('owners is per-agent only — never inherited', () => {
      const defaults: any = { $schema_version: 1, owners: ['leak.agentid.pub'] };
      const agent: AgentConfig = { ...agentBase };
      const m = mergeForAgent(agent, defaults);
      expect(m.owners).toBeUndefined();
    });
  });

  describe('expandEnvRefs', () => {
    it('replaces $ENV:NAME with env value', () => {
      process.env.MY_TEST_KEY = 'secret';
      const o = expandEnvRefs({ apiKey: '$ENV:MY_TEST_KEY', plain: 'no' });
      expect(o).toEqual({ apiKey: 'secret', plain: 'no' });
      delete process.env.MY_TEST_KEY;
    });

    it('returns "" when env not set, and warns', () => {
      delete process.env.NEVER_SET_KEY;
      const o = expandEnvRefs({ apiKey: '$ENV:NEVER_SET_KEY' });
      expect(o).toEqual({ apiKey: '' });
    });

    it('walks arrays and nested objects', () => {
      process.env.X = 'X';
      const o = expandEnvRefs({ a: ['$ENV:X', { b: '$ENV:X' }] });
      expect(o).toEqual({ a: ['X', { b: 'X' }] });
      delete process.env.X;
    });
  });

  describe('save / load / loadAllAgents', () => {
    it('round-trips defaults via atomic write', () => {
      const d: DefaultsConfig = { $schema_version: 1, flush_delay: 7 };
      saveDefaults(d);
      expect(loadDefaults()?.flush_delay).toBe(7);
    });

    it('round-trips agent and creates dir skeleton', () => {
      const a: AgentConfig = {
        $schema_version: 1,
        aid: 'alice.agentid.pub',
        channels: [{ type: 'aun', name: 'main' } as any],
      };
      saveAgent(a);
      ensureAgentDirSkeleton(a.aid);
      const root = process.env.EVOLCLAW_HOME!;
      expect(fs.existsSync(path.join(root, 'agents/alice.agentid.pub/personal'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'agents/alice.agentid.pub/identities/contacts'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'agents/alice.agentid.pub/venues'))).toBe(true);
      expect(loadAgent('alice.agentid.pub')?.aid).toBe('alice.agentid.pub');
    });

    it('rejects loadAgent when on-disk aid != dir name', () => {
      const root = process.env.EVOLCLAW_HOME!;
      const dir = path.join(root, 'agents/alice.agentid.pub');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        $schema_version: 1,
        aid: 'imposter.agentid.pub',
        channels: [],
      }));
      expect(() => loadAgent('alice.agentid.pub')).toThrow(/aid field.*!=.*directory name/);
    });

    it('loadAllAgents skips invalid dirs with reasons', () => {
      const root = process.env.EVOLCLAW_HOME!;
      const agentsDir = path.join(root, 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });

      // valid
      fs.mkdirSync(path.join(agentsDir, 'alice.agentid.pub'));
      fs.writeFileSync(path.join(agentsDir, 'alice.agentid.pub/config.json'), JSON.stringify({
        $schema_version: 1, aid: 'alice.agentid.pub',
        channels: [{ type: 'aun', name: 'main' }],
      }));

      // bad name
      fs.mkdirSync(path.join(agentsDir, 'not-an-aid'));
      fs.writeFileSync(path.join(agentsDir, 'not-an-aid/config.json'), '{}');

      // missing config.json
      fs.mkdirSync(path.join(agentsDir, 'bob.agentid.pub'));

      const r = loadAllAgents();
      expect(r.agents.map(a => a.aid)).toEqual(['alice.agentid.pub']);
      expect(r.skipped.map(s => s.dirName).sort()).toEqual(['bob.agentid.pub', 'not-an-aid']);
    });
  });
});
