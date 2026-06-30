/**
 * roles-merge 测试：overlay 合并与 diff（per-FieldPermission 粒度）。
 */

import { describe, it, expect } from 'vitest';
import { mergeRolesConfig, diffRolesConfig } from '../src/config/roles-merge.js';
import { writeRoles } from '../src/config/config-manager.js';
import { rolesConfig } from '../src/paths.js';
import { getBuiltinRolesConfig } from '../src/config/roles.js';
import fs from 'fs';
import type { RolesConfig } from '../src/types.js';

function baseConfig(): RolesConfig {
  return {
    $schema_version: 1,
    roles: {
      member: {
        description: '团队成员',
        permissions: {
          permissionMode: { default: 'auto', allowOverride: false, reason: '成员智能判断' },
          'baseagents.claude.model': { default: 'claude-sonnet-4-6', allowOverride: true, allowedModels: ['claude-sonnet-*'] },
          dispatch: { default: 'mention', allowOverride: false },
        },
      },
      owner: {
        description: '所有者',
        permissions: {
          permissionMode: { default: 'bypass', allowOverride: false },
        },
      },
    },
  };
}

describe('mergeRolesConfig', () => {
  it('overlay 为 null 时返回 base', () => {
    const base = baseConfig();
    expect(mergeRolesConfig(base, null)).toEqual(base);
    expect(mergeRolesConfig(base, undefined)).toEqual(base);
  });

  it('用户未改的角色整份用 base', () => {
    const base = baseConfig();
    const overlay: RolesConfig = { $schema_version: 1, roles: {} };
    const merged = mergeRolesConfig(base, overlay);
    expect(merged.roles.member).toEqual(base.roles.member);
    expect(merged.roles.owner).toEqual(base.roles.owner);
  });

  it('内置新增字段自动补全到已被用户改过的角色', () => {
    const base = baseConfig();
    // 模拟升级：base 的 member 新增了一个 effort 字段
    base.roles.member.permissions['baseagents.claude.effort'] = { default: 'medium', allowOverride: true };

    // 用户此前只改了 dispatch
    const overlay: RolesConfig = {
      $schema_version: 1,
      roles: {
        member: {
          description: '团队成员',
          permissions: {
            dispatch: { default: 'broadcast', allowOverride: false },
          },
        },
      },
    };

    const merged = mergeRolesConfig(base, overlay);
    // 用户改的 dispatch 保留
    expect(merged.roles.member.permissions.dispatch.default).toBe('broadcast');
    // 新增的 effort 自动补全（跟随内置）
    expect(merged.roles.member.permissions['baseagents.claude.effort'].default).toBe('medium');
    // 未改的 model 跟随内置
    expect(merged.roles.member.permissions['baseagents.claude.model'].default).toBe('claude-sonnet-4-6');
  });

  it('用户改过的 field 覆盖内置默认值', () => {
    const base = baseConfig();
    const overlay: RolesConfig = {
      $schema_version: 1,
      roles: {
        member: {
          description: '团队成员',
          permissions: {
            'baseagents.claude.model': { default: 'claude-haiku-4-5-20251001', allowOverride: true, allowedModels: ['claude-haiku-*'] },
          },
        },
      },
    };
    const merged = mergeRolesConfig(base, overlay);
    expect(merged.roles.member.permissions['baseagents.claude.model'].default).toBe('claude-haiku-4-5-20251001');
  });

  it('用户自定义角色完整保留', () => {
    const base = baseConfig();
    const overlay: RolesConfig = {
      $schema_version: 1,
      roles: {
        developer: {
          description: '开发者',
          permissions: {
            permissionMode: { default: 'request', allowOverride: true },
          },
        },
      },
    };
    const merged = mergeRolesConfig(base, overlay);
    expect(merged.roles.developer).toEqual(overlay.roles.developer);
    // 内置角色仍在
    expect(merged.roles.member).toBeDefined();
  });

  it('overlay 改 description 时用 overlay 的', () => {
    const base = baseConfig();
    const overlay: RolesConfig = {
      $schema_version: 1,
      roles: { member: { description: '自定义描述', permissions: {} } },
    };
    const merged = mergeRolesConfig(base, overlay);
    expect(merged.roles.member.description).toBe('自定义描述');
  });
});

