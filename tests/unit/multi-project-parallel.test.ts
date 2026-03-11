/**
 * 多项目并行执行功能测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageCache } from '../../src/core/message-cache.js';
import { MessageQueue } from '../../src/core/message-queue.js';
import type { Message } from '../../src/types.js';

describe('MessageCache', () => {
  let cache: MessageCache;

  beforeEach(() => {
    cache = new MessageCache();
  });

  it('应该能添加和获取事件', () => {
    const sessionId = 'test-session-1';
    const event = {
      type: 'completed' as const,
      message: '任务完成',
      timestamp: Date.now()
    };

    cache.addEvent(sessionId, event);

    const events = cache.getEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('completed');
    expect(events[0].message).toBe('任务完成');
  });

  it('应该能获取事件数量', () => {
    const sessionId = 'test-session-1';

    expect(cache.getCount(sessionId)).toBe(0);

    cache.addEvent(sessionId, {
      type: 'completed',
      message: '任务1',
      timestamp: Date.now()
    });

    expect(cache.getCount(sessionId)).toBe(1);

    cache.addEvent(sessionId, {
      type: 'error',
      message: '任务2失败',
      timestamp: Date.now()
    });

    expect(cache.getCount(sessionId)).toBe(2);
  });

  it('应该能清空事件', () => {
    const sessionId = 'test-session-1';

    cache.addEvent(sessionId, {
      type: 'completed',
      message: '任务完成',
      timestamp: Date.now()
    });

    expect(cache.hasMessages(sessionId)).toBe(true);

    cache.clearEvents(sessionId);

    expect(cache.hasMessages(sessionId)).toBe(false);
    expect(cache.getCount(sessionId)).toBe(0);
  });

  it('应该能清理过期事件', () => {
    const sessionId = 'test-session-1';
    const now = Date.now();

    // 添加一个过期事件（73小时前）
    cache.addEvent(sessionId, {
      type: 'completed',
      message: '过期任务',
      timestamp: now - 73 * 60 * 60 * 1000
    });

    // 添加一个未过期事件
    cache.addEvent(sessionId, {
      type: 'completed',
      message: '新任务',
      timestamp: now
    });

    expect(cache.getCount(sessionId)).toBe(2);

    // 清理过期事件（默认72小时）
    cache.cleanupExpired();

    expect(cache.getCount(sessionId)).toBe(1);
    expect(cache.getEvents(sessionId)[0].message).toBe('新任务');
  });
});

describe('MessageQueue - 项目级队列', () => {
  it('应该为不同项目创建独立队列', async () => {
    const processedMessages: Array<{ message: Message; projectPath: string }> = [];

    const queue = new MessageQueue(async (message) => {
      processedMessages.push({
        message,
        projectPath: message.channelId // 简化测试
      });
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    const sessionKey = 'feishu-chat1';
    const projectA = '/home/projectA';
    const projectB = '/home/projectB';

    // 发送到项目A
    const promise1 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat1', content: '消息A', timestamp: Date.now() },
      projectA
    );

    // 发送到项目B
    const promise2 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat1', content: '消息B', timestamp: Date.now() },
      projectB
    );

    await Promise.all([promise1, promise2]);

    expect(processedMessages).toHaveLength(2);
    expect(processedMessages[0].message.content).toBe('消息A');
    expect(processedMessages[1].message.content).toBe('消息B');
  });

  it('应该能获取正在处理的项目', async () => {
    let resolveHandler: () => void;
    const handlerPromise = new Promise<void>(resolve => {
      resolveHandler = resolve;
    });

    const queue = new MessageQueue(async () => {
      await handlerPromise;
    });

    const sessionKey = 'feishu-chat1';
    const projectPath = '/home/projectA';

    // 发送消息
    const promise = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat1', content: '测试', timestamp: Date.now() },
      projectPath
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 检查正在处理的项目
    const processingProject = queue.getProcessingProject(sessionKey);
    expect(processingProject).toBe(projectPath);

    // 完成处理
    resolveHandler!();
    await promise;

    // 处理完成后应该返回 undefined
    expect(queue.getProcessingProject(sessionKey)).toBeUndefined();
  });
});
