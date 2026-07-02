import { describe, it, expect, vi } from 'vitest';

const mockStore = vi.hoisted(() => ({ exists: vi.fn(), close: vi.fn() }));
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue(mockStore),
}));
// agentmdGet 走 store.downloadAgentMd；直接 mock agentmd 模块更稳
vi.mock('../../src/aun/aid/agentmd.js', async (orig) => ({
  ...(await orig() as any),
  agentmdGet: vi.fn(),
}));

import { aidLookup } from '../../src/aun/aid/identity.js';
import { agentmdGet } from '../../src/aun/aid/agentmd.js';

describe('aidLookup (PKI-based)', () => {
  it('registered but no agent.md → exists:true, content undefined', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    (agentmdGet as any).mockRejectedValue(new Error('agent.md not found'));
    const r = await aidLookup('ec12345.agentid.pub');
    expect(r.exists).toBe(true);
    expect(r.content).toBeUndefined();
  });

  it('registered with agent.md → exists:true, content present', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    (agentmdGet as any).mockResolvedValue('---\nname: "Foo"\n---\n');
    const r = await aidLookup('biz.agentid.pub');
    expect(r.exists).toBe(true);
    expect(r.content).toContain('name: "Foo"');
  });

  it('not registered → exists:false', async () => {
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: false } });
    const r = await aidLookup('nope.agentid.pub');
    expect(r.exists).toBe(false);
  });

  it('gateway unreachable → exists:false with error', async () => {
    mockStore.exists.mockResolvedValue({ ok: false, error: { message: 'network error' } });
    const r = await aidLookup('x.agentid.pub');
    expect(r.exists).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
