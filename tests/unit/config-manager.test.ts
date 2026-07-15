import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot, resolvePaths, agentConfig, agentRelationConfig } from '../../src/paths.js';
import {
  ConfigTarget, read, write, ensureFile, resolveAgentConfig,
  resolveEffective, initConfigManager, ConfigError, routeFieldPath,
} from '../../src/config/config-manager.js';
import { mergeLayers, expandVars, buildEnvResolver, _resetEnvWarnings } from '../../src/config/merge.js';
import { loadSchema, _resetSchemaCache } from '../../src/config/schema-registry.js';
import {
  isBehaviorConfigFieldPath,
  isCriticalAgentControlField,
  isSafeBehaviorConfigField,
  parseConfigFieldValue,
  resolveConfigFieldRule,
  resolveRoleFieldPermission,
} from '../../src/config/config-field-policy.js';
import { cmdConfig } from '../../src/cli/config.js';
import { formatPeerKey } from '../../src/core/relation/peer-identity.js';

const AID = 'bot.agentid.pub';
const PEER = 'aun#alice.agentid.pub';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-cfg-'));
  process.env.EVOLCLAW_HOME = root;
  _resetRoot();
  _resetSchemaCache();
  _resetEnvWarnings();
  return root;
}
function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
}

describe('schema-registry (v3)', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('所有配置文件都标记为同一权限类型（H）', () => {
    // v3: 不再区分 H 和 HA，所有配置都是 H（基础设施+行为统一）
    expect(loadSchema('agent-config').permission).toBe('H');
    expect(loadSchema('defaults').permission).toBe('H');
    expect(loadSchema('evolclaw').permission).toBe('H');
    expect(loadSchema('relation-config').permission).toBe('H');
    expect(loadSchema('contact-book').permission).toBe('H');
  });

  it('字段带 x-merge 语义', () => {
    const agent = loadSchema('agent-config');
    expect(agent.fields.get('baseagents')?.merge).toBe('dict');
    expect(agent.fields.get('show_activities')?.merge).toBe('scalar');
    expect(agent.fields.get('owners')?.merge).toBe('list');
  });
});

describe('typed merge（三三规则）', () => {
  it('scalar 覆盖 / list 并集去重 / dict 第一层键合并不递归', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { owners: ['a'], models: { default: 'x', allowed: ['m1'] } },
      { owners: ['a', 'b'], models: { default: 'y' } },
    ], fields);
    // list 并集去重
    expect(merged.owners.sort()).toEqual(['a', 'b']);
    // dict 第一层键并集：同键 default 高优先级覆盖（x→y）；base 独有 allowed 保留（不递归进 allowed 内部）
    expect(merged.models).toEqual({ default: 'y', allowed: ['m1'] });
  });

  it('dict 同键整体覆盖（不递归进二级）', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { baseagents: { claude: { model: 'a', effort: 'low' } } },
      { baseagents: { claude: { model: 'b' } } },
    ], fields);
    // 同键 claude 整体被高优先级覆盖（effort 不保留——不递归）
    expect(merged.baseagents.claude).toEqual({ model: 'b' });
  });

  it('scalar 高优先级胜', () => {
    const fields = loadSchema('agent-config').fields;
    const merged = mergeLayers<any>([
      { show_activities: 'all', flush_delay: 3 },
      { show_activities: 'none' },
    ], fields);
    expect(merged.show_activities).toBe('none');
    expect(merged.flush_delay).toBe(3);
  });
});

