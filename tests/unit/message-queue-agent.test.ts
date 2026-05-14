import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import { Message } from '../../src/types.js';

function makeMsg(content: string, extra?: Partial<Message>): Message {
  return {
    channel: 'feishu', channelId: 'c1', peerId: 'u1',
    content, timestamp: Date.now(),
    ...extra,
  };
}

describe('MessageQueue per-agent counters', () => {
  it('enqueue with agentName tags pending items correctly', async () => {
    // Use a single sessionKey + project to share one queue. First item blocks,
    // subsequent items pile up in that queue with their respective agentName tags.
    let releaseFirst!: () => void;
    const handler = vi.fn(async (m: Message) => {
      if (m.content === 'block') {
        await new Promise<void>(r => { releaseFirst = r; });
      }
    });
    const q = new MessageQueue(handler);

    const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/p', { interruptible: false, agentName: 'alice' });
    await new Promise(r => setTimeout(r, 10));

    q.enqueue('s1', makeMsg('a-pending', { peerId: 'ua' }), '/p', { interruptible: false, agentName: 'alice' });
    q.enqueue('s1', makeMsg('b-pending', { peerId: 'ub' }), '/p', { interruptible: false, agentName: 'bob' });

    expect(q.getQueueLengthByAgent('alice')).toBe(1);
    expect(q.getQueueLengthByAgent('bob')).toBe(1);
    expect(q.getQueueLengthByAgent('nobody')).toBe(0);

    releaseFirst();
    await p0.catch(() => {});
  });

  it('getQueueLengthByAgent counts only items tagged with that agent', async () => {
    // Use a handler that blocks the very first item so the rest stay queued.
    let releaseFirst!: () => void;
    const handler = vi.fn(async (m: Message) => {
      if (m.content === 'block') {
        await new Promise<void>(r => { releaseFirst = r; });
      }
    });
    const q = new MessageQueue(handler);

    // First item blocks the only sessionKey we'll use
    const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/p', { interruptible: false, agentName: 'alice' });
    await new Promise(r => setTimeout(r, 10));

    // These all go behind the blocked first item (same sessionKey + projectPath = same queueKey)
    q.enqueue('s1', makeMsg('a1', { peerId: 'u-a1' }), '/p', { interruptible: false, agentName: 'alice' });
    q.enqueue('s1', makeMsg('a2', { peerId: 'u-a2' }), '/p', { interruptible: false, agentName: 'alice' });
    q.enqueue('s1', makeMsg('b1', { peerId: 'u-b1' }), '/p', { interruptible: false, agentName: 'bob' });
    q.enqueue('s1', makeMsg('b2', { peerId: 'u-b2' }), '/p', { interruptible: false, agentName: 'bob' });
    q.enqueue('s1', makeMsg('b3', { peerId: 'u-b3' }), '/p', { interruptible: false, agentName: 'bob' });

    expect(q.getQueueLengthByAgent('alice')).toBe(2);
    expect(q.getQueueLengthByAgent('bob')).toBe(3);
    expect(q.getQueueLengthByAgent('charlie')).toBe(0);

    releaseFirst();
    await p0.catch(() => {});
  });

  it('items without agentName fall back to [default] bucket', async () => {
    let releaseFirst!: () => void;
    const handler = vi.fn(async (m: Message) => {
      if (m.content === 'block') {
        await new Promise<void>(r => { releaseFirst = r; });
      }
    });
    const q = new MessageQueue(handler);

    // Block first item (no agentName)
    const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/p', { interruptible: false });
    await new Promise(r => setTimeout(r, 10));

    // Mix of tagged/untagged
    q.enqueue('s1', makeMsg('untagged-1', { peerId: 'ua' }), '/p', { interruptible: false });
    q.enqueue('s1', makeMsg('untagged-2', { peerId: 'ub' }), '/p', { interruptible: false });
    q.enqueue('s1', makeMsg('tagged-1', { peerId: 'uc' }), '/p', { interruptible: false, agentName: 'alice' });

    expect(q.getQueueLengthByAgent('[default]')).toBe(2);
    expect(q.getQueueLengthByAgent('alice')).toBe(1);

    releaseFirst();
    await p0.catch(() => {});
  });

  it('getProcessingCountByAgent counts processing items tagged by agent', async () => {
    // Handler that holds each call until released — keeps processingAgent map populated
    const releasers: Array<() => void> = [];
    const handler = vi.fn(async () => {
      await new Promise<void>(r => releasers.push(r));
    });
    const q = new MessageQueue(handler);

    // Three different sessionKeys → three concurrent processing slots
    const p1 = q.enqueue('s-alice-1', makeMsg('a1'), '/p/a1', { interruptible: false, agentName: 'alice' });
    const p2 = q.enqueue('s-alice-2', makeMsg('a2'), '/p/a2', { interruptible: false, agentName: 'alice' });
    const p3 = q.enqueue('s-bob-1', makeMsg('b1'), '/p/b1', { interruptible: false, agentName: 'bob' });

    // Wait for processNext to populate processingAgent for each queueKey
    await new Promise(r => setTimeout(r, 20));

    expect(q.getProcessingCountByAgent('alice')).toBe(2);
    expect(q.getProcessingCountByAgent('bob')).toBe(1);
    expect(q.getProcessingCountByAgent('charlie')).toBe(0);

    // Release all handlers so the test cleanly finishes
    while (releasers.length > 0) releasers.shift()!();
    await Promise.all([p1, p2, p3]).catch(() => {});
  });

  it('getProcessingCountByAgent counts untagged processing as [default]', async () => {
    const releasers: Array<() => void> = [];
    const handler = vi.fn(async () => {
      await new Promise<void>(r => releasers.push(r));
    });
    const q = new MessageQueue(handler);

    const p1 = q.enqueue('s1', makeMsg('m1'), '/p/1', { interruptible: false }); // no agentName
    const p2 = q.enqueue('s2', makeMsg('m2'), '/p/2', { interruptible: false, agentName: 'alice' });
    await new Promise(r => setTimeout(r, 20));

    expect(q.getProcessingCountByAgent('[default]')).toBe(1);
    expect(q.getProcessingCountByAgent('alice')).toBe(1);

    while (releasers.length > 0) releasers.shift()!();
    await Promise.all([p1, p2]).catch(() => {});
  });
});
