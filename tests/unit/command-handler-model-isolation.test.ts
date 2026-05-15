import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter, EvolAgentHandle, EvolAgentRegistryHandle } from '../../src/types.js';

/**
 * H1 fix integration: CommandHandler./model on an EvolAgent-owned channel
 * mutates ONLY that agent's runner, leaving the DefaultAgent runner alone.
 */

function makeSession(overrides: Partial<any> = {}): any {
  return {
    id: 'sess-1', channel: 'main', channelId: 'chat1',
    projectPath: '/tmp/p', threadId: '', agentId: 'claude',
    chatType: 'private', sessionMode: 'interactive',
    agentSessionId: 'cs-1', metadata: {},
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
    recordSuccess: vi.fn(), recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    setSafeMode: vi.fn(), switchProject: vi.fn(), createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]), switchSession: vi.fn(),
    renameSession: vi.fn(), deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    checkSessionFileExists: vi.fn().mockReturnValue(true),
  } as any;
}

function makeMockRunner(initialModel: string) {
  let model = initialModel;
  return {
    name: 'claude', capabilities: { clear: true, compact: true, fork: true },
    runQuery: vi.fn(), interrupt: vi.fn(), updateSessionId: vi.fn(),
    closeSession: vi.fn(), compactSession: vi.fn(),
    getModel: vi.fn(() => model),
    setModel: vi.fn((m: string) => { model = m; }),
    getEffort: vi.fn().mockReturnValue('medium'),
    setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
    setMode: vi.fn(), getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([{ key: 'default', nameZh: '标准', description: '', available: true }]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
  } as any;
}

function makeAdapter(channelName: string): ChannelAdapter {
  return { channelName, sendText: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeMockMessageQueue() {
  return {
    getQueueLength: vi.fn().mockReturnValue(0),
    getQueueLengthByAgent: vi.fn().mockReturnValue(0),
    getProcessingCountByAgent: vi.fn().mockReturnValue(0),
    isProcessing: vi.fn().mockReturnValue(false),
    acquireLock: vi.fn().mockReturnValue(() => {}),
    enqueue: vi.fn(), interrupt: vi.fn(),
  } as any;
}

function makeAgent(name: string, channels: string[]): EvolAgentHandle {
  return {
    name, isDefault: name === '[default]',
    baseagent: 'claude', projectPath: '/tmp/p',
    getContext: vi.fn(), getOwner: vi.fn(),
    isOwner: vi.fn().mockReturnValue(true),
    isAdmin: vi.fn().mockReturnValue(true),
    setOwner: vi.fn(),
    getShowActivities: vi.fn().mockReturnValue('all'),
    setShowActivities: vi.fn(),
    setBaseagentModel: vi.fn(),
    setBaseagentEffort: vi.fn(),
    getProjects: vi.fn().mockReturnValue({}),
    addProject: vi.fn(),
    channelInstanceNames: vi.fn().mockReturnValue(channels),
  } as any;
}

function makeRegistry(channelToAgent: Record<string, EvolAgentHandle>): EvolAgentRegistryHandle {
  return {
    resolveByChannel: vi.fn((ch: string) => channelToAgent[ch] ?? null),
    get: vi.fn(), list: vi.fn().mockReturnValue([]),
    isOwner: vi.fn((_c, _u, fb) => fb(_c, _u)),
    isAdmin: vi.fn((_c, _u, fb) => fb(_c, _u)),
    getOwner: vi.fn(),
    setChannelOwner: vi.fn(),
    getShowActivities: vi.fn(),
    setShowActivities: vi.fn(),
  } as any;
}

describe('CommandHandler /model isolation between EvolAgents (H1)', () => {
  let cmdHandler: CommandHandler;
  let defaultRunner: any;
  let reviewRunner: any;

  beforeEach(() => {
    defaultRunner = makeMockRunner('sonnet');
    reviewRunner = makeMockRunner('sonnet');

    const agentMap = new Map<string, any>([
      ['[default]::claude', defaultRunner],
      ['review::claude', reviewRunner],
    ]);

    const config: Config = {
      agents: { defaultAgent: 'claude', claude: {} },
      channels: { aun: [{ name: 'main', enabled: true, aid: 'main.agentid.pub' }] },
      projects: { defaultPath: '/tmp/p' },
    } as any;

    cmdHandler = new CommandHandler(
      makeMockSessionManager('owner'),
      agentMap,
      config,
      { getCount: () => 0, addEvent: () => {}, getEvents: () => [], clearEvents: () => {}, hasMessages: () => false } as any,
      new EventBus(),
      '[default]::claude',
    );
    cmdHandler.setMessageQueue(makeMockMessageQueue());
    cmdHandler.registerAdapter(makeAdapter('default-aun'));
    cmdHandler.registerChannel('default-aun', {}, 'aun');
    cmdHandler.registerAdapter(makeAdapter('review-aun'));
    cmdHandler.registerChannel('review-aun', {}, 'aun');

    cmdHandler.setAgentRegistry(makeRegistry({
      'review-aun': makeAgent('review', ['review-aun']),
    }));
  });

  it('/model opus on review channel only changes the review runner', async () => {
    await cmdHandler.handle('/model opus', 'review-aun', 'chat1', undefined, 'user1');

    expect(reviewRunner.setModel).toHaveBeenCalledWith('opus');
    expect(defaultRunner.setModel).not.toHaveBeenCalled();
  });

  it('/model opus on default channel only changes the default runner', async () => {
    await cmdHandler.handle('/model opus', 'default-aun', 'chat1', undefined, 'user1');

    expect(defaultRunner.setModel).toHaveBeenCalledWith('opus');
    expect(reviewRunner.setModel).not.toHaveBeenCalled();
  });
});
