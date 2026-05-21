import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChannel(aid: string) {
  const ch = new AUNChannel({ aid }) as any;
  ch._aid = aid;
  ch.connected = true;
  // Stub methods that aren't under test
  ch.acknowledgeImmediately = vi.fn();
  ch.fetchPeerInfo = vi.fn().mockResolvedValue({ type: 'human', name: 'Tester' });
  ch.downloadAttachment = vi.fn().mockResolvedValue(null);
  return ch;
}

function makeGroupMessage(overrides: Record<string, any> = {}) {
  return {
    group_id: 'g-test123.agentid.pub',
    sender_aid: 'alice.agentid.pub',
    message_id: 'msg-001',
    seq: 1,
    payload: { text: 'hello world', type: 'text' },
    ...overrides,
  };
}

// ── dispatch_mode tests ─────────────────────────────────────────────────────

describe('AUNChannel.handleIncomingGroupMessage dispatch_mode', () => {
  let ch: any;
  let dispatched: any[];

  beforeEach(() => {
    ch = makeChannel('bot.agentid.pub');
    dispatched = [];
    ch.dispatchMessage = vi.fn((msg: any) => dispatched.push(msg));
  });

  // ── mention mode (default) ──

  it('defaults to mention mode when dispatch_mode absent — drops unmentioned messages', async () => {
    const msg = makeGroupMessage();
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.acknowledgeImmediately).toHaveBeenCalledWith('msg-001', 1);
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('mention mode — processes message when @self in text', async () => {
    const msg = makeGroupMessage({
      payload: { text: '@bot.agentid.pub hello', type: 'text' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].chatType).toBe('group');
    expect(dispatched[0].mentions).toContain('bot.agentid.pub');
  });

  it('mention mode — drops message with @all only in text (no struct mention)', async () => {
    const msg = makeGroupMessage({
      payload: { text: '@all check this', type: 'text' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('mention mode — processes message when all in payload.mentions', async () => {
    const msg = makeGroupMessage({
      payload: { text: 'check this', type: 'text', mentions: ['all'] },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].mentions).toContain('all');
  });

  it('mention mode — processes message when self in payload.mentions', async () => {
    const msg = makeGroupMessage({
      payload: { text: 'hello', type: 'text', mentions: ['bot.agentid.pub'] },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('explicit dispatch_mode=mention — drops unmentioned messages', async () => {
    const msg = makeGroupMessage({ dispatch_mode: 'mention' });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  // ── broadcast mode ──

  it('broadcast mode — processes all messages regardless of mention', async () => {
    const msg = makeGroupMessage({ dispatch_mode: 'broadcast' });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].text).toBe('hello world');
    expect(dispatched[0].mentions).toEqual([]);
  });

  it('broadcast mode — still populates mentions when @self present', async () => {
    const msg = makeGroupMessage({
      dispatch_mode: 'broadcast',
      payload: { text: '@bot.agentid.pub do something', type: 'text' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].mentions).toContain('bot.agentid.pub');
  });

  it('broadcast mode — still populates mentions when all in payload.mentions', async () => {
    const msg = makeGroupMessage({
      dispatch_mode: 'broadcast',
      payload: { text: 'attention', type: 'text', mentions: ['all'] },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].mentions).toContain('all');
  });

  // ── dispatch_mode from payload fallback ──

  it('reads dispatch_mode from payload.dispatch_mode when top-level absent', async () => {
    const msg = makeGroupMessage({
      payload: { text: 'hello', type: 'text', dispatch_mode: 'broadcast' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  // ── edge cases ──

  it('still drops own messages in broadcast mode', async () => {
    const msg = makeGroupMessage({
      dispatch_mode: 'broadcast',
      sender_aid: 'bot.agentid.pub',
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('still drops empty text in broadcast mode', async () => {
    const msg = makeGroupMessage({
      dispatch_mode: 'broadcast',
      payload: { text: '', type: 'text' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('broadcast mode with attachments but no text — processes message', async () => {
    ch.client = {};  // enable attachment processing path
    const msg = makeGroupMessage({
      dispatch_mode: 'broadcast',
      payload: { text: '', type: 'text', attachments: [{ filename: 'doc.pdf' }] },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });
});

describe('AUNChannel.handleIncomingGroupMessage dispatchModeResolver (local override)', () => {
  let ch: any;
  let dispatched: any[];

  beforeEach(() => {
    ch = makeChannel('bot.agentid.pub');
    dispatched = [];
    ch.dispatchMessage = vi.fn((msg: any) => dispatched.push(msg));
  });

  it('local dispatchMode "broadcast" overrides server "mention" — processes unmentioned messages', async () => {
    ch.setDispatchModeResolver(async () => 'broadcast');
    const msg = makeGroupMessage(); // no mention, server default = mention
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].text).toBe('hello world');
  });

  it('local dispatchMode "mention" overrides server "broadcast" — drops unmentioned messages', async () => {
    ch.setDispatchModeResolver(async () => 'mention');
    const msg = makeGroupMessage({ dispatch_mode: 'broadcast' });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('local dispatchMode undefined — falls back to server dispatch_mode', async () => {
    ch.setDispatchModeResolver(async () => undefined);
    const msg = makeGroupMessage({ dispatch_mode: 'broadcast' });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('no resolver set — uses server dispatch_mode as before', async () => {
    // no setDispatchModeResolver called
    const msg = makeGroupMessage({ dispatch_mode: 'broadcast' });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });
});

describe('AUNChannel proactive sessionMode × dispatchMode orthogonality', () => {
  let ch: any;
  let dispatched: any[];

  beforeEach(() => {
    ch = makeChannel('bot.agentid.pub');
    dispatched = [];
    ch.dispatchMessage = vi.fn((msg: any) => dispatched.push(msg));
  });

  it('dispatch=mention: drops unmentioned messages', async () => {
    ch.setDispatchModeResolver(async () => 'mention');
    const msg = makeGroupMessage(); // text type, no @
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('dispatch=broadcast: processes all text messages (no @ required)', async () => {
    ch.setDispatchModeResolver(async () => 'broadcast');
    const msg = makeGroupMessage(); // text type, no @
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
    expect(dispatched[0].text).toBe('hello world');
  });

  it('dispatch=broadcast: payload-type whitelist still rejects non-text-like types', async () => {
    ch.setDispatchModeResolver(async () => 'broadcast');
    const msg = makeGroupMessage({
      payload: { text: 'noise', type: 'task.update' }, // not in PROACTIVE_ALLOW_TYPES
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).not.toHaveBeenCalled();
  });

  it('dispatch=mention: still processes when @self present', async () => {
    ch.setDispatchModeResolver(async () => 'mention');
    const msg = makeGroupMessage({
      payload: { text: '@bot.agentid.pub help', type: 'text' },
    });
    await ch.handleIncomingGroupMessage(msg);

    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });
});
