import { describe, it, expect } from 'vitest';

/**
 * 话题引用逻辑单元测试
 *
 * 验证 feishu.ts 中话题创建消息的引用判断：
 * - 首次见到 thread_id → isThreadCreation = true → 拉引用
 * - 同 thread_id 再次出现 → isThreadCreation = false → 不拉引用
 * - 非话题的普通引用回复 → 正常拉引用
 */

/** 模拟 feishu.ts 中的引用条件判断逻辑（与实际代码保持一致） */
function shouldFetchQuote(
  msg: { parent_id?: string; thread_id?: string; root_id?: string },
  seenThreads: Set<string>
): { shouldFetch: boolean; isThreadCreation: boolean } {
  const isThreadCreation = !!(msg.thread_id && msg.parent_id && !seenThreads.has(msg.thread_id));
  if (msg.thread_id) seenThreads.add(msg.thread_id);
  const shouldFetch = !!(msg.parent_id && (!msg.thread_id || isThreadCreation));
  return { shouldFetch, isThreadCreation };
}

describe('Feishu Thread Quote Logic', () => {
  it('话题创建消息（首次见到 thread_id）应拉取引用', () => {
    const seenThreads = new Set<string>();
    const msg = { parent_id: 'om_root', thread_id: 'omt_123', root_id: 'om_root' };

    const result = shouldFetchQuote(msg, seenThreads);

    expect(result.isThreadCreation).toBe(true);
    expect(result.shouldFetch).toBe(true);
    expect(seenThreads.has('omt_123')).toBe(true);
  });

  it('话题后续消息（thread_id 已见过）不拉引用', () => {
    const seenThreads = new Set<string>(['omt_123']);
    const msg = { parent_id: 'om_root', thread_id: 'omt_123', root_id: 'om_root' };

    const result = shouldFetchQuote(msg, seenThreads);

    expect(result.isThreadCreation).toBe(false);
    expect(result.shouldFetch).toBe(false);
  });

  it('同一话题连续两条消息：第一条拉引用，第二条不拉', () => {
    const seenThreads = new Set<string>();
    const msg1 = { parent_id: 'om_root', thread_id: 'omt_456', root_id: 'om_root' };
    const msg2 = { parent_id: 'om_root', thread_id: 'omt_456', root_id: 'om_root' };

    const r1 = shouldFetchQuote(msg1, seenThreads);
    const r2 = shouldFetchQuote(msg2, seenThreads);

    expect(r1.shouldFetch).toBe(true);
    expect(r2.shouldFetch).toBe(false);
  });

  it('非话题的普通引用回复正常拉引用', () => {
    const seenThreads = new Set<string>();
    const msg = { parent_id: 'om_parent', thread_id: undefined, root_id: undefined };

    const result = shouldFetchQuote(msg, seenThreads);

    expect(result.isThreadCreation).toBe(false);
    expect(result.shouldFetch).toBe(true);
  });

  it('无引用的普通消息不拉引用', () => {
    const seenThreads = new Set<string>();
    const msg = { parent_id: undefined, thread_id: undefined, root_id: undefined };

    const result = shouldFetchQuote(msg, seenThreads);

    expect(result.shouldFetch).toBe(false);
  });

  it('话题消息无 parent_id 不拉引用', () => {
    const seenThreads = new Set<string>();
    const msg = { parent_id: undefined, thread_id: 'omt_789', root_id: undefined };

    const result = shouldFetchQuote(msg, seenThreads);

    expect(result.isThreadCreation).toBe(false);
    expect(result.shouldFetch).toBe(false);
    // thread_id 仍应被记录
    expect(seenThreads.has('omt_789')).toBe(true);
  });

  it('不同话题各自独立判断', () => {
    const seenThreads = new Set<string>();
    const msgA = { parent_id: 'om_a', thread_id: 'omt_aaa', root_id: 'om_a' };
    const msgB = { parent_id: 'om_b', thread_id: 'omt_bbb', root_id: 'om_b' };

    const rA = shouldFetchQuote(msgA, seenThreads);
    const rB = shouldFetchQuote(msgB, seenThreads);

    expect(rA.shouldFetch).toBe(true);
    expect(rB.shouldFetch).toBe(true);

    // 各自的后续消息不再拉引用
    const rA2 = shouldFetchQuote({ ...msgA }, seenThreads);
    const rB2 = shouldFetchQuote({ ...msgB }, seenThreads);
    expect(rA2.shouldFetch).toBe(false);
    expect(rB2.shouldFetch).toBe(false);
  });
});
