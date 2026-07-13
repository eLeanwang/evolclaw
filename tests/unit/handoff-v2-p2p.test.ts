import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcQuery } from '../../src/ipc.js';
import { createShortConnection } from '../../src/aun/rpc/index.js';
import { uploadFileAndBuildPayload } from '../../src/aun/msg/upload.js';
import { msgSend } from '../../src/aun/msg/p2p.js';

vi.mock('../../src/ipc.js', () => ({ ipcQuery: vi.fn() }));
vi.mock('../../src/aun/rpc/index.js', () => ({ createShortConnection: vi.fn() }));
vi.mock('../../src/aun/msg/upload.js', () => ({ uploadFileAndBuildPayload: vi.fn() }));

const mockedIpcQuery = vi.mocked(ipcQuery);
const mockedCreateShortConnection = vi.mocked(createShortConnection);
const mockedUploadFileAndBuildPayload = vi.mocked(uploadFileAndBuildPayload);
const originalSessionId = process.env.EVOLCLAW_SESSION_ID;

beforeEach(() => {
  process.env.EVOLCLAW_SESSION_ID = 'meta-origin';
  mockedIpcQuery.mockReset();
  mockedCreateShortConnection.mockReset();
  mockedUploadFileAndBuildPayload.mockReset();
});

afterEach(() => {
  if (originalSessionId === undefined) delete process.env.EVOLCLAW_SESSION_ID;
  else process.env.EVOLCLAW_SESSION_ID = originalSessionId;
});

function mockRuntimeAndSend(
  assertSend: (command: any) => void,
  runtime: Record<string, unknown> = {},
): void {
  mockedIpcQuery.mockImplementation(async (_socket, command) => {
    if (command.type === 'task-runtime-context') {
      return { ok: true, context: {
        sessionId: 'meta-origin', messageId: 'origin-message', channel: 'aun', chatType: 'private',
        selfAid: 'self.agentid.pub', peerId: 'origin.agentid.pub',
        ...runtime,
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
    mockRuntimeAndSend(command => {
      expect(command.payload.ref_message_id).toBeUndefined();
      expect(command.log.sessionId).toBeUndefined();
    });

    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'text', text: 'question' },
    });

    expect(result).toMatchObject({ ok: true, handoff_id: 'h-001' });
    expect(mockedCreateShortConnection).not.toHaveBeenCalled();
  });

  it('routes a Feishu group task through the daemon handoff path', async () => {
    mockRuntimeAndSend(command => {
      expect(command).toMatchObject({
        originSessionId: 'meta-feishu-group',
        originMessageId: 'feishu-message',
        aid: 'self.agentid.pub',
        to: 'target.agentid.pub',
      });
      expect(command.log.sessionId).toBeUndefined();
    }, {
      sessionId: 'meta-feishu-group',
      messageId: 'feishu-message',
      channel: 'feishu',
      chatType: 'group',
      peerId: 'feishu-user',
    });

    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'text', text: 'question from Feishu group' },
    });

    expect(result).toMatchObject({ ok: true, handoff_id: 'h-001', target_session_id: 'meta-target' });
    expect(mockedCreateShortConnection).not.toHaveBeenCalled();
  });

  it('uploads a file then routes its payload through v2 without direct message.send', async () => {
    const connection = { call: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mockedCreateShortConnection.mockResolvedValue(connection as any);
    mockedUploadFileAndBuildPayload.mockResolvedValue({
      type: 'file',
      attachment: {} as any,
      payload: { type: 'file', text: 'report', attachments: [{ object_key: 'shared/report.txt' }] },
    });
    mockRuntimeAndSend(command => {
      expect(command.payload).toMatchObject({
        type: 'file', text: 'report', attachments: [{ object_key: 'shared/report.txt' }],
      });
    }, { channel: 'feishu', chatType: 'group' });

    const result = await msgSend({
      from: 'self.agentid.pub', to: 'target.agentid.pub',
      body: { mode: 'file', filePath: '/tmp/report.txt' },
    });

    expect(result).toMatchObject({ ok: true, handoff_id: 'h-001' });
    expect(mockedUploadFileAndBuildPayload).toHaveBeenCalledTimes(1);
    expect(connection.call).not.toHaveBeenCalledWith('message.send', expect.anything());
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('attaches the local session id when sending to the current peer', async () => {
    mockRuntimeAndSend(command => expect(command.log.sessionId).toBe('meta-origin'));

    await msgSend({
      from: 'self.agentid.pub', to: 'origin.agentid.pub',
      body: { mode: 'text', text: 'same-session reply' },
    });
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
