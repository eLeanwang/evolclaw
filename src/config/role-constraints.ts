import { agentConfig as agentConfigPath } from '../paths.js';
import { atomicReadJson } from '../utils/atomic-write.js';
import { getBuiltinRolesConfig, getManagementRoleDefinition, isManagementRole } from './builtin-roles.js';
import type { AgentConfig, ConstraintCheckResult, ConstraintViolation, FieldPermission, RoleDefinition } from '../types.js';

export function mergeWithRoleConstraints(
  role: string,
  relationConfig: Record<string, any>,
  selfAid?: string,
): ConstraintCheckResult {
  const roleDef = getRoleDefinitionForConstraints(role, selfAid);
  if (!roleDef) {
    return {
      valid: false,
      violations: [{
        field: '*',
        reason: 'override_not_allowed',
        attempted: role,
        allowed: null,
        role,
      }],
      effectiveConfig: {},
    };
  }

  const violations: ConstraintViolation[] = [];
  const effectiveConfig: Record<string, any> = {};

  for (const [field, permission] of Object.entries(roleDef.permissions || {})) {
    const relationValue = getFieldValue(relationConfig, field);

    if (!permission.allowOverride) {
      if (relationValue !== undefined && !deepEqual(relationValue, permission.default)) {
        violations.push({
          field,
          reason: 'override_not_allowed',
          attempted: relationValue,
          allowed: permission.default,
          role,
        });
      }
      setValue(effectiveConfig, field, permission.default);
      continue;
    }

    if (relationValue === undefined) {
      setValue(effectiveConfig, field, permission.default);
      continue;
    }

    if (field.includes('.model') && permission.allowedModels) {
      if (!isModelAllowedByPatterns(relationValue, permission.allowedModels)) {
        violations.push({
          field,
          reason: 'model_not_allowed',
          attempted: relationValue,
          allowed: permission.allowedModels,
          role,
        });
        setValue(effectiveConfig, field, permission.default);
      } else {
        setValue(effectiveConfig, field, relationValue);
      }
      continue;
    }

    if (permission.allowedValues && permission.allowedValues.length > 0) {
      if (!permission.allowedValues.includes(relationValue)) {
        violations.push({
          field,
          reason: 'value_not_allowed',
          attempted: relationValue,
          allowed: permission.allowedValues,
          role,
        });
        setValue(effectiveConfig, field, permission.default);
      } else {
        setValue(effectiveConfig, field, relationValue);
      }
      continue;
    }

    setValue(effectiveConfig, field, relationValue);
  }

  for (const field of Object.keys(relationConfig || {})) {
    if (roleDef.permissions?.[field]) continue;
    setValue(effectiveConfig, field, relationConfig[field]);
  }

  return {
    valid: violations.length === 0,
    violations,
    effectiveConfig,
  };
}

export function isModelAllowedForRole(role: string, model: string, baseagent = 'claude', selfAid?: string): boolean {
  const roleDef = getRoleDefinitionForConstraints(role, selfAid);
  if (!roleDef) return false;
  const perm = roleDef?.permissions?.[`baseagents.${baseagent}.model`] ?? null;
  if (!perm || !perm.allowedModels) {
    return true;
  }
  return isModelAllowedByPatterns(model, perm.allowedModels);
}

/** Return the exact field policy used by mergeWithRoleConstraints(). */
export function getRoleFieldConstraint(
  role: string,
  field: string,
  selfAid?: string,
): FieldPermission | null {
  return getRoleFieldConstraints(role, selfAid)[field] ?? null;
}

/** Return all field policies used by mergeWithRoleConstraints(). */
export function getRoleFieldConstraints(
  role: string,
  selfAid?: string,
): Record<string, FieldPermission> {
  return getRoleDefinitionForConstraints(role, selfAid)?.permissions ?? {};
}

function getRoleDefinitionForConstraints(role: string, selfAid?: string): RoleDefinition | null {
  if (isManagementRole(role)) return getManagementRoleDefinition(role);
  const definitions = {
    ...getBuiltinRolesConfig().roles,
    ...(selfAid ? readAgentRoleDefinitions(selfAid) : {}),
  };
  return definitions[role] || null;
}

function readAgentRoleDefinitions(selfAid: string): Record<string, RoleDefinition> {
  try {
    const agent = atomicReadJson<AgentConfig>(agentConfigPath(selfAid));
    return agent?.roles?.definitions ?? {};
  } catch {
    return {};
  }
}

export function isModelAllowedByPatterns(model: string, allowedModels: string[]): boolean {
  if (allowedModels.includes('*')) return true;
  for (const pattern of allowedModels) {
    if (pattern.endsWith('*')) {
      if (model.startsWith(pattern.slice(0, -1))) return true;
    } else if (model === pattern) {
      return true;
    }
  }
  return false;
}

function setValue(obj: Record<string, any>, field: string, value: any): void {
  if (field.includes('.')) {
    setNestedValue(obj, field, value);
  } else {
    obj[field] = value;
  }
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function getFieldValue(obj: Record<string, any>, field: string): any {
  if (Object.prototype.hasOwnProperty.call(obj, field)) return obj[field];
  return field.includes('.') ? getNestedValue(obj, field) : undefined;
}

function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length
    && keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}
