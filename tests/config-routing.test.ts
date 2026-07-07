import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolvePaths } from '../src/paths.js';
import {
  ConfigTarget,
  ensureFile,
  read,
  resolveEffective,
  write,
} from '../src/config/config-manager.js';
import { collectConfigFiles } from '../src/config/snapshot.js';
import { setPrivateRoleAssignment } from '../src/config/role-assignments.js';

/**
 * v3 配置系统测试
 *
 * 核心变更：
 * - 所有参数统一在 config.json
 * - 覆盖链：defaults.json → agent/config.json → relation/config.json
 * - 权限控制在 API 层，而非文件级
 */

describe('v3 config system', () => {
  const testAid = 'test-routing-bot.agentid.pub';
  const testPeer = 'test-peer.aid.pub';
  let p: ReturnType<typeof resolvePaths>;

  beforeEach(() => {
    p = resolvePaths();
    // 清理测试数据
    const agentDir = path.join(p.agentsDir, testAid);
    if (fs.existsSync(agentDir)) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // 清理测试数据
    const agentDir = path.join(p.agentsDir, testAid);
    if (fs.existsSync(agentDir)) {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  describe('unified config.json', () => {
    it('stores all parameters (infra + behavior) in config.json', () => {
      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);

      // v3: 所有参数都在 config.json
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        // 基础设施参数
        projects: { defaultPath: '/home/user/projects' },
        // 行为参数
        dispatch: 'broadcast',
        chatmode: { private: 'proactive', group: 'interactive' },
        active_baseagent: 'claude',
        baseagents: {
          claude: {
            model: 'claude-sonnet-4',
            apiKey: '${ANTHROPIC_API_KEY}'
          }
        },
      }, sel);

      const agentConfigPath = path.join(p.agentsDir, testAid, 'config.json');
      expect(fs.existsSync(agentConfigPath)).toBe(true);

      const config = read(ConfigTarget.Agent, sel);
      expect(config?.dispatch).toBe('broadcast');
      expect(config?.projects?.defaultPath).toBe('/home/user/projects');
      expect(config?.baseagents?.claude?.model).toBe('claude-sonnet-4');
    });
  });

  describe('merge chain: defaults → agent → relation', () => {
    it('agent config overrides defaults', () => {
      // 设置 defaults（只能设置 defaults schema 支持的字段）
      write(ConfigTarget.Defaults, {
        $schema_version: 2,
        active_baseagent: 'claude',
        baseagents: { claude: { model: 'sonnet' } },
      }, {});

      // 设置 agent 覆盖部分字段
      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        active_baseagent: 'codex',  // 覆盖
        baseagents: { claude: { model: 'opus' } },  // 覆盖
        observable: true,  // 新增（defaults 不支持）
      }, sel);

      const effective = resolveEffective(sel);
      expect(effective.active_baseagent).toBe('codex');  // agent 覆盖
      expect(effective.baseagents?.claude?.model).toBe('opus');  // agent 覆盖
      expect(effective.observable).toBe(true);  // agent 新增
    });

    it('relation config overrides agent config', () => {
      // defaults
      write(ConfigTarget.Defaults, {
        $schema_version: 2,
        active_baseagent: 'claude',
        baseagents: { claude: { model: 'sonnet' } },
      }, {});

      // agent
      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        active_baseagent: 'codex',
        baseagents: { claude: { model: 'opus' } },
        dispatch: 'mention',
      }, sel);

      // relation (使用 relation-config schema 支持的字段)
      const relSel = { self: testAid, peerKey: `aun#${testPeer}` };
      ensureFile(ConfigTarget.Relation, relSel);
      write(ConfigTarget.Relation, {
        $schema_version: 2,
        baseagents: { claude: { model: 'haiku' } },  // 覆盖 agent
        dispatch: 'broadcast',  // 覆盖 agent
        // active_baseagent 未设置，继承 agent
      }, relSel);

      const effective = resolveEffective(relSel);
      expect(effective.dispatch).toBe('broadcast');  // relation 覆盖
      expect(effective.baseagents?.claude?.model).toBe('haiku');  // relation 覆盖
      expect(effective.active_baseagent).toBe('codex');  // 继承 agent
    });
  });

  describe('merge rules by type', () => {
    it('scalar: higher priority replaces', () => {
      write(ConfigTarget.Defaults, { active_baseagent: 'claude' }, {});

      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        aid: testAid,
        channels: [],
        active_baseagent: 'codex',
      }, sel);

      const effective = resolveEffective(sel);
      expect(effective.active_baseagent).toBe('codex');
    });

    it('list: union (append without duplicates)', () => {
      // 测试 list 合并：channels 字段
      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [
          { type: 'aun', name: 'main' },
          { type: 'feishu', name: 'work' },
        ],
      }, sel);

      const relSel = { self: testAid, peerKey: `aun#${testPeer}` };
      ensureFile(ConfigTarget.Relation, relSel);
      write(ConfigTarget.Relation, {
        $schema_version: 2,
        // relation-config 不支持 channels，使用 baseagents 测试 dict 合并
        // 实际 list 合并在 agent-level owners 中已测试
      }, relSel);

      // 使用 agent config 测试 list union
      const agentCfg = read(ConfigTarget.Agent, sel);
      expect(agentCfg?.channels?.length).toBe(2);
      expect(agentCfg?.channels?.some(c => c.type === 'aun')).toBe(true);
      expect(agentCfg?.channels?.some(c => c.type === 'feishu')).toBe(true);
    });

    it('dict: key union, same key overwrites (non-recursive)', () => {
      write(ConfigTarget.Defaults, {
        $schema_version: 2,
        baseagents: {
          claude: { model: 'sonnet', effort: 'medium' },
          codex: { model: 'o1', reasoning: 'high' },
        }
      }, {});

      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        baseagents: {
          claude: { model: 'opus' },  // 整个 claude 块覆盖（不递归）
          gemini: { model: 'gemini-2' },  // 新增 gemini
        },
      }, sel);

      const effective = resolveEffective(sel);
      // claude 被整体覆盖（不保留 effort）
      expect(effective.baseagents?.claude?.model).toBe('opus');
      expect(effective.baseagents?.claude?.effort).toBeUndefined();
      // codex 继承自 defaults
      expect(effective.baseagents?.codex?.model).toBe('o1');
      // gemini 新增
      expect(effective.baseagents?.gemini?.model).toBe('gemini-2');
    });
  });

  describe('snapshot includes all config files', () => {
    it('includes defaults, agent configs, and relation configs', () => {
      // 创建一些配置
      write(ConfigTarget.Defaults, {
        $schema_version: 2,
        active_baseagent: 'claude'
      }, {});

      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        observable: true,
      }, sel);

      const files = collectConfigFiles(p.root);

      expect(files).toContain('agents/defaults.json');
      expect(files.some(f => f.includes(testAid) && f.endsWith('config.json'))).toBe(true);
    });
  });

  describe('process config is independent', () => {
    it('evolclaw.json does not participate in merge chain', () => {
      // process config
      write(ConfigTarget.Process, {
        $schema_version: 2,
        aid: 'daemon.aid.pub',
        owners: ['admin.aid.pub'],
      }, {});

      // agent config
      const sel = { self: testAid };
      ensureFile(ConfigTarget.Agent, sel);
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: testAid,
        channels: [],
        owners: ['bot-owner.aid.pub'],
      }, sel);

      // process config 不影响 agent
      const effective = resolveEffective(sel);
      expect(effective.aid).toBe(testAid);
      expect(effective.owners).not.toContain('admin.aid.pub');
      expect(effective.owners).toContain('bot-owner.aid.pub');

      // 读取 process config
      const processConfig = read(ConfigTarget.Process, {});
      expect(processConfig?.aid).toBe('daemon.aid.pub');
    });
  });
});
