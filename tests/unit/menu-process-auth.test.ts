import { describe, it, expect } from 'vitest';
import type { DefaultsConfig } from '../../src/types.js';
import { isProcessLevelOwner } from '../../src/core/command-handler.js';

describe('DefaultsConfig.owners', () => {
  it('accepts owners as string array', () => {
    const cfg: DefaultsConfig = {
      $schema_version: 1,
      owners: ['eleans-2022.agentid.pub'],
      admins: ['elean.agentid.pub'],
    };
    expect(cfg.owners).toEqual(['eleans-2022.agentid.pub']);
  });
});

describe('isProcessLevelOwner', () => {
  it('allows AID in defaults.owners', () => {
    expect(isProcessLevelOwner('a.agentid.pub', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(true);
  });
  it('rejects AID not in owners', () => {
    expect(isProcessLevelOwner('b.agentid.pub', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(false);
  });
  it('rejects when owners missing', () => {
    expect(isProcessLevelOwner('a.agentid.pub', { $schema_version: 1 })).toBe(false);
  });
  it('rejects empty peerId', () => {
    expect(isProcessLevelOwner('', { $schema_version: 1, owners: ['a.agentid.pub'] })).toBe(false);
  });
  it('rejects null defaults', () => {
    expect(isProcessLevelOwner('a.agentid.pub', null)).toBe(false);
  });
});

