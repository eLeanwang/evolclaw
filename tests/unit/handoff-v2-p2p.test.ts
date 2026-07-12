import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcQuery } from '../../src/ipc.js';
import { createShortConnection } from '../../src/aun/rpc/index.js';
import { msgSend } from '../../src/aun/msg/p2p.js';

vi.mock('../../src/ipc.js', () => ({ ipcQuery: vi.fn() }));
vi.mock('../../src/aun/rpc/index.js', () => ({ createShortConnection: vi.fn() }));

const mockedIpcQuery = vi.mocked(ipcQuery);
const mockedCreateShortConnection = vi.mocked(createShortConnection);
const originalSessionId = process.env.EVOLCLAW_SESSION_ID;

beforeEach(() => {
  process.env.EVOLCLAW_SESSION_ID = 'meta-origin';
  mockedIpcQuery.mockReset();
  mockedCreateShortConnection.mockReset();
});

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.EVOLCLAW_SESSION_ID;
  else process.env.EVOLCLAW_SESSION_ID = originalSessionId;
});

function mockRuntimeAndSend(assertSend: (command: any) => void): void {
  mockedIpcQuery.mockImplementation(async (_socket, command) => {
    if (command.type === 'task-runtime-context') {
      return { ok: true, context: {
        sessionId: 'meta-origin', messageId: 'origin-message', channel: 'aun', chatType: 'private',
        selfAid: 'self.agentid.pub', peerId: 'origin.agentid.pub',
      } } as any;
    }
    if (command.type === 'aun-msg-send') {
      assertSend(command);
      return { ok: true, handoff_id: 'h-001', target_session_id: 'meta-target', status: 'queued' } as any;
    }
    return null;
  });
}

describe('handoff v2 msg send routing', () => {
  it('rejects return=none before direct or daemon sending', async () => {
    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'text', text: 'fire and forget' }, returnPolicy: 'none',
    });

    expect(result).toMatchObject({ ok: false, code: 'HANDOFF_RETURN_POLICY_UNSUPPORTED' });
    expect(mockedIpcQuery).not.toHaveBeenCalled();
    expect(mockedCreateShortConnection).not.toHaveBeenCalled();
  });

  it('does not inherit the origin message ref into a cross-session payload', async () => {
    mockRuntimeAndSend(command => expect(command.payload.ref_message_id).toBeUndefined());

    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'text', text: 'question' },
    });

    expect(result).toMatchObject({ ok: true, handoff_id: 'h-001' });
    expect(mockedCreateShortConnection).not.toHaveBeenCalled();
  });

  it('uses an explicit payload thread for target-session routing', async () => {
    mockRuntimeAndSend(command => {
      expect(command.thread).toBe('payload-thread');
      expect(command.payload.thread_id).toBe('payload-thread');
    });

    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'payload', payload: { type: 'text', text: 'question', thread_id: 'payload-thread' } },
    });

    expect(result).toMatchObject({ ok: true, handoff_id: 'h-001', target_session_id: 'meta-target' });
  });
});
