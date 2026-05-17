import { describe, it, expect } from 'vitest';
import {
  formatChannelKey, parseChannelKey, tryParseChannelKey, isValidChannelName,
} from '../../src/core/channel-key.js';

describe('channel-key', () => {
  it('formats and parses round-trip', () => {
    const k = { aid: 'secretary.agentid.pub', type: 'feishu', name: 'main' };
    const s = formatChannelKey(k);
    expect(s).toBe('secretary.agentid.pub#feishu#main');
    expect(parseChannelKey(s)).toEqual(k);
  });

  it('rejects key with wrong segment count', () => {
    expect(() => parseChannelKey('foo')).toThrow();
    expect(() => parseChannelKey('a#b')).toThrow();
    expect(() => parseChannelKey('a#b#c#d')).toThrow();
  });

  it('rejects key with empty segment', () => {
    expect(() => parseChannelKey('#feishu#main')).toThrow();
    expect(() => parseChannelKey('aid##main')).toThrow();
    expect(() => parseChannelKey('aid#feishu#')).toThrow();
  });

  it('tryParse returns null on invalid', () => {
    expect(tryParseChannelKey('not a key')).toBeNull();
    expect(tryParseChannelKey('a#b#c')).not.toBeNull();
  });

  it('isValidChannelName rejects empty / contains #', () => {
    expect(isValidChannelName('main')).toBe(true);
    expect(isValidChannelName('main-1')).toBe(true);
    expect(isValidChannelName('')).toBe(false);
    expect(isValidChannelName('main#bad')).toBe(false);
    expect(isValidChannelName(undefined as any)).toBe(false);
    expect(isValidChannelName(123 as any)).toBe(false);
  });

  it('AID with multiple dots survives round-trip', () => {
    const k = { aid: 'review-bot.dept.example.agentid.pub', type: 'aun', name: 'main' };
    expect(parseChannelKey(formatChannelKey(k))).toEqual(k);
  });
});
