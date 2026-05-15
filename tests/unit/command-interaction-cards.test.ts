import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { CommandHandler } from '../../src/core/command-handler.js';
import { InteractionRouter } from '../../src/core/interaction-router.js';
import { PermissionGateway } from '../../src/core/permission.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter, InteractionRequest, InteractionResponse } from '../../src/types.js';

// === Mock Factories ===

function createMockSessionManager(overrides?: Partial<Record<string, any>>) {
  const defaultSession = {
    id: 'test-session',
    channel: 'feishu',
    channelId: 'chat1',
    projectPath: '/tmp/test',
    threadId: '',
    agentId: 'claude',
    chatType: 'private',
    sessionMode: 'interactive',
    agentSessionId: 'claude-s1',
    name: '默认会话',
    metadata: { isActive: true },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return {
    getOrCreateSession: vi.fn().mockResolvedValue(defaultSession),
    getActiveSession: vi.fn().mockResolvedValue(defaultSession),
    getThreadSession: vi.fn().mockResolvedValue(null),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
    recordSuccess: vi.fn(),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() }),
    setSafeMode: vi.fn(),
    switchProject: vi.fn(),
    createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([defaultSession]),
    switchSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateAgentSessionIdBySessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    clearProcessing: vi.fn(),
    getSessionByProjectPath: vi.fn().mockResolvedValue(null),
    getSessionByName: vi.fn().mockResolvedValue(null),
    getSessionByUuidPrefix: vi.fn().mockResolvedValue(null),
    migrateChannelNames: vi.fn(),
    listSdkSessions: vi.fn().mockResolvedValue([]),
    scanCliSessions: vi.fn().mockResolvedValue([]),
    checkSessionFileExists: vi.fn().mockReturnValue(true),
    readSessionFirstMessage: vi.fn().mockReturnValue(null),
    switchAgent: vi.fn().mockResolvedValue(defaultSession),
    getSessionFileInfo: vi.fn().mockReturnValue({ turns: 0 }),
    getSafeModeSessionCount: vi.fn().mockReturnValue(0),
    ...overrides,
  } as any;
}

function createMockAgentRunner(overrides?: Partial<Record<string, any>>) {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    clearSession: vi.fn().mockResolvedValue(true),
    compactSession: vi.fn(),
    hasActiveStream: vi.fn().mockReturnValue(false),
    getModel: vi.fn().mockReturnValue('sonnet'),
    getEffort: vi.fn().mockReturnValue(undefined),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([
      { key: 'auto', nameZh: '自动', description: '自动策略', available: true },
      { key: 'bypass', nameZh: '跳过', description: '跳过审批', available: true },
      { key: 'request', nameZh: '请求', description: '请求审批', available: true },
    ]),
    capabilities: { clear: true, compact: true },
    ...overrides,
  } as any;
}

function createMockConfig(): Config {
  return {
    channels: {
      feishu: { appId: '', appSecret: '', owner: 'owner1' },
    },
    projects: {
      defaultPath: '/tmp/test',
      list: { test: '/tmp/test', other: '/tmp/other' },
    },
  } as any;
}

function createMockMessageCache() {
  return {
    getCount: vi.fn().mockReturnValue(0),
    hasMessages: vi.fn().mockReturnValue(false),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  } as any;
}

function createMockMessageQueue() {
  return {
    acquireLock: vi.fn().mockReturnValue(vi.fn()),
    getQueueLength: vi.fn().mockReturnValue(0),
    getGlobalQueueLength: vi.fn().mockReturnValue(0),
    getGlobalProcessingCount: vi.fn().mockReturnValue(0),
    isProcessing: vi.fn().mockReturnValue(false),
  } as any;
}

/** Create adapter with or without sendInteraction support */
function createMockAdapter(supportInteraction = true): ChannelAdapter & { sendInteraction: ReturnType<typeof vi.fn> } {
  const adapter: any = {
    channelName: 'feishu',
    sendText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  };
  if (supportInteraction) {
    adapter.sendInteraction = vi.fn().mockResolvedValue(true);
    adapter.onInteraction = vi.fn();
  }
  return adapter;
}

// === Test Setup ===

