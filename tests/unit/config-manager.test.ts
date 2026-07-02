import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot, resolvePaths, agentBehaviorConfig, agentConfig } from '../../src/paths.js';
import {
  ConfigTarget, read, write, ensureFile, resolveAgentConfig, resolveBehavior,
  resolveEffective, routeField, listFields, initConfigManager, ConfigError,
} from '../../src/core/config/config-manager.js';
import { mergeLayers, expandVars, buildEnvResolver, _resetEnvWarnings } from '../../src/core/config/merge.js';
import { assertDisjointFields, loadSchema, _resetSchemaCache } from '../../src/core/config/schema-registry.js';

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

describe('schema-registry', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); });
  afterEach(() => cleanup(root));

  it('config/behavior 字段名空间严格不相交', () => {
    expect(() => assertDisjointFields()).not.toThrow();
  });

  it('behavior schema 标记 HA，agent-config 标记 H', () => {
    expect(loadSchema('behavior').permission).toBe('HA');
    expect(loadSchema('agent-config').permission).toBe('H');
    expect(loadSchema('defaults').permission).toBe('H');
    expect(loadSchema('evolclaw').permission).toBe('H');
  });

  it('字段带 x-merge 语义', () => {
    const beh = loadSchema('behavior');
    expect(beh.fields.get('baseagents')?.merge).toBe('dict');
    expect(beh.fields.get('show_activities')?.merge).toBe('scalar');
    const agent = loadSchema('agent-config');
    expect(agent.fields.get('owners')?.merge).toBe('list');
  });
});

describe('typed merge（§三三规则）', () => {
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
    const fields = loadSchema('behavior').fields;
    const merged = mergeLayers<any>([
      { baseagents: { claude: { model: 'a', effort: 'low' } } },
      { baseagents: { claude: { model: 'b' } } },
    ], fields);
    // 同键 claude 整体被高优先级覆盖（effort 不保留——不递归）
    expect(merged.baseagents.claude).toEqual({ model: 'b' });
  });

  it('scalar 高优先级胜', () => {
    const fields = loadSchema('behavior').fields;
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
    expect(out).toEqual({ a: 'agent_val', b: 'r' });
  });

  it('$ENV: 旧语法不再展开（保持字面量）', () => {
    const resolver = buildEnvResolver({ rootDir: root });
    const out = expandVars({ a: '$ENV:TOK' }, resolver);
    expect(out).toEqual({ a: '$ENV:TOK' });
  });

  it('缺失变量展开为空字符串', () => {
    const resolver = buildEnvResolver({ rootDir: root });
    expect(expandVars({ a: '${MISSING}' }, resolver)).toEqual({ a: '' });
  });
});

describe('ConfigManager read/write/ensureFile + 字段路由', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('write H 落 config.json，write HA 落 behavior.json', () => {
    write(ConfigTarget.Agent, { $schema_version: 1, aid: AID, channels: [] }, { self: AID });
    write(ConfigTarget.AgentBehavior, { $schema_version: 1, show_activities: 'none' }, { self: AID });
    expect(fs.existsSync(agentConfig(AID))).toBe(true);
    expect(fs.existsSync(agentBehaviorConfig(AID))).toBe(true);
    const h = read<any>(ConfigTarget.Agent, { self: AID });
    const ha = read<any>(ConfigTarget.AgentBehavior, { self: AID });
    expect(h.aid).toBe(AID);
    expect(ha.show_activities).toBe('none');
  });

  it('routeField：H 字段→agent config，HA 字段→agent behavior', () => {
    expect(routeField('owners', 'agent').permission).toBe('H');
    expect(routeField('owners', 'agent').target).toBe(ConfigTarget.Agent);
    expect(routeField('chatmode', 'agent').permission).toBe('HA');
    expect(routeField('chatmode', 'agent').target).toBe(ConfigTarget.AgentBehavior);
  });

  it('routeField 未知字段抛 ConfigError', () => {
    expect(() => routeField('nope_field', 'agent')).toThrow(ConfigError);
  });

  it('write schema 校验：additionalProperties:false 挡住未知字段', () => {
    expect(() => write(ConfigTarget.Agent, { $schema_version: 1, aid: AID, channels: [], bogus: 1 } as any, { self: AID }))
      .toThrow(ConfigError);
  });

  it('listFields 列出 agent 作用域 H + HA 字段', () => {
    const fields = listFields('agent');
    const names = fields.map(f => f.schema);
    expect(names).toContain('agent-config');
    expect(names).toContain('behavior');
  });
});

