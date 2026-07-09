import { formatPeerKey } from '../core/relation/peer-identity.js';
import { ConfigTarget, read, write } from './config-manager.js';
import { isManagementRole } from './builtin-roles.js';
import { normalizeDefaultRole, roleExists, getRoleDefinition } from './roles.js';
import type { AgentConfig, RelationConfig, RelationRolesConfig } from '../types.js';

export interface PeerRoleContext {
  selfAid: string;
  channelType: string;
  chatType: 'private' | 'group';
  actorId: string;
  conversationId: string;
  peerType?: string;
}

export interface ResolvedPeerRole {
  effectiveRole: string | null;
  source:
    | 'agent-config-owner'
    | 'agent-config-admin'
    | 'relation-assigned'
    | 'group-member'
    | 'private-inherited'
    | 'group-default'
    | 'default'
    | 'none';
  assignmentKey?: string;
  isAuthenticated: boolean;
  allowAccess: boolean;
  roleExists: boolean;
}

export function isAuthenticated(userId: string): boolean {
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(userId);
}

export function listStaticAgentOwners(aid: string): string[] {
  return listAgentAids(aid, 'owners');
}

export function listStaticAgentAdmins(aid: string): string[] {
  return listAgentAids(aid, 'admins');
}

export function getFirstStaticAgentOwner(aid: string): string | undefined {
  return listStaticAgentOwners(aid)[0];
}

export function isStaticAgentOwner(aid: string, actorId: string): boolean {
  return !!aid && !!actorId && listStaticAgentOwners(aid).includes(actorId);
}

export function isStaticAgentAdmin(aid: string, actorId: string): boolean {
  return !!aid && !!actorId && listStaticAgentAdmins(aid).includes(actorId);
}

export function addStaticAgentOwner(aid: string, ownerAid: string): void {
  if (!aid || !ownerAid) return;
  const config = read<AgentConfig>(ConfigTarget.Agent, { self: aid }) ?? { $schema_version: 3, aid, channels: [] };
  const owners = new Set((config.owners ?? []).filter(Boolean));
  owners.add(ownerAid);
  write(ConfigTarget.Agent, { ...config, aid, owners: [...owners] }, { self: aid });
}

export function hasStaticAgentOwner(aid: string): boolean {
  return listStaticAgentOwners(aid).length > 0;
}

export function resolvePeerRoleDetail(ctx: PeerRoleContext): ResolvedPeerRole {
  const auth = isAuthenticated(ctx.actorId);

  if (isStaticAgentOwner(ctx.selfAid, ctx.actorId)) {
    return resultFor('owner', 'agent-config-owner', auth, ctx.selfAid, true);
  }
  if (isStaticAgentAdmin(ctx.selfAid, ctx.actorId)) {
    return resultFor('admin', 'agent-config-admin', auth, ctx.selfAid, true);
  }

  if (ctx.chatType === 'private') {
    const privateRoles = readRelationRoles(ctx.selfAid, ctx.channelType, ctx.actorId);
    const assigned = normalizeUserRole(privateRoles?.assigned, ctx.selfAid);
    if (assigned) return resultFor(assigned, 'relation-assigned', auth, ctx.selfAid);

    const fallback = normalizeDefaultRole(readAgentDefaultRole(ctx.selfAid, 'private'), ctx.selfAid);
    return fallback ? resultFor(fallback, 'default', auth, ctx.selfAid) : resultFor(null, 'none', auth, ctx.selfAid);
  }

  const groupRoles = readRelationRoles(ctx.selfAid, ctx.channelType, ctx.conversationId);
  const memberRole = normalizeUserRole(groupRoles?.members?.[ctx.actorId], ctx.selfAid);
  if (memberRole) return resultFor(memberRole, 'group-member', auth, ctx.selfAid);

  const privateRoles = readRelationRoles(ctx.selfAid, ctx.channelType, ctx.actorId);
  const inherited = normalizeUserRole(privateRoles?.assigned, ctx.selfAid);
  if (inherited) return resultFor(inherited, 'private-inherited', auth, ctx.selfAid);

  const groupAssigned = normalizeUserRole(groupRoles?.assigned, ctx.selfAid);
  if (groupAssigned) return resultFor(groupAssigned, 'group-default', auth, ctx.selfAid);

  const fallback = normalizeDefaultRole(readAgentDefaultRole(ctx.selfAid, 'group'), ctx.selfAid);
  return fallback ? resultFor(fallback, 'default', auth, ctx.selfAid) : resultFor(null, 'none', auth, ctx.selfAid);
}

export function roleToSessionIdentity(role: string | null): { role: string; mode: 'interactive' } {
  return { role: role ?? 'none', mode: 'interactive' };
}

export function checkRoleAccess(role: string | null | undefined, selfAid?: string): boolean {
  if (!role) return false;
  if (isManagementRole(role)) return true;
  const roleDef = getRoleDefinition(role, selfAid);
  if (!roleDef) return false;
  return roleDef.allowAccess ?? true;
}

function resultFor(
  role: string | null,
  source: ResolvedPeerRole['source'],
  auth: boolean,
  selfAid?: string,
  forceAccess = false,
): ResolvedPeerRole {
  const exists = role ? (isManagementRole(role) || roleExists(role, selfAid)) : false;
  const roleDef = role ? getRoleDefinition(role, selfAid) : null;
  return {
    effectiveRole: exists ? role : null,
    source: exists ? source : 'none',
    isAuthenticated: auth,
    allowAccess: forceAccess || !!(roleDef && (roleDef.allowAccess ?? true)),
    roleExists: exists,
  };
}

function listAgentAids(aid: string, field: 'owners' | 'admins'): string[] {
  if (!aid) return [];
  try {
    const config = read<AgentConfig>(ConfigTarget.Agent, { self: aid }, { cache: true });
    const values = config?.[field];
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
  } catch {
    return [];
  }
}

function readAgentDefaultRole(aid: string, chatType: 'private' | 'group'): string | null | undefined {
  const config = read<AgentConfig>(ConfigTarget.Agent, { self: aid }, { cache: true });
  const defaults = config?.roles?.defaultRoles;
  if (defaults && Object.prototype.hasOwnProperty.call(defaults, chatType)) {
    return defaults[chatType] ?? null;
  }
  return null;
}

function readRelationRoles(selfAid: string, channelType: string, channelId: string): RelationRolesConfig | undefined {
  if (!selfAid || !channelType || !channelId) return undefined;
  const peerKey = formatPeerKey(channelType, channelId);
  const config = read<RelationConfig>(ConfigTarget.Relation, { self: selfAid, peerKey }, { cache: true });
  return config?.roles;
}

function normalizeUserRole(value: unknown, selfAid: string): string | null {
  if (typeof value !== 'string' || !roleExists(value, selfAid)) return null;
  return value;
}
