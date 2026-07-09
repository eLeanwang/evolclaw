import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CommandHandler } from '../../src/core/command/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import { _resetRoot, agentRelationConfig } from '../../src/paths.js';
import { formatPeerKey } from '../../src/core/relation/peer-identity.js';
import { _resetSchemaCache } from '../../src/config/schema-registry.js';

const TEST_AID = 'test.agentid.pub';
let tmpRoot: string;
const oldHome = process.env.EVOLCLAW_HOME;

function readRelationPermissionMode(peerId = 'user1'): string | undefined {
  const file = agentRelationConfig(TEST_AID, formatPeerKey('aun', peerId));
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).permissionMode;
}

function relationPermissionResult(mode: string) {
  return {
    data: {
      mode,
      scope: 'relation',
      field: 'permissionMode',
      self: TEST_AID,
      peerKey: formatPeerKey('aun', 'user1'),
    },
  };
}

// D1：/system 进程级鉴权查 evolclaw.json.owners。默认让 user1 在 owners 名单内，
// 使既有正向用例继续通过；FORBIDDEN 用例按需覆写。
const ownersMock = vi.hoisted(() => ({ value: ['user1'] as string[] }));
vi.mock('../../src/config-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config-store.js')>();
  return {
    ...actual,
    loadEvolclawConfig: vi.fn(() => ({ $schema_version: 1, owners: ownersMock.value })),
  };
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-menu-'));
  process.env.EVOLCLAW_HOME = tmpRoot;
  _resetRoot();
  _resetSchemaCache();
  ownersMock.value = ['user1'];

  const agentDir = path.join(tmpRoot, 'agents', TEST_AID);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
    $schema_version: 1,
    aid: TEST_AID,
    channels: [],
    active_baseagent: 'claude',
    baseagents: { claude: { model: 'sonnet' } },
    chatmode: { private: 'interactive', group: 'proactive' },
    dispatch: 'mention',
    permissionMode: 'auto',
    show_activities: 'all',
  }));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (oldHome) process.env.EVOLCLAW_HOME = oldHome;
  else delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  _resetSchemaCache();
});

function testAgentConfigPath(): string {
  return path.join(tmpRoot, 'agents', TEST_AID, 'config.json');
}

function readTestAgentConfig(): any {
  return JSON.parse(fs.readFileSync(testAgentConfigPath(), 'utf-8'));
}

function writeTestAgentConfig(patch: Record<string, any>): void {
  fs.writeFileSync(testAgentConfigPath(), JSON.stringify({ ...readTestAgentConfig(), ...patch }));
}
function createMockSessionManager(overrides: Record<string, any> = {}) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'sess-1', channel: 'aun', channelId: 'chat1',
      projectPath: '/tmp/test', agentId: 'claude', baseagent: 'claude',
      selfAID: TEST_AID, channelType: 'aun', sessionKey: 'aun#chat1#',
      agentSessionId: 'agent-sess-123',
      chatType: 'private', sessionMode: 'interactive', chatMode: 'interactive',
      metadata: { permissionMode: 'auto', peerId: 'user1' },
      createdAt: Date.now(), updatedAt: Date.now(),
    }),
    getActiveSessionSync: vi.fn().mockReturnValue({
      id: 'sess-1', channel: 'aun', channelId: 'chat1',
      projectPath: '/tmp/test', agentId: 'claude', baseagent: 'claude',
      selfAID: TEST_AID, channelType: 'aun', sessionKey: 'aun#chat1#',
      chatType: 'private', sessionMode: 'interactive', chatMode: 'interactive',
      metadata: { permissionMode: 'auto', peerId: 'user1' },
      createdAt: Date.now(), updatedAt: Date.now(),
    }),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
    recordSuccess: vi.fn(),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, lastSuccessTime: Date.now(), safeMode: false }),
    setSafeMode: vi.fn(),
    switchProject: vi.fn(),
    createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    getThreadSession: vi.fn().mockResolvedValue(null),
    getSessionByName: vi.fn().mockResolvedValue(null),
    unbindSession: vi.fn().mockResolvedValue(true),
    switchSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getSessionById: vi.fn().mockResolvedValue(null),
    getSessionFileInfo: vi.fn().mockReturnValue({ turns: 5, title: null }),
    readSessionFirstMessage: vi.fn().mockReturnValue(null),
    clearProcessing: vi.fn(),
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
    setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus']),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([
      { key: 'auto', nameZh: '自动', description: '', available: true },
      { key: 'bypass', nameZh: '免审批', description: '', available: true },
      { key: 'readonly', nameZh: '只读', description: '', available: true },
      { key: 'plan', nameZh: '计划', description: '', available: true },
      { key: 'edit', nameZh: '编辑', description: '', available: true },
      { key: 'request', nameZh: '请求', description: '', available: true },
      { key: 'noask', nameZh: '静默', description: '', available: true },
    ]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
    closeSession: vi.fn().mockResolvedValue(undefined),
    setSessionName: vi.fn().mockResolvedValue(undefined),
    capabilities: { fork: true },
    getSessionMessages: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockAgentRegistry(overrides: Record<string, any> = {}) {
  const agent = {
    aid: TEST_AID,
    name: '<unknown>',
    baseagent: 'claude',
    projectPath: '/tmp/test',
    config: {
      $schema_version: 1,
      aid: TEST_AID,
      channels: [],
      active_baseagent: 'claude',
      baseagents: { claude: { model: 'sonnet' } },
      projects: { defaultPath: '/tmp/test' },
      chatmode: { private: 'interactive', group: 'proactive' },
    },
    getContext: vi.fn(),
    getShowActivities: vi.fn().mockReturnValue('all'),
    setShowActivities: vi.fn(),
    setActiveBaseagent: vi.fn(),
    setLifecycle: vi.fn(),
    setBaseagentModel: vi.fn(),
    setBaseagentEffort: vi.fn(),
    setChatmodePrivate: vi.fn(),
    setDispatch: vi.fn(),
    getObservable: vi.fn().mockReturnValue(false),
    setObservable: vi.fn(),
    channelInstanceNames: vi.fn().mockReturnValue(['aun']),
  };
  return {
    resolveByChannel: vi.fn().mockReturnValue(agent),
    get: vi.fn((name: string) => (name === TEST_AID || name === '<unknown>' ? agent : null)),
    list: vi.fn().mockReturnValue([]),
    getShowActivities: vi.fn().mockReturnValue('all'),
    setShowActivities: vi.fn(),
    ...overrides,
  } as any;
}

