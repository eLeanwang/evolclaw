import { loadEvolclawConfig } from '../../config-store.js';
import { checkRoleAccess, resolvePeerRoleDetail, roleToSessionIdentity, type ResolvedPeerRole } from '../../config/peer-role-resolver.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import { authorizeCommand } from '../command/command-permission.js';
import { auditCommandAuthorization } from '../command/command-audit.js';
import type {
  CommandAuthorizationContext,
  CommandAuthorizationDecision,
  CommandIntent,
  CommandSource,
  SessionIdentity,
} from '../../types.js';

export interface AuthSubject {
  selfAid?: string;
  actorId?: string;
  channel: string;
  channelType: string;
  channelId: string;
  chatType: 'private' | 'group';
  conversationId: string;
  peerKey?: string;
  role: string;
  roleSource: ResolvedPeerRole['source'] | 'fallback';
  identity: SessionIdentity;
  isDaemonOwner: boolean;
  fromControlChannel: boolean;
  allowAccess: boolean;
}

export interface AuthSubjectInput {
  selfAid?: string;
  actorId?: string;
  channel: string;
  channelType: string;
  channelId: string;
  chatType?: 'private' | 'group' | string;
  conversationId?: string;
  peerType?: string;
  roleDetail?: ResolvedPeerRole;
  fromControlChannel?: boolean;
  processOwners?: string[];
}

export type AuthDecision =
  | { allow: true; subject?: AuthSubject; command?: Extract<CommandAuthorizationDecision, { allow: true }> }
  | { allow: false; code: string; reason: string; subject?: AuthSubject; command?: Extract<CommandAuthorizationDecision, { allow: false }> };

export function buildAuthSubject(input: AuthSubjectInput): AuthSubject {
  const chatType: 'private' | 'group' = input.chatType === 'group' ? 'group' : 'private';
  const actorId = input.actorId;
  const conversationId = input.conversationId || (chatType === 'group' ? input.channelId : actorId || input.channelId);
  const roleDetail = input.roleDetail ?? resolveRoleDetail({
    selfAid: input.selfAid,
    channelType: input.channelType,
    chatType,
    actorId,
    conversationId,
    peerType: input.peerType,
  });
  const processOwners = input.processOwners ?? loadEvolclawConfig().owners ?? [];
  const isDaemonOwner = !!actorId && Array.isArray(processOwners) && processOwners.includes(actorId);
  const role = isDaemonOwner ? 'owner' : roleDetail.effectiveRole || 'none';

  return {
    selfAid: input.selfAid,
    actorId,
    channel: input.channel,
    channelType: input.channelType,
    channelId: input.channelId,
    chatType,
    conversationId,
    peerKey: input.channelType && conversationId ? formatPeerKey(input.channelType, conversationId) : undefined,
    role,
    roleSource: isDaemonOwner && !roleDetail.effectiveRole ? 'fallback' : roleDetail.source,
    identity: roleToSessionIdentity(role === 'none' ? null : role),
    isDaemonOwner,
    fromControlChannel: !!input.fromControlChannel,
    allowAccess: isDaemonOwner || (roleDetail.allowAccess && checkRoleAccess(role, input.selfAid)),
  };
}

export function authorizeAccess(subject: AuthSubject): AuthDecision {
  if (subject.allowAccess) return { allow: true, subject };
  return {
    allow: false,
    code: 'ROLE_ACCESS_DENIED',
    reason: `Role ${subject.role} is not allowed to access this agent`,
    subject,
  };
}

export async function authorizeOperation(params: {
  source: CommandSource;
  intent: CommandIntent;
  subject: AuthSubject;
  audit?: boolean;
}): Promise<AuthDecision> {
  const access = authorizeAccess(params.subject);
  if (!access.allow) {
    if (params.audit !== false) {
      await auditDecision(params, {
        allow: false,
        code: 'ROLE_ACCESS_DENIED',
        reason: access.reason,
        operation: params.intent.operation,
        scope: params.intent.scope,
        role: params.subject.role,
        dangerous: params.intent.dangerous,
      });
    }
    return access;
  }

  const ctx: CommandAuthorizationContext = {
    intent: params.intent,
    actorId: params.subject.actorId,
    channel: params.subject.channel,
    channelId: params.subject.channelId,
    chatType: params.subject.chatType,
    selfAid: params.subject.selfAid,
    peerKey: params.subject.peerKey,
    role: params.subject.role,
    isDaemonOwner: params.subject.isDaemonOwner,
    fromControlChannel: params.subject.fromControlChannel,
    source: params.source,
  };
  const decision = authorizeCommand(ctx);
  if (params.audit !== false && (!decision.allow || decision.dangerous)) {
    await auditDecision(params, decision);
  }
  if (!decision.allow) {
    return {
      allow: false,
      code: decision.code,
      reason: decision.reason,
      subject: params.subject,
      command: decision,
    };
  }
  return { allow: true, subject: params.subject, command: decision };
}

function resolveRoleDetail(input: {
  selfAid?: string;
  channelType: string;
  chatType: 'private' | 'group';
  actorId?: string;
  conversationId: string;
  peerType?: string;
}): ResolvedPeerRole {
  if (!input.selfAid || !input.actorId || !input.conversationId) {
    return {
      effectiveRole: null,
      source: 'none',
      isAuthenticated: false,
      allowAccess: false,
      roleExists: false,
    };
  }
  return resolvePeerRoleDetail({
    selfAid: input.selfAid,
    channelType: input.channelType,
    chatType: input.chatType,
    actorId: input.actorId,
    conversationId: input.conversationId,
    peerType: input.peerType,
  });
}

async function auditDecision(
  params: {
    source: CommandSource;
    intent: CommandIntent;
    subject: AuthSubject;
  },
  decision: CommandAuthorizationDecision,
): Promise<void> {
  await auditCommandAuthorization({
    ts: Date.now(),
    source: params.source,
    operation: params.intent.operation,
    scope: params.intent.scope,
    dangerous: decision.dangerous ?? params.intent.dangerous ?? false,
    actorId: params.subject.actorId,
    selfAid: params.subject.selfAid,
    peerKey: params.subject.peerKey,
    channel: params.subject.channel,
    channelId: params.subject.channelId,
    role: params.subject.role,
    isDaemonOwner: params.subject.isDaemonOwner,
    fromControlChannel: params.subject.fromControlChannel,
    decision: decision.allow ? 'allow' : 'deny',
    code: decision.allow ? undefined : decision.code,
    reason: decision.allow ? undefined : decision.reason,
    matchedRule: decision.matchedRule,
    argsSummary: params.intent.args,
  });
}
