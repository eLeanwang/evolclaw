import { describe, expect, it, vi } from 'vitest';
import { checkGroupIndex, getGroupIndex } from '../../src/aun/msg/group-index.js';

describe('group-index wrappers', () => {
  it('delegates checkGroupIndex to the SDK facade instead of raw RPC', async () => {
    const result = { group_aid: '11716.agentid.pub', cached: true };
    const client = {
      call: vi.fn(async () => {
        throw new Error('raw RPC should not be called');
      }),
      group: {
        checkGroupIndex: vi.fn(async () => result),
      },
    } as any;

    await expect(checkGroupIndex(client, '11716.agentid.pub')).resolves.toBe(result);
    expect(client.group.checkGroupIndex).toHaveBeenCalledWith({ group_id: '11716.agentid.pub' });
    expect(client.call).not.toHaveBeenCalled();
  });

  it('delegates getGroupIndex to the SDK facade instead of raw RPC', async () => {
    const result = {
      group_aid: '11716.agentid.pub',
      meta: { etag: 'sha256:abc' },
      settings: { 'rules.content': '{"path":"/rules.md"}' },
    };
    const client = {
      call: vi.fn(async () => {
        throw new Error('raw RPC should not be called');
      }),
      group: {
        getGroupIndex: vi.fn(async () => result),
      },
    } as any;

    await expect(getGroupIndex(client, '11716.agentid.pub')).resolves.toBe(result);
    expect(client.group.getGroupIndex).toHaveBeenCalledWith({ group_id: '11716.agentid.pub' });
    expect(client.call).not.toHaveBeenCalled();
  });
});
