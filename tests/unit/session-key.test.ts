import { describe, it, expect } from 'vitest';
import { formatSessionKey, parseSessionKey, DEFAULT_THREAD_ID } from '../../src/core/session/session-key.js';
import { shouldAutoFillSessionTitle } from '../../src/core/session/session-title.js';

describe('session-key', () => {
  it('formats with default threadId', () => {
    expect(formatSessionKey('aun', 'alice.aid.pub')).toBe('aun#alice.aid.pub#main');
  });
  it('formats with explicit threadId', () => {
    expect(formatSessionKey('feishu', 'oc_xxx', 'thread_123')).toBe('feishu#oc_xxx#thread_123');
  });
  it('encodes special chars in channelId', () => {
    const key = formatSessionKey('aun', 'a#b/c');
    expect(key).toBe('aun#a%23b%2Fc#main');
    const parsed = parseSessionKey(key);
    expect(parsed.channelId).toBe('a#b/c');
  });
  it('round-trips', () => {
    const key = formatSessionKey('wechat', 'wxid_abc', 'topic_1');
    const parsed = parseSessionKey(key);
    expect(parsed).toEqual({ channelType: 'wechat', channelId: 'wxid_abc', threadId: 'topic_1' });
  });
  it('throws on invalid key', () => {
    expect(() => parseSessionKey('invalid')).toThrow();
    expect(() => parseSessionKey('aun#only_two')).toThrow();
  });
  it('exports DEFAULT_THREAD_ID', () => {
    expect(DEFAULT_THREAD_ID).toBe('main');
  });
});

describe('shouldAutoFillSessionTitle', () => {
  it('allows generated titles for default main sessions and unnamed topics', () => {
    expect(shouldAutoFillSessionTitle('默认会话')).toBe(true);
    expect(shouldAutoFillSessionTitle('话题会话', 'topic-1')).toBe(true);
  });

  it('does not replace explicit topic titles or treat main sessions as topics', () => {
    expect(shouldAutoFillSessionTitle('需求讨论', 'topic-1')).toBe(false);
    expect(shouldAutoFillSessionTitle('话题会话')).toBe(false);
    expect(shouldAutoFillSessionTitle('话题会话', DEFAULT_THREAD_ID)).toBe(false);
  });
});
