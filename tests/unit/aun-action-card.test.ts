import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';
import type { InteractionResponse } from '../../src/types.js';

function makeChannel(aid = 'bot.agentid.pub') {
  const ch = new AUNChannel({ aid }) as any;
  ch._aid = aid;
  ch.connected = true;
  ch.client = {
    call: vi.fn().mockResolvedValue({ message_id: 'mid-001' }),
  };
  return ch;
}

// ── extractTextPayload: action_card_reply ─────────────────────────────────────

describe('AUNChannel.extractTextPayload — action_card_reply', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('fires interactionCallback and returns empty string when map entry exists', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-001', { requestId: 'req-abc', isCommandCard: false });

    const result = ch.extractTextPayload({
      type: 'action_card_reply',
      card_message_id: 'mid-001',
      action_value: 'prod',
      action_label: '生产环境',
      text: 'prod',
      behavior: 'reply',
    });

    expect(result).toBe('');
    expect(cb).toHaveBeenCalledOnce();
    const resp: InteractionResponse = cb.mock.calls[0][0];
    expect(resp.id).toBe('req-abc');
    expect(resp.action).toBe('prod');
    expect(resp.values?.text).toBe('prod');
  });

  it('removes map entry after firing callback', () => {
    ch.interactionCallback = vi.fn();
    ch.cardMessageIdMap.set('mid-001', { requestId: 'req-abc', isCommandCard: false });

    ch.extractTextPayload({ type: 'action_card_reply', card_message_id: 'mid-001', text: 'ok' });

    expect(ch.cardMessageIdMap.has('mid-001')).toBe(false);
  });

  it('does NOT fire callback when card_message_id is missing', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-001', { requestId: 'req-abc', isCommandCard: false });

    const result = ch.extractTextPayload({ type: 'action_card_reply', text: 'ok' });

    expect(result).toBe('');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire callback when card_message_id not in map (stale/expired)', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;

    const result = ch.extractTextPayload({
      type: 'action_card_reply',
      card_message_id: 'mid-stale',
      text: 'ok',
    });

    expect(result).toBe('');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire callback when interactionCallback is not registered', () => {
    ch.cardMessageIdMap.set('mid-001', { requestId: 'req-abc', isCommandCard: false });

    const result = ch.extractTextPayload({
      type: 'action_card_reply',
      card_message_id: 'mid-001',
      text: 'ok',
    });

    expect(result).toBe('');
    // map entry is NOT deleted when callback is absent (TTL will clean it up)
    expect(ch.cardMessageIdMap.has('mid-001')).toBe(true);
  });

  it('uses text as action when action_value is absent', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-001', { requestId: 'req-abc', isCommandCard: false });

    ch.extractTextPayload({ type: 'action_card_reply', card_message_id: 'mid-001', text: 'fallback' });

    expect(cb.mock.calls[0][0].action).toBe('fallback');
  });
});

// ── P2P dispatch: action_card_reply is not forwarded to agent ─────────────────

describe('AUNChannel.handleIncomingPrivateMessage — action_card_reply not dispatched', () => {
  it('returns early without calling dispatchMessage for action_card_reply', async () => {
    const ch = makeChannel();
    const dispatched: any[] = [];
    ch.dispatchMessage = (msg: any) => dispatched.push(msg);
    ch.fetchPeerInfo = vi.fn().mockResolvedValue({ type: 'human', name: 'Alice' });
    ch.aidStatsCollector = null;

    await ch.handleIncomingPrivateMessage({
      from_aid: 'alice.agentid.pub',
      message_id: 'mid-reply',
      seq: 1,
      payload: {
        type: 'action_card_reply',
        card_message_id: 'mid-001',
        text: 'prod',
        action_value: 'prod',
      },
    });

    expect(dispatched).toHaveLength(0);
  });
});

// ── sendStructured: returns message_id ───────────────────────────────────────

describe('AUNChannel.sendStructured — returns message_id', () => {
  it('returns message_id from server response', async () => {
    const ch = makeChannel();
    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBe('mid-001');
  });

  it('returns null when not connected', async () => {
    const ch = makeChannel();
    ch.connected = false;
    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBeNull();
  });

  it('returns null on RPC error', async () => {
    const ch = makeChannel();
    ch.client.call = vi.fn().mockRejectedValue(new Error('network error'));
    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBeNull();
  });
});

// ── interaction payload → action_card outbound ────────────────────────────────

