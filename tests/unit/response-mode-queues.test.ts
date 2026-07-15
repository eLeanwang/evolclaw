import { describe, it, expect } from 'vitest';
import { FIFOQueue, LIFOQueue, PriorityQueue } from '../../src/response-system/queues/index.js';
import type { InboundMessage } from '../../src/response-system/types.js';

function msg(content: string): InboundMessage {
  return { peerId: 'p1', content, chatType: 'private' };
}

describe('FIFOQueue', () => {
  it('dequeues in insertion order', async () => {
    const q = new FIFOQueue();
    await q.enqueue(msg('a'));
    await q.enqueue(msg('b'));
    await q.enqueue(msg('c'));
    expect(q.size()).toBe(3);
    expect((await q.dequeue())?.content).toBe('a');
    expect(q.dequeueSync()?.content).toBe('b');
    expect((await q.dequeue())?.content).toBe('c');
    expect(q.size()).toBe(0);
  });

  it('reorder to lifo reverses', async () => {
    const q = new FIFOQueue();
    await q.enqueue(msg('a'));
    await q.enqueue(msg('b'));
    await q.reorder('lifo');
    expect(q.dequeueSync()?.content).toBe('b');
  });
});

describe('LIFOQueue', () => {
  it('dequeues in reverse order', async () => {
    const q = new LIFOQueue();
    await q.enqueue(msg('a'));
    await q.enqueue(msg('b'));
    await q.enqueue(msg('c'));
    expect(q.dequeueSync()?.content).toBe('c');
    expect((await q.dequeue())?.content).toBe('b');
  });
});

describe('PriorityQueue', () => {
  it('dequeues highest priority first', async () => {
    const q = new PriorityQueue();
    await q.enqueue(msg('low'), 1);
    await q.enqueue(msg('high'), 10);
    await q.enqueue(msg('mid'), 5);
    expect(q.dequeueSync()?.content).toBe('high');
    expect(q.dequeueSync()?.content).toBe('mid');
    expect(q.dequeueSync()?.content).toBe('low');
  });

  it('same priority keeps FIFO order', async () => {
    const q = new PriorityQueue();
    await q.enqueue(msg('first'), 5);
    await q.enqueue(msg('second'), 5);
    expect(q.dequeueSync()?.content).toBe('first');
    expect(q.dequeueSync()?.content).toBe('second');
  });
});
