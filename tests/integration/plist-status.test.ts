/**
 * /plist 命令状态显示测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/core/message-queue.js';
import { MessageCache } from '../../src/core/message-cache.js';
import type { Message } from '../../src/types.js';

describe('/plist 状态显示集成测试', () => {
  let messageQueue: MessageQueue;
  let messageCache: MessageCache;
  let processedMessages: Message[];

  beforeEach(() => {
    processedMessages = [];
    messageQueue = new MessageQueue(async (message) => {
      processedMessages.push(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    messageCache = new MessageCache();
  });

  it('应该正确返回正在处理的项目路径', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/home/project-a';

    // 发送消息
    const promise = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '测试', timestamp: Date.now() },
      projectPath
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 查询正在处理的项目
    const processingProject = messageQueue.getProcessingProject(sessionKey);
    expect(processingProject).toBe(projectPath);

    await promise;
  });

  it('应该在处理完成后返回 undefined', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/home/project-a';

    await messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '测试', timestamp: Date.now() },
      projectPath
    );

    // 处理完成后查询
    const processingProject = messageQueue.getProcessingProject(sessionKey);
    expect(processingProject).toBeUndefined();
  });

  it('应该在不同项目间切换时正确跟踪', async () => {
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
    expect(messageQueue.getProcessingProject(sessionKey)).toBe(projectA);

    await promise1;

    // 发送项目B的消息
    const promise2 = messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息B', timestamp: Date.now() },
      projectB
    );

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(messageQueue.getProcessingProject(sessionKey)).toBe(projectB);

    await promise2;
  });

  it('应该正确处理路径规范化（去除尾部斜杠）', () => {
    const normalizePath = (p: string) => p.replace(/\/+$/, '');

    expect(normalizePath('/home/project')).toBe('/home/project');
    expect(normalizePath('/home/project/')).toBe('/home/project');
    expect(normalizePath('/home/project//')).toBe('/home/project');
    expect(normalizePath('/home/project///')).toBe('/home/project');
  });

  it('应该正确计算队列长度', async () => {
    const sessionKey = 'feishu-chat-1';
    const projectPath = '/home/project-a';

    // 快速添加3条消息
    messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );
    messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息2', timestamp: Date.now() },
      projectPath
    );
    messageQueue.enqueue(
      sessionKey,
      { channel: 'feishu', channelId: 'chat-1', content: '消息3', timestamp: Date.now() },
      projectPath
    );

    // 等待第一条开始处理
    await new Promise(resolve => setTimeout(resolve, 10));

    // 队列长度应该是2（第一条正在处理，不在队列中）
    const queueLength = messageQueue.getQueueLength(sessionKey);
    expect(queueLength).toBe(2);
  });

  it('应该正确跟踪未读消息数', () => {
    const sessionId = 'feishu-chat-1-12345';

    messageCache.addEvent(sessionId, { type: 'completed', message: '消息1', timestamp: Date.now() });
    messageCache.addEvent(sessionId, { type: 'completed', message: '消息2', timestamp: Date.now() });
    messageCache.addEvent(sessionId, { type: 'completed', message: '消息3', timestamp: Date.now() });

    expect(messageCache.getCount(sessionId)).toBe(3);
  });

  it('应该在多个会话间独立跟踪状态', async () => {
    const sessionKey1 = 'feishu-chat-1';
    const sessionKey2 = 'feishu-chat-2';
    const projectPath = '/home/project-a';

    // 会话1发送消息
    const promise1 = messageQueue.enqueue(
      sessionKey1,
      { channel: 'feishu', channelId: 'chat-1', content: '消息1', timestamp: Date.now() },
      projectPath
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    // 会话1正在处理
    expect(messageQueue.getProcessingProject(sessionKey1)).toBe(projectPath);
    // 会话2没有处理
    expect(messageQueue.getProcessingProject(sessionKey2)).toBeUndefined();

    await promise1;
  });
});
