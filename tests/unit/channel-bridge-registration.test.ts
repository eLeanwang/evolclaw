import { describe, it, expect, vi } from 'vitest';
import type { MessageBridge } from '../../src/core/message/message-bridge.js';
import type { BridgeHookContext } from '../../src/core/channel-loader.js';
import type { InboundMessage, ReplyContext } from '../../src/types.js';

/**
 * Creates a mock MessageBridge that captures register() arguments.
 * After registerBridge is called, use triggerInbound(channel, ...args) to simulate
 * a channel message and get the resulting InboundMessage.
 */
function createMockBridge() {
  let onMessageAdapter: ((handler: (msg: InboundMessage) => Promise<void>) => void) | undefined;
  let sendReplyFn: ((channelId: string, text: string, ctx?: ReplyContext) => Promise<void>) | undefined;
  let regChannelName: string | undefined;
  let regChannelType: string | undefined;

  const bridge = {
    register: vi.fn((channelName, onMessage, sendReply, _adapter, channelType) => {
      regChannelName = channelName;
      onMessageAdapter = onMessage;
      sendReplyFn = sendReply;
      regChannelType = channelType;
    }),
  } as unknown as MessageBridge;

  async function triggerInbound(channel: any, ...nativeArgs: any[]): Promise<InboundMessage> {
    let captured: InboundMessage | undefined;
    onMessageAdapter!(async (msg) => { captured = msg; });
    const wrappedFn = channel.onMessage.mock.calls[0][0];
    await wrappedFn(...nativeArgs);
    return captured!;
  }

  return {
    bridge,
    triggerInbound,
    get channelName() { return regChannelName; },
    get channelType() { return regChannelType; },
    get sendReply() { return sendReplyFn; },
  };
}

function createMockHookContext() {
  return {
    eventBus: { publish: vi.fn() },
    sessionManager: { getActiveSession: vi.fn().mockResolvedValue(undefined) },
  } as unknown as BridgeHookContext & {
    eventBus: { publish: ReturnType<typeof vi.fn> };
    sessionManager: { getActiveSession: ReturnType<typeof vi.fn> };
  };
}

// ── Feishu ──────────────────────────────────────────────────────────────────

describe('Feishu registerBridge', () => {
  function buildFeishuRegisterBridge(channel: any, adapterName: string) {
    const adapter = { channelName: adapterName } as any;
    return function registerBridge(bridge: MessageBridge, channelType: string) {
      bridge.register(
        adapter.channelName,
        (handler) => channel.onMessage(async ({ channelId: chatId, content, images, peerId, peerName, messageId, mentions, threadId, rootId, chatType }: any) => {
          await handler({
            channel: adapter.channelName, channelType, channelId: chatId, content, images, chatType,
            peerId: peerId || '', peerName, messageId, mentions, threadId,
            replyContext: threadId ? { replyToMessageId: rootId ?? threadId, replyInThread: true } : undefined,
          });
        }),
        (channelId, text, replyContext) => channel.sendMessage(channelId, text, {
          replyToMessageId: replyContext?.replyToMessageId,
          replyInThread: replyContext?.replyInThread,
        }),
        adapter,
        channelType
      );
    };
  }

  it('registers with correct channelName and channelType', () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    expect(mock.channelName).toBe('feishu-main');
    expect(mock.channelType).toBe('feishu');
  });

  it('maps native event with replyContext when threadId present', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    const msg = await mock.triggerInbound(channel, {
      channelId: 'chat-1', content: 'hello', images: undefined,
      peerId: 'user-1', peerName: 'Alice', messageId: 'msg-1',
      mentions: [{ userId: 'u1' }], threadId: 'thread-1', rootId: 'root-1', chatType: 'group',
    });

    expect(msg.channel).toBe('feishu-main');
    expect(msg.channelType).toBe('feishu');
    expect(msg.channelId).toBe('chat-1');
    expect(msg.peerId).toBe('user-1');
    expect(msg.chatType).toBe('group');
    expect(msg.replyContext).toEqual({ replyToMessageId: 'root-1', replyInThread: true });
  });

  it('uses threadId as replyToMessageId when rootId is absent', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    const msg = await mock.triggerInbound(channel, {
      channelId: 'c1', content: 'hi', peerId: 'u1',
      threadId: 'thread-1', rootId: undefined, chatType: 'private',
    });

    expect(msg.replyContext).toEqual({ replyToMessageId: 'thread-1', replyInThread: true });
  });

  it('does NOT set replyContext when threadId is absent', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    const msg = await mock.triggerInbound(channel, {
      channelId: 'c1', content: 'hi', peerId: 'u1',
      threadId: undefined, rootId: 'root-1', chatType: 'private',
    });

    expect(msg.replyContext).toBeUndefined();
  });

  it('defaults peerId to empty string', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    const msg = await mock.triggerInbound(channel, {
      channelId: 'c1', content: 'hi', peerId: undefined, chatType: 'private',
    });

    expect(msg.peerId).toBe('');
  });

  it('sendReply passes replyContext to channel.sendMessage', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined) };
    const mock = createMockBridge();
    buildFeishuRegisterBridge(channel, 'feishu-main')(mock.bridge, 'feishu');

    await mock.sendReply!('chat-1', 'resp', { replyToMessageId: 'msg-1', replyInThread: true });

    expect(channel.sendMessage).toHaveBeenCalledWith('chat-1', 'resp', {
      replyToMessageId: 'msg-1', replyInThread: true,
    });
  });
});

