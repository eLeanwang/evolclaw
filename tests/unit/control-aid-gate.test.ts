import { describe, it, expect } from 'vitest';
import { needsControlAidInit } from '../../src/cli/init.js';

describe('needsControlAidInit', () => {
  it('aid missing + TTY → enter init', () => {
    expect(needsControlAidInit(undefined, true)).toBe(true);
  });
  it('aid missing + no TTY → do not enter init (headless)', () => {
    expect(needsControlAidInit(undefined, false)).toBe(false);
  });
  it('aid present + TTY → no init', () => {
    expect(needsControlAidInit('ec12345.agentid.pub', true)).toBe(false);
  });
  it('aid present + no TTY → no init', () => {
    expect(needsControlAidInit('ec12345.agentid.pub', false)).toBe(false);
  });
});

import { parseOwnerAids } from '../../src/cli/init.js';

describe('parseOwnerAids', () => {
  const isValid = (aid: string) => aid.split('.').length >= 3;

  it('splits on whitespace and commas, dedups', () => {
    const r = parseOwnerAids('a.agentid.pub, b.agentid.pub a.agentid.pub', isValid);
    expect(r.valid).toEqual(['a.agentid.pub', 'b.agentid.pub']);
    expect(r.invalid).toEqual([]);
  });
  it('separates invalid AIDs', () => {
    const r = parseOwnerAids('good.agentid.pub bad', isValid);
    expect(r.valid).toEqual(['good.agentid.pub']);
    expect(r.invalid).toEqual(['bad']);
  });
  it('empty input → empty valid (treated as skip)', () => {
    const r = parseOwnerAids('   ', isValid);
    expect(r.valid).toEqual([]);
    expect(r.invalid).toEqual([]);
  });
});
