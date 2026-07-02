import {
  getGroupMemberRoleAssignment,
  getGroupRoleAssignment,
  getPrivateRoleAssignment,
  groupAssignmentKey,
  groupMemberAssignmentKey,
  privateAssignmentKey,
} from './role-assignments.js';
import { readRolesConfig } from './roles.js';
import type { RoleAssignment } from '../types.js';

export interface PeerRoleContext {
  selfAid: string;
  channelType: string;
  chatType: 'private' | 'group';
  actorId: string;
  conversationId: string;
  peerType?: string;
}

export interface ResolvedPeerRole {
  effectiveRole: string;
  source: 'assignment' | 'private-inherited' | 'group-default' | 'default';
  assignmentKey?: string;
  assignment?: RoleAssignment;
  isAuthenticated: boolean;
  allowAccess: boolean;
  roleExists: boolean;
}

export function isAuthenticated(userId: string): boolean {
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(userId);
}

function resultFor(
  role: string,
  source: ResolvedPeerRole['source'],
  auth: boolean,
  assignmentKeyValue?: string,
  assignment?: RoleAssignment,
): ResolvedPeerRole {
  const rolesConfig = readRolesConfig();
  const def = rolesConfig.roles[role];
  return {
    effectiveRole: def ? role : 'anonymous',
    source: def ? source : 'default',
    ...(assignmentKeyValue ? { assignmentKey: assignmentKeyValue } : {}),
    ...(assignment ? { assignment } : {}),
    isAuthenticated: auth,
    allowAccess: def ? (def.allowAccess ?? true) : false,
    roleExists: !!def,
  };
}

function defaultRoleFor(chatType: 'private' | 'group'): string {
  const rolesConfig = readRolesConfig();
  return rolesConfig.defaultRoles?.[chatType] || (chatType === 'group' ? 'guest' : 'anonymous');
}

export function resolvePeerRoleDetail(ctx: PeerRoleContext): ResolvedPeerRole {
  const auth = isAuthenticated(ctx.actorId);

  if (ctx.chatType === 'private') {
    const found = getPrivateRoleAssignment(ctx.selfAid, ctx.actorId);
    if (found) {
      return resultFor(found.role, 'assignment', auth, privateAssignmentKey(ctx.actorId), found);
    }
    return resultFor(defaultRoleFor('private'), 'default', auth);
  }

  const groupId = ctx.conversationId;
  const groupMember = getGroupMemberRoleAssignment(ctx.selfAid, groupId, ctx.actorId);
  if (groupMember) {
    return resultFor(groupMember.role, 'assignment', auth, groupMemberAssignmentKey(groupId, ctx.actorId), groupMember);
  }

  const privateAssignment = getPrivateRoleAssignment(ctx.selfAid, ctx.actorId);
  if (privateAssignment) {
    return resultFor(privateAssignment.role, 'private-inherited', auth, privateAssignmentKey(ctx.actorId), privateAssignment);
  }

  const groupAssignment = getGroupRoleAssignment(ctx.selfAid, groupId);
  if (groupAssignment) {
    return resultFor(groupAssignment.role, 'group-default', auth, groupAssignmentKey(groupId), groupAssignment);
  }

  return resultFor(defaultRoleFor('group'), 'default', auth);
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