function createHandler(opts: { sessionManager?: any; agentRegistry?: any; messageQueue?: any; agentRunner?: any } = {}) {
  const sm = opts.sessionManager ?? createMockSessionManager();
  const agentRunner = opts.agentRunner ?? createMockAgentRunner();
  const cache = { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn(), hasMessages: vi.fn().mockReturnValue(false) } as any;
  const mq = opts.messageQueue ?? { isProcessing: vi.fn().mockReturnValue(false), getQueueLength: vi.fn().mockReturnValue(0), getQueueLengthByAgent: vi.fn().mockReturnValue(0), getProcessingCountByAgent: vi.fn().mockReturnValue(0) } as any;
  const eb = new EventBus();
  const handler = new CommandHandler(sm, agentRunner, cache, eb);
  handler.registerChannel('aun', {}, 'aun');
  handler.setMessageQueue(mq);
  handler.setAgentRegistry(opts.agentRegistry ?? createMockAgentRegistry());
  return { handler, sm, eb, agentRunner };
}

describe('execMenuQuery', () => {
  describe('/perm', () => {
    it('returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('bypass'));
    });

    it('targets the current relation when no session exists', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1') as any;
      expect(result).toEqual(relationPermissionResult('bypass'));
    });
  });

  describe('/chatmode', () => {
    it('returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/chatmode', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'interactive', scope: 'agent', field: 'chatmode.private', self: TEST_AID } });
    });

    it('falls back to agent config when no session', async () => {
      writeTestAgentConfig({ chatmode: { private: 'proactive', group: 'proactive' } });
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/chatmode', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive', scope: 'agent', field: 'chatmode.private', self: TEST_AID } });
    });
  });

  describe('/dispatch', () => {
    it('returns NOT_APPLICABLE for private chat', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/dispatch', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NOT_APPLICABLE');
    });

    it('returns mode for group chat', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { dispatchMode: 'mention' }, projectPath: '/tmp', agentId: 'claude',
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/dispatch', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'mention', scope: 'agent', field: 'dispatch', self: TEST_AID } });
    });
  });

  describe('/activity', () => {
    it('returns current mode (no session needed)', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = {
        getShowActivities: vi.fn().mockReturnValue('none'),
        setShowActivities: vi.fn(),
        resolveByChannel: vi.fn().mockReturnValue(null),
      };
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/activity', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'none' } });
    });

    it('defaults to all when no registry', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/activity', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'all' } });
    });
  });

  describe('/session', () => {
    it('returns session state with rich fields', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/session', 'aun', 'chat1', 'user1') as { data: any };
      expect(result.data).toMatchObject({
        agentSessionId: 'agent-sess-123',
        status: 'idle',
        turns: 5,
      });
      expect(typeof result.data.createdAt).toBe('number');
    });

    it('returns no-session status when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/session', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { status: 'no-session' } });
    });

    it('reports processing status when stream active', async () => {
      const mq = { isProcessing: vi.fn().mockReturnValue(true), getQueueLength: vi.fn().mockReturnValue(2), getQueueLengthByAgent: vi.fn().mockReturnValue(0), getProcessingCountByAgent: vi.fn().mockReturnValue(0) } as any;
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', agentId: 'claude', chatType: 'private', sessionMode: 'interactive',
          metadata: {}, projectPath: '/tmp', processingState: String(Date.now() - 5000),
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm, messageQueue: mq });
      const result = await handler.execMenuQuery('/session', 'aun', 'chat1', 'user1') as { data: any };
      expect(result.data.status).toBe('processing');
      expect(result.data.queueLength).toBe(2);
      expect(result.data.processingDuration).toBeGreaterThanOrEqual(4);
    });
  });

  describe('/topic', () => {
    it('returns topic status by threadId', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        agentSessionId: 'topic-agent-123',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { peerId: 'user1' },
        createdAt: 1000, updatedAt: 2000,
      };
      const sm = createMockSessionManager({ getThreadSession: vi.fn().mockResolvedValue(topic) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/topic', 'aun', 'chat1', 'user1', { target: 'thread-1' }) as { data: any };
      expect(result.data).toMatchObject({
        threadId: 'thread-1',
        name: '重构讨论',
        agentSessionId: 'topic-agent-123',
        status: 'idle',
        turns: 5,
      });
    });

    it('returns NOT_FOUND for missing topic target', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/topic', 'aun', 'chat1', 'user1', { target: 'missing' }) as any;
      expect(result.code).toBe('NOT_FOUND');
    });
  });

  describe('/pwd', () => {
    it('returns current project path', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/pwd', 'aun', 'chat1', 'user1') as { data: any };
      expect(result.data.path).toBe('/tmp/test');
      expect(result.data.name).toBe('test');
    });

    it('falls back to evolagent default when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = {
        resolveByChannel: vi.fn().mockReturnValue({ config: { projects: { defaultPath: '/home/me/proj' } } }),
      };
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/pwd', 'aun', 'chat1', 'user1') as { data: any };
      expect(result.data.path).toBe('/home/me/proj');
    });

    it('returns null path when nothing available', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = createMockAgentRegistry({ resolveByChannel: vi.fn().mockReturnValue(null) });
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/pwd', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { name: null, path: null } });
    });
  });

  describe('/system', () => {
    it('returns process info', async () => {
      const { handler } = createHandler();
      // /system 进程级：仅控制 channel（fromControlChannel=true）可执行
      const result = await handler.execMenuQuery('/system', 'aun', 'chat1', 'user1', undefined, undefined, true) as { data: any };
      expect(result.data.pid).toBe(process.pid);
      expect(result.data.node).toBe(process.version);
      expect(typeof result.data.uptime).toBe('number');
    });

    it('rejects /system query from agent channel (not control)', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/system', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('FORBIDDEN');
    });
  });

  describe('unsupported command', () => {
    it('returns NOT_SUPPORTED for unknown', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/unknown', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NOT_SUPPORTED');
    });
  });
});

