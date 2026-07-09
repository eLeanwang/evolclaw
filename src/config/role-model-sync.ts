/**
 * Synchronize relation model overrides against locked role defaults.
 *
 * Role assignments now live inside relation config:
 * - roles.assigned for the relation default role
 * - roles.members for group member-specific roles
 *
 * The relation config is shared by all members of a group, so member-specific
 * roles can only be normalized when their locked defaults agree.
 */

import * as fs from 'fs';
import { agentRelationsDir, resolvePaths } from '../paths.js';
import { ConfigTarget, read, write } from './config-manager.js';
import type { RelationConfig, RoleDefinition, RolesConfig } from '../types.js';

interface LockedModelDefault {
  baseagent: string;
  model: string;
}

export interface RoleModelSyncResult {
  scannedAgents: number;
  scannedAssignments: number;
  updatedRelations: number;
}

const MODEL_PERMISSION_RE = /^baseagents\.([^.]+)\.model$/;

export function syncNoOverrideRoleModelsForAllAgents(roles: RolesConfig): RoleModelSyncResult {
  const agentsDir = resolvePaths().agentsDir;
  const result: RoleModelSyncResult = {
    scannedAgents: 0,
    scannedAssignments: 0,
    updatedRelations: 0,
  };
  if (!fs.existsSync(agentsDir)) return result;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partial = syncNoOverrideRoleModelsForAgent(entry.name, roles);
    result.scannedAgents += partial.scannedAgents;
    result.scannedAssignments += partial.scannedAssignments;
    result.updatedRelations += partial.updatedRelations;
  }
  return result;
}

export function syncNoOverrideRoleModelsForAgent(aid: string, roles: RolesConfig): RoleModelSyncResult {
  const result: RoleModelSyncResult = {
    scannedAgents: 1,
    scannedAssignments: 0,
    updatedRelations: 0,
  };
  const lockedByRole = buildLockedModelDefaults(roles);
  if (lockedByRole.size === 0) return result;

  for (const peerKey of listRelationKeys(aid)) {
    const relation = read<RelationConfig>(ConfigTarget.Relation, { self: aid, peerKey });
    if (!relation?.roles) continue;

    const assignedRoles = assignedRolesForRelation(relation);
    result.scannedAssignments += assignedRoles.length;
    const locked = mergeCompatibleLockedModels(assignedRoles, lockedByRole);
    if (!locked.length) continue;

    const { value: next, changed } = applyLockedModels(relation, locked);
    if (!changed) continue;
    write(ConfigTarget.Relation, next, { self: aid, peerKey });
    result.updatedRelations += 1;
  }

  return result;
}

export function normalizeRelationBehaviorForAssignedRole(
  aid: string,
  peerKey: string,
  value: RelationConfig,
  roles: RolesConfig,
): RelationConfig {
  const lockedByRole = buildLockedModelDefaults(roles);
  if (lockedByRole.size === 0) return value;

  const assignedRoles = assignedRolesForRelation(value);
  const locked = mergeCompatibleLockedModels(assignedRoles, lockedByRole);
  if (!locked.length) return value;

  return applyLockedModels(value, locked).value;
}

function buildLockedModelDefaults(roles: RolesConfig): Map<string, LockedModelDefault[]> {
  const out = new Map<string, LockedModelDefault[]>();
  for (const [roleName, roleDef] of Object.entries(roles.roles || {})) {
    const locked = lockedDefaultsForRole(roleDef);
    if (locked.length > 0) out.set(roleName, locked);
  }
  return out;
}

function lockedDefaultsForRole(roleDef: RoleDefinition): LockedModelDefault[] {
  const locked: LockedModelDefault[] = [];
  for (const [field, permission] of Object.entries(roleDef.permissions || {})) {
    const match = MODEL_PERMISSION_RE.exec(field);
    if (!match) continue;
    if (permission.allowOverride !== false) continue;
    if (typeof permission.default !== 'string' || !permission.default.trim()) continue;
    locked.push({ baseagent: match[1], model: permission.default.trim() });
  }
  return locked;
}

function assignedRolesForRelation(config: RelationConfig): string[] {
  const roles = config.roles;
  if (!roles) return [];
  const out = new Set<string>();
  if (typeof roles.assigned === 'string' && roles.assigned) out.add(roles.assigned);
  for (const role of Object.values(roles.members || {})) {
    if (typeof role === 'string' && role) out.add(role);
  }
  return [...out];
}

function mergeCompatibleLockedModels(
  roleNames: string[],
  lockedByRole: Map<string, LockedModelDefault[]>,
): LockedModelDefault[] {
  const byBaseagent = new Map<string, string>();
  const conflicts = new Set<string>();

  for (const roleName of roleNames) {
    for (const locked of lockedByRole.get(roleName) || []) {
      if (conflicts.has(locked.baseagent)) continue;
      const existing = byBaseagent.get(locked.baseagent);
      if (existing && existing !== locked.model) {
        byBaseagent.delete(locked.baseagent);
        conflicts.add(locked.baseagent);
        continue;
      }
      byBaseagent.set(locked.baseagent, locked.model);
    }
  }

  return [...byBaseagent.entries()].map(([baseagent, model]) => ({ baseagent, model }));
}

function listRelationKeys(aid: string): string[] {
  const dir = agentRelationsDir(aid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => entry.name);
}

function applyLockedModels(
  value: RelationConfig,
  locked: LockedModelDefault[],
): { value: RelationConfig; changed: boolean } {
  let next: RelationConfig | null = null;

  for (const item of locked) {
    const baseagents = (next || value).baseagents || {};
    const current = (baseagents as any)[item.baseagent] || {};
    if (current.model === item.model) continue;

    next = next || cloneConfig(value);
    next.baseagents = next.baseagents || {};
    (next.baseagents as any)[item.baseagent] = {
      ...((next.baseagents as any)[item.baseagent] || {}),
      model: item.model,
    };
  }

  return { value: next || value, changed: !!next };
}

function cloneConfig(value: RelationConfig): RelationConfig {
  return JSON.parse(JSON.stringify(value || {}));
}
