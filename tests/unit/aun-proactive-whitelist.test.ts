import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChannel(aid: string) {
  const ch = new AUNChannel({ aid }) as any;
  ch._aid = aid;
  ch.connected = true;
  ch.acknowledgeImmediately = vi.fn();
  ch.fetchPeerInfo = vi.fn().mockResolvedValue({ type: 'human', name: 'Tester' });
  ch.downloadAttachment = vi.fn().mockResolvedValue(null);
  return ch;
}

function makeGroupMessage(overrides: Record<string, any> = {}) {
  return {
    group_id: 'g-test.agentid.pub',
    sender_aid: 'alice.agentid.pub',
    message_id: 'msg-001',
    seq: 1,
    payload: { text: 'hello', type: 'text' },
    dispatch_mode: 'broadcast',
    ...overrides,
  };
}

// ── payload type whitelist tests (unconditional) ────────────────────────────

describe('AUNChannel payload type whitelist', () => {
  let ch: any;
  let dispatched: any[];

  beforeEach(() => {
    ch = makeChannel('bot.agentid.pub');
    dispatched = [];
    ch.dispatchMessage = vi.fn((msg: any) => dispatched.push(msg));
  });

  // ── deny: types not in allow list ──

  it('drops event type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'event', event: 'task.started', data: { task_id: 'task-1' } },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops thought type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'thought', text: 'thinking...', stage: 'tool' },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops status type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'status', state: 'processing' },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops tool_call type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'tool_call', call_id: 'c1', name: 'bash', arguments: {} },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops tool_result type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'tool_result', call_id: 'c1', ok: true, result: {} },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops menu.query type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'menu.query', cmd: '/help' },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops custom type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'custom', kind: 'foo', data: {} },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  it('drops unknown type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'unknown_xyz', text: 'hi' },
    }));
    expect(ch.dispatchMessage).not.toHaveBeenCalled();
    expect(ch.acknowledgeImmediately).toHaveBeenCalled();
  });

  // ── allow list types pass through (with mention condition for dispatch_mode=mention) ──

  it('dispatches text with @self in text', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'text', text: '@bot.agentid.pub hello' },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches text with @self in payload.mentions (string format)', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'text', text: 'hello', mentions: ['bot.agentid.pub'] },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches text in broadcast mode without mention', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'text', text: 'hello everyone' },
      dispatch_mode: 'broadcast',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches quote type', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'quote', text: '@bot.agentid.pub agree', quote: { text: 'proposal' } },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches image type with @self', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: {
        type: 'image',
        text: '@bot.agentid.pub look at this',
        attachments: [{ url: 'aun://storage/img.png', filename: 'img.png' }],
      },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches file type with @self', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'file', text: '@bot.agentid.pub check this' },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });

  it('dispatches link type with @self', async () => {
    await ch.handleIncomingGroupMessage(makeGroupMessage({
      payload: { type: 'link', url: 'https://example.com', text: '@bot.agentid.pub check this' },
      dispatch_mode: 'mention',
    }));
    expect(ch.dispatchMessage).toHaveBeenCalledOnce();
  });
});
