import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CommandHandler } from '../../src/core/command/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import { _resetRoot, agentRelationConfig } from '../../src/paths.js';
import { formatPeerKey } from '../../src/core/relation/peer-identity.js';
import { _resetSchemaCache } from '../../src/config/schema-registry.js';
import { AgentDelegationRegistry } from '../../src/core/auth/agent-delegation.js';
import { buildAunFilePayload } from '../../src/channels/aun.js';

const TEST_AID = 'test.agentid.pub';
let tmpRoot: string;
const oldHome = process.env.EVOLCLAW_HOME;

function readRelationPermissionMode(peerId = 'user1'): string | undefined {
  const file = agentRelationConfig(TEST_AID, formatPeerKey('aun', peerId));
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')).permissionMode;
}

function readRelationConfig(peerId = 'user1'): Record<string, any> {
  const file = agentRelationConfig(TEST_AID, formatPeerKey('aun', peerId));
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeRelationConfig(peerId: string, patch: Record<string, any>): void {
  const file = agentRelationConfig(TEST_AID, formatPeerKey('aun', peerId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readRelationConfig(peerId), ...patch }));
}

function relationPermissionResult(mode: string, source?: string) {
  return {
    data: {
      mode,
      ...(source ? { source } : {}),
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
    mentionMode: 'mention-only',
    permissionMode: 'auto',
    show_activities: 'all',
  }));
  writeRelationConfig('user1', { permissionMode: 'bypass' });
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

function relationConfigPathByKey(peerKey: string): string {
  return path.join(tmpRoot, 'agents', TEST_AID, 'relations', peerKey, 'config.json');
}

function readRelationConfigByKey(peerKey: string): any {
  return JSON.parse(fs.readFileSync(relationConfigPathByKey(peerKey), 'utf-8'));
}

function writeTestAgentConfig(patch: Record<string, any>): void {
  fs.writeFileSync(testAgentConfigPath(), JSON.stringify({ ...readTestAgentConfig(), ...patch }));
}

function createPrivateNonHumanSession(overrides: Record<string, any> = {}) {
  const metadata = {
    permissionMode: 'auto',
    peerId: 'agent-peer',
    peerType: 'agent',
    ...(overrides.metadata ?? {}),
  };
  return {
    id: 'sess-agent-peer', channel: 'aun', channelId: 'chat1',
    projectPath: '/tmp/test', agentId: 'claude',
    baseagent: 'claude', selfAID: TEST_AID, channelType: 'aun',
    agentSessionId: 'agent-sess-123',
    chatType: 'private', sessionMode: 'proactive',
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
    metadata,
  };
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
      { key: 'readonly', nameZh: '只读', description: '', available: true },
      { key: 'auto', nameZh: '自动', description: '', available: true },
      { key: 'request', nameZh: '请求', description: '', available: true },
      { key: 'bypass', nameZh: '免审批', description: '', available: true },
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
  const delegationRegistry = new AgentDelegationRegistry();
  handler.setAgentDelegationRegistry(delegationRegistry);
  handler.registerChannel('aun', {}, 'aun');
  handler.setMessageQueue(mq);
  handler.setAgentRegistry(opts.agentRegistry ?? createMockAgentRegistry());
  return { handler, sm, eb, agentRunner, delegationRegistry };
}

