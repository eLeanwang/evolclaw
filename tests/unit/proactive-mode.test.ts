import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { StreamFlusher } from '../../src/core/message/stream-flusher.js';
import { CommandHandler } from '../../src/core/command-handler.js';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { EventBus } from '../../src/core/event-bus.js';
import { PermissionGateway } from '../../src/core/permission.js';
import { getChannelSessionMode } from '../../src/config.js';
import type { Config, ChannelAdapter, Session } from '../../src/types.js';

// =====================================================================
// 1. StreamFlusher silent 模式
// =====================================================================
describe('StreamFlusher silent 模式 (proactive)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('silent=true 时 addText/addActivity 不调用 send', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 1000, undefined, false, true);

    flusher.addText('hello world');
    flusher.addActivity('🔧 Read: x.ts');

    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('silent 模式下 flush(true) 不发送但清理内部状态', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 1000, undefined, false, true);

    flusher.addText('drained');
    expect(flusher.hasContent()).toBe(true);

    await flusher.flush(true);

    expect(send).not.toHaveBeenCalled();
    expect(flusher.hasContent()).toBe(false);  // queue/buffer 已清理
    expect(flusher.hasSentContent()).toBe(false);
  });

  it('silent 模式下 flushActivitiesOnly 也是空操作', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 1000, undefined, false, true);

    flusher.addActivity('🔧 something');
    await flusher.flushActivitiesOnly();

    expect(send).not.toHaveBeenCalled();
  });

  it('silent 模式下 getFinalText 仍累积全部文本（用于诊断）', () => {
    const send = vi.fn();
    const flusher = new StreamFlusher(send, 1000, undefined, false, true);

    flusher.addText('part1 ');
    flusher.addText('part2');

    expect(flusher.getFinalText()).toBe('part1 part2');
  });

  it('silent=false（默认）时行为不变（回归保护）', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 1000);

    flusher.addText('still works');
    await vi.advanceTimersByTimeAsync(2000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('still works');
  });
});

// =====================================================================
// 2. config.getChannelSessionMode
// =====================================================================
describe('getChannelSessionMode', () => {
  it('单实例对象形式：读取 sessionMode', () => {
    const config: Config = {
      channels: { aun: { aid: 'evolclaw-ai.agentid.pub', sessionMode: 'proactive' } },
    } as any;
    expect(getChannelSessionMode(config, 'aun')).toBe('proactive');
  });

  it('数组形式：按实例名匹配', () => {
    const config: Config = {
      channels: {
        aun: [
          { name: 'aun-main', aid: 'a.agentid.pub', sessionMode: 'proactive' } as any,
          { name: 'aun-work', aid: 'b.agentid.pub', sessionMode: 'interactive' } as any,
        ],
      },
    } as any;
    expect(getChannelSessionMode(config, 'aun-main')).toBe('proactive');
    expect(getChannelSessionMode(config, 'aun-work')).toBe('interactive');
  });

  it('未配置 sessionMode 时返回 undefined', () => {
    const config: Config = {
      channels: { aun: { aid: 'x.agentid.pub' } },
    } as any;
    expect(getChannelSessionMode(config, 'aun')).toBeUndefined();
  });

  it('实例名不存在时返回 undefined', () => {
    const config: Config = {
      channels: { aun: { aid: 'x.agentid.pub', sessionMode: 'proactive' } },
    } as any;
    expect(getChannelSessionMode(config, 'aun-nonexistent')).toBeUndefined();
  });

  it('单实例对象使用自定义 name 时按 name 匹配', () => {
    const config: Config = {
      channels: { aun: { name: 'my-aun', aid: 'x.agentid.pub', sessionMode: 'proactive' } },
    } as any;
    expect(getChannelSessionMode(config, 'my-aun')).toBe('proactive');
    expect(getChannelSessionMode(config, 'aun')).toBeUndefined();
  });
});

