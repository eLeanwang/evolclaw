import { describe, it, expect } from 'vitest';
import {
  shortLogName, deriveLogTypes, computePreChecked, validateLogTypes, filterLogFiles,
} from '../../src/cli/watch-logs.js';

describe('shortLogName', () => {
  it('strips rotation suffix', () => {
    expect(shortLogName('evolclaw-20260518-21.log')).toBe('evolclaw');
  });
  it('keeps plain name', () => {
    expect(shortLogName('aun.log')).toBe('aun');
  });
});

describe('deriveLogTypes', () => {
  it('dedups and sorts types', () => {
    const files = ['evolclaw.log', 'evolclaw-20260610-03.log', 'aun.log', 'channel-in-20260610-04.log'];
    expect(deriveLogTypes(files)).toEqual(['aun', 'channel-in', 'evolclaw']);
  });
});

describe('computePreChecked', () => {
  const types = ['aun', 'channel-in', 'evolclaw'];
  it('checks all when saved is undefined', () => {
    expect([...computePreChecked(types, undefined)].sort()).toEqual(['aun', 'channel-in', 'evolclaw']);
  });
  it('checks only saved, new types unchecked', () => {
    expect([...computePreChecked(types, ['aun'])].sort()).toEqual(['aun']);
  });
});

describe('validateLogTypes', () => {
  const available = ['aun', 'evolclaw'];
  it('returns empty for all-valid', () => {
    expect(validateLogTypes(['aun'], available)).toEqual([]);
  });
  it('returns invalid ones', () => {
    expect(validateLogTypes(['aun', 'nope'], available)).toEqual(['nope']);
  });
});

describe('filterLogFiles', () => {
  it('keeps only files whose type is selected', () => {
    const files = ['/l/evolclaw-20260610-03.log', '/l/aun.log', '/l/stdout.log'];
    expect(filterLogFiles(files, new Set(['evolclaw', 'aun']))).toEqual(['/l/evolclaw-20260610-03.log', '/l/aun.log']);
  });
});
