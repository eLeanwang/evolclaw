import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendMessageLog, appendMessageLogStrict, buildInboundEntry } from '../../src/core/message/message-log.js';
import { readAllJsonlLines } from '../../src/core/session/session-fs-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('handoff v2 strict message log', () => {
  it('creates missing chat directories before appending', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-log-'));
    roots.push(root);
    const regularChat = path.join(root, 'regular', 'nested');
    const strictChat = path.join(root, 'strict', 'nested');

    appendMessageLog(regularChat, buildInboundEntry({
      from: 'peer.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
      msgId: 'new-regular-chat', content: 'menu request',
    }));
    appendMessageLogStrict(strictChat, buildInboundEntry({
      from: 'target.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
      msgId: 'new-strict-chat', content: 'handoff reply',
    }));

    expect(readAllJsonlLines(path.join(regularChat, 'messages.jsonl'))).toHaveLength(1);
    expect(readAllJsonlLines(path.join(strictChat, 'messages.jsonl'))).toHaveLength(1);
  });

  it('deduplicates inbound ids per chat instead of across sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-log-'));
    roots.push(root);
    const firstChat = path.join(root, 'first');
    const secondChat = path.join(root, 'second');
    fs.mkdirSync(firstChat, { recursive: true });
    fs.mkdirSync(secondChat, { recursive: true });
    const entry = buildInboundEntry({
      from: 'target.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
      msgId: 'same-external-id', content: 'reply',
    });

    appendMessageLogStrict(firstChat, entry);
    appendMessageLogStrict(firstChat, entry);
    appendMessageLogStrict(secondChat, entry);

    expect(readAllJsonlLines(path.join(firstChat, 'messages.jsonl'))).toHaveLength(1);
    expect(readAllJsonlLines(path.join(secondChat, 'messages.jsonl'))).toHaveLength(1);
  });

  it('does not persist transient protocol and status signals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-log-filter-'));
    roots.push(root);
    const chatDir = path.join(root, 'chat');

    for (const [msgId, payloadType] of [
      ['menu', 'menu.options'],
      ['activity', 'activity'],
      ['status', 'status.progress'],
      ['event', 'events.delivery'],
      ['thought', 'thought'],
    ]) {
      appendMessageLog(chatDir, buildInboundEntry({
        from: 'peer.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
        msgId, content: `[payload:${payloadType}]`, msgType: 'custom', payloadType,
      }));
    }
    appendMessageLog(chatDir, buildInboundEntry({
      from: 'peer.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
      msgId: 'text', content: 'hello',
    }));
    appendMessageLog(chatDir, {
      ...buildInboundEntry({
        from: 'peer.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
        msgId: 'handoff-state', content: '',
      }),
      msgType: 'handoff_state',
    } as any);
    appendMessageLogStrict(chatDir, buildInboundEntry({
      from: 'peer.agentid.pub', to: 'self.agentid.pub', chatType: 'private',
      msgId: 'strict-status', content: '[status]', msgType: 'custom', payloadType: 'status.progress',
    }));

    expect(readAllJsonlLines(path.join(chatDir, 'messages.jsonl')).map(entry => entry.msgId))
      .toEqual(['text']);
  });
});
