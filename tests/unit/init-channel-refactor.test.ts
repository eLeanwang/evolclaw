import { describe, it, expect } from 'vitest';
import { getChannelCredentialCollector } from '../../src/utils/init-channel.js';

describe('getChannelCredentialCollector', () => {
  it('returns collector function for feishu', () => {
    const collector = getChannelCredentialCollector('feishu');
    expect(collector).toBeDefined();
    expect(typeof collector).toBe('function');
  });

  it('returns collector function for aun', () => {
    const collector = getChannelCredentialCollector('aun');
    expect(collector).toBeDefined();
  });

  it('returns collector function for wechat', () => {
    const collector = getChannelCredentialCollector('wechat');
    expect(collector).toBeDefined();
  });

  it('returns collector function for dingtalk', () => {
    const collector = getChannelCredentialCollector('dingtalk');
    expect(collector).toBeDefined();
  });

  it('returns collector function for qqbot', () => {
    const collector = getChannelCredentialCollector('qqbot');
    expect(collector).toBeDefined();
  });

  it('returns collector function for wecom', () => {
    const collector = getChannelCredentialCollector('wecom');
    expect(collector).toBeDefined();
  });

  it('returns null for unknown type', () => {
    const collector = getChannelCredentialCollector('unknown');
    expect(collector).toBeNull();
  });
});
