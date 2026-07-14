import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { msgHistory } from '../../src/aun/msg/history.js';
import { buildInboundEntry, buildOutboundEntry } from '../../src/core/message/message-log.js';
import { appendJsonl, atomicWriteJson, chatDirPath } from '../../src/core/session/session-fs-store.js';

const SELF_AID = 'self.agentid.pub';
const TARGET_AID = 'target.agentid.pub';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { sessionsDir: string; chatDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-history-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const chatDir = chatDirPath(sessionsDir, 'aun', TARGET_AID, SELF_AID);
  fs.mkdirSync(chatDir, { recursive: true });
  return { sessionsDir, chatDir };
}

function appendMessages(chatDir: string): void {
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildInboundEntry({
    from: TARGET_AID,
    to: SELF_AID,
    msgId: 'legacy-menu-signal',
    msgType: 'custom',
    payloadType: 'menu.options',
    chatType: 'private',
    content: '[payload:menu.options]',
    timestamp: 500,
  }));
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildInboundEntry({
    from: TARGET_AID,
    to: SELF_AID,
    msgId: 'legacy-in',
    chatType: 'private',
    content: 'legacy',
    timestamp: 1000,
  }));
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildInboundEntry({
    from: TARGET_AID,
    to: SELF_AID,
    sessionId: 'meta_session_a',
    msgId: 'session-a-in',
    chatType: 'private',
    content: 'session a inbound',
    timestamp: 2000,
  }));
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildOutboundEntry({
    from: SELF_AID,
    to: TARGET_AID,
    sessionId: 'meta_session_a',
    msgId: 'session-a-out',
    chatType: 'private',
    content: 'session a outbound',
    timestamp: 3000,
  }));
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildInboundEntry({
    from: TARGET_AID,
    to: SELF_AID,
    sessionId: 'meta_session_b',
    msgId: 'session-b-in',
    chatType: 'private',
    content: 'session b inbound',
    timestamp: 4000,
  }));
  appendJsonl(path.join(chatDir, 'messages.jsonl'), buildOutboundEntry({
    from: SELF_AID,
    to: TARGET_AID,
    sessionId: 'meta_session_a',
    msgId: 'internal-state',
    msgType: 'handoff_state',
    chatType: 'private',
    content: '',
    timestamp: 5000,
  }));
}

describe('msgHistory', () => {
  it('keeps legacy entries in all-session queries and filters internal state', () => {
    const { sessionsDir, chatDir } = fixture();
    appendMessages(chatDir);

    const result = msgHistory({ from: SELF_AID, target: TARGET_AID, session: 'all' }, { sessionsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map(message => message.msgId)).toEqual([
      'legacy-in',
      'session-a-in',
      'session-a-out',
      'session-b-in',
    ]);
  });

  it('defaults to latest from active.json and strictly excludes legacy entries', () => {
    const { sessionsDir, chatDir } = fixture();
    appendMessages(chatDir);
    atomicWriteJson(path.join(chatDir, 'active.json'), {
      id: 'meta_session_a',
      channelType: 'aun',
      channelId: TARGET_AID,
      selfAID: SELF_AID,
    });

    const result = msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
    }, { sessionsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session_id).toBe('meta_session_a');
    expect(result.messages.map(message => message.msgId)).toEqual(['session-a-in', 'session-a-out']);
  });

  it('resolves an archived session only inside the selected AID pair', () => {
    const { sessionsDir, chatDir } = fixture();
    appendMessages(chatDir);
    appendJsonl(path.join(chatDir, 'meta_session_b.jsonl'), {
      id: 'meta_session_b',
      channelType: 'aun',
      channelId: TARGET_AID,
      selfAID: SELF_AID,
    });

    const result = msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
      session: 'meta_session_b',
    }, { sessionsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map(message => message.msgId)).toEqual(['session-b-in']);
  });

  it('applies direction, time, and latest-N filters before rendering', () => {
    const { sessionsDir, chatDir } = fixture();
    appendMessages(chatDir);

    const result = msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
      direction: 'in',
      after: 1000,
      before: 5000,
      limit: 2,
      session: 'all',
    }, { sessionsDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map(message => message.msgId)).toEqual(['session-a-in', 'session-b-in']);
  });

  it('returns explicit errors for missing default/latest sessions and invalid limits', () => {
    const { sessionsDir } = fixture();

    expect(msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
    }, { sessionsDir })).toMatchObject({ ok: false, code: 'LATEST_SESSION_NOT_FOUND' });

    expect(msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
      limit: 501,
    }, { sessionsDir })).toMatchObject({ ok: false, code: 'INVALID_LIMIT' });
  });

  it('returns an empty result for a missing log and skips corrupt lines', () => {
    const { sessionsDir, chatDir } = fixture();

    expect(msgHistory({ from: SELF_AID, target: TARGET_AID, session: 'all' }, { sessionsDir })).toMatchObject({
      ok: true,
      count: 0,
      messages: [],
    });

    fs.writeFileSync(path.join(chatDir, 'messages.jsonl'), [
      '{not-json}',
      JSON.stringify(buildInboundEntry({
        from: TARGET_AID,
        to: SELF_AID,
        msgId: 'valid-after-corrupt',
        chatType: 'private',
        content: 'valid',
        timestamp: 1000,
      })),
      '',
    ].join('\n'));

    const result = msgHistory({ from: SELF_AID, target: TARGET_AID, session: 'all' }, { sessionsDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages.map(message => message.msgId)).toEqual(['valid-after-corrupt']);
  });

  it('rejects sessions whose metadata belongs to another AID pair', () => {
    const { sessionsDir, chatDir } = fixture();
    appendJsonl(path.join(chatDir, 'meta_wrong_pair.jsonl'), {
      id: 'meta_wrong_pair',
      channelType: 'aun',
      channelId: 'other.agentid.pub',
      selfAID: SELF_AID,
    });

    expect(msgHistory({
      from: SELF_AID,
      target: TARGET_AID,
      session: 'meta_wrong_pair',
    }, { sessionsDir })).toMatchObject({ ok: false, code: 'SESSION_SCOPE_MISMATCH' });
  });

  it('validates AIDs, session IDs, directions, and time ranges', () => {
    const { sessionsDir } = fixture();

    expect(msgHistory({ from: '../self', target: TARGET_AID }, { sessionsDir }))
      .toMatchObject({ ok: false, code: 'INVALID_SELF_AID' });
    expect(msgHistory({ from: SELF_AID, target: '../target' }, { sessionsDir }))
      .toMatchObject({ ok: false, code: 'INVALID_TARGET_AID' });
    expect(msgHistory({ from: SELF_AID, target: TARGET_AID, session: '../session' }, { sessionsDir }))
      .toMatchObject({ ok: false, code: 'INVALID_SESSION_ID' });
    expect(msgHistory({ from: SELF_AID, target: TARGET_AID, direction: 'sideways' as any }, { sessionsDir }))
      .toMatchObject({ ok: false, code: 'INVALID_DIRECTION' });
    expect(msgHistory({ from: SELF_AID, target: TARGET_AID, after: 2000, before: 1000 }, { sessionsDir }))
      .toMatchObject({ ok: false, code: 'INVALID_TIME_RANGE' });
  });
});
