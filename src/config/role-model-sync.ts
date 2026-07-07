/**
 * role-model-sync.ts
 *
 * 角色模型自动同步功能：当角色定义中设置 allowOverride=false 时，
 * 自动扫描并修正所有违反该约束的 relation 配置。
 */

import * as fs from 'fs';
import { agentRelationsDir, agentRoleAssignmentsConfig, resolvePaths } from '../paths.js';
import { parsePeerKey } from '../core/relation/peer-identity.js';
import { ConfigTarget, read, write } from './config-manager.js';
import type { RoleAssignment, RoleAssignmentsConfig, RolesConfig, RelationConfig } from '../types.js';

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

/**
 * 扫描所有 agent，同步不允许覆盖的角色模型设置。
 *
 * 当角色定义中某个模型设置为 allowOverride=false 时，
 * 此函数会自动将所有分配了该角色的 relation 配置修正为角色默认值。
 */
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

/**
 * 同步单个 agent 的角色模型设置。
 */
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

/**
 * 规范化单个 relation 配置的模型设置（用于写入时验证）。
 */
export function normalizeRelationBehaviorForAssignedRole(
  aid: string,
  peerKey: string,
  value: RelationConfig,
  roles: RolesConfig,
): RelationConfig {
  const role = explicitRoleForRelation(aid, peerKey);
  if (!role) return value;
  const locked = buildLockedModelDefaults(roles).get(role);
  if (!locked || locked.length === 0) return value;
  return applyLockedModels(value, locked).value;
}

/**
 * 从角色配置中提取所有 allowOverride=false 的模型约束。
 */
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

/**
 * 读取 agent 的角色分配配置。
 */
function readAssignments(aid: string): RoleAssignmentsConfig {
  try {
    const config = read<RoleAssignmentsConfig>(ConfigTarget.RoleAssignments, { self: aid });
    return config ?? { $schema_version: 2, assignments: {} };
  } catch {
    return { $schema_version: 2, assignments: {} };
  }
}

/**
 * 列出 agent 的所有 relation 目录（peerKey）。
 */
function listRelationKeys(aid: string): string[] {
  const dir = agentRelationsDir(aid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_')) // 跳过 _index, _trash 等
    .map(entry => entry.name);
}

/**
 * 根据角色分配查找对应的 relation keys。
 */
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

/**
 * 从角色分配中提取目标 ID（peerId 或 groupId）。
 */
function relationTargetId(assignment: RoleAssignment): string | null {
  if (assignment.scope === 'private') return assignment.peerId || null;
  if (assignment.scope === 'group') return assignment.groupId || null;
  return null;
}

/**
 * 查找 relation 的显式角色分配。
 */
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

/**
 * 从 peerKey 中提取 channelId（解析后的 peerId/groupId）。
 */
function relationChannelId(peerKey: string): string | null {
  try {
    return parsePeerKey(peerKey).channelId;
  } catch {
    return null;
  }
}

/**
 * 检查并修正单个 relation 的模型配置。
 */
function normalizeRelationModels(aid: string, peerKey: string, locked: LockedModelDefault[]): boolean {
  const existing = read<RelationConfig>(ConfigTarget.Relation, { self: aid, peerKey });
  if (!existing) return false; // 没有配置文件，跳过

  const { value: next, changed } = applyLockedModels(existing, locked);
  if (!changed) return false;

  write(ConfigTarget.Relation, next, { self: aid, peerKey });
  return true;
}

/**
 * 应用锁定的模型设置到配置对象。
 */
function applyLockedModels(
  value: RelationConfig,
  locked: LockedModelDefault[]
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

/**
 * 深拷贝配置对象。
 */
function cloneConfig(value: RelationConfig): RelationConfig {
  return JSON.parse(JSON.stringify(value || {}));
}
