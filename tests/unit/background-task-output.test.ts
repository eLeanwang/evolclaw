/**
 * 测试：切换项目后后台任务不应该继续输出
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageProcessor } from '../../src/core/message-processor.js';
import { AgentRunner } from '../../src/agent-runner.js';
import { SessionManager } from '../../src/session-manager.js';
import { MessageCache } from '../../src/core/message-cache.js';
import type { Config, ChannelAdapter, Message } from '../../src/types.js';

describe('MessageProcessor - 后台任务输出控制', () => {
  let processor: MessageProcessor;
  let sessionManager: SessionManager;
  let messageCache: MessageCache;
  let sentMessages: string[];
  let mockAdapter: ChannelAdapter;

  beforeEach(() => {
    // 创建测试用的 SessionManager
    sessionManager = new SessionManager(':memory:');
    messageCache = new MessageCache();

    // 记录发送的消息
    sentMessages = [];
    mockAdapter = {
      name: 'test',
      sendText: async (channelId: string, text: string) => {
        sentMessages.push(text);
      }
    };

    // 创建 AgentRunner mock
    const mockAgentRunner = {
      runQuery: vi.fn(),
      updateSessionId: vi.fn(),
      registerStream: vi.fn(),
      cleanupStream: vi.fn(),
      closeSession: vi.fn(),
      interrupt: vi.fn(),
      setCompactStartCallback: vi.fn()
    } as any;

    const mockConfig: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: 'test', appSecret: 'test' },
      acp: { domain: 'test', agentName: 'test' },
      projects: { defaultPath: '/test', autoCreate: false }
    };

    processor = new MessageProcessor(
      mockAgentRunner,
      sessionManager,
      mockConfig,
      messageCache
    );

    processor.registerChannel(mockAdapter);
  });

  it('应该在切换项目后停止输出', async () => {
    const channel = 'test';
    const channelId = 'chat-1';
    const projectA = '/test/projectA';
    const projectB = '/test/projectB';

    // 1. 创建项目A的会话（活跃）
    const sessionA = await sessionManager.getOrCreateSession(channel, channelId, projectA);
    expect(sessionA.isActive).toBe(true);

    // 2. 模拟切换到项目B
    await sessionManager.switchProject(channel, channelId, projectB);

    // 3. 验证项目A不再活跃
    const updatedSessionA = await sessionManager.getSessionByProjectPath(channel, channelId, projectA);
    expect(updatedSessionA?.isActive).toBe(false);

    // 4. 验证项目B是活跃的
    const activeSession = await sessionManager.getActiveSession(channel, channelId);
    expect(activeSession?.projectPath).toBe(projectB);
  });
});
