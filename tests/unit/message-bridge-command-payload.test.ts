import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageBridge } from '../../src/core/message/message-bridge.js';
import { ConfigTarget, read, write } from '../../src/config/config-manager.js';
import { formatPeerKey } from '../../src/core/relation/peer-identity.js';
import { _resetRoot } from '../../src/paths.js';
import { _resetSchemaCache } from '../../src/config/schema-registry.js';
import { clearPendingDingtalkContactBinds, registerPendingDingtalkContactBind } from '../../src/channels/dingtalk.js';
import type { AgentConfig, ChannelAdapter, InboundMessage, ReplyContext, OutboundEnvelope, OutboundPayload } from '../../src/types.js';

/**
 * 命令回显改走 adapter.send 统一出站入口的回归测试
 *
 * 覆盖场景：
 *  - cmdHandler 返回 string → 自动包装为 command.result payload
 *  - cmdHandler 返回 { kind: 'command.result', text } → 透传
 *  - cmdHandler 返回 { kind: 'command.error', text } → 透传
 *  - adapter 没实现 send → 降级到 sendReply
 *  - envelope 字段（taskId 前缀 / channel / channelId / chatmode / replyContext）正确填充
 */

interface BridgeHarness {
  bridge: MessageBridge;
  cmdHandler: {
    isCommand: ReturnType<typeof vi.fn>;
    handle: ReturnType<typeof vi.fn>;
    execMenuQuery: ReturnType<typeof vi.fn>;
    execMenuUpdate: ReturnType<typeof vi.fn>;
    execMenuAction: ReturnType<typeof vi.fn>;
    getMenuItems: ReturnType<typeof vi.fn>;
    getSubMenuItems: ReturnType<typeof vi.fn>;
  };
  adapter: ChannelAdapter;
  eventBus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  sendReply: ReturnType<typeof vi.fn>;
  triggerInbound: (msg: InboundMessage) => Promise<void>;
}

const BRIDGE_AID = 'bridge-test.agentid.pub';
const BRIDGE_PEER = 'peer-1';
const oldHome = process.env.EVOLCLAW_HOME;
let tmpRoot: string;

/** 构造一个最小的 MessageBridge harness，捕获 adapter.send / sendReply 调用 */
function makeBridge(opts: {
  adapterSend?: ReturnType<typeof vi.fn> | undefined;
  channelName?: string;
  channelKey?: string;
  channelType?: string;
} = {}): BridgeHarness {
  const channelName = opts.channelName ?? 'test-instance';
  const channelKey = opts.channelKey ?? channelName;
  const channelType = opts.channelType ?? 'test-type';
  const cmdHandler = {
    isCommand: vi.fn((s: string) => s.startsWith('/')),
    handle: vi.fn(),
    quickCommandPrefixes: [] as string[],
    execMenuQuery: vi.fn(),
    execMenuUpdate: vi.fn(),
    execMenuAction: vi.fn(),
    getMenuItems: vi.fn().mockReturnValue([]),
    getSubMenuItems: vi.fn(),
  };

  const adapter: ChannelAdapter = {
    channelName,
    channelKey,
    sendText: vi.fn().mockResolvedValue(undefined),
    ...(opts.adapterSend !== undefined ? { send: opts.adapterSend } : {}),
  };

  const sessionManager = {
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner' }),
  } as any;

  const processor = {
    getChannelInfo: vi.fn((name: string) => name === adapter.channelName ? { adapter } : undefined),
  } as any;

  const messageQueue = {} as any;
  const eventBus = { publish: vi.fn(), subscribe: vi.fn() } as any;

  const bridge = new MessageBridge(
    '/tmp/proj',
    sessionManager,
    processor,
    messageQueue,
    cmdHandler as any,
    eventBus,
    0
  );

  // agentRegistry 是可选注入，命令路径只读 resolveByChannel
  bridge.setAgentRegistry({
    resolveByChannel: vi.fn().mockReturnValue({ aid: BRIDGE_AID, name: 'evol-agent', projectPath: '/tmp/proj', config: {} }),
    setChannelOwner: vi.fn(),
    getOwner: vi.fn().mockReturnValue(BRIDGE_PEER),
  } as any);

  let registeredHandler: ((m: InboundMessage) => Promise<void>) | undefined;
  const sendReply = vi.fn().mockResolvedValue(undefined);
  bridge.register(
    adapter.channelName,
    (handler) => { registeredHandler = handler; },
    sendReply,
    adapter,
    channelType
  );

  return {
    bridge,
    cmdHandler,
    adapter,
    eventBus,
    sendReply,
    triggerInbound: async (msg) => { if (registeredHandler) await registeredHandler(msg); },
  };
}

function makeInbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'test-instance',
    channelType: 'test-type',
    channelId: 'chat-1',
    selfAID: BRIDGE_AID,
    peerId: BRIDGE_PEER,
    chatType: 'private',
    content: '/help',
    ...over,
  };
}

function parseCustomResponse(sendMock: ReturnType<typeof vi.fn>) {
  const [, payload] = sendMock.mock.calls[0] as [OutboundEnvelope, OutboundPayload];
  expect(payload.kind).toBe('custom');
  const value = (payload as any).payload;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

const MEMBER_IDENTITY = { role: 'member', mode: 'interactive' };

describe('MessageBridge — 命令回显走 adapter.send', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-bridge-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    _resetSchemaCache();
    write(ConfigTarget.Agent, {
      aid: BRIDGE_AID,
      owners: ['owner.aid.pub'],
      channels: [],
    }, { self: BRIDGE_AID });
    write(ConfigTarget.Relation, {
      roles: { assigned: 'member' },
    }, { self: BRIDGE_AID, peerKey: formatPeerKey('test-type', BRIDGE_PEER) });
    clearPendingDingtalkContactBinds();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearPendingDingtalkContactBinds();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (oldHome) process.env.EVOLCLAW_HOME = oldHome;
    else delete process.env.EVOLCLAW_HOME;
    _resetRoot();
    _resetSchemaCache();
  });

  it('cmdHandler 返回 string → 包装为 command.result payload', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue('帮助文本');

    await h.triggerInbound(makeInbound({ content: '/help' }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [envelope, payload] = sendMock.mock.calls[0] as [OutboundEnvelope, OutboundPayload];
    expect(payload).toEqual({ kind: 'command.result', text: '帮助文本' });
    expect(envelope.channel).toBe('test-instance');
    expect(envelope.channelId).toBe('chat-1');
    expect(envelope.chatmode).toBe('interactive');
    expect(envelope.taskId).toMatch(/^cmd-[0-9a-f]{10}$/);
    // 兜底 sendReply 不应被调用
    expect(h.sendReply).not.toHaveBeenCalled();
  });

  it('drops transient protocol messages before session creation or handoff binding', async () => {
    const h = makeBridge();
    const getOrCreateSession = vi.fn();
    const bindReply = vi.fn();
    (h.bridge as any).sessionManager.getOrCreateSession = getOrCreateSession;
    h.bridge.setHandoffRuntime({ bindReply } as any);

    await h.triggerInbound(makeInbound({
      content: '[status] processing',
      msgType: 'custom',
      payloadType: 'status.progress',
      messageId: 'transient-status-1',
    }));

    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(bindReply).not.toHaveBeenCalled();
    expect(h.cmdHandler.handle).not.toHaveBeenCalled();
  });

  it('cmdHandler 返回 { kind: command.result } → 透传', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue({ kind: 'command.result', text: '✓ 已切换' });

    await h.triggerInbound(makeInbound({ content: '/p foo' }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendMock.mock.calls[0] as [OutboundEnvelope, OutboundPayload];
    expect(payload).toEqual({ kind: 'command.result', text: '✓ 已切换' });
  });

  it('cmdHandler 返回 { kind: command.error } → 透传', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue({ kind: 'command.error', text: '❌ 未知命令' });

    await h.triggerInbound(makeInbound({ content: '/zzz' }));

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [envelope, payload] = sendMock.mock.calls[0] as [OutboundEnvelope, OutboundPayload];
    expect(payload).toEqual({ kind: 'command.error', text: '❌ 未知命令' });
    expect(envelope.agentName).toBe('evol-agent');
  });

  it('adapter 未实现 send → 降级到 sendReply(text)', async () => {
    const h = makeBridge({ adapterSend: undefined });
    h.cmdHandler.handle.mockResolvedValue({ kind: 'command.result', text: '降级文本' });

    await h.triggerInbound(makeInbound({ content: '/help' }));

    expect(h.sendReply).toHaveBeenCalledTimes(1);
    expect(h.sendReply).toHaveBeenCalledWith('chat-1', '降级文本', undefined);
  });

  it('replyContext 透传到 envelope', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue('ok');

    const replyContext: ReplyContext = { replyToMessageId: 'msg-99', replyInThread: true };
    await h.triggerInbound(makeInbound({ replyContext }));

    const [envelope] = sendMock.mock.calls[0] as [OutboundEnvelope, OutboundPayload];
    expect(envelope.replyContext).toEqual(replyContext);
  });

  it('cmdHandler 返回 undefined → 不命中命令路径，不调 send', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.isCommand.mockReturnValue(true);
    h.cmdHandler.handle.mockResolvedValue(undefined);

    // 当 handle 返回 undefined，bridge 视作"未处理"（让消息走主管线）
    // 但因为 isCommand 已返回 true，主管线会走 session 解析等逻辑——
    // 这里我们只关心 send 没被调用即可
    await h.triggerInbound(makeInbound({ content: '/notacmd' })).catch(() => { /* tolerate downstream errors */ });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('cmdHandler 返回 null → 命令已处理但无回显', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue(null);

    await h.triggerInbound(makeInbound({ content: '/silent' }));
    // null 视为已处理（return true）但不发任何消息
    expect(sendMock).not.toHaveBeenCalled();
    expect(h.sendReply).not.toHaveBeenCalled();
  });

  it('does not auto-bind the first inbound channel peer as owner', async () => {
    write(ConfigTarget.Agent, {
      aid: BRIDGE_AID,
      owners: [],
      channels: [],
    }, { self: BRIDGE_AID });

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.handle.mockResolvedValue('ok');

    await h.triggerInbound(makeInbound({ content: '/help', peerId: BRIDGE_PEER }));

    const saved = read<AgentConfig>(ConfigTarget.Agent, { self: BRIDGE_AID });
    expect(saved?.owners ?? []).toEqual([]);
    expect(h.eventBus.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'channel:owner-bound' }));
  });

  it('matches DingTalk contact bind by full adapter channelKey after channel config is committed', async () => {
    const channelKey = `dingtalk#${BRIDGE_AID}#main`;
    registerPendingDingtalkContactBind({
      selfAid: BRIDGE_AID,
      channelName: channelKey,
      primaryId: 'owner.aid.pub',
      code: '123456',
    });

    const h = makeBridge({
      channelName: 'main',
      channelKey,
      channelType: 'dingtalk',
    });

    await h.triggerInbound(makeInbound({
      channel: 'main',
      channelType: 'dingtalk',
      peerId: 'staff-001',
      content: ' 123456 ',
    }));

    const saved = read<{ contacts?: Record<string, { aliases?: string[] }> }>(ConfigTarget.Contact, { self: BRIDGE_AID });
    expect(saved?.contacts?.['owner.aid.pub']?.aliases).toEqual(['dingtalk:staff-001']);
    expect(h.sendReply).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('钉钉身份绑定成功'),
      undefined,
    );
    expect(h.cmdHandler.handle).not.toHaveBeenCalled();
  });
});