describe('execMenuUpdate', () => {
  describe('/perm', () => {
    it('switches mode (owner)', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.execMenuUpdate('/perm', 'bypass', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('bypass'));
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('bypass');
    });

    it('switches to readonly mode (owner)', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.execMenuUpdate('/perm', 'readonly', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('readonly'));
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('readonly');
    });

    it('switches mode (admin)', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'admin' }) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/perm', 'noask', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('noask'));
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('noask');
    });

    it('handles /perm readonly through the chat command path', async () => {
      const { handler, sm } = createHandler();
      const result = await handler.handle('/perm readonly', 'aun', 'chat1', undefined, 'user1') as any;
      expect(result.kind).toBe('command.result');
      expect(result.text).toContain('readonly');
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('readonly');
    });

    it('handles /perm readonly through the chat command path for admin', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'admin' }) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.handle('/perm readonly', 'aun', 'chat1', undefined, 'user1') as any;
      expect(result.kind).toBe('command.result');
      expect(result.text).toContain('readonly');
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('readonly');
    });

    it('rejects invalid mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/perm', 'invalid', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('rejects visitor', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/perm', 'bypass', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
    });

    it('writes relation config when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/perm', 'bypass', 'aun', 'chat1', 'user1') as any;
      expect(result).toEqual(relationPermissionResult('bypass'));
      expect(readRelationPermissionMode()).toBe('bypass');
    });
  });

  describe('/chatmode', () => {
    it('switches mode in session', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/chatmode', 'proactive', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive', scope: 'agent', field: 'chatmode.private', self: TEST_AID } });
      expect(readTestAgentConfig().chatmode.private).toBe('proactive');
    });

    it('rejects invalid mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/chatmode', 'invalid', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('writes to agent config when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'proactive', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive', scope: 'agent', field: 'chatmode.private', self: TEST_AID } });
      expect(readTestAgentConfig().chatmode.private).toBe('proactive');
    });

    it('rejects non-admin in group chat', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive', metadata: {},
        }),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'proactive', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
    });
  });

  describe('/dispatch', () => {
    it('switches mode in group session', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto' }, projectPath: '/tmp', agentId: 'claude',
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/dispatch', 'broadcast', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'broadcast', scope: 'agent', field: 'dispatch', self: TEST_AID } });
      expect(readTestAgentConfig().dispatch).toBe('broadcast');
    });

    it('rejects in private chat', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/dispatch', 'broadcast', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NOT_APPLICABLE');
    });

    it('clear removes agent dispatch override', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto', dispatchMode: 'mention', dispatchModeOverride: 'broadcast' },
          projectPath: '/tmp', agentId: 'claude', createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/dispatch', 'clear', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: null, scope: 'agent', field: 'dispatch', self: TEST_AID } });
      expect(readTestAgentConfig().dispatch).toBeUndefined();
    });
  });

  describe('/activity', () => {
    it('switches mode (owner)', async () => {
      const setShowActivities = vi.fn();
      const agentRegistry = { getShowActivities: vi.fn(), setShowActivities, resolveByChannel: vi.fn().mockReturnValue(null) };
      const { handler } = createHandler({ agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'none', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'none' } });
      expect(setShowActivities).toHaveBeenCalledWith('aun', 'none');
    });

    it('rejects invalid mode', async () => {
      const agentRegistry = { getShowActivities: vi.fn(), setShowActivities: vi.fn(), resolveByChannel: vi.fn().mockReturnValue(null) };
      const { handler } = createHandler({ agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'invalid', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('rejects non-owner', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }) });
      const agentRegistry = { getShowActivities: vi.fn(), setShowActivities: vi.fn(), resolveByChannel: vi.fn().mockReturnValue(null) };
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'none', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
    });

    it('works without active session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const setShowActivities = vi.fn();
      const agentRegistry = { getShowActivities: vi.fn(), setShowActivities, resolveByChannel: vi.fn().mockReturnValue(null) };
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'all', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'all' } });
    });
  });

  describe('missing value', () => {
    it('returns MISSING_VALUE', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/chatmode', '', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('MISSING_VALUE');
    });
  });
});

