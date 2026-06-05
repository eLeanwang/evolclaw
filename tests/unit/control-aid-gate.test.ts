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
