import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter, EvolAgentHandle, EvolAgentRegistryHandle } from '../../src/types.js';

/**
 * These tests invoke the real CommandHandler.handle() to verify that /check
 * and /restart correctly scope to the owning agent and block cross-agent
 * operations. The previous version reimplemented the filter logic in the test
 * file itself, so it would have passed even if production code drifted.
 */

function makeSession(overrides: Partial<any> = {}): any {
  return {
    id: 'test-session', channel: 'main', channelId: 'chat1',
    projectPath: '/tmp/test', threadId: '', agentId: 'claude',
    chatType: 'private', sessionMode: 'interactive',
    agentSessionId: 'claude-s1', metadata: {},
    createdAt: Date.now(), updatedAt: Date.now(),
    identity: { role: 'owner', mode: 'interactive' },
    ...overrides,
  };
}

function makeMockSessionManager(role: 'owner' | 'admin' | 'guest' = 'owner') {
  const session = makeSession({ identity: { role, mode: 'interactive' } });
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(session),
    getActiveSession: vi.fn().mockResolvedValue(session),
    resolveIdentity: vi.fn().mockReturnValue({ role, mode: 'interactive' }),
    recordSuccess: vi.fn(),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    setSafeMode: vi.fn(),
    switchProject: vi.fn(),
    createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    checkSessionFileExists: vi.fn().mockReturnValue(true),
  } as any;
}

