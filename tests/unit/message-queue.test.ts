import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageQueue } from '../../src/core/message-queue.js';
import { Message } from '../../src/types.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;
  let handler: (msg: Message) => Promise<void>;
  let results: number[];

  beforeEach(() => {
    results = [];
    handler = vi.fn(async (msg: Message) => {
      results.push(parseInt(msg.content));
    });
    queue = new MessageQueue(handler);
  });

  it('should enqueue and process messages in order', async () => {
    const msg1: Message = { channel: 'feishu', channelId: 'c1', content: '1', timestamp: Date.now() };
    const msg2: Message = { channel: 'feishu', channelId: 'c1', content: '2', timestamp: Date.now() };

    await Promise.all([
      queue.enqueue('session1', msg1, '/test/project'),
      queue.enqueue('session1', msg2, '/test/project')
    ]);

    expect(results).toEqual([1, 2]);
  });

  it('should process different sessions in parallel', async () => {
    const msg1: Message = { channel: 'feishu', channelId: 'c1', content: '1', timestamp: Date.now() };
    const msg2: Message = { channel: 'acp', channelId: 'c2', content: '2', timestamp: Date.now() };

    await Promise.all([
      queue.enqueue('session1', msg1, '/test/project1'),
      queue.enqueue('session2', msg2, '/test/project2')
    ]);

    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  it('should handle errors', async () => {
    const errorHandler = vi.fn(async () => { throw new Error('test'); });
    const q = new MessageQueue(errorHandler);
    const msg: Message = { channel: 'feishu', channelId: 'c1', content: 'x', timestamp: Date.now() };

    await expect(q.enqueue('s1', msg, '/test/project')).rejects.toThrow('test');
  });
});
