/**
 * roles-merge —— roles 配置的 overlay 合并与 diff（per-FieldPermission 粒度）。
 *
 * roles.json 采用 overlay 存储模型：
 *   内置基线 getBuiltinRolesConfig()  ← 随代码升级变化，作为 base
 *         ⊕ deep-merge（per-FieldPermission）
 *   用户 roles.json（只存 diff）        ← 只有用户改过的 permission 才在这里
 *
 * 为什么不复用 merge.ts 的 mergeLayers：
 *   roles schema 的 `roles` 属性无 x-merge，通用合并会当 dict 浅合并（role 名为键整体覆盖），
 *   不满足"内置新增字段自动补全 + 用户改动保留"的字段级需求。
 *
 * 为什么 diff 最小单位是整个 FieldPermission：
 *   roles.schema.1.json 在 FieldPermission 层 additionalProperties:false 且
 *   required:[default, allowOverride]，无法存部分 permission。用户改 dispatch.default 时，
 *   整个 dispatch permission（含 reason）一并冻结存入。
 *
 * 本模块为纯函数，不依赖 config-manager（避免循环依赖）。
 */

import type { RolesConfig, RoleDefinition, FieldPermission } from '../types.js';

/** 深比较（用于判断某个 FieldPermission 是否相对内置发生变化）。 */
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

/**
 * 合并内置基线与用户 overlay（diff），得到完整生效配置。
 *
 * 合并规则（per-FieldPermission）：
 *   - overlay 无此 role → 整份用 base（含 base 全部最新字段）
 *   - overlay 有此 role → permissions 按 field 合并：base 全部 field 打底（新字段自动补全），
 *     overlay 的 field 覆盖（保留用户改动）；description 用 overlay 的（若有）否则 base 的
 *   - overlay 独有的 role（用户自定义角色）→ 完整保留
 *
 * @param base    内置基线（getBuiltinRolesConfig）
 * @param overlay 用户 diff（roles.json），null/缺失时返回 base
 */
export function mergeRolesConfig(base: RolesConfig, overlay: RolesConfig | null | undefined): RolesConfig {
  if (!overlay || !overlay.roles) {
    return base;
  }

  const merged: RolesConfig = {
    $schema_version: base.$schema_version,
    roles: {},
  };

  // 1. 遍历 base 的角色（内置）
  for (const [roleName, baseDef] of Object.entries(base.roles)) {
    const overlayDef = overlay.roles[roleName];

    if (!overlayDef) {
      // 用户未改过这个角色 → 整份用 base
      merged.roles[roleName] = baseDef;
      continue;
    }

    // 字段级合并 permissions：base 打底，overlay 覆盖
    const mergedPerms: Record<string, FieldPermission> = { ...baseDef.permissions };
    if (overlayDef.permissions) {
      for (const [field, overlayPerm] of Object.entries(overlayDef.permissions)) {
        mergedPerms[field] = overlayPerm;
      }
    }

    merged.roles[roleName] = {
      description: overlayDef.description ?? baseDef.description,
      permissions: mergedPerms,
    };
  }

  // 2. 保留用户自定义角色（base 中不存在的）
  for (const [roleName, overlayDef] of Object.entries(overlay.roles)) {
    if (!base.roles[roleName]) {
      merged.roles[roleName] = overlayDef;
    }
  }

  return merged;
}

/**
 * 计算完整配置相对内置基线的差异（diff），仅保留改动。供写入用。
 *
 * 规则：
 *   - builtin 无此 role（用户自定义）→ 整份进 diff
 *   - builtin 有此 role → 逐 field deepEqual 比对整个 FieldPermission：
 *       不同的 field 才进 diff（存完整 permission 对象）；builtin 没有的 field（用户新增）→ 进 diff
 *   - description 不同才写 description（相同省略，绝不写 undefined）
 *   - 该 role 无任何 field diff 且 description 相同 → 不写此 role
 *
 * @param builtin 内置基线
 * @param full    完整配置（已合并的视图，从 ecweb 表单或读取得到）
 */
export function diffRolesConfig(builtin: RolesConfig, full: RolesConfig): RolesConfig {
  const diff: RolesConfig = {
    $schema_version: builtin.$schema_version,
    roles: {},
  };

  for (const [roleName, fullDef] of Object.entries(full.roles)) {
    const builtinDef = builtin.roles[roleName];

    if (!builtinDef) {
      // 自定义角色 → 整份保留
      diff.roles[roleName] = fullDef;
      continue;
    }

    // 内置角色 → 逐 field 比对，只留改动
    const permDiff: Record<string, FieldPermission> = {};
    for (const [field, fullPerm] of Object.entries(fullDef.permissions || {})) {
      const builtinPerm = builtinDef.permissions[field];
      if (!builtinPerm || !deepEqual(fullPerm, builtinPerm)) {
        permDiff[field] = fullPerm;
      }
    }

    const descDiff = fullDef.description !== builtinDef.description;
    const hasPermDiff = Object.keys(permDiff).length > 0;

    if (!hasPermDiff && !descDiff) {
      // 与内置完全一致 → 不写此 role（恢复继承内置）
      continue;
    }

    const roleDiff: RoleDefinition = {
      // description 相同则沿用 builtin 值（schema 要求 description 必填，不能 undefined）
      description: descDiff ? fullDef.description : builtinDef.description,
      permissions: permDiff,
    };
    diff.roles[roleName] = roleDiff;
  }

  return diff;
}