describe('${VAR} 展开（仅 ${VAR}，三级 .env）', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('agent .env 覆盖 root .env，root 覆盖 process.env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'TOK=root_val\nONLY_ROOT=r\n');
    const agentDir = path.join(root, 'agents', AID);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, '.env'), 'TOK=agent_val\n');
    const resolver = buildEnvResolver({ rootDir: root, agentDir });
    const out = expandVars({ a: '${TOK}', b: '${ONLY_ROOT}' }, resolver);
    expect(out.a).toBe('agent_val');
    expect(out.b).toBe('r');
  });

  it('未定义变量展开为空字符串（带警告）', () => {
    const resolver = buildEnvResolver({ rootDir: setupHome() });
    const out = expandVars({ x: '${UNDEF}' }, resolver);
    // v3 实现：未定义变量展开为空字符串（并输出警告）
    expect(out.x).toBe('');
  });

  it('展开对象、数组、嵌套结构', () => {
    process.env.K = 'val';
    const resolver = buildEnvResolver({ rootDir: setupHome() });
    const out = expandVars({
      str: '${K}',
      obj: { nested: '${K}' },
      arr: ['${K}', 123],
    }, resolver);
    expect(out.str).toBe('val');
    expect(out.obj.nested).toBe('val');
    expect(out.arr[0]).toBe('val');
    delete process.env.K;
  });
});

describe('ConfigManager CRUD (v3 unified config.json)', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('write 所有参数到 config.json', () => {
    initConfigManager();
    write(ConfigTarget.Agent, {
      $schema_version: 2,
      aid: AID,
      channels: [],
      // 基础设施参数
      owners: ['owner.aid.pub'],
      projects: { defaultPath: '/workspace' },
      // 行为参数
      show_activities: 'none',
      chatmode: { private: 'proactive' },
      dispatch: 'broadcast',
      baseagents: { claude: { model: 'sonnet' } },
    }, { self: AID });

    expect(fs.existsSync(agentConfig(AID))).toBe(true);

    const config = read<any>(ConfigTarget.Agent, { self: AID });
    expect(config.show_activities).toBe('none');
    expect(config.owners).toContain('owner.aid.pub');
    expect(config.baseagents.claude.model).toBe('sonnet');
  });

  it('未知字段不阻止写入（forward compatibility）', () => {
    initConfigManager();
    expect(() => {
      write(ConfigTarget.Agent, {
        $schema_version: 2,
        aid: AID,
        channels: [],
        future_field_v4: 'some_value',
      }, { self: AID }, { skipValidate: true });
    }).not.toThrow();
  });
});

describe('resolveEffective (v3 覆盖链: defaults → agent → relation)', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('agent 覆盖 defaults', () => {
    write(ConfigTarget.Defaults, {
      $schema_version: 2,
      active_baseagent: 'claude',
      baseagents: { claude: { model: 'sonnet' } },
    }, {});

    write(ConfigTarget.Agent, {
      $schema_version: 2,
      aid: AID,
      channels: [],
      baseagents: { claude: { model: 'opus' } },
    }, { self: AID });

    expect(resolveAgentConfig({ self: AID }).active_baseagent).toBe('claude');
    expect(resolveEffective({ self: AID }).baseagents?.claude?.model).toBe('opus');
  });

  it('relation 覆盖 agent', () => {
    write(ConfigTarget.Agent, {
      $schema_version: 2,
      aid: AID,
      channels: [],
      baseagents: { claude: { model: 'agent-model' } },
    }, { self: AID });

    write(ConfigTarget.Relation, {
      $schema_version: 2,
      baseagents: { claude: { model: 'relation-model' } },
    }, { self: AID, peerKey: PEER });

    expect(resolveEffective({ self: AID }).baseagents?.claude?.model).toBe('agent-model');
    expect(resolveEffective({ self: AID, peerKey: PEER }).baseagents?.claude?.model).toBe('relation-model');
  });

  it('merges session_renew across defaults, agent, and relation', () => {
    write(ConfigTarget.Defaults, {
      $schema_version: 1,
      config: { auxiliaryModel: 'deepseek-v4-flash', debounceMs: 3000 },
      session_renew: { enabled: false, after_hours: 24, model: 'claude-haiku-4-5-20251001', effort: 'low' },
    }, {});

    write(ConfigTarget.Agent, {
      $schema_version: 3,
      aid: AID,
      channels: [],
      config: { auxiliaryModel: 'claude-haiku' },
      session_renew: { enabled: true },
    }, { self: AID });

    write(ConfigTarget.Relation, {
      $schema_version: 2,
      config: { debounceMs: 1000 },
      session_renew: { after_hours: 72, fallback_action: 'continue' },
    }, { self: AID, peerKey: PEER });

    expect(resolveEffective({ self: AID, peerKey: PEER }).session_renew).toEqual({
      enabled: true,
      after_hours: 72,
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      fallback_action: 'continue',
    });
    expect(resolveEffective({ self: AID, peerKey: PEER }).config).toEqual({
      auxiliaryModel: 'claude-haiku',
      debounceMs: 1000,
    });
    expect(routeFieldPath('session_renew.enabled', 'defaults').target).toBe(ConfigTarget.Defaults);
  });

  it('roles 块保留在 effective（用于角色寻址）', () => {
    write(ConfigTarget.Agent, {
      $schema_version: 2,
      aid: AID,
      channels: [],
      roles: {
        definitions: {
          vip: {
            description: 'VIP collaborator',
            permissions: {
              'baseagents.claude.model': { default: 'vip-model', allowOverride: true },
            },
          },
        },
      },
    }, { self: AID });

    const eff = resolveEffective({ self: AID });
    // v3: roles 块保留在配置中（用于角色寻址）
    expect(eff.roles).toBeDefined();
    expect(eff.roles?.definitions?.vip).toBeDefined();
  });
});