function makeMockAgentRunner() {
  return {
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    compactSession: vi.fn(),
    getModel: vi.fn().mockReturnValue('sonnet'),
    getEffort: vi.fn().mockReturnValue('medium'),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
    name: 'claude',
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([{ key: 'default', nameZh: '标准', description: '标准', available: true }]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
  } as any;
}

function makeMockConfig(): Config {
  return {
    agents: { defaultAgent: 'claude', claude: {} },
    channels: { aun: [{ name: 'main', enabled: true, aid: 'main.agentid.pub' }] },
    projects: { defaultPath: '/tmp/test', list: { test: '/tmp/test' } },
  } as any;
}

function makeMockMessageCache() {
  return {
    getCount: vi.fn().mockReturnValue(0),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
    hasMessages: vi.fn().mockReturnValue(false),
  } as any;
}

function makeMockMessageQueue() {
  return {
    getQueueLength: vi.fn().mockReturnValue(0),
    getQueueLengthByAgent: vi.fn().mockReturnValue(0),
    getProcessingCountByAgent: vi.fn().mockReturnValue(0),
    isProcessing: vi.fn().mockReturnValue(false),
    acquireLock: vi.fn().mockReturnValue(() => {}),
    enqueue: vi.fn(),
    interrupt: vi.fn(),
  } as any;
}

function makeAdapter(channelName: string): ChannelAdapter {
  return { channelName, sendText: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeMockEvolAgent(name: string, opts: {
  isDefault?: boolean;
  channels?: string[];
  projectPath?: string;
  baseagent?: string;
}): EvolAgentHandle {
  return {
    name,
    isDefault: opts.isDefault ?? false,
    baseagent: opts.baseagent ?? 'claude',
    projectPath: opts.projectPath ?? '/home/agent',
    getContext: vi.fn(),
    getOwner: vi.fn(),
    isOwner: vi.fn().mockReturnValue(true),
    isAdmin: vi.fn().mockReturnValue(true),
    setOwner: vi.fn(),
    getShowActivities: vi.fn().mockReturnValue('all'),
    setShowActivities: vi.fn(),
    setBaseagentModel: vi.fn(),
    setBaseagentEffort: vi.fn(),
    getProjects: vi.fn().mockReturnValue({}),
    addProject: vi.fn(),
    channelInstanceNames: vi.fn().mockReturnValue(opts.channels ?? []),
  } as any;
}

function makeMockRegistry(channelToAgent: Record<string, EvolAgentHandle>): EvolAgentRegistryHandle {
  return {
    resolveByChannel: vi.fn((ch: string) => channelToAgent[ch] ?? null),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    isOwner: vi.fn((_ch, _uid, fb) => fb(_ch, _uid)),
    isAdmin: vi.fn((_ch, _uid, fb) => fb(_ch, _uid)),
    getOwner: vi.fn(),
    setChannelOwner: vi.fn(),
    getShowActivities: vi.fn(),
    setShowActivities: vi.fn(),
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// /check scoping
// ─────────────────────────────────────────────────────────────────────────────

describe('/check scoping — real handler', () => {
  let cmdHandler: CommandHandler;

  beforeEach(() => {
    const sessionManager = makeMockSessionManager('owner');
    const eventBus = new EventBus();
    cmdHandler = new CommandHandler(
      sessionManager,
      makeMockAgentRunner(),
      makeMockConfig(),
      makeMockMessageCache(),
      eventBus,
    );

    cmdHandler.setMessageQueue(makeMockMessageQueue());

    // Register two adapters: one owned by an EvolAgent, one default
    cmdHandler.registerAdapter(makeAdapter('review-aun'));
    cmdHandler.registerChannel('review-aun', {}, 'aun');
    cmdHandler.registerAdapter(makeAdapter('default-aun'));
    cmdHandler.registerChannel('default-aun', {}, 'aun');

    const reviewAgent = makeMockEvolAgent('review', {
      channels: ['review-aun'],
      projectPath: '/home/review',
    });
    cmdHandler.setAgentRegistry(makeMockRegistry({ 'review-aun': reviewAgent }));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('agent-owned channel /check only lists its own channels', async () => {
    const result = await cmdHandler.handle('/check', 'review-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('review-aun');
    expect(result).not.toContain('default-aun');
  });

  it('default channel /check only lists default channels, not agent-owned', async () => {
    const result = await cmdHandler.handle('/check', 'default-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('default-aun');
    // review-aun is owned by an EvolAgent — default /check must NOT show it
    expect(result).not.toContain('review-aun');
  });

  it('agent-owned channel /check shows agent name in header', async () => {
    const result = await cmdHandler.handle('/check', 'review-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /restart blocking on EvolAgent channels
// ─────────────────────────────────────────────────────────────────────────────

describe('/restart blocking on EvolAgent channels — real handler', () => {
  let cmdHandler: CommandHandler;

  beforeEach(() => {
    const sessionManager = makeMockSessionManager('owner');
    const eventBus = new EventBus();
    cmdHandler = new CommandHandler(
      sessionManager,
      makeMockAgentRunner(),
      makeMockConfig(),
      makeMockMessageCache(),
      eventBus,
    );

    cmdHandler.setMessageQueue(makeMockMessageQueue());

    cmdHandler.registerAdapter(makeAdapter('review-aun'));
    cmdHandler.registerChannel('review-aun', {}, 'aun');
    cmdHandler.registerAdapter(makeAdapter('default-aun'));
    cmdHandler.registerChannel('default-aun', {}, 'aun');

    const reviewAgent = makeMockEvolAgent('review', {
      channels: ['review-aun'],
      projectPath: '/home/review',
    });
    cmdHandler.setAgentRegistry(makeMockRegistry({ 'review-aun': reviewAgent }));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('/restart (no-arg) on agent-owned channel returns service-restart-blocked message', async () => {
    const result = await cmdHandler.handle('/restart', 'review-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('DefaultAgent');
    expect(result).not.toBeNull();
  });

  it('/restart aun on agent-owned channel returns channel-reconnect-blocked message', async () => {
    const result = await cmdHandler.handle('/restart aun', 'review-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('DefaultAgent');
    expect(result).not.toBeNull();
  });

  it('/restart (no-arg) on default channel does NOT return the EvolAgent block message', async () => {
    // On default channel /restart proceeds normally (may fail for other reasons in test env,
    // but must NOT return the EvolAgent isolation error)
    const result = await cmdHandler.handle('/restart', 'default-aun', 'chat1', undefined, 'user1');
    expect(result).not.toContain('DefaultAgent 通道发起');
  });

  it('/restart aun on default channel does NOT return the EvolAgent block message', async () => {
    const result = await cmdHandler.handle('/restart aun', 'default-aun', 'chat1', undefined, 'user1');
    expect(result).not.toContain('DefaultAgent 通道发起');
    expect(result).not.toContain('DefaultAgent 通道发起（服务级操作）');
  });
});
