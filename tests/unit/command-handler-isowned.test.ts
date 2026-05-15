import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter, EvolAgentHandle, EvolAgentRegistryHandle } from '../../src/types.js';

/**
 * These tests invoke the real CommandHandler.handle() and assert on its output,
 * to catch drift in the actual production isolation logic. The previous version
 * reimplemented the regex/conditionals in the test file and tested that copy,
 * so it would have passed even if production code drifted.
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

function makeAdapter(channelName: string): ChannelAdapter {
  return { channelName, sendText: vi.fn().mockResolvedValue(undefined) } as any;
}

/** Mock EvolAgent satisfying the parts CommandHandler reads. */
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

describe('CommandHandler isOwned blocking — real handler', () => {
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
    cmdHandler.registerAdapter(makeAdapter('agent-aun'));
    cmdHandler.registerChannel('agent-aun', {}, 'aun');
    cmdHandler.registerAdapter(makeAdapter('default-aun'));
    cmdHandler.registerChannel('default-aun', {}, 'aun');

    // 'agent-aun' belongs to a non-default EvolAgent; 'default-aun' has no owner
    const reviewAgent = makeMockEvolAgent('review', {
      channels: ['agent-aun'],
      projectPath: '/home/review',
      baseagent: 'claude',
    });
    cmdHandler.setAgentRegistry(makeMockRegistry({ 'agent-aun': reviewAgent }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Project-related commands blocked on agent-owned channel ──

  it('blocks /project foo on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/project foo', 'agent-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('agent [review]');
    expect(result).toContain('项目已锁定为 /home/review');
  });

  it('blocks /bind /tmp/x on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/bind /tmp/x', 'agent-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('agent [review]');
    expect(result).toContain('项目已锁定');
  });

  it('blocks /plist on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/plist', 'agent-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('agent [review]');
    expect(result).toContain('项目已锁定');
  });

  it('blocks /p alias on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/p somename', 'agent-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('agent [review]');
    expect(result).toContain('项目已锁定');
  });

  // ── /agent switching blocked, view-only allowed ──

  it('blocks /agent codex (switch) on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/agent codex', 'agent-aun', 'chat1', undefined, 'user1');
    expect(result).toContain('agent [review]');
    expect(result).toContain('baseagent 已锁定为 claude');
  });

  it('does NOT block /agent (view-only) on agent-owned channel', async () => {
    const result = await cmdHandler.handle('/agent', 'agent-aun', 'chat1', undefined, 'user1');
    // /agent without arg should pass through to the listing handler — no lock message
    expect(result).not.toContain('baseagent 已锁定');
    expect(result).not.toContain('项目已锁定');
  });

  // ── Default channel: same commands NOT blocked by isolation guard ──

  it('does NOT show isolation lock on default channel for /project', async () => {
    const result = await cmdHandler.handle('/project foo', 'default-aun', 'chat1', undefined, 'user1');
    // May return some other error (project not found, permission, etc) but NOT the isolation lock
    expect(result).not.toContain('项目已锁定为');
    expect(result).not.toContain('agent [');
  });

  it('does NOT show isolation lock on default channel for /agent codex', async () => {
    const result = await cmdHandler.handle('/agent codex', 'default-aun', 'chat1', undefined, 'user1');
    expect(result).not.toContain('baseagent 已锁定');
    expect(result).not.toContain('agent [');
  });
});
