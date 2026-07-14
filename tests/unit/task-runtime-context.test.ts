import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcQuery } from '../../src/ipc.js';
import {
  buildTaskRuntimeEnv,
  parseTaskRuntimeContext,
  readBestTaskRuntimeContext,
  runtimeRefMessageIdForMsgSend,
  TASK_RUNTIME_CONTEXT_ENV,
} from '../../src/core/task-runtime-context.js';

vi.mock('../../src/ipc.js', () => ({ ipcQuery: vi.fn() }));

const mockedIpcQuery = vi.mocked(ipcQuery);

beforeEach(() => mockedIpcQuery.mockReset());

describe('task runtime context', () => {
  it('uses the current inbound message as the private AUN reply reference', () => {
    expect(runtimeRefMessageIdForMsgSend({
      from: 'self.agentid.pub',
      runtime: {
        sessionId: 'session-1',
        messageId: 'inbound-1',
        channel: 'aun',
        chatType: 'private',
        selfAid: 'self.agentid.pub',
      },
    })).toBe('inbound-1');

    expect(runtimeRefMessageIdForMsgSend({
      from: 'other.agentid.pub',
      runtime: {
        messageId: 'inbound-1',
        channel: 'aun',
        chatType: 'private',
        selfAid: 'self.agentid.pub',
      },
    })).toBeUndefined();
  });

  it('prefers the active daemon context over a stale environment snapshot', async () => {
    mockedIpcQuery.mockResolvedValueOnce({
      ok: true,
      context: {
        sessionId: 'session-1',
        messageId: 'new-inbound',
        handoffIds: ['h-1'],
      },
    } as any);

    const context = await readBestTaskRuntimeContext({
      EVOLCLAW_SESSION_ID: 'session-1',
      [TASK_RUNTIME_CONTEXT_ENV]: JSON.stringify({
        sessionId: 'session-1',
        messageId: 'old-inbound',
      }),
    } as NodeJS.ProcessEnv);

    expect(context).toMatchObject({ messageId: 'new-inbound', handoffIds: ['h-1'] });
  });

  it('drops legacy and unknown runtime fields', () => {
    const parsed = parseTaskRuntimeContext(JSON.stringify({
      sessionId: 'session-1',
      handoffIds: ['h-1', 2],
      consumedHandoff: { kind: 'request_to_target' },
      legacy: true,
    }));
    expect(parsed).toEqual(expect.objectContaining({ sessionId: 'session-1', handoffIds: ['h-1'] }));
    expect(parsed).not.toHaveProperty('consumedHandoff');
    expect(parsed).not.toHaveProperty('legacy');

    const env = buildTaskRuntimeEnv(parsed!);
    expect(JSON.parse(env[TASK_RUNTIME_CONTEXT_ENV])).not.toHaveProperty('consumedHandoff');
  });
});
