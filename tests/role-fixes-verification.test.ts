import { describe, expect, it } from 'vitest';
import { ConfigTarget, read, validateConfig } from '../src/config/config-manager.js';
import { setRoleAssignment, writeRoleAssignments } from '../src/config/role-assignments.js';

describe('role source cleanup verification', () => {
  it('rejects old agent-level role assignment lists', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'legacy.agentid.pub',
      channels: [],
      owners: ['alice.aid.pub'],
    })).not.toEqual([]);

    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'legacy.agentid.pub',
      channels: [],
      admins: ['alice.aid.pub'],
    })).not.toEqual([]);

    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'legacy.agentid.pub',
      channels: [],
      members: ['alice.aid.pub'],
    })).not.toEqual([]);
  });

  it('rejects relation-level role assignment fields', () => {
    expect(validateConfig(ConfigTarget.Relation, { role: 'owner' })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Relation, { owners: ['alice.aid.pub'] })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Relation, { admins: ['alice.aid.pub'] })).not.toEqual([]);
  });

  it('accepts role-assignments config as the assignment source', () => {
    const aid = 'clean.agentid.pub';
    const channelKey = 'aun#clean.agentid.pub#main';
    const peerId = 'alice.aid.pub';

    setRoleAssignment(aid, channelKey, peerId, 'owner');
    const config = read<any>(ConfigTarget.RoleAssignments, { self: aid });

    expect(validateConfig(ConfigTarget.RoleAssignments, config)).toEqual([]);
    expect(config.assignments[`${channelKey}::${peerId}`].role).toBe('owner');
  });

  it('rejects malformed role assignment keys through role assignment writes', () => {
    expect(() => writeRoleAssignments('bad.agentid.pub', {
      $schema_version: 1,
      assignments: {
        wrong: { channelKey: 'aun#x#main', peerId: 'alice.aid.pub', role: 'owner' },
      },
    })).toThrow('Invalid role assignment key');
  });
});
