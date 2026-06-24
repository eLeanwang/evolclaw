/**
 * Role System - 角色配置读取与管理
 *
 * 提供全局角色定义的读取、缓存和查询功能。
 * 如果 roles.json 不存在，返回内置的五种角色配置。
 */

import fs from 'fs';
import { atomicReadJson } from '../utils/atomic-write.js';
import { rolesConfig } from '../paths.js';
import type { RolesConfig, RoleDefinition, FieldPermission } from '../types.js';

// 角色定义缓存
const ROLES_CACHE = new Map<string, RoleDefinition>();

/**
 * 读取全局角色配置
 * 如果文件不存在，返回内置默认配置
 */
export function readRolesConfig(): RolesConfig {
  const file = rolesConfig();

  if (fs.existsSync(file)) {
    try {
      const config = atomicReadJson<RolesConfig>(file);
      if (config) return config;
    } catch (err) {
      console.warn('[roles] Failed to read roles.json, using builtin:', err);
    }
  }

  return getBuiltinRolesConfig();
}

/**
 * 获取指定角色的定义
 * @param role 角色名称
 * @returns 角色定义，不存在返回 null
 */
export function getRoleDefinition(role: string): RoleDefinition | null {
  // 优先从缓存读取
  if (ROLES_CACHE.has(role)) {
    return ROLES_CACHE.get(role)!;
  }

  const config = readRolesConfig();
  const def = config.roles[role];

  if (def) {
    ROLES_CACHE.set(role, def);
  }

  return def || null;
}

/**
 * 获取角色对指定字段的权限
 * 支持嵌套字段路径，如 "baseagents.claude.model"
 *
 * @param role 角色名称
 * @param field 字段路径（支持点分隔）
 * @returns 权限定义，不存在返回 null
 */
export function getFieldPermission(
  role: string,
  field: string
): FieldPermission | null {
  const roleDef = getRoleDefinition(role);
  if (!roleDef) return null;

  // 直接查找字段（支持嵌套路径作为key）
  const perm = roleDef.permissions[field];
  if (perm) return perm;

  // 如果没找到，返回 null 而不是 undefined
  return null;
}

/**
 * 清空角色缓存（用于测试或热重载）
 */
export function clearRolesCache(): void {
  ROLES_CACHE.clear();
}

/**
 * 内置默认角色配置
 * 五种角色：owner > admin > member > guest > anonymous
 */
