import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message-processor.js';
import type { Config, Message, ChannelAdapter } from '../../src/types.js';

// === Mock Factories ===

function createMockAgentRunner(streamEvents: any[], eventDelay = 0) {
  let interruptCalled = false;
  const activeStreams = new Map();

  return {
    interruptCalled: () => interruptCalled,
    runQuery: vi.fn().mockImplementation(async () => {
      const events = [...streamEvents];
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index >= events.length) return { done: true, value: undefined };
              if (eventDelay > 0) await new Promise(r => setTimeout(r, eventDelay));
              return { done: false, value: events[index++] };
            }
          };
        }
      };
    }),
    registerStream: vi.fn().mockImplementation((key: string, stream: any) => {
      activeStreams.set(key, stream);
    }),
    cleanupStream: vi.fn(),
    interrupt: vi.fn().mockImplementation(async () => { interruptCalled = true; }),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    compactSession: vi.fn().mockResolvedValue(false),
  };
}

function createMockSessionManager(overrides: Record<string, any> = {}) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue({
      id: 'test-session', channel: 'feishu', channelId: 'test-channel',
      projectPath: '/tmp/test-project', threadId: '', agentType: 'claude',
      agentSessionId: 'test-claude-session',
      isActive: true, createdAt: Date.now(), updatedAt: Date.now(),
    }),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'test-session', channel: 'feishu', channelId: 'test-channel',
      projectPath: '/tmp/test-project', threadId: '', agentType: 'claude',
      isActive: true,
    }),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({
      consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now(),
    }),
    setSafeMode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockMessageCache() {
  return {
    getCount: vi.fn().mockReturnValue(0),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  };
}

function createMockAdapter(): ChannelAdapter & { sentMessages: string[] } {
  const sentMessages: string[] = [];
  return {
    name: 'feishu' as const,
    sentMessages,
    sendText: vi.fn().mockImplementation(async (_id: string, text: string) => {
      sentMessages.push(text);
    }),
  };
}

function createConfig(ownerUserId?: string): Config {
  return {
    channels: {
      feishu: { appId: '', appSecret: '', ...(ownerUserId ? { owner: ownerUserId } : {}) },
      aun: { domain: '', agentName: '' },
    },
    projects: { defaultPath: '/tmp/test-project', autoCreate: false },
    idleMonitor: { enabled: true, safeModeThreshold: 3, timeout: 0.5 },
  };
}

function createMessage(opts: { userId?: string; isGroup?: boolean; content?: string } = {}): Message {
  return {
    channel: 'feishu',
    channelId: 'test-channel',
    content: opts.content || 'hello',
    userId: opts.userId,
    isGroup: opts.isGroup ?? false,
    timestamp: Date.now(),
  };
}

// 创建挂起流的 runner（永不返回事件，用于触发超时）
function createHangingRunner() {
  const runner = createMockAgentRunner([], 0);
  runner.runQuery.mockImplementation(async () => ({
    [Symbol.asyncIterator]() {
      return { async next() { return new Promise(() => {}); } };
    }
  }));
  return runner;
}

// PLACEHOLDER_TESTS