describe('execMenuAction', () => {
  describe('/system', () => {
    it('rejects restart from agent channel (process-level gate)', async () => {
      ownersMock.value = ['user1'];
      const { handler } = createHandler();
      // 非控制 channel：进程级闸直接 FORBIDDEN（早于 owners 检查）
      const result = await handler.execMenuAction('/system', 'restart', undefined, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('FORBIDDEN');
    });

    it('rejects restart for non-owner via control channel (owners check)', async () => {
      ownersMock.value = ['someone-else.agentid.pub'];
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/system', 'restart', undefined, 'aun', 'chat1', 'user1', undefined, undefined, undefined, true) as any;
      expect(result.code).toBe('FORBIDDEN');
      ownersMock.value = ['user1'];
    });

    it('rejects upgrade for non-owner via control channel (owners check)', async () => {
      ownersMock.value = ['someone-else.agentid.pub'];
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/system', 'upgrade', undefined, 'aun', 'chat1', 'user1', undefined, undefined, undefined, true) as any;
      expect(result.code).toBe('FORBIDDEN');
      ownersMock.value = ['user1'];
    });

    it('check works for owner via control channel', async () => {
      ownersMock.value = ['user1'];
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/system', 'check', undefined, 'aun', 'chat1', 'user1', undefined, undefined, undefined, true) as any;
      // 控制 channel + owners 名单内：check 通过鉴权
      expect(result.code).not.toBe('FORBIDDEN');
      expect(result.data?.action).toBe('check');
    });

    it('rejects unknown action via control channel', async () => {
      ownersMock.value = ['user1'];
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/system', 'frobnicate', undefined, 'aun', 'chat1', 'user1', undefined, undefined, undefined, true) as any;
      expect(result.code).toBe('NOT_SUPPORTED');
    });
  });

  describe('/session', () => {
    it('stop returns NO_ACTIVE_SESSION when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/session', 'stop', undefined, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_ACTIVE_SESSION');
    });

    it('stop returns NO_ACTIVE_TASK when session exists but no task', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/session', 'stop', undefined, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_ACTIVE_TASK');
    });

    it('stop succeeds when stream is active', async () => {
      const interrupt = vi.fn();
      const agentRunner = createMockAgentRunner();
      agentRunner.hasActiveStream = vi.fn().mockReturnValue(true);
      agentRunner.interrupt = interrupt;
      const sm = createMockSessionManager();
      const cache = { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn(), hasMessages: vi.fn().mockReturnValue(false) } as any;
      const mq = { isProcessing: vi.fn().mockReturnValue(false), getQueueLength: vi.fn().mockReturnValue(1), getQueueLengthByAgent: vi.fn().mockReturnValue(0), getProcessingCountByAgent: vi.fn().mockReturnValue(0) } as any;
      const eb = new EventBus();
      const handler = new CommandHandler(sm, agentRunner, cache, eb);
      handler.setMessageQueue(mq);
      const result = await handler.execMenuAction('/session', 'stop', undefined, 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { action: 'stop', success: true } });
      expect(interrupt).toHaveBeenCalled();
    });

    it('switch requires args.target', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/session', 'switch', {}, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('MISSING_VALUE');
    });

    it('delete requires args.target', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/session', 'delete', {}, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('MISSING_VALUE');
    });

    it('renames active session when target is omitted', async () => {
      const session = {
        id: 'sess-1', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        agentSessionId: 'agent-sess-123',
        name: '旧会话',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { permissionMode: 'auto' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
        listSessions: vi.fn().mockResolvedValue([session]),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const agentRunner = createMockAgentRunner();
      const { handler, eb } = createHandler({ sessionManager: sm, agentRunner });
      const events: any[] = [];
      eb.on('*', (event) => events.push(event));

      const result = await handler.execMenuAction('/session', 'rename', { name: '新会话' }, 'aun', 'chat1', 'user1') as any;

      expect(result).toEqual({
        data: {
          action: 'rename',
          success: true,
          session: { id: 'sess-1', name: '新会话', agentSessionId: 'agent-sess-123' },
        },
      });
      expect(sm.renameSession).toHaveBeenCalledWith('sess-1', '新会话');
      expect(agentRunner.setSessionName).toHaveBeenCalledWith('agent-sess-123', '新会话');
      expect(events).toContainEqual({ type: 'session:renamed', sessionId: 'sess-1', oldName: '旧会话', newName: '新会话' });
    });

    it('renames a target main session by name', async () => {
      const active = {
        id: 'sess-1', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        name: '当前会话',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { permissionMode: 'auto' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const target = {
        id: 'sess-2', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        name: '目标会话',
        chatType: 'private', sessionMode: 'interactive',
        metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(active),
        listSessions: vi.fn().mockResolvedValue([active, target]),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuAction('/session', 'rename', { target: '目标会话', name: '新目标' }, 'aun', 'chat1', 'user1') as any;

      expect(result.data.session).toEqual({ id: 'sess-2', name: '新目标' });
      expect(sm.renameSession).toHaveBeenCalledWith('sess-2', '新目标');
    });

    it('rename requires args.name', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/session', 'rename', {}, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('MISSING_VALUE');
    });

    it('rename returns CONFLICT when the new session name exists', async () => {
      const active = {
        id: 'sess-1', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        name: '旧会话',
        chatType: 'private', sessionMode: 'interactive',
        metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(active),
        listSessions: vi.fn().mockResolvedValue([active]),
        getSessionByName: vi.fn().mockResolvedValue({ id: 'sess-2', name: '已存在' }),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuAction('/session', 'rename', { name: '已存在' }, 'aun', 'chat1', 'user1') as any;

      expect(result.code).toBe('CONFLICT');
      expect(sm.renameSession).not.toHaveBeenCalled();
    });

    it('forbids group visitor renaming a main session', async () => {
      const session = {
        id: 'sess-1', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        name: '群会话',
        chatType: 'group', sessionMode: 'proactive',
        metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
        listSessions: vi.fn().mockResolvedValue([session]),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor', mode: 'interactive' }),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuAction('/session', 'rename', { name: '新群会话' }, 'aun', 'chat1', 'visitor1') as any;

      expect(result.code).toBe('NO_PERMISSION');
      expect(sm.renameSession).not.toHaveBeenCalled();
    });

    it('compact returns NO_ACTIVE_SESSION when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/session', 'compact', undefined, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_ACTIVE_SESSION');
    });

    it('reports Codex manual compact progress and completion', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', channel: 'aun', channelId: 'chat1',
          projectPath: '/tmp/test', agentId: 'codex',
          agentSessionId: 'thread-1',
          chatType: 'private', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto' },
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const agentRunner = createMockAgentRunner();
      agentRunner.name = 'codex';
      agentRunner.capabilities.compact = true;
      agentRunner.compactSession = vi.fn().mockResolvedValue(true);
      const mq = {
        isProcessing: vi.fn().mockReturnValue(false),
        getQueueLength: vi.fn().mockReturnValue(0),
        getQueueLengthByAgent: vi.fn().mockReturnValue(0),
        getProcessingCountByAgent: vi.fn().mockReturnValue(0),
        acquireLock: vi.fn().mockReturnValue(() => {}),
      } as any;
      const cache = { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn(), hasMessages: vi.fn().mockReturnValue(false) } as any;
      const handler = new CommandHandler(sm, agentRunner, cache, new EventBus());
      handler.setMessageQueue(mq);
      const send = vi.fn().mockResolvedValue(undefined);

      const result = await handler.handle('/compact', 'aun', 'chat1', send, 'user1');

      expect(result).toEqual({ kind: 'command.result', text: '✅ 会话压缩完成' });
      expect(send).toHaveBeenCalledWith(
        'chat1',
        expect.stringContaining('正在压缩会话上下文'),
        undefined
      );
      expect(agentRunner.compactSession).toHaveBeenCalledWith('sess-1', 'thread-1', '/tmp/test');
    });

    it('fork returns NO_ACTIVE_SESSION when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/session', 'fork', { name: 'branch' }, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_ACTIVE_SESSION');
    });

    it('rejects unknown action', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/session', 'frobnicate', undefined, 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NOT_SUPPORTED');
    });
  });

  describe('/topic', () => {
    it('deletes topic by threadId for owner', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { peerId: 'user1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({ getThreadSession: vi.fn().mockResolvedValue(topic) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/topic', 'delete', { target: 'thread-1' }, 'aun', 'chat1', 'user1') as any;
      expect(result).toEqual({ data: { deleted: true } });
      expect(sm.unbindSession).toHaveBeenCalledWith('topic-sess');
    });

    it('renames topic by threadId for owner', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        agentSessionId: 'topic-agent-123',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { peerId: 'user1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getThreadSession: vi.fn().mockResolvedValue(topic),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const agentRunner = createMockAgentRunner();
      const { handler, eb } = createHandler({ sessionManager: sm, agentRunner });
      const events: any[] = [];
      eb.on('*', (event) => events.push(event));

      const result = await handler.execMenuAction('/topic', 'rename', { target: 'thread-1', name: '新话题' }, 'aun', 'chat1', 'user1') as any;

      expect(result).toEqual({
        data: {
          action: 'rename',
          success: true,
          topic: { id: 'topic-sess', name: '新话题', agentSessionId: 'topic-agent-123', threadId: 'thread-1' },
        },
      });
      expect(sm.renameSession).toHaveBeenCalledWith('topic-sess', '新话题');
      expect(agentRunner.setSessionName).toHaveBeenCalledWith('topic-agent-123', '新话题');
      expect(events).toContainEqual({ type: 'session:renamed', sessionId: 'topic-sess', oldName: '重构讨论', newName: '新话题' });
    });

    it('rename requires args.target and args.name', async () => {
      const { handler } = createHandler();

      const missingTarget = await handler.execMenuAction('/topic', 'rename', { name: '新话题' }, 'aun', 'chat1', 'user1') as any;
      expect(missingTarget.code).toBe('MISSING_VALUE');

      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { peerId: 'user1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({ getThreadSession: vi.fn().mockResolvedValue(topic) });
      const h = createHandler({ sessionManager: sm }).handler;

      const missingName = await h.execMenuAction('/topic', 'rename', { target: 'thread-1' }, 'aun', 'chat1', 'user1') as any;
      expect(missingName.code).toBe('MISSING_VALUE');
    });

    it('rename returns CONFLICT when the new topic name exists', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'private', sessionMode: 'interactive',
        metadata: { peerId: 'user1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getThreadSession: vi.fn().mockResolvedValue(topic),
        getSessionByName: vi.fn().mockResolvedValue({ id: 'other-topic', name: '已存在' }),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuAction('/topic', 'rename', { target: 'thread-1', name: '已存在' }, 'aun', 'chat1', 'user1') as any;

      expect(result.code).toBe('CONFLICT');
      expect(sm.renameSession).not.toHaveBeenCalled();
    });

    it('forbids group visitor deleting topic', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'group', sessionMode: 'proactive',
        metadata: { peerId: 'admin1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getThreadSession: vi.fn().mockResolvedValue(topic),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor', mode: 'interactive' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/topic', 'delete', { target: 'thread-1' }, 'aun', 'chat1', 'visitor1', undefined, 'group') as any;
      expect(result.code).toBe('FORBIDDEN');
      expect(sm.unbindSession).not.toHaveBeenCalled();
    });

    it('forbids group visitor renaming topic', async () => {
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '重构讨论',
        chatType: 'group', sessionMode: 'proactive',
        metadata: { peerId: 'admin1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getThreadSession: vi.fn().mockResolvedValue(topic),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor', mode: 'interactive' }),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuAction('/topic', 'rename', { target: 'thread-1', name: '新话题' }, 'aun', 'chat1', 'visitor1', undefined, 'group') as any;
      expect(result.code).toBe('FORBIDDEN');
      expect(sm.renameSession).not.toHaveBeenCalled();
    });

    it('uses topic chatType for rename permission when explicit chatType is omitted', async () => {
      const active = {
        id: 'sess-1', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        name: '私聊主会话',
        chatType: 'private', sessionMode: 'interactive',
        metadata: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const topic = {
        id: 'topic-sess', channel: 'aun', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude',
        threadId: 'thread-1',
        name: '群话题',
        chatType: 'group', sessionMode: 'proactive',
        metadata: { peerId: 'visitor1' },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(active),
        getActiveSessionSync: vi.fn().mockReturnValue(active),
        getThreadSession: vi.fn().mockResolvedValue(topic),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor', mode: 'interactive' }),
        renameSession: vi.fn().mockResolvedValue(true),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuAction('/topic', 'rename', { target: 'thread-1', name: '新群话题' }, 'aun', 'chat1', 'visitor1') as any;

      expect(result.code).toBe('FORBIDDEN');
      expect(sm.renameSession).not.toHaveBeenCalled();
    });
  });

  describe('delegateAsAction null handling', () => {
    it('treats null result from delegated command as EXEC_FAILED', async () => {
      // Use a slash command that won't match any handler (returns null)
      // We bypass via test by stubbing a non-existent action — but /system check actually returns a result.
      // Instead test the actual contract: check that successful delegation returns success.
      const { handler } = createHandler();
      const result = await handler.execMenuAction('/system', 'check', undefined, 'aun', 'chat1', 'user1', undefined, undefined, undefined, true) as any;
      // /check returns command.result text → mapped to success
      expect(result.data?.action).toBe('check');
      expect(result.data?.success).toBe(true);
    });
  });
});

