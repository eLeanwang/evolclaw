import { describe, it, expect } from 'vitest';

describe('QQBot Config', () => {
  describe('channelTypes', () => {
    it('should include qqbot', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('qqbot');
    });
  });
});

describe('QQBotChannel', () => {
  async function createChannel(opts?: any) {
    const { QQBotChannel } = await import('../../src/channels/qqbot.js');
    return new QQBotChannel({ appId: 'test', clientSecret: 'test', ...opts });
  }

  describe('message dedup', () => {
    it('should reject duplicate messageId', async () => {
      const channel = await createChannel();
      expect(channel.isDuplicate('msg-001')).toBe(false);
      expect(channel.isDuplicate('msg-001')).toBe(true);
      expect(channel.isDuplicate('msg-002')).toBe(false);
    });
  });

  describe('chatId resolution', () => {
    it('should use groupOpenid for group chat', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId({
        type: 'group', senderId: 'user1', groupOpenid: 'group1',
        content: 'hi', messageId: 'm1', timestamp: '0',
      })).toBe('group1');
    });

    it('should use senderId for C2C', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId({
        type: 'c2c', senderId: 'user1',
        content: 'hi', messageId: 'm1', timestamp: '0',
      })).toBe('user1');
    });
  });

  describe('event type filter', () => {
    it('should accept c2c events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('c2c')).toBe(true);
    });

    it('should accept group events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('group')).toBe(true);
    });

    it('should reject guild events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('guild')).toBe(false);
    });

    it('should reject dm events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('dm')).toBe(false);
    });
  });
});

describe('QQBotChannelPlugin', () => {
  describe('isEnabled', () => {
    it('should return false when no qqbot config', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      expect(plugin.isEnabled({ projects: { defaultPath: '/tmp', autoCreate: false } } as any)).toBe(false);
    });

    it('should return true with valid credentials', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'abc', clientSecret: 'xyz' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(true);
    });

    it('should return false when explicitly disabled', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'abc', clientSecret: 'xyz', enabled: false } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(false);
    });

    it('should return true with array form if any instance valid', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: [
          { name: 'qq1', appId: '', clientSecret: '' },
          { name: 'qq2', appId: 'abc', clientSecret: 'xyz' },
        ] },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(true);
    });

    it('should return false with placeholder credentials', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'your-app-id', clientSecret: 'your-secret' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(false);
    });
  });

  describe('name', () => {
    it('should be qqbot', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      expect(plugin.name).toBe('qqbot');
    });
  });
});
