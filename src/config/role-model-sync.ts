import fs from 'fs';
import { agentRelationBehaviorConfig, agentRelationsDir, agentRoleAssignmentsConfig, resolvePaths } from '../paths.js';
import { parsePeerKey } from '../core/relation/peer-identity.js';
import { atomicReadJson, atomicWriteJson } from '../utils/atomic-write.js';
import { fileCache } from '../core/daemon-file-cache.js';
import { currentVersion, loadSchema } from './schema-registry.js';
import type { BehaviorConfig } from './behavior.js';
import type { RoleAssignment, RoleAssignmentsConfig, RolesConfig } from '../types.js';

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

  const assignments = readAssignments(aid).assignments || {};
  const relationKeys = listRelationKeys(aid);
  if (relationKeys.length === 0) return result;

  for (const assignment of Object.values(assignments)) {
    result.scannedAssignments += 1;
    const locked = lockedByRole.get(assignment.role);
    if (!locked || locked.length === 0) continue;

    for (const peerKey of relationKeysForAssignment(assignment, relationKeys)) {
      if (normalizeRelationModels(aid, peerKey, locked)) {
        result.updatedRelations += 1;
      }
    }
  }
  return result;
}

export function normalizeRelationBehaviorForAssignedRole(
  aid: string,
  peerKey: string,
  value: BehaviorConfig,
  roles: RolesConfig,
): BehaviorConfig {
  const role = explicitRoleForRelation(aid, peerKey);
  if (!role) return value;
  const locked = buildLockedModelDefaults(roles).get(role);
  if (!locked || locked.length === 0) return value;
  return applyLockedModels(value, locked).value;
}

function buildLockedModelDefaults(roles: RolesConfig): Map<string, LockedModelDefault[]> {
  const out = new Map<string, LockedModelDefault[]>();
  for (const [roleName, roleDef] of Object.entries(roles.roles || {})) {
    const locked: LockedModelDefault[] = [];
    for (const [field, permission] of Object.entries(roleDef.permissions || {})) {
      const match = MODEL_PERMISSION_RE.exec(field);
      if (!match) continue;
      if (permission.allowOverride !== false) continue;
      if (typeof permission.default !== 'string' || !permission.default.trim()) continue;
      locked.push({ baseagent: match[1], model: permission.default.trim() });
    }
    if (locked.length > 0) out.set(roleName, locked);
  }
  return out;
}

function readAssignments(aid: string): RoleAssignmentsConfig {
  return atomicReadJson<RoleAssignmentsConfig>(agentRoleAssignmentsConfig(aid))
    ?? { $schema_version: 2, assignments: {} };
}

function listRelationKeys(aid: string): string[] {
  const dir = agentRelationsDir(aid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function relationKeysForAssignment(assignment: RoleAssignment, existingKeys: string[]): string[] {
  const targetId = relationTargetId(assignment);
  if (!targetId) return [];

  const matched = existingKeys.filter(peerKey => relationChannelId(peerKey) === targetId);
  const canonicalAun = `aun#${encodeURIComponent(targetId)}`;
  if (existingKeys.includes(canonicalAun) && !matched.includes(canonicalAun)) {
    matched.push(canonicalAun);
  }
  return matched;
}

function relationTargetId(assignment: RoleAssignment): string | null {
  if (assignment.scope === 'private') return assignment.peerId || null;
  if (assignment.scope === 'group') return assignment.groupId || null;
  return null;
}

function explicitRoleForRelation(aid: string, peerKey: string): string | null {
  const channelId = relationChannelId(peerKey);
  if (!channelId) return null;

  const assignments = Object.values(readAssignments(aid).assignments || {});
  const privateAssignment = assignments.find(assignment =>
    assignment.scope === 'private' && assignment.peerId === channelId);
  if (privateAssignment) return privateAssignment.role;

  const groupAssignment = assignments.find(assignment =>
    assignment.scope === 'group' && assignment.groupId === channelId);
  if (groupAssignment) return groupAssignment.role;

  return null;
}

function relationChannelId(peerKey: string): string | null {
  try {
    return parsePeerKey(peerKey).channelId;
  } catch {
    return null;
  }
}

function normalizeRelationModels(aid: string, peerKey: string, locked: LockedModelDefault[]): boolean {
  const existing = readRelationBehaviorFile(aid, peerKey) || {};
  const { value: next, changed } = applyLockedModels(existing, locked);
  if (!changed) return false;
  writeRelationBehaviorFile(aid, peerKey, next);
  return true;
}

function readRelationBehaviorFile(aid: string, peerKey: string): BehaviorConfig | null {
  return atomicReadJson<BehaviorConfig>(agentRelationBehaviorConfig(aid, peerKey));
}

function writeRelationBehaviorFile(aid: string, peerKey: string, value: BehaviorConfig): void {
  const file = agentRelationBehaviorConfig(aid, peerKey);
  const schema = loadSchema('behavior');
  const withVersion: BehaviorConfig = {
    $schema_version: value.$schema_version ?? currentVersion('behavior'),
    ...value,
  };
  const ok = schema.validate(withVersion);
  if (!ok) {
    const errs = (schema.validate.errors || [])
      .map(e => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(`behavior config does not match schema(behavior.v${schema.version}): ${errs}`);
  }
  atomicWriteJson(file, withVersion);
  try { fileCache.invalidate(file); } catch {}
}

function applyLockedModels(value: BehaviorConfig, locked: LockedModelDefault[]): { value: BehaviorConfig; changed: boolean } {
  let next: BehaviorConfig | null = null;

  for (const item of locked) {
    const baseagents = (next || value).baseagents || {};
    const current = (baseagents as any)[item.baseagent] || {};
    if (current.model === item.model) continue;

    next = next || cloneBehavior(value);
    next.baseagents = next.baseagents || {};
    (next.baseagents as any)[item.baseagent] = {
      ...((next.baseagents as any)[item.baseagent] || {}),
      model: item.model,
    };
  }

  return { value: next || value, changed: !!next };
}

function cloneBehavior(value: BehaviorConfig): BehaviorConfig {
  return JSON.parse(JSON.stringify(value || {}));
}
