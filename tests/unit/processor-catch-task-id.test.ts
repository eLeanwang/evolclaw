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

// Mock AgentRunner that throws an infra error inside the stream (caught by catch block)
function createThrowingRunner(errMessage = 'network exploded') {
  return {
    runQuery: vi.fn().mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error(errMessage);
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
  const sentContexts: Array<{ text: string; context?: ReplyContext }> = [];
  const thoughts: Array<{ taskId: string; payload: any }> = [];
  const adapter: ChannelAdapter & { sentContexts: typeof sentContexts; thoughts: typeof thoughts } = {
    channelName: 'aun',
    sentContexts,
    thoughts,
    capabilities: { file: false, image: false, interaction: false, markdown: false, thought: true, status: true },
    send: vi.fn().mockImplementation(async (envelope: any, payload: any) => {
      if ('text' in payload) sentContexts.push({ text: payload.text, context: { ...envelope.replyContext, metadata: { ...(envelope.replyContext?.metadata ?? {}), taskId: envelope.taskId, chatmode: envelope.chatmode } } });
      if (payload.kind === 'activity.batch') thoughts.push({ taskId: envelope.taskId, payload });
    }),
    sendText: vi.fn().mockImplementation(async (_id: string, text: string, context?: ReplyContext) => {
      sentContexts.push({ text, context });
    }),
  };
  return adapter;
}

const baseConfig: Config = {
  agents: { anthropic: { apiKey: 'test' } },
  channels: { aun: { aid: 'bot.agentid.pub' } },
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

describe('MessageProcessor catch block — task_id / chatmode injection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('interactive: error sendText carries metadata.taskId and metadata.chatmode', async () => {
    const runner = createThrowingRunner();
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());

    expect(adapter.sentContexts.length).toBeGreaterThan(0);
    const errorSend = adapter.sentContexts[adapter.sentContexts.length - 1];
    expect(errorSend.context?.metadata?.taskId).toMatch(/^task-[0-9a-f]{10}$/);
    expect(errorSend.context?.metadata?.chatmode).toBe('interactive');
  });

  it('proactive: error sendText carries metadata.taskId and chatmode=proactive', async () => {
    const runner = createThrowingRunner();
    const sm = createSessionManager('proactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());

    const errorSend = adapter.sentContexts[adapter.sentContexts.length - 1];
    expect(errorSend.context?.metadata?.taskId).toMatch(/^task-[0-9a-f]{10}$/);
    expect(errorSend.context?.metadata?.chatmode).toBe('proactive');
  });

  it.skip('proactive: catch block emits error thought with same taskId', async () => {
    const runner = createThrowingRunner('something broke');
    const sm = createSessionManager('proactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());

    // A thought with stage 'error' must have been emitted
    const errorThought = adapter.thoughts.find(t => t.payload?.stage === 'error');
    expect(errorThought).toBeTruthy();
    // Thought taskId must match the same taskId seen on the sendText context
    const errorSend = adapter.sentContexts[adapter.sentContexts.length - 1];
    const sendTaskId = errorSend.context?.metadata?.taskId as string;
    expect(errorThought!.taskId).toBe(sendTaskId);
  });

  it('interactive: no thought emitted on catch (ThoughtEmitter not created)', async () => {
    const runner = createThrowingRunner();
    const sm = createSessionManager('interactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());

    expect(adapter.thoughts.length).toBe(0);
  });

  it('taskId is stable across sendText and thought within one processMessage', async () => {
    const runner = createThrowingRunner();
    const sm = createSessionManager('proactive');
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    await processor.processMessage(createMessage());

    const errorSend = adapter.sentContexts[adapter.sentContexts.length - 1];
    const sendTaskId = errorSend.context?.metadata?.taskId as string;
    // All thoughts emitted this task should carry the same taskId
    for (const t of adapter.thoughts) {
      expect(t.taskId).toBe(sendTaskId);
    }
  });
});
