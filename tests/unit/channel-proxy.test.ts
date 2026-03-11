/**
 * ChannelProxy 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelProxy, asyncLocalStorage } from '../../src/core/channel-proxy.js';
import { MessageCache } from '../../src/core/message-cache.js';
import type { ChannelAdapter } from '../../src/types.js';
import type { SessionManager } from '../../src/core/session-manager.js';

describe('ChannelProxy 单元测试', () => {
  let mockChannel: ChannelAdapter;
  let mockSessionManager: SessionManager;
  let messageCache: MessageCache;
  let proxy: ChannelProxy;
  let sentMessages: Array<{ channelId: string; text: string }>;

  beforeEach(() => {
    sentMessages = [];

    // Mock Channel
    mockChannel = {
      name: 'feishu',
      sendText: vi.fn(async (channelId: string, text: string) => {
        sentMessages.push({ channelId, text });
      }),
      sendFile: vi.fn()
    };

    // Mock SessionManager
    mockSessionManager = {
      getOrCreateSession: vi.fn(async (channel, channelId, defaultPath) => ({
        id: `${channel}-${channelId}-active`,
        channel,
        channelId,
        projectPath: '/test/project',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }))
    } as any;

    messageCache = new MessageCache();
    proxy = new ChannelProxy(mockChannel, mockSessionManager, messageCache);
  });

  it('应该在没有上下文时直接发送消息', async () => {
    await proxy.sendText('chat-1', '测试消息');

    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '测试消息');
    expect(sentMessages.length).toBe(1);
    expect(messageCache.getCount('any-session')).toBe(0);
  });

  it('应该在活跃项目时直接发送消息', async () => {
    const sessionId = 'feishu-chat-1-active';

    await asyncLocalStorage.run({ sessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '测试消息');
    expect(sentMessages.length).toBe(1);
    expect(messageCache.getCount(sessionId)).toBe(0);
  });

  it('应该在非活跃项目时缓存消息', async () => {
    const currentSessionId = 'feishu-chat-1-inactive';

    await asyncLocalStorage.run({ sessionId: currentSessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    // 消息不应该被发送
    expect(mockChannel.sendText).not.toHaveBeenCalled();
    expect(sentMessages.length).toBe(0);

    // 消息应该被缓存
    expect(messageCache.getCount(currentSessionId)).toBe(1);
    const cached = messageCache.getAll(currentSessionId);
    expect(cached[0].text).toBe('测试消息');
  });

  it('应该正确解析sessionId', async () => {
    const sessionId = 'feishu-chat-123-456-timestamp';

    await asyncLocalStorage.run({ sessionId }, async () => {
      await proxy.sendText('chat-123-456', '测试消息');
    });

    // 验证 getOrCreateSession 被正确调用
    expect(mockSessionManager.getOrCreateSession).toHaveBeenCalledWith(
      'feishu',
      'chat-123-456',
      expect.any(String)
    );
  });

  it('应该透传文件发送', async () => {
    await proxy.sendFile('chat-1', '/path/to/file.txt');

    expect(mockChannel.sendFile).toHaveBeenCalledWith('chat-1', '/path/to/file.txt');
  });

  it('应该保持channel名称', () => {
    expect(proxy.name).toBe('feishu');
  });

  it('应该处理无效的sessionId格式', async () => {
    const invalidSessionId = 'invalid';

    await asyncLocalStorage.run({ sessionId: invalidSessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    // 应该直接发送（因为无法解析）
    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '测试消息');
    expect(sentMessages.length).toBe(1);
  });

  it('应该支持多个并发上下文', async () => {
    const session1 = 'feishu-chat-1-active';
    const session2 = 'feishu-chat-2-inactive';

    // 并发执行两个上下文
    await Promise.all([
      asyncLocalStorage.run({ sessionId: session1 }, async () => {
        await proxy.sendText('chat-1', '消息1');
      }),
      asyncLocalStorage.run({ sessionId: session2 }, async () => {
        await proxy.sendText('chat-2', '消息2');
      })
    ]);

    // session1 应该发送
    expect(sentMessages.some(m => m.text === '消息1')).toBe(true);

    // session2 应该缓存
    expect(messageCache.getCount(session2)).toBe(1);
  });

  it('应该处理嵌套的AsyncLocalStorage上下文', async () => {
    const outerSession = 'feishu-chat-1-active';
    const innerSession = 'feishu-chat-2-inactive';

    await asyncLocalStorage.run({ sessionId: outerSession }, async () => {
      await proxy.sendText('chat-1', '外层消息');

      await asyncLocalStorage.run({ sessionId: innerSession }, async () => {
        await proxy.sendText('chat-2', '内层消息');
      });

      await proxy.sendText('chat-1', '外层消息2');
    });

    // 外层消息应该发送
    expect(sentMessages.filter(m => m.text.includes('外层')).length).toBe(2);

    // 内层消息应该缓存
    expect(messageCache.getCount(innerSession)).toBe(1);
  });

  it('应该处理空的channelId', async () => {
    await proxy.sendText('', '测试消息');
    expect(mockChannel.sendText).toHaveBeenCalledWith('', '测试消息');
  });

  it('应该处理空的消息文本', async () => {
    await proxy.sendText('chat-1', '');
    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '');
  });

  it('应该处理非常长的sessionId', async () => {
    const longSessionId = 'feishu-' + 'a'.repeat(1000) + '-active';

    await asyncLocalStorage.run({ sessionId: longSessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    // 应该能正常处理
    expect(mockChannel.sendText).toHaveBeenCalled();
  });

  it('应该处理包含特殊字符的sessionId', async () => {
    const specialSessionId = 'feishu-chat@#$%^&*()-active';

    await asyncLocalStorage.run({ sessionId: specialSessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    expect(mockChannel.sendText).toHaveBeenCalled();
  });

  it('应该处理只有一个部分的sessionId', async () => {
    const invalidSessionId = 'feishu';

    await asyncLocalStorage.run({ sessionId: invalidSessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    // 应该直接发送（因为无法解析）
    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '测试消息');
  });

  it('应该处理sendFile为undefined的channel', async () => {
    const channelWithoutFile: ChannelAdapter = {
      name: 'acp',
      sendText: vi.fn()
    };

    const proxyWithoutFile = new ChannelProxy(channelWithoutFile, mockSessionManager, messageCache);

    // 不应该抛出错误
    await expect(proxyWithoutFile.sendFile('chat-1', '/path/to/file')).resolves.not.toThrow();
  });

  it('应该在SessionManager抛出错误时直接发送', async () => {
    mockSessionManager.getOrCreateSession = vi.fn(async () => {
      throw new Error('Database error');
    });

    const sessionId = 'feishu-chat-1-test';

    await asyncLocalStorage.run({ sessionId }, async () => {
      await proxy.sendText('chat-1', '测试消息');
    });

    // 应该直接发送（因为无法获取活跃session）
    expect(mockChannel.sendText).toHaveBeenCalledWith('chat-1', '测试消息');
  });

  it('应该处理快速连续的消息发送', async () => {
    const sessionId = 'feishu-chat-1-active';

    await asyncLocalStorage.run({ sessionId }, async () => {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(proxy.sendText('chat-1', `消息 ${i}`));
      }
      await Promise.all(promises);
    });

    expect(sentMessages.length).toBe(100);
  });

  it('应该为不同的channel类型工作', async () => {
    const acpChannel: ChannelAdapter = {
      name: 'acp',
      sendText: vi.fn()
    };

    const acpProxy = new ChannelProxy(acpChannel, mockSessionManager, messageCache);
    expect(acpProxy.name).toBe('acp');

    await acpProxy.sendText('session-1', '测试消息');
    expect(acpChannel.sendText).toHaveBeenCalled();
  });

  it('应该在缓存消息时保留消息顺序', async () => {
    const sessionId = 'feishu-chat-1-inactive';

    await asyncLocalStorage.run({ sessionId }, async () => {
      await proxy.sendText('chat-1', '消息1');
      await proxy.sendText('chat-1', '消息2');
      await proxy.sendText('chat-1', '消息3');
    });

    const cached = messageCache.getAll(sessionId);
    expect(cached.length).toBe(3);
    expect(cached[0].text).toBe('消息1');
    expect(cached[1].text).toBe('消息2');
    expect(cached[2].text).toBe('消息3');
  });
});
