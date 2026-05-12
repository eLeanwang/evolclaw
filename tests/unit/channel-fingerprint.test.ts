import { describe, it, expect } from 'vitest';
import { extractFingerprint, detectDuplicates } from '../../src/utils/channel-fingerprint.js';

describe('extractFingerprint', () => {
  it('extracts feishu fingerprint by appId', () => {
    expect(extractFingerprint('feishu', { appId: 'cli_abc', appSecret: 's' }))
      .toBe('feishu:cli_abc');
  });

  it('extracts aun fingerprint by aid', () => {
    expect(extractFingerprint('aun', { aid: 'review.agentid.pub' }))
      .toBe('aun:review.agentid.pub');
  });

  it('extracts wechat fingerprint by token', () => {
    expect(extractFingerprint('wechat', { token: 'xyz' }))
      .toBe('wechat:xyz');
  });

  it('extracts wecom fingerprint by botId', () => {
    expect(extractFingerprint('wecom', { botId: 'b1', secret: 's' }))
      .toBe('wecom:b1');
  });

  it('extracts dingtalk fingerprint by clientId', () => {
    expect(extractFingerprint('dingtalk', { clientId: 'c1' }))
      .toBe('dingtalk:c1');
  });

  it('extracts qqbot fingerprint by appId', () => {
    expect(extractFingerprint('qqbot', { appId: '1234' }))
      .toBe('qqbot:1234');
  });

  it('returns null for missing primary key', () => {
    expect(extractFingerprint('feishu', { appSecret: 's' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(extractFingerprint('unknown' as any, { key: 'v' })).toBeNull();
  });
});

describe('detectDuplicates', () => {
  it('returns empty when all fingerprints are unique', () => {
    const config = {
      channels: {
        feishu: [
          { name: 'f1', appId: 'a', appSecret: 's' },
          { name: 'f2', appId: 'b', appSecret: 's' },
        ],
      },
    };
    expect(detectDuplicates(config as any)).toEqual([]);
  });

  it('detects duplicate appId across instances', () => {
    const config = {
      channels: {
        feishu: [
          { name: 'f1', appId: 'dup', appSecret: 's1' },
          { name: 'f2', appId: 'dup', appSecret: 's2' },
        ],
      },
    };
    const result = detectDuplicates(config as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fingerprint: 'feishu:dup',
      instances: ['f1', 'f2'],
    });
  });

  it('handles single-object channel config', () => {
    const config = {
      channels: {
        wechat: { token: 'dup' },
        wecom: [{ name: 'w1', botId: 'b1', secret: 's' }],
      },
    };
    expect(detectDuplicates(config as any)).toEqual([]);
  });
});
