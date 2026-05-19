/**
 * Unit tests for the unified interaction payload entrypoint.
 *
 * Covers the migration from `adapter.sendInteraction(...)` direct calls to
 * `adapter.send(envelope, { kind: 'interaction', ... })` for permission
 * requests, AskUserQuestion / ExitPlanMode flows, and CommandHandler cards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildEnvelope,
  defaultFallbackText,
  sendInteractionPayload,
} from '../../src/core/message/message-processor.js';
import { PermissionGateway } from '../../src/core/permission.js';
import type {
  ChannelAdapter,
  InteractionRequest,
  OutboundEnvelope,
  OutboundPayload,
  CommandCard,
  ActionInteraction,
} from '../../src/types.js';

function makeActionInteraction(over: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    type: 'interaction',
    id: 'req-1',
    channelId: 'chan-1',
    sessionId: 'sess-1',
    kind: {
      kind: 'action',
      title: '🔐 权限请求',
      body: '工具：Bash\n操作：rm -rf /tmp/x',
      buttons: [
        { key: 'allow', label: '✅ 允许', style: 'primary' },
        { key: 'deny', label: '❌ 拒绝', style: 'danger' },
      ],
    } as ActionInteraction,
    fallback: { command: 'perm' },
    ...over,
  };
}

function makeCommandCard(over: Partial<InteractionRequest> = {}): InteractionRequest {
  const card: CommandCard = {
    kind: 'command-card',
    title: '📋 三选一',
    body: '请选择',
    buttons: [
      { label: 'a', command: '/x a', style: 'default' },
      { label: 'b', command: '/x b', style: 'primary' },
    ],
  };
  return {
    type: 'interaction',
    id: 'card-1',
    channelId: 'chan-1',
    sessionId: 'sess-1',
    kind: card,
    ...over,
  };
}

describe('outbound-envelope helpers', () => {
  describe('buildEnvelope', () => {
    it('fills required envelope fields with sensible defaults', () => {
      const env = buildEnvelope({ channel: 'feishu', channelId: 'chat-1' });
      expect(env.channel).toBe('feishu');
      expect(env.channelId).toBe('chat-1');
      expect(env.chatmode).toBe('interactive');
      expect(env.agentName).toBe('<unknown>');
      expect(typeof env.taskId).toBe('string');
      expect(env.taskId.length).toBeGreaterThan(0);
      expect(typeof env.timestamp).toBe('number');
    });

    it('respects explicit fields when provided', () => {
      const env = buildEnvelope({
        taskId: 't-1',
        channel: 'aun',
        channelId: 'a@b',
        agentName: 'review-bot',
        chatmode: 'proactive',
        replyContext: { replyToMessageId: 'm-7' },
      });
      expect(env).toMatchObject({
        taskId: 't-1',
        channel: 'aun',
        channelId: 'a@b',
        agentName: 'review-bot',
        chatmode: 'proactive',
        replyContext: { replyToMessageId: 'm-7' },
      });
    });
  });

  describe('defaultFallbackText', () => {
    it('renders ActionInteraction with fallback command into text', () => {
      const text = defaultFallbackText(makeActionInteraction());
      expect(text).toContain('🔐 权限请求');
      expect(text).toContain('/perm');
    });

    it('renders CommandCard into a command list', () => {
      const text = defaultFallbackText(makeCommandCard());
      expect(text).toContain('📋 三选一');
      expect(text).toContain('/x a');
      expect(text).toContain('/x b');
    });
  });
});

describe('sendInteractionPayload', () => {
  let envelope: OutboundEnvelope;

  beforeEach(() => {
    envelope = buildEnvelope({ channel: 'feishu', channelId: 'chat-1' });
  });

  it('routes through adapter.send with kind=interaction when available', async () => {
    const send = vi.fn(async (_env: OutboundEnvelope, _payload: OutboundPayload) => {});
    const adapter: ChannelAdapter = {
      channelName: 'feishu',
      sendText: vi.fn(async () => {}),
      send,
    };

    const interaction = makeActionInteraction();
    const result = await sendInteractionPayload(adapter, envelope, interaction, 'fb-text');

    expect(result).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const [calledEnv, calledPayload] = send.mock.calls[0];
    expect(calledEnv.channel).toBe('feishu');
    expect(calledEnv.channelId).toBe('chat-1');
    expect(calledPayload).toEqual({
      kind: 'interaction',
      interaction,
      fallbackText: 'fb-text',
    });
  });

  it('uses defaultFallbackText when caller omits fallback', async () => {
    const send = vi.fn(async () => {});
    const adapter: ChannelAdapter = {
      channelName: 'feishu',
      sendText: vi.fn(async () => {}),
      send,
    };

    const card = makeCommandCard();
    await sendInteractionPayload(adapter, envelope, card);

    const [, payload] = send.mock.calls[0];
    expect(payload.kind).toBe('interaction');
    expect((payload as any).fallbackText).toContain('📋 三选一');
  });

  it('falls back to adapter.sendInteraction when send is missing', async () => {
    const sendInteraction = vi.fn(async () => 'msg-id-123');
    const adapter: ChannelAdapter = {
      channelName: 'wechat',
      sendText: vi.fn(async () => {}),
      sendInteraction,
    };

    const interaction = makeActionInteraction();
    const result = await sendInteractionPayload(adapter, envelope, interaction, 'fb');

    expect(result).toBe('msg-id-123');
    expect(sendInteraction).toHaveBeenCalledWith('chat-1', interaction, undefined);
  });

  it('falls back to adapter.sendInteraction when send throws', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const sendInteraction = vi.fn(async () => 'msg-id-456');
    const adapter: ChannelAdapter = {
      channelName: 'qqbot',
      sendText: vi.fn(async () => {}),
      send,
      sendInteraction,
    };

    const interaction = makeActionInteraction();
    const result = await sendInteractionPayload(adapter, envelope, interaction, 'fb');

    expect(result).toBe('msg-id-456');
    expect(sendInteraction).toHaveBeenCalledTimes(1);
  });

  it('returns false when neither send nor sendInteraction is implemented', async () => {
    const adapter: ChannelAdapter = {
      channelName: 'plain',
      sendText: vi.fn(async () => {}),
    };
    const result = await sendInteractionPayload(adapter, envelope, makeActionInteraction(), 'fb');
    expect(result).toBe(false);
  });

  it('passes replyCtx into adapter.send via enriched envelope', async () => {
    const send = vi.fn(async () => {});
    const adapter: ChannelAdapter = {
      channelName: 'feishu',
      sendText: vi.fn(async () => {}),
      send,
    };
    const replyCtx = { replyToMessageId: 'omg-42' };
    await sendInteractionPayload(adapter, envelope, makeActionInteraction(), 'fb', replyCtx);
    const [calledEnv] = send.mock.calls[0];
    expect(calledEnv.replyContext).toEqual(replyCtx);
  });
});

describe('PermissionGateway.requestPermission integration', () => {
  it('triggers adapter.send with interaction payload (preferred path)', async () => {
    const gateway = new PermissionGateway();
    const send = vi.fn(async () => {});
    const adapter: ChannelAdapter = {
      channelName: 'feishu',
      sendText: vi.fn(async () => {}),
      send,
    };
    const sendPrompt = vi.fn(async () => {});

    // Don't await — requestPermission only resolves when user replies. We
    // just want to verify adapter.send was invoked synchronously.
    const promise = gateway.requestPermission(
      'sess-x',
      'Bash',
      { command: 'echo hi' },
      sendPrompt,
      {
        adapter,
        channelId: 'chat-x',
        channel: 'feishu',
        agentName: 'review-bot',
        taskId: 't-1',
        chatmode: 'interactive',
      },
      'echo hi',
    );

    // Yield to let the async send call run
    await new Promise((r) => setTimeout(r, 0));

    expect(send).toHaveBeenCalledTimes(1);
    const [env, payload] = send.mock.calls[0];
    expect(env.channel).toBe('feishu');
    expect(env.taskId).toBe('t-1');
    expect(env.agentName).toBe('review-bot');
    expect(payload.kind).toBe('interaction');
    expect((payload as any).interaction.kind.kind).toBe('action');
    expect((payload as any).interaction.kind.title).toContain('🔐');
    expect((payload as any).fallbackText).toContain('🔐');
    expect((payload as any).fallbackText).toContain('Bash');
    expect(sendPrompt).not.toHaveBeenCalled();

    // Cleanup: reject the request so the dangling promise resolves
    const pending = gateway.getPendingRequests('sess-x');
    expect(pending.length).toBe(1);
    gateway.resolvePermission('sess-x', pending[0], 'deny');
    await promise;
  });

  it('falls back to sendPrompt when adapter has no send / sendInteraction', async () => {
    const gateway = new PermissionGateway();
    const sendPrompt = vi.fn(async () => {});
    const adapter: ChannelAdapter = {
      channelName: 'plain',
      sendText: vi.fn(async () => {}),
    };

    const promise = gateway.requestPermission(
      'sess-y',
      'Read',
      { file_path: '/etc/passwd' },
      sendPrompt,
      { adapter, channelId: 'chat-y', channel: 'plain' },
      '/etc/passwd',
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const [text] = sendPrompt.mock.calls[0];
    expect(text).toContain('🔐 权限请求');

    const pending = gateway.getPendingRequests('sess-y');
    gateway.resolvePermission('sess-y', pending[0], 'allow');
    await promise;
  });

  it('falls back to legacy adapter.sendInteraction when adapter.send absent', async () => {
    const gateway = new PermissionGateway();
    const sendPrompt = vi.fn(async () => {});
    const sendInteraction = vi.fn(async () => 'card-msg');
    const adapter: ChannelAdapter = {
      channelName: 'wechat',
      sendText: vi.fn(async () => {}),
      sendInteraction,
    };

    const promise = gateway.requestPermission(
      'sess-z',
      'Bash',
      { command: 'ls' },
      sendPrompt,
      { adapter, channelId: 'u-1', channel: 'wechat' },
      'ls',
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(sendInteraction).toHaveBeenCalledTimes(1);
    const [chid, interaction, replyCtx] = sendInteraction.mock.calls[0];
    expect(chid).toBe('u-1');
    expect((interaction as any).kind.kind).toBe('action');
    // sendPrompt should NOT have been called when sendInteraction succeeds
    expect(sendPrompt).not.toHaveBeenCalled();

    const pending = gateway.getPendingRequests('sess-z');
    gateway.resolvePermission('sess-z', pending[0], 'always');
    await promise;
  });
});
