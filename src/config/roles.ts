import { ConfigTarget, read } from './config-manager.js';
import {
  getBuiltinRolesConfig,
  getBuiltinUserRoleDefinitions,
  getManagementRoleDefinition,
  isManagementRole,
  isReservedRoleName,
} from './builtin-roles.js';
import type { AgentConfig, CommandPermission, FieldPermission, RoleDefinition, RolesConfig } from '../types.js';

const ROLE_NAME_RE = /^[a-z0-9_-]+$/;

export { getBuiltinRolesConfig };

export function readRolesConfig(selfAid?: string): RolesConfig {
  const builtin = getBuiltinRolesConfig();
  const definitions = selfAid ? readAgentRoleDefinitions(selfAid) : {};
  return {
    $schema_version: builtin.$schema_version,
    defaultRoles: selfAid ? readDefaultRoles(selfAid) : builtin.defaultRoles,
    roles: mergeUserRoleDefinitions(builtin.roles, definitions),
  };
}

export function getRoleDefinition(role: string, selfAid?: string): RoleDefinition | null {
  if (isManagementRole(role)) return getManagementRoleDefinition(role);
  const config = readRolesConfig(selfAid);
  return config.roles[role] || null;
}

export function getUserRoleDefinition(role: string, selfAid?: string): RoleDefinition | null {
  if (isReservedRoleName(role)) return null;
  const config = readRolesConfig(selfAid);
  return config.roles[role] || null;
}

export function getFieldPermission(
  role: string,
  field: string,
  selfAid?: string,
): FieldPermission | null {
  const roleDef = getRoleDefinition(role, selfAid);
  return roleDef?.permissions[field] ?? null;
}

export function getCommandPermissions(role: string, selfAid?: string): Record<string, CommandPermission> {
  const roleDef = getRoleDefinition(role, selfAid);
  return roleDef?.commandPermissions || {};
}

export function clearRolesCache(): void {
  // Retained as a no-op for callers that invalidate role state after config writes.
}

export function isValidUserRoleName(role: unknown): role is string {
  return typeof role === 'string'
    && ROLE_NAME_RE.test(role)
    && !isReservedRoleName(role);
}

export function roleExists(role: string | null | undefined, selfAid?: string): role is string {
  if (!role || !isValidUserRoleName(role)) return false;
  return !!getUserRoleDefinition(role, selfAid);
}

export function normalizeDefaultRole(
  value: unknown,
  selfAid: string | undefined,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  return roleExists(value, selfAid) ? value : null;
}

function readDefaultRoles(selfAid: string): RolesConfig['defaultRoles'] {
  const agent = read<AgentConfig>(ConfigTarget.Agent, { self: selfAid }, { cache: true });
  const builtin = getBuiltinRolesConfig().defaultRoles ?? {};
  return {
    private: Object.prototype.hasOwnProperty.call(agent?.roles?.defaultRoles ?? {}, 'private')
      ? agent?.roles?.defaultRoles?.private ?? null
      : builtin.private ?? null,
    group: Object.prototype.hasOwnProperty.call(agent?.roles?.defaultRoles ?? {}, 'group')
      ? agent?.roles?.defaultRoles?.group ?? null
      : builtin.group ?? null,
  };
}

function readAgentRoleDefinitions(selfAid: string): Record<string, RoleDefinition> {
  const agent = read<AgentConfig>(ConfigTarget.Agent, { self: selfAid }, { cache: true });
  return agent?.roles?.definitions ?? {};
}

function mergeUserRoleDefinitions(
  builtin: Record<string, RoleDefinition>,
  overrides: Record<string, RoleDefinition>,
): Record<string, RoleDefinition> {
  const result: Record<string, RoleDefinition> = deepCloneRoleMap(builtin);

  for (const [roleName, roleDef] of Object.entries(overrides || {})) {
    if (!isValidUserRoleName(roleName)) continue;
    if (!roleDef || typeof roleDef !== 'object') continue;

    const base = result[roleName];
    result[roleName] = base ? mergeRoleDefinition(base, roleDef) : cloneRoleDefinition(roleDef);
  }

  return result;
}

function mergeRoleDefinition(base: RoleDefinition, overlay: RoleDefinition): RoleDefinition {
  return {
    description: overlay.description ?? base.description,
    allowAccess: overlay.allowAccess ?? base.allowAccess,
    permissions: {
      ...(base.permissions || {}),
      ...(overlay.permissions || {}),
    },
    commandPermissions: {
      ...(base.commandPermissions || {}),
      ...(overlay.commandPermissions || {}),
    },
    usageLimits: overlay.usageLimits
      ? { ...(base.usageLimits || {}), ...overlay.usageLimits }
      : base.usageLimits ? { ...base.usageLimits } : undefined,
  };
}

function deepCloneRoleMap(value: Record<string, RoleDefinition>): Record<string, RoleDefinition> {
  const out: Record<string, RoleDefinition> = {};
  for (const [key, def] of Object.entries(value)) {
    out[key] = cloneRoleDefinition(def);
  }
  return out;
}

function cloneRoleDefinition(def: RoleDefinition): RoleDefinition {
  return {
    description: def.description,
    allowAccess: def.allowAccess,
    permissions: { ...(def.permissions || {}) },
    commandPermissions: { ...(def.commandPermissions || {}) },
    usageLimits: def.usageLimits ? { ...def.usageLimits } : undefined,
  };
}
