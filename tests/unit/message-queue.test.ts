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

describe('MessageQueue', () => {
  let queue: MessageQueue;
  let handler: ReturnType<typeof vi.fn>;
  let handledMessages: Message[];

  beforeEach(() => {
    handledMessages = [];
    handler = vi.fn(async (msg: Message) => {
      handledMessages.push(msg);
    });
    queue = new MessageQueue(handler);
  });

  // ── 基本功能 ──

  it('should enqueue and process messages in order', async () => {
    await Promise.all([
      queue.enqueue('s1', makeMsg('1'), '/test/project'),
      queue.enqueue('s1', makeMsg('2'), '/test/project'),
    ]);

    // 第一条立即处理，第二条排队后贪心合并（只有 1 条，不合并）
    // 因为 handler 是同步 mock，第一条处理完后第二条才出队
    expect(handledMessages.length).toBe(2);
    expect(handledMessages[0].content).toBe('1');
    expect(handledMessages[1].content).toBe('2');
  });

  it('should process different sessions independently', async () => {
    await Promise.all([
      queue.enqueue('s1', makeMsg('1'), '/test/project1'),
      queue.enqueue('s2', makeMsg('2', { channelId: 'c2' }), '/test/project2'),
    ]);

    expect(handledMessages).toHaveLength(2);
    const contents = handledMessages.map(m => m.content).sort();
    expect(contents).toEqual(['1', '2']);
  });

  it('should handle errors and reject all merged promises', async () => {
    const errorHandler = vi.fn(async () => { throw new Error('test'); });
    const q = new MessageQueue(errorHandler);

    const p1 = q.enqueue('s1', makeMsg('a'), '/test/project');
    const p2 = q.enqueue('s1', makeMsg('b'), '/test/project');

    await expect(Promise.all([p1, p2])).rejects.toThrow('test');
  });

  // ── cancel ──

  describe('cancel', () => {
    it('should cancel a queued message', async () => {
      // 使处理阻塞，让消息在队列中排队
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'first') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      const p1 = q.enqueue('s1', makeMsg('first', { messageId: 'id1' }), '/test/project', { interruptible: false });
      // 第一条正在处理，后续消息排队
      const p2 = q.enqueue('s1', makeMsg('second', { messageId: 'id2', peerId: 'u2' }), '/test/project', { interruptible: false });

      // 撤回排队中的消息
      expect(q.cancel('id2')).toBe(true);

      // 释放第一条处理
      resolveFirst();
      await Promise.all([p1, p2]);

      // 只有第一条被处理
      expect(handledMessages).toHaveLength(1);
      expect(handledMessages[0].content).toBe('first');
    });

    it('should return false when messageId not found', () => {
      expect(queue.cancel('nonexistent')).toBe(false);
    });

    it('should resolve cancelled message promise (not reject)', async () => {
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
      });
      const q = new MessageQueue(blockHandler);

      const p1 = q.enqueue('s1', makeMsg('block', { messageId: 'id1' }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('cancel-me', { messageId: 'id2', peerId: 'u2' }), '/test/project', { interruptible: false });

      q.cancel('id2');
      resolveFirst();

      // 两个 promise 都应该 resolve（不 reject）
      await expect(Promise.all([p1, p2])).resolves.not.toThrow();
    });
  });

  // ── FIFO 贪心合并 ──

  describe('FIFO greedy merge', () => {
    it('should merge consecutive same-peerId messages', async () => {
      // 阻塞处理，让多条消息排队
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      // 第一条消息开始处理（阻塞）
      const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/test/project', { interruptible: false });
      // 同一 peerId 的后续消息排队
      const p1 = q.enqueue('s1', makeMsg('aaa', { messageId: 'id1' }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('bbb', { messageId: 'id2' }), '/test/project', { interruptible: false });
      const p3 = q.enqueue('s1', makeMsg('ccc', { messageId: 'id3' }), '/test/project', { interruptible: false });

      resolveFirst();
      await Promise.all([p0, p1, p2, p3]);

      // 第一条单独处理，后三条合并为一条
      expect(handledMessages).toHaveLength(2);
      expect(handledMessages[0].content).toBe('block');
      expect(handledMessages[1].content).toBe('aaa\nbbb\nccc');
      // 合并后保留最新一条的 messageId（用于 thought 锚定与中断追踪）
      expect(handledMessages[1].messageId).toBe('id3');
    });

    it('should stop merging at different peerId', async () => {
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/test/project', { interruptible: false });
      // u1 的两条，然后 u2 的一条，然后 u1 的一条
      const p1 = q.enqueue('s1', makeMsg('u1-a', { peerId: 'u1' }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('u1-b', { peerId: 'u1' }), '/test/project', { interruptible: false });
      const p3 = q.enqueue('s1', makeMsg('u2-a', { peerId: 'u2' }), '/test/project', { interruptible: false });
      const p4 = q.enqueue('s1', makeMsg('u1-c', { peerId: 'u1' }), '/test/project', { interruptible: false });

      resolveFirst();
      await Promise.all([p0, p1, p2, p3, p4]);

      // block(u0) → u1-a+u1-b(合并) → u2-a(单独) → u1-c(单独)
      expect(handledMessages).toHaveLength(4);
      expect(handledMessages[0].content).toBe('block');
      expect(handledMessages[1].content).toBe('u1-a\nu1-b');
      expect(handledMessages[2].content).toBe('u2-a');
      expect(handledMessages[3].content).toBe('u1-c');
    });

    it('should merge images and mentions from multiple messages', async () => {
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      const img1 = { data: 'base64a', mimeType: 'image/png' };
      const img2 = { data: 'base64b', mimeType: 'image/jpeg' };
      const m1 = { userId: 'u1', name: 'Alice' };
      const m2 = { userId: 'u2', name: 'Bob' };

      const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/test/project', { interruptible: false });
      const p1 = q.enqueue('s1', makeMsg('text1', { images: [img1], mentions: [m1] }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('text2', { images: [img2], mentions: [m2] }), '/test/project', { interruptible: false });

      resolveFirst();
      await Promise.all([p0, p1, p2]);

      const merged = handledMessages[1];
      expect(merged.content).toBe('text1\ntext2');
      expect(merged.images).toEqual([img1, img2]);
      expect(merged.mentions).toEqual([m1, m2]);
    });

    it('should use last message peerName and replyContext', async () => {
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      const reply1 = { replyToMessageId: 'r1' };
      const reply2 = { replyToMessageId: 'r2' };

      const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/test/project', { interruptible: false });
      const p1 = q.enqueue('s1', makeMsg('a', { peerName: 'Alice', replyContext: reply1 }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('b', { peerName: 'Bob', replyContext: reply2 }), '/test/project', { interruptible: false });

      resolveFirst();
      await Promise.all([p0, p1, p2]);

      const merged = handledMessages[1];
      expect(merged.peerName).toBe('Bob');
      expect(merged.replyContext).toEqual(reply2);
    });

    it('should not merge single message (no-op)', async () => {
      await queue.enqueue('s1', makeMsg('only-one'), '/test/project');

      expect(handledMessages).toHaveLength(1);
      expect(handledMessages[0].content).toBe('only-one');
    });

    it('should preserve mentionUserIds in replyContext after merge', async () => {
      let resolveFirst!: () => void;
      const blockHandler = vi.fn(async (msg: Message) => {
        if (msg.content === 'block') {
          await new Promise<void>(r => { resolveFirst = r; });
        }
        handledMessages.push(msg);
      });
      const q = new MessageQueue(blockHandler);

      const reply1 = { threadId: 'task_1', mentionUserIds: ['alice.agentid.pub'] };
      const reply2 = { threadId: 'task_1', mentionUserIds: ['all'] };

      const p0 = q.enqueue('s1', makeMsg('block', { peerId: 'u0' }), '/test/project', { interruptible: false });
      const p1 = q.enqueue('s1', makeMsg('first', { peerId: 'alice', replyContext: reply1 }), '/test/project', { interruptible: false });
      const p2 = q.enqueue('s1', makeMsg('second', { peerId: 'alice', replyContext: reply2 }), '/test/project', { interruptible: false });

      resolveFirst();
      await Promise.all([p0, p1, p2]);

      const merged = handledMessages[1];
      expect(merged.content).toBe('first\nsecond');
      expect(merged.replyContext).toEqual(reply2);
      expect(merged.replyContext?.mentionUserIds).toEqual(['all']);
    });
  });

  // ── isChannelProcessing ──

  describe('isChannelProcessing', () => {
    it('returns true when any session under channel is processing', async () => {
      let resolveHandler!: () => void;
      const blockingHandler = vi.fn(async () => {
        await new Promise<void>(r => { resolveHandler = r; });
      });
      const q = new MessageQueue(blockingHandler);

      // sessionKey shape used in production: `${channelName}-${channelId}-${ts}`
      const p = q.enqueue('feishu-chat-123', makeMsg('hi', { channel: 'feishu' }), '/tmp');
      // Allow processNext to mark the queue as processing
      await new Promise(r => setTimeout(r, 10));

      expect(q.isChannelProcessing('feishu')).toBe(true);
      expect(q.isChannelProcessing('wechat')).toBe(false);

      resolveHandler();
      await p;
      expect(q.isChannelProcessing('feishu')).toBe(false);
    });

    it('returns false when no session is processing for the channel', () => {
      expect(queue.isChannelProcessing('feishu')).toBe(false);
      expect(queue.isChannelProcessing('aun')).toBe(false);
    });
  });
});
