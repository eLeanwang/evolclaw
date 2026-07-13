import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendMessageLogStrict, buildInboundEntry } from '../../src/core/message/message-log.js';
import { readAllJsonlLines } from '../../src/core/session/session-fs-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('handoff v2 strict message log', () => {
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
});
