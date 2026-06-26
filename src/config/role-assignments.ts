import { ConfigTarget, ensureFile, read, write } from './config-manager.js';
import { readRolesConfig } from './roles.js';
import type { RoleAssignment, RoleAssignmentsConfig } from '../types.js';

export function assignmentKey(channelKey: string, peerId: string): string {
  return `${channelKey}::${peerId}`;
}

export function readRoleAssignments(aid: string): RoleAssignmentsConfig {
  const config = read<RoleAssignmentsConfig>(ConfigTarget.RoleAssignments, { self: aid }, { cache: true });
  return config ?? { $schema_version: 1, assignments: {} };
}

export function writeRoleAssignments(aid: string, config: RoleAssignmentsConfig): void {
  validateAssignments(config);
  ensureFile(ConfigTarget.RoleAssignments, { self: aid });
  write(ConfigTarget.RoleAssignments, config, { self: aid });
}

export function getRoleAssignment(
  aid: string,
  channelKey: string,
  peerId: string
): RoleAssignment | undefined {
  return readRoleAssignments(aid).assignments[assignmentKey(channelKey, peerId)];
}

export function setRoleAssignment(
  aid: string,
  channelKey: string,
  peerId: string,
  role: string,
  patch: Partial<Omit<RoleAssignment, 'channelKey' | 'peerId' | 'role'>> = {}
): RoleAssignment {
  validateRole(role);
  const now = Date.now();
  const config = readRoleAssignments(aid);
  const key = assignmentKey(channelKey, peerId);
  const existing = config.assignments[key];
  const next: RoleAssignment = {
    ...existing,
    ...patch,
    channelKey,
    peerId,
    role,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
  };
  config.assignments[key] = next;
  writeRoleAssignments(aid, config);
  return next;
}

export function deleteRoleAssignment(aid: string, channelKey: string, peerId: string): boolean {
  const config = readRoleAssignments(aid);
  const key = assignmentKey(channelKey, peerId);
  if (!config.assignments[key]) return false;
  delete config.assignments[key];
  writeRoleAssignments(aid, config);
  return true;
}

export function hasRoleAssignment(aid: string, channelKey: string, role: string): boolean {
  const config = readRoleAssignments(aid);
  return Object.values(config.assignments).some(a => a.channelKey === channelKey && a.role === role);
}

export function listRoleAssignments(
  aid: string,
  channelKey?: string,
  role?: string
): RoleAssignment[] {
  const config = readRoleAssignments(aid);
  return Object.values(config.assignments).filter(assignment => {
    if (channelKey && assignment.channelKey !== channelKey) return false;
    if (role && assignment.role !== role) return false;
    return true;
  });
}

export function getFirstRoleAssignment(
  aid: string,
  channelKey: string,
  role: string
): RoleAssignment | undefined {
  return listRoleAssignments(aid, channelKey, role)[0];
}

function validateAssignments(config: RoleAssignmentsConfig): void {
  for (const [key, assignment] of Object.entries(config.assignments || {})) {
    if (key !== assignmentKey(assignment.channelKey, assignment.peerId)) {
      throw new Error(`Invalid role assignment key "${key}", expected "${assignmentKey(assignment.channelKey, assignment.peerId)}"`);
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
