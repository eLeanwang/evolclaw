import path from 'path';
import { describe, expect, it } from 'vitest';
import { renderMessageBody } from '../../src/eck/message-renderer.js';

const fragmentsDir = path.join(process.cwd(), 'kits', 'templates', 'message-fragments');

describe('handoff v2 message rendering', () => {
  it('renders target delivery with the return command', () => {
    const rendered = renderMessageBody([{
      kind: 'handoff',
      peerId: 'target.agentid.pub',
      content: 'target reply',
      timestamp: 2000,
      handoff: {
        kind: 'request_to_target',
        handoffId: 'h-001',
        previousContent: 'question for target',
        previousMessageId: 'out-1',
      },
    }], {
      chatType: 'private',
      selfAid: 'self.agentid.pub',
      KITS_MESSAGE_FRAGMENTS: fragmentsDir,
    }, 'handoff-v2-target-render');

    expect(rendered.body).toContain('跨会话请求回复，仅本端可见');
    expect(rendered.body).toContain('question for target');
    expect(rendered.body).toContain('target reply');
    expect(rendered.body).toContain('ec handoff return h-001');
  });

  it('renders origin delivery without exposing the handoff id', () => {
    const rendered = renderMessageBody([{
      kind: 'handoff',
      peerId: 'origin.agentid.pub',
      content: '128 records',
      timestamp: 2000,
      handoff: {
        kind: 'response_to_origin',
        handoffId: 'h-001',
        previousContent: 'record count?',
      },
    }], {
      chatType: 'private',
      selfAid: 'self.agentid.pub',
      KITS_MESSAGE_FRAGMENTS: fragmentsDir,
    }, 'handoff-v2-origin-render');

    expect(rendered.body).toContain('跨会话结果回流，仅本端可见');
    expect(rendered.body).toContain('record count?');
    expect(rendered.body).toContain('128 records');
    expect(rendered.body).not.toContain('h-001');
  });
});
