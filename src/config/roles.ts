import { resolveRoles } from './config-manager.js';
import type { RolesConfig, RoleDefinition, FieldPermission, CommandPermission } from '../types.js';
import {
  clearRolesCache as clearSharedRolesCache,
  getCachedRoleDefinition,
  setCachedRoleDefinition,
} from './roles-cache.js';

export { getBuiltinRolesConfig } from './builtin-roles.js';

export function readRolesConfig(): RolesConfig {
  return resolveRoles({ cache: true });
}

export function getRoleDefinition(role: string): RoleDefinition | null {
  const cached = getCachedRoleDefinition(role);
  if (cached) return cached;

  const config = readRolesConfig();
  const def = config.roles[role];
  if (def) setCachedRoleDefinition(role, def);
  return def || null;
}

export function getFieldPermission(
  role: string,
  field: string
): FieldPermission | null {
  const roleDef = getRoleDefinition(role);
  return roleDef?.permissions[field] ?? null;
}

export function clearRolesCache(): void {
  clearSharedRolesCache();
}

export function getCommandPermissions(role: string): Record<string, CommandPermission> {
  const roleDef = getRoleDefinition(role);
  return roleDef?.commandPermissions || {};
}