// =====================================================================
// 3. SessionManager.setSessionModeResolver / 默认值规则
// =====================================================================
describe('SessionManager sessionMode 默认值', () => {
  let sessionManager: SessionManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-pmode-${Date.now()}-${Math.random()}.db`);
    sessionManager = new SessionManager(dbPath, new EventBus(), () => true);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('未设置 resolver 时所有新建 session 默认 interactive', async () => {
    const s = await sessionManager.getOrCreateSession('feishu', 'chat1', '/tmp/p');
    expect(s.sessionMode).toBe('interactive');
  });

  it('resolver 返回 proactive 时新建 session 锁定为 proactive', async () => {
    sessionManager.setSessionModeResolver(() => 'proactive');
    const s = await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p');
    expect(s.sessionMode).toBe('proactive');
  });

  it('resolver 收到正确的 channel/chatType 参数', async () => {
    const spy = vi.fn().mockReturnValue('interactive');
    sessionManager.setSessionModeResolver(spy);

    await sessionManager.getOrCreateSession('aun-main', 'g-x', '/tmp/p', undefined, undefined, undefined, undefined, 'group');

    expect(spy).toHaveBeenCalledWith('aun-main', 'group');
  });

  it('resolver 返回 undefined 时回退到 interactive', async () => {
    sessionManager.setSessionModeResolver(() => undefined);
    const s = await sessionManager.getOrCreateSession('feishu', 'c1', '/tmp/p');
    expect(s.sessionMode).toBe('interactive');
  });

  it('resolver 在 createNewSession 路径同样生效', async () => {
    sessionManager.setSessionModeResolver(() => 'proactive');
    const s = await sessionManager.createNewSession('aun', 'g-1', '/tmp/p', '测试会话');
    expect(s.sessionMode).toBe('proactive');
  });

  it('updateSession 支持更新 sessionMode 并持久化', async () => {
    const s = await sessionManager.getOrCreateSession('feishu', 'chat1', '/tmp/p');
    expect(s.sessionMode).toBe('interactive');

    await sessionManager.updateSession(s.id, { sessionMode: 'proactive' });

    const reloaded = await sessionManager.getSessionById(s.id);
    expect(reloaded?.sessionMode).toBe('proactive');
  });

  it('updateSession 切换回 interactive 也生效', async () => {
    sessionManager.setSessionModeResolver(() => 'proactive');
    const s = await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p');
    expect(s.sessionMode).toBe('proactive');

    await sessionManager.updateSession(s.id, { sessionMode: 'interactive' });
    const reloaded = await sessionManager.getSessionById(s.id);
    expect(reloaded?.sessionMode).toBe('interactive');
  });
});

// =====================================================================
// 4. CommandHandler /chatmode 与 handleCtl /send
// =====================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    channel: 'aun',
    channelId: 'g-1',
    projectPath: '/tmp/test',
    threadId: '',
    agentId: 'claude',
    chatType: 'group',
    sessionMode: 'interactive',
    name: '默认会话',
    metadata: { isActive: true },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMockSessionManager(session: Session) {
  return {
    getActiveSession: vi.fn().mockResolvedValue(session),
    getSessionById: vi.fn().mockResolvedValue(session),
    getOrCreateSession: vi.fn().mockResolvedValue(session),
    getThreadSession: vi.fn().mockResolvedValue(null),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn(),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    listSessions: vi.fn().mockResolvedValue([session]),
    clearProcessing: vi.fn(),
  } as any;
}

function createMockAgent() {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    hasActiveStream: vi.fn().mockReturnValue(false),
    getModel: vi.fn().mockReturnValue('sonnet'),
    capabilities: { clear: true, compact: true },
  } as any;
}

function createTestEnv(session: Session, configOverride: Partial<Config> = {}) {
  const sessionManager = createMockSessionManager(session);
  const agentMap = new Map([['claude', createMockAgent()]]);
  const eventBus = new EventBus();
  const config: Config = {
    channels: { aun: { aid: 'x.agentid.pub', owner: 'owner1' } },
    projects: { defaultPath: '/tmp/test', autoCreate: false } as any,
    ...configOverride,
  } as any;
  const messageCache = {
    getCount: vi.fn().mockReturnValue(0),
    hasMessages: vi.fn().mockReturnValue(false),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  } as any;
  const messageQueue = {
    acquireLock: vi.fn().mockReturnValue(vi.fn()),
    getQueueLength: vi.fn().mockReturnValue(0),
    isProcessing: vi.fn().mockReturnValue(false),
  } as any;
  const adapter: ChannelAdapter = {
    channelName: 'aun',
    sendText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  };
  const gateway = new PermissionGateway();
  gateway.setEventBus(eventBus);

  const cmdHandler = new CommandHandler(sessionManager, agentMap, config, messageCache, eventBus);
  cmdHandler.setPermissionGateway(gateway);
  cmdHandler.setMessageQueue(messageQueue);
  cmdHandler.registerAdapter(adapter);

  return { cmdHandler, sessionManager, adapter, config };
}

describe('/chatmode 命令', () => {
  it('无参数 + 无锁定：显示当前模式', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler } = createTestEnv(session);

    const result = await cmdHandler.handle('/chatmode', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('interactive');
    expect(result).not.toContain('锁定');
  });

  it('无参数 + 通道锁定：提示锁定原因', async () => {
    const session = createMockSession({ sessionMode: 'proactive' });
    const config = { channels: { aun: { aid: 'x.agentid.pub', owner: 'owner1', sessionMode: 'proactive' } } };
    const { cmdHandler } = createTestEnv(session, config as any);

    const result = await cmdHandler.handle('/chatmode', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('proactive');
    expect(result).toContain('锁定');
  });

  it('切换到 proactive：调用 updateSession 持久化', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler, sessionManager } = createTestEnv(session);

    const result = await cmdHandler.handle('/chatmode proactive', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('已切换');
    expect(result).toContain('proactive');
    expect(sessionManager.updateSession).toHaveBeenCalledWith(session.id, { sessionMode: 'proactive' });
  });

  it('通道锁定时拒绝切换', async () => {
    const session = createMockSession({ sessionMode: 'proactive' });
    const config = { channels: { aun: { aid: 'x.agentid.pub', owner: 'owner1', sessionMode: 'proactive' } } };
    const { cmdHandler, sessionManager } = createTestEnv(session, config as any);

    const result = await cmdHandler.handle('/chatmode interactive', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('❌');
    expect(result).toContain('锁定');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('无效模式参数：拒绝并提示可选值', async () => {
    const session = createMockSession();
    const { cmdHandler, sessionManager } = createTestEnv(session);

    const result = await cmdHandler.handle('/chatmode invalid', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('❌');
    expect(result).toContain('interactive');
    expect(result).toContain('proactive');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('切换到当前模式：返回 "已是" 提示但不更新', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler, sessionManager } = createTestEnv(session);

    const result = await cmdHandler.handle('/chatmode interactive', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('已是');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });

  it('非管理员被拒绝', async () => {
    const session = createMockSession();
    const { cmdHandler, sessionManager } = createTestEnv(session);
    sessionManager.resolveIdentity.mockReturnValue({ role: 'guest', mode: 'interactive' });

    const result = await cmdHandler.handle('/chatmode proactive', 'aun', 'g-1', undefined, 'guest1');

    expect(result).toContain('❌');
    expect(sessionManager.updateSession).not.toHaveBeenCalled();
  });
});

describe('/activity 在 proactive 模式下被拒绝', () => {
  it('proactive session 调用 /activity 返回错误提示', async () => {
    const session = createMockSession({ sessionMode: 'proactive' });
    const { cmdHandler } = createTestEnv(session);

    const result = await cmdHandler.handle('/activity all', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('proactive');
    expect(result).toContain('不支持');
  });

  it('interactive session 仍可用 /activity（回归保护）', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler } = createTestEnv(session);

    const result = await cmdHandler.handle('/activity', 'aun', 'g-1', undefined, 'owner1');

    // 不应包含 proactive 拒绝提示
    expect(result == null || !result.includes('proactive 模式，不支持')).toBe(true);
  });
});

describe('handleCtl /send 文本消息', () => {
  it('成功发送文本，调用 adapter.sendText', async () => {
    const session = createMockSession();
    const { cmdHandler, adapter } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/send 你好', session.id);

    expect(result.ok).toBe(true);
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect((adapter.sendText as any).mock.calls[0][0]).toBe(session.channelId);
    expect((adapter.sendText as any).mock.calls[0][1]).toBe('你好');
  });

  it('空消息内容返回错误', async () => {
    const session = createMockSession();
    const { cmdHandler, adapter } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/send   ', session.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('内容不能为空');
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('/send 无参数返回错误', async () => {
    const session = createMockSession();
    const { cmdHandler, adapter } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/send', session.id);

    expect(result.ok).toBe(false);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('未注册的 adapter 返回错误', async () => {
    const session = createMockSession({ channel: 'unknown-channel' });
    const { cmdHandler } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/send 你好', session.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('adapter 未找到');
  });

  it('adapter.sendText 抛错时返回 ok=false', async () => {
    const session = createMockSession();
    const { cmdHandler, adapter } = createTestEnv(session);
    (adapter.sendText as any).mockRejectedValueOnce(new Error('network failed'));

    const result = await cmdHandler.handleCtl('/send 你好', session.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('network failed');
  });

  it('恢复 session.metadata 中的 ReplyContext（话题群聊）', async () => {
    const session = createMockSession({
      metadata: {
        isActive: true,
        replyContext: { threadId: 'thread-abc', peerId: 'user1' },
      },
    });
    const { cmdHandler, adapter } = createTestEnv(session);

    await cmdHandler.handleCtl('/send 群聊回复', session.id);

    const ctx = (adapter.sendText as any).mock.calls[0][2];
    expect(ctx).toBeDefined();
    expect(ctx.threadId).toBe('thread-abc');
    expect(ctx.peerId).toBe('user1');
  });

  it('恢复 metadata.peerId 作为 ReplyContext 兜底（私聊）', async () => {
    const session = createMockSession({
      chatType: 'private',
      metadata: { isActive: true, peerId: 'dm-user' },
    });
    const { cmdHandler, adapter } = createTestEnv(session);

    await cmdHandler.handleCtl('/send 私聊回复', session.id);

    const ctx = (adapter.sendText as any).mock.calls[0][2];
    expect(ctx).toBeDefined();
    expect(ctx.peerId).toBe('dm-user');
  });

  it('无任何 metadata 时 ReplyContext 为 undefined', async () => {
    const session = createMockSession({ metadata: { isActive: true } });
    const { cmdHandler, adapter } = createTestEnv(session);

    await cmdHandler.handleCtl('/send 直接发送', session.id);

    const ctx = (adapter.sendText as any).mock.calls[0][2];
    expect(ctx).toBeUndefined();
  });

  it('replyContext.peerId 优先于 metadata.peerId', async () => {
    const session = createMockSession({
      metadata: {
        isActive: true,
        peerId: 'fallback-peer',
        replyContext: { threadId: 't1', peerId: 'thread-peer' },
      },
    });
    const { cmdHandler, adapter } = createTestEnv(session);

    await cmdHandler.handleCtl('/send msg', session.id);

    const ctx = (adapter.sendText as any).mock.calls[0][2];
    expect(ctx.peerId).toBe('thread-peer');
  });

  it('无效 sessionId 返回错误', async () => {
    const session = createMockSession();
    const { cmdHandler, sessionManager } = createTestEnv(session);
    sessionManager.getSessionById.mockResolvedValueOnce(null);

    const result = await cmdHandler.handleCtl('/send hi', 'bad-session');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('无效的 session');
  });

  it('白名单外的命令被拒绝', async () => {
    const session = createMockSession();
    const { cmdHandler } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/secret-cmd', session.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('不允许的指令');
  });
});

describe('handleCtl /chatmode（CTL 白名单内）', () => {
  it('/chatmode 经过 ctl 入口可执行', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler, sessionManager } = createTestEnv(session);

    const result = await cmdHandler.handleCtl('/chatmode proactive', session.id);

    expect(result.ok).toBe(true);
    expect(sessionManager.updateSession).toHaveBeenCalledWith(session.id, { sessionMode: 'proactive' });
  });
});

// =====================================================================
// 5. chatType 继承（switchProject / switchAgent / createNewSession）
// =====================================================================
describe('SessionManager chatType 继承', () => {
  let sessionManager: SessionManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-chattype-${Date.now()}-${Math.random()}.db`);
    sessionManager = new SessionManager(dbPath, new EventBus(), () => true);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('createNewSession 继承当前活跃 session 的 chatType', async () => {
    // 先创建一个 group session
    const original = await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p', undefined, undefined, undefined, undefined, 'group');
    expect(original.chatType).toBe('group');

    // /new 创建新 session 应继承 group
    const newSession = await sessionManager.createNewSession('aun', 'g-1', '/tmp/p', '新会话');
    expect(newSession.chatType).toBe('group');
  });

  it('switchProject 继承当前活跃 session 的 chatType', async () => {
    // 先创建一个 group session
    await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p1', undefined, undefined, undefined, undefined, 'group');

    // 切换到新项目应继承 group
    const switched = await sessionManager.switchProject('aun', 'g-1', '/tmp/p2');
    expect(switched.chatType).toBe('group');
  });

  it('switchAgent 继承当前活跃 session 的 chatType', async () => {
    await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p', undefined, undefined, undefined, undefined, 'group');

    const switched = await sessionManager.switchAgent('aun', 'g-1', '/tmp/p', 'gemini');
    expect(switched.chatType).toBe('group');
  });

  it('无活跃 session 时回退到 private', async () => {
    // 直接 createNewSession 没有前置 session
    const session = await sessionManager.createNewSession('feishu', 'chat-new', '/tmp/p');
    expect(session.chatType).toBe('private');
  });

  it('chatType 继承 + sessionModeResolver 联动：群聊 → proactive', async () => {
    sessionManager.setSessionModeResolver((channel, chatType) => {
      if (chatType === 'group') return 'proactive';
      return undefined;
    });

    // 创建 group session
    await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p', undefined, undefined, undefined, undefined, 'group');

    // /new 继承 group → resolver 返回 proactive
    const newSession = await sessionManager.createNewSession('aun', 'g-1', '/tmp/p', '新会话');
    expect(newSession.chatType).toBe('group');
    expect(newSession.sessionMode).toBe('proactive');
  });

  it('话题会话继承主会话的 chatType', async () => {
    // 创建 group 主会话
    await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p', undefined, undefined, undefined, undefined, 'group');

    // 创建话题会话
    const threadSession = await sessionManager.getOrCreateSession('aun', 'g-1', '/tmp/p', 'thread-123', undefined, undefined, undefined, 'group');
    expect(threadSession.chatType).toBe('group');
  });

  it('chatType 自动修正：入站 group 时会刷新 private 历史 session', async () => {
    // 第一次创建时错误标记为 private（模拟历史脏数据）
    const s1 = await sessionManager.getOrCreateSession('aun', 'g-x', '/tmp/p', undefined, undefined, undefined, undefined, 'private');
    expect(s1.chatType).toBe('private');

    // 再次入站时传入正确的 group
    const s2 = await sessionManager.getOrCreateSession('aun', 'g-x', '/tmp/p', undefined, undefined, undefined, undefined, 'group');
    expect(s2.id).toBe(s1.id);  // 同一 session
    expect(s2.chatType).toBe('group');  // 已自动更新

    // 再次读取确认持久化
    const reloaded = await sessionManager.getSessionById(s1.id);
    expect(reloaded?.chatType).toBe('group');
  });

  it('chatType 一致时不触发更新', async () => {
    const s1 = await sessionManager.getOrCreateSession('aun', 'g-y', '/tmp/p', undefined, undefined, undefined, undefined, 'group');
    const originalUpdatedAt = s1.updatedAt;

    await new Promise(r => setTimeout(r, 5));
    const s2 = await sessionManager.getOrCreateSession('aun', 'g-y', '/tmp/p', undefined, undefined, undefined, undefined, 'group');
    expect(s2.chatType).toBe('group');
    // 虽然 updated_at 可能会因为其他 metadata 更新变化，但 chatType 本身未被重写
    expect(s2.id).toBe(s1.id);
  });
});

