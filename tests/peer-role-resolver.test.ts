import { describe, expect, it } from 'vitest';
import {
  deleteGroupMemberRoleAssignment,
  deleteGroupRoleAssignment,
  deletePrivateRoleAssignment,
  getFirstRoleAssignment,
  getGroupMemberRoleAssignment,
  getGroupRoleAssignment,
  getPrivateRoleAssignment,
  groupAssignmentKey,
  groupMemberAssignmentKey,
  listRoleAssignments,
  privateAssignmentKey,
  readRoleAssignments,
  setGroupMemberRoleAssignment,
  setGroupRoleAssignment,
  setPrivateRoleAssignment,
} from '../src/config/role-assignments.js';
import {
  checkRoleAccess,
  isAuthenticated,
  resolvePeerRoleDetail,
  roleToSessionIdentity,
} from '../src/config/peer-role-resolver.js';
import { write, ConfigTarget } from '../src/config/config-manager.js';

describe('peer role assignments', () => {
  const aid = 'bot.agentid.pub';

  it('stores private assignments under peer scope', () => {
    const item = setPrivateRoleAssignment(aid, 'alice.aid.pub', 'owner', { note: 'test' });

    expect(privateAssignmentKey('alice.aid.pub')).toBe('private::alice.aid.pub');
    expect(item.role).toBe('owner');
    expect(item.scope).toBe('private');
    expect(item.note).toBe('test');
    expect(getPrivateRoleAssignment(aid, 'alice.aid.pub')?.role).toBe('owner');
    expect(readRoleAssignments(aid).assignments[privateAssignmentKey('alice.aid.pub')]).toBeDefined();
  });

  it('stores group and group-member assignments under separate scopes', () => {
    setGroupRoleAssignment(aid, 'group.team', 'guest');
    setGroupMemberRoleAssignment(aid, 'group.team', 'alice.aid.pub', 'admin');

    expect(groupAssignmentKey('group.team')).toBe('group::group.team');
    expect(groupMemberAssignmentKey('group.team', 'alice.aid.pub')).toBe('group-member::group.team::alice.aid.pub');
    expect(getGroupRoleAssignment(aid, 'group.team')?.role).toBe('guest');
    expect(getGroupMemberRoleAssignment(aid, 'group.team', 'alice.aid.pub')?.role).toBe('admin');
  });

  it('filters assignments by scope and role', () => {
    setPrivateRoleAssignment(aid, 'owner.aid.pub', 'owner');
    setPrivateRoleAssignment(aid, 'admin.aid.pub', 'admin');
    setGroupMemberRoleAssignment(aid, 'group.team', 'owner.aid.pub', 'member');

    expect(listRoleAssignments(aid, { scope: 'private' })).toHaveLength(2);
    expect(listRoleAssignments(aid, { scope: 'private', role: 'owner' }).map(a => a.peerId)).toContain('owner.aid.pub');
    expect(getFirstRoleAssignment(aid, { scope: 'group-member', groupId: 'group.team', peerId: 'owner.aid.pub' })?.role).toBe('member');
  });

  it('deletes only the exact scoped assignment', () => {
    setPrivateRoleAssignment(aid, 'same.aid.pub', 'owner');
    setGroupRoleAssignment(aid, 'group.team', 'guest');
    setGroupMemberRoleAssignment(aid, 'group.team', 'same.aid.pub', 'admin');

    expect(deletePrivateRoleAssignment(aid, 'same.aid.pub')).toBe(true);
    expect(getPrivateRoleAssignment(aid, 'same.aid.pub')).toBeUndefined();
    expect(getGroupMemberRoleAssignment(aid, 'group.team', 'same.aid.pub')?.role).toBe('admin');

    expect(deleteGroupMemberRoleAssignment(aid, 'group.team', 'same.aid.pub')).toBe(true);
    expect(deleteGroupRoleAssignment(aid, 'group.team')).toBe(true);
  });

  it('rejects unknown role names at write time', () => {
    expect(() => setPrivateRoleAssignment(aid, 'alice.aid.pub', 'not-a-role')).toThrow('Unknown role');
  });
});