describe('Owner SafeMode & QuietMode', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('should NOT accumulate errors for non-owner in DM', async () => {
    const runner = createMockAgentRunner([], 0);
    runner.runQuery.mockRejectedValue(new Error('some SDK error'));
    const sessionManager = createMockSessionManager();
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    // 非主人单聊
    const promise = processor.processMessage(createMessage({ userId: 'stranger-456' })).catch(e => e);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(sessionManager.recordError).not.toHaveBeenCalled();
    expect(sessionManager.setSafeMode).not.toHaveBeenCalled();
  });

  it('should NOT accumulate errors in group chat even for owner', async () => {
    const runner = createMockAgentRunner([], 0);
    runner.runQuery.mockRejectedValue(new Error('some SDK error'));
    const sessionManager = createMockSessionManager();
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    // 主人群聊
    const promise = processor.processMessage(createMessage({ userId: 'owner-123', isGroup: true })).catch(e => e);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(sessionManager.recordError).not.toHaveBeenCalled();
    expect(sessionManager.setSafeMode).not.toHaveBeenCalled();
  });

// PLACEHOLDER_TESTS_2

  it('should trigger safe mode after owner DM consecutive errors reach threshold', async () => {
    // 使用挂起流触发 SDK_TIMEOUT（只有超时错误会到达外层 catch 的健康追踪）
    const runner = createHangingRunner();
    const sessionManager = createMockSessionManager({
      recordError: vi.fn().mockResolvedValue(3), // 达到阈值
      getHealthStatus: vi.fn().mockResolvedValue({
        consecutiveErrors: 2, safeMode: false, lastSuccessTime: Date.now(),
      }),
    });
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    const promise = processor.processMessage(createMessage({ userId: 'owner-123' })).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000);
    const error = await promise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');
    expect(sessionManager.recordError).toHaveBeenCalled();
    expect(sessionManager.setSafeMode).toHaveBeenCalledWith('test-session', true);
    expect(adapter.sentMessages.some(m => m.includes('安全模式已启用'))).toBe(true);
  });

  it('should append safe mode hint after successful reply when in safe mode', async () => {
    const events = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'result', result: 'Hello', subtype: 'success' },
    ];
    const runner = createMockAgentRunner(events, 50);
    const sessionManager = createMockSessionManager({
      getHealthStatus: vi.fn().mockResolvedValue({
        consecutiveErrors: 3, safeMode: true, lastSuccessTime: Date.now(),
      }),
    });
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    const promise = processor.processMessage(createMessage({ userId: 'owner-123' }));
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(50);
    // flush delay
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(sessionManager.recordSuccess).toHaveBeenCalled();
    expect(adapter.sentMessages.some(m => m.includes('当前处于安全模式'))).toBe(true);
  });

// PLACEHOLDER_TESTS_3

  it('should send detailed kill diagnostic for owner DM', async () => {
    const runner = createHangingRunner();
    const sessionManager = createMockSessionManager();
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    const promise = processor.processMessage(createMessage({ userId: 'owner-123' })).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000);
    const error = await promise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');
    // 主人收到详细诊断（含 🛑）
    expect(adapter.sentMessages.some(m => m.includes('🛑'))).toBe(true);
  });

  it('should send short kill message for non-owner DM', async () => {
    const runner = createHangingRunner();
    const sessionManager = createMockSessionManager();
    const adapter = createMockAdapter();
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    const promise = processor.processMessage(createMessage({ userId: 'stranger-456' })).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000);
    const error = await promise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');
    // 非主人收到简短提示，不含详细诊断
    expect(adapter.sentMessages.some(m => m.includes('任务超时') && m.includes('已自动中断'))).toBe(true);
    expect(adapter.sentMessages.some(m => m.includes('🛑'))).toBe(false);
  });

  it('should not send duplicate error message on SDK_TIMEOUT', async () => {
    const runner = createHangingRunner();
    const sessionManager = createMockSessionManager();
    const adapter = createMockAdapter();
    // 非主人：quietMode，notify/warn 静默，只有 kill 发一条简短消息
    const config = createConfig('owner-123');

    const processor = new MessageProcessor(runner as any, sessionManager as any, config, createMockMessageCache() as any);
    processor.registerChannel(adapter);

    const promise = processor.processMessage(createMessage({ userId: 'stranger-456' })).catch(e => e);
    await vi.advanceTimersByTimeAsync(30000);
    await promise;

    // 非主人 quietMode：notify/warn 静默，只有 kill 的简短消息
    // SDK_TIMEOUT 不应再触发 _processMessageInternal 的通用错误消息
    const allMessages = adapter.sentMessages;
    const timeoutMessages = allMessages.filter(m => m.includes('超时') || m.includes('中断'));
    expect(timeoutMessages).toHaveLength(1);
  });
});
