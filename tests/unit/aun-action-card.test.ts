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
    ch.cardMessageIdMap.set('mid-001', 'req-abc');

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
    ch.cardMessageIdMap.set('mid-001', 'req-abc');

    ch.extractTextPayload({ type: 'action_card_reply', card_message_id: 'mid-001', text: 'ok' });

    expect(ch.cardMessageIdMap.has('mid-001')).toBe(false);
  });

  it('does NOT fire callback when card_message_id is missing', () => {
    const cb = vi.fn();
    ch.interactionCallback = cb;
    ch.cardMessageIdMap.set('mid-001', 'req-abc');

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
    ch.cardMessageIdMap.set('mid-001', 'req-abc');

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
    ch.cardMessageIdMap.set('mid-001', 'req-abc');

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
      ch.cardMessageIdMap.set(msgId, req.id);
      setTimeout(() => ch.cardMessageIdMap.delete(msgId), 20 * 60 * 1000);
    }

    expect(msgId).toBe('mid-001');
    expect(ch.cardMessageIdMap.get('mid-001')).toBe('req-xyz');

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
    if (msgId) ch.cardMessageIdMap.set(msgId, 'req-cmd');

    expect(sendStructuredCalls[0].payload.actions[0]).toMatchObject({ label: '确认', value: '/confirm' });
    expect(sendStructuredCalls[0].payload.actions[1]).toMatchObject({ label: '取消', value: '/cancel' });
    expect(ch.cardMessageIdMap.get('mid-001')).toBe('req-cmd');
  });

  it('does not store in cardMessageIdMap when sendStructured returns null', async () => {
    const ch = makeChannel();
    ch.connected = false; // causes sendStructured to return null

    const msgId = await ch.sendStructured('alice.agentid.pub', { type: 'action_card', actions: [] });
    if (msgId) ch.cardMessageIdMap.set(msgId, 'req-null');

    expect(msgId).toBeNull();
    expect(ch.cardMessageIdMap.size).toBe(0);
  });
});

// ── cardMessageIdMap TTL ──────────────────────────────────────────────────────

describe('AUNChannel.cardMessageIdMap — TTL cleanup', () => {
  it('entry is removed after TTL expires', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    ch.cardMessageIdMap.set('mid-ttl', 'req-ttl');
    setTimeout(() => ch.cardMessageIdMap.delete('mid-ttl'), 20 * 60 * 1000);

    expect(ch.cardMessageIdMap.has('mid-ttl')).toBe(true);
    vi.advanceTimersByTime(20 * 60 * 1000 + 1);
    expect(ch.cardMessageIdMap.has('mid-ttl')).toBe(false);
    vi.useRealTimers();
  });
});
