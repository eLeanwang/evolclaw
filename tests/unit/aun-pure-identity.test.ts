import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock store/client 层，避免真连 Gateway
const mockClient = vi.hoisted(() => ({
  aid: 'ec12345.agentid.pub',
  _device_id: 'dev',
  on: vi.fn(),
  authenticate: vi.fn().mockResolvedValue({ gateway: 'https://gw', access_token: 't' }),
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/aun/aid/store.js', async (orig) => ({
  ...(await orig() as any),
  getAidStore: vi.fn().mockResolvedValue({ close: vi.fn() }),
  loadClient: vi.fn().mockResolvedValue(mockClient),
}));

import { AUNChannel } from '../../src/channels/aun.js';
import * as configStore from '../../src/config-store.js';

describe('AUNChannel pureIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.on.mockClear();
    mockClient.aid = 'ec12345.agentid.pub';
  });

  it('pureIdentity 模式不调用 loadAgent（不触发 welcome）', async () => {
    const loadAgentSpy = vi.spyOn(configStore, 'loadAgent');
    const ch = new AUNChannel({ aid: 'ec12345.agentid.pub', gatewayUrl: 'https://gw', pureIdentity: true });
    await ch.connect();
    expect(loadAgentSpy).not.toHaveBeenCalled();
    await ch.disconnect();
  });

  it('pureIdentity 模式不注册 group 事件监听', async () => {
    const ch = new AUNChannel({ aid: 'ec12345.agentid.pub', gatewayUrl: 'https://gw', pureIdentity: true });
    await ch.connect();
    const events = mockClient.on.mock.calls.map(c => c[0]);
    expect(events).not.toContain('group.message_created');
    expect(events).not.toContain('group.message_undecryptable');
    expect(events).toContain('message.received'); // 私聊仍监听
    await ch.disconnect();
  });

  it('普通模式（pureIdentity 未设）仍注册 group 事件', async () => {
    vi.spyOn(configStore, 'loadAgent').mockReturnValue(null); // welcome 会被 null 短路
    const ch = new AUNChannel({ aid: 'biz.agentid.pub', gatewayUrl: 'https://gw' });
    mockClient.aid = 'biz.agentid.pub';
    await ch.connect();
    const events = mockClient.on.mock.calls.map(c => c[0]);
    expect(events).toContain('group.message_created');
    await ch.disconnect();
  });
});