describe('diffRolesConfig', () => {
  it('与内置完全一致 → 空 diff', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    const diff = diffRolesConfig(builtin, full);
    expect(Object.keys(diff.roles)).toHaveLength(0);
  });

  it('单个 permission 改动 → 只含该 permission', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.member.permissions.dispatch.default = 'broadcast';

    const diff = diffRolesConfig(builtin, full);
    expect(Object.keys(diff.roles)).toEqual(['member']);
    // 只有 dispatch 进 diff，其它 permission 不进
    expect(Object.keys(diff.roles.member.permissions)).toEqual(['dispatch']);
    expect(diff.roles.member.permissions.dispatch.default).toBe('broadcast');
    // description 相同 → 沿用 builtin 值（不写 undefined）
    expect(diff.roles.member.description).toBe('团队成员');
  });

  it('整个 permission 作为单位存入（含 reason 一起冻结）', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.member.permissions.permissionMode.default = 'request';

    const diff = diffRolesConfig(builtin, full);
    // 整个 permissionMode 对象存入，reason 一并带上
    expect(diff.roles.member.permissions.permissionMode).toEqual({
      default: 'request', allowOverride: false, reason: '成员智能判断',
    });
  });

  it('用户新增的 field（内置没有）进 diff', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.member.permissions['custom.field'] = { default: 'x', allowOverride: true };

    const diff = diffRolesConfig(builtin, full);
    expect(diff.roles.member.permissions['custom.field']).toEqual({ default: 'x', allowOverride: true });
  });

  it('自定义角色完整进 diff', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.developer = {
      description: '开发者',
      permissions: { permissionMode: { default: 'request', allowOverride: true } },
    };
    const diff = diffRolesConfig(builtin, full);
    expect(diff.roles.developer).toEqual(full.roles.developer);
  });

  it('description 改动 → 写入新 description', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.member.description = '新描述';
    const diff = diffRolesConfig(builtin, full);
    expect(diff.roles.member.description).toBe('新描述');
  });

  it('diff 后再 merge 可还原完整视图（round-trip）', () => {
    const builtin = baseConfig();
    const full = baseConfig();
    full.roles.member.permissions.dispatch.default = 'broadcast';
    full.roles.developer = {
      description: '开发者',
      permissions: { permissionMode: { default: 'request', allowOverride: true } },
    };

    const diff = diffRolesConfig(builtin, full);
    const restored = mergeRolesConfig(builtin, diff);
    expect(restored.roles.member.permissions.dispatch.default).toBe('broadcast');
    expect(restored.roles.developer).toEqual(full.roles.developer);
    // 未改字段跟随内置
    expect(restored.roles.member.permissions.permissionMode).toEqual(builtin.roles.member.permissions.permissionMode);
  });
});

describe('writeRoles', () => {
  it('allows overlay diffs without defaultRoles when only role permissions change', () => {
    const full = getBuiltinRolesConfig();
    full.roles.member.permissions['baseagents.claude.model'] = {
      ...full.roles.member.permissions['baseagents.claude.model'],
      default: 'claude-haiku-4-5-20251001',
      allowedModels: ['claude-haiku-*'],
    };

    expect(() => writeRoles(full)).not.toThrow();

    const raw = JSON.parse(fs.readFileSync(rolesConfig(), 'utf-8')) as RolesConfig;
    expect(raw.defaultRoles).toBeUndefined();
    expect(raw.roles.member.permissions['baseagents.claude.model'].allowedModels).toEqual(['claude-haiku-*']);
  });
});