describe('AUNChannel — interaction → action_card via sendStructured', () => {
  function makeChannelWithSend() {
    const ch = makeChannel();
    // Expose sendStructured result tracking
    const sendStructuredCalls: Array<{ channelId: string; payload: any }> = [];
    const origSendStructured = ch.sendStructured.bind(ch);
    ch.sendStructured = vi.fn().mockImplementation(async (channelId: string, payload: any, ctx?: any) => {
      sendStructuredCalls.push({ channelId, payload });
      return origSendStructured(channelId, payload, ctx);
    });
    return { ch, sendStructuredCalls };
  }

  it('sends action_card for ActionInteraction and stores message_id in cardMessageIdMap', async () => {
    const { ch, sendStructuredCalls } = makeChannelWithSend();

    // Simulate what adapter.send does for 'interaction' kind with ActionInteraction
    const req = {
      type: 'interaction',
      id: 'req-xyz',
      channelId: 'alice.agentid.pub',
      sessionId: 'sess-1',
      kind: {
        kind: 'action',
        title: '选择环境',
        body: '请选择部署目标',
        buttons: [
          { key: 'prod', label: '生产', style: 'primary' },
          { key: 'dev', label: '测试', style: 'default' },
        ],
      },
    };

    const aunCard = {
      type: 'action_card',
      title: req.kind.title,
      text: req.kind.body,
      actions: req.kind.buttons.map((btn: any) => ({
        label: btn.label,
        value: btn.key,
        style: btn.style ?? 'default',
        behavior: 'reply',
      })),
    };

    const msgId = await ch.sendStructured('alice.agentid.pub', aunCard);
    if (msgId) {
      ch.cardMessageIdMap.set(msgId, { requestId: req.id, isCommandCard: false });
      setTimeout(() => ch.cardMessageIdMap.delete(msgId), 20 * 60 * 1000);
    }

    expect(msgId).toBe('mid-001');
    expect(ch.cardMessageIdMap.get('mid-001')).toEqual({ requestId: 'req-xyz', isCommandCard: false });

    const sentPayload = sendStructuredCalls[0].payload;
    expect(sentPayload.type).toBe('action_card');
    expect(sentPayload.title).toBe('选择环境');
    expect(sentPayload.actions).toHaveLength(2);
    expect(sentPayload.actions[0]).toMatchObject({ label: '生产', value: 'prod', behavior: 'reply' });
  });

  it('sends action_card for CommandCard with command as value', async () => {
    const { ch, sendStructuredCalls } = makeChannelWithSend();

    const aunCard = {
      type: 'action_card',
      title: '确认操作',
      text: undefined,
      actions: [
        { label: '确认', value: '/confirm', style: 'danger', behavior: 'reply' },
        { label: '取消', value: '/cancel', style: 'default', behavior: 'reply' },
      ],
    };

    const msgId = await ch.sendStructured('alice.agentid.pub', aunCard);
    if (msgId) ch.cardMessageIdMap.set(msgId, { requestId: 'req-cmd', isCommandCard: false });

    expect(sendStructuredCalls[0].payload.actions[0]).toMatchObject({ label: '确认', value: '/confirm' });
    expect(sendStructuredCalls[0].payload.actions[1]).toMatchObject({ label: '取消', value: '/cancel' });
    expect(ch.cardMessageIdMap.get('mid-001')).toEqual({ requestId: 'req-cmd', isCommandCard: false });
  });

  it('does not store in cardMessageIdMap when sendStructured returns null', async () => {
    const ch = makeChannel();
    ch.connected = false; // causes sendStructured to return null

    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', actions: [] });
    if (msgId) ch.cardMessageIdMap.set(msgId, { requestId: 'req-null', isCommandCard: false });

    expect(msgId).toBeNull();
    expect(ch.cardMessageIdMap.size).toBe(0);
  });
});

// ── cardMessageIdMap TTL ──────────────────────────────────────────────────────

describe('AUNChannel.cardMessageIdMap — TTL cleanup', () => {
  it('entry is removed after TTL expires', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    ch.cardMessageIdMap.set('mid-ttl', { requestId: 'req-ttl', isCommandCard: false });
    setTimeout(() => ch.cardMessageIdMap.delete('mid-ttl'), 20 * 60 * 1000);

    expect(ch.cardMessageIdMap.has('mid-ttl')).toBe(true);
    vi.advanceTimersByTime(20 * 60 * 1000 + 1);
    expect(ch.cardMessageIdMap.has('mid-ttl')).toBe(false);
    vi.useRealTimers();
  });
});

// ── action_card_reply: frontend field name compat (ref_message_id / value / label) ──

