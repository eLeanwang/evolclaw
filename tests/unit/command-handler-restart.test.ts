import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandHandler } from '../../src/core/command/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';

/**
 * Tests for /restart command behavior changes:
 * - Non-daemon-owner gets permission error
 * - daemon owner with no pending messages: executeRestart is called, returns null
 *
 * /restart 是进程级操作：鉴权主体是 evolclaw.json.owners（daemon owner），
 * 与 menu 协议 /system restart 一致。agent-channel 的 owner 角色不足以重启 daemon。
 *
 * Note: Full restart flow (spawn, kill, adapter.send) is tested via integration.
 * This unit test verifies the return value contract.
 */

// daemon owners 名单：默认含 user1（正向用例）；非 owner 用例覆写。
const ownersMock = vi.hoisted(() => ({ value: ['user1'] as string[] }));
vi.mock('../../src/config-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config-store.js')>();
  return {
    ...actual,
    loadEvolclawConfig: vi.fn(() => ({ $schema_version: 1, owners: ownersMock.value })),
  };
});

function makeSession(overrides: Partial<any> = {}): any {
  return {
    id: 'sess-1', channel: 'main', channelId: 'chat1',
    channelType: 'feishu',
    projectPath: '/tmp/p', threadId: '', agentId: 'claude',
    chatType: 'private', sessionMode: 'interactive',
    agentSessionId: 'cs-1', metadata: {},
    createdAt: Date.now(), updatedAt: Date.now(),
    identity: { role: 'owner', mode: 'interactive' },
    ...overrides,
  };
}

function makeMockSessionManager(role: 'owner' | 'guest' = 'owner') {
  const session = makeSession({ identity: { role, mode: 'interactive' } });
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(session),
    getActiveSession: vi.fn().mockResolvedValue(session),
    resolveIdentity: vi.fn().mockReturnValue({ role, mode: 'interactive' }),
    recordSuccess: vi.fn(), recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    setSafeMode: vi.fn(), switchProject: vi.fn(), createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn(), renameSession: vi.fn(), deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    checkSessionFileExists: vi.fn().mockReturnValue(true),
    getThreadSession: vi.fn().mockResolvedValue(null),
    getActiveChatType: vi.fn().mockReturnValue('private'),
  } as any;
}

function makeMockAgentRegistry() {
  return {
    resolveByChannel: vi.fn().mockReturnValue({ aid: 'self.agentid.pub', name: 'self-agent' }),
    get: vi.fn().mockReturnValue({ aid: 'self.agentid.pub', name: 'self-agent' }),
  } as any;
}

function makeMockRunner() {
  return {
    name: 'claude', capabilities: { clear: true, compact: true, fork: true },
    runQuery: vi.fn(), interrupt: vi.fn(), updateSessionId: vi.fn(),
    closeSession: vi.fn(), compactSession: vi.fn(), clearSession: vi.fn(),
    getModel: vi.fn(() => 'sonnet'), setModel: vi.fn(),
    getEffort: vi.fn().mockReturnValue('medium'), setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet']),
    setMode: vi.fn(), getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
  } as any;
}

describe('CommandHandler: /restart permission and return value', () => {
  afterEach(() => {
    ownersMock.value = ['user1'];
  });

  it('non-daemon-owner gets permission error (even if agent-channel owner)', async () => {
    ownersMock.value = ['someone-else'];  // user1 不在 daemon owners
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager('owner');  // 即便 agent-channel owner 也不够
    const runner = makeMockRunner();
    const handler = new CommandHandler(sessionManager, runner, { get: vi.fn(), hasMessages: vi.fn().mockReturnValue(false), getCount: vi.fn().mockReturnValue(0) } as any, eventBus);
    handler.registerAdapter({ channelName: 'main', sendText: vi.fn() } as any);
    handler.setMessageQueue({ isProcessing: vi.fn().mockReturnValue(false), getQueueLength: vi.fn().mockReturnValue(0) } as any);
    handler.setAgentRegistry(makeMockAgentRegistry());

    const result = await handler.handle('/restart', 'main', 'chat1', vi.fn(), 'user1');

    expect(result).not.toBeNull();
    expect((result as any).text).toContain('无权限');
  });

  it('daemon owner /restart returns null (notification sent internally)', async () => {
    ownersMock.value = ['user1'];
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager('owner');
    const runner = makeMockRunner();
    const adapter = { channelName: 'main', sendText: vi.fn(), send: vi.fn().mockResolvedValue(undefined) } as any;
    const handler = new CommandHandler(sessionManager, runner, { get: vi.fn(), hasMessages: vi.fn().mockReturnValue(false), getCount: vi.fn().mockReturnValue(0) } as any, eventBus);
    handler.registerAdapter(adapter);
    handler.setMessageQueue({
      isProcessing: vi.fn().mockReturnValue(false),
      getQueueLength: vi.fn().mockReturnValue(0),
      getQueueLengthByAgent: vi.fn().mockReturnValue(0),
      getProcessingCountByAgent: vi.fn().mockReturnValue(0),
    } as any);
    handler.setAgentRegistry(makeMockAgentRegistry());

    // Mock process.kill to prevent killing test process
    const originalKill = process.kill;
    process.kill = vi.fn() as any;

    try {
      // Use fake timers to handle the setTimeout in executeRestart
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const resultPromise = handler.handle('/restart', 'main', 'chat1', vi.fn(), 'user1');

      // Advance past the 500ms delay after adapter.send
      await vi.advanceTimersByTimeAsync(600);

      const result = await resultPromise;

      // Key assertion: handler returns null (not the restart text)
      // because the notification is sent via adapter.send() inside executeRestart
      expect(result).toBeNull();

      // adapter.send was called with the restart notification
      expect(adapter.send).toHaveBeenCalled();
      const calls = adapter.send.mock.calls;
      const restartNotification = calls.find((c: any) => c[1]?.text?.includes('重启'));
      expect(restartNotification).toBeDefined();

      vi.useRealTimers();
    } finally {
      process.kill = originalKill;
    }
  });

  it('daemon owner /restart is rejected when owning agent is busy', async () => {
    ownersMock.value = ['user1'];
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager('guest');
    const runner = makeMockRunner();
    const handler = new CommandHandler(sessionManager, runner, { get: vi.fn(), hasMessages: vi.fn().mockReturnValue(false), getCount: vi.fn().mockReturnValue(0) } as any, eventBus);
    handler.setMessageQueue({
      isProcessing: vi.fn().mockReturnValue(false),
      getQueueLength: vi.fn().mockReturnValue(0),
      getQueueLengthByAgent: vi.fn().mockReturnValue(1),
      getProcessingCountByAgent: vi.fn().mockReturnValue(2),
      getProcessingDetailsByAgent: vi.fn().mockReturnValue([
        { queueKey: 'session1::agent1', agentName: 'agent1' },
        { queueKey: 'session2::agent1', agentName: 'agent1' },
      ]),
    } as any);
    handler.setAgentRegistry(makeMockAgentRegistry());

    const result = await handler.handle('/restart', 'main', 'chat1', vi.fn(), 'user1');

    expect((result as any).kind).toBe('command.error');
    expect((result as any).text).toContain('3 个任务执行中');
  });
});
