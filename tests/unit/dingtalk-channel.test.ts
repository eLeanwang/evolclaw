import { describe, it, expect } from 'vitest';

describe('DingTalk Config', () => {
  describe('channelTypes', () => {
    it('should include dingtalk', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('dingtalk');
    });
  });
});

describe('DingtalkChannel', () => {
  async function createChannel(opts?: any) {
    const { DingtalkChannel } = await import('../../src/channels/dingtalk.js');
    return new DingtalkChannel({ clientId: 'test', clientSecret: 'test', ...opts });
  }

  describe('webhook URL validation', () => {
    it('should accept valid DingTalk webhook URLs', async () => {
      const channel = await createChannel();
      expect(channel.isValidWebhook('https://oapi.dingtalk.com/robot/sendBySession?session=abc')).toBe(true);
      expect(channel.isValidWebhook('https://api.dingtalk.com/robot/sendBySession?session=abc')).toBe(true);
    });

    it('should reject non-DingTalk URLs', async () => {
      const channel = await createChannel();
      expect(channel.isValidWebhook('https://evil.com/robot/send')).toBe(false);
      expect(channel.isValidWebhook('http://oapi.dingtalk.com/robot/send')).toBe(false);
      expect(channel.isValidWebhook('')).toBe(false);
    });
  });

  describe('message dedup', () => {
    it('should reject duplicate msgId', async () => {
      const channel = await createChannel();
      expect(channel.isDuplicate('msg-001')).toBe(false);
      expect(channel.isDuplicate('msg-001')).toBe(true);
      expect(channel.isDuplicate('msg-002')).toBe(false);
    });
  });

  describe('chatId resolution', () => {
    it('should use conversationId for group chat', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId('2', 'cid123', 'sender456')).toBe('cid123');
    });

    it('should use senderId for DM', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId('1', 'cid123', 'sender456')).toBe('sender456');
    });
  });

  describe('group gate', () => {
    it('should pass when requireMention is false', async () => {
      const channel = await createChannel({ requireMention: false });
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(true);
    });

    it('should pass when in freeResponseChats', async () => {
      const channel = await createChannel({ freeResponseChats: ['cid1'] });
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(true);
    });

    it('should pass when isInAtList is true', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcessGroupMessage('cid1', true)).toBe(true);
    });

    it('should reject when not mentioned and not whitelisted', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(false);
    });
  });

  describe('text extraction', () => {
    it('should extract text from object format', async () => {
      const channel = await createChannel();
      expect(channel.extractText({ text: { content: 'hello' } })).toBe('hello');
    });

    it('should extract text from plain string format', async () => {
      const channel = await createChannel();
      expect(channel.extractText({ text: 'hello' })).toBe('hello');
    });

    it('should return empty string for missing text', async () => {
      const channel = await createChannel();
      expect(channel.extractText({})).toBe('');
    });
  });
});