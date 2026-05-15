import { describe, it, expect, vi } from 'vitest';
import { CommandHandler } from '../../src/core/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config } from '../../src/types.js';

function createMockSessionManager(overrides: Record<string, any> = {}) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'sess-1', channel: 'aun', channelId: 'chat1',
      projectPath: '/tmp/test', agentId: 'claude',
      chatType: 'private', sessionMode: 'interactive',
      metadata: { permissionMode: 'auto' },
      createdAt: Date.now(), updatedAt: Date.now(),
    }),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
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
    getSessionById: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

function createMockAgentRunner() {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    getModel: vi.fn().mockReturnValue('sonnet'),
    getEffort: vi.fn().mockReturnValue('medium'),
    setModel: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus']),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([
      { key: 'auto', nameZh: '自动', description: '', available: true },
      { key: 'bypass', nameZh: '免审批', description: '', available: true },
      { key: 'plan', nameZh: '计划', description: '', available: true },
      { key: 'edit', nameZh: '编辑', description: '', available: true },
      { key: 'request', nameZh: '请求', description: '', available: true },
      { key: 'noask', nameZh: '静默', description: '', available: true },
    ]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
    capabilities: { fork: true },
    getSessionMessages: vi.fn().mockResolvedValue([]),
  } as any;
}

function createHandler(opts: { sessionManager?: any } = {}) {
  const sm = opts.sessionManager ?? createMockSessionManager();
  const config: Config = { channels: { aun: { aid: 'test' } }, projects: { defaultPath: '/tmp' } } as any;
  const cache = { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any;
  const eb = new EventBus();
  return { handler: new CommandHandler(sm, createMockAgentRunner(), config, cache, eb), sm };
}

describe('execMenu', () => {
  describe('/perm', () => {
    it('query returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/perm', 'query', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'auto' } });
    });

    it('update switches mode', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.execMenu('/perm bypass', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'bypass' } });
      expect(sm.updateSession).toHaveBeenCalledWith('sess-1', { metadata: { permissionMode: 'bypass' } });
    });

    it('update rejects invalid mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/perm invalid', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '无效模式: invalid' });
    });

    it('update rejects non-owner', async () => {
      const sm = createMockSessionManager({
        resolveIdentity: vi.fn().mockReturnValue({ role: 'guest' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenu('/perm bypass', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '无权限' });
    });

    it('update without arg returns error', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/perm', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '缺少目标模式' });
    });
  });

  describe('/chatmode', () => {
    it('query returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/chatmode', 'query', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'interactive' } });
    });

    it('update switches mode', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.execMenu('/chatmode proactive', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive' } });
      expect(sm.updateSession).toHaveBeenCalledWith('sess-1', { sessionMode: 'proactive' });
    });

    it('update rejects invalid mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/chatmode invalid', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '无效模式: invalid' });
    });

    it('update rejects non-admin in group', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive', metadata: {},
        }),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'guest' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenu('/chatmode proactive', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '无权限：群聊中仅管理员可切换' });
    });
  });

  describe('unsupported command', () => {
    it('returns error for unknown command', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('/unknown', 'query', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '不支持 exec 模式: /unknown' });
    });
  });

  describe('no active session', () => {
    it('returns error when no session', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(null),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenu('/perm', 'query', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '当前无活跃会话' });
    });
  });

  describe('edge cases', () => {
    it('returns error for whitespace-only cmd', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenu('   ', 'query', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '缺少命令' });
    });

    it('handles cmd with extra whitespace', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.execMenu('  /perm  bypass  ', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'bypass' } });
      expect(sm.updateSession).toHaveBeenCalledWith('sess-1', { metadata: { permissionMode: 'bypass' } });
    });

    it('filters unavailable modes from listModes', async () => {
      const sm = createMockSessionManager();
      const { handler } = createHandler({ sessionManager: sm });
      // Override agent to mark 'max' as unavailable - should not appear in validModes
      (handler as any).agentMap.get('[default]::claude').listModes = vi.fn().mockReturnValue([
        { key: 'auto', available: true },
        { key: 'bypass', available: false, unavailableReason: 'N/A' },
      ]);
      const result = await handler.execMenu('/perm bypass', 'update', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ error: '无效模式: bypass' });
    });
  });
});
