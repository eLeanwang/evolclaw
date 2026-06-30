import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPrivateRoleAssignment } from '../src/config/role-assignments.js';

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
    expect(payload.code).toBe('MODEL_OVERRIDE_DISABLED');
  });
});
