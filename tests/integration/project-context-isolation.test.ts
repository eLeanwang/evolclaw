/**
 * 项目上下文隔离测试
 * 验证消息在正确的项目上下文中执行
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/core/message-queue.js';
import type { Message } from '../../src/types.js';

describe('项目上下文隔离测试', () => {
  let messageQueue: MessageQueue;
  let processedMessages: Array<{ message: Message; projectPath: string }>;

  beforeEach(() => {
    processedMessages = [];
    messageQueue = new MessageQueue(async (message) => {
      // 记录处理的消息及其项目路径
      processedMessages.push({
        message,
        projectPath: message.projectPath || 'unknown'
      });
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

    // 项目B的消息
    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息B', timestamp: Date.now() },
      projectB
    );

    await Promise.all([promise1, promise2]);

    // 验证消息在正确的项目中执行
    expect(processedMessages).toHaveLength(2);
    expect(processedMessages[0].message.content).toBe('消息A');
    expect(processedMessages[0].projectPath).toBe(projectA);
    expect(processedMessages[1].message.content).toBe('消息B');
    expect(processedMessages[1].projectPath).toBe(projectB);
  });

  it('应该保持项目路径在整个处理过程中不变', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/home/molbox';

    await messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '测试消息', timestamp: Date.now() },
      projectPath
    );

    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].projectPath).toBe(projectPath);
    expect(processedMessages[0].message.projectPath).toBe(projectPath);
  });

  it('应该在多个项目间切换时保持上下文隔离', async () => {
    const sessionKey = 'feishu-chat-1';
    const openclaw = '/data/openclaw-root';
    const molbox = '/home/molbox';

    // 模拟用户场景：
    // 1. 在 openclaw 发送消息
    const promise1 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'openclaw任务', timestamp: Date.now() },
      openclaw
    );

    // 2. 切换到 molbox 并发送消息（openclaw 还在处理）
    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'molbox任务', timestamp: Date.now() },
      molbox
    );

    // 3. 再发送一个 openclaw 消息
    const promise3 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: 'openclaw任务2', timestamp: Date.now() },
      openclaw
    );

    await Promise.all([promise1, promise2, promise3]);

    // 验证每个消息都在正确的项目中执行
    expect(processedMessages).toHaveLength(3);
    expect(processedMessages[0].projectPath).toBe(openclaw);
    expect(processedMessages[1].projectPath).toBe(molbox);
    expect(processedMessages[2].projectPath).toBe(openclaw);
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