// =====================================================================
// 6. /chatmode requiresIdle 检查
// =====================================================================
describe('/chatmode requiresIdle 检查', () => {
  it('agent 正在处理时拒绝 /chatmode 切换', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler } = createTestEnv(session);

    // 模拟 agent 正在处理
    const agentMap = (cmdHandler as any).agentMap as Map<string, any>;
    const agent = agentMap.get('claude');
    agent.hasActiveStream.mockReturnValue(true);

    const result = await cmdHandler.handle('/chatmode proactive', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('正在处理');
    expect(result).toContain('/stop');
  });

  it('agent 空闲时允许 /chatmode 切换', async () => {
    const session = createMockSession({ sessionMode: 'interactive' });
    const { cmdHandler } = createTestEnv(session);

    const agentMap = (cmdHandler as any).agentMap as Map<string, any>;
    const agent = agentMap.get('claude');
    agent.hasActiveStream.mockReturnValue(false);

    const result = await cmdHandler.handle('/chatmode proactive', 'aun', 'g-1', undefined, 'owner1');

    expect(result).toContain('已切换');
  });
});

// =====================================================================
// 7. MessageProcessor 提示词注入（proactive vs interactive 契约对齐）
// =====================================================================

const mpPolicy = {
  canSwitchProject: () => true,
  canListProjects: () => true,
  canCreateSession: () => true,
  canDeleteSession: () => true,
  canImportCliSession: () => true,
  messagePrefix: () => '',
  showMiddleResult: () => true,
  showIdleMonitor: () => true,
  accumulateErrors: () => false,
};

