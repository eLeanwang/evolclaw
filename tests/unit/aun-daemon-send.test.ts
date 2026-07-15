import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AUNChannel } from '../../src/channels/aun.js';
import { resolveRoot } from '../../src/paths.js';

function connectedChannel() {
  const call = vi.fn();
  const channel = new AUNChannel({ aid: 'self.agentid.pub' }) as any;
  channel.connected = true;
  channel.client = { call };
  channel.forwardOutbound = vi.fn();
  return { channel, call };
}

describe('AUN daemon delegated send boundary', () => {
  it('rejects H-class files before the privileged channel reads them', async () => {
    const { channel, call } = connectedChannel();

    await expect(channel.buildDaemonFilePayload({
      filePath: path.join(resolveRoot(), 'evolclaw.json'),
    })).rejects.toMatchObject({ code: 'H_CLASS_PROTECTED' });
    expect(call).not.toHaveBeenCalled();
  });

  it('sends group payloads and mentions over the existing daemon connection', async () => {
    const { channel, call } = connectedChannel();
    call.mockResolvedValue({
      group_id: 'group.owner/team',
      message: { message_id: 'group-message', payload: { type: 'text', text: 'hello' } },
      event: { seq: 3 },
    });

    const result = await channel.sendDaemonGroupMsg({
      groupId: 'group.owner/team',
      payload: { type: 'text', text: 'hello' },
      mentions: [{ scope: 'all' }],
      encrypt: true,
    });

    expect(result).toMatchObject({ ok: true, message_id: 'group-message', group_id: 'group.owner/team' });
    expect(call).toHaveBeenCalledWith('group.send', {
      group_id: 'group.owner/team',
      payload: { type: 'text', text: 'hello', mentions: [{ scope: 'all' }] },
      encrypt: true,
    });
  });
});
