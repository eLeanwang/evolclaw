import type { FieldPermission, RoleDefinition, RolesConfig } from '../types.js';

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function mergeRolesConfig(base: RolesConfig, overlay: RolesConfig | null | undefined): RolesConfig {
  if (!overlay || !overlay.roles) return base;

  const merged: RolesConfig = {
    $schema_version: base.$schema_version,
    defaultRoles: overlay.defaultRoles ?? base.defaultRoles,
    roles: {},
  };

  for (const [roleName, baseDef] of Object.entries(base.roles)) {
    const overlayDef = overlay.roles[roleName];
    if (!overlayDef) {
      merged.roles[roleName] = baseDef;
      continue;
    }

    const mergedPerms: Record<string, FieldPermission> = { ...baseDef.permissions };
    for (const [field, overlayPerm] of Object.entries(overlayDef.permissions || {})) {
      mergedPerms[field] = overlayPerm;
    }

    merged.roles[roleName] = {
      description: overlayDef.description ?? baseDef.description,
      allowAccess: overlayDef.allowAccess ?? baseDef.allowAccess,
      permissions: mergedPerms,
    };
  }

  for (const [roleName, overlayDef] of Object.entries(overlay.roles)) {
    if (!base.roles[roleName]) merged.roles[roleName] = overlayDef;
  }

  return merged;
}

export function diffRolesConfig(builtin: RolesConfig, full: RolesConfig): RolesConfig {
  const diff: RolesConfig = {
    $schema_version: builtin.$schema_version,
    roles: {},
  };

  if (!deepEqual(full.defaultRoles, builtin.defaultRoles)) {
    diff.defaultRoles = full.defaultRoles;
  }

  for (const [roleName, fullDef] of Object.entries(full.roles)) {
    const builtinDef = builtin.roles[roleName];
    if (!builtinDef) {
      diff.roles[roleName] = fullDef;
      continue;
    }

    const permDiff: Record<string, FieldPermission> = {};
    for (const [field, fullPerm] of Object.entries(fullDef.permissions || {})) {
      const builtinPerm = builtinDef.permissions[field];
      if (!builtinPerm || !deepEqual(fullPerm, builtinPerm)) permDiff[field] = fullPerm;
    }

    const descDiff = fullDef.description !== builtinDef.description;
    const accessDiff = fullDef.allowAccess !== builtinDef.allowAccess;
    if (Object.keys(permDiff).length === 0 && !descDiff && !accessDiff) continue;

    const roleDiff: RoleDefinition = {
      description: descDiff ? fullDef.description : builtinDef.description,
      permissions: permDiff,
    };
    if (accessDiff) roleDiff.allowAccess = fullDef.allowAccess;
    diff.roles[roleName] = roleDiff;
  }

  return diff;
}