export function getBuiltinRolesConfig(): RolesConfig {
  return {
    $schema_version: 1,
    roles: {
      owner: {
        description: 'Agent 所有者，完全控制权限',
        permissions: {
          permissionMode: {
            default: 'bypass',
            allowOverride: false,
            reason: '所有者权限不可降级'
          },
          'baseagents.claude.model': {
            default: 'claude-opus-4-8',
            allowOverride: true,
            allowedModels: ['*'],
            reason: '所有者可使用任意模型'
          },
          'baseagents.claude.effort': {
            default: 'high',
            allowOverride: true
          },
          chatmode: {
            default: {
              private: 'interactive',
              group: 'proactive',
              nothuman: 'proactive'
            },
            allowOverride: true
          },
          dispatch: {
            default: 'broadcast',
            allowOverride: true,
            reason: '所有者可自由配置响应策略'
          },
          show_activities: {
            default: 'all',
            allowOverride: true
          },
          flush_delay: {
            default: 3,
            allowOverride: true
          },
          debounce: {
            default: 0,
            allowOverride: true
          },
          enable_rich_content: {
            default: true,
            allowOverride: true
          }
        }
      },
      admin: {
        description: '管理员，需要确认敏感操作',
        permissions: {
          permissionMode: {
            default: 'request',
            allowOverride: false,
            reason: '管理员必须逐次确认操作'
          },
          'baseagents.claude.model': {
            default: 'claude-sonnet-4-6',
            allowOverride: true,
            allowedModels: ['claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*'],
            reason: '管理员可使用主流模型，成本可控'
          },
          'baseagents.claude.effort': {
            default: 'medium',
            allowOverride: true
          },
          chatmode: {
            default: {
              private: 'interactive',
              group: 'proactive',
              nothuman: 'proactive'
            },
            allowOverride: true
          },
          dispatch: {
            default: 'mention',
            allowOverride: true,
            allowedValues: ['mention'],
            reason: '管理员不能配置 broadcast，避免打扰'
          },
          show_activities: {
            default: 'all',
            allowOverride: true
          },
          flush_delay: {
            default: 3,
            allowOverride: true
          },
          debounce: {
            default: 0,
            allowOverride: true
          },
          enable_rich_content: {
            default: true,
            allowOverride: true
          }
        }
      },
      member: {
        description: '团队成员，有基本使用权限',
        permissions: {
          permissionMode: {
            default: 'auto',
            allowOverride: false,
            reason: '成员使用智能判断模式'
          },
          'baseagents.claude.model': {
            default: 'claude-sonnet-4-6',
            allowOverride: true,
            allowedModels: ['claude-sonnet-*', 'claude-haiku-*'],
            reason: '成员可使用中低成本模型'
          },
          'baseagents.claude.effort': {
            default: 'medium',
            allowOverride: true
          },
          chatmode: {
            default: {
              private: 'interactive',
              group: 'proactive',
              nothuman: 'proactive'
            },
            allowOverride: true
          },
          dispatch: {
            default: 'mention',
            allowOverride: false,
            reason: '成员只能使用 mention 模式'
          },
          show_activities: {
            default: 'all',
            allowOverride: true
          },
          flush_delay: {
            default: 3,
            allowOverride: true
          },
          debounce: {
            default: 0,
            allowOverride: true
          },
          enable_rich_content: {
            default: false,
            allowOverride: true
          }
        }
      },
      guest: {
        description: '访客，只读权限，有身份但未授权',
        permissions: {
          permissionMode: {
            default: 'readonly',
            allowOverride: false,
            reason: '访客只能查询，不能执行'
          },
          'baseagents.claude.model': {
            default: 'claude-haiku-4-5',
            allowOverride: false,
            allowedModels: ['claude-haiku-*'],
            reason: '访客只能使用最低成本模型'
          },
          'baseagents.claude.effort': {
            default: 'low',
            allowOverride: false
          },
          chatmode: {
            default: {
              private: 'proactive',
              group: 'proactive',
              nothuman: 'proactive'
            },
            allowOverride: false,
            reason: '访客必须使用主动模式，避免过度消耗'
          },
          dispatch: {
            default: 'mention',
            allowOverride: false,
            reason: '访客只能通过 @mention 触发'
          },
          show_activities: {
            default: 'none',
            allowOverride: false,
            reason: '访客不应看到内部处理过程'
          },
          flush_delay: {
            default: 5,
            allowOverride: false,
            reason: '访客消息批次延迟更长'
          },
          debounce: {
            default: 0,
            allowOverride: false
          },
          enable_rich_content: {
            default: false,
            allowOverride: false
          }
        }
      },
      anonymous: {
        description: '匿名用户，完全未认证，极度受限',
        permissions: {
          permissionMode: {
            default: 'readonly',
            allowOverride: false,
            reason: '匿名用户只读'
          },
          'baseagents.claude.model': {
            default: 'claude-haiku-4-5',
            allowOverride: false,
            allowedModels: ['claude-haiku-*'],
            reason: '匿名只能使用最低成本模型'
          },
          'baseagents.claude.effort': {
            default: 'low',
            allowOverride: false
          },
          chatmode: {
            default: {
              private: 'proactive',
              group: 'proactive',
              nothuman: 'proactive'
            },
            allowOverride: false
          },
          dispatch: {
            default: 'mention',
            allowOverride: false
          },
          show_activities: {
            default: 'none',
            allowOverride: false
          },
          flush_delay: {
            default: 10,
            allowOverride: false,
            reason: '匿名用户延迟最长'
          },
          debounce: {
            default: 0,
            allowOverride: false
          },
          enable_rich_content: {
            default: false,
            allowOverride: false
          }
        }
      }
    }
  };
}