// ── WeChat ──────────────────────────────────────────────────────────────────

describe('WeChat registerBridge', () => {
  function buildWechatRegisterBridge(channel: any, adapterName: string) {
    const adapter = { channelName: adapterName } as any;
    return function registerBridge(bridge: MessageBridge, channelType: string) {
      bridge.register(
        adapter.channelName,
        (handler) => channel.onMessage(async (channelId: string, content: string, peerId?: string,
          images?: Array<{ data: string; mimeType: string }>, chatType?: 'private' | 'group') => {
          handler({ channel: adapter.channelName, channelType, channelId, content, images, chatType: chatType || 'private', peerId: peerId || '' });
        }),
        (channelId, text) => channel.sendMessage(channelId, text),
        adapter, channelType
      );
    };
  }

  it('maps positional args to InboundMessage', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildWechatRegisterBridge(channel, 'wechat-main')(mock.bridge, 'wechat');

    const msg = await mock.triggerInbound(channel, 'chat-wx', 'hi', 'peer-1', undefined, 'group');

    expect(msg.channel).toBe('wechat-main');
    expect(msg.channelType).toBe('wechat');
    expect(msg.channelId).toBe('chat-wx');
    expect(msg.content).toBe('hi');
    expect(msg.peerId).toBe('peer-1');
    expect(msg.chatType).toBe('group');
  });

  it('defaults chatType to private and peerId to empty', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildWechatRegisterBridge(channel, 'wechat-main')(mock.bridge, 'wechat');

    const msg = await mock.triggerInbound(channel, 'ch', 'msg', undefined, undefined, undefined);

    expect(msg.chatType).toBe('private');
    expect(msg.peerId).toBe('');
  });
});

// ── AUN ─────────────────────────────────────────────────────────────────────

describe('AUN registerBridge', () => {
  function buildAunRegisterBridge(channel: any, adapterName: string) {
    const adapter = { channelName: adapterName } as any;
    return function registerBridge(bridge: MessageBridge, channelType: string) {
      bridge.register(
        adapter.channelName,
        (handler) => channel.onMessage(async (opts: any) => {
          handler({
            channel: adapter.channelName, channelType,
            channelId: opts.channelId, selfId: opts.selfId, groupId: opts.groupId,
            content: opts.content, chatType: opts.chatType || 'private',
            peerId: opts.peerId || '', peerName: opts.peerName,
            messageId: opts.messageId, mentions: opts.mentions,
            threadId: opts.threadId, replyContext: opts.replyContext,
          });
        }),
        (channelId, text, replyContext) => channel.sendMessage(channelId, text, replyContext),
        adapter, channelType
      );
    };
  }

  it('maps opts to InboundMessage with all fields', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildAunRegisterBridge(channel, 'aun-bot')(mock.bridge, 'aun');

    const msg = await mock.triggerInbound(channel, {
      channelId: 'ch-1', selfId: 'self.agentid.pub', groupId: 'grp-1',
      content: 'test', chatType: 'group', peerId: 'peer.agentid.pub', peerName: 'Peer',
      messageId: 'mid-1', mentions: [{ userId: 'u1' }],
      threadId: 'tid-1', replyContext: { replyToMessageId: 'rm-1' },
    });

    expect(msg.channel).toBe('aun-bot');
    expect(msg.channelType).toBe('aun');
    expect(msg.selfId).toBe('self.agentid.pub');
    expect(msg.groupId).toBe('grp-1');
    expect(msg.chatType).toBe('group');
    expect(msg.peerId).toBe('peer.agentid.pub');
    expect(msg.replyContext).toEqual({ replyToMessageId: 'rm-1' });
  });

  it('defaults chatType and peerId', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
    const mock = createMockBridge();
    buildAunRegisterBridge(channel, 'aun-bot')(mock.bridge, 'aun');

    const msg = await mock.triggerInbound(channel, { channelId: 'ch-1', content: 'hi' });

    expect(msg.chatType).toBe('private');
    expect(msg.peerId).toBe('');
  });

  it('sendReply passes replyContext through', async () => {
    const channel = { onMessage: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined) };
    const mock = createMockBridge();
    buildAunRegisterBridge(channel, 'aun-bot')(mock.bridge, 'aun');

    const ctx: ReplyContext = { replyToMessageId: 'rm-1' };
    await mock.sendReply!('ch-1', 'reply', ctx);

    expect(channel.sendMessage).toHaveBeenCalledWith('ch-1', 'reply', ctx);
  });
});

