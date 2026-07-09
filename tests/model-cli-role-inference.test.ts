import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigTarget, write, read } from '../src/config/config-manager.js';
import { clearRolesCache } from '../src/config/roles.js';

vi.mock('../src/core/model/model-catalog.js', () => ({
  getCatalog: vi.fn(async () => ({
    source: 'mock',
    models: [
      { id: 'claude-opus-4-8', owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-6', owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', owned_by: 'anthropic' },
    ],
  })),
  getModelInfo: vi.fn(),
}));

describe('model CLI role inference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearRolesCache();
  });

  it('filters model list by role inferred from --self and --peer', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${currentAid}` });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    const { cmdModel } = await import('../src/cli/model.js');
    await cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload.role).toBe('visitor');
    expect(payload.models.map((model: any) => model.id)).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('rejects model list when inferred role denies command permission', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, {
      aid: selfAid,
      channels: [],
      roles: {
        definitions: {
          blocked: {
            description: 'cannot list models',
            permissions: {},
            commandPermissions: {
              'model.list': {
                allow: false,
                reason: 'model list disabled for blocked',
              },
            },
          },
        },
      },
    }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'blocked' } }, { self: selfAid, peerKey: `aun#${currentAid}` });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const catalog = await import('../src/core/model/model-catalog.js');
    vi.mocked(catalog.getCatalog).mockClear();

    const { cmdModel } = await import('../src/cli/model.js');
    await expect(cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']))
      .rejects.toThrow('process.exit:1');

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload).toMatchObject({
      ok: false,
      code: 'NOT_ALLOWED',
      error: 'model list disabled for blocked',
    });
    expect(catalog.getCatalog).not.toHaveBeenCalled();
  });

  it('returns effective model without leaking scope diagnostics', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${currentAid}` });
    // v3: 写入 relation config 时提供 role，会触发角色约束警告，但仍写入原始值
    write(
      ConfigTarget.Relation,
      { roles: { assigned: 'visitor' }, baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: selfAid, peerKey: `aun#${currentAid}`, role: 'visitor' },
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    const { cmdModel } = await import('../src/cli/model.js');
    await cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    // effective 字段通过 resolveEffective 应用了角色约束，返回降级后的 haiku
    expect(payload.effective).toEqual({
      model: 'claude-haiku-4-5-20251001',
      source: 'relation',
    });
    expect(payload.scopes).toBeUndefined();
    // v3: 直接读取 relation config - 存储的是原始值（write 只警告不修正）
    const relationConfig = read<any>(ConfigTarget.Relation, { self: selfAid, peerKey: `aun#${currentAid}` });
    expect(relationConfig?.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('rejects disallowed model use by inferred role', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${currentAid}` });

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const { cmdModel } = await import('../src/cli/model.js');
    await expect(cmdModel(['use', 'claude-opus-4-8', '--self', selfAid, '--peer', currentAid, '--format', 'json']))
      .rejects.toThrow('process.exit:1');

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('ARGUMENT_MISMATCH');
    expect(payload.error).toContain('cannot override');
  });
});
