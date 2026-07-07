// TODO: 此文件是角色系统文件，在 5eda64a (v3设计) 中不存在
// 需要重构以对齐 v3 设计（去除 behavior.json）
// 暂时创建存根让代码编译通过

import type { RolesConfig } from '../types.js';

export interface RoleModelSyncResult {
  scannedAgents: number;
  scannedAssignments: number;
  updatedRelations: number;
}

export function syncNoOverrideRoleModelsForAllAgents(): RoleModelSyncResult {
  console.warn('[role-model-sync] 此功能暂时禁用，需要对齐 v3 设计');
  return { scannedAgents: 0, scannedAssignments: 0, updatedRelations: 0 };
}

export function syncNoOverrideRoleModelsForAgent(): RoleModelSyncResult {
  console.warn('[role-model-sync] 此功能暂时禁用，需要对齐 v3 设计');
  return { scannedAgents: 0, scannedAssignments: 0, updatedRelations: 0 };
}

export function normalizeRelationBehaviorForAssignedRole(
  aid: string,
  peerKey: string,
  value: any,
  roles: RolesConfig | null
): any {
  return value;
}
