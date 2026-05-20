import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBridge } from '../../src/core/message/message-bridge.js';
import type { ChannelAdapter, InboundMessage, ReplyContext, OutboundEnvelope, OutboundPayload } from '../../src/types.js';

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
  cmdHandler: { isCommand: ReturnType<typeof vi.fn>; handle: ReturnType<typeof vi.fn> };
  adapter: ChannelAdapter;
  sendReply: ReturnType<typeof vi.fn>;
  triggerInbound: (msg: InboundMessage) => Promise<void>;
}

/** 构造一个最小的 MessageBridge harness，捕获 adapter.send / sendReply 调用 */
function makeBridge(opts: { adapterSend?: ReturnType<typeof vi.fn> | undefined } = {}): BridgeHarness {
  const cmdHandler = {
    isCommand: vi.fn((s: string) => s.startsWith('/')),
    handle: vi.fn(),
    quickCommandPrefixes: [] as string[],
    execMenu: vi.fn(),
    getMenuItems: vi.fn().mockReturnValue([]),
    getSubMenuItems: vi.fn(),
  };

  const adapter: ChannelAdapter = {
    channelName: 'test-instance',
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
    resolveByChannel: vi.fn().mockReturnValue({ name: 'evol-agent', projectPath: '/tmp/proj', config: {} }),
    setChannelOwner: vi.fn(),
    getOwner: vi.fn().mockReturnValue('peer-1'),
  } as any);

  let registeredHandler: ((m: InboundMessage) => Promise<void>) | undefined;
  const sendReply = vi.fn().mockResolvedValue(undefined);
  bridge.register(
    adapter.channelName,
    (handler) => { registeredHandler = handler; },
    sendReply,
    adapter,
    'test-type'
  );

  return {
    bridge,
    cmdHandler,
    adapter,
    sendReply,
    triggerInbound: async (msg) => { if (registeredHandler) await registeredHandler(msg); },
  };
}

function makeInbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'test-instance',
    channelType: 'test-type',
    channelId: 'chat-1',
    peerId: 'peer-1',
    chatType: 'private',
    content: '/help',
    ...over,
  };
}

describe('MessageBridge — 命令回显走 adapter.send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