describe('peer role resolver', () => {
  const aid = 'resolver.agentid.pub';

  it('uses static agent owners before scoped role assignments', () => {
    const staticAid = 'static-owner.agentid.pub';
    const owner = 'root.agentid.pub';
    write(ConfigTarget.Agent, {
      aid: staticAid,
      channels: [],
      owners: [owner],
    }, { self: staticAid });
    setPrivateRoleAssignment(staticAid, owner, 'guest');
    setGroupMemberRoleAssignment(staticAid, 'team.group', owner, 'member');

    expect(resolvePeerRoleDetail({
      selfAid: staticAid,
      channelType: 'aun',
      chatType: 'private',
      actorId: owner,
      conversationId: owner,
    })).toMatchObject({ effectiveRole: 'owner', source: 'agent-config-owner' });

    expect(resolvePeerRoleDetail({
      selfAid: staticAid,
      channelType: 'aun',
      chatType: 'group',
      actorId: owner,
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'owner', source: 'agent-config-owner' });
  });

  it('uses private role assignments as explicit private role source', () => {
    setPrivateRoleAssignment(aid, 'owner.aid.pub', 'owner');

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'owner.aid.pub',
      conversationId: 'owner.aid.pub',
    });

    expect(detail.effectiveRole).toBe('owner');
    expect(detail.source).toBe('assignment');
    expect(detail.allowAccess).toBe(true);
    expect(roleToSessionIdentity(detail.effectiveRole)).toEqual({ role: 'owner', mode: 'interactive' });
  });

  it('falls back to private default role without private assignment', () => {
    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'guest.aid.pub',
      conversationId: 'guest.aid.pub',
    });

    expect(detail.effectiveRole).toBe('anonymous');
    expect(detail.source).toBe('default');
    expect(detail.isAuthenticated).toBe(true);
  });

  it('uses configured defaultRoles.private for unauthenticated private peers', () => {
    write(ConfigTarget.Roles, {
      $schema_version: 3,
      defaultRoles: { private: 'guest', group: 'guest' },
      roles: {},
    });

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'feishu',
      chatType: 'private',
      actorId: 'ou_123',
      conversationId: 'ou_123',
    });

    expect(detail.effectiveRole).toBe('guest');
    expect(detail.source).toBe('default');
    expect(detail.isAuthenticated).toBe(false);
  });

  it('resolves group members by member assignment, private inheritance, group role, then group default', () => {
    setGroupRoleAssignment(aid, 'team.group', 'guest');
    setPrivateRoleAssignment(aid, 'private-owner.aid.pub', 'owner');
    setGroupMemberRoleAssignment(aid, 'team.group', 'member-admin.aid.pub', 'admin');

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'member-admin.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'admin', source: 'assignment' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'private-owner.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'owner', source: 'private-inherited' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'plain-member.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'guest', source: 'group-default' });
  });

  it('denies access for roles with allowAccess false', () => {
    write(ConfigTarget.Roles, {
      $schema_version: 3,
      defaultRoles: { private: 'anonymous', group: 'guest' },
      roles: {
        suspended: {
          description: 'blocked peer',
          allowAccess: false,
          permissions: {},
        },
      },
    });
    setPrivateRoleAssignment(aid, 'blocked.aid.pub', 'suspended');

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'blocked.aid.pub',
      conversationId: 'blocked.aid.pub',
    });

    expect(detail.effectiveRole).toBe('suspended');
    expect(detail.allowAccess).toBe(false);
    expect(checkRoleAccess('suspended')).toBe(false);
  });

  it('recognizes only signed AID-style actors as authenticated', () => {
    expect(isAuthenticated('alice.aid.pub')).toBe(true);
    expect(isAuthenticated('bot.agentid.pub')).toBe(true);
    expect(isAuthenticated('ou_123')).toBe(false);
  });
});