describe('resolveAgentConfig（H 链三级）', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('defaults → agent → relation 逐级合并；owners list 并集', () => {
    write(ConfigTarget.Defaults, { $schema_version: 1, owners: ['ops.agentid.pub'] });
    write(ConfigTarget.Agent, { $schema_version: 1, aid: AID, channels: [], owners: ['bob.agentid.pub'] }, { self: AID });
    ensureFile(ConfigTarget.Relation, { self: AID, peerKey: PEER });
    write(ConfigTarget.Relation, { $schema_version: 1, owners: ['carol.agentid.pub'] }, { self: AID, peerKey: PEER });
    const merged = resolveAgentConfig({ self: AID, peerKey: PEER });
    expect((merged.owners || []).sort()).toEqual(['bob.agentid.pub', 'carol.agentid.pub', 'ops.agentid.pub']);
  });
});

describe('resolveBehavior（HA 链含角色层）', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('agent → role → relation 优先级（relation 最高）', () => {
    write(ConfigTarget.AgentBehavior, {
      $schema_version: 1,
      baseagents: { claude: { model: 'agent-model' } },
      roles: { vip: { baseagents: { claude: { model: 'role-model' } } } },
    }, { self: AID });
    write(ConfigTarget.RelationBehavior, {
      $schema_version: 1,
      baseagents: { claude: { model: 'relation-model' } },
    }, { self: AID, peerKey: PEER });

    // 仅 agent
    expect(resolveBehavior({ self: AID }).baseagents?.claude?.model).toBe('agent-model');
    // agent + role：role 覆盖 agent
    expect(resolveBehavior({ self: AID, role: 'vip' }).baseagents?.claude?.model).toBe('role-model');
    // agent + role + relation：relation 最高
    expect(resolveBehavior({ self: AID, role: 'vip', peerKey: PEER }).baseagents?.claude?.model).toBe('relation-model');
  });

  it('roles 块本身不进 effective（仅作角色寻址）', () => {
    write(ConfigTarget.AgentBehavior, {
      $schema_version: 1,
      roles: { vip: { permissionMode: 'bypass' } },
    }, { self: AID });
    const beh = resolveBehavior({ self: AID });
    expect(beh.roles).toBeUndefined();
  });

  it('HA 链无 defaults 层：defaults 不影响 behavior', () => {
    write(ConfigTarget.Defaults, { $schema_version: 1, owners: ['x.agentid.pub'] });
    write(ConfigTarget.AgentBehavior, { $schema_version: 1, show_activities: 'none' }, { self: AID });
    const beh = resolveBehavior({ self: AID });
    expect(beh.show_activities).toBe('none');
  });
});

describe('resolveEffective（H + behavior 合并视图）', () => {
  let root: string;
  beforeEach(() => { root = setupHome(); initConfigManager(); });
  afterEach(() => cleanup(root));

  it('H 段在顶层，HA 段在 behavior', () => {
    write(ConfigTarget.Agent, { $schema_version: 1, aid: AID, channels: [], owners: ['bob.agentid.pub'] }, { self: AID });
    write(ConfigTarget.AgentBehavior, { $schema_version: 1, chatmode: { private: 'proactive' } }, { self: AID });
    const eff = resolveEffective({ self: AID });
    expect(eff.aid).toBe(AID);
    expect(eff.owners).toEqual(['bob.agentid.pub']);
    expect(eff.behavior.chatmode?.private).toBe('proactive');
  });
});
