import { describe, it, expect, vi } from 'vitest';
import { ChannelLoader, type ChannelPlugin, type ChannelInstance } from '../../src/core/channel-loader.js';
import type { Config } from '../../src/types.js';

function mockPlugin(name: string, callCounter: { count: number }): ChannelPlugin {
  return {
    name,
    isEnabled: vi.fn().mockReturnValue(true),
    async createChannel(): Promise<ChannelInstance> {
      callCounter.count++;
      return {
        channelType: name,
        adapter: { channelName: name, sendText: vi.fn() } as any,
        channel: {},
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    },
  };
}

describe('ChannelLoader idempotency', () => {
  it('createAll can be called multiple times without side effects', async () => {
    const loader = new ChannelLoader();
    const counter = { count: 0 };
    const plugin = mockPlugin('feishu', counter);
    loader.register(plugin);

    const config: Config = { channels: { feishu: {} } } as any;

    const result1 = await loader.createAll(config);
    const result2 = await loader.createAll(config);

    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(counter.count).toBe(2);
    // Each call produces independent instances
    expect(result1[0]).not.toBe(result2[0]);
    // isEnabled should be invoked with the config on each call
    expect(plugin.isEnabled).toHaveBeenCalledWith(config);
  });

  it('createAll with different configs produces independent results', async () => {
    const loader = new ChannelLoader();
    loader.register(mockPlugin('feishu', { count: 0 }));
    loader.register(mockPlugin('aun', { count: 0 }));

    const configFeishu: Config = { channels: { feishu: {} } } as any;
    const configAun: Config = { channels: { aun: {} } } as any;

    const result1 = await loader.createAll(configFeishu);
    const result2 = await loader.createAll(configAun);

    expect(result1.map(i => i.adapter.channelName)).toContain('feishu');
    expect(result2.map(i => i.adapter.channelName)).toContain('aun');
  });

  it('createAll idempotent for multi-instance plugins (createChannels)', async () => {
    const loader = new ChannelLoader();
    const counter = { count: 0 };
    const plugin: ChannelPlugin = {
      name: 'feishu',
      isEnabled: () => true,
      createChannel: vi.fn() as any, // required by interface but unused when createChannels exists
      async createChannels(): Promise<ChannelInstance[]> {
        counter.count++;
        return [
          {
            channelType: 'feishu',
            adapter: { channelName: 'feishu-1', sendText: vi.fn() } as any,
            channel: {},
            connect: vi.fn(),
            disconnect: vi.fn(),
          },
          {
            channelType: 'feishu',
            adapter: { channelName: 'feishu-2', sendText: vi.fn() } as any,
            channel: {},
            connect: vi.fn(),
            disconnect: vi.fn(),
          },
        ];
      },
    };
    loader.register(plugin);

    const config: Config = { channels: { feishu: [{ name: 'feishu-1' }, { name: 'feishu-2' }] } } as any;
    const result1 = await loader.createAll(config);
    const result2 = await loader.createAll(config);

    expect(result1).toHaveLength(2);
    expect(result2).toHaveLength(2);
    expect(counter.count).toBe(2); // createChannels called once per createAll
    expect(result1[0]).not.toBe(result2[0]);
  });

  it('isEnabled=false skips plugin in all calls consistently', async () => {
    const loader = new ChannelLoader();
    const plugin: ChannelPlugin = {
      name: 'feishu',
      isEnabled: () => false,
      createChannel: vi.fn() as any,
    };
    loader.register(plugin);

    const config: Config = { channels: { feishu: {} } } as any;
    const r1 = await loader.createAll(config);
    const r2 = await loader.createAll(config);

    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });
});
