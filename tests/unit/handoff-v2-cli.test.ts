import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseList, parseReturn, parseTrace } from '../../src/cli/handoff-command.js';
import { HandoffRuntime } from '../../src/core/handoff/runtime.js';
import { HandoffStore } from '../../src/core/handoff/store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('handoff v2 CLI', () => {
  it('parses explicit-id and current-task shorthand return content', () => {
    expect(parseReturn(['h-001', 'complete', 'answer'])).toEqual({
      handoffId: 'h-001', content: 'complete answer',
    });
    expect(parseReturn(['complete', 'answer'])).toEqual({
      handoffId: undefined, content: 'complete answer',
    });
    expect(parseReturn(['h-001', '--', 'answer', '--flag-like-content'])).toEqual({
      handoffId: 'h-001', content: 'answer --flag-like-content',
    });
    expect(parseReturn(['--', 'h-not-an-id', 'is content'])).toEqual({
      handoffId: undefined, content: 'h-not-an-id is content',
    });
  });

  it('reads return content from a file without changing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cli-'));
    roots.push(root);
    const filePath = path.join(root, 'answer.txt');
    fs.writeFileSync(filePath, 'line one\nline two\n');

    expect(parseReturn(['h-001', '--text-from-file', filePath])).toEqual({
      handoffId: 'h-001', content: 'line one\nline two\n',
    });
  });

  it('parses bounded list and trace query options', () => {
    expect(parseList([
      '--state', 'origin_queued', '--session', 'meta-origin', '--limit', '25', '--agent', 'self.agentid.pub',
    ])).toEqual({
      state: 'origin_queued', sessionId: 'meta-origin', limit: 25, agent: 'self.agentid.pub',
    });
    expect(parseTrace(['h-001', '--limit', '10', '--agent', 'self.agentid.pub'])).toEqual({
      handoffId: 'h-001', limit: 10, agent: 'self.agentid.pub',
    });
    expect(() => parseList(['--state', 'invalid'])).toThrow('INVALID_HANDOFF_STATE');
    expect(() => parseTrace(['h-001', '--limit', '501'])).toThrow('INVALID_HANDOFF_LIMIT');
  });

  it('rejects return=none in phase 1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-runtime-'));
    roots.push(root);
    const origin = {
      id: 'meta-origin', selfAID: 'self.agentid.pub', channel: 'aun-main', channelType: 'aun',
      channelId: 'origin.agentid.pub', projectPath: '/project', metadata: {}, baseagent: 'codex',
    };
    const runtime = new HandoffRuntime({
      getSessionById: async () => origin,
      getOrCreateSession: async () => ({ ...origin, id: 'meta-target', channelId: 'target.agentid.pub' }),
    } as any, {} as any, async () => ({ ok: true }), new HandoffStore(root));

    await expect(runtime.createOutbound({
      selfAid: 'self.agentid.pub',
      to: 'target.agentid.pub',
      originSessionId: 'meta-origin',
      originMessageId: 'origin-message',
      payload: { type: 'text', text: 'question' },
      encrypt: false,
      explicitReturnPolicy: 'none',
    })).rejects.toMatchObject({ code: 'HANDOFF_RETURN_POLICY_UNSUPPORTED' });
  });
});
