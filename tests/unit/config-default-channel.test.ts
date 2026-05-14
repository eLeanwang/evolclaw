import { describe, it, expect } from 'vitest';
import { parseDefaultChannelRef, validateDefaultChannelRef, validateConfigIntegrity } from '../../src/config.js';

describe('parseDefaultChannelRef', () => {
  it('parses bare type', () => {
    expect(parseDefaultChannelRef('feishu')).toEqual({ type: 'feishu' });
  });

  it('parses type/instance form', () => {
    expect(parseDefaultChannelRef('feishu/feilun')).toEqual({ type: 'feishu', instance: 'feilun' });
  });

  it('handles trailing slash with empty instance', () => {
    expect(parseDefaultChannelRef('feishu/')).toEqual({ type: 'feishu', instance: '' });
  });

  it('handles multi-segment instance after first slash', () => {
    // first '/' is the separator; everything after is treated as instance name
    expect(parseDefaultChannelRef('aun/inst/with/slashes')).toEqual({
      type: 'aun',
      instance: 'inst/with/slashes',
    });
  });
});

describe('validateDefaultChannelRef', () => {
  const singleInst = {
    feishu: [{ name: 'fs', appId: 'a', appSecret: 's' }],
  };
  const multiInst = {
    feishu: [
      { name: 'fs1', appId: 'a1', appSecret: 's' },
      { name: 'fs2', appId: 'a2', appSecret: 's' },
    ],
  };
  const empty = {};

  it('rejects unknown channel type', () => {
    const err = validateDefaultChannelRef('matrix', singleInst);
    expect(err).toMatch(/unknown channel type/);
  });

  it('rejects when channel block has no instances of that type', () => {
    const err = validateDefaultChannelRef('feishu', empty);
    expect(err).toMatch(/has no instances/);
  });

  it('accepts single instance with bare-type ref', () => {
    expect(validateDefaultChannelRef('feishu', singleInst)).toBeNull();
  });

  it('rejects bare-type ref when multiple instances exist (ambiguous)', () => {
    const err = validateDefaultChannelRef('feishu', multiInst);
    expect(err).toMatch(/ambiguous/);
  });

  it('accepts type/instance ref pointing to existing instance', () => {
    expect(validateDefaultChannelRef('feishu/fs1', multiInst)).toBeNull();
    expect(validateDefaultChannelRef('feishu/fs', singleInst)).toBeNull();
  });

  it('rejects type/instance ref pointing to nonexistent instance', () => {
    const err = validateDefaultChannelRef('feishu/missing', multiInst);
    expect(err).toMatch(/no instance named/);
  });
});

describe('validateConfigIntegrity defaultChannel branches', () => {
  function baseValid(extra?: any): any {
    return {
      agents: { defaultAgent: 'claude', claude: {} },
      projects: { defaultPath: '/home/u/p' },
      channels: { feishu: [{ name: 'fs', appId: 'a', appSecret: 's' }] },
      ...extra,
    };
  }

  it('flags zero channels with "no channel instances configured"', () => {
    const cfg = baseValid({ channels: {} });
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no channel instances configured/);
  });

  it('single channel instance with no defaultChannel passes', () => {
    const cfg = baseValid();
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('multi-instance with no defaultChannel reports missing defaultChannel', () => {
    const cfg = baseValid({
      channels: {
        feishu: [{ name: 'fs1', appId: 'a1', appSecret: 's' }],
        aun: [{ name: 'aun1', aid: 'x.agentid.pub' }],
      },
    });
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/Missing channels\.defaultChannel/);
  });

  it('multi-instance with valid defaultChannel passes', () => {
    const cfg = baseValid({
      channels: {
        defaultChannel: 'feishu',
        feishu: [{ name: 'fs1', appId: 'a1', appSecret: 's' }],
        aun: [{ name: 'aun1', aid: 'x.agentid.pub' }],
      },
    });
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(true);
    const reasons = result.reasons.join(' ');
    expect(reasons).not.toMatch(/defaultChannel/);
  });

  it('multi-instance with invalid defaultChannel surfaces the validateDefaultChannelRef error', () => {
    const cfg = baseValid({
      channels: {
        defaultChannel: 'feishu',  // ambiguous: 2 feishu instances
        feishu: [
          { name: 'fs1', appId: 'a1', appSecret: 's' },
          { name: 'fs2', appId: 'a2', appSecret: 's' },
        ],
      },
    });
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/ambiguous/);
  });

  it('single channel instance with invalid defaultChannel still surfaces error', () => {
    const cfg = baseValid({
      channels: {
        defaultChannel: 'feishu/missing',
        feishu: [{ name: 'fs', appId: 'a', appSecret: 's' }],
      },
    });
    const result = validateConfigIntegrity(cfg);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no instance named/);
  });
});