// ── AUN registerHooks ───────────────────────────────────────────────────────

describe('AUN registerHooks', () => {
  function buildAunRegisterHooks(channel: any, adapterName: string) {
    const adapter = { channelName: adapterName } as any;
    return function registerHooks(ctx: BridgeHookContext) {
      channel.setEventBus(ctx.eventBus);
      if (channel.setOnChannelDown) {
        channel.setOnChannelDown(() => {
          (ctx.eventBus as any).publish({
            type: 'channel:health', channel: 'aun', channelName: adapter.channelName,
            status: 'auth_error',
            message: `AUN ${adapter.channelName} disconnected`,
            timestamp: Date.now(),
          });
        });
      }
      if (typeof channel.setSessionModeResolver === 'function') {
        channel.setSessionModeResolver(async (channelId: string) => {
          const session = await (ctx.sessionManager as any).getActiveSession(adapter.channelName, channelId);
          return session?.sessionMode;
        });
      }
    };
  }

  it('calls setEventBus', () => {
    const channel = { setEventBus: vi.fn(), setOnChannelDown: vi.fn(), setSessionModeResolver: vi.fn() };
    const ctx = createMockHookContext();
    buildAunRegisterHooks(channel, 'aun-bot')(ctx);

    expect(channel.setEventBus).toHaveBeenCalledWith(ctx.eventBus);
  });

  it('registers channelDown callback that publishes health event', () => {
    const channel = { setEventBus: vi.fn(), setOnChannelDown: vi.fn(), setSessionModeResolver: vi.fn() };
    const ctx = createMockHookContext();
    buildAunRegisterHooks(channel, 'aun-bot')(ctx);

    const cb = channel.setOnChannelDown.mock.calls[0][0];
    cb();

    expect(ctx.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'channel:health', channel: 'aun', channelName: 'aun-bot', status: 'auth_error',
    }));
  });

  it('sessionModeResolver queries sessionManager', async () => {
    const channel = { setEventBus: vi.fn(), setOnChannelDown: vi.fn(), setSessionModeResolver: vi.fn() };
    const ctx = createMockHookContext();
    ctx.sessionManager.getActiveSession.mockResolvedValue({ sessionMode: 'proactive' });
    buildAunRegisterHooks(channel, 'aun-bot')(ctx);

    const resolver = channel.setSessionModeResolver.mock.calls[0][0];
    const mode = await resolver('ch-1');

    expect(ctx.sessionManager.getActiveSession).toHaveBeenCalledWith('aun-bot', 'ch-1');
    expect(mode).toBe('proactive');
  });
});

// ── Standard channels (dingtalk/qqbot/wecom) ────────────────────────────────

describe('Standard channel registerBridge (dingtalk/qqbot/wecom)', () => {
  function buildStandardRegisterBridge(channel: any, adapterName: string) {
    const adapter = { channelName: adapterName } as any;
    return function registerBridge(bridge: MessageBridge, channelType: string) {
      bridge.register(
        adapter.channelName,
        (handler) => channel.onMessage(async (event: any) => {
          handler({
            channel: adapter.channelName, channelType,
            channelId: event.channelId, content: event.content, images: event.images,
            chatType: event.chatType || 'private', peerId: event.peerId || '',
            peerName: event.peerName, messageId: event.messageId,
          });
        }),
        (channelId, text) => channel.sendMessage(channelId, text),
        adapter, channelType
      );
    };
  }

  for (const type of ['dingtalk', 'qqbot', 'wecom'] as const) {
    describe(type, () => {
      it('maps event to InboundMessage', async () => {
        const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
        const mock = createMockBridge();
        buildStandardRegisterBridge(channel, `${type}-main`)(mock.bridge, type);

        const msg = await mock.triggerInbound(channel, {
          channelId: 'ch-1', content: 'hello',
          images: [{ data: 'b64', mimeType: 'image/png' }],
          chatType: 'group', peerId: 'p-1', peerName: 'Bob', messageId: 'mid-1',
        });

        expect(msg.channel).toBe(`${type}-main`);
        expect(msg.channelType).toBe(type);
        expect(msg.channelId).toBe('ch-1');
        expect(msg.content).toBe('hello');
        expect(msg.chatType).toBe('group');
        expect(msg.peerId).toBe('p-1');
        expect(msg.peerName).toBe('Bob');
        expect(msg.messageId).toBe('mid-1');
      });

      it('defaults chatType and peerId', async () => {
        const channel = { onMessage: vi.fn(), sendMessage: vi.fn() };
        const mock = createMockBridge();
        buildStandardRegisterBridge(channel, `${type}-main`)(mock.bridge, type);

        const msg = await mock.triggerInbound(channel, { channelId: 'ch-1', content: 'hi' });

        expect(msg.chatType).toBe('private');
        expect(msg.peerId).toBe('');
      });
    });
  }
});