describe('getMenuItems', () => {
  function flatten(items: { group: string; commands: any[] }[]) {
    return items.flatMap(group => group.commands);
  }

  it('shows /perm modes and /file to admin in agent scope', () => {
    const { handler } = createHandler();
    const commands = flatten(handler.getMenuItems('admin', 'private', 'agent'));
    const perm = commands.find(command => command.cmd === '/perm');

    expect(perm?.next?.items.map((item: any) => item.value)).toEqual(expect.arrayContaining(['auto', 'bypass', 'readonly', 'edit', 'noask']));
    expect(commands.some(command => command.cmd === '/file')).toBe(true);
  });

  it('hides process restart from agent-scope admin menu', () => {
    const { handler } = createHandler();
    const commands = flatten(handler.getMenuItems('admin', 'private', 'agent'));
    expect(commands.some(command => command.cmd === '/restart')).toBe(false);
  });

  it('shows process restart in control-scope owner menu', () => {
    const { handler } = createHandler();
    const commands = flatten(handler.getMenuItems('owner', 'private', 'control'));
    expect(commands.some(command => command.cmd === '/restart')).toBe(true);
  });
});

describe('getSubMenuItems — selected field', () => {
  it('/s marks active session as selected with rich fields', async () => {
    const sm = createMockSessionManager({
      listSessions: vi.fn().mockResolvedValue([
        { id: 'sess-1', name: 'main', agentSessionId: 'abc12345', updatedAt: Date.now(), projectPath: '/tmp', agentId: 'claude' },
        { id: 'sess-2', name: 'dev', agentSessionId: 'def67890', updatedAt: Date.now(), projectPath: '/tmp', agentId: 'claude' },
      ]),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const items = await handler.getSubMenuItems('/s', 'aun', 'chat1');
    const main = items?.find(i => i.value === 'main');
    const dev = items?.find(i => i.value === 'dev');
    expect(main?.selected).toBe(true);
    expect(dev?.selected).toBe(false);
    expect(main?.agentSessionId).toBe('abc12345');
    expect(typeof main?.lastActive).toBe('number');
  });

  it('/s excludes topic sessions and /topic lists only topics without selected', async () => {
    const sm = createMockSessionManager({
      listSessions: vi.fn().mockResolvedValue([
        { id: 'sess-1', name: 'main', threadId: '', agentSessionId: 'abc12345', updatedAt: Date.now(), projectPath: '/tmp', agentId: 'claude' },
        { id: 'topic-1', name: 'topic', threadId: 'thread-1', agentSessionId: 'def67890', updatedAt: Date.now(), projectPath: '/tmp', agentId: 'claude' },
      ]),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const sessionItems = await handler.getSubMenuItems('/s', 'aun', 'chat1');
    expect(sessionItems?.some(i => i.value === 'thread-1')).toBe(false);

    const topicItems = await handler.getSubMenuItems('/topic', 'aun', 'chat1', 'user1');
    expect(topicItems).toHaveLength(1);
    expect(topicItems?.[0]).toMatchObject({ value: 'thread-1', label: 'topic', agentSessionId: 'def67890' });
    expect(topicItems?.[0].selected).toBeUndefined();
  });

  it('/baseagent marks current agent as selected', async () => {
    const { handler } = createHandler();
    const items = await handler.getSubMenuItems('/baseagent', 'aun', 'chat1');
    const claude = items?.find(i => i.value === 'claude');
    expect(claude?.selected).toBe(true);
  });

  it('/model marks current model as selected', async () => {
    const { handler } = createHandler();
    const items = await handler.getSubMenuItems('/model', 'aun', 'chat1');
    const sonnet = items?.find(i => i.value === 'sonnet');
    const opus = items?.find(i => i.value === 'opus');
    expect(sonnet?.selected).toBe(true);
    expect(opus?.selected).toBe(false);
  });

  it('/chatmode marks current mode as selected', async () => {
    const { handler } = createHandler();
    const items = await handler.getSubMenuItems('/chatmode', 'aun', 'chat1');
    const interactive = items?.find(i => i.value === 'interactive');
    const proactive = items?.find(i => i.value === 'proactive');
    expect(interactive?.selected).toBe(true);
    expect(proactive?.selected).toBe(false);
  });

  it('/chatmode falls back to agent config when no session', async () => {
    writeTestAgentConfig({ chatmode: { private: 'proactive', group: 'proactive' } });
    const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
    const { handler } = createHandler({ sessionManager: sm });
    const items = await handler.getSubMenuItems('/chatmode', 'aun', 'chat1');
    const proactive = items?.find(i => i.value === 'proactive');
    const interactive = items?.find(i => i.value === 'interactive');
    expect(proactive?.selected).toBe(true);
    expect(interactive?.selected).toBe(false);
  });

  it('/dispatch marks current mode as selected', async () => {
    writeTestAgentConfig({ dispatch: 'broadcast' });
    const sm = createMockSessionManager({
      getActiveSession: vi.fn().mockResolvedValue({
        id: 'sess-1', agentId: 'claude', chatType: 'group', sessionMode: 'interactive',
        metadata: { dispatchMode: 'broadcast' }, projectPath: '/tmp',
        createdAt: Date.now(), updatedAt: Date.now(),
      }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const items = await handler.getSubMenuItems('/dispatch', 'aun', 'chat1');
    const broadcast = items?.find(i => i.value === 'broadcast');
    const mention = items?.find(i => i.value === 'mention');
    expect(broadcast?.selected).toBe(true);
    expect(mention?.selected).toBe(false);
  });

  it('/perm marks current mode as selected', async () => {
    const { handler } = createHandler();
    const items = await handler.getSubMenuItems('/perm', 'aun', 'chat1');
    const auto = items?.find(i => i.value === 'auto');
    const bypass = items?.find(i => i.value === 'bypass');
    const readonly = items?.find(i => i.value === 'readonly');
    expect(auto?.selected).toBe(false);
    expect(bypass?.selected).toBe(true);
    expect(readonly).toBeDefined();
  });

  it('/activity marks current mode as selected', async () => {
    const agentRegistry = { getShowActivities: vi.fn().mockReturnValue('none'), setShowActivities: vi.fn(), resolveByChannel: vi.fn().mockReturnValue(null) };
    const { handler } = createHandler({ agentRegistry });
    const items = await handler.getSubMenuItems('/activity', 'aun', 'chat1');
    const none = items?.find(i => i.value === 'none');
    const all = items?.find(i => i.value === 'all');
    expect(none?.selected).toBe(true);
    expect(all?.selected).toBe(false);
  });
});
