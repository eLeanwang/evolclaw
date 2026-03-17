/**
 * 项目上下文隔离测试
 * 验证消息在正确的项目上下文中执行
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/core/message-queue.js';
import type { Message } from '../../src/types.js';

describe('项目上下文隔离测试', () => {
  let messageQueue: MessageQueue;
  let processedMessages: Message[];

  beforeEach(() => {
    processedMessages = [];
    messageQueue = new MessageQueue(async (message) => {
      processedMessages.push(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  it('应该在正确的项目上下文中执行消息', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectA = '/home/project-a';
    const projectB = '/home/project-b';

    // 项目A的消息
    const promise1 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息A', timestamp: Date.now() },
      projectA
    );

    // 项目B的消息 (different project = different queue key)
    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息B', timestamp: Date.now() },
      projectB
    );

    await Promise.all([promise1, promise2]);

    // 验证两条消息都被处理
    expect(processedMessages).toHaveLength(2);
    expect(processedMessages[0].content).toBe('消息A');
    expect(processedMessages[1].content).toBe('消息B');
  });

  it('应该通过 getProcessingProject 跟踪当前项目', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/home/molbox';

    const promise = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '测试消息', timestamp: Date.now() },
      projectPath
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    // 正在处理时应该能获取到项目路径
    expect(messageQueue.getProcessingProject(sessionKey)).toBe(projectPath);

    await promise;
  });

  it('应该在多个项目间切换时保持上下文隔离', async () => {
    const sessionKey = 'feishu-chat-1';
    const openclaw = '/data/openclaw-root';
    const molbox = '/home/molbox';

    // 不同项目会产生不同的 queueKey，可以并行处理
    const promise1 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'openclaw任务', timestamp: Date.now() },
      openclaw
    );

    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'molbox任务', timestamp: Date.now() },
      molbox
    );

    const promise3 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'openclaw任务2', timestamp: Date.now() },
      openclaw
    );

    await Promise.all([promise1, promise2, promise3]);

    // 验证所有消息都被处理
    expect(processedMessages).toHaveLength(3);
  });

  it('应该正确跟踪正在处理的项目', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectA = '/home/project-a';
    const projectB = '/home/project-b';

    // 发送项目A的消息
    const promise1 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息A', timestamp: Date.now() },
      projectA
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    // 此时应该正在处理项目A
    expect(messageQueue.getProcessingProject(sessionKey)).toBe(projectA);

    await promise1;

    // 发送项目B的消息
    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息B', timestamp: Date.now() },
      projectB
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    // 此时应该正在处理项目B
    expect(messageQueue.getProcessingProject(sessionKey)).toBe(projectB);

    await promise2;
  });
});