import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';
import { InteractionRouter } from '../../src/core/interaction-router.js';
import { PermissionGateway } from '../../src/core/permission.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter } from '../../src/types.js';

// ── Mocks (borrowed from command-interaction-cards.test.ts style) ──

function createMockSessionManager() {
  const defaultSession = {
    id: 'sess-ask-1',
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
    listSessions: vi.fn().mockResolvedValue([defaultSession]),
    getSafeModeSessionCount: vi.fn().mockReturnValue(0),
    updateSession: vi.fn().mockResolvedValue(undefined),
    clearProcessing: vi.fn(),
    migrateChannelNames: vi.fn(),
  } as any;
}

function createMockAgentRunner() {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    hasActiveStream: vi.fn().mockReturnValue(false),
    getModel: vi.fn().mockReturnValue('sonnet'),
    listModels: vi.fn().mockReturnValue(['sonnet']),
    listModes: vi.fn().mockReturnValue([
      { key: 'auto', nameZh: '自动', description: '', available: true },
      { key: 'bypass', nameZh: '跳过', description: '', available: true },
    ]),
    getMode: vi.fn().mockReturnValue('bypass'),
    capabilities: { clear: true, compact: true },
  } as any;
}

function createMockAdapter(): ChannelAdapter {
  return {
    channelName: 'feishu',
    sendText: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockConfig(): Config {
  return {
    channels: { feishu: { appId: '', appSecret: '', owner: 'owner1' } },
    projects: { defaultPath: '/tmp/test', list: {} },
  } as any;
}

function createEnv() {
  const sessionManager = createMockSessionManager();
  const runner = createMockAgentRunner();
  const agentMap = new Map([['claude', runner]]);
  const eventBus = new EventBus();
  const config = createMockConfig();
  const messageCache = { getCount: vi.fn().mockReturnValue(0), hasMessages: vi.fn().mockReturnValue(false), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any;
  const adapter = createMockAdapter();
  const interactionRouter = new InteractionRouter();
  const gateway = new PermissionGateway();
  gateway.setEventBus(eventBus);

  const cmdHandler = new CommandHandler(sessionManager, agentMap, messageCache, eventBus);
  cmdHandler.setPermissionGateway(gateway);
  cmdHandler.registerAdapter(adapter);
  cmdHandler.setInteractionRouter(interactionRouter);

  return { cmdHandler, sessionManager, interactionRouter, adapter };
}

async function runCmd(h: CommandHandler, input: string, userId = 'owner1') {
  return h.handle(input, 'feishu', 'chat1', undefined, userId, undefined);
}

// ── Tests ──

describe('/ask command — route replies to pending interactions', () => {
  let env: ReturnType<typeof createEnv>;

  beforeEach(() => {
    env = createEnv();
  });

  it('returns hint message when no pending interactions and no args', async () => {
    const result = await runCmd(env.cmdHandler, '/ask');
    expect(result).toContain('没有待回答的问题');
  });

  it('returns error when args given but no pending interactions', async () => {
    const result = await runCmd(env.cmdHandler, '/ask 1');
    expect(result).toContain('没有待回答');
  });

  it('lists count when pending exists but no args', async () => {
    env.interactionRouter.register('req-abc', 'sess-ask-1', vi.fn(), { fallbackCommand: 'ask' });
    const result = await runCmd(env.cmdHandler, '/ask');
    expect(result).toContain('1 个待回答问题');
  });

  it('routes /ask <arg> to pending interaction callback', async () => {
    const cb = vi.fn();
    env.interactionRouter.register('req-num', 'sess-ask-1', cb, { fallbackCommand: 'ask' });

    const result = await runCmd(env.cmdHandler, '/ask 2');
    expect(result).toBe('✓ 已回答');
    expect(cb).toHaveBeenCalledWith('2', undefined, 'owner1');
  });

  it('routes free-form /ask text to pending interaction callback', async () => {
    const cb = vi.fn();
    env.interactionRouter.register('req-free', 'sess-ask-1', cb, { fallbackCommand: 'ask' });

    await runCmd(env.cmdHandler, '/ask 自定义答案');
    expect(cb).toHaveBeenCalledWith('自定义答案', undefined, 'owner1');
  });

  it('ignores interactions from other sessions', async () => {
    const cb = vi.fn();
    env.interactionRouter.register('req-other', 'sess-other', cb, { fallbackCommand: 'ask' });

    const result = await runCmd(env.cmdHandler, '/ask 1');
    expect(result).toContain('没有待回答');
    expect(cb).not.toHaveBeenCalled();
  });

  it('routes to earliest pending when multiple exist', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    env.interactionRouter.register('req-first', 'sess-ask-1', cb1, { fallbackCommand: 'ask' });
    env.interactionRouter.register('req-second', 'sess-ask-1', cb2, { fallbackCommand: 'ask' });

    await runCmd(env.cmdHandler, '/ask 1');
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).not.toHaveBeenCalled();
  });

  it('passes operatorId (userId) to callback for access control', async () => {
    const cb = vi.fn();
    env.interactionRouter.register('req-op', 'sess-ask-1', cb, { fallbackCommand: 'ask' });

    await runCmd(env.cmdHandler, '/ask approve', 'user-123');
    expect(cb).toHaveBeenCalledWith('approve', undefined, 'user-123');
  });
});