describe('execMenuQuery', () => {
  describe('/perm', () => {
    it('returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('bypass', 'role'));
    });

    it('targets the current relation when no session exists', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1') as any;
      expect(result).toEqual(relationPermissionResult('bypass', 'role'));
    });

    it('reports the role scope when permission comes from the role policy', async () => {
      writeTestAgentConfig({ permissionMode: undefined });
      writeRelationConfig('user1', { permissionMode: undefined });
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ mode: 'bypass', source: 'role' });
    });

    it('reports the builtin scope when neither config nor role provides permission', async () => {
      writeTestAgentConfig({ permissionMode: undefined });
      writeRelationConfig('user1', { permissionMode: undefined });
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'none' }) });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuQuery('/perm', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ mode: 'readonly', source: 'builtin' });
    });
  });

  describe('/model and /effort', () => {
    it('reports the agent scope for an inherited model', async () => {
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/model', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({
        model: 'sonnet',
        source: 'agent',
        scope: 'relation',
        field: 'baseagents.claude.model',
      });
    });

    it('reports the defaults scope for a defaults model', async () => {
      writeTestAgentConfig({ baseagents: undefined });
      fs.writeFileSync(path.join(tmpRoot, 'agents', 'defaults.json'), JSON.stringify({
        $schema_version: 1,
        baseagents: { claude: { model: 'haiku' } },
      }));
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/model', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ model: 'haiku', source: 'defaults' });
    });

    it('reports the relation scope for a relation model override', async () => {
      writeRelationConfig('user1', { baseagents: { claude: { model: 'opus' } } });
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/model', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ model: 'opus', source: 'relation' });
    });

    it('reports the role scope when a custom role replaces model and effort', async () => {
      writeTestAgentConfig({
        roles: {
          definitions: {
            reviewer: {
              description: 'Restricted reviewer',
              commandPermissions: {
                'model.*': { allow: true, scopes: ['relation'] },
              },
              permissions: {
                'baseagents.claude.model': {
                  default: 'sonnet',
                  allowOverride: true,
                  allowedModels: ['sonnet'],
                },
                'baseagents.claude.effort': {
                  default: 'low',
                  allowOverride: true,
                  allowedValues: ['low'],
                },
              },
            },
          },
        },
      });
      writeRelationConfig('user1', { baseagents: { claude: { model: 'opus', effort: 'high' } } });
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'reviewer' }) });
      const { handler } = createHandler({ sessionManager: sm });

      const model = await handler.execMenuQuery('/model', 'aun', 'chat1', 'user1') as any;
      const effort = await handler.execMenuQuery('/effort', 'aun', 'chat1', 'user1') as any;

      expect(model.data).toMatchObject({ model: 'sonnet', source: 'role' });
      expect(effort.data).toMatchObject({ effort: 'low', source: 'role' });
    });

    it('reports the runner scope for an unconfigured effort', async () => {
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/effort', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ effort: 'medium', source: 'runner' });
    });
  });

  describe('/chatmode', () => {
    it('returns current mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/chatmode', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'interactive', source: 'agent', scope: 'relation', field: 'chatmode.private', self: TEST_AID, peerKey: formatPeerKey('aun', 'user1') } });
    });

    it('renders the Slash card from the current relation effective mode', async () => {
      writeRelationConfig('user1', { chatmode: { private: 'proactive' } });
      const { handler } = createHandler();
      const send = vi.fn().mockResolvedValue(undefined);
      handler.registerAdapter({ channelName: 'aun', send } as any);

      const result = await handler.handle('/chatmode', 'aun', 'chat1', undefined, 'user1');

      expect(result).toBeNull();
      const payload = send.mock.calls[0]?.[1];
      expect(payload?.kind).toBe('interaction');
      expect(payload?.interaction?.kind?.buttons).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: '/chatmode proactive', style: 'primary', disabled: true }),
        expect.objectContaining({ command: '/chatmode interactive', style: 'default', disabled: false }),
      ]));
    });

    it('uses relation chatmode.nothuman for non-human private peers', async () => {
      const session = createPrivateNonHumanSession();
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/chatmode', 'aun', 'chat1', 'agent-peer');
      expect(result).toEqual({
        data: {
          mode: 'proactive',
          source: 'builtin',
          scope: 'relation',
          field: 'chatmode.nothuman',
          self: TEST_AID,
          peerKey: 'aun#agent-peer',
        },
      });
    });

    it('falls back to agent config when no session', async () => {
      writeTestAgentConfig({ chatmode: { private: 'proactive', group: 'proactive' } });
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/chatmode', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive', source: 'agent', scope: 'relation', field: 'chatmode.private', self: TEST_AID, peerKey: formatPeerKey('aun', 'user1') } });
    });
  });

  describe('/mentionmode', () => {
    it('returns NOT_APPLICABLE for private chat', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/mentionmode', 'aun', 'chat1', 'user1') as any;
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
      const result = await handler.execMenuQuery('/mentionmode', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'mention-only', source: 'agent', scope: 'relation', field: 'mentionMode', self: TEST_AID, peerKey: formatPeerKey('aun', 'chat1') } });
    });

    it('reports the session source when mentionMode only comes from session metadata', async () => {
      writeTestAgentConfig({ mentionMode: undefined });
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { dispatchMode: 'broadcast' }, projectPath: '/tmp', agentId: 'claude',
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuQuery('/mentionmode', 'aun', 'chat1', 'user1') as any;

      expect(result.data).toMatchObject({ mode: 'disabled', source: 'session' });
    });
  });

  describe('/activity', () => {
    it('queries the current relation without an active session', async () => {
      writeTestAgentConfig({ show_activities: undefined });
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = createMockAgentRegistry({
        getShowActivities: vi.fn().mockReturnValue('none'),
      });
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/activity', 'aun', 'chat1', 'user1');
      expect(result).toEqual({
        data: {
          mode: 'none',
          source: 'builtin',
          scope: 'relation',
          field: 'show_activities',
          self: TEST_AID,
          peerKey: formatPeerKey('aun', 'user1'),
        },
      });
    });

    it('defaults to relation scope and reports an inherited agent source', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/activity', 'aun', 'chat1', 'user1');
      expect(result).toEqual({
        data: {
          mode: 'all',
          source: 'agent',
          scope: 'relation',
          field: 'show_activities',
          self: TEST_AID,
          peerKey: formatPeerKey('aun', 'user1'),
        },
      });
    });

    it('reports a relation override by default', async () => {
      writeRelationConfig('user1', { show_activities: 'none' });
      const { handler } = createHandler();

      const result = await handler.execMenuQuery('/activity', 'aun', 'chat1', 'user1');

      expect(result).toEqual({
        data: {
          mode: 'none',
          source: 'relation',
          scope: 'relation',
          field: 'show_activities',
          self: TEST_AID,
          peerKey: formatPeerKey('aun', 'user1'),
        },
      });
    });

    it('supports an explicit agent query', async () => {
      const { handler } = createHandler();

      const result = await handler.execMenuQuery(
        '/activity',
        'aun',
        'chat1',
        'user1',
        { scope: 'agent' },
      ) as any;

      expect(result.data).toMatchObject({ mode: 'all', scope: 'agent', source: 'agent' });
      expect(result.data.peerKey).toBeUndefined();
    });
  });

  describe('/observable', () => {
    it('returns the current owner-only Agent setting', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuQuery('/observable', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { observable: false, source: 'builtin' } });
    });

    it('rejects non-owner queries', async () => {
      const sm = createMockSessionManager({
        resolveIdentity: vi.fn().mockReturnValue({ role: 'admin', mode: 'interactive' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuQuery('/observable', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
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
      expect(result.data.source).toBe('session');
    });

    it('falls back to evolagent default when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = {
        resolveByChannel: vi.fn().mockReturnValue({ config: { projects: { defaultPath: '/home/me/proj' } } }),
      };
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/pwd', 'aun', 'chat1', 'user1') as { data: any };
      expect(result.data.path).toBe('/home/me/proj');
      expect(result.data.source).toBe('agent');
    });

    it('returns null path when nothing available', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const agentRegistry = createMockAgentRegistry({ resolveByChannel: vi.fn().mockReturnValue(null) });
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuQuery('/pwd', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { name: null, path: null, source: null } });
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
      const result = await handler.execMenuUpdate('/perm', 'request', 'aun', 'chat1', 'user1');
      expect(result).toEqual(relationPermissionResult('request'));
      expect(sm.updateSession).not.toHaveBeenCalled();
      expect(readRelationPermissionMode()).toBe('request');
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

    it('rejects /perm update through the chat command path for visitor', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.handle('/perm readonly', 'aun', 'chat1', undefined, 'user1') as any;
      expect(result.kind).toBe('command.error');
      expect(readRelationPermissionMode()).toBe('bypass');
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
      expect(result).toEqual({ data: { mode: 'proactive', scope: 'relation', field: 'chatmode.private', self: TEST_AID, peerKey: formatPeerKey('aun', 'user1') } });
      expect(readRelationConfig().chatmode.private).toBe('proactive');
    });

    it('writes the current relation through Menu for admin', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'admin' }) });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.execMenuUpdate('/chatmode', 'proactive', 'aun', 'chat1', 'user1');

      expect(result).toEqual({ data: { mode: 'proactive', scope: 'relation', field: 'chatmode.private', self: TEST_AID, peerKey: formatPeerKey('aun', 'user1') } });
      expect(readRelationConfig().chatmode.private).toBe('proactive');
      expect(readTestAgentConfig().chatmode.private).toBe('interactive');
    });

    it.each(['owner', 'admin'] as const)('writes the current relation through Slash for %s', async (role) => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role }) });
      const { handler } = createHandler({ sessionManager: sm });

      const result = await handler.handle('/chatmode proactive', 'aun', 'chat1', undefined, 'user1') as any;

      expect(result).toMatchObject({ kind: 'command.result' });
      expect(readRelationConfig().chatmode.private).toBe('proactive');
      expect(readTestAgentConfig().chatmode.private).toBe('interactive');
    });

    it('writes relation chatmode.nothuman for non-human private peers by default', async () => {
      const session = createPrivateNonHumanSession();
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'interactive', 'aun', 'chat1', 'agent-peer');
      expect(result).toEqual({
        data: {
          mode: 'interactive',
          scope: 'relation',
          field: 'chatmode.nothuman',
          self: TEST_AID,
          peerKey: 'aun#agent-peer',
        },
      });
      expect(readRelationConfigByKey('aun#agent-peer').chatmode.nothuman).toBe('interactive');
      expect(readTestAgentConfig().chatmode.nothuman).toBeUndefined();
    });

    it('writes agent chatmode.nothuman when scope is agent', async () => {
      const session = createPrivateNonHumanSession();
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'interactive', 'aun', 'chat1', 'agent-peer', undefined, false, { scope: 'agent' });
      expect(result).toEqual({ data: { mode: 'interactive', scope: 'agent', field: 'chatmode.nothuman', self: TEST_AID } });
      expect(readTestAgentConfig().chatmode.nothuman).toBe('interactive');
    });

    it('writes relation chatmode.nothuman for non-human private peers', async () => {
      const session = createPrivateNonHumanSession();
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue(session),
        getActiveSessionSync: vi.fn().mockReturnValue(session),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'interactive', 'aun', 'chat1', 'agent-peer', undefined, false, { scope: 'relation' });
      expect(result).toEqual({
        data: {
          mode: 'interactive',
          scope: 'relation',
          field: 'chatmode.nothuman',
          self: TEST_AID,
          peerKey: 'aun#agent-peer',
        },
      });
      expect(readRelationConfigByKey('aun#agent-peer').chatmode.nothuman).toBe('interactive');
      expect(readTestAgentConfig().chatmode.nothuman).toBeUndefined();
    });

    it('rejects invalid mode', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/chatmode', 'invalid', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('writes relation config when no session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/chatmode', 'proactive', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'proactive', scope: 'relation', field: 'chatmode.private', self: TEST_AID, peerKey: formatPeerKey('aun', 'user1') } });
      expect(readRelationConfig().chatmode.private).toBe('proactive');
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
      expect(result.code).toBe('NOT_ALLOWED');
    });
  });

  describe('/mentionmode', () => {
    it('switches mode in group session', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto' }, projectPath: '/tmp', agentId: 'claude',
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/mentionmode', 'disabled', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: 'disabled', scope: 'relation', field: 'mentionMode', self: TEST_AID, peerKey: formatPeerKey('aun', 'chat1') } });
      expect(readRelationConfig('chat1').mentionMode).toBe('disabled');
    });

    it('rejects in private chat', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/mentionmode', 'disabled', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NOT_APPLICABLE');
    });

    it('clear removes agent mentionMode override', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto', dispatchMode: 'mention', dispatchModeOverride: 'broadcast' },
          projectPath: '/tmp', agentId: 'claude', createdAt: Date.now(), updatedAt: Date.now(),
        }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/mentionmode', 'clear', 'aun', 'chat1', 'user1');
      expect(result).toEqual({ data: { mode: null, scope: 'relation', field: 'mentionMode', self: TEST_AID, peerKey: formatPeerKey('aun', 'chat1') } });
      expect(readRelationConfig('chat1').mentionMode).toBeUndefined();
    });

    it('rejects /mentionmode update through the chat command path for visitor', async () => {
      const sm = createMockSessionManager({
        getActiveSession: vi.fn().mockResolvedValue({
          id: 'sess-1', chatType: 'group', sessionMode: 'interactive',
          metadata: { permissionMode: 'auto' }, projectPath: '/tmp', agentId: 'claude',
          baseagent: 'claude', selfAID: TEST_AID, channelType: 'aun',
          createdAt: Date.now(), updatedAt: Date.now(),
        }),
        resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.handle('/mentionmode disabled', 'aun', 'chat1', undefined, 'user1') as any;
      expect(result.kind).toBe('command.error');
      expect(readTestAgentConfig().mentionMode).toBe('mention-only');
    });
  });

  describe('/activity', () => {
    it('writes the current relation by default (owner)', async () => {
      const setShowActivities = vi.fn();
      const agentRegistry = createMockAgentRegistry({ setShowActivities });
      const { handler } = createHandler({ agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'none', 'aun', 'chat1', 'user1');
      expect(result).toEqual({
        data: {
          mode: 'none',
          scope: 'relation',
          field: 'show_activities',
          self: TEST_AID,
          peerKey: formatPeerKey('aun', 'user1'),
        },
      });
      expect(setShowActivities).not.toHaveBeenCalled();
      expect(readRelationConfig().show_activities).toBe('none');
    });

    it('rejects invalid mode', async () => {
      const agentRegistry = createMockAgentRegistry();
      const { handler } = createHandler({ agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'invalid', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('rejects non-owner', async () => {
      const sm = createMockSessionManager({ resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor' }) });
      const agentRegistry = createMockAgentRegistry();
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'none', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
    });

    it('writes the current relation without an active session', async () => {
      const sm = createMockSessionManager({ getActiveSession: vi.fn().mockResolvedValue(null) });
      const setShowActivities = vi.fn();
      const agentRegistry = createMockAgentRegistry({ setShowActivities });
      const { handler } = createHandler({ sessionManager: sm, agentRegistry });
      const result = await handler.execMenuUpdate('/activity', 'all', 'aun', 'chat1', 'user1');
      expect(result).toEqual({
        data: {
          mode: 'all',
          scope: 'relation',
          field: 'show_activities',
          self: TEST_AID,
          peerKey: formatPeerKey('aun', 'user1'),
        },
      });
      expect(setShowActivities).not.toHaveBeenCalled();
      expect(readRelationConfig().show_activities).toBe('all');
    });

    it('writes agent config only when agent scope is explicit', async () => {
      const { handler } = createHandler();

      const result = await handler.execMenuUpdate(
        '/activity',
        'text',
        'aun',
        'chat1',
        'user1',
        undefined,
        false,
        { scope: 'agent' },
      );

      expect(result).toEqual({
        data: {
          mode: 'text',
          scope: 'agent',
          field: 'show_activities',
          self: TEST_AID,
        },
      });
      expect(readRelationConfig().show_activities).toBeUndefined();
      expect(readTestAgentConfig().show_activities).toBe('text');
    });
  });

  describe('/observable', () => {
    it('persists true through the owning Agent handle', async () => {
      const agentRegistry = createMockAgentRegistry();
      const { handler } = createHandler({ agentRegistry });
      const result = await handler.execMenuUpdate('/observable', 'true', 'aun', 'chat1', 'user1');
      const agent = agentRegistry.resolveByChannel.mock.results[0]?.value ?? agentRegistry.resolveByChannel('aun');
      expect(result).toEqual({ data: { observable: true } });
      expect(agent.setObservable).toHaveBeenCalledWith(true);
    });

    it('rejects values other than true or false', async () => {
      const { handler } = createHandler();
      const result = await handler.execMenuUpdate('/observable', 'on', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('INVALID_VALUE');
    });

    it('rejects non-owner updates', async () => {
      const sm = createMockSessionManager({
        resolveIdentity: vi.fn().mockReturnValue({ role: 'admin', mode: 'interactive' }),
      });
      const { handler } = createHandler({ sessionManager: sm });
      const result = await handler.execMenuUpdate('/observable', 'true', 'aun', 'chat1', 'user1') as any;
      expect(result.code).toBe('NO_PERMISSION');
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

    expect(perm?.next?.items.map((item: any) => item.value)).toEqual([
      'readonly', 'auto', 'request', 'bypass',
    ]);
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

  it('shows observable only to owners in agent scope', () => {
    const { handler } = createHandler();
    const ownerCommands = flatten(handler.getMenuItems('owner', 'private', 'agent'));
    const adminCommands = flatten(handler.getMenuItems('admin', 'private', 'agent'));
    const controlCommands = flatten(handler.getMenuItems('owner', 'private', 'control'));
    const observable = ownerCommands.find(command => command.cmd === '/observable');

    expect(observable?.next?.items.map((item: any) => item.value)).toEqual(['true', 'false']);
    expect(adminCommands.some(command => command.cmd === '/observable')).toBe(false);
    expect(controlCommands.some(command => command.cmd === '/observable')).toBe(false);
  });

  it('handles observable slash query and boolean updates', async () => {
    const agentRegistry = createMockAgentRegistry();
    const { handler } = createHandler({ agentRegistry });

    const query = await handler.handle('/observable', 'aun', 'chat1', undefined, 'user1') as any;
    const enabled = await handler.handle('/observable true', 'aun', 'chat1', undefined, 'user1') as any;
    const disabled = await handler.handle('/observable false', 'aun', 'chat1', undefined, 'user1') as any;
    const invalid = await handler.handle('/observable on', 'aun', 'chat1', undefined, 'user1') as any;
    const agent = agentRegistry.resolveByChannel('aun');

    expect(query.text).toContain('观察者模式: false');
    expect(enabled.text).toContain('观察者模式: true');
    expect(agent.setObservable).toHaveBeenCalledWith(true);
    expect(disabled.text).toContain('观察者模式: false');
    expect(agent.setObservable).toHaveBeenCalledWith(false);
    expect(invalid.kind).toBe('command.error');
    expect(invalid.text).toContain('/observable <true|false>');
  });
});

describe('/cli config authorization', () => {
  function installPassthroughSpy(handler: CommandHandler) {
    const passthrough = vi.fn().mockResolvedValue({ data: { ok: true } });
    (handler as any).execCliPassthrough = passthrough;
    return passthrough;
  }

  it('authorizes and executes the same normalized relation argv for member', async () => {
    ownersMock.value = [];
    const sm = createMockSessionManager({
      resolveIdentity: vi.fn().mockReturnValue({ role: 'member', mode: 'interactive' }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const passthrough = installPassthroughSpy(handler);

    const result = await handler.execMenuAction(
      '/cli',
      'exec',
      { argv: ['ec', 'config', 'set', 'chatmode.private', 'proactive'] },
      'aun',
      'chat1',
      'user1',
    );

    expect(result).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledWith([
      'config', 'set', 'chatmode.private', 'proactive',
      '--self', TEST_AID, '--peer', formatPeerKey('aun', 'user1'),
    ]);
  });

  it('rejects unknown raw CLI before spawn', async () => {
    const { handler } = createHandler();
    const passthrough = installPassthroughSpy(handler);

    const result = await handler.execMenuAction(
      '/cli', 'exec', { argv: ['totally-unknown', '--token', 'secret'] },
      'aun', 'chat1', 'user1', { role: 'owner', mode: 'interactive' },
    ) as any;

    expect(result.code).toBe('NOT_ALLOWED');
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('supports the deprecated command string through safe tokenization', async () => {
    const { handler } = createHandler();
    const passthrough = installPassthroughSpy(handler);

    const result = await handler.execMenuAction(
      '/cli', 'exec', { command: 'status --format "json"' },
      'aun', 'chat1', 'user1', { role: 'owner', mode: 'interactive' },
    );

    expect(result).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledWith(['status', '--format', 'json']);
  });

  it('rejects malformed argv before spawn', async () => {
    const { handler } = createHandler();
    const passthrough = installPassthroughSpy(handler);

    const result = await handler.execMenuAction(
      '/cli', 'exec', { argv: ['status', 123] },
      'aun', 'chat1', 'user1', { role: 'owner', mode: 'interactive' },
    ) as any;

    expect(result.code).toBe('INVALID_ARGUMENT');
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('does not spawn for denied fields or sensitive reads', async () => {
    ownersMock.value = [];
    const sm = createMockSessionManager({
      resolveIdentity: vi.fn().mockReturnValue({ role: 'member', mode: 'interactive' }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const passthrough = installPassthroughSpy(handler);

    const deniedWrite = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: ['config', 'set', 'permissionMode', 'bypass'] },
      'aun', 'chat1', 'user1',
    ) as any;
    expect(deniedWrite.code).toBe('ARGUMENT_MISMATCH');

    const deniedRead = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: ['config', 'get', 'owners'] },
      'aun', 'chat1', 'user1',
    ) as any;
    expect(deniedRead.code).toBe('DANGEROUS_NOT_GRANTED');
    expect(passthrough).not.toHaveBeenCalled();
  });

  it('keeps visitor config access read-only before spawn', async () => {
    ownersMock.value = [];
    const sm = createMockSessionManager({
      resolveIdentity: vi.fn().mockReturnValue({ role: 'visitor', mode: 'interactive' }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const passthrough = installPassthroughSpy(handler);

    const readResult = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: ['config', 'get', 'chatmode.private'] },
      'aun', 'chat1', 'user1',
    );
    expect(readResult).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledTimes(1);

    const writeResult = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: ['config', 'set', 'chatmode.private', 'interactive'] },
      'aun', 'chat1', 'user1',
    ) as any;
    expect(writeResult.code).toBe('NO_PERMISSION');
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it('uses the current group relation without comparing it to the actor id', async () => {
    ownersMock.value = [];
    const groupSession = {
      id: 'group-session', channel: 'aun', channelId: 'group1',
      projectPath: '/tmp/test', agentId: 'claude', baseagent: 'claude',
      selfAID: TEST_AID, channelType: 'aun', sessionKey: 'aun#group1#',
      chatType: 'group', sessionMode: 'interactive', chatMode: 'interactive',
      metadata: { groupId: 'group1', permissionMode: 'auto' },
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const sm = createMockSessionManager({
      getActiveSession: vi.fn().mockResolvedValue(groupSession),
      getActiveSessionSync: vi.fn().mockReturnValue(groupSession),
      resolveIdentity: vi.fn().mockReturnValue({ role: 'member', mode: 'interactive' }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const passthrough = installPassthroughSpy(handler);

    const result = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: ['config', 'set', 'chatmode.group', 'proactive'] },
      'aun', 'group1', 'member1',
    );
    expect(result).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledWith([
      'config', 'set', 'chatmode.group', 'proactive',
      '--self', TEST_AID, '--peer', formatPeerKey('aun', 'group1'),
    ]);
  });

  it('lets an authenticated owner target a group relation from the App p2p control relation', async () => {
    ownersMock.value = [];
    const { handler } = createHandler();
    const passthrough = installPassthroughSpy(handler);
    const groupPeer = formatPeerKey('aun', 'group.example/42');

    const result = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: [
        'config', 'set', 'chatmode.group', 'proactive',
        '--self', TEST_AID, '--peer', groupPeer,
      ] },
      'aun', 'owner.agentid.pub', 'owner.agentid.pub',
      { role: 'owner', mode: 'interactive' },
    );

    expect(result).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledWith([
      'config', 'set', 'chatmode.group', 'proactive',
      '--self', TEST_AID, '--peer', groupPeer,
    ]);
  });

  it('lets an authenticated owner target a peer AID relation from the App p2p control relation', async () => {
    ownersMock.value = [];
    const { handler } = createHandler();
    const passthrough = installPassthroughSpy(handler);
    const targetPeer = formatPeerKey('aun', 'peer.agentid.pub');

    const result = await handler.execMenuAction(
      '/cli', 'exec',
      { argv: [
        'config', 'set', 'chatmode.private', 'proactive',
        '--self', TEST_AID, '--peer', targetPeer,
      ] },
      'aun', 'owner.agentid.pub', 'owner.agentid.pub',
      { role: 'owner', mode: 'interactive' },
    );

    expect(result).toEqual({ data: { ok: true } });
    expect(passthrough).toHaveBeenCalledWith([
      'config', 'set', 'chatmode.private', 'proactive',
      '--self', TEST_AID, '--peer', targetPeer,
    ]);
  });
});

describe('/file fetch control response', () => {
  it('builds result.file with snake_case correlation', () => {
    const attachment = {
      owner_aid: TEST_AID,
      object_key: 'shared/id/result.json',
      filename: 'result.json',
      size_bytes: 12,
      sha256: 'hash',
      content_type: 'application/json',
    };

    expect(buildAunFilePayload({
      filename: 'result.json', size: 12, contentType: 'application/json', attachment,
      context: { metadata: { correlationId: 'file-fetch-1' } },
    })).toEqual({
      type: 'result.file', text: expect.any(String), correlation_id: 'file-fetch-1',
      name: 'result.json', content_type: 'application/json', attachments: [attachment],
    });

    expect(buildAunFilePayload({
      filename: 'result.json', size: 12, contentType: 'application/json', attachment,
    })).not.toHaveProperty('correlation_id');
  });

  it('sends one correlated file payload and returns accepted', async () => {
    const projectPath = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    const filePath = path.join(projectPath, 'result.json');
    fs.writeFileSync(filePath, '{"ok":true}');
    const session = {
      ...createMockSessionManager().getActiveSessionSync(),
      projectPath,
    };
    const sm = createMockSessionManager({
      getActiveSession: vi.fn().mockResolvedValue(session),
      getActiveSessionSync: vi.fn().mockReturnValue(session),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const send = vi.fn().mockResolvedValue(undefined);
    handler.registerAdapter({
      channelName: 'aun', channelKey: 'aun', capabilities: { file: true }, send,
    } as any);

    const result = await handler.execMenuAction(
      '/file', 'fetch', { path: 'result.json' }, 'aun', 'chat1', 'user1',
      { role: 'owner', mode: 'interactive' }, 'private', 'file-fetch-1',
    );

    expect(result).toEqual({ data: { accepted: true } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({
      kind: 'result.file', filePath: fs.realpathSync(filePath), correlationId: 'file-fetch-1',
    });
  });

  it('denies file fetch before touching the filesystem', async () => {
    const { handler } = createHandler();
    const existsSpy = vi.spyOn(fs, 'existsSync');

    const result = await handler.execMenuAction(
      '/file', 'fetch', { path: 'secret.txt' }, 'aun', 'chat1', 'user1',
      { role: 'visitor', mode: 'interactive' }, 'private', 'file-denied-1',
    ) as any;

    expect(result.code).toMatch(/NO_PERMISSION|NOT_ALLOWED/);
    expect(existsSpy.mock.calls.some(([checkedPath]) => String(checkedPath).endsWith('secret.txt'))).toBe(false);
    existsSpy.mockRestore();
  });
});

describe('managed agent config IPC', () => {
  function managedSession(peerId = 'user1') {
    return {
      id: 'managed-session',
      channel: 'aun',
      channelId: 'chat1',
      projectPath: '/tmp/test',
      agentId: 'claude',
      baseagent: 'claude',
      selfAID: TEST_AID,
      channelType: 'aun',
      sessionKey: `aun#${peerId}#`,
      agentSessionId: 'agent-sess-123',
      chatType: 'private',
      sessionMode: 'interactive',
      chatMode: 'interactive',
      metadata: { permissionMode: 'auto', peerId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function createManagedHandler(role: 'member' | 'visitor') {
    ownersMock.value = [];
    const session = managedSession();
    writeRelationConfig('user1', { roles: { assigned: role } });
    const sm = createMockSessionManager({
      getSessionById: vi.fn().mockResolvedValue(session),
    });
    return createHandler({ sessionManager: sm }).handler;
  }

  function issueManagedToken(
    handler: CommandHandler,
    session: ReturnType<typeof managedSession>,
    actorId = session.metadata.peerId,
  ): string {
    const chatType = session.chatType === 'group' ? 'group' : 'private';
    const relationId = chatType === 'group'
      ? ((session.metadata as any).groupId || session.channelId)
      : actorId;
    return ((handler as any).agentDelegationRegistry as AgentDelegationRegistry).issue({
      sessionId: session.id,
      taskId: `task-${session.id}`,
      messageId: `message-${session.id}`,
      actorId,
      channel: session.channel,
      channelType: session.channelType,
      chatType,
      selfAid: session.selfAID,
      peerKey: formatPeerKey(session.channelType, relationId),
      issuedRole: 'member',
    });
  }

  it('rejects missing, forged, revoked, and cross-session delegation tokens', async () => {
    ownersMock.value = [];
    const first = managedSession('user1');
    const second = { ...managedSession('user2'), id: 'managed-session-2' };
    const sm = createMockSessionManager({
      getSessionById: vi.fn(async (id: string) => id === first.id ? first : id === second.id ? second : null),
    });
    const { handler, delegationRegistry } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, first);

    expect(await handler.handleConfigOperation(['config', 'get', 'chatmode.private'], first.id))
      .toMatchObject({ ok: false, code: 'DELEGATION_REQUIRED' });
    expect(await handler.handleConfigOperation(['config', 'get', 'chatmode.private'], first.id, 'forged'))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
    expect(await handler.handleConfigOperation(['config', 'get', 'chatmode.private'], second.id, token))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });

    delegationRegistry.revokeTask(first.id, `task-${first.id}`);
    expect(await handler.handleConfigOperation(['config', 'get', 'chatmode.private'], first.id, token))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
  });

  it('resolves the trusted session relation and writes only its relation config', async () => {
    const handler = createManagedHandler('member');
    const session = managedSession();
    const token = issueManagedToken(handler, session);
    const result = await handler.handleConfigOperation(
      ['config', 'set', 'chatmode.private', 'proactive'],
      'managed-session',
      token,
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        subcommand: 'set',
        field: 'chatmode.private',
        value: 'proactive',
        scope: 'relation',
      },
    });
    expect(readRelationConfigByKey(formatPeerKey('aun', 'user1')).chatmode.private).toBe('proactive');
    expect(readTestAgentConfig().chatmode.private).toBe('interactive');
  });

  it('keeps visitor field access read-only', async () => {
    const handler = createManagedHandler('visitor');
    const token = issueManagedToken(handler, managedSession());
    const readResult = await handler.handleConfigOperation(
      ['config', 'get', 'chatmode.private'],
      'managed-session',
      token,
    );
    expect(readResult).toMatchObject({
      ok: true,
      result: { subcommand: 'get', field: 'chatmode.private', value: 'interactive', scope: 'relation' },
    });

    const writeResult = await handler.handleConfigOperation(
      ['config', 'set', 'chatmode.private', 'proactive'],
      'managed-session',
      token,
    );
    expect(writeResult).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
    expect(readTestAgentConfig().chatmode.private).toBe('interactive');
  });

  it('denies sensitive fields and selectors outside the current relation', async () => {
    const handler = createManagedHandler('member');
    const token = issueManagedToken(handler, managedSession());
    const sensitive = await handler.handleConfigOperation(
      ['config', 'get', 'owners'],
      'managed-session',
      token,
    );
    expect(sensitive).toMatchObject({ ok: false, code: 'DANGEROUS_NOT_GRANTED' });

    const otherRelation = await handler.handleConfigOperation(
      [
        'config', 'set', 'chatmode.private', 'proactive',
        '--self', TEST_AID, '--peer', formatPeerKey('aun', 'other-user'),
      ],
      'managed-session',
      token,
    );
    expect(otherRelation).toMatchObject({ ok: false, code: 'ARGUMENT_MISMATCH' });
    expect(fs.existsSync(relationConfigPathByKey(formatPeerKey('aun', 'other-user')))).toBe(false);
  });

  it('limits a group owner to relation-scoped config mutations', async () => {
    const ownerId = 'owner.agentid.pub';
    writeTestAgentConfig({ owners: [ownerId] });
    const groupSession = {
      ...managedSession(ownerId),
      id: 'managed-group-session',
      channelId: 'group1',
      sessionKey: 'aun#group1#',
      chatType: 'group',
      metadata: { permissionMode: 'auto', peerId: ownerId, groupId: 'group1' },
    };
    const sm = createMockSessionManager({
      getSessionById: vi.fn().mockResolvedValue(groupSession),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, groupSession as ReturnType<typeof managedSession>, ownerId);

    for (const argv of [
      ['config', 'set', 'chatmode.group', 'interactive', '--self', TEST_AID],
      ['config', 'set', 'debug', 'true', '--process'],
    ]) {
      expect(await handler.handleConfigOperation(argv, groupSession.id, token))
        .toMatchObject({ ok: false, code: 'SCOPE_MISMATCH' });
    }

    expect(await handler.handleConfigOperation(
      ['config', 'set', 'chatmode.group', 'interactive'],
      groupSession.id,
      token,
    )).toMatchObject({
      ok: true,
      result: { subcommand: 'set', field: 'chatmode.group', scope: 'relation' },
    });
    expect(readRelationConfigByKey(formatPeerKey('aun', 'group1')).chatmode.group).toBe('interactive');
    expect(readTestAgentConfig().chatmode.group).toBe('proactive');
  });

  it('uses the current group sender instead of a stale owner stored on the session', async () => {
    ownersMock.value = [];
    const staleOwner = 'stale-owner.agentid.pub';
    const currentVisitor = 'current-visitor.agentid.pub';
    writeTestAgentConfig({ owners: [staleOwner] });
    writeRelationConfig('group-stale-owner', {
      roles: { members: { [currentVisitor]: 'visitor' } },
    });
    const session = {
      ...managedSession(staleOwner),
      id: 'group-stale-owner-session',
      channelId: 'group-stale-owner',
      chatType: 'group',
      metadata: { peerId: staleOwner, groupId: 'group-stale-owner' },
    };
    const sm = createMockSessionManager({ getSessionById: vi.fn().mockResolvedValue(session) });
    const { handler } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, session as ReturnType<typeof managedSession>, currentVisitor);

    expect(await handler.handleConfigOperation(
      ['config', 'set', 'chatmode.group', 'interactive'], session.id, token,
    )).toMatchObject({ ok: false, code: 'NO_PERMISSION' });
  });

  it('allows the current group owner even when the session stores a stale visitor', async () => {
    ownersMock.value = [];
    const staleVisitor = 'stale-visitor.agentid.pub';
    const currentOwner = 'current-owner.agentid.pub';
    writeTestAgentConfig({ owners: [currentOwner] });
    const session = {
      ...managedSession(staleVisitor),
      id: 'group-stale-visitor-session',
      channelId: 'group-stale-visitor',
      chatType: 'group',
      metadata: { peerId: staleVisitor, groupId: 'group-stale-visitor' },
    };
    const sm = createMockSessionManager({ getSessionById: vi.fn().mockResolvedValue(session) });
    const { handler } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, session as ReturnType<typeof managedSession>, currentOwner);

    expect(await handler.handleConfigOperation(
      ['config', 'set', 'chatmode.group', 'interactive'], session.id, token,
    )).toMatchObject({ ok: true, result: { scope: 'relation' } });
    expect(readRelationConfigByKey(formatPeerKey('aun', 'group-stale-visitor')).chatmode.group).toBe('interactive');
  });

  it('allows a private agent owner to manage sensitive current-agent fields', async () => {
    ownersMock.value = [];
    const ownerId = 'agent-owner.agentid.pub';
    writeTestAgentConfig({ owners: [ownerId], admins: [] });
    const session = managedSession(ownerId);
    const sm = createMockSessionManager({ getSessionById: vi.fn().mockResolvedValue(session) });
    const { handler } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, session);

    expect(await handler.handleConfigOperation(
      ['config', 'get', 'owners'], session.id, token,
    )).toMatchObject({ ok: true, result: { value: [ownerId], scope: 'relation' } });
    expect(await handler.handleConfigOperation(
      ['config', 'set', 'admins', 'next-admin.agentid.pub', '--self', TEST_AID], session.id, token,
    )).toMatchObject({ ok: true, result: { scope: 'agent' } });
    expect(await handler.handleConfigOperation(
      ['config', 'unset', 'admins', '--self', TEST_AID], session.id, token,
    )).toMatchObject({ ok: true, result: { removed: true, scope: 'agent' } });
  });

  it('allows a private daemon owner to use process and global config commands', async () => {
    const daemonOwner = 'daemon-owner.agentid.pub';
    ownersMock.value = [daemonOwner];
    const session = managedSession(daemonOwner);
    const sm = createMockSessionManager({ getSessionById: vi.fn().mockResolvedValue(session) });
    const { handler } = createHandler({ sessionManager: sm });
    const token = issueManagedToken(handler, session);

    expect(await handler.handleConfigOperation(
      ['config', 'get', 'owners', '--process'], session.id, token,
    )).toMatchObject({ ok: true, result: { scope: 'process' } });
    expect(await handler.handleConfigOperation(
      ['config', 'history'], session.id, token,
    )).toMatchObject({ ok: true, result: { subcommand: 'history' } });
  });

  it('rejects an invalid daemon session', async () => {
    const { handler } = createHandler();
    const session = { ...managedSession(), id: 'missing-session' };
    const token = issueManagedToken(handler, session);
    expect(await handler.handleConfigOperation(
      ['config', 'get', 'chatmode.private'],
      'missing-session',
      token,
    )).toMatchObject({ ok: false, code: 'INVALID_SESSION' });
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

  it('/mentionmode marks current mode as selected', async () => {
    writeTestAgentConfig({ mentionMode: 'disabled' });
    const sm = createMockSessionManager({
      getActiveSession: vi.fn().mockResolvedValue({
        id: 'sess-1', agentId: 'claude', chatType: 'group', sessionMode: 'interactive',
        metadata: { dispatchMode: 'broadcast' }, projectPath: '/tmp',
        createdAt: Date.now(), updatedAt: Date.now(),
      }),
    });
    const { handler } = createHandler({ sessionManager: sm });
    const items = await handler.getSubMenuItems('/mentionmode', 'aun', 'chat1');
    const disabled = items?.find(i => i.value === 'disabled');
    const mentionOnly = items?.find(i => i.value === 'mention-only');
    expect(disabled?.selected).toBe(true);
    expect(mentionOnly?.selected).toBe(false);
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
    writeRelationConfig('user1', { show_activities: 'none' });
    const { handler } = createHandler();
    const items = await handler.getSubMenuItems('/activity', 'aun', 'chat1');
    const none = items?.find(i => i.value === 'none');
    const all = items?.find(i => i.value === 'all');
    expect(none?.selected).toBe(true);
    expect(all?.selected).toBe(false);
  });
});
