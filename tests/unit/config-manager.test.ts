import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot, resolvePaths, agentConfig } from '../../src/paths.js';
import {
  ConfigTarget, read, write, ensureFile, resolveAgentConfig,
  resolveEffective, initConfigManager, ConfigError,
} from '../../src/config/config-manager.js';
import { mergeLayers, expandVars, buildEnvResolver, _resetEnvWarnings } from '../../src/config/merge.js';
import { loadSchema, _resetSchemaCache } from '../../src/config/schema-registry.js';

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
      { show_activities: true, flush_delay: 3 },
      { show_activities: false },
    ], fields);
    expect(merged.show_activities).toBe(false);
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
      show_activities: false,
      chatmode: { private: 'proactive' },
      dispatch: 'broadcast',
      baseagents: { claude: { model: 'sonnet' } },
    }, { self: AID });

    expect(fs.existsSync(agentConfig(AID))).toBe(true);

    const config = read<any>(ConfigTarget.Agent, { self: AID });
    expect(config.show_activities).toBe(false);
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
