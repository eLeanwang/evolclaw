import { describe, it, expect } from 'vitest';

describe('QQBot Config', () => {
  describe('channelTypes', () => {
    it('should include qqbot', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('qqbot');
    });
  });
});