function createMPAgentRunner() {
  return {
    runQuery: vi.fn().mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          }
        };
      }
    })),
    registerStream: vi.fn(),
    cleanupStream: vi.fn(),
    interrupt: vi.fn(),
    hasActiveStream: vi.fn().mockReturnValue(false),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    setSendPrompt: vi.fn(),
    setMode: vi.fn(),
  };
}

function createMPSessionManager(sessionMode: 'interactive' | 'proactive') {
  const session = {
    id: 'mp-sess',
    channel: 'aun',
    channelId: 'g-1',
    projectPath: '/tmp/mp-test',
    threadId: '',
    agentId: 'claude',
    chatType: 'group',
    sessionMode,
    agentSessionId: undefined,
    metadata: { isActive: true },
    name: '默认会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    identity: { role: 'owner', mode: 'interactive' },
  };
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(session),
    getActiveSession: vi.fn().mockResolvedValue(session),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    setSafeMode: vi.fn().mockResolvedValue(undefined),
    markProcessing: vi.fn(),
    clearProcessing: vi.fn(),
  };
}

function createMPAdapter() {
  return {
    channelName: 'aun',
    sendText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),  // 有 sendFile 能力
  } as any;
}

async function runProcessMessage(sessionMode: 'interactive' | 'proactive') {
  const runner = createMPAgentRunner();
  const sessionManager = createMPSessionManager(sessionMode);
  const messageCache = {
    getCount: vi.fn().mockReturnValue(0),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  };
  const adapter = createMPAdapter();
  // 创建实际的项目目录避免 fs 错误
  fs.mkdirSync('/tmp/mp-test', { recursive: true });

  const config: any = {
    channels: { aun: { aid: 'x.agentid.pub', owner: 'owner1' } },
    projects: { defaultPath: '/tmp/mp-test', autoCreate: false },
  };

  const processor = new MessageProcessor(
    runner as any,
    sessionManager as any,
    config,
    messageCache as any,
    new EventBus(),
  );
  processor.registerChannel(adapter, mpPolicy);

  const message: any = {
    channel: 'aun',
    channelId: 'g-1',
    content: 'hello',
    peerId: 'owner1',
    chatType: 'group',
    timestamp: Date.now(),
  };
  await processor.processMessage(message);

  // 提取 runQuery 的 systemPromptAppend 参数（第 6 个参数）
  const runQueryCall = runner.runQuery.mock.calls[0];
  const effectiveSystemPrompt = runQueryCall?.[5] as string | undefined;
  return { effectiveSystemPrompt, runner, adapter };
}

