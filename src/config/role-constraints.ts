/**
 * Role Constraints - 角色约束合并器
 *
 * 应用角色约束合并配置，检查模型白名单和字段覆盖权限。
 * 核心功能：
 * 1. 根据角色定义应用字段约束
 * 2. 检查模型白名单（支持通配符）
 * 3. 检查值白名单
 * 4. 记录违规信息
 */

import { getRoleDefinition, getFieldPermission } from './roles.js';
import type { ConstraintViolation, ConstraintCheckResult } from '../types.js';

/**
 * 应用角色约束合并配置
 *
 * @param role 用户角色
 * @param relationConfig 关系级配置
 * @returns 约束检查结果
 */
export function mergeWithRoleConstraints(
  role: string,
  relationConfig: Record<string, any>
): ConstraintCheckResult {
  const roleDef = getRoleDefinition(role);

  if (!roleDef) {
    // 未定义的角色，降级到 member 级别
    console.warn(`[role-constraints] Unknown role: ${role}, fallback to member`);
    const result = mergeWithRoleConstraints('member', relationConfig);
    // 更新违规记录中的 role 为原始角色
    result.violations.forEach(v => v.role = role);
    return result;
  }

  const violations: ConstraintViolation[] = [];
  const effectiveConfig: Record<string, any> = {};

  // 遍历角色定义的所有字段
  for (const [field, permission] of Object.entries(roleDef.permissions)) {
    // 从 relationConfig 中获取值（支持扁平键和嵌套对象）
    let relationValue = relationConfig[field];

    // 如果扁平键没找到，尝试从嵌套对象中提取
    if (relationValue === undefined && field.includes('.')) {
      relationValue = getNestedValue(relationConfig, field);
    }

    if (!permission.allowOverride) {
      // 不允许覆盖，强制使用角色默认值
      if (relationValue !== undefined && !deepEqual(relationValue, permission.default)) {
        violations.push({
          field,
          reason: 'override_not_allowed',
          attempted: relationValue,
          allowed: permission.default,
          role
        });
      }
      if (field.includes('.')) {
        setNestedValue(effectiveConfig, field, permission.default);
      } else {
        effectiveConfig[field] = permission.default;
      }
    } else {
      // 允许覆盖，但需要检查约束
      if (relationValue !== undefined) {
        // 检查模型白名单
        if (field.includes('.model') && permission.allowedModels) {
          if (!isModelAllowedByPatterns(relationValue, permission.allowedModels)) {
            violations.push({
              field,
              reason: 'model_not_allowed',
              attempted: relationValue,
              allowed: permission.allowedModels,
              role
            });
            if (field.includes('.')) {
              setNestedValue(effectiveConfig, field, permission.default);
            } else {
              effectiveConfig[field] = permission.default;
            }
          } else {
            if (field.includes('.')) {
              setNestedValue(effectiveConfig, field, relationValue);
            } else {
              effectiveConfig[field] = relationValue;
            }
          }
        }
        // 检查值白名单
        else if (permission.allowedValues && permission.allowedValues.length > 0) {
          if (!permission.allowedValues.includes(relationValue)) {
            violations.push({
              field,
              reason: 'value_not_allowed',
              attempted: relationValue,
              allowed: permission.allowedValues,
              role
            });
            if (field.includes('.')) {
              setNestedValue(effectiveConfig, field, permission.default);
            } else {
              effectiveConfig[field] = permission.default;
            }
          } else {
            if (field.includes('.')) {
              setNestedValue(effectiveConfig, field, relationValue);
            } else {
              effectiveConfig[field] = relationValue;
            }
          }
        }
        // 无约束，直接使用
        else {
          if (field.includes('.')) {
            setNestedValue(effectiveConfig, field, relationValue);
          } else {
            effectiveConfig[field] = relationValue;
          }
        }
      } else {
        // 关系级未配置，使用角色默认值
        if (field.includes('.')) {
          setNestedValue(effectiveConfig, field, permission.default);
        } else {
          effectiveConfig[field] = permission.default;
        }
      }
    }
  }

  // 处理角色定义中没有的字段（保留，但发出警告）
  for (const field of Object.keys(relationConfig)) {
    if (!roleDef.permissions[field]) {
      console.warn(`[role-constraints] Field ${field} not defined in role ${role}, keeping as-is`);
      if (field.includes('.')) {
        setNestedValue(effectiveConfig, field, relationConfig[field]);
      } else {
        effectiveConfig[field] = relationConfig[field];
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    effectiveConfig
  };
}

/**
 * 检查模型是否在角色的允许列表内
 *
 * @param role 角色名称
 * @param model 模型名称
 * @returns 是否允许
 */
export function isModelAllowedForRole(role: string, model: string): boolean {
  const perm = getFieldPermission(role, 'baseagents.claude.model');
  if (!perm || !perm.allowedModels) {
    return false;
  }
  return isModelAllowedByPatterns(model, perm.allowedModels);
}

/**
 * 检查模型是否在白名单内
 * 支持通配符模式，如 "claude-sonnet-*"
 *
 * @param model 模型名称
 * @param allowedModels 允许的模型列表
 * @returns 是否允许
 */
export function isModelAllowedByPatterns(model: string, allowedModels: string[]): boolean {
  if (allowedModels.includes('*')) {
    return true;
  }

  for (const pattern of allowedModels) {
    if (pattern.endsWith('*')) {
      // 前缀匹配，如 "claude-sonnet-*"
      const prefix = pattern.slice(0, -1);
      if (model.startsWith(prefix)) {
        return true;
      }
    } else {
      // 精确匹配
      if (model === pattern) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 获取嵌套对象的值
 *
 * @param obj 对象
 * @param path 路径（点分隔）
 * @returns 值，不存在返回 undefined
 */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * 设置嵌套对象的值
 *
 * @param obj 对象
 * @param path 路径（点分隔）
 * @param value 值
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * 深度相等比较
 *
 * @param a 值 A
 * @param b 值 B
 * @returns 是否相等
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
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

  return false;
}
