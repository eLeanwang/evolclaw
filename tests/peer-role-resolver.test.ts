import { describe, expect, it } from 'vitest';
import { formatPeerKey } from '../src/core/relation/peer-identity.js';
import {
  addStaticAgentOwner,
  checkRoleAccess,
  isAuthenticated,
  resolvePeerRoleDetail,
  roleToSessionIdentity,
} from '../src/config/peer-role-resolver.js';
import { ConfigTarget, write } from '../src/config/config-manager.js';

describe('peer role resolver', () => {
  const aid = 'resolver.agentid.pub';

  function writeAgent(extra: Record<string, unknown> = {}) {
    write(ConfigTarget.Agent, {
      aid,
      channels: [],
      ...extra,
    }, { self: aid });
  }

  function writeRelation(channelId: string, value: Record<string, unknown>) {
    write(ConfigTarget.Relation, value, {
      self: aid,
      peerKey: formatPeerKey('aun', channelId),
    });
  }

  it('uses static agent owners and admins before relation roles', () => {
    const owner = 'root.agentid.pub';
    const admin = 'ops.agentid.pub';
    writeAgent({ owners: [owner], admins: [admin] });
    writeRelation(owner, { roles: { assigned: 'visitor' } });
    writeRelation(admin, { roles: { assigned: 'member' } });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: owner,
      conversationId: owner,
    })).toMatchObject({ effectiveRole: 'owner', source: 'agent-config-owner' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: admin,
      conversationId: admin,
    })).toMatchObject({ effectiveRole: 'admin', source: 'agent-config-admin' });
  });

  it('can append static owners through the resolver helper', () => {
    writeAgent();
    addStaticAgentOwner(aid, 'alice.agentid.pub');

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'alice.agentid.pub',
      conversationId: 'alice.agentid.pub',
    })).toMatchObject({ effectiveRole: 'owner', source: 'agent-config-owner' });
  });

  it('uses private relation assigned role as explicit private role source', () => {
    writeAgent();
    writeRelation('member.aid.pub', { roles: { assigned: 'member' } });

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'member.aid.pub',
      conversationId: 'member.aid.pub',
    });

    expect(detail.effectiveRole).toBe('member');
    expect(detail.source).toBe('relation-assigned');
    expect(detail.allowAccess).toBe(true);
    expect(roleToSessionIdentity(detail.effectiveRole)).toEqual({ role: 'member', mode: 'interactive' });
  });

  it('fails closed for private peers without an assigned role', () => {
    writeAgent();

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'plain.aid.pub',
      conversationId: 'plain.aid.pub',
    });

    expect(detail.effectiveRole).toBeNull();
    expect(detail.source).toBe('none');
    expect(detail.isAuthenticated).toBe(true);
    expect(roleToSessionIdentity(detail.effectiveRole)).toEqual({ role: 'none', mode: 'interactive' });
  });

  it('uses configured defaultRoles.private when set on agent config', () => {
    writeAgent({ roles: { defaultRoles: { private: 'visitor', group: 'visitor' } } });

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'feishu',
      chatType: 'private',
      actorId: 'ou_123',
      conversationId: 'ou_123',
    });

    expect(detail.effectiveRole).toBe('visitor');
    expect(detail.source).toBe('default');
    expect(detail.isAuthenticated).toBe(false);
  });

  it('resolves group members by member role, private inheritance, group assigned role, then denies without group default', () => {
    writeAgent();
    writeRelation('team.group', {
      roles: {
        assigned: 'visitor',
        members: { 'direct.aid.pub': 'member' },
      },
    });
    writeRelation('private-member.aid.pub', { roles: { assigned: 'member' } });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'direct.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'member', source: 'group-member' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'private-member.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'member', source: 'private-inherited' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'plain-member.aid.pub',
      conversationId: 'team.group',
    })).toMatchObject({ effectiveRole: 'visitor', source: 'group-default' });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'someone.aid.pub',
      conversationId: 'other.group',
    })).toMatchObject({ effectiveRole: null, source: 'none' });
  });

  it('uses configured defaultRoles.group when explicitly set on agent config', () => {
    writeAgent({ roles: { defaultRoles: { group: 'visitor' } } });

    expect(resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'group',
      actorId: 'someone.aid.pub',
      conversationId: 'other.group',
    })).toMatchObject({ effectiveRole: 'visitor', source: 'default' });
  });

  it('allows access for custom roles when selfAid is supplied', () => {
    writeAgent({
      roles: {
        definitions: {
          reviewer: {
            description: 'custom reviewer',
            allowAccess: true,
            permissions: {},
          },
        },
      },
    });

    expect(checkRoleAccess('reviewer')).toBe(false);
    expect(checkRoleAccess('reviewer', aid)).toBe(true);
  });

  it('denies access for custom roles with allowAccess false', () => {
    writeAgent({
      roles: {
        definitions: {
          suspended: {
            description: 'blocked peer',
            allowAccess: false,
            permissions: {},
          },
        },
      },
    });
    writeRelation('blocked.aid.pub', { roles: { assigned: 'suspended' } });

    const detail = resolvePeerRoleDetail({
      selfAid: aid,
      channelType: 'aun',
      chatType: 'private',
      actorId: 'blocked.aid.pub',
      conversationId: 'blocked.aid.pub',
    });

    expect(detail.effectiveRole).toBe('suspended');
    expect(detail.allowAccess).toBe(false);
    expect(checkRoleAccess('suspended', aid)).toBe(false);
  });

  it('recognizes only signed AID-style actors as authenticated', () => {
    expect(isAuthenticated('alice.aid.pub')).toBe(true);
    expect(isAuthenticated('bot.agentid.pub')).toBe(true);
    expect(isAuthenticated('ou_123')).toBe(false);
  });
});
