import { describe, it, expect } from 'vitest';
import { formatPeerKey, parsePeerKey } from '../../src/core/relation/peer-key.js';

describe('peer-key', () => {
  it('formats and parses round-trip (simple channelId)', () => {
    const key = formatPeerKey('aun', 'alice.aid.pub');
    expect(key).toBe('aun#alice.aid.pub');
    expect(parsePeerKey(key)).toEqual({ channelType: 'aun', channelId: 'alice.aid.pub' });
  });

  it('formats and parses round-trip (channelId with special chars)', () => {
    const key = formatPeerKey('feishu', 'oc#xx');
    expect(key).toBe('feishu#oc%23xx');
    expect(parsePeerKey(key)).toEqual({ channelType: 'feishu', channelId: 'oc#xx' });
  });

  it('formats and parses round-trip (channelId with /)', () => {
    const key = formatPeerKey('wechat', 'user/123');
    expect(key).toBe('wechat#user%2F123');
    expect(parsePeerKey(key)).toEqual({ channelType: 'wechat', channelId: 'user/123' });
  });

  it('parsePeerKey throws on invalid key (no #)', () => {
    expect(() => parsePeerKey('invalid')).toThrow(/Invalid peer key/);
  });

  it('parsePeerKey throws on key starting with #', () => {
    expect(() => parsePeerKey('#foo')).toThrow(/Invalid peer key/);
  });

  it('handles channelId with multiple special characters', () => {
    const channelId = 'ou_abc#def/ghi?jkl';
    const key = formatPeerKey('dingtalk', channelId);
    const parsed = parsePeerKey(key);
    expect(parsed.channelType).toBe('dingtalk');
    expect(parsed.channelId).toBe(channelId);
  });
});
