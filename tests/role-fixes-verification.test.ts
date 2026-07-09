import { describe, expect, it } from 'vitest';
import { ConfigTarget, validateConfig } from '../src/config/config-manager.js';

describe('role source cleanup verification', () => {
  it('accepts static agent owner/admin fields', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'clean.agentid.pub',
      channels: [],
      owners: ['alice.aid.pub'],
      admins: ['ops.aid.pub'],
    })).toEqual([]);
  });

  it('accepts relation roles through roles.assigned and roles.members', () => {
    expect(validateConfig(ConfigTarget.Relation, {
      roles: {
        assigned: 'member',
        members: {
          'alice.aid.pub': 'visitor',
        },
      },
    })).toEqual([]);
  });

  it('rejects management roles in relation user-role assignments', () => {
    expect(validateConfig(ConfigTarget.Relation, {
      roles: { assigned: 'owner' },
    })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Relation, {
      roles: { members: { 'alice.aid.pub': 'admin' } },
    })).not.toEqual([]);
  });

  it('rejects custom definitions that reuse management role names', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'clean.agentid.pub',
      channels: [],
      roles: {
        definitions: {
          owner: {
            description: 'must not be user-defined',
            allowAccess: true,
            permissions: {},
          },
        },
      },
    })).not.toEqual([]);
  });
});
