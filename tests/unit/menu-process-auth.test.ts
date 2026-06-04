import { describe, it, expect } from 'vitest';
import type { DefaultsConfig } from '../../src/types.js';

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