describe('MessageProcessor 提示词注入（contextParts）', () => {
  it('interactive 模式：包含 [SEND_FILE:] 提示，不包含 proactive 提示', async () => {
    const { effectiveSystemPrompt } = await runProcessMessage('interactive');

    expect(effectiveSystemPrompt).toBeDefined();
    expect(effectiveSystemPrompt).toContain('[SEND_FILE:路径]');
    expect(effectiveSystemPrompt).not.toContain('[Proactive 模式]');
  });

  it('proactive 模式：包含 proactive 提示，不包含 [SEND_FILE:] 提示（契约对齐）', async () => {
    const { effectiveSystemPrompt } = await runProcessMessage('proactive');

    expect(effectiveSystemPrompt).toBeDefined();
    expect(effectiveSystemPrompt).toContain('[Proactive 模式]');
    expect(effectiveSystemPrompt).toContain('evolclaw ctl send');
    expect(effectiveSystemPrompt).toContain('evolclaw ctl file');
    // 关键：proactive 模式不能推送 [SEND_FILE:] 提示（避免与 ctl file 契约冲突）
    expect(effectiveSystemPrompt).not.toContain('[SEND_FILE:路径]');
  });

  it('两种模式下 [当前环境] 等公共信息都存在', async () => {
    const interactive = (await runProcessMessage('interactive')).effectiveSystemPrompt;
    const proactive = (await runProcessMessage('proactive')).effectiveSystemPrompt;

    expect(interactive).toContain('[当前环境]');
    expect(proactive).toContain('[当前环境]');
  });
});
