import { ConfigTarget, ensureFile, read, write } from './config-manager.js';
import { readRolesConfig, getBuiltinRolesConfig } from './roles.js';
import { syncNoOverrideRoleModelsForAgent } from './role-model-sync.js';
import type { RoleAssignment, RoleAssignmentsConfig, RoleAssignmentScope } from '../types.js';

export interface RoleAssignmentFilter {
  scope?: RoleAssignmentScope;
  role?: string;
  peerId?: string;
  groupId?: string;
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function privateAssignmentKey(peerId: string): string {
  return `private::${keyPart(peerId)}`;
}

export function groupAssignmentKey(groupId: string): string {
  return `group::${keyPart(groupId)}`;
}

export function groupMemberAssignmentKey(groupId: string, peerId: string): string {
  return `group-member::${keyPart(groupId)}::${keyPart(peerId)}`;
}

export function assignmentKey(assignment: Pick<RoleAssignment, 'scope' | 'peerId' | 'groupId'>): string {
  if (assignment.scope === 'private') {
    if (!assignment.peerId) throw new Error('private role assignment requires peerId');
    return privateAssignmentKey(assignment.peerId);
  }
  if (assignment.scope === 'group') {
    if (!assignment.groupId) throw new Error('group role assignment requires groupId');
    return groupAssignmentKey(assignment.groupId);
  }
  if (!assignment.groupId || !assignment.peerId) {
    throw new Error('group-member role assignment requires groupId and peerId');
  }
  return groupMemberAssignmentKey(assignment.groupId, assignment.peerId);
}

export function readRoleAssignments(aid: string): RoleAssignmentsConfig {
  const config = read<RoleAssignmentsConfig>(ConfigTarget.RoleAssignments, { self: aid }, { cache: true });
  return config ?? { $schema_version: 2, assignments: {} };
}

export function writeRoleAssignments(aid: string, config: RoleAssignmentsConfig): void {
  validateAssignments(config);
  ensureFile(ConfigTarget.RoleAssignments, { self: aid });
  write(ConfigTarget.RoleAssignments, config, { self: aid });

  // v3: 传入 roles 参数以触发自动同步
  syncNoOverrideRoleModelsForAgent(aid, getBuiltinRolesConfig());
}

function setScopedRoleAssignment(
  aid: string,
  identity: Pick<RoleAssignment, 'scope' | 'peerId' | 'groupId'>,
  role: string,
  patch: Partial<Omit<RoleAssignment, 'scope' | 'peerId' | 'groupId' | 'role'>> = {},
): RoleAssignment {
  validateRole(role);
  const now = Date.now();
  const config = readRoleAssignments(aid);
  const key = assignmentKey(identity);
  const existing = config.assignments[key];
  const next: RoleAssignment = {
    ...existing,
    ...patch,
    ...identity,
    role,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
  };
  config.assignments[key] = next;
  writeRoleAssignments(aid, config);
  return next;
}

export function setPrivateRoleAssignment(
  aid: string,
  peerId: string,
  role: string,
  patch: Partial<Omit<RoleAssignment, 'scope' | 'peerId' | 'groupId' | 'role'>> = {},
): RoleAssignment {
  return setScopedRoleAssignment(aid, { scope: 'private', peerId }, role, patch);
}

export function setGroupRoleAssignment(
  aid: string,
  groupId: string,
  role: string,
  patch: Partial<Omit<RoleAssignment, 'scope' | 'peerId' | 'groupId' | 'role'>> = {},
): RoleAssignment {
  return setScopedRoleAssignment(aid, { scope: 'group', groupId }, role, patch);
}

export function setGroupMemberRoleAssignment(
  aid: string,
  groupId: string,
  peerId: string,
  role: string,
  patch: Partial<Omit<RoleAssignment, 'scope' | 'peerId' | 'groupId' | 'role'>> = {},
): RoleAssignment {
  return setScopedRoleAssignment(aid, { scope: 'group-member', groupId, peerId }, role, patch);
}

export function getPrivateRoleAssignment(aid: string, peerId: string): RoleAssignment | undefined {
  return readRoleAssignments(aid).assignments[privateAssignmentKey(peerId)];
}

export function getGroupRoleAssignment(aid: string, groupId: string): RoleAssignment | undefined {
  return readRoleAssignments(aid).assignments[groupAssignmentKey(groupId)];
}

export function getGroupMemberRoleAssignment(aid: string, groupId: string, peerId: string): RoleAssignment | undefined {
  return readRoleAssignments(aid).assignments[groupMemberAssignmentKey(groupId, peerId)];
}

export function deletePrivateRoleAssignment(aid: string, peerId: string): boolean {
  return deleteRoleAssignmentByKey(aid, privateAssignmentKey(peerId));
}

export function deleteGroupRoleAssignment(aid: string, groupId: string): boolean {
  return deleteRoleAssignmentByKey(aid, groupAssignmentKey(groupId));
}

export function deleteGroupMemberRoleAssignment(aid: string, groupId: string, peerId: string): boolean {
  return deleteRoleAssignmentByKey(aid, groupMemberAssignmentKey(groupId, peerId));
}

function deleteRoleAssignmentByKey(aid: string, key: string): boolean {
  const config = readRoleAssignments(aid);
  if (!config.assignments[key]) return false;
  delete config.assignments[key];
  writeRoleAssignments(aid, config);
  return true;
}

export function listRoleAssignments(aid: string, filter: RoleAssignmentFilter = {}): RoleAssignment[] {
  const config = readRoleAssignments(aid);
  return Object.values(config.assignments).filter(assignment => {
    if (filter.scope && assignment.scope !== filter.scope) return false;
    if (filter.role && assignment.role !== filter.role) return false;
    if (filter.peerId && assignment.peerId !== filter.peerId) return false;
    if (filter.groupId && assignment.groupId !== filter.groupId) return false;
    return true;
  });
}

export function getFirstRoleAssignment(aid: string, filter: RoleAssignmentFilter): RoleAssignment | undefined {
  return listRoleAssignments(aid, filter)[0];
}

export function hasRoleAssignment(aid: string, filter: RoleAssignmentFilter): boolean {
  return listRoleAssignments(aid, filter).length > 0;
}

function validateAssignments(config: RoleAssignmentsConfig): void {
  for (const [key, assignment] of Object.entries(config.assignments || {})) {
    const expected = assignmentKey(assignment);
    if (key !== expected) {
      throw new Error(`Invalid role assignment key "${key}", expected "${expected}"`);
    }
    validateRole(assignment.role);
  }
}

function validateRole(role: string): void {
  const roles = readRolesConfig();
  if (!roles.roles?.[role]) {
    throw new Error(`Unknown role: ${role}`);
  }
}
