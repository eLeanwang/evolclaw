import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandHandler, type MenuItem, type MenuNext } from '../../src/core/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter } from '../../src/types.js';

// === Mock Factories ===

function createMockSessionManager(overrides: Record<string, any> = {}) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'sess-1', channel: 'aun', channelId: 'chat1',
      projectPath: '/tmp/test', threadId: '', agentId: 'claude',
      chatType: 'private', sessionMode: 'interactive',
      agentSessionId: 'claude-s1', metadata: {},
      createdAt: Date.now(), updatedAt: Date.now(),
      identity: { role: 'owner', mode: 'interactive' },
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

function createMockAgentRunner(overrides: Record<string, any> = {}) {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    compactSession: vi.fn(),
    getModel: vi.fn().mockReturnValue('sonnet'),
    getEffort: vi.fn().mockReturnValue('medium'),
    setModel: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
    capabilities: { fork: true },
    getSessionMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function createMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    channels: {
      aun: { aid: 'test.test' },
    },
    projects: { defaultPath: '/tmp/test', list: { myproj: '/tmp/myproj', other: '/tmp/other' } },
    ...overrides,
  } as any;
}

function createMockMessageCache() {
  return { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any;
}

function createHandler(opts: {
  sessionManager?: any;
  agentRunner?: any;
  config?: Config;
  agentMap?: Map<string, any>;
} = {}) {
  const sm = opts.sessionManager ?? createMockSessionManager();
  const config = opts.config ?? createMockConfig();
  const cache = createMockMessageCache();
  const eventBus = new EventBus();
  const agentArg = opts.agentMap ?? opts.agentRunner ?? createMockAgentRunner();
  return { handler: new CommandHandler(sm, agentArg, config, cache, eventBus), sm, config };
}

// === Helpers ===

function flatCommands(groups: { group: string; commands: MenuItem[] }[]): MenuItem[] {
  return groups.flatMap(g => g.commands);
}

function findCmd(groups: { group: string; commands: MenuItem[] }[], cmd: string): MenuItem | undefined {
  return flatCommands(groups).find(c => c.cmd === cmd);
}

// =====================================================================
// getMenuItems
// =====================================================================

describe('getMenuItems', () => {
  describe('owner / private', () => {
    it('returns all command groups', () => {
      const { handler } = createHandler();
      const items = handler.getMenuItems('owner', 'private');
      const groupNames = items.map(g => g.group);
      expect(groupNames).toContain('项目管理');
      expect(groupNames).toContain('会话管理');
      expect(groupNames).toContain('Agent 与模型');
      expect(groupNames).toContain('权限管理');
      expect(groupNames).toContain('运维');
      expect(groupNames).toContain('帮助');
    });

    it('/new has next.type = text', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/new');
      expect(item).toBeDefined();
      expect(item!.next).toEqual({ type: 'text' });
    });

    it('/s has next.type = select + dynamic', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/s');
      expect(item!.next).toEqual({ type: 'select', dynamic: true });
    });

    it('/del has next.type = select + dynamic', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/del');
      expect(item!.next).toEqual({ type: 'select', dynamic: true });
    });

    it('/p has next.type = select + dynamic', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/p');
      expect(item!.next).toEqual({ type: 'select', dynamic: true });
    });

    it('/bind has next.type = text', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/bind');
      expect(item).toBeDefined();
      expect(item!.next).toEqual({ type: 'text' });
    });

    it('/agent has next.type = select + dynamic', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/agent');
      expect(item!.next).toEqual({ type: 'select', dynamic: true });
    });

    it('/model has next.type = select + dynamic', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/model');
      expect(item!.next).toEqual({ type: 'select', dynamic: true });
    });

    it('/effort has static select items with no desc', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/effort');
      expect(item!.next!.type).toBe('select');
      expect(item!.next!.dynamic).toBeUndefined();
      const values = item!.next!.items!.map(i => i.value);
      expect(values).toEqual(['low', 'medium', 'high', 'max']);
      for (const sub of item!.next!.items!) {
        expect(sub.desc).toBeUndefined();
      }
    });

    it('/perm has all mode options with desc for owner', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/perm');
      expect(item!.next!.type).toBe('select');
      const values = item!.next!.items!.map(i => i.value);
      expect(values).toContain('auto');
      expect(values).toContain('bypass');
      expect(values).toContain('plan');
      expect(values).toContain('edit');
      expect(values).toContain('request');
      expect(values).toContain('noask');
      expect(values).toContain('allow');
      expect(values).toContain('always');
      expect(values).toContain('deny');
      for (const sub of item!.next!.items!) {
        expect(sub.desc).toBeTruthy();
      }
    });

    it('/name has next.type = text', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/name');
      expect(item!.next).toEqual({ type: 'text' });
    });

    it('/fork has next.type = text', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('owner'), '/fork');
      expect(item!.next).toEqual({ type: 'text' });
    });

    it('leaf commands have no next field', () => {
      const { handler } = createHandler();
      const leafCmds = ['/pwd', '/compact', '/status', '/stop', '/check', '/help'];
      const all = flatCommands(handler.getMenuItems('owner'));
      for (const cmd of leafCmds) {
        const item = all.find(c => c.cmd === cmd);
        if (item) expect(item.next).toBeUndefined();
      }
    });
  });

  describe('admin (non-owner)', () => {
    it('does not include /bind', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('admin'), '/bind');
      expect(item).toBeUndefined();
    });

    it('/perm does not include owner-only modes', () => {
      const { handler } = createHandler();
      const item = findCmd(handler.getMenuItems('admin'), '/perm');
      const values = item!.next!.items!.map(i => i.value);
      expect(values).not.toContain('bypass');
      expect(values).not.toContain('plan');
      expect(values).not.toContain('auto');
      expect(values).not.toContain('edit');
      expect(values).not.toContain('request');
      expect(values).not.toContain('noask');
      expect(values).toContain('allow');
    });

    it('includes admin groups', () => {
      const { handler } = createHandler();
      const groups = handler.getMenuItems('admin').map(g => g.group);
      expect(groups).toContain('项目管理');
      expect(groups).toContain('Agent 与模型');
    });
  });

  describe('guest / private', () => {
    it('returns session management and help groups', () => {
      const { handler } = createHandler();
      const items = handler.getMenuItems('guest', 'private');
      const groups = items.map(g => g.group);
      expect(groups).toContain('会话管理');
      expect(groups).toContain('帮助');
      expect(groups).not.toContain('项目管理');
      expect(groups).not.toContain('Agent 与模型');
    });

    it('does not include admin-only commands like /fork, /compact', () => {
      const { handler } = createHandler();
      const all = flatCommands(handler.getMenuItems('guest', 'private'));
      expect(all.find(c => c.cmd === '/fork')).toBeUndefined();
      expect(all.find(c => c.cmd === '/compact')).toBeUndefined();
    });
  });

  describe('guest / group', () => {
    it('returns minimal commands', () => {
      const { handler } = createHandler();
      const items = handler.getMenuItems('guest', 'group');
      const all = flatCommands(items);
      const cmds = all.map(c => c.cmd);
      expect(cmds).toContain('/status');
      expect(cmds).toContain('/help');
      expect(cmds).not.toContain('/new');
      expect(cmds).not.toContain('/s');
    });

    it('none of the minimal commands have next', () => {
      const { handler } = createHandler();
      const all = flatCommands(handler.getMenuItems('guest', 'group'));
      for (const item of all) {
        expect(item.next).toBeUndefined();
      }
    });
  });

  describe('every item has a label', () => {
    it('owner items all have label', () => {
      const { handler } = createHandler();
      for (const item of flatCommands(handler.getMenuItems('owner'))) {
        expect(item.label).toBeTruthy();
      }
    });

    it('guest group items all have label', () => {
      const { handler } = createHandler();
      for (const item of flatCommands(handler.getMenuItems('guest', 'group'))) {
        expect(item.label).toBeTruthy();
      }
    });
  });
});

