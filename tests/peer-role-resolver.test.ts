import { describe, expect, it } from 'vitest';
import {
  assignmentKey,
  deleteRoleAssignment,
  getFirstRoleAssignment,
  getRoleAssignment,
  listRoleAssignments,
  readRoleAssignments,
  setRoleAssignment,
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
  const channelKey = 'aun#bot.agentid.pub#main';
  const peerId = 'alice.aid.pub';

  it('stores assignments under channelKey and peerId', () => {
    const item = setRoleAssignment(aid, channelKey, peerId, 'owner', { note: 'test' });

    expect(assignmentKey(channelKey, peerId)).toBe(`${channelKey}::${peerId}`);
    expect(item.role).toBe('owner');
    expect(item.note).toBe('test');
    expect(getRoleAssignment(aid, channelKey, peerId)?.role).toBe('owner');
    expect(readRoleAssignments(aid).assignments[assignmentKey(channelKey, peerId)]).toBeDefined();
  });

  it('filters assignments by channel and role', () => {
    setRoleAssignment(aid, channelKey, 'owner.aid.pub', 'owner');
    setRoleAssignment(aid, channelKey, 'admin.aid.pub', 'admin');
    setRoleAssignment(aid, 'feishu#bot.agentid.pub#main', 'owner.aid.pub', 'member');

    expect(listRoleAssignments(aid, channelKey)).toHaveLength(2);
    expect(listRoleAssignments(aid, channelKey, 'owner')).toHaveLength(1);
    expect(getFirstRoleAssignment(aid, channelKey, 'owner')?.peerId).toBe('owner.aid.pub');
  });

  it('deletes only the exact channel assignment', () => {
    setRoleAssignment(aid, channelKey, peerId, 'owner');
    setRoleAssignment(aid, 'feishu#bot.agentid.pub#main', peerId, 'admin');

    expect(deleteRoleAssignment(aid, channelKey, peerId)).toBe(true);
    expect(getRoleAssignment(aid, channelKey, peerId)).toBeUndefined();
    expect(getRoleAssignment(aid, 'feishu#bot.agentid.pub#main', peerId)?.role).toBe('admin');
  });

  it('rejects unknown role names at write time', () => {
    expect(() => setRoleAssignment(aid, channelKey, peerId, 'not-a-role')).toThrow('Unknown role');
  });
});

describe('peer role resolver', () => {
  const aid = 'resolver.agentid.pub';
  const channelKey = 'aun#resolver.agentid.pub#main';

  it('uses role-assignments as the sole explicit role source', () => {
    setRoleAssignment(aid, channelKey, 'owner.aid.pub', 'owner');

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelKey,
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

  it('falls back to guest for authenticated peers without assignment', () => {
    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelKey,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'guest.aid.pub',
      conversationId: 'guest.aid.pub',
    });

    expect(detail.effectiveRole).toBe('guest');
    expect(detail.source).toBe('guest');
    expect(detail.isAuthenticated).toBe(true);
  });

  it('uses roles.defaultRole for unauthenticated peers', () => {
    write(ConfigTarget.Roles, {
      $schema_version: 2,
      defaultRole: 'guest',
      roles: {},
    });

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelKey,
      channelType: 'feishu',
      chatType: 'private',
      actorId: 'ou_123',
      conversationId: 'ou_123',
    });

    expect(detail.effectiveRole).toBe('guest');
    expect(detail.source).toBe('default');
    expect(detail.isAuthenticated).toBe(false);
  });

  it('denies access for roles with allowAccess false', () => {
    write(ConfigTarget.Roles, {
      $schema_version: 2,
      roles: {
        suspended: {
          description: 'blocked peer',
          allowAccess: false,
          permissions: {},
        },
      },
    });
    setRoleAssignment(aid, channelKey, 'blocked.aid.pub', 'suspended');

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelKey,
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
