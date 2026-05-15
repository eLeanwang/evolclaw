import { describe, it, expect } from 'vitest';
import { getChannelCredentialCollector, type ChannelCredentialCollector } from '../../src/utils/init-channel.js';

describe('getChannelCredentialCollector', () => {
  const knownTypes = ['feishu', 'aun', 'wechat', 'wecom', 'dingtalk', 'qqbot'];

  for (const type of knownTypes) {
    it(`returns a function for known channel type: ${type}`, () => {
      const collector = getChannelCredentialCollector(type);
      expect(collector).toBeTypeOf('function');
    });
  }

  it('returns null for unknown channel type', () => {
    expect(getChannelCredentialCollector('unknown')).toBeNull();
    expect(getChannelCredentialCollector('')).toBeNull();
  });

  it('all collectors share the same arity (no args, returns Promise)', () => {
    for (const type of knownTypes) {
      const collector = getChannelCredentialCollector(type)!;
      expect(collector.length).toBe(0); // no required args
    }
  });
});
