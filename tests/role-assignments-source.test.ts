import { describe, expect, it } from 'vitest';
import {
  buildConversationSeeds,
  canAssignRole,
  canRevokeRole,
  normalizeAgentPeerType,
  parseAgentMdInfo,
} from '../ecweb/src/sources/role-assignments.js';

function msg(overrides: any) {
  return {
    ts: 100,
    dir: 'in',
    from: 'alice.aid.pub',
    to: 'bot.agentid.pub',
    chatType: 'private',
    groupId: null,
    msgId: 'm1',
    msgType: 'text',
    content: 'hi',
    replyTo: null,
    agent: null,
    model: null,
    permMode: null,
    durationMs: null,
    ...overrides,
  };
}

describe('ecweb role assignment source', () => {
  const aid = 'bot.agentid.pub';

  it('lists real private conversations even when they have no explicit role assignment', () => {
    const seeds = buildConversationSeeds(aid, [
      {
        conversationId: 'alice.aid.pub',
        active: {
          agentSessionId: null,
          channelType: 'aun',
          channelId: 'alice.aid.pub',
          chatType: 'private',
          selfAID: aid,
          name: null,
          updatedAt: 120,
          metadata: { peerName: 'Alice' },
        },
        messages: [msg({})],
      },
    ]);

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      self: aid,
      chatType: 'private',
      conversationId: 'alice.aid.pub',
      peerId: 'alice.aid.pub',
      peerName: 'Alice',
      name: 'Alice',
    });
  });

  it('does not create conversations from assignments alone', () => {
    const seeds = buildConversationSeeds(aid, [
      { conversationId: 'alice.aid.pub', messages: [] },
    ]);

    expect(seeds.map(seed => seed.conversationId)).toEqual(['alice.aid.pub']);
  });

  it('creates one group conversation and exposes message senders as members', () => {
    const seeds = buildConversationSeeds(aid, [
      {
        conversationId: 'group.team',
        active: {
          agentSessionId: null,
          channelType: 'aun',
          channelId: 'group.team',
          chatType: 'group',
          selfAID: aid,
          name: 'Team Group',
          updatedAt: 130,
          metadata: { groupId: 'group.team', groupName: 'Team Group' },
        },
        messages: [
          msg({
            ts: 100,
            chatType: 'group',
            groupId: 'group.team',
            peerName: 'Alice',
            peerType: 'human',
          }),
          msg({
            ts: 120,
            from: 'bob.aid.pub',
            chatType: 'group',
            groupId: 'group.team',
            msgId: 'm2',
            peerName: 'Bot Bob',
            peerType: 'codeagent',
          }),
        ],
      },
    ]);

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      chatType: 'group',
      conversationId: 'group.team',
      groupId: 'group.team',
      name: 'Team Group',
    });
    expect(seeds[0].members?.map(member => member.peerId).sort()).toEqual(['alice.aid.pub', 'bob.aid.pub']);
    expect(seeds[0].members?.find(member => member.peerId === 'alice.aid.pub')?.peerType).toBe('human');
    expect(seeds[0].members?.find(member => member.peerId === 'bob.aid.pub')?.peerType).toBe('ai');
  });

  it('uses local agent.md as the peer type source for private peers', () => {
    const seeds = buildConversationSeeds(aid, [
      {
        conversationId: 'alice.aid.pub',
        active: {
          agentSessionId: null,
          channelType: 'aun',
          channelId: 'alice.aid.pub',
          chatType: 'private',
          selfAID: aid,
          name: null,
          updatedAt: 100,
          metadata: { peerType: 'codeagent' },
        },
        messages: [],
      },
    ], peerAid => peerAid === 'alice.aid.pub'
      ? { name: 'Alice Local', declaredType: 'human', peerType: 'human' }
      : undefined);

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      peerId: 'alice.aid.pub',
      peerName: 'Alice Local',
      peerType: 'human',
      name: 'Alice Local',
    });
  });

  it('uses each sender agent.md as the peer type source in group conversations', () => {
    const seeds = buildConversationSeeds(aid, [
      {
        conversationId: 'group.team',
        active: {
          agentSessionId: null,
          channelType: 'aun',
          channelId: 'group.team',
          chatType: 'group',
          selfAID: aid,
          name: null,
          updatedAt: 100,
          metadata: { groupId: 'group.team' },
        },
        messages: [
          msg({ chatType: 'group', groupId: 'group.team', peerType: 'codeagent' }),
          msg({ from: 'bob.aid.pub', chatType: 'group', groupId: 'group.team', msgId: 'm2', peerType: 'human' }),
        ],
      },
    ], peerAid => {
      if (peerAid === 'alice.aid.pub') return { declaredType: 'human', peerType: 'human' };
      if (peerAid === 'bob.aid.pub') return { declaredType: 'codeagent', peerType: 'ai' };
      return undefined;
    });

    expect(seeds[0].members?.find(member => member.peerId === 'alice.aid.pub')?.peerType).toBe('human');
    expect(seeds[0].members?.find(member => member.peerId === 'bob.aid.pub')?.peerType).toBe('ai');
  });

  it('parses and normalizes agent.md declared types', () => {
    expect(parseAgentMdInfo('---\naid: "alice.aid.pub"\nname: "Alice"\ntype: "human"\n---\n')).toMatchObject({
      name: 'Alice',
      declaredType: 'human',
      peerType: 'human',
    });
    expect(normalizeAgentPeerType('codeagent')).toBe('ai');
    expect(normalizeAgentPeerType('Codex')).toBe('ai');
    expect(normalizeAgentPeerType('unknown')).toBeUndefined();
  });

  it('enforces role assignment escalation policy', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('owner', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'member')).toBe(true);
    expect(canAssignRole('admin', 'guest')).toBe(true);
    expect(canAssignRole('admin', 'anonymous')).toBe(true);
    expect(canAssignRole('admin', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('member', 'guest')).toBe(false);
  });

  it('enforces role revoke escalation policy', () => {
    expect(canRevokeRole('owner', 'owner')).toBe(true);
    expect(canRevokeRole('owner', 'admin')).toBe(true);
    expect(canRevokeRole('admin', 'member')).toBe(true);
    expect(canRevokeRole('admin', 'guest')).toBe(true);
    expect(canRevokeRole('admin', 'anonymous')).toBe(true);
    expect(canRevokeRole('admin', 'admin')).toBe(false);
    expect(canRevokeRole('admin', 'owner')).toBe(false);
    expect(canRevokeRole('member', 'guest')).toBe(false);
  });
});