function createTestEnv(opts?: {
  adapterSupportsInteraction?: boolean;
  withInteractionRouter?: boolean;
  runnerOverrides?: Partial<Record<string, any>>;
  sessionManagerOverrides?: Partial<Record<string, any>>;
}) {
  const sessionManager = createMockSessionManager(opts?.sessionManagerOverrides);
  const runner = createMockAgentRunner(opts?.runnerOverrides);
  const agentMap = new Map([['[default]::claude', runner]]);
  const eventBus = new EventBus();
  const config = createMockConfig();
  const messageCache = createMockMessageCache();
  const messageQueue = createMockMessageQueue();
  const adapter = createMockAdapter(opts?.adapterSupportsInteraction ?? true);
  const interactionRouter = new InteractionRouter();
  const gateway = new PermissionGateway();
  gateway.setEventBus(eventBus);

  const cmdHandler = new CommandHandler(
    sessionManager,
    agentMap,
    config,
    messageCache,
    eventBus,
  );
  cmdHandler.setPermissionGateway(gateway);
  cmdHandler.setMessageQueue(messageQueue);
  cmdHandler.registerAdapter(adapter);

  if (opts?.withInteractionRouter !== false) {
    cmdHandler.setInteractionRouter(interactionRouter);
  }

  return { cmdHandler, sessionManager, runner, adapter, interactionRouter, eventBus, messageCache, messageQueue, config };
}

async function cmd(handler: CommandHandler, input: string, channel = 'feishu', channelId = 'chat1', userId?: string) {
  return handler.handle(input, channel, channelId, undefined, userId, undefined);
}

// === Tests ===

