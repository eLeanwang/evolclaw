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

  it('does not filter model list by inferred role', async () => {
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
      'claude-opus-4-8',
      'claude-sonnet-4-6',
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

  it('allows relation model overrides regardless of provided role', () => {
    const selfAid = 'reject-violating-write.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${currentAid}` });

    expect(() => write(
      ConfigTarget.Relation,
      { roles: { assigned: 'visitor' }, baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: selfAid, peerKey: `aun#${currentAid}`, role: 'visitor' },
    )).not.toThrow();
  });

  it('returns effective model without leaking scope diagnostics', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${currentAid}` });
    // Seed legacy/unsafe stored data explicitly; normal relation writes reject this by default.
    write(
      ConfigTarget.Relation,
      { roles: { assigned: 'visitor' }, baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: selfAid, peerKey: `aun#${currentAid}`, role: 'visitor' },
      { allowRoleConstraintViolations: true },
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    const { cmdModel } = await import('../src/cli/model.js');
    await cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    // effective 字段保留关系级模型，不再应用角色模型约束
    expect(payload.effective).toEqual({
      model: 'claude-opus-4-8',
      source: 'relation',
    });
    expect(payload.scopes).toBeUndefined();
    // v3: 直接读取 relation config - 存储的是原始值（write 只警告不修正）
    const relationConfig = read<any>(ConfigTarget.Relation, { self: selfAid, peerKey: `aun#${currentAid}` });
    expect(relationConfig?.baseagents?.claude?.model).toBe('claude-opus-4-8');
  });

  it('allows model use independently of inferred role model policy', async () => {
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
    await cmdModel(['use', 'claude-opus-4-8', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload.ok).toBe(true);
    expect(payload.model).toBe('claude-opus-4-8');
  });
});