describe('MessageBridge — menu 协议', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-bridge-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    _resetSchemaCache();
    write(ConfigTarget.Agent, {
      aid: BRIDGE_AID,
      owners: ['owner.aid.pub'],
      channels: [],
    }, { self: BRIDGE_AID });
    write(ConfigTarget.Relation, {
      roles: { assigned: 'member' },
    }, { self: BRIDGE_AID, peerKey: formatPeerKey('test-type', BRIDGE_PEER) });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (oldHome) process.env.EVOLCLAW_HOME = oldHome;
    else delete process.env.EVOLCLAW_HOME;
    _resetRoot();
    _resetSchemaCache();
  });

  it('menu.list 返回菜单树', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.getMenuItems.mockReturnValue([{ group: '帮助', commands: [{ cmd: '/help', label: '帮助' }] }]);

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.list', id: 'l1' }) }));

    const response = parseCustomResponse(sendMock);
    expect(response).toEqual({
      type: 'menu.response',
      id: 'l1',
      data: [{ group: '帮助', commands: [{ cmd: '/help', label: '帮助' }] }],
    });
    expect(h.cmdHandler.handle).not.toHaveBeenCalled();
  });

  it('menu.list 按角色调用 getMenuItems', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.getMenuItems.mockReturnValue([]);

    await h.triggerInbound(makeInbound({
      content: JSON.stringify({ type: 'menu.list', id: 'l2' }),
      chatType: 'group',
    }));

    expect(h.cmdHandler.getMenuItems).toHaveBeenCalledWith('member', 'group', 'agent');
  });

  it('menu.list 在控制 channel 使用 control scope', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.getMenuItems.mockReturnValue([]);

    await h.triggerInbound(makeInbound({
      content: JSON.stringify({ type: 'menu.list', id: 'l-control' }),
      isControlChannel: true,
    }));

    expect(h.cmdHandler.getMenuItems).toHaveBeenCalledWith('member', 'private', 'control');
  });

  it('menu.query 通过 name 解析 cmd 并调用 execMenuQuery', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuQuery.mockResolvedValue({ data: { mode: 'interactive' } });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', id: 'q1', name: 'chatmode' }) }));

    expect(h.cmdHandler.execMenuQuery).toHaveBeenCalledWith('/chatmode', 'test-instance', 'chat-1', BRIDGE_PEER, undefined, 'private', false, MEMBER_IDENTITY);
    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'q1',
      name: 'chatmode',
      data: { mode: 'interactive' },
    });
  });

  it('menu.query 通过标准 observable name 路由', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuQuery.mockResolvedValue({ data: { observable: false, source: 'builtin' } });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', id: 'q-observable', name: 'observable' }) }));

    expect(h.cmdHandler.execMenuQuery).toHaveBeenCalledWith('/observable', 'test-instance', 'chat-1', BRIDGE_PEER, undefined, 'private', false, MEMBER_IDENTITY);
    expect(parseCustomResponse(sendMock)).toMatchObject({
      type: 'menu.response',
      id: 'q-observable',
      name: 'observable',
      data: { observable: false, source: 'builtin' },
    });
  });

  it('menu.options 通过 name 解析 cmd 并调用 getSubMenuItems', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.getSubMenuItems.mockResolvedValue([{ value: 'proactive', label: '主动模式' }]);

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.options', id: 'o1', name: 'chatmode' }) }));

    expect(h.cmdHandler.getSubMenuItems).toHaveBeenCalledWith('/chatmode', 'test-instance', 'chat-1', BRIDGE_PEER, undefined, MEMBER_IDENTITY, 'private', false);
    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'o1',
      name: 'chatmode',
      data: [{ value: 'proactive', label: '主动模式' }],
    });
  });

  it('menu.update 写入 value 并返回结构化结果', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuUpdate.mockResolvedValue({ data: { mode: 'proactive' } });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.update', id: 'u1', name: 'chatmode', value: 'proactive' }) }));

    expect(h.cmdHandler.execMenuUpdate).toHaveBeenCalledWith('/chatmode', 'proactive', 'test-instance', 'chat-1', BRIDGE_PEER, MEMBER_IDENTITY, false, undefined);
    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'u1',
      name: 'chatmode',
      data: { mode: 'proactive' },
    });
  });

  it('menu.update 错误透传 code 字段', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuUpdate.mockResolvedValue({ error: '无效模式: invalid', code: 'INVALID_VALUE' });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.update', id: 'u2', name: 'chatmode', value: 'invalid' }) }));

    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'u2',
      name: 'chatmode',
      error: { code: 'INVALID_ARGUMENT', message: '无效模式: invalid' },
    });
  });

  it('menu.action 调用 execMenuAction', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuAction.mockResolvedValue({ data: { action: 'stop', success: true } });

    await h.triggerInbound(makeInbound({
      content: JSON.stringify({ type: 'menu.action', id: 'a1', name: 'session', action: 'stop' }),
      msgType: 'custom',
      payloadType: 'menu.action',
    }));

    expect(h.cmdHandler.execMenuAction).toHaveBeenCalledWith('/session', 'stop', undefined, 'test-instance', 'chat-1', BRIDGE_PEER, MEMBER_IDENTITY, 'private', 'a1', false);
    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'a1',
      name: 'session',
      data: { action: 'stop', success: true },
    });
  });

  it('menu.action 透传 args', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuAction.mockResolvedValue({ data: { action: 'switch', success: true } });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({
      type: 'menu.action', id: 'a2', name: 'session', action: 'switch', args: { target: '前端重构' }
    }) }));

    expect(h.cmdHandler.execMenuAction).toHaveBeenCalledWith(
      '/session', 'switch', { target: '前端重构' }, 'test-instance', 'chat-1', BRIDGE_PEER, MEMBER_IDENTITY, 'private', 'a2', false
    );
  });

  it('menu.options 支持 topic name 映射', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.getSubMenuItems.mockResolvedValue([{ value: 'thread-1', label: '重构讨论' }]);

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.options', id: 'topic-o1', name: 'topic' }) }));

    expect(h.cmdHandler.getSubMenuItems).toHaveBeenCalledWith('/topic', 'test-instance', 'chat-1', BRIDGE_PEER, undefined, MEMBER_IDENTITY, 'private', false);
    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'topic-o1',
      name: 'topic',
      data: [{ value: 'thread-1', label: '重构讨论' }],
    });
  });

  it('menu.query unknown name 返回 NOT_SUPPORTED 错误', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', id: 'q-x', name: 'nonexistent' }) }));

    const response = parseCustomResponse(sendMock);
    expect(response.type).toBe('menu.response');
    expect(response.id).toBe('q-x');
    expect(response.name).toBe('nonexistent');
    expect(response.error.code).toBe('NOT_SUPPORTED');
  });

  it('menu.update 缺少 value 返回 INVALID_ARGUMENT 错误', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.update', id: 'u-x', name: 'chatmode', value: '' }) }));

    const response = parseCustomResponse(sendMock);
    expect(response.error.code).toBe('INVALID_ARGUMENT');
    expect(h.cmdHandler.execMenuUpdate).not.toHaveBeenCalled();
  });

  it('menu.action 缺少 action 返回 INVALID_ARGUMENT 错误', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.action', id: 'a-x', name: 'session', action: '' }) }));

    const response = parseCustomResponse(sendMock);
    expect(response.error.code).toBe('INVALID_ARGUMENT');
    expect(h.cmdHandler.execMenuAction).not.toHaveBeenCalled();
  });

  it('全局鉴权拒绝返回关联 menu.response 且不调用 handler', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    write(ConfigTarget.Relation, { roles: { assigned: null } }, {
      self: BRIDGE_AID,
      peerKey: formatPeerKey('test-type', BRIDGE_PEER),
    });

    await h.triggerInbound(makeInbound({
      content: JSON.stringify({ type: 'menu.action', id: 'denied-1', name: 'cli', action: 'exec', args: { argv: ['status'] } }),
    }));

    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'denied-1',
      name: 'cli',
      error: expect.objectContaining({ code: 'ROLE_ACCESS_DENIED' }),
    });
    expect(h.cmdHandler.execMenuAction).not.toHaveBeenCalled();
    expect(sendMock.mock.calls[0][1]).toMatchObject({ kind: 'custom' });
  });

  it('缺失 id 的 menu 请求静默丢弃且不执行', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', name: 'model' }) }));

    expect(sendMock).not.toHaveBeenCalled();
    expect(h.sendReply).not.toHaveBeenCalled();
    expect(h.cmdHandler.execMenuQuery).not.toHaveBeenCalled();
  });

  it('缺少 name 返回 INVALID_ARGUMENT 且 data/error 互斥', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', id: 'missing-name-1' }) }));

    const response = parseCustomResponse(sendMock);
    expect(response).toEqual({
      type: 'menu.response', id: 'missing-name-1',
      error: { code: 'INVALID_ARGUMENT', message: 'Menu request name is required' },
    });
    expect(response).not.toHaveProperty('data');
    expect(h.cmdHandler.execMenuQuery).not.toHaveBeenCalled();
  });

  it('handler 异常归一化为 INTERNAL_ERROR 并保留 id/name', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuQuery.mockRejectedValue(new Error('boom'));

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.query', id: 'error-1', name: 'model' }) }));

    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response', id: 'error-1', name: 'model',
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('Menu 请求不会触发首次 owner 自动绑定', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    write(ConfigTarget.Agent, { aid: BRIDGE_AID, owners: [], channels: [] }, { self: BRIDGE_AID });
    write(ConfigTarget.Relation, { roles: { assigned: null } }, {
      self: BRIDGE_AID,
      peerKey: formatPeerKey('test-type', BRIDGE_PEER),
    });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.list', id: 'no-bind-1' }) }));

    expect((read(ConfigTarget.Agent, { self: BRIDGE_AID }) as any)?.owners).toEqual([]);
    expect(parseCustomResponse(sendMock).error.code).toBe('ROLE_ACCESS_DENIED');
  });

  it('未知 menu operation 返回 METHOD_NOT_FOUND 且不进入聊天管线', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.future', id: 'future-1', name: 'model' }) }));

    expect(parseCustomResponse(sendMock)).toEqual({
      type: 'menu.response',
      id: 'future-1',
      name: 'model',
      error: { code: 'METHOD_NOT_FOUND', message: 'Unknown menu request type: menu.future' },
    });
    expect(h.cmdHandler.handle).not.toHaveBeenCalled();
  });

  it('相同 scope 和 id 的重复 action 只执行一次并重放响应', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuAction.mockResolvedValue({ data: { stopped: true } });
    const request = makeInbound({ content: JSON.stringify({ type: 'menu.action', id: 'dedup-1', name: 'session', action: 'stop' }) });

    await Promise.all([h.triggerInbound(request), h.triggerInbound(request)]);

    expect(h.cmdHandler.execMenuAction).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(parseCustomResponse(sendMock)).toEqual({ type: 'menu.response', id: 'dedup-1', name: 'session', data: { stopped: true } });
  });

  it('相同 scope 和 id 但 payload 不同返回 CONFLICT', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuAction.mockResolvedValue({ data: { stopped: true } });

    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.action', id: 'conflict-1', name: 'session', action: 'stop' }) }));
    await h.triggerInbound(makeInbound({ content: JSON.stringify({ type: 'menu.action', id: 'conflict-1', name: 'session', action: 'delete' }) }));

    expect(h.cmdHandler.execMenuAction).toHaveBeenCalledTimes(1);
    const [, secondPayload] = sendMock.mock.calls[1] as [OutboundEnvelope, OutboundPayload];
    expect((secondPayload as any).payload.error.code).toBe('CONFLICT');
  });

  it('相同 id 在不同 group scope 独立执行', async () => {
    const sendMock = vi.fn().mockResolvedValue(undefined);
    const h = makeBridge({ adapterSend: sendMock });
    h.cmdHandler.execMenuQuery.mockResolvedValue({ data: { value: 'ok' } });
    const content = JSON.stringify({ type: 'menu.query', id: 'shared-id', name: 'model' });

    await h.triggerInbound(makeInbound({ content, chatType: 'group', channelId: 'group-1', groupId: 'group-1' }));
    await h.triggerInbound(makeInbound({ content, chatType: 'group', channelId: 'group-2', groupId: 'group-2' }));

    expect(h.cmdHandler.execMenuQuery).toHaveBeenCalledTimes(2);
    expect((sendMock.mock.calls[0][0] as OutboundEnvelope).channelId).toBe('group-1');
    expect((sendMock.mock.calls[1][0] as OutboundEnvelope).channelId).toBe('group-2');
  });
});
