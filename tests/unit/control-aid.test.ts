import { describe, it, expect, vi } from 'vitest';

const mockStore = vi.hoisted(() => ({ exists: vi.fn(), close: vi.fn() }));
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue(mockStore),
}));
vi.mock('../../src/aun/aid/index.js', async (orig) => ({
  ...(await orig() as any),
  aidCreate: vi.fn(),
}));

import * as aid from '../../src/aun/aid/index.js';
import { candidateAid, generateControlAid } from '../../src/aun/aid/control-aid.js';

describe('candidateAid', () => {
  it('matches ec + 5 digits + .agentid.pub', () => {
    expect(candidateAid()).toMatch(/^ec\d{5}\.agentid\.pub$/);
  });
});

describe('generateControlAid', () => {
  it('retries on collision then succeeds', async () => {
    mockStore.exists.mockReset();
    mockStore.close.mockReset();
    mockStore.exists
      .mockResolvedValueOnce({ ok: true, data: { exists: true } })   // 第1个候选已注册
      .mockResolvedValueOnce({ ok: true, data: { exists: false } }); // 第2个候选可用
    (aid.aidCreate as any).mockResolvedValue({ aid: 'ec00002.agentid.pub', alreadyExisted: false, gateway: 'g', client: { close: vi.fn() }, store: { close: vi.fn() } });

    const result = await generateControlAid();
    expect(result.aid).toMatch(/^ec\d{5}\.agentid\.pub$/);
    expect(mockStore.exists.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockStore.close).toHaveBeenCalled(); // store 复用后 finally close
  });

  it('throws after max attempts all colliding', async () => {
    mockStore.exists.mockReset();
    mockStore.exists.mockResolvedValue({ ok: true, data: { exists: true } });
    await expect(generateControlAid()).rejects.toThrow(/无法生成/);
  });

  it('fail-fast when gateway unreachable (exists !ok)', async () => {
    mockStore.exists.mockReset();
    mockStore.exists.mockResolvedValue({ ok: false, error: { message: 'network error' } });
    await expect(generateControlAid()).rejects.toThrow(/Gateway 不可达|network error/);
  });
});
