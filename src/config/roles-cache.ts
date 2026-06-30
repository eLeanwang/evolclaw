import type { RoleDefinition } from '../types.js';

const ROLES_CACHE = new Map<string, RoleDefinition>();

export function getCachedRoleDefinition(role: string): RoleDefinition | null {
  return ROLES_CACHE.get(role) ?? null;
}

export function setCachedRoleDefinition(role: string, definition: RoleDefinition): void {
  ROLES_CACHE.set(role, definition);
}

export function clearRolesCache(): void {
  ROLES_CACHE.clear();
}
