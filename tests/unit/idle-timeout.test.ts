import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message-processor.js';
import type { Config, Message, ChannelAdapter } from '../../src/types.js';

// Mock AgentRunner
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
              if (index >= events.length) {
                return { done: true, value: undefined };
              }
              if (eventDelay > 0) {
                await new Promise(r => setTimeout(r, eventDelay));
              }
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
  };
}

// Mock SessionManager
function createMockSessionManager() {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue({
      id: 'test-session',
      channel: 'feishu',
      channelId: 'test-channel',
      projectPath: '/tmp/test-project',
      claudeSessionId: 'test-claude-session',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'test-session',
      channel: 'feishu',
      channelId: 'test-channel',
      projectPath: '/tmp/test-project',
      isActive: true,
    }),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() }),
    setSafeMode: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock MessageCache
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

function createMessage(content = 'hello'): Message {
  return { channel: 'feishu', channelId: 'test-channel', content, timestamp: Date.now() };
}

describe('Idle Timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not timeout when events arrive within idle window', async () => {
    // 事件间隔 50ms，空闲超时 200ms，不应超时
    const events = [
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'World' },
      { type: 'result', result: 'Hello World', subtype: 'success' },
    ];

    const runner = createMockAgentRunner(events, 50);
    const sessionManager = createMockSessionManager();
    const messageCache = createMockMessageCache();
    const adapter = createMockAdapter();

    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      acp: { domain: '', agentName: '' },
      timeout: { idle: 200 },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage());

    // 推进时间让事件逐个到达（每个 50ms）
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    await processPromise;

    // 不应调用 interrupt
    expect(runner.interruptCalled()).toBe(false);
    // 不应有超时提示消息
    expect(adapter.sentMessages.every(m => !m.includes('超时'))).toBe(true);
  });

  it('should timeout when no events arrive within idle window', async () => {
    // 创建一个永远不产生事件的流
    const runner = createMockAgentRunner([], 0);
    // 覆盖 runQuery 返回一个永远挂起的流
    runner.runQuery.mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // 永远不返回，模拟无输出
            return new Promise(() => {});
          }
        };
      }
    }));

    const sessionManager = createMockSessionManager();
    const messageCache = createMockMessageCache();
    const adapter = createMockAdapter();

    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      acp: { domain: '', agentName: '' },
      timeout: { idle: 500 },  // 500ms 空闲超时
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage()).catch(e => e);

    // 推进 500ms 触发超时
    await vi.advanceTimersByTimeAsync(500);

    // 等待 promise 完成
    const error = await processPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');

    // 应调用 interrupt
    expect(runner.interrupt).toHaveBeenCalled();
    // 应发送超时提示
    expect(adapter.sentMessages.some(m => m.includes('超时'))).toBe(true);
  });

  it('should use default 120s when config.timeout.idle is not set', async () => {
    const runner = createMockAgentRunner([], 0);
    runner.runQuery.mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise(() => {});
          }
        };
      }
    }));

    const sessionManager = createMockSessionManager();
    const messageCache = createMockMessageCache();
    const adapter = createMockAdapter();

    // 不设置 timeout 配置
    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      acp: { domain: '', agentName: '' },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage()).catch(e => e);

    // 119秒不应超时
    await vi.advanceTimersByTimeAsync(119000);
    expect(runner.interrupt).not.toHaveBeenCalled();

    // 120秒应超时
    await vi.advanceTimersByTimeAsync(1000);

    const error = await processPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');
    expect(runner.interrupt).toHaveBeenCalled();
  });

  it('should reset timer on each event, allowing long tasks to complete', async () => {
    // 5个事件，每个间隔 300ms，空闲超时 400ms
    // 总时间 1500ms > 400ms，但每个事件间隔 < 400ms，不应超时
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/test' } }] } },
      { type: 'text_delta', text: 'Reading ' },
      { type: 'text_delta', text: 'file...' },
      { type: 'text_delta', text: ' Done!' },
      { type: 'result', result: 'Reading file... Done!', subtype: 'success' },
    ];

    const runner = createMockAgentRunner(events, 300);
    const sessionManager = createMockSessionManager();
    const messageCache = createMockMessageCache();
    const adapter = createMockAdapter();

    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      acp: { domain: '', agentName: '' },
      timeout: { idle: 400 },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage());

    // 推进足够时间让所有事件完成
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    await processPromise;

    expect(runner.interruptCalled()).toBe(false);
    expect(adapter.sentMessages.every(m => !m.includes('超时'))).toBe(true);
  });
});

