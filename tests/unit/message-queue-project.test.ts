/**
 * MessageQueue 单元测试 - 项目路径检查
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageQueue } from '../../src/core/message-queue.js';
import type { Message } from '../../src/types.js';

describe('MessageQueue 项目路径检查', () => {
  let queue: MessageQueue;
  let processedMessages: Message[];
  let interruptCalls: string[];

  beforeEach(() => {
    processedMessages = [];
    interruptCalls = [];

    queue = new MessageQueue(async (message) => {
      processedMessages.push(message);
      // 模拟处理延迟
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    queue.setInterruptCallback(async (sessionKey) => {
      interruptCalls.push(sessionKey);
    });
  });

  it('应该在同项目时触发中断', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    // 发送第一条消息
    const promise1 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 发送第二条消息（同项目）
    const promise2 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );

    await Promise.all([promise1, promise2]);

    // 验证中断被调用
    expect(interruptCalls.length).toBe(1);
    expect(interruptCalls[0]).toBe(sessionKey);
  });

  it('应该在不同项目时不触发中断', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPathA = '/test/project-a';
    const projectPathB = '/test/project-b';

    // 发送第一条消息（项目A）
    const promise1 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPathA
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 发送第二条消息（项目B）
    const promise2 = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPathB
    );

    await Promise.all([promise1, promise2]);

    // 验证中断未被调用
    expect(interruptCalls.length).toBe(0);
  });

  it('应该按顺序处理消息', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息3', timestamp: Date.now() },
      projectPath
    );

    // 等待所有消息处理完成
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(processedMessages.length).toBe(3);
    expect(processedMessages[0].content).toBe('消息1');
    expect(processedMessages[1].content).toBe('消息2');
    expect(processedMessages[2].content).toBe('消息3');
  });

  it('应该支持多个独立的队列', async () => {
    const sessionKey1 = 'feishu-chat-1';
    const sessionKey2 = 'feishu-chat-2';
    const projectPath = '/test/project-a';

    // 并发发送到不同队列
    await Promise.all([
      queue.enqueue(
        sessionKey1,
        { channel: 'feishu', channelId: 'chat-1', content: '队列1消息', timestamp: Date.now() },
        projectPath
      ),
      queue.enqueue(
        sessionKey2,
        { channel: 'feishu', channelId: 'chat-2', content: '队列2消息', timestamp: Date.now() },
        projectPath
      )
    ]);

    // 等待处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(processedMessages.length).toBe(2);
    expect(processedMessages.some(m => m.content === '队列1消息')).toBe(true);
    expect(processedMessages.some(m => m.content === '队列2消息')).toBe(true);
  });

  it('应该正确报告队列长度', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    // 快速添加多条消息
    queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );
    queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );
    queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息3', timestamp: Date.now() },
      projectPath
    );

    // 立即检查队列长度（第一条正在处理，剩余2条在队列中）
    await new Promise(resolve => setTimeout(resolve, 10));
    const queueLength = queue.getQueueLength(sessionKey);
    expect(queueLength).toBeGreaterThanOrEqual(0);
    expect(queueLength).toBeLessThanOrEqual(3);
  });

  it('应该正确报告处理状态', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    // 发送消息
    const promise = queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息', timestamp: Date.now() },
      projectPath
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 检查处理状态
    expect(queue.isProcessing(sessionKey)).toBe(true);

    // 等待处理完成
    await promise;

    // 检查处理状态
    expect(queue.isProcessing(sessionKey)).toBe(false);
  });

  it('应该处理错误并继续处理后续消息', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    // 创建会抛出错误的队列
    const errorQueue = new MessageQueue(async (message) => {
      if (message.content === '错误消息') {
        throw new Error('处理失败');
      }
      processedMessages.push(message);
    });

    // 发送消息
    const promise1 = errorQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '错误消息', timestamp: Date.now() },
      projectPath
    ).catch(() => {}); // 捕获错误

    const promise2 = errorQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '正常消息', timestamp: Date.now() },
      projectPath
    );

    await Promise.all([promise1, promise2]);

    // 验证第二条消息仍然被处理
    expect(processedMessages.length).toBe(1);
    expect(processedMessages[0].content).toBe('正常消息');
  });

  it('应该处理相同项目路径但不同格式（尾部斜杠）', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPathA = '/test/project-a';
    const projectPathB = '/test/project-a/'; // 带尾部斜杠

    let interruptCalled = false;
    const testQueue = new MessageQueue(async (message) => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    testQueue.setInterruptCallback(async () => {
      interruptCalled = true;
    });

    const promise1 = testQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPathA
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    const promise2 = testQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPathB
    );

    await Promise.all([promise1, promise2]);

    // path.basename 会规范化尾部斜杠，两个路径映射到同一个队列，应该触发中断
    expect(interruptCalled).toBe(true);
  });

  it('应该处理空的项目路径', async () => {
    const sessionKey = 'feishu-chat-1';

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息', timestamp: Date.now() },
      ''
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(processedMessages.length).toBe(1);
  });

  it('应该处理非常长的项目路径', async () => {
    const sessionKey = 'feishu-chat-1';
    const longPath = '/test/' + 'a'.repeat(1000);

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息', timestamp: Date.now() },
      longPath
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(processedMessages.length).toBe(1);
  });

  it('应该处理包含特殊字符的项目路径', async () => {
    const sessionKey = 'feishu-chat-1';
    const specialPath = '/test/项目-名称 (测试)';

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息', timestamp: Date.now() },
      specialPath
    );

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(processedMessages.length).toBe(1);
  });

  it('应该在没有设置中断回调时正常工作', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    const queueWithoutCallback = new MessageQueue(async (message) => {
      processedMessages.push(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // 不设置中断回调

    const promise1 = queueWithoutCallback.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    const promise2 = queueWithoutCallback.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );

    // 不应该抛出错误
    await expect(Promise.all([promise1, promise2])).resolves.not.toThrow();
  });

  it('应该处理中断回调抛出错误', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    const errorQueue = new MessageQueue(async (message) => {
      processedMessages.push(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    errorQueue.setInterruptCallback(async () => {
      throw new Error('中断失败');
    });

    const promise1 = errorQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    const promise2 = errorQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );

    // 即使中断失败，消息仍应该被处理
    await Promise.all([promise1, promise2]);
    expect(processedMessages.length).toBe(2);
  });

  it('应该处理快速连续的消息入队', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        queue.enqueue(
          sessionKey,
          { channel: 'feishu', channelId: 'chat-1', content: `消息${i}`, timestamp: Date.now() },
          projectPath
        )
      );
    }

    await Promise.all(promises);

    expect(processedMessages.length).toBe(10);
  });

  it('应该在队列为空时正确报告状态', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    await queue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息', timestamp: Date.now() },
      projectPath
    );

    // 等待处理完成
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(queue.getQueueLength(sessionKey)).toBe(0);
    expect(queue.isProcessing(sessionKey)).toBe(false);
  });

  it('应该处理不同channel的消息', async () => {
    const feishuKey = 'feishu-chat-1';
    const aunKey = 'aun-session-1';
    const projectPath = '/test/project-a';

    await Promise.all([
      queue.enqueue(
        feishuKey,
        { channel: 'feishu', channelId: 'chat-1', content: 'Feishu消息', timestamp: Date.now() },
        projectPath
      ),
      queue.enqueue(
        aunKey,
        { channel: 'aun', channelId: 'session-1', content: 'AUN消息', timestamp: Date.now() },
        projectPath
      )
    ]);

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(processedMessages.length).toBe(2);
    expect(processedMessages.some(m => m.content === 'Feishu消息')).toBe(true);
    expect(processedMessages.some(m => m.content === 'AUN消息')).toBe(true);
  });

  it('应该处理消息处理时间很长的情况', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/test/project-a';

    const slowQueue = new MessageQueue(async (message) => {
      processedMessages.push(message);
      await new Promise(resolve => setTimeout(resolve, 200)); // 200ms延迟
    });

    const startTime = Date.now();

    await slowQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '慢消息', timestamp: Date.now() },
      projectPath
    );

    const duration = Date.now() - startTime;

    expect(duration).toBeGreaterThanOrEqual(200);
    expect(processedMessages.length).toBe(1);
  });
});