describe('CommandHandler Interaction Cards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure test project directories exist for /plist fs.existsSync checks
    fs.mkdirSync('/tmp/test', { recursive: true });
    fs.mkdirSync('/tmp/other', { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('P1: /restart text confirmation', () => {
    it('should return restart text when no pending messages', async () => {
      const { cmdHandler } = createTestEnv();

      const result = await cmd(cmdHandler, '/restart');

      // No pending messages → direct restart message
      expect(result).toContain('重启');
    });

    it('should warn about unsent messages and ask for re-confirmation', async () => {
      const { cmdHandler, messageCache } = createTestEnv();
      messageCache.hasMessages.mockReturnValue(true);
      messageCache.getCount.mockReturnValue(3);

      const result = await cmd(cmdHandler, '/restart');

      // Should return text warning about pending messages
      expect(result).toContain('3 条新消息');
      expect(result).toContain('再次输入 /restart');
    });

    it('should work without interaction support', async () => {
      const { cmdHandler, adapter } = createTestEnv({ adapterSupportsInteraction: false });

      const result = await cmd(cmdHandler, '/restart');

      // /restart uses text-based confirm, not interaction cards
      expect(adapter.sendInteraction).toBeUndefined();
      expect(result).toContain('重启');
    });

    it('should work without interactionRouter', async () => {
      const { cmdHandler } = createTestEnv({ withInteractionRouter: false });

      const result = await cmd(cmdHandler, '/restart');
      expect(result).toContain('重启');
    });

    it('should work when sendInteraction returns false', async () => {
      const { cmdHandler, adapter } = createTestEnv();
      adapter.sendInteraction.mockResolvedValue(false);

      const result = await cmd(cmdHandler, '/restart');
      expect(result).toContain('重启');
    });
  });

  describe('/clear direct execution (no card)', () => {
    it('should execute clear directly without card', async () => {
      const { cmdHandler, adapter, runner } = createTestEnv();

      const result = await cmd(cmdHandler, '/clear');

      // Should NOT send an interaction card — /clear is direct execution
      expect(adapter.sendInteraction).not.toHaveBeenCalled();
      // Should execute clear directly
      expect(runner.clearSession).toHaveBeenCalledTimes(1);
      expect(result).toContain('已清空');
    });

    it('should return error when session has no history', async () => {
      const { cmdHandler } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue({
            id: 'test-session', channel: 'feishu', channelId: 'chat1',
            projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
            agentSessionId: '', // no agent session
            metadata: { isActive: true },
            createdAt: Date.now(), updatedAt: Date.now(),
          }),
          getOrCreateSession: vi.fn().mockResolvedValue({
            id: 'test-session', channel: 'feishu', channelId: 'chat1',
            projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
            agentSessionId: '',
            metadata: { isActive: true },
            createdAt: Date.now(), updatedAt: Date.now(),
          }),
        },
      });

      const result = await cmd(cmdHandler, '/clear');
      expect(result).toContain('没有历史记录');
    });
  });

  describe('P2: /model action card (no-args)', () => {
    it('should send action card with model buttons', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      const result = await cmd(cmdHandler, '/model');

      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('模型');

      // Should have buttons for each model
      const buttons = (interaction.kind as any).buttons;
      expect(buttons).toHaveLength(3); // sonnet, opus, haiku

      // Current model should be marked primary with ✓
      const currentBtn = buttons.find((b: any) => b.key === 'sonnet');
      expect(currentBtn?.style).toBe('primary');
      expect(currentBtn?.label).toContain('✓');

      expect(result).toBeNull();
    });

    it('should fallback to text when no interaction support', async () => {
      const { cmdHandler } = createTestEnv({ adapterSupportsInteraction: false });

      const result = await cmd(cmdHandler, '/model');

      expect(result).toContain('当前模型');
      expect(result).toContain('sonnet');
    });

    it('should execute model switch when button is clicked', async () => {
      const { cmdHandler, interactionRouter, adapter } = createTestEnv();

      await cmd(cmdHandler, '/model');

      const pending = interactionRouter.getPending('test-session');
      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: 'opus', // click the opus button directly
      });

      await vi.advanceTimersByTimeAsync(10);
      // The callback should have called handle('/model opus') which sends text result
      expect(adapter.sendText).toHaveBeenCalled();
    });
  });

  describe('P2: /agent action card (no-args)', () => {
    it('should send action card with agent buttons', async () => {
      const runner2 = createMockAgentRunner({ name: 'gemini' });
      const sessionManager = createMockSessionManager();
      const agentMap = new Map([
        ['[default]::claude', createMockAgentRunner()],
        ['[default]::gemini', runner2],
      ]);
      const eventBus = new EventBus();
      const config = createMockConfig();
      const adapter = createMockAdapter(true);
      const interactionRouter = new InteractionRouter();

      const cmdHandler = new CommandHandler(
        sessionManager,
        agentMap,
        config,
        createMockMessageCache(),
        eventBus,
      );
      cmdHandler.setInteractionRouter(interactionRouter);
      cmdHandler.registerAdapter(adapter);

      const result = await cmdHandler.handle('/agent', 'feishu', 'chat1', undefined, undefined, undefined);

      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');

      const buttons = (interaction.kind as any).buttons;
      expect(buttons).toHaveLength(2);

      // Current agent should be primary with ✓
      const currentBtn = buttons.find((b: any) => b.key === 'claude');
      expect(currentBtn?.style).toBe('primary');
      expect(currentBtn?.label).toContain('✓');

      expect(result).toBeNull();
    });

    it('should not send card when only one agent available', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      // Only one agent ('claude'), so card should not be sent
      const result = await cmd(cmdHandler, '/agent');

      expect(adapter.sendInteraction).not.toHaveBeenCalled();
      expect(result).toContain('当前 Agent');
    });
  });

  describe('P2: /perm action card (no-args)', () => {
    it('should send action card with permission mode buttons', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      const result = await cmd(cmdHandler, '/perm');

      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('权限');

      // Should have buttons for available modes
      const buttons = (interaction.kind as any).buttons;
      expect(buttons.length).toBeGreaterThanOrEqual(1);

      expect(result).toBeNull();
    });

    it('should fallback to text when no interaction support', async () => {
      const { cmdHandler } = createTestEnv({ adapterSupportsInteraction: false });

      const result = await cmd(cmdHandler, '/perm');
      expect(result).toContain('当前权限模式');
    });
  });

  describe('P2: /plist action card', () => {
    it('should send action card with per-project buttons', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      const result = await cmd(cmdHandler, '/plist');

      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('项目');

      // Should have buttons for each project
      const buttons = (interaction.kind as any).buttons;
      expect(buttons).toHaveLength(2); // 'test' and 'other'

      // Current project should be marked primary
      const currentBtn = buttons.find((b: any) => b.key === 'test');
      expect(currentBtn?.style).toBe('primary');
      expect(currentBtn?.label).toContain('✓');

      const otherBtn = buttons.find((b: any) => b.key === 'other');
      expect(otherBtn?.style).toBe('default');

      expect(result).toBeNull();
    });

    it('should fallback to text when no interaction support', async () => {
      const { cmdHandler } = createTestEnv({ adapterSupportsInteraction: false });

      const result = await cmd(cmdHandler, '/plist');

      expect(result).toContain('可用项目');
      expect(result).toContain('提示: 使用 /p <名称> 切换项目');
    });

    it('should switch project when button is clicked', async () => {
      const { cmdHandler, interactionRouter, adapter } = createTestEnv({
        sessionManagerOverrides: {
          switchProject: vi.fn().mockResolvedValue({
            id: 'new-session', projectPath: '/tmp/other', agentId: 'claude',
            agentSessionId: '', name: '默认会话', metadata: { isActive: true },
            createdAt: Date.now(), updatedAt: Date.now(),
          }),
        },
      });

      await cmd(cmdHandler, '/plist');

      const pending = interactionRouter.getPending('test-session');
      expect(pending).toHaveLength(1);

      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: 'other', // click the "other" project button
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.sendText).toHaveBeenCalled();
    });

    it('should not switch when clicking current project', async () => {
      const { cmdHandler, interactionRouter, adapter } = createTestEnv();

      await cmd(cmdHandler, '/plist');

      const pending = interactionRouter.getPending('test-session');
      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: 'test', // click current project — should be no-op
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.sendText).not.toHaveBeenCalled();
    });

    it('should verify operatorId in callback', async () => {
      const { cmdHandler, interactionRouter, adapter } = createTestEnv({
        sessionManagerOverrides: {
          switchProject: vi.fn().mockResolvedValue({
            id: 'new-session', projectPath: '/tmp/other', agentId: 'claude',
            agentSessionId: '', name: '默认会话', metadata: { isActive: true },
            createdAt: Date.now(), updatedAt: Date.now(),
          }),
        },
      });

      await cmd(cmdHandler, '/plist', 'feishu', 'chat1', 'user-A');

      const pending = interactionRouter.getPending('test-session');
      // Different user clicks
      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: 'other',
        operatorId: 'user-B',
      });

      await vi.advanceTimersByTimeAsync(10);
      // Should be rejected — different operatorId
      expect(adapter.sendText).not.toHaveBeenCalled();
    });
  });

  describe('P2: /p delegates to /plist', () => {
    it('should delegate /p (no-args) to /plist', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      const result = await cmd(cmdHandler, '/p');

      // /p (no-args) now delegates to /plist, which sends action card
      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('项目');
      expect(result).toBeNull();
    });

    it('should fallback to text list when no interaction support', async () => {
      const { cmdHandler } = createTestEnv({ adapterSupportsInteraction: false });

      const result = await cmd(cmdHandler, '/p');

      expect(result).toContain('可用项目');
      expect(result).toContain('提示: 使用 /p <名称> 切换项目');
    });
  });

  describe('P2: /slist action card', () => {
    it('should send action card with per-session buttons', async () => {
      const session1 = {
        id: 'session-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-1', name: 'Session A', metadata: { isActive: true },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const session2 = {
        id: 'session-2', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-2', name: 'Session B', metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      const { cmdHandler, adapter } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue(session1),
          getOrCreateSession: vi.fn().mockResolvedValue(session1),
          listSessions: vi.fn().mockResolvedValue([session1, session2]),
        },
      });

      const result = await cmd(cmdHandler, '/slist');

      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('会话');

      const buttons = (interaction.kind as any).buttons;
      expect(buttons).toHaveLength(2);

      // Button keys are numeric indices (1-based), not session names
      const activeBtn = buttons.find((b: any) => b.key === '1');
      expect(activeBtn?.style).toBe('primary');
      expect(activeBtn?.label).toContain('✓');

      const otherBtn = buttons.find((b: any) => b.key === '2');
      expect(otherBtn?.style).toBe('default');

      expect(result).toBeNull();
    });

    it('should send card even with one session', async () => {
      const { cmdHandler, adapter } = createTestEnv();

      const result = await cmd(cmdHandler, '/slist');

      // displaySessions.length >= 1 triggers card
      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should switch session when button is clicked', async () => {
      const session1 = {
        id: 'session-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-1', name: 'Session A', metadata: { isActive: true },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const session2 = {
        id: 'session-2', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-2', name: 'Session B', metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      const { cmdHandler, adapter, interactionRouter } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue(session1),
          getOrCreateSession: vi.fn().mockResolvedValue(session1),
          listSessions: vi.fn().mockResolvedValue([session1, session2]),
          getSessionByName: vi.fn().mockImplementation(async (_ch: string, _id: string, name: string) => {
            if (name === 'Session B') return session2;
            return null;
          }),
          switchToSession: vi.fn().mockResolvedValue(true),
          readSessionLastUserMessage: vi.fn().mockReturnValue(null),
        },
      });

      await cmd(cmdHandler, '/slist');

      const pending = interactionRouter.getPending('session-1');
      expect(pending).toHaveLength(1);

      // Button key is index '2' (second session), not session name
      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: '2',
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.sendText).toHaveBeenCalled();
    });

    it('should verify operatorId in callback', async () => {
      const session1 = {
        id: 'session-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-1', name: 'Session A', metadata: { isActive: true },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const session2 = {
        id: 'session-2', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-2', name: 'Session B', metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      const { cmdHandler, adapter, interactionRouter } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue(session1),
          getOrCreateSession: vi.fn().mockResolvedValue(session1),
          listSessions: vi.fn().mockResolvedValue([session1, session2]),
        },
      });

      await cmd(cmdHandler, '/slist', 'feishu', 'chat1', 'user-A');

      const pending = interactionRouter.getPending('session-1');
      interactionRouter.handle({
        type: 'interaction.response',
        id: pending[0],
        action: '2',
        operatorId: 'user-B',
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(adapter.sendText).not.toHaveBeenCalled();
    });
  });

  describe('P2: /s delegates to /slist', () => {
    it('should delegate /s (no-args) to /slist', async () => {
      const session1 = {
        id: 'session-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-1', name: 'Session A', metadata: { isActive: true },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const session2 = {
        id: 'session-2', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', chatType: 'private',
        agentSessionId: 'cs-2', name: 'Session B', metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };

      const { cmdHandler, adapter } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue(session1),
          getOrCreateSession: vi.fn().mockResolvedValue(session1),
          listSessions: vi.fn().mockResolvedValue([session1, session2]),
        },
      });

      const result = await cmd(cmdHandler, '/s');

      // /s (no-args) now delegates to /slist, which sends action card
      expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
      const interaction = adapter.sendInteraction.mock.calls[0][1] as InteractionRequest;
      expect(interaction.kind.kind).toBe('action');
      expect((interaction.kind as any).title).toContain('会话');
      expect(result).toBeNull();
    });

    it('should fallback to text when no session', async () => {
      const { cmdHandler } = createTestEnv({
        sessionManagerOverrides: {
          getActiveSession: vi.fn().mockResolvedValue(null),
        },
      });

      const result = await cmd(cmdHandler, '/s');
      expect(result).toContain('没有活跃会话');
    });
  });

  describe('Timeout and cleanup', () => {
    it('should register with timeout for all card types', async () => {
      const { cmdHandler, interactionRouter } = createTestEnv();

      // Use /model (which sends an action card) instead of /restart (which uses text-based confirm)
      await cmd(cmdHandler, '/model');

      const pending = interactionRouter.getPending('test-session');
      expect(pending).toHaveLength(1);

      // After timeout (120s), handler should be removed
      vi.advanceTimersByTime(121_000);
      expect(interactionRouter.getPending('test-session')).toHaveLength(0);
    });
  });

  describe('Error handling', () => {
    it('should fallback when sendInteraction throws', async () => {
      const { cmdHandler, adapter } = createTestEnv();
      adapter.sendInteraction.mockRejectedValue(new Error('network error'));

      const result = await cmd(cmdHandler, '/restart');

      // Should fall back to text
      expect(result).toContain('重启');
    });
  });
});