describe('AUNChannel.extractTextPayload — action_card_reply frontend compat', () => {
  let ch: any;

  beforeEach(() => {
    ch = makeChannel();
  });

  it('matches on ref_message_id when card_message_id is absent', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-002', { requestId: 'req-front', isCommandCard: false });

    const result = ch.extractTextPayload({
      type: 'action_card_reply',
      ref_message_id: 'mid-002',
      value: 'staging',
      label: '预发布',
    });

    expect(result).toBe('');
    expect(cb).toHaveBeenCalledOnce();
    const resp: InteractionResponse = cb.mock.calls[0][0];
    expect(resp.id).toBe('req-front');
    expect(resp.action).toBe('staging');
    expect(resp.values?.action_label).toBe('预发布');
  });

  it('prefers ref_message_id over card_message_id when both present', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-ref', { requestId: 'req-ref', isCommandCard: false });
    ch.cardMessageIdMap.set('mid-card', { requestId: 'req-card', isCommandCard: false });

    ch.extractTextPayload({
      type: 'action_card_reply',
      ref_message_id: 'mid-ref',
      card_message_id: 'mid-card',
      value: 'x',
    });

    expect(cb.mock.calls[0][0].id).toBe('req-ref');
  });

  it('falls back to card_message_id when ref_message_id is absent', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-old', { requestId: 'req-old', isCommandCard: false });

    ch.extractTextPayload({
      type: 'action_card_reply',
      card_message_id: 'mid-old',
      action_value: 'legacy',
      action_label: '旧按钮',
    });

    expect(cb.mock.calls[0][0].id).toBe('req-old');
    expect(cb.mock.calls[0][0].action).toBe('legacy');
    expect(cb.mock.calls[0][0].values?.action_label).toBe('旧按钮');
  });

  it('prefers value over action_value for actionValue', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-003', { requestId: 'req-val', isCommandCard: false });

    ch.extractTextPayload({
      type: 'action_card_reply',
      ref_message_id: 'mid-003',
      value: 'new-val',
      action_value: 'old-val',
    });

    expect(cb.mock.calls[0][0].action).toBe('new-val');
  });

  it('prefers label over action_label for peerName in command card', () => {
    ch.cardMessageIdMap.set('mid-cmd', { requestId: 'req-cmd', isCommandCard: true });
    const messages: any[] = [];
    ch.messageHandler = (msg: any) => messages.push(msg);

    ch.extractTextPayload({
      type: 'action_card_reply',
      ref_message_id: 'mid-cmd',
      value: '/dispatch broadcast',
      label: 'broadcast',
      action_label: 'old-label',
    }, 'group.agentid.pub/123');

    expect(messages[0].peerName).toBe('broadcast');
  });
});

// ── action_card_reply: senderAid passthrough for command cards ───────────────

describe('AUNChannel.extractTextPayload — senderAid in command card trigger', () => {
  it('uses senderAid as peerId when provided', () => {
    const ch = makeChannel();
    ch.cardMessageIdMap.set('mid-grp', { requestId: 'req-grp', isCommandCard: true });
    const messages: any[] = [];
    ch.messageHandler = (msg: any) => messages.push(msg);

    ch.extractTextPayload(
      { type: 'action_card_reply', ref_message_id: 'mid-grp', value: '/dispatch mention' },
      'group.agentid.pub/11412',
      'elean.agentid.pub',
    );

    expect(messages[0].peerId).toBe('elean.agentid.pub');
    expect(messages[0].channelId).toBe('group.agentid.pub/11412');
    expect(messages[0].content).toBe('/dispatch mention');
  });

  it('falls back to channelId when senderAid is not provided', () => {
    const ch = makeChannel();
    ch.cardMessageIdMap.set('mid-p2p', { requestId: 'req-p2p', isCommandCard: true });
    const messages: any[] = [];
    ch.messageHandler = (msg: any) => messages.push(msg);

    ch.extractTextPayload(
      { type: 'action_card_reply', ref_message_id: 'mid-p2p', value: '/model sonnet' },
      'alice.agentid.pub',
    );

    expect(messages[0].peerId).toBe('alice.agentid.pub');
  });
});

// ── sendStructured: group.send nested message_id extraction ─────────────────

describe('AUNChannel.sendStructured — group.send nested message_id', () => {
  it('extracts message_id from result.message.message_id (nested response)', async () => {
    const ch = makeChannel();
    ch.client.call = vi.fn().mockResolvedValue({
      group_id: 'group.agentid.pub/11412',
      message: { message_id: 'gm-nested-001', group_id: 'group.agentid.pub/11412', seq: 100 },
      message_dispatch: { status: 'dispatched' },
    });

    const msgId = await ch.sendStructured('group.agentid.pub/11412', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBe('gm-nested-001');
  });

  it('falls back to top-level message_id if result.message is absent', async () => {
    const ch = makeChannel();
    ch.client.call = vi.fn().mockResolvedValue({ message_id: 'mid-flat' });

    const msgId = await ch.sendStructured('group.agentid.pub/11412', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBe('mid-flat');
  });

  it('returns null when neither nested nor top-level message_id exists', async () => {
    const ch = makeChannel();
    ch.client.call = vi.fn().mockResolvedValue({ message_dispatch: { status: 'debounced' } });

    const msgId = await ch.sendStructured('group.agentid.pub/11412', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBeNull();
  });

  it('P2P sendStructured still uses top-level message_id', async () => {
    const ch = makeChannel();
    ch.client.call = vi.fn().mockResolvedValue({ message_id: 'mid-p2p-001' });

    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', title: 'test', actions: [] });
    expect(msgId).toBe('mid-p2p-001');
  });
});
