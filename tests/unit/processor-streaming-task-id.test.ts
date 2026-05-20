import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, Message, ChannelAdapter, ChannelPolicy, ReplyContext } from '../../src/types.js';

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

function createStreamingRunner(events: any[]) {
  return {
    runQuery: vi.fn().mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i >= events.length) return { done: true, value: undefined };
            return { done: false, value: events[i++] };
          },
        };
      },
    })),
    registerStream: vi.fn(),
    cleanupStream: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    setSendPrompt: vi.fn(),
    setMode: vi.fn(),
    name: 'claude',
  };
}

function createSessionManager(sessionMode: 'interactive' | 'proactive' = 'interactive') {
  const baseSession = {
    id: 'sess-1',
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    projectPath: '/tmp/test-project',
    threadId: '',
    agentId: 'claude',
    chatType: 'private' as const,
    sessionMode,
    agentSessionId: 'agent-sid',
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

function createCache() {
  return {
    getCount: vi.fn().mockReturnValue(0),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  };
}

function createAdapter() {
  const sent: Array<{ text: string; context?: ReplyContext }> = [];
  const adapter: ChannelAdapter & { sent: typeof sent } = {
    channelName: 'aun',
    sent,
    capabilities: { file: false, image: false, interaction: false, markdown: false, thought: false, status: false },
    send: vi.fn().mockImplementation(async (envelope: any, payload: any) => {
      // Collect text-bearing payloads; synthesise context.metadata from envelope
      if ('text' in payload && payload.text) {
        const ctx: ReplyContext = {
          ...(envelope.replyContext ?? {}),
          metadata: { ...(envelope.replyContext?.metadata ?? {}), taskId: envelope.taskId, chatmode: envelope.chatmode },
        };
        sent.push({ text: payload.text, context: ctx });
      }
    }),
  };
  return adapter;
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

describe('MessageProcessor streaming path — task_id / chatmode injection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('flusher sendText carries metadata.taskId and metadata.chatmode (interactive)', async () => {
    const runner = createStreamingRunner([
      { type: 'text', text: 'hello world' },
      { type: 'complete', isError: false, result: 'hello world', subtype: 'success', durationMs: 10 },
    ]);
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());
    // Wait for flusher to drain
    await new Promise(r => setTimeout(r, 100));

    expect(adapter.sent.length).toBeGreaterThan(0);
    const first = adapter.sent[0];
    expect(first.context?.metadata?.taskId).toMatch(/^task-[0-9a-f]{10}$/);
    expect(first.context?.metadata?.chatmode).toBe('interactive');
  });

  it('proactive mode: adapter.send carries taskId via client_context (activity.batch)', async () => {
    const runner = createStreamingRunner([
      { type: 'text', text: 'proactive reply' },
      { type: 'complete', isError: false, result: 'proactive reply', subtype: 'success', durationMs: 10 },
    ]);
    const sm = createSessionManager('proactive');
    const sentPayloads: Array<{ envelope: any; payload: any }> = [];
    const adapter: ChannelAdapter & { sent: any[] } = {
      channelName: 'aun',
      sent: [],
      sendText: vi.fn().mockImplementation(async () => {}),
      send: vi.fn().mockImplementation(async (envelope: any, payload: any) => {
        sentPayloads.push({ envelope, payload });
      }),
    };
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    // Proactive 模式下中间内容通过 activity.batch 推送
    const batches = sentPayloads.filter(p => p.payload.kind === 'activity.batch');
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].envelope.taskId).toMatch(/^task-[0-9a-f]{10}$/);
    expect(batches[0].envelope.chatmode).toBe('proactive');
  });

  it('taskId is stable across multiple flusher sends within one task', async () => {
    // Multiple text events get batched by flusher; 1 sendText call is typical.
    // Simulate a long stream that triggers multiple flushes via quick flushDelay.
    const runner = createStreamingRunner([
      { type: 'text', text: 'first ' },
      { type: 'text', text: 'second ' },
      { type: 'text', text: 'third' },
      { type: 'complete', isError: false, result: 'first second third', subtype: 'success', durationMs: 10 },
    ]);
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    expect(adapter.sent.length).toBeGreaterThan(0);
    const taskIds = new Set(adapter.sent.map(s => s.context?.metadata?.taskId));
    expect(taskIds.size).toBe(1);  // Same taskId across all sends
  });

  it('taskId differs between two separate processMessage calls', async () => {
    const runner1 = createStreamingRunner([
      { type: 'text', text: 'first task' },
      { type: 'complete', isError: false, result: 'first task', subtype: 'success', durationMs: 10 },
    ]);
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner1 as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage({ content: 'msg1' }));
    await new Promise(r => setTimeout(r, 100));
    const firstTaskId = adapter.sent[0].context?.metadata?.taskId;

    // Second call — need a fresh runner since the first has no more events
    const runner2 = createStreamingRunner([
      { type: 'text', text: 'second task' },
      { type: 'complete', isError: false, result: 'second task', subtype: 'success', durationMs: 10 },
    ]);
    (processor as any).agentMap.set('claude', runner2);

    await processor.processMessage(createMessage({ content: 'msg2' }));
    await new Promise(r => setTimeout(r, 100));

    const allTaskIds = adapter.sent.map(s => s.context?.metadata?.taskId);
    const secondTaskId = allTaskIds[allTaskIds.length - 1];
    expect(secondTaskId).not.toBe(firstTaskId);
    expect(secondTaskId).toMatch(/^task-[0-9a-f]{10}$/);
  });

  it('metadata.taskId format is task-{10hex}', async () => {
    const runner = createStreamingRunner([
      { type: 'text', text: 'format test' },
      { type: 'complete', isError: false, result: 'format test', subtype: 'success', durationMs: 10 },
    ]);
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    const taskId = adapter.sent[0].context?.metadata?.taskId as string;
    expect(taskId).toMatch(/^task-[0-9a-f]{10}$/);
  });
});
