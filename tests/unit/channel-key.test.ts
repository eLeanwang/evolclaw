import { describe, it, expect } from 'vitest';
import {
  formatChannelKey, parseChannelKey, tryParseChannelKey, isValidChannelName,
} from '../../src/core/channel-loader.js';

describe('channel-key', () => {
  it('formats and parses round-trip', () => {
    const k = { type: 'feishu', selfAID: 'secretary.agentid.pub', name: 'main' };
    const s = formatChannelKey(k);
    expect(s).toBe('feishu#secretary.agentid.pub#main');
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
    const k = { type: 'aun', selfAID: 'review-bot.dept.example.agentid.pub', name: 'main' };
    expect(parseChannelKey(formatChannelKey(k))).toEqual(k);
  });

  it('tryParseChannelKey correctly parses aun#alice.aid.pub#main', () => {
    const result = tryParseChannelKey('aun#alice.aid.pub#main');
    expect(result).toEqual({ type: 'aun', selfAID: 'alice.aid.pub', name: 'main' });
  });

  it('throws if selfAID contains #', () => {
    expect(() => formatChannelKey({ type: 'aun', selfAID: 'bad#aid', name: 'main' })).toThrow(/contains '#'/);
  });
});
