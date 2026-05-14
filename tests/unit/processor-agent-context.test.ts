import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, Message, ChannelAdapter, ChannelPolicy, ReplyContext } from '../../src/types.js';
import { EvolAgent } from '../../src/core/evolagent.js';

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

function createSessionManager() {
  const baseSession = {
    id: 'sess-1',
    channel: 'test-fs',
    channelId: 'chat-1',
    projectPath: '/tmp/test-project',
    threadId: '',
    agentId: 'claude',
    chatType: 'private' as const,
    sessionMode: 'interactive' as const,
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

function createAdapter(name = 'test-fs') {
  const sent: Array<{ text: string; context?: ReplyContext }> = [];
  const adapter: ChannelAdapter & { sent: typeof sent } = {
    channelName: name,
    sent,
    sendText: vi.fn().mockImplementation(async (_id: string, text: string, context?: ReplyContext) => {
      sent.push({ text, context });
    }),
  };
  return adapter;
}

const baseConfig: Config = {
  agents: { anthropic: { apiKey: 'test' } },
  channels: { feishu: { appId: 'x', appSecret: 'y' } },
  flushDelay: 0.01,
} as Config;

describe('MessageProcessor.setAgentRegistry + getAgentContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getAgentContext returns null when no registry set', () => {
    const runner = createStreamingRunner([]);
    const processor = new MessageProcessor(runner as any, createSessionManager() as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(createAdapter(), testPolicy);

    // Access private method
    const result = (processor as any).getAgentContext('test-fs', 'private');
    expect(result).toBeNull();
  });

  it('getAgentContext returns null when registry cannot resolve channel', () => {
    const runner = createStreamingRunner([]);
    const processor = new MessageProcessor(runner as any, createSessionManager() as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(createAdapter(), testPolicy);

    const mockRegistry = {
      resolveByChannel: vi.fn().mockReturnValue(null),
    };
    processor.setAgentRegistry(mockRegistry);

    const result = (processor as any).getAgentContext('unknown-channel', 'private');
    expect(result).toBeNull();
    expect(mockRegistry.resolveByChannel).toHaveBeenCalledWith('unknown-channel');
  });

  it('getAgentContext returns AgentContext when registry resolves channel', () => {
    const runner = createStreamingRunner([]);
    const processor = new MessageProcessor(runner as any, createSessionManager() as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(createAdapter(), testPolicy);

    const agent = new EvolAgent('/tmp/test.json', {
      name: 'test-agent',
      agents: { claude: { model: 'opus' } },
      channels: { feishu: [{ name: 'test-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp/project' },
      chatmode: { private: 'interactive', group: 'proactive' },
    });

    const mockRegistry = {
      resolveByChannel: vi.fn().mockReturnValue(agent),
    };
    processor.setAgentRegistry(mockRegistry);

    const ctx = (processor as any).getAgentContext('test-fs', 'group');
    expect(ctx).not.toBeNull();
    expect(ctx.name).toBe('test-agent');
    expect(ctx.baseagent).toBe('claude');
    expect(ctx.chatMode).toBe('proactive');
    expect(ctx.projectPath).toBe('/tmp/project');
    expect(ctx.isOwned).toBe(true);
  });

  it('getAgentContext uses global chatmode when agent has none', () => {
    const runner = createStreamingRunner([]);
    const configWithChatmode = { ...baseConfig, chatmode: { private: 'proactive', group: 'interactive' } } as any;
    const processor = new MessageProcessor(runner as any, createSessionManager() as any, configWithChatmode, createCache() as any, new EventBus());
    processor.registerChannel(createAdapter(), testPolicy);

    const agent = new EvolAgent('/tmp/test.json', {
      name: 'no-chatmode-agent',
      agents: { claude: {} },
      channels: { feishu: [{ name: 'test-fs', appId: 'x', appSecret: 'y' }] },
      projects: { defaultPath: '/tmp/project2' },
      // no chatmode
    });

    const mockRegistry = {
      resolveByChannel: vi.fn().mockReturnValue(agent),
    };
    processor.setAgentRegistry(mockRegistry);

    const ctx = (processor as any).getAgentContext('test-fs', 'private');
    expect(ctx.chatMode).toBe('proactive');
  });

  it('setAgentRegistry stores registry for later use', () => {
    const runner = createStreamingRunner([]);
    const processor = new MessageProcessor(runner as any, createSessionManager() as any, baseConfig, createCache() as any, new EventBus());

    expect((processor as any).agentRegistry).toBeUndefined();

    const mockRegistry = { resolveByChannel: vi.fn() };
    processor.setAgentRegistry(mockRegistry);

    expect((processor as any).agentRegistry).toBe(mockRegistry);
  });
});
