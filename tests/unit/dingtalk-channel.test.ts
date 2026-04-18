import { describe, it, expect } from 'vitest';

describe('DingTalk Config', () => {
  describe('channelTypes', () => {
    it('should include dingtalk', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('dingtalk');
    });
  });
});
