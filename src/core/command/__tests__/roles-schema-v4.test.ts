import { describe, expect, it } from 'vitest';
import { loadSchema } from '../../../config/schema-registry.js';

describe('roles schema v4', () => {
  it('should load with the current schema registry', () => {
    const schema = loadSchema('roles');
    expect(schema.version).toBe(4);
    expect(schema.permission).toBe('H');
    expect(schema.scope).toBe('roles');
  });

  it('should reject unknown top-level fields', () => {
    const schema = loadSchema('roles');
    const valid = schema.validate({
      $schema_version: 4,
      roles: {},
      unexpected: true,
    });
    expect(valid).toBe(false);
  });
});
