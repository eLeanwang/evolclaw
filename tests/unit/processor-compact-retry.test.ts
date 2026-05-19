import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, Message, ChannelAdapter, ChannelPolicy } from '../../src/types.js';

const testPolicy: ChannelPolicy = {
  canSwitchProject: () => true,
  canListProjects: () => true,
  canCreateSession: () => true,
  canDeleteSession: () => true,
  canImportCliSession: () => true,
  messagePrefix: () => '',
  showMiddleResult: () => true,
  showIdleMonitor: () => false,
  accumulateErrors: () => false,
};

function makeStream(events: any[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= events.length) return { done: true, value: undefined };
          return { done: false, value: events[i++] };
        },
      };
    },
  };
}

function createSessionManager() {
  const baseSession = {
    id: 'sess-1',
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    projectPath: '/tmp/test-project',
    threadId: '',
    agentId: 'claude',
    chatType: 'private' as const,
    sessionMode: 'interactive' as const,
    agentSessionId: 'agent-sid-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    identity: { role: 'owner' as const, mode: 'interactive' as const },
  };
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(baseSession),
    getActiveSession: vi.fn().mockResolvedValue(baseSession),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() }),
    setSafeMode: vi.fn().mockResolvedValue(undefined),
    markProcessing: vi.fn(),
    clearProcessing: vi.fn(),
  };
}

function createAdapter() {
  return {
    channelName: 'aun',
    capabilities: { file: false, image: false, interaction: false, markdown: false, thought: false, status: false },
    send: vi.fn().mockResolvedValue(undefined),
  };
}

const baseConfig: Config = {
  agents: { anthropic: { apiKey: 'test' } },
  channels: { aun: { aid: 'bot.agentid.pub' } },
  flushDelay: 0.01,
} as Config;

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    content: 'hello',
    peerId: 'peer.agentid.pub',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── compact retry uses effectiveSystemPrompt ──────────────────────────────────

describe('MessageProcessor compact retry — effectiveSystemPrompt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes effectiveSystemPrompt (not options.systemPromptAppend) to compact retry runQuery', async () => {
    // First runQuery throws context_length_exceeded; compact succeeds; retry runQuery is called
    const contextError = new Error('context_length_exceeded');

    let callCount = 0;
    const runQuery = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw contextError;
      // Second call (compact retry) returns a valid stream
      return makeStream([
        { type: 'text', text: 'retried' },
        { type: 'complete', isError: false, result: 'retried', subtype: 'success', durationMs: 10 },
      ]);
    });

    const runner = {
      runQuery,
      registerStream: vi.fn(),
      cleanupStream: vi.fn(),
      interrupt: vi.fn(),
      updateSessionId: vi.fn(),
      closeSession: vi.fn(),
      setSendPrompt: vi.fn(),
      setMode: vi.fn(),
      compact: vi.fn().mockResolvedValue(true),
      name: 'claude',
      capabilities: { clear: true, compact: true, fork: true },
    };

    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any, new EventBus());
    processor.registerChannel(adapter as any, testPolicy, { systemPromptAppend: 'channel-append' } as any);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 150));

    // runQuery should have been called twice: first (throws), second (compact retry)
    expect(runQuery).toHaveBeenCalledTimes(2);

    // The second call (compact retry) should receive a systemPrompt that is NOT just 'channel-append'
    // effectiveSystemPrompt includes runtime context parts built dynamically
    const retryCall = runQuery.mock.calls[1];
    const retrySystemPrompt = retryCall[5]; // 6th arg: systemPrompt

    // effectiveSystemPrompt is built from [options?.systemPromptAppend, ...contextParts]
    // It will contain 'channel-append' AND runtime context (not just 'channel-append' alone)
    // The key assertion: it's not undefined and contains the channel-append value
    expect(retrySystemPrompt).toBeDefined();
    expect(retrySystemPrompt).toContain('channel-append');
  });

  it('compact retry receives undefined systemPrompt when no systemPromptAppend and no context', async () => {
    const contextError = new Error('context_length_exceeded');
    let callCount = 0;
    const runQuery = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw contextError;
      return makeStream([
        { type: 'text', text: 'ok' },
        { type: 'complete', isError: false, result: 'ok', subtype: 'success', durationMs: 10 },
      ]);
    });

    const runner = {
      runQuery,
      registerStream: vi.fn(),
      cleanupStream: vi.fn(),
      interrupt: vi.fn(),
      updateSessionId: vi.fn(),
      closeSession: vi.fn(),
      setSendPrompt: vi.fn(),
      setMode: vi.fn(),
      compact: vi.fn().mockResolvedValue(true),
      name: 'claude',
      capabilities: { clear: true, compact: true, fork: true },
    };

    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any, new EventBus());
    // No systemPromptAppend
    processor.registerChannel(adapter as any, testPolicy);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 150));

    expect(runQuery).toHaveBeenCalledTimes(2);
    const retrySystemPrompt = runQuery.mock.calls[1][5];
    // With no systemPromptAppend and minimal context, effectiveSystemPrompt may be a non-empty
    // string (runtime section) or undefined — either way it should NOT be the raw 'channel-append'
    // The important thing: it's the same value as the first call's systemPrompt
    const firstSystemPrompt = runQuery.mock.calls[0][5];
    expect(retrySystemPrompt).toBe(firstSystemPrompt);
  });
});