// =====================================================================
// getSubMenuItems
// =====================================================================

describe('getSubMenuItems', () => {
  describe('/s — session list', () => {
    it('returns sessions with agentSessionId prefix and relative time in desc', async () => {
      const sm = createMockSessionManager({
        listSessions: vi.fn().mockResolvedValue([
          { id: 'aun-chat1-1714300060000', name: 'dev', agentSessionId: 'abcdef12-3456-7890-abcd-ef1234567890', updatedAt: Date.now() - 60000 },
          { id: 'aun-chat1-1714300000000', name: 'prod', agentSessionId: '11223344-5566-7788-99aa-bbccddeeff00', updatedAt: Date.now() - 3600000 },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/s', 'aun', 'chat1');
      expect(items).toHaveLength(3);
      expect(items![0].value).toBe('dev');
      expect(items![0].label).toBe('dev');
      expect(items![0].desc).toBe('abcdef12 · 1分钟前');
      expect(items![1].desc).toBe('11223344 · 1小时前');
      expect(items![2]).toEqual({ value: 'cli', label: '查看 CLI 会话', desc: '列出未导入的 CLI 本地会话' });
    });

    it('shows only relative time when no agentSessionId', async () => {
      const sm = createMockSessionManager({
        listSessions: vi.fn().mockResolvedValue([
          { id: 'aun-chat1-1714300000000', name: '', agentSessionId: null, updatedAt: Date.now() },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/s', 'aun', 'chat1');
      expect(items![0].value).toBe('aun-chat');
      expect(items![0].label).toBe('aun-chat');
      expect(items![0].desc).toBe('刚刚');
    });

    it('returns cli option even when no sessions', async () => {
      const { handler } = createHandler();
      const items = await handler.getSubMenuItems('/s', 'aun', 'chat1');
      expect(items).toHaveLength(1);
      expect(items![0].value).toBe('cli');
    });

    it('includes all sessions (including active) plus cli option for /s', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-active' }),
        listSessions: vi.fn().mockResolvedValue([
          { id: 'sess-active', name: 'current' },
          { id: 'sess-other', name: 'other' },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/s', 'aun', 'chat1');
      expect(items).toHaveLength(3);
      expect(items![0].value).toBe('current');
      expect(items![1].value).toBe('other');
      expect(items![2].value).toBe('cli');
    });
  });

  describe('/del — session delete list', () => {
    it('excludes active session', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-active' }),
        listSessions: vi.fn().mockResolvedValue([
          { id: 'sess-active', name: 'current' },
          { id: 'sess-other', name: 'other' },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/del', 'aun', 'chat1');
      expect(items).toHaveLength(1);
      expect(items![0].value).toBe('other');
    });

    it('returns empty when only active session exists', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-1' }),
        listSessions: vi.fn().mockResolvedValue([
          { id: 'sess-1', name: 'only' },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/del', 'aun', 'chat1');
      expect(items).toEqual([]);
    });

    it('does not include cli option', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-active' }),
        listSessions: vi.fn().mockResolvedValue([
          { id: 'sess-active', name: 'current' },
          { id: 'sess-other', name: 'other', agentSessionId: '12345678-abcd', updatedAt: Date.now() },
        ]),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const items = await handler.getSubMenuItems('/del', 'aun', 'chat1');
      expect(items!.find(i => i.value === 'cli')).toBeUndefined();
    });
  });

  describe('/p — project list', () => {
    it('returns configured projects', async () => {
      const { handler } = createHandler();
      const items = await handler.getSubMenuItems('/p', 'aun', 'chat1');
      expect(items).toHaveLength(2);
      expect(items!.map(i => i.value)).toContain('myproj');
      expect(items!.map(i => i.value)).toContain('other');
    });

    it('returns empty when no projects configured', async () => {
      const config = createMockConfig({ projects: { defaultPath: '/tmp' } } as any);
      const { handler } = createHandler({ config });
      const items = await handler.getSubMenuItems('/p', 'aun', 'chat1');
      expect(items).toEqual([]);
    });
  });

  describe('/agent — agent list', () => {
    it('returns all registered agents', async () => {
      const agentMap = new Map([
        ['claude', createMockAgentRunner({ name: 'claude' })],
        ['hermes', createMockAgentRunner({ name: 'hermes' })],
        ['gemini', createMockAgentRunner({ name: 'gemini' })],
      ]);
      const { handler } = createHandler({ agentMap });
      const items = await handler.getSubMenuItems('/agent', 'aun', 'chat1');
      expect(items).toHaveLength(3);
      expect(items!.map(i => i.value)).toEqual(['claude', 'hermes', 'gemini']);
    });

    it('returns single agent when only one registered', async () => {
      const { handler } = createHandler();
      const items = await handler.getSubMenuItems('/agent', 'aun', 'chat1');
      expect(items).toHaveLength(1);
      expect(items![0].value).toBe('claude');
    });
  });

  describe('/model — model list', () => {
    it('returns models from agent.listModels', async () => {
      const agent = createMockAgentRunner({
        listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
      });
      const { handler } = createHandler({ agentRunner: agent });
      const items = await handler.getSubMenuItems('/model', 'aun', 'chat1');
      expect(items).toHaveLength(3);
      expect(items!.map(i => i.value)).toEqual(['sonnet', 'opus', 'haiku']);
    });

    it('returns null when agent has no listModels', async () => {
      const agent = createMockAgentRunner({ listModels: undefined });
      const { handler } = createHandler({ agentRunner: agent });
      const items = await handler.getSubMenuItems('/model', 'aun', 'chat1');
      expect(items).toBeNull();
    });

    it('returns null when listModels returns empty', async () => {
      const agent = createMockAgentRunner({
        listModels: vi.fn().mockReturnValue([]),
      });
      const { handler } = createHandler({ agentRunner: agent });
      const items = await handler.getSubMenuItems('/model', 'aun', 'chat1');
      expect(items).toBeNull();
    });
  });

  describe('unknown cmd', () => {
    it('returns null for unrecognized command', async () => {
      const { handler } = createHandler();
      const items = await handler.getSubMenuItems('/unknown', 'aun', 'chat1');
      expect(items).toBeNull();
    });

    it('returns null for empty cmd', async () => {
      const { handler } = createHandler();
      const items = await handler.getSubMenuItems('', 'aun', 'chat1');
      expect(items).toBeNull();
    });
  });
});

// =====================================================================
// Bare command usage hints (/name, /rename, /bind without args)
// =====================================================================

describe('bare command usage hints', () => {
  it('/name without args returns usage hint', async () => {
    const { handler } = createHandler();
    const result = await handler.handle('/name', 'aun', 'chat1');
    expect(result).toMatch(/用法/);
    expect(result).toMatch(/name/);
  });

  it('/rename without args returns usage hint', async () => {
    const { handler } = createHandler();
    const result = await handler.handle('/rename', 'aun', 'chat1');
    expect(result).toMatch(/用法/);
    expect(result).toMatch(/rename/);
  });

  it('/bind without args returns usage hint', async () => {
    const { handler } = createHandler();
    const result = await handler.handle('/bind', 'aun', 'chat1');
    expect(result).toMatch(/用法/);
    expect(result).toMatch(/bind/);
  });
});
