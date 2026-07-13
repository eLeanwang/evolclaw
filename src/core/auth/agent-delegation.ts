import crypto from 'crypto';

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

function hashDelegationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
