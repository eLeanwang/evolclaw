import crypto from 'crypto';
import { authorizeCommand } from '../command/command-permission.js';
import { parsePeerKey } from '../relation/peer-identity.js';

export const AGENT_DELEGATION_TOKEN_ENV = 'EVOLCLAW_DELEGATION_TOKEN';

export interface AgentDelegationGrant {
  tokenHash: string;
  sessionId: string;
  taskId: string;
  messageId?: string;
  actorId: string;
  channel: string;
  channelType: string;
  chatType: 'private' | 'group';
  selfAid: string;
  peerKey: string;
  issuedRole: string;
}

export type AgentDelegationValidation =
  | { ok: true; grant: AgentDelegationGrant }
  | { ok: false; code: 'DELEGATION_REQUIRED' | 'INVALID_DELEGATION'; reason: string };

export type DelegatedAunMsgSendAuthorization =
  | { ok: true; grant: AgentDelegationGrant }
  | { ok: false; code: 'DELEGATION_REQUIRED' | 'INVALID_DELEGATION' | 'NOT_ALLOWED'; reason: string };

export class AgentDelegationRegistry {
  private readonly grantsByHash = new Map<string, AgentDelegationGrant>();
  private readonly activeHashBySession = new Map<string, string>();

  issue(input: Omit<AgentDelegationGrant, 'tokenHash'>): string {
    this.revokeSession(input.sessionId);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashDelegationToken(token);
    this.grantsByHash.set(tokenHash, { ...input, tokenHash });
    this.activeHashBySession.set(input.sessionId, tokenHash);
    return token;
  }

  validate(token: string | undefined, sessionId: string): AgentDelegationValidation {
    if (!token) {
      return {
        ok: false,
        code: 'DELEGATION_REQUIRED',
        reason: 'An active task delegation token is required',
      };
    }

    const tokenHash = hashDelegationToken(token);
    const grant = this.grantsByHash.get(tokenHash);
    if (!grant
      || grant.sessionId !== sessionId
      || this.activeHashBySession.get(sessionId) !== tokenHash) {
      return {
        ok: false,
        code: 'INVALID_DELEGATION',
        reason: 'The task delegation token is invalid, revoked, or belongs to another session',
      };
    }
    return { ok: true, grant };
  }

  revokeTask(sessionId: string, taskId: string): void {
    const tokenHash = this.activeHashBySession.get(sessionId);
    if (!tokenHash) return;
    const grant = this.grantsByHash.get(tokenHash);
    if (!grant || grant.taskId !== taskId) return;
    this.grantsByHash.delete(tokenHash);
    this.activeHashBySession.delete(sessionId);
  }

  revokeSession(sessionId: string): void {
    const tokenHash = this.activeHashBySession.get(sessionId);
    if (tokenHash) this.grantsByHash.delete(tokenHash);
    this.activeHashBySession.delete(sessionId);
  }
}

export function authorizeDelegatedAunMsgSend(
  registry: AgentDelegationRegistry,
  input: {
    delegationToken?: string;
    sessionId?: string;
    messageId?: string;
    aid: string;
    to: string;
    scope?: 'msg' | 'group';
    action?: 'send' | 'file';
  },
): DelegatedAunMsgSendAuthorization {
  if (!input.sessionId) {
    return { ok: false, code: 'DELEGATION_REQUIRED', reason: 'Origin session is required' };
  }
  const validation = registry.validate(input.delegationToken, input.sessionId);
  if (!validation.ok) return validation;

  const grant = validation.grant;
  if (grant.selfAid !== input.aid) {
    return { ok: false, code: 'INVALID_DELEGATION', reason: 'Delegation self agent does not match sender' };
  }
  if (grant.messageId && grant.messageId !== input.messageId) {
    return { ok: false, code: 'INVALID_DELEGATION', reason: 'Delegation message does not match origin message' };
  }

  let channelId: string;
  try {
    channelId = parsePeerKey(grant.peerKey).channelId;
  } catch {
    return { ok: false, code: 'INVALID_DELEGATION', reason: 'Delegation relation key is invalid' };
  }
  const decision = authorizeCommand({
    actorId: grant.actorId,
    channel: grant.channel,
    channelId,
    chatType: grant.chatType,
    selfAid: grant.selfAid,
    peerKey: grant.peerKey,
    role: grant.issuedRole,
    isDaemonOwner: false,
    fromControlChannel: false,
    source: 'agent-tool',
    intent: {
      operation: `ec.${input.scope ?? 'msg'}.${input.action ?? 'send'}`,
      scope: 'relation',
      source: 'agent-tool',
      args: { peer: input.to, targetId: input.to },
    },
  });
  if (!decision.allow) {
    return { ok: false, code: 'NOT_ALLOWED', reason: decision.reason };
  }
  return { ok: true, grant };
}

function hashDelegationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
