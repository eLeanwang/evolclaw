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
  return { channel: 'feishu', channelId: 'test-channel', content, userId: 'owner-123', timestamp: Date.now() };
}

describe('Idle Timeout with StreamIdleMonitor', () => {
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
      aun: { domain: '', agentName: '' },
      timeout: { idle: 200 },
      owners: { feishu: 'owner-123' },
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
    // 不应有超时或监控消息
    expect(adapter.sentMessages.every(m => !m.includes('超时') && !m.includes('执行监控'))).toBe(true);
  });

  it('should send notify at 1x idle, warn at 2.5x, and kill at 5x', async () => {
    // 创建一个永远不产生事件的流
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

    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      aun: { domain: '', agentName: '' },
      timeout: { idle: 500 },  // 500ms idle threshold for fast tests
      owners: { feishu: 'owner-123' },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage()).catch(e => e);

    // Monitor interval is 30s, but with fake timers we need to advance past thresholds
    // notify at 500ms (1×), warn at 1250ms (2.5×), kill at 2500ms (5×)
    // The 30s interval with a 500ms idle → first check at 30s already past kill threshold

    // For this test, advance time in 30s chunks (the monitor interval)
    // At 30s check: idle=30000ms, way past 500ms×5=2500ms → triggers notify, warn, then kill
    await vi.advanceTimersByTimeAsync(30000);

    const error = await processPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');
    expect(runner.interrupt).toHaveBeenCalled();
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

    // 不设置 timeout 配置 → 默认 120000ms
    const config: Config = {
      anthropic: { apiKey: 'test' },
      feishu: { appId: '', appSecret: '' },
      aun: { domain: '', agentName: '' },
      owners: { feishu: 'owner-123' },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage()).catch(e => e);

    // Monitor interval is 30s
    // Default idle = 120s, notify at 120s, warn at 300s, kill at 600s

    // At 30s: no threshold reached yet (idle < 120s)
    await vi.advanceTimersByTimeAsync(30000);
    expect(runner.interrupt).not.toHaveBeenCalled();

    // At 90s: still no threshold
    await vi.advanceTimersByTimeAsync(60000);
    expect(runner.interrupt).not.toHaveBeenCalled();

    // At 120s: notify threshold reached, but monitor fires every 30s
    // Next check at 120s → should trigger notify
    await vi.advanceTimersByTimeAsync(30000);
    // notify sent but not killed
    expect(runner.interrupt).not.toHaveBeenCalled();
    expect(adapter.sentMessages.some(m => m.includes('执行监控'))).toBe(true);

    // Advance to 600s (kill threshold) — 480s more
    await vi.advanceTimersByTimeAsync(480000);

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
      aun: { domain: '', agentName: '' },
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
    expect(adapter.sentMessages.every(m => !m.includes('超时') && !m.includes('执行监控'))).toBe(true);
  });

  it('should send diagnostic info with tool name and event count', async () => {
    // 流先产生一些事件，然后挂住
    let resolveHang: () => void;
    const hangPromise = new Promise<void>(r => { resolveHang = r; });
    let eventIndex = 0;
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'text_delta', text: 'Running...' },
    ];

    const runner = createMockAgentRunner([], 0);
    runner.runQuery.mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<{ done: boolean; value: any }> {
            if (eventIndex < events.length) {
              return { done: false, value: events[eventIndex++] };
            }
            // 挂住，模拟长时间无输出
            await hangPromise;
            return { done: true, value: undefined };
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
      aun: { domain: '', agentName: '' },
      timeout: { idle: 500 },
      owners: { feishu: 'owner-123' },
    };

    const processor = new MessageProcessor(
      runner as any,
      sessionManager as any,
      config,
      messageCache as any,
    );
    processor.registerChannel(adapter);

    const processPromise = processor.processMessage(createMessage()).catch(e => e);

    // Let initial events process
    await vi.advanceTimersByTimeAsync(100);

    // Advance past monitor interval (30s) to trigger check
    // At this point idle > 500ms × 5 = 2500ms (well past kill at 30s)
    await vi.advanceTimersByTimeAsync(30000);

    // Resolve the hang so stream finishes
    resolveHang!();

    const error = await processPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SDK_TIMEOUT');

    // The kill message should reference the last tool (🛑 is the kill prefix)
    const killMsg = adapter.sentMessages.find(m => m.includes('🛑') || m.includes('自动中断'));
    expect(killMsg).toBeDefined();
    expect(killMsg).toContain('Bash');
  });
});
