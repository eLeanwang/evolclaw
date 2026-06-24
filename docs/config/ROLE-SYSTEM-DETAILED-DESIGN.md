# EvolClaw 角色系统详细设计文档

> 版本：v1.0
> 创建时间：2026-06-23
> 状态：设计阶段
> 作者：系统架构组

---

## 文档目录

1. [设计概述](#一设计概述)
2. [架构设计](#二架构设计)
3. [数据模型](#三数据模型)
4. [接口设计](#四接口设计)
5. [实现细节](#五实现细节)
6. [迁移方案](#六迁移方案)
7. [测试计划](#七测试计划)
8. [部署方案](#八部署方案)

---

## 一、设计概述

### 1.1 设计目标

**核心目标**：建立清晰、安全、可扩展的角色权限体系，实现以下能力：

1. **权限分离**：不同角色拥有明确区分的权限边界
2. **成本控制**：通过角色限制模型使用，控制 API 成本
3. **安全防护**：防止权限提升和配置绕过
4. **个性化**：在安全边界内允许用户个性化配置
5. **可扩展**：支持自定义角色和灵活的权限配置

### 1.2 设计原则

1. **最小权限原则**：默认赋予最小必要权限，按需提升
2. **纵深防御**：多层权限检查，配置层 + 运行时层
3. **显式优于隐式**：权限配置显式声明，避免隐式继承
4. **向后兼容**：新设计兼容现有配置，平滑迁移
5. **可审计**：所有权限决策可追溯来源

### 1.3 非目标

- ❌ 不实现细粒度的 RBAC（Role-Based Access Control）系统
- ❌ 不实现动态权限（运行时权限提升/降级）
- ❌ 不实现权限委托和代理机制
- ❌ 不改变现有的 H/HA 配置链架构

---

## 二、架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Configuration Layer                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐      ┌──────────────┐                     │
│  │  roles.json  │      │ config.json  │                     │
│  │  (全局定义)   │      │ (角色映射)   │                     │
│  └──────┬───────┘      └──────┬───────┘                     │
│         │                     │                              │
│         └──────────┬──────────┘                              │
│                    │                                         │
│         ┌──────────▼─────────────┐                          │
│         │  Role Resolver         │                          │
│         │  (角色解析器)           │                          │
│         └──────────┬─────────────┘                          │
│                    │                                         │
│         ┌──────────▼─────────────┐                          │
│         │  Permission Resolver   │                          │
│         │  (权限解析器)           │                          │
│         └──────────┬─────────────┘                          │
│                    │                                         │
├────────────────────┼─────────────────────────────────────────┤
│                    │         Merge Layer                     │
│         ┌──────────▼─────────────┐                          │
│         │  Role Constraint       │                          │
│         │  Merger                │                          │
│         │  (角色约束合并器)       │                          │
│         └──────────┬─────────────┘                          │
│                    │                                         │
│         ┌──────────▼─────────────┐                          │
│         │  Effective Config      │                          │
│         │  (最终生效配置)         │                          │
│         └──────────┬─────────────┘                          │
│                    │                                         │
├────────────────────┼─────────────────────────────────────────┤
│                    │         Runtime Layer                   │
│         ┌──────────▼─────────────┐                          │
│         │  Permission Guard      │                          │
│         │  (运行时权限守卫)       │                          │
│         └────────────────────────┘                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 配置层次

```
┌─────────────────────────────────────────────────────────┐
│ Level 1: Global Role Definition (roles.json)           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ - owner: {permissions: {...}}                       │ │
│ │ - admin: {permissions: {...}}                       │ │
│ │ - member: {permissions: {...}}                      │ │
│ │ - guest: {permissions: {...}}                       │ │
│ │ - anonymous: {permissions: {...}}                   │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Level 2: Role Mapping (agents/{aid}/config.json)       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ owners: ["alice.aid.pub", "bob.aid.pub"]            │ │
│ │ admins: ["charlie.aid.pub"]                         │ │
│ │ members: ["dave.aid.pub", "eve.aid.pub"]            │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Level 3: Relation Override (受角色约束)                 │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ agents/{aid}/relations/{peerKey}/behavior.json      │ │
│ │ - 只能覆盖 allowOverride=true 的字段                │ │
│ │ - 必须符合 allowedModels/allowedValues 约束        │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.3 核心组件

#### 2.3.1 Role Resolver（角色解析器）

**职责**：根据用户标识和 agent 配置，解析用户角色

**输入**：
- `agentId`: Agent 标识
- `peerKey`: 用户标识

**输出**：
- `role`: 'owner' | 'admin' | 'member' | 'guest' | 'anonymous'

**逻辑**：
```typescript
if (config.owners.includes(peerKey)) return 'owner';
if (config.admins.includes(peerKey)) return 'admin';
if (config.members.includes(peerKey)) return 'member';
if (isAuthenticated(peerKey)) return 'guest';
return 'anonymous';
```

#### 2.3.2 Permission Resolver（权限解析器）

**职责**：根据角色和字段名，查询该角色对该字段的权限定义

**输入**：
- `role`: 角色名
- `field`: 字段路径（如 "permissionMode", "baseagents.claude.model"）

**输出**：
```typescript
{
  default: any,              // 默认值
  allowOverride: boolean,    // 是否允许覆盖
  allowedModels?: string[],  // 允许的模型列表
  allowedValues?: any[],     // 允许的值列表
  reason?: string            // 原因说明
}
```

#### 2.3.3 Role Constraint Merger（角色约束合并器）

**职责**：合并配置时应用角色约束

**输入**：
- `role`: 用户角色
- `rolePermissions`: 角色权限定义
- `relationConfig`: 关系级配置

**输出**：
- `effectiveConfig`: 应用约束后的最终配置

**核心逻辑**：
```typescript
for each field in relationConfig:
  roleRule = rolePermissions[field]
  
  if (!roleRule.allowOverride):
    result[field] = roleRule.default  // 强制使用角色默认值
  else:
    if (field is 'baseagents.*.model'):
      if (relationConfig[field] in roleRule.allowedModels):
        result[field] = relationConfig[field]
      else:
        throw PermissionDenied
    else:
      result[field] = relationConfig[field] ?? roleRule.default
```

#### 2.3.4 Permission Guard（运行时权限守卫）

**职责**：在运行时检查操作权限

**检查点**：
1. 消息处理前：检查 `permissionMode`
2. 工具调用前：检查工具权限
3. 模型调用前：检查模型是否在 `allowedModels` 内
4. 配置写入前：检查字段是否 `allowOverride`

---

## 三、数据模型

### 3.1 roles.json Schema

**文件路径**：`{evolclaw_home}/roles.json`

**Schema 文件**：`kits/schemas/roles.schema.1.json`

#### 3.1.1 顶层结构

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "roles.schema.1.json",
  "title": "RolesConfig",
  "description": "Global role definitions and permissions",
  "type": "object",
  "required": ["$schema_version", "roles"],
  "properties": {
    "$schema_version": {
      "type": "number",
      "const": 1
    },
    "roles": {
      "type": "object",
      "description": "Role definitions",
      "additionalProperties": {
        "$ref": "#/definitions/RoleDefinition"
      }
    }
  },
  "definitions": {
    "RoleDefinition": {
      "type": "object",
      "required": ["description", "permissions"],
      "properties": {
        "description": {
          "type": "string",
          "description": "Human-readable role description"
        },
        "permissions": {
          "type": "object",
          "description": "Field-level permissions",
          "additionalProperties": {
            "$ref": "#/definitions/FieldPermission"
          }
        }
      }
    },
    "FieldPermission": {
      "type": "object",
      "required": ["default", "allowOverride"],
      "properties": {
        "default": {
          "description": "Default value for this field"
        },
        "allowOverride": {
          "type": "boolean",
          "description": "Whether relation-level config can override"
        },
        "allowedModels": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Allowed model patterns (for baseagents)"
        },
        "allowedValues": {
          "type": "array",
          "description": "Allowed values (for enum fields)"
        },
        "reason": {
          "type": "string",
          "description": "Explanation for this permission setting"
        }
      }
    }
  }
}
```

#### 3.1.2 TypeScript 类型定义

```typescript
// src/config/roles.ts

export interface RolesConfig {
  $schema_version: number;
  roles: Record<string, RoleDefinition>;
}

export interface RoleDefinition {
  description: string;
  permissions: Record<string, FieldPermission>;
}

export interface FieldPermission<T = any> {
  default: T;
  allowOverride: boolean;
  allowedModels?: string[];    // for baseagents.*.model
  allowedValues?: T[];         // for enum fields
  reason?: string;
}

export type BuiltinRole = 'owner' | 'admin' | 'member' | 'guest' | 'anonymous';

export interface RoleContext {
  self: string;
  peerKey: string;
  role: BuiltinRole | string;
}
```

### 3.2 agent-config.json 扩展

#### 3.2.1 新增 members 字段

**现有字段**：
```json
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"]
}
```

**扩展后**：
```json
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub", "dave.aid.pub"]
}
```

#### 3.2.2 Schema 更新

```json
// kits/schemas/agent-config.schema.1.json
{
  "properties": {
    "owners": {
      "type": "array",
      "items": {"type": "string"},
      "x-merge": "list"
    },
    "admins": {
      "type": "array",
      "items": {"type": "string"},
      "x-merge": "list"
    },
    "members": {
      "type": "array",
      "items": {"type": "string"},
      "x-merge": "list",
      "description": "Team members with basic permissions"
    }
  }
}
```

### 3.3 行为配置约束模型

#### 3.3.1 字段分类

**Security 字段**（Security Fields）：
- 定义：影响系统安全和权限边界的字段
- 特征：`allowOverride = false` 对所有角色
- 示例：`permissionMode`

**Cost-Control 字段**（Cost-Control Fields）：
- 定义：影响 API 成本的字段
- 特征：根据角色有不同的 `allowedModels` 约束
- 示例：`baseagents.*.model`, `baseagents.*.effort`

**Behavior 字段**（Behavior Fields）：
- 定义：影响交互行为但不涉及安全的字段
- 特征：高权限角色可覆盖，低权限角色不可
- 示例：`dispatch`, `chatmode`, `show_activities`

**Preference 字段**（Preference Fields）：
- 定义：纯用户偏好设置
- 特征：多数角色可覆盖
- 示例：`flush_delay`, `debounce`, `enable_rich_content`

#### 3.3.2 约束检查模型

```typescript
interface ConstraintViolation {
  field: string;
  reason: 'override_not_allowed' | 'model_not_allowed' | 'value_not_allowed';
  attempted: any;
  allowed: any;
  role: string;
}

interface ConstraintCheckResult {
  valid: boolean;
  violations: ConstraintViolation[];
  effectiveConfig: BehaviorConfig;
}
```

---

## 四、接口设计

### 4.1 核心 API

#### 4.1.1 角色解析 API

```typescript
/**
 * 解析用户在指定 agent 中的角色
 * @param self - Agent ID
 * @param peerKey - 用户标识
 * @returns 用户角色
 */
export function resolveUserRole(
  self: string,
  peerKey: string
): BuiltinRole | 'guest';

// 示例
const role = resolveUserRole('myagent.aid.pub', 'alice.aid.pub');
// => 'owner'
```

#### 4.1.2 权限查询 API

```typescript
/**
 * 查询角色对指定字段的权限
 * @param role - 角色名
 * @param field - 字段路径
 * @returns 权限定义，不存在返回 null
 */
export function getFieldPermission(
  role: string,
  field: string
): FieldPermission | null;

// 示例
const perm = getFieldPermission('guest', 'permissionMode');
// => { default: 'readonly', allowOverride: false, reason: '...' }
```

#### 4.1.3 约束合并 API

```typescript
/**
 * 应用角色约束合并配置
 * @param role - 用户角色
 * @param relationConfig - 关系级配置
 * @returns 约束检查结果
 */
export function mergeWithRoleConstraints(
  role: string,
  relationConfig: Partial<BehaviorConfig>
): ConstraintCheckResult;

// 示例
const result = mergeWithRoleConstraints('guest', {
  permissionMode: 'bypass',  // 尝试提权
  chatmode: { private: 'interactive' }
});
// result.valid = false
// result.violations[0] = {
//   field: 'permissionMode',
//   reason: 'override_not_allowed',
//   attempted: 'bypass',
//   allowed: 'readonly',
//   role: 'guest'
// }
```

#### 4.1.4 模型白名单检查 API

```typescript
/**
 * 检查模型是否在角色的允许列表内
 * @param role - 角色名
 * @param model - 模型名称
 * @returns 是否允许
 */
export function isModelAllowed(
  role: string,
  model: string
): boolean;

// 示例
isModelAllowed('guest', 'claude-opus-4-8');  // => false
isModelAllowed('guest', 'claude-haiku-4-5'); // => true
isModelAllowed('owner', 'claude-opus-4-8');  // => true
```

#### 4.1.5 配置写入校验 API

```typescript
/**
 * 校验配置写入是否符合角色约束
 * @param target - 配置目标
 * @param config - 待写入配置
 * @param context - 角色上下文
 * @returns 校验结果
 */
export function validateConfigWrite(
  target: ConfigTarget,
  config: Partial<BehaviorConfig>,
  context: RoleContext
): ConstraintCheckResult;

// 示例
const result = validateConfigWrite(
  ConfigTarget.RelationBehavior,
  { permissionMode: 'bypass' },
  { self: 'myagent', peerKey: 'guest.aid.pub', role: 'guest' }
);
// result.valid = false
```

### 4.2 CLI 命令接口

#### 4.2.1 角色管理命令

```bash
# 列出所有角色定义
ec role list [--json]

# 查看角色详情
ec role describe <role> [--json]

# 查看用户角色
ec role show --self <aid> --peer <peerKey>

# 审计角色配置
ec role audit [--self <aid>]
```

#### 4.2.2 配置命令扩展

```bash
# 检查配置是否符合角色约束
ec config validate --self <aid> --peer <peerKey> [--check-role]

# 显示配置时包含角色信息
ec config effective --self <aid> --peer <peerKey> [--show-role]

# 显示字段的角色约束
ec config field-info <field> --role <role>
```

### 4.3 配置文件接口

#### 4.3.1 读取全局角色定义

```typescript
/**
 * 读取全局角色配置
 * @returns 角色配置，不存在返回默认内置角色
 */
export function readRolesConfig(): RolesConfig;

// 内部实现
export function readRolesConfig(): RolesConfig {
  const file = rolesConfigPath();
  if (fs.existsSync(file)) {
    return atomicReadJson<RolesConfig>(file);
  }
  return getBuiltinRolesConfig();
}
```

#### 4.3.2 写入角色配置

```typescript
/**
 * 写入全局角色配置
 * @param config - 角色配置
 */
export function writeRolesConfig(config: RolesConfig): void;

// 注意：普通用户不应直接写入 roles.json
// 仅限管理员通过 CLI 或配置管理界面修改
```

---

## 五、实现细节

### 5.1 代码结构

#### 5.1.1 新增文件

```
src/config/
├── roles.ts                 # 角色配置核心逻辑
├── role-resolver.ts         # 角色解析器
├── role-constraints.ts      # 角色约束合并
└── permission-guard.ts      # 运行时权限守卫

kits/schemas/
└── roles.schema.1.json      # 角色配置 schema

tests/
├── role-resolver.test.ts
├── role-constraints.test.ts
└── permission-guard.test.ts

docs/config/
└── roles-reference.md       # 角色配置参考文档
```

#### 5.1.2 修改文件

```
src/config/config-manager.ts # 集成角色约束合并
src/core/model/config-scope.ts # 更新角色定义常量
src/cli/config.ts            # 添加角色相关命令
src/paths.ts                 # 添加 roles.json 路径
kits/schemas/agent-config.schema.1.json # 添加 members 字段
```

### 5.2 核心实现

#### 5.2.1 角色解析器实现

```typescript
// src/config/role-resolver.ts

import { read, ConfigTarget } from './config-manager.js';
import type { AgentConfig } from '../types.js';

export type BuiltinRole = 'owner' | 'admin' | 'member' | 'guest' | 'anonymous';

/**
 * 解析用户角色
 * 优先级：owners > admins > members > 已认证用户(guest) > 匿名(anonymous)
 */
export function resolveUserRole(
  self: string,
  peerKey: string
): BuiltinRole | 'guest' {
  try {
    const config = read<AgentConfig>(ConfigTarget.Agent, { self });
    if (!config) return 'anonymous';

    // 检查 owners
    if (config.owners?.includes(peerKey)) {
      return 'owner';
    }

    // 检查 admins
    if (config.admins?.includes(peerKey)) {
      return 'admin';
    }

    // 检查 members
    if (config.members?.includes(peerKey)) {
      return 'member';
    }

    // 已认证但未授权 -> guest
    if (isAuthenticated(peerKey)) {
      return 'guest';
    }

    // 完全未认证 -> anonymous
    return 'anonymous';
  } catch (err) {
    console.warn(`[role-resolver] Failed to resolve role for ${peerKey}:`, err);
    return 'anonymous'; // 安全降级
  }
}

/**
 * 检查用户是否已认证
 * 简单判断：peerKey 是否符合 AID 格式
 */
function isAuthenticated(peerKey: string): boolean {
  // AID 格式：xxx.aid.pub 或 xxx.agentid.pub
  return /^[a-z0-9_-]+\.(aid|agentid)\.pub$/i.test(peerKey);
}

/**
 * 批量解析多个用户的角色
 */
export function resolveUserRoles(
  self: string,
  peerKeys: string[]
): Map<string, BuiltinRole | 'guest'> {
  const result = new Map<string, BuiltinRole | 'guest'>();
  for (const peerKey of peerKeys) {
    result.set(peerKey, resolveUserRole(self, peerKey));
  }
  return result;
}
```

#### 5.2.2 角色配置读取实现

```typescript
// src/config/roles.ts

import fs from 'fs';
import { atomicReadJson, atomicWriteJson } from '../utils/atomic-write.js';
import { resolvePaths } from '../paths.js';
import type { RolesConfig, RoleDefinition, FieldPermission } from './types.js';

const ROLES_CACHE = new Map<string, RoleDefinition>();

/**
 * 读取全局角色配置
 * 如果文件不存在，返回内置默认配置
 */
export function readRolesConfig(): RolesConfig {
  const file = rolesConfigPath();
  
  if (fs.existsSync(file)) {
    try {
      return atomicReadJson<RolesConfig>(file);
    } catch (err) {
      console.warn('[roles] Failed to read roles.json, using builtin:', err);
    }
  }
  
  return getBuiltinRolesConfig();
}

/**
 * 获取指定角色的定义
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
 */
export function getFieldPermission(
  role: string,
  field: string
): FieldPermission | null {
  const roleDef = getRoleDefinition(role);
  if (!roleDef) return null;

  // 支持嵌套字段路径，如 "baseagents.claude.model"
  const parts = field.split('.');
  let current: any = roleDef.permissions;

  for (const part of parts) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[part];
  }

  return current as FieldPermission | null;
}

/**
 * roles.json 文件路径
 */
function rolesConfigPath(): string {
  const paths = resolvePaths();
  return `${paths.root}/roles.json`;
}

/**
 * 内置默认角色配置
 */
function getBuiltinRolesConfig(): RolesConfig {
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
            allowedModels: ['*']
          },
          'baseagents.claude.effort': {
            default: 'high',
            allowOverride: true
          },
          chatmode: {
            default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' },
            allowOverride: true
          },
          dispatch: {
            default: 'broadcast',
            allowOverride: true
          },
          show_activities: {
            default: 'all',
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
            allowedModels: ['claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*']
          },
          'baseagents.claude.effort': {
            default: 'medium',
            allowOverride: true
          },
          chatmode: {
            default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' },
            allowOverride: true
          },
          dispatch: {
            default: 'mention',
            allowOverride: true,
            allowedValues: ['mention']
          }
        }
      },
      member: {
        description: '团队成员，基本使用权限',
        permissions: {
          permissionMode: {
            default: 'auto',
            allowOverride: false
          },
          'baseagents.claude.model': {
            default: 'claude-sonnet-4-6',
            allowOverride: true,
            allowedModels: ['claude-sonnet-*', 'claude-haiku-*']
          },
          chatmode: {
            default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' },
            allowOverride: true
          },
          dispatch: {
            default: 'mention',
            allowOverride: false
          }
        }
      },
      guest: {
        description: '访客，只读权限',
        permissions: {
          permissionMode: {
            default: 'readonly',
            allowOverride: false
          },
          'baseagents.claude.model': {
            default: 'claude-haiku-4-5',
            allowOverride: false,
            allowedModels: ['claude-haiku-*']
          },
          chatmode: {
            default: { private: 'proactive', group: 'proactive', nothuman: 'proactive' },
            allowOverride: false
          }
        }
      },
      anonymous: {
        description: '匿名用户，极度受限',
        permissions: {
          permissionMode: {
            default: 'readonly',
            allowOverride: false
          },
          'baseagents.claude.model': {
            default: 'claude-haiku-4-5',
            allowOverride: false,
            allowedModels: ['claude-haiku-*']
          },
          chatmode: {
            default: { private: 'proactive', group: 'proactive', nothuman: 'proactive' },
            allowOverride: false
          }
        }
      }
    }
  };
}

/**
 * 清空角色缓存（用于测试或热重载）
 */
export function clearRolesCache(): void {
  ROLES_CACHE.clear();
}
```

#### 5.2.3 角色约束合并实现

```typescript
// src/config/role-constraints.ts

import { getRoleDefinition, getFieldPermission } from './roles.js';
import type { BehaviorConfig, ConstraintCheckResult, ConstraintViolation } from './types.js';

/**
 * 应用角色约束合并配置
 */
export function mergeWithRoleConstraints(
  role: string,
  relationConfig: Partial<BehaviorConfig>
): ConstraintCheckResult {
  const roleDef = getRoleDefinition(role);
  
  if (!roleDef) {
    // 未定义的角色，降级到 member 级别
    console.warn(`[role-constraints] Unknown role: ${role}, fallback to member`);
    return mergeWithRoleConstraints('member', relationConfig);
  }

  const violations: ConstraintViolation[] = [];
  const effectiveConfig: Partial<BehaviorConfig> = {};

  // 遍历角色定义的所有字段
  for (const [field, permission] of Object.entries(roleDef.permissions)) {
    const relationValue = getNestedValue(relationConfig, field);
    
    if (!permission.allowOverride) {
      // 不允许覆盖，强制使用角色默认值
      if (relationValue !== undefined && relationValue !== permission.default) {
        violations.push({
          field,
          reason: 'override_not_allowed',
          attempted: relationValue,
          allowed: permission.default,
          role
        });
      }
      setNestedValue(effectiveConfig, field, permission.default);
    } else {
      // 允许覆盖，但需要检查约束
      if (relationValue !== undefined) {
        // 检查模型白名单
        if (field.includes('.model') && permission.allowedModels) {
          if (!isModelAllowed(relationValue, permission.allowedModels)) {
            violations.push({
              field,
              reason: 'model_not_allowed',
              attempted: relationValue,
              allowed: permission.allowedModels,
              role
            });
            setNestedValue(effectiveConfig, field, permission.default);
          } else {
            setNestedValue(effectiveConfig, field, relationValue);
          }
        }
        // 检查值白名单
        else if (permission.allowedValues) {
          if (!permission.allowedValues.includes(relationValue)) {
            violations.push({
              field,
              reason: 'value_not_allowed',
              attempted: relationValue,
              allowed: permission.allowedValues,
              role
            });
            setNestedValue(effectiveConfig, field, permission.default);
          } else {
            setNestedValue(effectiveConfig, field, relationValue);
          }
        }
        // 无约束，直接使用
        else {
          setNestedValue(effectiveConfig, field, relationValue);
        }
      } else {
        // 关系级未配置，使用角色默认值
        setNestedValue(effectiveConfig, field, permission.default);
      }
    }
  }

  // 处理角色定义中没有的字段（保留，但发出警告）
  for (const field of Object.keys(relationConfig)) {
    if (!roleDef.permissions[field]) {
      console.warn(`[role-constraints] Field ${field} not defined in role ${role}, keeping as-is`);
      setNestedValue(effectiveConfig, field, getNestedValue(relationConfig, field));
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    effectiveConfig: effectiveConfig as BehaviorConfig
  };
}

/**
 * 检查模型是否在白名单内
 */
function isModelAllowed(model: string, allowedModels: string[]): boolean {
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
 * 公开的模型白名单检查 API
 */
export function isModelAllowedForRole(role: string, model: string): boolean {
  const perm = getFieldPermission(role, 'baseagents.claude.model');
  if (!perm || !perm.allowedModels) {
    return false;
  }
  return isModelAllowed(model, perm.allowedModels);
}
```

#### 5.2.4 集成到 ConfigManager

```typescript
// src/config/config-manager.ts

import { resolveUserRole } from './role-resolver.js';
import { mergeWithRoleConstraints } from './role-constraints.js';

/**
 * 解析最终生效配置（集成角色约束）
 */
export function resolveEffective(sel: Selector, opts: ReadOpts = {}): EffectiveAgentConfig {
  // 1. 合并 H 链
  const config = resolveAgentConfig(sel, opts);
  
  // 2. 合并 HA 链（behavior）
  let effective = mergeBehaviorIntoEffective(config, sel, opts);
  
  // 3. 应用角色约束（新增）
  if (sel.self && sel.peerKey) {
    const role = resolveUserRole(sel.self, sel.peerKey);
    const relationBehavior = read<BehaviorConfig>(ConfigTarget.RelationBehavior, sel, opts);
    
    if (relationBehavior) {
      const constrained = mergeWithRoleConstraints(role, relationBehavior);
      
      if (!constrained.valid) {
        console.warn(`[config-manager] Role constraint violations for ${sel.peerKey}:`, constrained.violations);
      }
      
      // 使用约束后的配置
      effective = { ...effective, ...constrained.effectiveConfig };
    }
  }
  
  return effective;
}

/**
 * 配置写入前的角色约束校验
 */
export function validateConfigWrite(
  target: ConfigTarget,
  config: Partial<BehaviorConfig>,
  sel: Selector
): ConstraintCheckResult {
  // 只对 behavior 配置进行角色约束检查
  if (target !== ConfigTarget.RelationBehavior) {
    return { valid: true, violations: [], effectiveConfig: config as BehaviorConfig };
  }

  if (!sel.self || !sel.peerKey) {
    throw new ConfigError('SELECTOR_REQUIRED', 'RelationBehavior requires self and peerKey');
  }

  const role = resolveUserRole(sel.self, sel.peerKey);
  return mergeWithRoleConstraints(role, config);
}
```

---

## 六、迁移方案

### 6.1 迁移策略

#### 6.1.1 分阶段迁移

**Phase 0: 准备阶段**（1 周）
- 创建 roles.json 和 schema
- 实现核心角色解析和约束逻辑
- 编写单元测试

**Phase 1: 软切换**（2 周）
- 部署新代码，但默认不启用角色约束
- 通过环境变量 `EVOLCLAW_ENABLE_ROLE_CONSTRAINTS=true` 开启
- 只记录警告，不阻止操作
- 监控日志，发现配置冲突

**Phase 2: 宽松模式**（2 周）
- 默认启用角色约束
- 违反约束时降级到角色默认值，不阻止操作
- 通知用户配置被调整
- 收集反馈，调整角色权限

**Phase 3: 严格模式**（1 周）
- 违反约束的写入操作直接失败
- CLI 提供迁移工具，帮助用户修正配置
- 完全启用权限守卫

#### 6.1.2 兼容性处理

**现有 admin 用户权限变化**：
```typescript
// 迁移脚本：src/scripts/migrate-admin-permissions.ts

async function migrateAdminPermissions() {
  const agents = loadAllAgents();
  
  for (const agent of agents) {
    const admins = agent.config.admins || [];
    
    for (const admin of admins) {
      const relationBehavior = readRelationBehavior(agent.aid, admin);
      
      if (!relationBehavior) {
        // 为现有 admin 创建关系级配置，保持 bypass 权限
        writeRelationBehavior(agent.aid, admin, {
          permissionMode: 'bypass',
          _migrated: true,
          _migration_reason: 'preserve_legacy_admin_bypass'
        });
        
        console.log(`✓ Migrated admin ${admin} for agent ${agent.aid}`);
      }
    }
  }
}
```

**现有 behavior.json 中的 roles 字段**：
```typescript
// 迁移脚本：src/scripts/migrate-embedded-roles.ts

async function migrateEmbeddedRoles() {
  const agents = loadAllAgents();
  const globalRoles: Record<string, RoleDefinition> = {};
  
  for (const agent of agents) {
    const behavior = readAgentBehavior(agent.aid);
    
    if (behavior?.roles) {
      console.log(`Found embedded roles in agent ${agent.aid}:`, Object.keys(behavior.roles));
      
      // 合并到全局 roles.json
      for (const [roleName, roleDef] of Object.entries(behavior.roles)) {
        if (!globalRoles[roleName]) {
          globalRoles[roleName] = convertToGlobalRoleDef(roleDef);
        }
      }
      
      // 从 behavior.json 中移除 roles 字段
      delete behavior.roles;
      writeAgentBehavior(agent.aid, behavior);
      
      console.log(`✓ Migrated embedded roles for agent ${agent.aid}`);
    }
  }
  
  // 写入全局 roles.json
  if (Object.keys(globalRoles).length > 0) {
    const existingRoles = readRolesConfig();
    existingRoles.roles = { ...existingRoles.roles, ...globalRoles };
    writeRolesConfig(existingRoles);
    
    console.log(`✓ Merged ${Object.keys(globalRoles).length} custom roles to global roles.json`);
  }
}
```

### 6.2 回滚计划

#### 6.2.1 紧急回滚

如果角色系统导致严重问题：

**方法 1：环境变量禁用**
```bash
export EVOLCLAW_ENABLE_ROLE_CONSTRAINTS=false
ec daemon restart
```

**方法 2：代码回滚**
```bash
git revert <role-system-commit>
npm run build
ec daemon restart
```

**方法 3：配置回滚**
```bash
# 备份当前配置
ec config snapshot --tag pre-role-system

# 回滚到之前版本
ec config restore <snapshot-id>
```

#### 6.2.2 数据恢复

```typescript
// 恢复脚本：src/scripts/rollback-role-system.ts

async function rollbackRoleSystem() {
  const agents = loadAllAgents();
  
  for (const agent of agents) {
    // 恢复 admin 的 bypass 权限（如果被降级）
    const admins = agent.config.admins || [];
    for (const admin of admins) {
      const behavior = readRelationBehavior(agent.aid, admin);
      if (behavior?._migrated) {
        delete behavior._migrated;
        delete behavior._migration_reason;
        // 保留显式设置的 bypass
      }
    }
  }
  
  // 可选：删除 roles.json
  // fs.unlinkSync(rolesConfigPath());
  
  console.log('✓ Rollback complete');
}
```

---

## 七、测试计划

### 7.1 单元测试

#### 7.1.1 角色解析测试

```typescript
// tests/role-resolver.test.ts

describe('Role Resolver', () => {
  it('should resolve owner role', () => {
    const role = resolveUserRole('agent1', 'alice.aid.pub');
    expect(role).toBe('owner');
  });

  it('should resolve admin role', () => {
    const role = resolveUserRole('agent1', 'bob.aid.pub');
    expect(role).toBe('admin');
  });

  it('should resolve member role', () => {
    const role = resolveUserRole('agent1', 'charlie.aid.pub');
    expect(role).toBe('member');
  });

  it('should resolve guest role for authenticated user', () => {
    const role = resolveUserRole('agent1', 'stranger.aid.pub');
    expect(role).toBe('guest');
  });

  it('should resolve anonymous role for unauthenticated', () => {
    const role = resolveUserRole('agent1', 'unknown-user');
    expect(role).toBe('anonymous');
  });

  it('should handle missing agent config', () => {
    const role = resolveUserRole('non-existent', 'alice.aid.pub');
    expect(role).toBe('anonymous'); // 安全降级
  });
});
```

#### 7.1.2 角色约束测试

```typescript
// tests/role-constraints.test.ts

describe('Role Constraints', () => {
  describe('permissionMode constraint', () => {
    it('should prevent guest from using bypass', () => {
      const result = mergeWithRoleConstraints('guest', {
        permissionMode: 'bypass'
      });
      
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].reason).toBe('override_not_allowed');
      expect(result.effectiveConfig.permissionMode).toBe('readonly');
    });

    it('should allow owner to keep bypass', () => {
      const result = mergeWithRoleConstraints('owner', {
        permissionMode: 'bypass'
      });
      
      expect(result.valid).toBe(true);
      expect(result.effectiveConfig.permissionMode).toBe('bypass');
    });
  });

  describe('model whitelist constraint', () => {
    it('should prevent guest from using opus', () => {
      const result = mergeWithRoleConstraints('guest', {
        baseagents: {
          claude: { model: 'claude-opus-4-8' }
        }
      });
      
      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toBe('model_not_allowed');
    });

    it('should allow member to use sonnet', () => {
      const result = mergeWithRoleConstraints('member', {
        baseagents: {
          claude: { model: 'claude-sonnet-4-6' }
        }
      });
      
      expect(result.valid).toBe(true);
    });

    it('should allow owner to use any model', () => {
      const result = mergeWithRoleConstraints('owner', {
        baseagents: {
          claude: { model: 'claude-opus-4-8' }
        }
      });
      
      expect(result.valid).toBe(true);
    });
  });

  describe('dispatch constraint', () => {
    it('should prevent member from using broadcast', () => {
      const result = mergeWithRoleConstraints('member', {
        dispatch: 'broadcast'
      });
      
      expect(result.valid).toBe(false);
      expect(result.effectiveConfig.dispatch).toBe('mention');
    });
  });
});
```

#### 7.1.3 集成测试

```typescript
// tests/role-integration.test.ts

describe('Role System Integration', () => {
  beforeEach(() => {
    // 准备测试环境
    setupTestAgent('test-agent', {
      owners: ['owner.aid.pub'],
      admins: ['admin.aid.pub'],
      members: ['member.aid.pub']
    });
  });

  it('should apply role constraints in resolveEffective', () => {
    // guest 尝试设置 bypass
    writeRelationBehavior('test-agent', 'guest.aid.pub', {
      permissionMode: 'bypass'
    });

    const effective = resolveEffective({
      self: 'test-agent',
      peerKey: 'guest.aid.pub'
    });

    // 应该被降级到 readonly
    expect(effective.permissionMode).toBe('readonly');
  });

  it('should validate config write', () => {
    const result = validateConfigWrite(
      ConfigTarget.RelationBehavior,
      { permissionMode: 'bypass' },
      { self: 'test-agent', peerKey: 'guest.aid.pub' }
    );

    expect(result.valid).toBe(false);
  });
});
```

### 7.2 E2E 测试

```typescript
// tests/e2e/role-system.e2e.test.ts

describe('Role System E2E', () => {
  it('should enforce guest readonly in real conversation', async () => {
    // 模拟 guest 用户发送消息
    const response = await sendMessage({
      from: 'guest.aid.pub',
      to: 'test-agent',
      content: 'execute command'
    });

    // 应该被 permissionMode: readonly 阻止
    expect(response.error).toMatch(/readonly/);
  });

  it('should allow owner to execute commands', async () => {
    const response = await sendMessage({
      from: 'owner.aid.pub',
      to: 'test-agent',
      content: 'execute command'
    });

    expect(response.success).toBe(true);
  });

  it('should enforce model whitelist', async () => {
    // member 尝试使用 opus
    const result = await setModelForRelation(
      'test-agent',
      'member.aid.pub',
      'claude-opus-4-8'
    );

    expect(result.error).toMatch(/model not allowed/);
  });
});
```

### 7.3 测试覆盖率目标

- **单元测试覆盖率**：>= 90%
- **集成测试覆盖率**：>= 80%
- **E2E 测试场景**：>= 10 个核心场景

---

## 八、部署方案

### 8.1 部署步骤

#### 8.1.1 开发环境部署（1 天）

```bash
# 1. 拉取代码
git checkout feature/role-system
git pull

# 2. 安装依赖
npm install

# 3. 运行测试
npm test

# 4. 构建
npm run build

# 5. 生成默认 roles.json
ec role init

# 6. 启动 daemon（测试模式）
EVOLCLAW_ENABLE_ROLE_CONSTRAINTS=true ec daemon start

# 7. 验证
ec role list
ec role describe owner
```

#### 8.1.2 预发环境部署（3 天）

```bash
# 1. 备份配置
ec config snapshot --tag pre-role-system-staging

# 2. 部署代码
git checkout feature/role-system
npm install && npm run build

# 3. 运行迁移脚本
node dist/scripts/migrate-admin-permissions.js --dry-run
node dist/scripts/migrate-admin-permissions.js --apply

# 4. 启动服务（软切换模式）
EVOLCLAW_ENABLE_ROLE_CONSTRAINTS=false ec daemon restart

# 5. 监控日志
tail -f ~/.evolclaw/logs/daemon.log | grep role-constraints

# 6. 逐步开启约束
EVOLCLAW_ENABLE_ROLE_CONSTRAINTS=true ec daemon restart

# 7. 观察 3 天，收集反馈
```

#### 8.1.3 生产环境部署（分批）

**批次 1：试点 agent（10%）**
- 选择 2-3 个非关键 agent
- 部署并开启角色约束
- 观察 1 周

**批次 2：扩大范围（50%）**
- 选择一半 agent
- 部署并开启角色约束
- 观察 3 天

**批次 3：全量（100%）**
- 所有 agent
- 严格模式启用
- 持续监控

### 8.2 监控指标

#### 8.2.1 关键指标

| 指标 | 说明 | 阈值 |
|------|------|------|
| `role_constraint_violations` | 角色约束违规次数 | < 10/小时 |
| `permission_denied_rate` | 权限拒绝率 | < 1% |
| `config_write_failures` | 配置写入失败次数 | < 5/天 |
| `role_resolution_errors` | 角色解析错误次数 | 0 |
| `role_config_load_time` | 角色配置加载时间 | < 10ms |

#### 8.2.2 告警规则

```yaml
# Prometheus 告警规则
groups:
  - name: role_system
    rules:
      - alert: HighRoleConstraintViolations
        expr: rate(role_constraint_violations_total[5m]) > 0.1
        annotations:
          summary: "High role constraint violations detected"
          
      - alert: RoleResolutionFailure
        expr: role_resolution_errors_total > 0
        annotations:
          summary: "Role resolution errors detected"
```

### 8.3 回滚触发条件

立即回滚：
- ✅ 权限拒绝率 > 10%
- ✅ 角色解析错误 > 5 次/小时
- ✅ 配置写入失败 > 20 次/小时
- ✅ 用户投诉 > 3 起严重问题

---

## 九、附录

### 9.1 完整的 roles.json 示例

见文档末尾 `roles.json.example`

### 9.2 CLI 命令完整列表

```bash
# 角色管理
ec role list                          # 列出所有角色
ec role describe <role>               # 查看角色详情
ec role show --self <aid> --peer <pk> # 查看用户角色
ec role audit                         # 审计角色配置
ec role init                          # 初始化 roles.json

# 配置命令扩展
ec config validate --check-role --self <aid> --peer <pk>
ec config effective --show-role --self <aid> --peer <pk>
ec config field-info <field> --role <role>

# 迁移工具
ec role migrate-admins --dry-run      # 迁移 admin 权限（预览）
ec role migrate-admins --apply        # 迁移 admin 权限（应用）
ec role migrate-embedded --dry-run    # 迁移嵌入式角色（预览）
ec role migrate-embedded --apply      # 迁移嵌入式角色（应用）
```

### 9.3 术语表

| 术语 | 英文 | 说明 |
|------|------|------|
| 角色 | Role | 用户在 agent 中的身份类型 |
| 权限 | Permission | 角色允许执行的操作 |
| 约束 | Constraint | 对配置覆盖的限制 |
| 白名单 | Whitelist | 允许的值列表 |
| 覆盖 | Override | 关系级配置覆盖角色默认值 |
| 生效配置 | Effective Config | 应用所有覆盖链后的最终配置 |

---

## 十、变更历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| v1.0 | 2026-06-23 | 系统架构组 | 初始版本 |

---

**文档结束**
