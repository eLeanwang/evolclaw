import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPrivateRoleAssignment } from '../src/config/role-assignments.js';
import { ConfigTarget, write, writeRoles } from '../src/config/config-manager.js';
import { readRelationBehavior } from '../src/config/behavior.js';
import { clearRolesCache, getBuiltinRolesConfig } from '../src/config/roles.js';

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
    setPrivateRoleAssignment(selfAid, currentAid, 'guest');

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    const { cmdModel } = await import('../src/cli/model.js');
    await cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload.role).toBe('guest');
    expect(payload.models.map((model: any) => model.id)).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('rejects model list when inferred role denies command permission', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    const roles = getBuiltinRolesConfig();
    roles.roles.guest.commandPermissions = {
      ...roles.roles.guest.commandPermissions,
      'model.list': {
        allow: false,
        reason: 'model list disabled for guest',
      },
    };
    writeRoles(roles);
    setPrivateRoleAssignment(selfAid, currentAid, 'guest');

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
      error: 'model list disabled for guest',
    });
    expect(catalog.getCatalog).not.toHaveBeenCalled();
  });

  it('returns effective model without leaking scope diagnostics', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    setPrivateRoleAssignment(selfAid, currentAid, 'guest');
    write(
      ConfigTarget.RelationBehavior,
      { baseagents: { claude: { model: 'claude-opus-4-8' } } },
      { self: selfAid, peerKey: `aun#${currentAid}` },
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: any) => {
      logs.push(String(msg));
    });

    const { cmdModel } = await import('../src/cli/model.js');
    await cmdModel(['list', '--self', selfAid, '--peer', currentAid, '--format', 'json']);

    const payload = JSON.parse(logs.at(-1) || '{}');
    expect(payload.effective).toEqual({
      model: 'claude-haiku-4-5-20251001',
      source: 'relation',
    });
    expect(payload.scopes).toBeUndefined();
    expect(readRelationBehavior(selfAid, `aun#${currentAid}`)?.baseagents?.claude?.model)
      .toBe('claude-haiku-4-5-20251001');
  });

  it('rejects disallowed model use by inferred role', async () => {
    const selfAid = 'frontend-peer.agentid.pub';
    const currentAid = 'current-user.aid.pub';
    setPrivateRoleAssignment(selfAid, currentAid, 'guest');

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
