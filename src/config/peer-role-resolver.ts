import { getRoleAssignment, assignmentKey } from './role-assignments.js';
import { readRolesConfig } from './roles.js';
import type { RoleAssignment } from '../types.js';

export interface PeerRoleContext {
  selfAid: string;
  channelKey: string;
  channelType: string;
  chatType: 'private' | 'group';
  actorId: string;
  conversationId: string;
  peerType?: string;
}

export interface ResolvedPeerRole {
  effectiveRole: string;
  source: 'assignment' | 'guest' | 'default';
  assignmentKey?: string;
  assignment?: RoleAssignment;
  isAuthenticated: boolean;
  allowAccess: boolean;
  roleExists: boolean;
}

export function isAuthenticated(userId: string): boolean {
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(userId);
}

export function resolvePeerRoleDetail(ctx: PeerRoleContext): ResolvedPeerRole {
  const auth = isAuthenticated(ctx.actorId);
  const rolesConfig = readRolesConfig();
  const found = getRoleAssignment(ctx.selfAid, ctx.channelKey, ctx.actorId);

  if (found) {
    const def = rolesConfig.roles[found.role];
    if (!def) {
      return {
        effectiveRole: 'anonymous',
        source: 'default',
        assignmentKey: assignmentKey(ctx.channelKey, ctx.actorId),
        assignment: found,
        isAuthenticated: auth,
        allowAccess: false,
        roleExists: false,
      };
    }
    return {
      effectiveRole: found.role,
      source: 'assignment',
      assignmentKey: assignmentKey(ctx.channelKey, ctx.actorId),
      assignment: found,
      isAuthenticated: auth,
      allowAccess: def.allowAccess ?? true,
      roleExists: true,
    };
  }

  const fallbackRole = auth ? 'guest' : (rolesConfig.defaultRole || 'anonymous');
  const def = rolesConfig.roles[fallbackRole];
  return {
    effectiveRole: def ? fallbackRole : 'anonymous',
    source: auth ? 'guest' : 'default',
    isAuthenticated: auth,
    allowAccess: def ? (def.allowAccess ?? true) : false,
    roleExists: !!def,
  };
}

export function roleToSessionIdentity(role: string): { role: string; mode: 'interactive' } {
  return { role, mode: 'interactive' };
}

export function checkRoleAccess(role: string): boolean {
  try {
    const rolesConfig = readRolesConfig();
    const roleDef = rolesConfig.roles[role];
    if (!roleDef) return false;
    return roleDef.allowAccess ?? true;
  } catch {
    return false;
  }
}
