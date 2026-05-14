import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildReloadHooks } from '../../src/core/reload-hooks.js';
import type { ChannelInstance } from '../../src/core/channel-loader.js';

describe('buildReloadHooks (e2e)', () => {
  let channelInstances: ChannelInstance[];
  let registerChannelInstance: any;
  let channelLoader: any;

  beforeEach(() => {
    channelInstances = [];
    registerChannelInstance = vi.fn();
    channelLoader = {
      createAll: vi.fn(),
    };
  });

  function makeMockInstance(channelName: string): ChannelInstance {
    return {
      adapter: { channelName, sendText: vi.fn() } as any,
      channel: {} as any,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
  }

  describe('drainChannel', () => {
    it('logs and waits the configured delay', async () => {
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 50 });
      const start = Date.now();
      await hooks.drainChannel('test-fs');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(45);
    });

    it('drainDelayMs=0 returns immediately', async () => {
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      const start = Date.now();
      await hooks.drainChannel('test-fs');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(20);
    });
  });

  describe('disconnectChannel', () => {
    it('calls disconnect and removes from channelInstances', async () => {
      const inst = makeMockInstance('feishu-review');
      channelInstances.push(inst);

      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await hooks.disconnectChannel('feishu-review');

      expect(inst.disconnect).toHaveBeenCalled();
      expect(channelInstances).toHaveLength(0);
    });

    it('skips when channel not found', async () => {
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await expect(hooks.disconnectChannel('nonexistent')).resolves.toBeUndefined();
    });

    it('throws on disconnect failure', async () => {
      const inst = makeMockInstance('feishu-fail');
      inst.disconnect = vi.fn().mockRejectedValue(new Error('TCP error'));
      channelInstances.push(inst);

      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await expect(hooks.disconnectChannel('feishu-fail')).rejects.toThrow('TCP error');
    });
  });

  describe('startChannel', () => {
    function makeAgent(name: string, channels: any) {
      return { name, config: { agents: {}, channels, projects: { defaultPath: '/tmp' } } };
    }

    it('creates and connects a new channel', async () => {
      const newInst = makeMockInstance('feishu-new');
      channelLoader.createAll.mockResolvedValue([newInst]);

      const agent = makeAgent('bot', {
        feishu: [{ name: 'feishu-new', appId: 'x', appSecret: 'y' }],
      });

      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await hooks.startChannel(agent, 'feishu-new');

      expect(channelLoader.createAll).toHaveBeenCalled();
      expect(newInst.connect).toHaveBeenCalled();
      expect(registerChannelInstance).toHaveBeenCalledWith(newInst);
      expect(channelInstances).toContain(newInst);
    });

    it('throws when channel not found in agent config', async () => {
      const agent = makeAgent('bot', { feishu: [{ name: 'a', appId: 'x', appSecret: 'y' }] });
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await expect(hooks.startChannel(agent, 'nonexistent')).rejects.toThrow(/not found in agent/);
    });

    it('throws when createAll returns no matching instance', async () => {
      channelLoader.createAll.mockResolvedValue([]);
      const agent = makeAgent('bot', { feishu: [{ name: 'feishu-x', appId: 'a', appSecret: 'b' }] });
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await expect(hooks.startChannel(agent, 'feishu-x')).rejects.toThrow(/Failed to create/);
    });

    it('handles single-object channel form', async () => {
      const newInst = makeMockInstance('aun');
      channelLoader.createAll.mockResolvedValue([newInst]);

      const agent = makeAgent('bot', {
        aun: { aid: 'bot.agentid.pub' },  // object form, no name field
      });

      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await hooks.startChannel(agent, 'aun');  // name defaults to type

      expect(newInst.connect).toHaveBeenCalled();
      expect(channelInstances).toContain(newInst);
    });

    it('connect failure propagates', async () => {
      const newInst = makeMockInstance('feishu-bad');
      newInst.connect = vi.fn().mockRejectedValue(new Error('auth failed'));
      channelLoader.createAll.mockResolvedValue([newInst]);

      const agent = makeAgent('bot', { feishu: [{ name: 'feishu-bad', appId: 'x', appSecret: 'y' }] });
      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });
      await expect(hooks.startChannel(agent, 'feishu-bad')).rejects.toThrow(/auth failed/);
    });
  });

  describe('integration: full reload cycle', () => {
    it('disconnect old + start new + verify channelInstances state', async () => {
      const oldInst = makeMockInstance('feishu-old');
      channelInstances.push(oldInst);

      const newInst = makeMockInstance('feishu-new');
      channelLoader.createAll.mockResolvedValue([newInst]);

      const agent = { name: 'bot', config: {
        agents: {},
        channels: { feishu: [{ name: 'feishu-new', appId: 'x', appSecret: 'y' }] },
        projects: { defaultPath: '/tmp' },
      }};

      const hooks = buildReloadHooks({ channelLoader, channelInstances, registerChannelInstance, drainDelayMs: 0 });

      await hooks.drainChannel('feishu-old');
      await hooks.disconnectChannel('feishu-old');
      await hooks.startChannel(agent, 'feishu-new');

      expect(channelInstances).toHaveLength(1);
      expect(channelInstances[0]).toBe(newInst);
      expect(oldInst.disconnect).toHaveBeenCalled();
      expect(newInst.connect).toHaveBeenCalled();
    });
  });
});
