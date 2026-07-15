import { describe, expect, it } from 'vitest';
import {
  AgentDelegationRegistry,
  authorizeDelegatedAunMsgSend,
} from '../../src/core/auth/agent-delegation.js';

function issueMemberGrant(registry: AgentDelegationRegistry): string {
  return registry.issue({
    sessionId: 'session-1',
    taskId: 'task-1',
    messageId: 'message-1',
    actorId: 'peer.agentid.pub',
    channel: 'aun',
    channelType: 'aun',
    chatType: 'private',
    selfAid: 'self.agentid.pub',
    peerKey: 'aun#peer.agentid.pub',
    issuedRole: 'member',
  });
}

describe('delegated AUN message send authorization', () => {
  it('allows the signed member task to send only to its own peer', () => {
    const registry = new AgentDelegationRegistry();
    const token = issueMemberGrant(registry);
    expect(authorizeDelegatedAunMsgSend(registry, {
      delegationToken: token,
      sessionId: 'session-1',
      messageId: 'message-1',
      aid: 'self.agentid.pub',
      to: 'peer.agentid.pub',
    }).ok).toBe(true);

    expect(authorizeDelegatedAunMsgSend(registry, {
      delegationToken: token,
      sessionId: 'session-1',
      messageId: 'message-1',
      aid: 'self.agentid.pub',
      to: 'other.agentid.pub',
    })).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });

  it('rejects missing, cross-session, sender, and message token reuse', () => {
    const registry = new AgentDelegationRegistry();
    const token = issueMemberGrant(registry);
    const base = {
      delegationToken: token,
      sessionId: 'session-1',
      messageId: 'message-1',
      aid: 'self.agentid.pub',
      to: 'peer.agentid.pub',
    };

    expect(authorizeDelegatedAunMsgSend(registry, { ...base, delegationToken: undefined }))
      .toMatchObject({ ok: false, code: 'DELEGATION_REQUIRED' });
    expect(authorizeDelegatedAunMsgSend(registry, { ...base, sessionId: 'session-2' }))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
    expect(authorizeDelegatedAunMsgSend(registry, { ...base, aid: 'other.agentid.pub' }))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
    expect(authorizeDelegatedAunMsgSend(registry, { ...base, messageId: 'message-2' }))
      .toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
  });

  it('rejects a token after the task is revoked', () => {
    const registry = new AgentDelegationRegistry();
    const token = issueMemberGrant(registry);
    registry.revokeTask('session-1', 'task-1');
    expect(authorizeDelegatedAunMsgSend(registry, {
      delegationToken: token,
      sessionId: 'session-1',
      messageId: 'message-1',
      aid: 'self.agentid.pub',
      to: 'peer.agentid.pub',
    })).toMatchObject({ ok: false, code: 'INVALID_DELEGATION' });
  });

  it('authorizes group file sends against the group-file operation', () => {
    const registry = new AgentDelegationRegistry();
    const token = registry.issue({
      sessionId: 'group-session',
      taskId: 'group-task',
      messageId: 'group-message',
      actorId: 'member.agentid.pub',
      channel: 'aun',
      channelType: 'aun',
      chatType: 'group',
      selfAid: 'self.agentid.pub',
      peerKey: 'aun#group.owner%2Fteam',
      issuedRole: 'member',
    });

    expect(authorizeDelegatedAunMsgSend(registry, {
      delegationToken: token,
      sessionId: 'group-session',
      messageId: 'group-message',
      aid: 'self.agentid.pub',
      to: 'group.owner/team',
      scope: 'group',
      action: 'file',
    }).ok).toBe(true);
  });

  it('does not let a visitor upgrade a permitted text send into a file send', () => {
    const registry = new AgentDelegationRegistry();
    const token = registry.issue({
      sessionId: 'visitor-session',
      taskId: 'visitor-task',
      messageId: 'visitor-message',
      actorId: 'peer.agentid.pub',
      channel: 'aun',
      channelType: 'aun',
      chatType: 'private',
      selfAid: 'self.agentid.pub',
      peerKey: 'aun#peer.agentid.pub',
      issuedRole: 'visitor',
    });
    const input = {
      delegationToken: token,
      sessionId: 'visitor-session',
      messageId: 'visitor-message',
      aid: 'self.agentid.pub',
      to: 'peer.agentid.pub',
      scope: 'msg' as const,
    };

    expect(authorizeDelegatedAunMsgSend(registry, { ...input, action: 'send' }).ok).toBe(true);
    expect(authorizeDelegatedAunMsgSend(registry, { ...input, action: 'file' }))
      .toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
  });
});
