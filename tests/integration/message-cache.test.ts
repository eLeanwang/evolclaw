/**
 * 消息缓存机制集成测试
 * 测试项目切换时的消息缓存和刷新功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/core/session-manager.js';
import { AgentRunner } from '../../src/core/agent-runner.js';
import { MessageProcessor } from '../../src/core/message-processor.js';
import { MessageQueue } from '../../src/core/message-queue.js';
import { MessageCache } from '../../src/core/message-cache.js';
import { ChannelProxy } from '../../src/core/channel-proxy.js';
import { MockFeishuClient } from '../mock-feishu-client.js';
import type { ChannelAdapter, Config } from '../../src/types.js';
import fs from 'fs';
import path from 'path';

describe('消息缓存机制集成测试', () => {
  let sessionManager: SessionManager;
  let agentRunner: AgentRunner;
  let messageCache: MessageCache;
  let processor: MessageProcessor;
  let messageQueue: MessageQueue;
  let mockFeishu: MockFeishuClient;
  let testDbPath: string;
  let testProjectA: string;
  let testProjectB: string;

  beforeEach(async () => {
    // 创建测试数据库
    testDbPath = './data/test-message-cache.db';
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // 创建测试项目目录
    testProjectA = './data/test-project-a';
    testProjectB = './data/test-project-b';
    fs.mkdirSync(testProjectA, { recursive: true });
    fs.mkdirSync(testProjectB, { recursive: true });

    // 初始化组件
    sessionManager = new SessionManager(testDbPath);
    messageCache = new MessageCache();

    // 模拟 AgentRunner（不实际调用 API）
    agentRunner = {
      runQuery: async () => {
        // 模拟返回一个简单的事件流
        return (async function* () {
          yield { type: 'result', result: '这是一个测试响应' };
        })();
      },
      registerStream: () => {},
      cleanupStream: () => {},
      updateSessionId: () => {},
      interrupt: async () => {},
      closeSession: async () => {}
    } as any;

    // 创建 MockFeishu
    mockFeishu = new MockFeishuClient();

    // 创建配置
    const config: Config = {
      anthropic: { apiKey: 'test-key' },
      feishu: { appId: 'test-app', appSecret: 'test-secret' },
      acp: { domain: 'test-domain', agentName: 'test-agent' },
      projects: {
        defaultPath: testProjectA,
        autoCreate: true,
        list: {
          projectA: testProjectA,
          projectB: testProjectB
        }
      },
      flushDelay: 100 // 缩短延迟以加快测试
    };

    // 创建 ChannelAdapter
    const feishuAdapter: ChannelAdapter = {
      name: 'feishu',
      sendText: (channelId, text) => mockFeishu.sendMessage(channelId, text),
      sendFile: (channelId, filePath) => mockFeishu.sendFile(channelId, filePath)
    };

    // 创建 ChannelProxy
    const feishuProxy = new ChannelProxy(feishuAdapter, sessionManager, messageCache);

    // 创建 MessageProcessor
    processor = new MessageProcessor(
      agentRunner,
      sessionManager,
      config,
      messageCache
    );

    processor.registerChannel(feishuProxy, feishuAdapter, {
      fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g
    });

    // 创建 MessageQueue
    messageQueue = new MessageQueue(async (message) => {
      await processor.processMessage(message);
    });

    messageQueue.setInterruptCallback(async (sessionKey) => {
      await agentRunner.interrupt(sessionKey);
    });
  });

  afterEach(() => {
    sessionManager.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testProjectA)) {
      fs.rmSync(testProjectA, { recursive: true });
    }
    if (fs.existsSync(testProjectB)) {
      fs.rmSync(testProjectB, { recursive: true });
    }
  });

  it('场景1：基本消息缓存 - 切换项目时消息被缓存', async () => {
    const chatId = 'test-chat-1';

    // 1. 在项目 A 中发送消息
    await messageQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content: '请生成一个长文本', timestamp: Date.now() },
      testProjectA
    );

    // 等待消息处理完成
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证消息已发送
    const messagesBeforeSwitch = mockFeishu.getSentMessages(chatId);
    expect(messagesBeforeSwitch.length).toBeGreaterThan(0);
    mockFeishu.clear();

    // 2. 切换到项目 B
    await sessionManager.switchProject('feishu', chatId, testProjectB);

    // 3. 在项目 A 中继续发送消息（模拟后台任务）
    const sessionA = await sessionManager.getSessionByProjectPath('feishu', chatId, testProjectA);
    expect(sessionA).toBeDefined();

    // 模拟项目 A 的消息被缓存
    messageCache.add(sessionA!.id, '这是项目A的缓存消息1');
    messageCache.add(sessionA!.id, '这是项目A的缓存消息2');

    // 验证缓存
    expect(messageCache.getCount(sessionA!.id)).toBe(2);
    expect(messageCache.hasMessages(sessionA!.id)).toBe(true);

    // 4. 切换回项目 A
    await sessionManager.switchProject('feishu', chatId, testProjectA);

    // 5. 刷新缓存消息
    await processor.flushCachedMessages('feishu', chatId, sessionA!.id, testProjectA, 100);

    // 等待消息发送
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证缓存消息已发送
    const cachedMessages = mockFeishu.getSentMessages(chatId);
    expect(cachedMessages.length).toBe(2);
    expect(cachedMessages[0].content).toContain('项目A的缓存消息1');
    expect(cachedMessages[1].content).toContain('项目A的缓存消息2');

    // 验证缓存已清空
    expect(messageCache.getCount(sessionA!.id)).toBe(0);
  });

  it('场景2：同项目中断仍然生效', async () => {
    const chatId = 'test-chat-2';

    // 创建一个新的 MessageQueue 来测试中断
    let interruptCalled = false;
    const testQueue = new MessageQueue(async (message) => {
      await new Promise(resolve => setTimeout(resolve, 100)); // 模拟处理延迟
    });

    testQueue.setInterruptCallback(async (sessionKey) => {
      interruptCalled = true;
    });

    // 1. 在项目 A 中发送第一条消息
    const promise1 = testQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content: '第一条消息', timestamp: Date.now() },
      testProjectA
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 20));

    // 2. 在项目 A 中发送第二条消息（应该触发中断）
    const promise2 = testQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content: '第二条消息', timestamp: Date.now() },
      testProjectA
    );

    // 等待处理完成
    await Promise.all([promise1, promise2]);

    // 验证中断被调用
    expect(interruptCalled).toBe(true);
  });

  it('场景3：不同项目不触发中断', async () => {
    const chatId = 'test-chat-3';

    // 创建一个新的 MessageQueue 来测试中断
    let interruptCalled = false;
    const testQueue = new MessageQueue(async (message) => {
      await new Promise(resolve => setTimeout(resolve, 100)); // 模拟处理延迟
    });

    testQueue.setInterruptCallback(async (sessionKey) => {
      interruptCalled = true;
    });

    // 1. 在项目 A 中发送消息
    const promise1 = testQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content: '项目A消息', timestamp: Date.now() },
      testProjectA
    );

    // 等待开始处理
    await new Promise(resolve => setTimeout(resolve, 20));

    // 2. 在项目 B 中发送消息（不应该触发中断）
    const promise2 = testQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content: '项目B消息', timestamp: Date.now() },
      testProjectB
    );

    // 等待处理完成
    await Promise.all([promise1, promise2]);

    // 验证中断未被调用
    expect(interruptCalled).toBe(false);
  });

  it('场景4：文件发送处理 - 文件存在', async () => {
    const chatId = 'test-chat-4';

    // 创建测试文件
    const testFile = path.join(testProjectA, 'test.txt');
    fs.writeFileSync(testFile, 'test content');

    // 模拟缓存包含文件标记的消息
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '文件已创建 [SEND_FILE:test.txt]');

    // 刷新缓存消息
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    // 等待处理完成
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证文本消息已发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBeGreaterThan(0);

    // 验证文件已发送
    const files = mockFeishu.getSentFiles(chatId);
    expect(files.length).toBe(1);
    expect(files[0].filePath).toContain('test.txt');

    // 清理
    fs.unlinkSync(testFile);
  });

  it('场景5：文件发送处理 - 文件不存在', async () => {
    const chatId = 'test-chat-5';

    // 模拟缓存包含文件标记的消息（文件不存在）
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '文件已创建 [SEND_FILE:nonexistent.txt]');

    // 刷新缓存消息
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    // 等待处理完成
    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证文本消息已发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBeGreaterThan(0);

    // 验证文件未发送
    const files = mockFeishu.getSentFiles(chatId);
    expect(files.length).toBe(0);

    // 验证发送了文件不存在的提示
    const warningMessage = messages.find(m => m.content.includes('文件已不存在'));
    expect(warningMessage).toBeDefined();
    expect(warningMessage!.content).toContain('nonexistent.txt');
  });

  it('场景6：缓存上限测试 - 最多100条消息', async () => {
    const chatId = 'test-chat-6';
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);

    // 添加 150 条消息
    for (let i = 0; i < 150; i++) {
      messageCache.add(sessionA.id, `消息 ${i}`);
    }

    // 验证只保留了最后 100 条
    expect(messageCache.getCount(sessionA.id)).toBe(100);

    const messages = messageCache.getAll(sessionA.id);
    expect(messages[0].text).toContain('消息 50'); // 前 50 条被删除
    expect(messages[99].text).toContain('消息 149');
  });

  it('场景7：多聊天独立性', async () => {
    const chatId1 = 'test-chat-7a';
    const chatId2 = 'test-chat-7b';

    // 在聊天1的项目A中添加缓存消息
    const session1A = await sessionManager.getOrCreateSession('feishu', chatId1, testProjectA);
    messageCache.add(session1A.id, '聊天1的消息');

    // 在聊天2的项目A中添加缓存消息
    const session2A = await sessionManager.getOrCreateSession('feishu', chatId2, testProjectA);
    messageCache.add(session2A.id, '聊天2的消息');

    // 验证缓存独立
    expect(messageCache.getCount(session1A.id)).toBe(1);
    expect(messageCache.getCount(session2A.id)).toBe(1);

    const messages1 = messageCache.getAll(session1A.id);
    const messages2 = messageCache.getAll(session2A.id);

    expect(messages1[0].text).toContain('聊天1的消息');
    expect(messages2[0].text).toContain('聊天2的消息');
  });

  it('场景8：切换项目后立即切换回来', async () => {
    const chatId = 'test-chat-8';

    // 在项目A中添加缓存消息
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '项目A的消息1');
    messageCache.add(sessionA.id, '项目A的消息2');

    // 切换到项目B
    await sessionManager.switchProject('feishu', chatId, testProjectB);

    // 立即切换回项目A
    await sessionManager.switchProject('feishu', chatId, testProjectA);

    // 刷新缓存消息
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证消息被发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(2);
  });

  it('场景9：多个项目同时有缓存消息', async () => {
    const chatId = 'test-chat-9';

    // 在项目A中添加缓存
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '项目A的消息');

    // 切换到项目B并添加缓存
    await sessionManager.switchProject('feishu', chatId, testProjectB);
    const sessionB = await sessionManager.getSessionByProjectPath('feishu', chatId, testProjectB);
    messageCache.add(sessionB!.id, '项目B的消息');

    // 验证两个项目都有缓存
    expect(messageCache.hasMessages(sessionA.id)).toBe(true);
    expect(messageCache.hasMessages(sessionB!.id)).toBe(true);

    // 切换回项目A并刷新
    await sessionManager.switchProject('feishu', chatId, testProjectA);
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证只有项目A的消息被发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.some(m => m.content.includes('项目A'))).toBe(true);
    expect(messages.some(m => m.content.includes('项目B'))).toBe(false);

    // 项目B的缓存仍然存在
    expect(messageCache.hasMessages(sessionB!.id)).toBe(true);
  });

  it('场景10：缓存消息包含多个文件标记', async () => {
    const chatId = 'test-chat-10';

    // 创建测试文件
    const file1 = path.join(testProjectA, 'file1.txt');
    const file2 = path.join(testProjectA, 'file2.txt');
    fs.writeFileSync(file1, 'content1');
    fs.writeFileSync(file2, 'content2');

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '文件已创建 [SEND_FILE:file1.txt] 和 [SEND_FILE:file2.txt]');

    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证两个文件都被发送
    const files = mockFeishu.getSentFiles(chatId);
    expect(files.length).toBe(2);
    expect(files.some(f => f.filePath.includes('file1.txt'))).toBe(true);
    expect(files.some(f => f.filePath.includes('file2.txt'))).toBe(true);

    // 清理
    fs.unlinkSync(file1);
    fs.unlinkSync(file2);
  });

  it('场景11：缓存消息包含绝对路径文件', async () => {
    const chatId = 'test-chat-11';

    // 创建测试文件（绝对路径）
    const absoluteFile = path.join(testProjectA, 'absolute.txt');
    fs.writeFileSync(absoluteFile, 'absolute content');

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    // 使用相对路径标记（因为系统会自动解析）
    messageCache.add(sessionA.id, `文件已创建 [SEND_FILE:absolute.txt]`);

    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证文件被发送
    const files = mockFeishu.getSentFiles(chatId);
    expect(files.length).toBe(1);
    expect(files[0].filePath).toContain('absolute.txt');

    // 清理
    fs.unlinkSync(absoluteFile);
  });

  it('场景12：空缓存时刷新不应该发送消息', async () => {
    const chatId = 'test-chat-12';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);

    // 刷新空缓存
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证没有消息被发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(0);
  });

  it('场景13：缓存消息后立即清空', async () => {
    const chatId = 'test-chat-13';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '消息1');
    messageCache.add(sessionA.id, '消息2');

    // 立即清空
    messageCache.clear(sessionA.id);

    // 刷新缓存
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证没有消息被发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(0);
  });

  it('场景14：处理包含特殊字符的消息', async () => {
    const chatId = 'test-chat-14';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    const specialMessage = '特殊字符: \n\t\r <script>alert("xss")</script> 🎉';
    messageCache.add(sessionA.id, specialMessage);

    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证消息被正确发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe(specialMessage);
  });

  it('场景15：处理非常长的缓存消息', async () => {
    const chatId = 'test-chat-15';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    const longMessage = 'A'.repeat(10000);
    messageCache.add(sessionA.id, longMessage);

    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证长消息被正确发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(1);
    expect(messages[0].content.length).toBe(10000);
  });

  it('场景16：文件部分存在部分不存在', async () => {
    const chatId = 'test-chat-16';

    // 只创建一个文件
    const existingFile = path.join(testProjectA, 'existing.txt');
    fs.writeFileSync(existingFile, 'content');

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '文件: [SEND_FILE:existing.txt] [SEND_FILE:missing.txt]');

    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证存在的文件被发送
    const files = mockFeishu.getSentFiles(chatId);
    expect(files.length).toBe(1);
    expect(files[0].filePath.includes('existing.txt')).toBe(true);

    // 验证不存在的文件有提示
    const messages = mockFeishu.getSentMessages(chatId);
    const warningMessage = messages.find(m => m.content.includes('文件已不存在'));
    expect(warningMessage).toBeDefined();
    expect(warningMessage!.content).toContain('missing.txt');

    // 清理
    fs.unlinkSync(existingFile);
  });

  it('场景17：快速连续切换项目', async () => {
    const chatId = 'test-chat-17';

    // 在项目A中添加缓存
    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '项目A的消息');

    // 快速切换：A -> B -> A -> B -> A
    await sessionManager.switchProject('feishu', chatId, testProjectB);
    await sessionManager.switchProject('feishu', chatId, testProjectA);
    await sessionManager.switchProject('feishu', chatId, testProjectB);
    await sessionManager.switchProject('feishu', chatId, testProjectA);

    // 验证缓存仍然存在
    expect(messageCache.hasMessages(sessionA.id)).toBe(true);

    // 刷新缓存
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证消息被发送
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(1);
  });

  it('场景18：缓存达到上限后继续添加', async () => {
    const chatId = 'test-chat-18';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);

    // 添加150条消息
    for (let i = 0; i < 150; i++) {
      messageCache.add(sessionA.id, `消息 ${i}`);
    }

    // 验证只保留了100条
    expect(messageCache.getCount(sessionA.id)).toBe(100);

    // 刷新缓存
    await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);

    await new Promise(resolve => setTimeout(resolve, 200));

    // 验证发送了100条消息
    const messages = mockFeishu.getSentMessages(chatId);
    expect(messages.length).toBe(100);

    // 验证是最后100条（50-149）
    expect(messages[0].content).toContain('消息 50');
    expect(messages[99].content).toContain('消息 149');
  });

  it('场景19：不同channel的消息缓存独立', async () => {
    const feishuChatId = 'feishu-chat-19';
    const acpSessionId = 'acp-session-19';

    // Feishu channel
    const feishuSession = await sessionManager.getOrCreateSession('feishu', feishuChatId, testProjectA);
    messageCache.add(feishuSession.id, 'Feishu消息');

    // ACP channel
    const acpSession = await sessionManager.getOrCreateSession('acp', acpSessionId, testProjectA);
    messageCache.add(acpSession.id, 'ACP消息');

    // 验证缓存独立
    expect(messageCache.getCount(feishuSession.id)).toBe(1);
    expect(messageCache.getCount(acpSession.id)).toBe(1);

    const feishuMessages = messageCache.getAll(feishuSession.id);
    const acpMessages = messageCache.getAll(acpSession.id);

    expect(feishuMessages[0].text).toBe('Feishu消息');
    expect(acpMessages[0].text).toBe('ACP消息');
  });

  it('场景20：发送失败时缓存不会被清空', async () => {
    const chatId = 'test-chat-20';

    const sessionA = await sessionManager.getOrCreateSession('feishu', chatId, testProjectA);
    messageCache.add(sessionA.id, '测试消息');

    // 模拟发送失败
    const originalSendText = mockFeishu.sendMessage;
    let sendAttempted = false;
    mockFeishu.sendMessage = async () => {
      sendAttempted = true;
      throw new Error('发送失败');
    };

    try {
      await processor.flushCachedMessages('feishu', chatId, sessionA.id, testProjectA, 100);
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      // 预期会抛出错误
    }

    // 恢复原始方法
    mockFeishu.sendMessage = originalSendText;

    // 验证发送被尝试
    expect(sendAttempted).toBe(true);

    // 验证缓存未被清空（因为发送失败）
    expect(messageCache.getCount(sessionA.id)).toBe(1);
  });
});