describe('process config is independent', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('evolclaw.json 不参与 agent 覆盖链', () => {
    write(ConfigTarget.Process, {
      $schema_version: 2,
      aid: 'daemon.aid.pub',
      owners: ['admin.aid.pub'],
    }, {});

    write(ConfigTarget.Agent, {
      $schema_version: 2,
      aid: AID,
      channels: [],
      owners: ['bot-owner.aid.pub'],
    }, { self: AID });

    const processConfig = read(ConfigTarget.Process, {});
    expect(processConfig?.aid).toBe('daemon.aid.pub');

    const agentEffective = resolveEffective({ self: AID });
    expect(agentEffective.aid).toBe(AID);
    expect(agentEffective.owners).not.toContain('admin.aid.pub');
  });
});

describe('config field policy', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  const safeFields = [
    'active_baseagent',
    'baseagents.claude.model',
    'baseagents.claude.effort',
    'baseagents.codex.reasoning',
    'baseagents.claude.agentProgressSummaries',
    'baseagents.codex.enableRequestUserInput',
    'baseagents.codex.approvalsReviewer',
    'baseagents.gemini.mode',
    'baseagents.gemini.useVertex',
    'chatmode.private',
    'response_modes.default_private',
    'responseMode',
    'config.auxiliaryModel',
    'flush_delay',
    'debounce',
    'dispatch',
    'show_activities',
    'proactive.pre_tool_1stmsgchk',
    'session_renew.enabled',
    'session_renew.after_hours',
    'session_renew.model',
    'session_renew.effort',
    'session_renew.fallback_action',
    'render.private',
    'sessionManifests.default',
    'enable_rich_content',
    'permissionMode',
  ];

  it('keeps every safe field inside the behavior route and relation schema', () => {
    for (const field of safeFields) {
      expect(isSafeBehaviorConfigField(field), field).toBe(true);
      expect(isBehaviorConfigFieldPath(field), field).toBe(true);
      expect(routeFieldPath(field, 'relation').target, field).toBe(ConfigTarget.Relation);
    }
  });

  it('keeps sensitive and unknown fields outside the user field plane', () => {
    for (const field of ['owners', 'admins', 'roles', 'channels', 'baseagents.claude.apiKey']) {
      expect(resolveConfigFieldRule(field).class, field).toBe('sensitive');
      expect(isSafeBehaviorConfigField(field), field).toBe(false);
    }
    expect(resolveConfigFieldRule('made_up_field').class).toBe('unknown');
    expect(isSafeBehaviorConfigField('chatmode.secret')).toBe(false);
    expect(isSafeBehaviorConfigField('response_modes.configs.secret')).toBe(false);
    expect(isCriticalAgentControlField('roles.definitions.member')).toBe(true);
  });

  it('matches exact field permissions before safe top-level permissions', () => {
    const chatmode = { default: {}, allowOverride: true };
    const exact = { default: 'interactive', allowOverride: false };
    expect(resolveRoleFieldPermission({ chatmode, 'chatmode.private': exact }, 'chatmode.private')).toBe(exact);
    expect(resolveRoleFieldPermission({ chatmode }, 'chatmode.group')).toBe(chatmode);
    expect(resolveRoleFieldPermission({ baseagents: chatmode }, 'baseagents.claude.apiKey')).toBeUndefined();
  });

  it('coerces scalar values and rejects invalid or unsafe values', () => {
    expect(parseConfigFieldValue('chatmode.private', 'interactive')).toEqual({ ok: true, value: 'interactive' });
    expect(parseConfigFieldValue('chatmode.private', 'invalid').ok).toBe(false);
    expect(parseConfigFieldValue('enable_rich_content', 'true')).toEqual({ ok: true, value: true });
    expect(parseConfigFieldValue('enable_rich_content', '1').ok).toBe(false);
    expect(parseConfigFieldValue('flush_delay', '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseConfigFieldValue('flush_delay', '-1').ok).toBe(false);
    expect(parseConfigFieldValue('dispatch', 'broadcast')).toEqual({ ok: true, value: 'broadcast' });
    expect(parseConfigFieldValue('show_activities', 'text').ok).toBe(false);
    expect(parseConfigFieldValue('permissionMode', 'bypass')).toEqual({ ok: true, value: 'bypass' });
    expect(parseConfigFieldValue('active_baseagent', 'codex')).toEqual({ ok: true, value: 'codex' });
    expect(parseConfigFieldValue('active_baseagent', 'unknown').ok).toBe(false);
    expect(parseConfigFieldValue('sessionManifests.main', 'custom.json')).toEqual({ ok: true, value: 'custom.json' });
    expect(parseConfigFieldValue('sessionManifests.main', '../../secret.json').ok).toBe(false);
    expect(parseConfigFieldValue('session_renew.enabled', 'true')).toEqual({ ok: true, value: true });
    expect(parseConfigFieldValue('session_renew.after_hours', '24')).toEqual({ ok: true, value: 24 });
    expect(parseConfigFieldValue('session_renew.after_hours', '0').ok).toBe(false);
    expect(parseConfigFieldValue('session_renew.model', 'claude-haiku-4-5-20251001')).toEqual({
      ok: true,
      value: 'claude-haiku-4-5-20251001',
    });
    expect(parseConfigFieldValue('session_renew.model', ' ').ok).toBe(false);
    expect(parseConfigFieldValue('session_renew.fallback_action', 'continue')).toEqual({ ok: true, value: 'continue' });
    expect(parseConfigFieldValue('session_renew.fallback_action', 'ask').ok).toBe(false);
  });
});

describe('config CLI relation writes', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('writes the selected relation file without mutating agent config', async () => {
    const self = 'relation-write.agentid.pub';
    const peerKey = formatPeerKey('aun', 'member.agentid.pub');
    const agentFile = agentConfig(self);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, JSON.stringify({
      $schema_version: 1,
      aid: self,
      channels: [],
      chatmode: { private: 'interactive' },
    }, null, 2));
    const beforeAgent = fs.readFileSync(agentFile, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await cmdConfig([
        'set', 'chatmode.private', 'proactive',
        '--self', self, '--peer', peerKey,
        '--format', 'json',
      ]);
    } finally {
      log.mockRestore();
    }

    const relationFile = agentRelationConfig(self, peerKey);
    expect(fs.existsSync(relationFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(relationFile, 'utf8')).chatmode.private).toBe('proactive');
    expect(fs.readFileSync(agentFile, 'utf8')).toBe(beforeAgent);
  });
});
