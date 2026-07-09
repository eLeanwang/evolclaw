# EvolClaw 模型配置设计方案

> **文档版本**: v1.0  
> **创建时间**: 2026-06-27  
> **修订时间**: 2026-06-29  
> **状态**: Implemented  
> **作者**: 系统架构组

---

## 文档目录

1. [设计概述](#一设计概述)
2. [角色与模型映射关系](#二角色与模型映射关系)
3. [配置文件结构设计](#三配置文件结构设计)
4. [模型白名单验证逻辑](#四模型白名单验证逻辑)
5. [ecweb 后台配置功能设计](#五ecweb-后台配置功能设计)
6. [前端界面设计](#六前端界面设计)
7. [实现路径分析](#七实现路径分析)
8. [配置示例](#八配置示例)
9. [技术实现细节](#九技术实现细节)
10. [部署与迁移方案](#十部署与迁移方案)

---

## 一、设计概述

### 1.1 背景

当前 EvolClaw 已经建立了完整的角色权限体系（owner/admin/member/guest/anonymous），但模型配置方面存在以下问题：

1. **模型版本硬编码**：配置文件中直接写死具体版本号（如 `claude-opus-4-8`），新模型上线需要手动更新
2. **缺乏统一管理**：模型的上架/下架没有统一的管理入口
3. **成本控制粒度不足**：缺乏基于角色的模型使用限制
4. **配置复杂度高**：管理员需要手动编辑 JSON 文件，容易出错

### 1.2 设计目标

本方案旨在建立一套完整的模型配置体系，实现：

1. ✅ **成本分级控制**：不同角色默认使用不同成本级别的模型，防止成本失控
2. ✅ **灵活白名单机制**：支持精确型号（`claude-sonnet-4-6`）和通配符模式（`claude-sonnet-*`）
3. ✅ **ecweb 后台可配置**：管理员可在 Web 界面查看网关模型列表，并维护角色模型白名单
4. ✅ **向后兼容**：首期保持现有 `roles.schema.3.json` 结构不变，平滑迁移
5. 🔄 **模型别名解析到最新版本**：作为后续增强能力，需要先定义稳定排序和回退规则

### 1.3 设计原则

1. **最小权限原则**：默认赋予最低成本模型，按需提升
2. **自动化优先**：模型别名自动解析，减少人工维护
3. **显式优于隐式**：权限配置显式声明，避免隐式继承
4. **配置即代码**：所有配置可追溯、可审计
5. **用户友好**：提供可视化配置界面，降低配置门槛

### 1.4 非目标

本方案不涉及以下内容：

- ❌ 不改变现有的角色权限体系架构
- ❌ 不实现模型动态定价和计费系统
- ❌ 不实现模型性能监控和统计分析
- ❌ 不实现跨网关的模型统一管理
- ❌ 首期不持久化 `selectionMode` 字段；该字段只作为 ecweb 前端 UI 状态

### 1.5 当前实现边界

当前代码库已经具备模型白名单验证、角色配置合并和网关模型目录拉取能力，但仍有几个边界需要明确：

- `roles.schema.3.json` 的 `FieldPermission` 使用 `additionalProperties: false`，因此首期不能直接向角色权限写入 `selectionMode`。
- `src/core/model/model-catalog.ts` 已将 `opus`、`sonnet`、`haiku` 作为别名虚拟条目并入模型目录，但尚未实现“别名解析到最新具体型号”的稳定函数。
- ecweb 已有 `/api/role-definitions` 作为角色定义读写入口，模型权限配置 API 应复用该语义边界，不建议新建 `/api/roles/...` 写入口。
- roles 写入必须复用 ConfigManager 的 `writeRoles()`，不要绕过 overlay diff、schema 校验和缓存失效机制直接写 `roles.json`。

---

## 二、角色与模型映射关系

### 2.1 角色层级与成本控制

EvolClaw 采用五级角色体系，每个角色对应不同的成本控制策略：

```
┌─────────────────────────────────────────────────────────────┐
│ 角色层级                                                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  owner (所有者)                                               │
│  ├─ 默认模型: claude-opus-4-8（后续可迁移为 opus 别名）        │
│  ├─ 白名单: * (全模型)                                        │
│  └─ 成本: 最高                                                │
│                                                               │
│  admin (管理员)                                               │
│  ├─ 默认模型: claude-sonnet-4-6（后续可迁移为 opus/sonnet）    │
│  ├─ 白名单: claude-opus-*, claude-sonnet-*, claude-haiku-*     │
│  └─ 成本: 最高                                                │
│                                                               │
│  member (成员)                                                │
│  ├─ 默认模型: claude-sonnet-4-6                               │
│  ├─ 白名单: claude-sonnet-*, claude-haiku-*                  │
│  └─ 成本: 中等                                                │
│                                                               │
│  guest (访客)                                                 │
│  ├─ 默认模型: claude-haiku-4-5-20251001                       │
│  ├─ 白名单: claude-haiku-*                                    │
│  └─ 成本: 最低                                                │
│                                                               │
│  anonymous (匿名)                                             │
│  ├─ 默认模型: claude-haiku-4-5-20251001                       │
│  ├─ 白名单: claude-haiku-*                                    │
│  └─ 成本: 最低                                                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 模型系列分类

Claude 模型按性能和成本分为三个系列：

| 系列   | 别名     | 特点                   | 适用角色              | 成本等级 |
|--------|----------|------------------------|-----------------------|----------|
| Opus   | `opus`   | 最强性能，最高成本     | owner, admin          | 💰💰💰   |
| Sonnet | `sonnet` | 性能与成本平衡         | owner, admin, member  | 💰💰     |
| Haiku  | `haiku`  | 快速响应，经济实惠     | 所有角色              | 💰       |

### 2.3 模型别名机制

**核心概念**：使用稳定的别名（`opus`/`sonnet`/`haiku`）降低配置维护成本。当前代码已把这些别名作为虚拟模型条目并入模型目录，便于 UI 展示和后续扩展。

需要注意：当前实现尚未提供“别名自动解析到最新具体型号”的完整运行时能力。若要把内置默认模型从具体版本迁移为别名，必须先实现稳定的 `resolveModelAlias()`，并定义版本排序、无可用模型时的回退策略。

#### 解析流程

```
用户配置: "sonnet"
    ↓
1. 查询网关 /v1/models 或 /models 接口
    ↓
2. 提取所有 claude-sonnet-* 系列模型
    ↓
3. 按版本号排序，选择最新版本
    ↓
实际使用: "claude-sonnet-4-6"
```

上述流程是目标能力，不是当前完整实现。

#### 实现位置

当前已在 `src/core/model/model-catalog.ts` 中实现“别名并入目录”：

```typescript
const KNOWN_ALIASES: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: [],
  gemini: [],
};

// 别名作为虚拟条目并入目录
function withAliases(models: ModelCatalogEntry[], ba: string): ModelCatalogEntry[] {
  const aliases = KNOWN_ALIASES[ba] || [];
  const existing = new Set(models.map(m => m.id));
  const aliasEntries: ModelCatalogEntry[] = aliases
    .filter(a => !existing.has(a))
    .map(a => ({ id: a, owned_by: 'alias' }));
  return [...aliasEntries, ...models];
}
```

### 2.4 模型上下架管理

#### 新模型上线流程

```
1. AI 厂商发布新模型（如 claude-opus-4-9）
    ↓
2. 网关管理员将模型添加到网关的 /models 列表
    ↓
3. EvolClaw 自动检测到新模型（通过 getCatalog()）
    ↓
4. 通配符白名单自动允许匹配的新模型；别名配置是否自动切换取决于后续别名解析实现
    ↓
5. ecweb 后台显示新模型可用
```

#### 老模型下架流程

```
1. AI 厂商宣布下架某模型（如 claude-opus-4-6）
    ↓
2. 网关管理员从网关的 /models 列表移除
    ↓
3. EvolClaw 检测到模型不可用
    ↓
4. 通配符配置不再匹配下架模型；别名配置是否自动切换取决于后续别名解析实现
    ↓
5. 硬编码版本号的配置会收到警告
```

---

## 三、配置文件结构设计

### 3.1 roles.json 配置格式

角色配置文件（`roles.json`）是模型权限的单一真实来源（Single Source of Truth）。

#### 3.1.1 Schema 定义

当前使用 `roles.schema.3.json`，已支持首期模型配置所需字段：

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "roles.schema.3.json",
  "title": "RolesConfig",
  "properties": {
    "roles": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/definitions/RoleDefinition"
      }
    }
  },
  "definitions": {
    "FieldPermission": {
      "type": "object",
      "required": ["default", "allowOverride"],
      "properties": {
        "default": {
          "description": "默认值（可以是别名或精确型号）"
        },
        "allowOverride": {
          "type": "boolean",
          "description": "是否允许在关系配置中覆盖"
        },
        "allowedModels": {
          "type": "array",
          "items": { "type": "string" },
          "description": "允许的模型列表（支持通配符，如 claude-sonnet-*）"
        },
        "reason": {
          "type": "string",
          "description": "权限设置的原因说明"
        }
      }
    }
  }
}
```

**关键字段说明**：

- `default`: 角色的默认模型，推荐使用别名（`opus`/`sonnet`/`haiku`），也可使用精确型号
- `allowOverride`: 是否允许用户在关系级配置（`behavior.json`）中覆盖默认模型
- `allowedModels`: 模型白名单数组，支持：
  - 通配符：`claude-sonnet-*`（允许所有 sonnet 系列）
  - 精确型号：`claude-sonnet-4-6`（只允许特定版本）
  - 全模型：`*`（允许任意模型）
- `reason`: 人类可读的权限说明，用于审计和文档

**首期持久化约束**：

- 不向 `FieldPermission` 写入 `selectionMode`。当前 schema 不允许未知字段，直接写入会导致校验失败。
- ecweb 可根据 `allowedModels` 推断 UI 模式：全是通配符显示为通配符模式，全是具体模型显示为精确型号模式，混合列表显示为高级/混合模式。
- 如果后续确实需要持久化 `selectionMode`，应升级 schema 和 TypeScript 类型，而不是绕过校验。

#### 3.1.2 完整配置示例

```json
{
  "$schema_version": 3,
  "defaultRoles": {
    "private": "anonymous",
    "group": "guest"
  },
  "roles": {
    "owner": {
      "description": "Agent 所有者，完全控制权限",
      "allowAccess": true,
      "permissions": {
        "permissionMode": {
          "default": "bypass",
          "allowOverride": false
        },
        "baseagents.claude.model": {
          "default": "opus",
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "所有者可使用任意模型，无成本限制"
        },
        "baseagents.claude.effort": {
          "default": "high",
          "allowOverride": true
        }
      }
    },
    "admin": {
      "description": "管理员，需要确认敏感操作",
      "allowAccess": true,
      "permissions": {
        "permissionMode": {
          "default": "request",
          "allowOverride": false
        },
        "baseagents.claude.model": {
          "default": "opus",
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "管理员可使用任意模型"
        },
        "baseagents.claude.effort": {
          "default": "medium",
          "allowOverride": true
        }
      }
    },
    "member": {
      "description": "团队成员，有基本使用权限",
      "allowAccess": true,
      "permissions": {
        "permissionMode": {
          "default": "auto",
          "allowOverride": false
        },
        "baseagents.claude.model": {
          "default": "sonnet",
          "allowOverride": true,
          "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
          "reason": "成员可使用中低成本模型，禁止使用 opus"
        },
        "baseagents.claude.effort": {
          "default": "medium",
          "allowOverride": true
        }
      }
    },
    "guest": {
      "description": "访客，只读权限",
      "allowAccess": true,
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false
        },
        "baseagents.claude.model": {
          "default": "haiku",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "访客只能使用最低成本模型，不允许覆盖"
        },
        "baseagents.claude.effort": {
          "default": "low",
          "allowOverride": false
        }
      }
    },
    "anonymous": {
      "description": "匿名用户，完全未认证",
      "allowAccess": false,
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false
        },
        "baseagents.claude.model": {
          "default": "haiku",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "匿名用户只能使用最低成本模型"
        },
        "baseagents.claude.effort": {
          "default": "low",
          "allowOverride": false
        }
      }
    }
  }
}
```

### 3.2 relation-config (behavior.json) 配置

关系级配置允许在角色权限范围内进行个性化定制。

#### 3.2.1 配置路径

```
agents/{aid}/relations/{peerKey}/behavior.json
```

#### 3.2.2 模型覆盖示例

**场景 1：member 角色用户个性化选择模型**

```json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": {
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

**验证逻辑**：
1. 用户角色为 `member`
2. `member` 的 `allowedModels` 为 `["claude-sonnet-*", "claude-haiku-*"]`
3. `claude-haiku-4-5-20251001` 匹配 `claude-haiku-*` ✅
4. 允许使用

**场景 2：member 角色用户尝试使用 opus（违规）**

```json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": {
      "model": "claude-opus-4-8"
    }
  }
}
```

**验证逻辑**：
1. 用户角色为 `member`
2. `member` 的 `allowedModels` 为 `["claude-sonnet-*", "claude-haiku-*"]`
3. `claude-opus-4-8` 不匹配任何白名单 ❌
4. 拒绝请求，回退到角色默认模型（`sonnet`）
5. 记录违规日志

#### 3.2.3 配置优先级

```
角色默认配置（roles.json）
    ↓
    | allowOverride: true ?
    ↓
关系级配置（behavior.json）
    ↓
    | 在 allowedModels 白名单内 ?
    ↓
最终生效配置
```

### 3.3 内置默认配置

内置配置在 `src/config/roles.ts` 的 `getBuiltinRolesConfig()` 中定义，作为 `roles.json` 不存在时的兜底。

**建议调整**：将内置配置改为使用别名，确保与文档一致。

```typescript
export function getBuiltinRolesConfig(): RolesConfig {
  return {
    $schema_version: 3,
    defaultRoles: {
      private: 'anonymous',
      group: 'guest',
    },
    roles: {
      owner: {
        description: 'Agent 所有者，完全控制权限',
        allowAccess: true,
        permissions: {
          'baseagents.claude.model': {
            default: 'opus',  // 改为别名
            allowOverride: true,
            allowedModels: ['*'],
            reason: '所有者可使用任意模型'
          },
          // ... 其他权限
        }
      },
      // ... 其他角色
    }
  };
}
```

---

## 四、模型白名单验证逻辑

### 4.1 验证流程

模型白名单验证在配置合并阶段执行，由 `src/config/role-constraints.ts` 实现。

#### 4.1.1 完整验证流程图

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 用户请求使用模型 X                                         │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. 解析用户角色                                               │
│    - 查询 role-assignments.json                              │
│    - 确定角色: owner/admin/member/guest/anonymous            │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 获取角色的模型权限                                         │
│    - 读取 roles.json                                         │
│    - 提取 baseagents.claude.model 的权限定义                 │
│    - 字段: default, allowOverride, allowedModels            │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. 检查是否允许覆盖                                           │
│    - allowOverride = false → 强制使用角色默认模型             │
│    - allowOverride = true → 继续验证白名单                   │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. 白名单匹配检查                                             │
│    - 调用 isModelAllowed(model, allowedModels)               │
│    - 支持通配符（claude-sonnet-*）和精确匹配                 │
└────────────────────┬────────────────────────────────────────┘
                     ↓
          ┌──────────┴──────────┐
          ↓                     ↓
    ✅ 匹配成功          ❌ 匹配失败
          ↓                     ↓
    允许使用模型 X        回退到角色默认模型
          ↓                     ↓
    记录成功日志          记录违规日志
```

### 4.2 白名单匹配算法

已在 `src/config/role-constraints.ts` 中实现：

```typescript
/**
 * 检查模型是否在白名单内
 * 支持通配符模式，如 "claude-sonnet-*"
 *
 * @param model 模型名称
 * @param allowedModels 允许的模型列表
 * @returns 是否允许
 */
function isModelAllowed(model: string, allowedModels: string[]): boolean {
  // 1. 检查全模型通配符
  if (allowedModels.includes('*')) {
    return true;
  }

  // 2. 遍历白名单进行匹配
  for (const pattern of allowedModels) {
    if (pattern.endsWith('*')) {
      // 2.1 前缀匹配（系列级通配符）
      const prefix = pattern.slice(0, -1);
      if (model.startsWith(prefix)) {
        return true;
      }
    } else {
      // 2.2 精确匹配
      if (model === pattern) {
        return true;
      }
    }
  }

  // 3. 未匹配任何规则
  return false;
}
```

### 4.3 匹配规则示例

#### 4.3.1 通配符匹配

| 白名单模式           | 测试模型                  | 结果 | 说明                    |
|---------------------|---------------------------|------|-------------------------|
| `*`                 | `claude-opus-4-8`         | ✅   | 全模型通配符             |
| `*`                 | `deepseek-v4-pro`         | ✅   | 全模型通配符             |
| `claude-sonnet-*`   | `claude-sonnet-4-6`       | ✅   | 前缀匹配                 |
| `claude-sonnet-*`   | `claude-sonnet-4-7`       | ✅   | 前缀匹配                 |
| `claude-sonnet-*`   | `claude-opus-4-8`         | ❌   | 前缀不匹配               |
| `claude-haiku-*`    | `claude-haiku-4-5-20251001` | ✅ | 前缀匹配                 |

#### 4.3.2 精确匹配

| 白名单模式              | 测试模型                  | 结果 | 说明                    |
|------------------------|---------------------------|------|-------------------------|
| `claude-sonnet-4-6`    | `claude-sonnet-4-6`       | ✅   | 完全相同                 |
| `claude-sonnet-4-6`    | `claude-sonnet-4-7`       | ❌   | 版本号不同               |
| `opus`                 | `opus`                    | ✅   | 别名匹配（由别名解析器处理） |

#### 4.3.3 组合匹配

**白名单**: `["claude-sonnet-*", "claude-haiku-*"]`

| 测试模型                  | 结果 | 原因                          |
|---------------------------|------|-------------------------------|
| `claude-sonnet-4-6`       | ✅   | 匹配 `claude-sonnet-*`         |
| `claude-haiku-4-5-20251001` | ✅ | 匹配 `claude-haiku-*`          |
| `claude-opus-4-8`         | ❌   | 不匹任何规则                 |
| `deepseek-v4-pro`         | ❌   | 不匹配任何规则                 |

### 4.4 违规处理机制

#### 4.4.1 违规类型

```typescript
interface ConstraintViolation {
  field: string;              // 违规字段（如 "baseagents.claude.model"）
  reason: string;             // 违规原因
  attempted: any;             // 用户尝试的值
  allowed: any;               // 允许的值
  role: string;               // 用户角色
}
```

**违规原因分类**：

1. `override_not_allowed`: 字段不允许覆盖（`allowOverride: false`）
2. `model_not_allowed`: 模型不在白名单内
3. `value_not_allowed`: 其他字段值不在允许列表内

#### 4.4.2 违规处理策略

```typescript
export function mergeWithRoleConstraints(
  role: string,
  relationConfig: Record<string, any>
): ConstraintCheckResult {
  const violations: ConstraintViolation[] = [];
  const effectiveConfig: Record<string, any> = {};

  // 检查模型白名单
  if (field.includes('.model') && permission.allowedModels) {
    if (!isModelAllowed(relationValue, permission.allowedModels)) {
      // 记录违规
      violations.push({
        field,
        reason: 'model_not_allowed',
        attempted: relationValue,
        allowed: permission.allowedModels,
        role
      });
      
      // 回退到角色默认模型
      setNestedValue(effectiveConfig, field, permission.default);
    } else {
      // 允许使用
      setNestedValue(effectiveConfig, field, relationValue);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    effectiveConfig
  };
}
```

#### 4.4.3 违规日志示例

```json
{
  "timestamp": "2026-06-27T10:30:00Z",
  "user": "alice.aid.pub",
  "role": "member",
  "violation": {
    "field": "baseagents.claude.model",
    "reason": "model_not_allowed",
    "attempted": "claude-opus-4-8",
    "allowed": ["claude-sonnet-*", "claude-haiku-*"]
  },
  "action": "fallback_to_default",
  "effectiveModel": "claude-sonnet-4-6"
}
```

### 4.5 运行时验证

配置合并阶段已经会应用角色约束。运行时二次检查属于后续增强，适合在别名解析能力稳定后实现。示意流程如下：

```typescript
// 在 claude-runner.ts 中的模型解析
async function resolveModelForRole(requestedModel: string, role: string): Promise<string> {
  // 1. 可选：别名解析。首期如果没有 resolveModelAlias()，requestedModel 原样参与校验。
  const resolvedModel = await resolveModelAliasIfAvailable(requestedModel);
  
  // 2. 权限验证
  if (!isModelAllowedForRole(role, resolvedModel)) {
    console.warn(`[model-guard] Model ${resolvedModel} not allowed for role ${role}`);
    const roleDef = getRoleDefinition(role);
    const fallback = roleDef?.permissions['baseagents.claude.model']?.default || 'haiku';
    return resolveModelAliasIfAvailable(fallback);
  }
  
  // 3. 可用性验证（检查模型是否在网关目录中）
  const catalog = await getCatalog();
  if (!catalog.models.find(m => m.id === resolvedModel)) {
    console.error(`[model-guard] Model ${resolvedModel} not available in gateway`);
    return resolveModelAliasIfAvailable('claude-haiku-4-5-20251001'); // 最终兜底示例
  }
  
  return resolvedModel;
}
```

---

## 五、ecweb 后台配置功能设计

### 5.1 功能概述

ecweb 后台需要提供可视化的模型管理界面，降低配置门槛，提升管理效率。

#### 5.1.1 核心功能模块

```
┌─────────────────────────────────────────────────────────────┐
│ ecweb 后台 - 模型管理模块                                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. 模型目录查看                                              │
│     ├─ 从网关实时获取可用模型列表                             │
│     ├─ 展示模型详情（ID、系列、厂商、状态）                   │
│     └─ 标记新上线/即将下架的模型                              │
│                                                               │
│  2. 角色模型权限配置                                          │
│     ├─ 为每个角色配置默认模型                                 │
│     ├─ 配置模型白名单（支持通配符和精确型号）                 │
│     ├─ 设置是否允许用户覆盖                                   │
│     └─ 实时校验配置有效性                                     │
│                                                               │
│  3. 模型使用统计（可选）                                      │
│     ├─ 各模型的调用次数                                       │
│     ├─ 各角色的模型使用分布                                   │
│     └─ 成本预估与预警                                         │
│                                                               │
│  4. 配置审计日志                                              │
│     ├─ 记录所有模型配置变更                                   │
│     ├─ 记录模型权限违规尝试                                   │
│     └─ 导出审计报告                                           │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 后台 API 接口设计

角色定义读写在当前 ecweb 中已经使用 `/api/role-definitions` 前缀，模型权限配置应挂在同一语义边界下。`/api/roles/` 已用于角色分配，不建议承载角色定义写入。

#### 5.2.1 获取网关模型列表

**接口定义**：

```http
GET /api/models/catalog?baseagent=claude
```

`refresh=true` 只有在后端实现真实 catalog 缓存后再开放；否则不要返回伪造的 `cached: !refresh`。

**响应示例**：

```json
{
  "success": true,
  "data": {
    "models": [
      {
        "id": "claude-sonnet-4-6",
        "owned_by": "anthropic",
        "family": "sonnet",
        "status": "available"
      },
      {
        "id": "sonnet",
        "owned_by": "alias",
        "family": "sonnet",
        "status": "alias"
      }
    ],
    "source": "v1/models",
    "lastUpdate": "2026-06-29T00:00:00.000Z"
  }
}
```

实现要点：

- 复用 `src/core/model/model-catalog.ts` 的 `getCatalog()`。
- `family` 可以按模型 ID 中的 `opus`、`sonnet`、`haiku` 推断。
- `status=alias` 表示目录虚拟别名，不代表已经能解析到最新具体型号。
- `resolves_to` 只有在后续实现 `resolveModelAlias()` 后再返回。

#### 5.2.2 获取角色可配置模型

**接口定义**：

```http
GET /api/role-definitions/:role/configurable-models
```

**响应示例**：

```json
{
  "success": true,
  "data": {
    "role": "member",
    "current": {
      "defaultModel": "claude-sonnet-4-6",
      "allowOverride": true,
      "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
      "reason": "成员可使用中低成本模型",
      "selectionMode": "pattern"
    },
    "gatewayModels": [
      { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
    ],
    "matched": {
      "count": 1,
      "models": [
        { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
      ]
    }
  }
}
```

实现要点：

- `selectionMode` 是响应中的派生字段，不写入配置。
- 白名单匹配应复用角色约束中的通配符/精确匹配规则。

#### 5.2.3 预览白名单匹配结果

**接口定义**：

```http
POST /api/role-definitions/:role/preview-models
Content-Type: application/json

{
  "allowedModels": ["claude-sonnet-*", "claude-haiku-*"]
}
```

**响应示例**：

```json
{
  "success": true,
  "data": {
    "role": "member",
    "selectionMode": "pattern",
    "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
    "matched": [
      { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
    ],
    "statistics": {
      "total": 1,
      "opus": 0,
      "sonnet": 1,
      "haiku": 0,
      "other": 0
    },
    "riskHint": {
      "tier": "medium",
      "message": "包含 Sonnet 系列模型"
    }
  }
}
```

`riskHint` 只是 UI 提醒，不是计费或权限依据。

#### 5.2.4 更新角色模型权限

**接口定义**：

```http
PUT /api/role-definitions/:role/model-permissions
Content-Type: application/json

{
  "defaultModel": "claude-sonnet-4-6",
  "allowOverride": true,
  "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  "reason": "成员只允许使用验证过的中低成本模型"
}
```

保存校验：

- `role` 必须存在。
- `defaultModel` 必须是非空字符串。
- `allowOverride` 必须是 boolean。
- `allowedModels` 必须是非空字符串数组。
- `defaultModel` 必须被 `allowedModels` 允许；如要允许别名作为默认模型，需要先实现明确的别名解析策略。
- 请求体中的 `selectionMode` 必须忽略或拒绝，不能持久化。

保存流程：

1. 读取 `readRolesConfig()` 的完整合并视图。
2. 只替换目标角色的 `permissions["baseagents.claude.model"]`。
3. 调用 ConfigManager `writeRoles(fullConfig)`。
4. `writeRoles()` 负责 overlay diff、schema 校验、原子写入和角色缓存清理。
5. 返回保存后的权限配置和匹配预览。

### 5.3 数据持久化

角色模型权限写入必须复用现有 ConfigManager：

- 使用 `writeRoles(fullConfig)` 写入 roles overlay。
- 不新增 `ecweb/src/sources/config-writer.ts` 直接写 `roles.json`。
- 不手动绕过 schema 校验。
- 不手动维护角色缓存失效，除非 ConfigManager 没有覆盖到对应进程。

### 5.4 审计日志

审计日志建议作为 Phase 2 增强实现。日志应记录：

- 操作者。
- 被修改的角色。
- 修改前后的模型权限配置。
- 匹配模型数量。
- 时间戳。

---

## 六、前端界面设计

### 6.1 页面结构

ecweb 前端需要新增或增强以下页面：

```
ecweb 前端结构
├─ 现有 Tab: 角色定义 (Role Definitions)
│  └─ 增强：添加模型配置区块
│
└─ 新增 Tab: 模型目录 (Model Catalog)
   ├─ 模型列表展示
   ├─ 模型详情查看
   └─ 角色权限概览
```

### 6.2 角色定义页面增强

#### 6.2.1 模型配置区块

在现有的"角色定义"Tab 中，为每个角色添加模型配置区块。

**界面布局**：

```html
<div class="role-detail">
  <h3>Member 角色配置</h3>
  
  <!-- 现有的权限配置... -->
  
  <!-- 新增：模型配置区块 -->
  <div class="model-config-section">
    <h4>🤖 模型配置</h4>
    
    <!-- 默认模型选择 -->
    <div class="form-group">
      <label for="default-model">默认模型</label>
      <select id="default-model" class="form-control">
        <optgroup label="推荐（别名，自动最新）">
          <option value="opus">Opus - 最强性能</option>
          <option value="sonnet" selected>Sonnet - 性能平衡</option>
          <option value="haiku">Haiku - 快速经济</option>
        </optgroup>
        <optgroup label="精确型号">
          <option value="claude-opus-4-8">claude-opus-4-8</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
        </optgroup>
      </select>
      <small class="form-text">
        当前解析为: <code id="resolved-model">claude-sonnet-4-6</code>
      </small>
    </div>
    
    <!-- 允许的模型白名单 -->
    <div class="form-group">
      <label>允许的模型列表</label>
      <div class="model-whitelist">
        <label class="checkbox-label">
          <input type="checkbox" value="*"> 
          <span class="model-family all">全部模型（不限制）</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" value="claude-opus-*"> 
          <span class="model-family opus">Opus 全系列</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" value="claude-sonnet-*" checked> 
          <span class="model-family sonnet">Sonnet 全系列</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" value="claude-haiku-*" checked> 
          <span class="model-family haiku">Haiku 全系列</span>
        </label>
      </div>
      <button class="btn btn-link" onclick="showAdvancedWhitelist()">
        + 添加精确型号
      </button>
    </div>
    
    <!-- 是否允许用户覆盖 -->
    <div class="form-group">
      <label class="checkbox-label">
        <input type="checkbox" id="allow-override" checked>
        允许用户在关系配置中覆盖默认模型
      </label>
      <small class="form-text">
        ℹ️ 勾选后，用户可在对端关系的 behavior.json 中自定义模型（需在白名单内）
      </small>
    </div>
    
    <!-- 权限说明 -->
    <div class="form-group">
      <label for="permission-reason">权限说明</label>
      <input 
        type="text" 
        id="permission-reason" 
        class="form-control" 
        value="成员可使用中低成本模型"
        placeholder="简要说明此权限设置的原因"
      >
    </div>
    
    <!-- 网关可用模型预览 -->
    <div class="available-models-preview">
      <h5>🌐 网关当前可用模型</h5>
      <div class="models-grid" id="gateway-models">
        <!-- 通过 JavaScript 动态加载 -->
        <span class="model-chip opus">claude-opus-4-8</span>
        <span class="model-chip opus">claude-opus-4-7</span>
        <span class="model-chip sonnet">claude-sonnet-4-6</span>
        <span class="model-chip haiku">claude-haiku-4-5-20251001</span>
      </div>
      <button class="btn btn-sm btn-secondary" onclick="refreshModels()">
        🔄 刷新模型列表
      </button>
    </div>
    
    <!-- 保存按钮 -->
    <div class="form-actions">
      <button class="btn btn-primary" onclick="saveRoleModelConfig('member')">
        💾 保存配置
      </button>
      <button class="btn btn-secondary" onclick="resetToDefault('member')">
        ↩️ 恢复默认
      </button>
    </div>
  </div>
</div>
```

#### 6.2.2 JavaScript 交互逻辑

```javascript
// ecweb/src/static/model-config.js

/**
 * 加载角色的模型配置
 */
async function loadRoleModelConfig(role) {
  try {
    const response = await fetch(`/api/role-definitions/${role}/configurable-models`);
    const result = await response.json();
    
    if (result.success) {
      const config = result.data.current;
      
      // 填充表单
      document.getElementById('default-model').value = config.defaultModel;
      document.getElementById('allow-override').checked = config.allowOverride;
      document.getElementById('permission-reason').value = config.reason || '';
      
      // 首期不承诺别名解析到具体型号，展示当前保存值即可
      document.getElementById('resolved-model').textContent = config.defaultModel;
      
      // 勾选白名单
      config.allowedModels.forEach(pattern => {
        const checkbox = document.querySelector(`input[value="${pattern}"]`);
        if (checkbox) checkbox.checked = true;
      });
    }
  } catch (error) {
    console.error('Failed to load role config:', error);
    alert('加载配置失败: ' + error.message);
  }
}

/**
 * 保存角色的模型配置
 */
async function saveRoleModelConfig(role) {
  try {
    // 1. 收集表单数据
    const defaultModel = document.getElementById('default-model').value;
    const allowOverride = document.getElementById('allow-override').checked;
    const reason = document.getElementById('permission-reason').value;
    
    // 2. 收集白名单
    const allowedModels = Array.from(
      document.querySelectorAll('.model-whitelist input:checked')
    ).map(cb => cb.value);
    
    // 3. 验证
    if (!defaultModel) {
      alert('请选择默认模型');
      return;
    }
    
    if (allowedModels.length === 0) {
      alert('至少选择一个允许的模型');
      return;
    }
    
    // 4. 发送请求
    const response = await fetch(`/api/role-definitions/${role}/model-permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultModel,
        allowOverride,
        allowedModels,
        reason
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      alert('✅ 保存成功');
      // 刷新配置显示
      await loadRoleModelConfig(role);
    } else {
      alert('❌ 保存失败: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to save role config:', error);
    alert('保存失败: ' + error.message);
  }
}

/**
 * 刷新网关模型列表
 */
async function refreshModels() {
  try {
    const response = await fetch('/api/models/catalog');
    const result = await response.json();
    
    if (result.success) {
      const modelsGrid = document.getElementById('gateway-models');
      modelsGrid.innerHTML = result.data.models
        .filter(m => m.status === 'available')
        .map(m => `
          <span class="model-chip ${m.family || ''}" title="${m.id}">
            ${m.id}
          </span>
        `).join('');
      
      // 显示数据源
      console.log(`Models loaded from: ${result.data.source}`);
    }
  } catch (error) {
    console.error('Failed to refresh models:', error);
    alert('刷新失败: ' + error.message);
  }
}

/**
 * 实时预览模型是否被当前白名单匹配（用于添加精确型号时）
 */
async function validateModelForRole(role, model) {
  try {
    const response = await fetch(`/api/role-definitions/${role}/preview-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowedModels: [model] })
    });
    
    const result = await response.json();
    
    if (result.success) {
      return result.data.matched.some(m => m.id === model);
    }
    return false;
  } catch (error) {
    console.error('Validation failed:', error);
    return false;
  }
}

/**
 * 显示高级白名单配置（添加精确型号）
 */
function showAdvancedWhitelist() {
  const modal = document.getElementById('advanced-whitelist-modal');
  modal.style.display = 'block';
  
  // 加载可用模型列表
  loadAvailableModelsForWhitelist();
}

async function loadAvailableModelsForWhitelist() {
  const response = await fetch('/api/models/catalog');
  const result = await response.json();
  
  if (result.success) {
    const modalBody = document.getElementById('whitelist-model-list');
    modalBody.innerHTML = result.data.models
      .filter(m => m.status === 'available')
      .map(m => `
        <label class="checkbox-label">
          <input type="checkbox" value="${m.id}" data-exact="true">
          <span class="model-chip ${m.family || ''}">${m.id}</span>
        </label>
      `).join('');
  }
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
  // 加载当前角色的配置
  const currentRole = getCurrentRole(); // 从 URL 或状态获取
  if (currentRole) {
    loadRoleModelConfig(currentRole);
  }
  
  // 加载网关模型列表
  refreshModels();
});
```

### 6.3 模型目录页面（新增）

#### 6.3.1 页面布局

```html
<div id="model-catalog-tab" class="tab-content">
  <h2>🤖 模型目录</h2>
  
  <!-- 数据源信息 -->
  <div class="catalog-info">
    <span>数据源: <code id="catalog-source">v1/models</code></span>
    <span>网关: <code id="catalog-baseurl">https://mg-new.evolai.cn/claude-proxy</code></span>
    <span>更新时间: <code id="catalog-update">2026-06-27 10:30:00</code></span>
    <button class="btn btn-sm btn-secondary" onclick="refreshCatalog()">🔄 刷新</button>
  </div>
  
  <!-- 筛选器 -->
  <div class="catalog-filters">
    <label>
      系列筛选:
      <select id="family-filter" onchange="filterModels()">
        <option value="all">全部</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
        <option value="alias">别名</option>
      </select>
    </label>
    
    <label>
      状态筛选:
      <select id="status-filter" onchange="filterModels()">
        <option value="all">全部</option>
        <option value="available">可用</option>
        <option value="alias">别名</option>
      </select>
    </label>
  </div>
  
  <!-- 模型列表表格 -->
  <table class="model-catalog-table">
    <thead>
      <tr>
        <th>模型 ID</th>
        <th>系列</th>
        <th>厂商</th>
        <th>状态</th>
        <th>允许使用的角色</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody id="model-catalog-body">
      <!-- 通过 JavaScript 动态加载 -->
    </tbody>
  </table>
  
  <!-- 角色权限概览 -->
  <div class="role-permissions-overview">
    <h3>📊 角色权限概览</h3>
    <div class="roles-grid" id="roles-permissions-grid">
      <!-- 动态加载 -->
    </div>
  </div>
</div>
```

#### 6.3.2 JavaScript 渲染逻辑

```javascript
// ecweb/src/static/model-catalog.js

let catalogData = null;
let rolesData = null;

/**
 * 加载并渲染模型目录
 */
async function loadModelCatalog() {
  try {
    // 1. 加载模型列表
    const catalogResponse = await fetch('/api/models/catalog');
    const catalogResult = await catalogResponse.json();
    
    if (!catalogResult.success) {
      throw new Error(catalogResult.error);
    }
    
    catalogData = catalogResult.data;
    
    // 2. 加载角色权限
    const rolesResponse = await fetch('/api/role-definitions');
    const rolesResult = await rolesResponse.json();
    rolesData = extractModelPermissionsByRole(rolesResult.roles || {});
    
    // 3. 更新页面信息
    document.getElementById('catalog-source').textContent = catalogData.source;
    document.getElementById('catalog-baseurl').textContent = catalogData.baseUrl;
    document.getElementById('catalog-update').textContent = catalogData.lastUpdate;
    
    // 4. 渲染表格
    renderModelTable();
    
    // 5. 渲染角色权限概览
    renderRolesOverview();
    
  } catch (error) {
    console.error('Failed to load catalog:', error);
    alert('加载模型目录失败: ' + error.message);
  }
}

function extractModelPermissionsByRole(roles) {
  const out = {};
  for (const [roleName, roleDef] of Object.entries(roles)) {
    const perm = roleDef.permissions?.['baseagents.claude.model'];
    if (perm) out[roleName] = {
      defaultModel: perm.default,
      allowOverride: perm.allowOverride,
      allowedModels: perm.allowedModels || [],
      reason: perm.reason || ''
    };
  }
  return out;
}

/**
 * 渲染模型表格
 */
function renderModelTable() {
  const tbody = document.getElementById('model-catalog-body');
  
  tbody.innerHTML = catalogData.models.map(model => {
    const allowedRoles = getRolesAllowingModel(model.id);
    const familyClass = model.family || 'unknown';
    
    return `
      <tr data-family="${familyClass}" data-status="${model.status}">
        <td>
          <code class="model-id">${model.id}</code>
          ${model.resolves_to ? `<br><small>→ ${model.resolves_to}</small>` : ''}
        </td>
        <td>
          <span class="badge badge-${familyClass}">${model.family || '-'}</span>
        </td>
        <td>${model.owned_by}</td>
        <td>
          <span class="status-badge status-${model.status}">${model.status}</span>
        </td>
        <td>
          <div class="roles-badges">
            ${allowedRoles.map(r => `<span class="role-badge role-${r}">${r}</span>`).join('')}
          </div>
        </td>
        <td>
          <button class="btn btn-sm" onclick="showModelDetail('${model.id}')">详情</button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * 获取允许使用某模型的角色列表
 */
function getRolesAllowingModel(modelId) {
  const allowedRoles = [];
  
  for (const [roleName, roleConfig] of Object.entries(rolesData)) {
    const patterns = roleConfig.allowedModels || [];
    
    // 检查是否匹配
    if (patterns.includes('*')) {
      allowedRoles.push(roleName);
    } else {
      for (const pattern of patterns) {
        if (pattern.endsWith('*')) {
          if (modelId.startsWith(pattern.slice(0, -1))) {
            allowedRoles.push(roleName);
            break;
          }
        } else if (pattern === modelId) {
          allowedRoles.push(roleName);
          break;
        }
      }
    }
  }
  
  return allowedRoles;
}

/**
 * 渲染角色权限概览
 */
function renderRolesOverview() {
  const grid = document.getElementById('roles-permissions-grid');
  
  grid.innerHTML = Object.entries(rolesData).map(([roleName, config]) => `
    <div class="role-card role-${roleName}">
      <h4>${roleName}</h4>
      <div class="role-config">
        <p><strong>默认模型:</strong> <code>${config.defaultModel}</code></p>
        <p><strong>允许覆盖:</strong> ${config.allowOverride ? '✅' : '❌'}</p>
        <p><strong>白名单:</strong></p>
        <ul class="whitelist-items">
          ${config.allowedModels.map(m => `<li><code>${m}</code></li>`).join('')}
        </ul>
        <p class="reason"><em>${config.reason}</em></p>
      </div>
      <button class="btn btn-sm" onclick="editRolePermissions('${roleName}')">
        编辑配置
      </button>
    </div>
  `).join('');
}

/**
 * 筛选模型
 */
function filterModels() {
  const familyFilter = document.getElementById('family-filter').value;
  const statusFilter = document.getElementById('status-filter').value;
  
  const rows = document.querySelectorAll('#model-catalog-body tr');
  
  rows.forEach(row => {
    const family = row.dataset.family;
    const status = row.dataset.status;
    
    const familyMatch = familyFilter === 'all' || family === familyFilter;
    const statusMatch = statusFilter === 'all' || status === statusFilter;
    
    row.style.display = (familyMatch && statusMatch) ? '' : 'none';
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('model-catalog-tab')) {
    loadModelCatalog();
  }
});
```

### 6.4 CSS 样式

```css
/* ecweb/src/static/model-config.css */

.model-config-section {
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 20px;
  margin: 20px 0;
  background: #f9f9f9;
}

.model-whitelist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 10px 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.model-family {
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.model-family.opus { background: #ff6b6b; color: white; }
.model-family.sonnet { background: #4ecdc4; color: white; }
.model-family.haiku { background: #95e1d3; color: #333; }
.model-family.all { background: #666; color: white; }

.models-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0;
}

.model-chip {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  transition: transform 0.2s;
}

.model-chip:hover {
  transform: scale(1.05);
}

.model-chip.opus { background: #ffe0e0; color: #c00; }
.model-chip.sonnet { background: #e0f7fa; color: #006064; }
.model-chip.haiku { background: #e8f5e9; color: #2e7d32; }

.model-catalog-table {
  width: 100%;
  border-collapse: collapse;
  margin: 20px 0;
}

.model-catalog-table th,
.model-catalog-table td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid #ddd;
}

.model-catalog-table th {
  background: #f5f5f5;
  font-weight: 600;
}

.badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-opus { background: #ffcdd2; color: #c62828; }
.badge-sonnet { background: #b2ebf2; color: #006064; }
.badge-haiku { background: #c8e6c9; color: #2e7d32; }

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
}

.status-available { background: #4caf50; color: white; }
.status-alias { background: #ff9800; color: white; }

.roles-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.role-badge {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  background: #e0e0e0;
}

.role-badge.role-owner { background: #9c27b0; color: white; }
.role-badge.role-admin { background: #3f51b5; color: white; }
.role-badge.role-member { background: #2196f3; color: white; }
.role-badge.role-guest { background: #ff9800; color: white; }

.roles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
  margin: 20px 0;
}

.role-card {
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  background: white;
}

.role-card h4 {
  margin: 0 0 12px 0;
  text-transform: capitalize;
}

.whitelist-items {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.whitelist-items li {
  padding: 2px 0;
}

.reason {
  color: #666;
  font-size: 13px;
  margin-top: 8px;
}
```

---

## 七、实现路径分析

### 7.1 现有代码已支持的功能

以下功能已在当前代码库中实现，可直接复用：

| 功能 | 实现位置 | 说明 |
|------|---------|------|
| ✅ 模型别名目录项 | `src/core/model/model-catalog.ts` | `KNOWN_ALIASES` 定义了 `opus/sonnet/haiku`，`withAliases()` 将别名并入目录；尚未实现解析到最新具体型号 |
| ✅ 网关模型列表获取 | `src/core/model/model-catalog.ts` | `getCatalog()` 实现多级回退：`/v1/models` → `/models` → 远端接口 → mock |
| ✅ 模型白名单验证 | `src/config/role-constraints.ts` | `isModelAllowed()` 支持通配符（`claude-sonnet-*`）和精确匹配 |
| ✅ 角色权限 Schema | `kits/schemas/roles.schema.3.json` | 已定义 `allowedModels`、`allowOverride` 等字段 |
| ✅ 配置合并逻辑 | `src/config/role-constraints.ts` | `mergeWithRoleConstraints()` 应用角色约束并记录违规 |
| ✅ 角色解析 | `src/config/roles.ts` | `getRoleDefinition()` 和 `getFieldPermission()` 已实现 |
| ✅ 角色定义 API 基础 | `ecweb/src/sources/role-definitions.ts` | 已有 `/api/role-definitions` 读写入口，应在该边界扩展模型权限 API |
| ✅ roles overlay 写入 | `src/config/config-manager.ts` | `writeRoles()` 负责 diff、schema 校验、原子写入和缓存清理 |

### 7.2 需要新增的功能

以下功能需要**新增实现**：

#### 7.2.1 后端 API 接口（优先级：高）

| 接口 | 路径 | 功能 | 实现位置 |
|------|------|------|---------|
| 🆕 获取模型目录 | `GET /api/models/catalog` | 调用 `getCatalog()` 返回网关模型列表 | `ecweb/src/server.ts` |
| 🆕 获取角色可配置模型 | `GET /api/role-definitions/:role/configurable-models` | 返回角色模型权限、网关目录和匹配预览 | `ecweb/src/sources/role-definitions.ts` |
| 🆕 预览白名单匹配结果 | `POST /api/role-definitions/:role/preview-models` | 检查候选 `allowedModels` 实际匹配哪些网关模型 | `ecweb/src/sources/role-definitions.ts` |
| 🆕 更新角色模型权限 | `PUT /api/role-definitions/:role/model-permissions` | 使用 `writeRoles()` 更新角色模型权限 | `ecweb/src/sources/role-definitions.ts` |

#### 7.2.2 前端界面（优先级：高）

| 组件 | 功能 | 实现位置 |
|------|------|---------|
| 🆕 角色定义页面 - 模型配置区块 | 为每个角色配置默认模型和白名单 | `ecweb/src/static/app.js` |
| 🆕 模型目录页面 | 展示网关可用模型列表和角色权限概览 | `ecweb/src/static/app.js` |
| 🆕 实时验证 UI | 配置时实时检查模型是否在白名单内 | `ecweb/src/static/model-config.js` |

#### 7.2.3 配置文件调整（优先级：中）

| 文件 | 调整内容 | 说明 |
|------|---------|------|
| 📝 `src/config/roles.ts` | 可选：调整内置默认模型 | 只有在 `resolveModelAlias()` 落地后，才建议把默认模型迁移为 `opus/sonnet/haiku` |
| 📝 `kits/schemas/roles.schema.*.json` | 暂不调整 | 首期不持久化 `selectionMode`，保持 schema 兼容 |

#### 7.2.4 运行时验证（优先级：低，可选）

| 功能 | 实现位置 | 说明 |
|------|---------|------|
| 🔄 模型解析时的二次验证 | `src/agents/claude-runner.ts` | 在 `resolveModel()` 中增加角色权限检查 |
| 🔄 模型不可用时的自动降级 | `src/agents/claude-runner.ts` | 检查模型是否在网关目录中，不可用时降级到角色默认模型 |

### 7.3 实现优先级

#### Phase 1: 核心功能（第 1 周）

1. **后端 API 接口**
   - 实现模型目录 API
   - 在 `/api/role-definitions` 下实现角色模型权限读取、预览和保存
   - 保存路径复用 `writeRoles()`

#### Phase 2: 前端界面（第 2 周）

2. **角色定义页面增强**
   - 添加模型配置区块
   - 实现表单交互和保存逻辑

3. **模型目录页面**
   - 新增 Tab
   - 实现模型列表和角色权限概览

#### Phase 3: 增强功能（第 3 周）

4. **体验、审计和缓存**
   - 前端实时校验
   - 加载状态和错误提示
   - 审计日志
   - 真实 catalog 缓存与刷新

5. **运行时二次验证（可选）**
   - 在 `claude-runner.ts` 中增加权限守卫
   - 实现模型自动降级逻辑
   - 实现别名解析到最新具体型号

### 7.4 技术依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | >= 18 | 运行环境 |
| Node http | 现有实现 | ecweb HTTP API |
| WebSocket | 现有版本 | 实时通信 |
| fetch API | 内置 | HTTP 请求 |

**无需新增外部依赖**，使用现有技术栈即可实现。

### 7.5 测试计划

#### 7.5.1 单元测试

```typescript
// tests/model-config.test.ts

describe('Model Configuration', () => {
  describe('模型白名单验证', () => {
    it('通配符匹配：claude-sonnet-*', () => {
      expect(isModelAllowed('claude-sonnet-4-6', ['claude-sonnet-*'])).toBe(true);
      expect(isModelAllowed('claude-opus-4-8', ['claude-sonnet-*'])).toBe(false);
    });
    
    it('精确匹配', () => {
      expect(isModelAllowed('claude-sonnet-4-6', ['claude-sonnet-4-6'])).toBe(true);
      expect(isModelAllowed('claude-sonnet-4-7', ['claude-sonnet-4-6'])).toBe(false);
    });
    
    it('全模型通配符', () => {
      expect(isModelAllowed('any-model', ['*'])).toBe(true);
    });
  });
  
  describe('模型目录别名条目', () => {
    it('目录包含 claude 稳定别名', async () => {
      const catalog = await getCatalog(undefined, 'claude');
      expect(catalog.models.some(m => m.id === 'sonnet' && m.owned_by === 'alias')).toBe(true);
    });
  });
  
  describe('角色权限合并', () => {
    it('member 角色尝试使用 opus 被拒绝', () => {
      const result = mergeWithRoleConstraints('member', {
        baseagents: { claude: { model: 'claude-opus-4-8' } }
      });
      
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].reason).toBe('model_not_allowed');
      expect(result.effectiveConfig.baseagents.claude.model).toBeDefined(); // 回退到角色默认
    });
    
    it('member 角色使用 sonnet 成功', () => {
      const result = mergeWithRoleConstraints('member', {
        baseagents: { claude: { model: 'claude-sonnet-4-6' } }
      });
      
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.effectiveConfig.baseagents.claude.model).toBe('claude-sonnet-4-6');
    });
  });
});
```

#### 7.5.2 集成测试

```typescript
// tests/model-config-api.test.ts

describe('Model Config API', () => {
  it('GET /api/models/catalog 返回模型列表', async () => {
    const response = await fetch('http://localhost:3000/api/models/catalog');
    const data = await response.json();
    
    expect(data.success).toBe(true);
    expect(data.data.models).toBeInstanceOf(Array);
    expect(data.data.source).toBeDefined();
  });
  
  it('GET /api/role-definitions/:role/configurable-models 返回角色模型配置', async () => {
    const response = await fetch('http://localhost:3000/api/role-definitions/member/configurable-models');
    const data = await response.json();
    
    expect(data.success).toBe(true);
    expect(data.data.role).toBe('member');
    expect(data.data.current.allowedModels).toBeInstanceOf(Array);
  });
  
  it('PUT /api/role-definitions/:role/model-permissions 更新配置', async () => {
    const response = await fetch('http://localhost:3000/api/role-definitions/member/model-permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultModel: 'claude-sonnet-4-6',
        allowOverride: true,
        allowedModels: ['claude-sonnet-*', 'claude-haiku-*']
      })
    });
    
    const data = await response.json();
    expect(data.success).toBe(true);
  });
  
  it('POST /api/role-definitions/:role/preview-models 预览白名单', async () => {
    const response = await fetch('http://localhost:3000/api/role-definitions/member/preview-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedModels: ['claude-sonnet-*']
      })
    });
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.data.matched).toBeInstanceOf(Array);
  });
});
```

#### 7.5.3 端到端测试

```typescript
// tests/e2e/model-config-workflow.test.ts

describe('模型配置完整流程', () => {
  it('管理员修改 member 角色的模型权限', async () => {
    // 1. 登录为 admin
    // 2. 进入角色定义页面
    // 3. 选择 member 角色
    // 4. 修改默认模型为 haiku
    // 5. 修改白名单只允许 haiku
    // 6. 保存配置
    // 7. 验证配置已更新
    // 8. member 用户尝试使用 sonnet 失败
  });
});
```

---

## 八、配置示例

### 8.1 标准配置（推荐）

适用于大多数团队，首期推荐使用“具体默认模型 + 通配符白名单”。这样既能保持默认模型稳定，又能让同系列新模型进入可授权范围。

```json
{
  "$schema_version": 3,
  "defaultRoles": {
    "private": "anonymous",
    "group": "guest"
  },
  "roles": {
    "owner": {
      "description": "Agent 所有者，完全控制权限",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-opus-4-8",
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "所有者可使用任意模型，无成本限制"
        }
      }
    },
    "admin": {
      "description": "管理员，需要确认敏感操作",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "管理员可使用任意模型"
        }
      }
    },
    "member": {
      "description": "团队成员，有基本使用权限",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
          "reason": "成员可使用中低成本模型"
        }
      }
    },
    "guest": {
      "description": "访客，只读权限",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-haiku-4-5-20251001",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "访客只能使用最低成本模型"
        }
      }
    },
    "anonymous": {
      "description": "匿名用户，完全未认证",
      "allowAccess": false,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-haiku-4-5-20251001",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "匿名用户只能使用最低成本模型"
        }
      }
    }
  }
}
```

### 8.2 严格成本控制配置

适用于需要严格控制成本的场景，限制使用精确型号。

```json
{
  "$schema_version": 3,
  "roles": {
    "owner": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": [
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001"
          ],
          "reason": "所有者只能使用指定版本，防止成本失控"
        }
      }
    },
    "member": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-haiku-4-5-20251001",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-4-5-20251001"],
          "reason": "成员只能使用 haiku，不允许覆盖"
        }
      }
    }
  }
}
```

### 8.3 灵活配置（高级用户）

适用于需要精细控制的高级场景。

```json
{
  "$schema_version": 3,
  "roles": {
    "owner": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-opus-4-8",
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "所有者不受限制"
        }
      }
    },
    "admin": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": [
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-sonnet-*",
            "claude-haiku-*"
          ],
          "reason": "管理员可使用 opus 4-8/4-7 和所有 sonnet/haiku"
        }
      }
    },
    "member": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": [
            "claude-sonnet-4-6",
            "claude-haiku-*"
          ],
          "reason": "成员可使用 sonnet 4-6 和所有 haiku"
        }
      }
    },
    "trial_user": {
      "description": "试用用户，有限额度",
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-haiku-4-5-20251001",
          "allowOverride": false,
          "allowedModels": ["claude-haiku-4-5-20251001"],
          "reason": "试用用户只能使用特定 haiku 版本"
        }
      }
    }
  }
}
```

### 8.4 关系级配置覆盖示例

用户可以在关系配置中覆盖默认模型（需在白名单内）。

**文件**: `agents/{aid}/relations/{peerKey}/behavior.json`

```json
{
  "$schema_version": 1,
  "baseagents": {
    "claude": {
      "model": "claude-haiku-4-5-20251001"
    }
  }
}
```

**验证流程**：

1. 用户角色为 `member`
2. `member` 的 `allowedModels` 为 `["claude-sonnet-*", "claude-haiku-*"]`
3. `claude-haiku-4-5-20251001` 匹配 `claude-haiku-*` ✅
4. 允许使用，生效配置为 `claude-haiku-4-5-20251001`

### 8.5 配置迁移示例

#### 从旧配置迁移到新配置

**旧配置**（硬编码版本号）：

```json
{
  "roles": {
    "member": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true
        }
      }
    }
  }
}
```

**新配置**（首期建议：保留具体默认模型 + 增加白名单）：

```json
{
  "roles": {
    "member": {
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4-6",
          "allowOverride": true,
          "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
          "reason": "成员可使用中低成本模型"
        }
      }
    }
  }
}
```

**迁移优势**：

- ✅ 新模型 `claude-sonnet-4-7` 上线后可被通配符白名单允许
- ✅ 默认模型仍保持精确版本，避免别名解析未落地前引入运行时不确定性
- ✅ 成本控制更灵活（可限制系列而非版本）

---

## 九、技术实现细节

### 9.1 模型别名目录与后续解析

#### 9.1.1 当前已实现：别名并入目录

当前 `src/core/model/model-catalog.ts` 已将稳定别名作为虚拟条目并入模型目录，便于 UI 展示和后续扩展：

```typescript
// src/core/model/model-catalog.ts

/**
 * 已知别名定义
 */
const KNOWN_ALIASES: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: [],
  gemini: [],
};

/**
 * 将别名作为虚拟条目并入目录
 */
function withAliases(models: ModelCatalogEntry[], ba: string): ModelCatalogEntry[] {
  const aliases = KNOWN_ALIASES[ba] || [];
  const existing = new Set(models.map(m => m.id));
  const aliasEntries: ModelCatalogEntry[] = aliases
    .filter(a => !existing.has(a))
    .map(a => ({ id: a, owned_by: 'alias' }));
  return [...aliasEntries, ...models];
}

```

#### 9.1.2 后续增强：别名解析到具体型号

如果需要把 `opus`、`sonnet`、`haiku` 作为运行时默认模型，应新增并测试 `resolveModelAlias()`：

- 非别名输入必须原样返回。
- 别名输入应只在同 baseagent 的模型目录中查找。
- 排序规则必须明确支持版本号和日期型模型名。
- 找不到候选模型时必须有可观测的回退策略。
- 保存角色权限时，如果 `defaultModel` 是别名，应以解析后的具体模型参与 `allowedModels` 校验。

#### 9.1.3 在 Runner 中应用

```typescript
async function resolveModelIfAliasReady(requestedModel: string): Promise<string> {
  if (!isResolveModelAliasImplemented()) return requestedModel;
  return resolveModelAlias(requestedModel, 'claude');
}
```

### 9.2 配置读写与缓存

#### 9.2.1 配置读取（带缓存）

```typescript
// src/config/roles.ts

import { resolveRoles } from './config-manager.js';

const ROLES_CACHE = new Map<string, RoleDefinition>();

/**
 * 读取全局角色配置（overlay 模型：内置基线 + 用户 roles.json diff）
 * 自动获得深合并、schema 迁移、mtime 缓存
 */
export function readRolesConfig(): RolesConfig {
  return resolveRoles({ cache: true });
}

/**
 * 获取指定角色的定义（带缓存）
 */
export function getRoleDefinition(role: string): RoleDefinition | null {
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
 * 清空角色缓存（配置更新后调用）
 */
export function clearRolesCache(): void {
  ROLES_CACHE.clear();
}
```

#### 9.2.2 配置写入

角色配置写入必须复用 ConfigManager 的 `writeRoles()`。它会把完整视图转换成 overlay diff，并完成 schema 校验、原子写入和当前进程角色缓存清理。

```typescript
interface ModelPermissionPatch {
  defaultModel: string;
  allowOverride: boolean;
  allowedModels: string[];
  reason?: string;
}

function updateRoleModelPermission(
  fullConfig: RolesConfig,
  role: string,
  patch: ModelPermissionPatch
): void {
  fullConfig.roles[role].permissions['baseagents.claude.model'] = {
    default: patch.defaultModel,
    allowOverride: patch.allowOverride,
    allowedModels: patch.allowedModels,
    reason: patch.reason || ''
  };

  writeRoles(fullConfig);
}
```

不要新增 `ecweb/src/sources/config-writer.ts` 直接写 `roles.json`。直接写文件会绕过 overlay diff、schema 校验、迁移和缓存失效。

### 9.3 权限验证的性能优化

#### 9.3.1 缓存策略

```typescript
// src/config/role-constraints.ts

/**
 * 角色权限验证结果缓存
 * Key: `${role}:${model}`
 * Value: boolean
 * TTL: 5 分钟
 */
const MODEL_VALIDATION_CACHE = new Map<string, { result: boolean; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * 检查模型是否在角色白名单内（带缓存）
 */
export function isModelAllowedForRole(role: string, model: string): boolean {
  const cacheKey = `${role}:${model}`;
  const cached = MODEL_VALIDATION_CACHE.get(cacheKey);
  
  // 检查缓存是否有效
  if (cached && Date.now() < cached.expiry) {
    return cached.result;
  }
  
  // 计算结果
  const perm = getFieldPermission(role, 'baseagents.claude.model');
  const result = perm ? isModelAllowed(model, perm.allowedModels || []) : false;
  
  // 写入缓存
  MODEL_VALIDATION_CACHE.set(cacheKey, {
    result,
    expiry: Date.now() + CACHE_TTL
  });
  
  return result;
}

/**
 * 清空验证缓存（配置更新时调用）
 */
export function clearValidationCache(): void {
  MODEL_VALIDATION_CACHE.clear();
}
```

#### 9.3.2 批量验证优化

当需要批量验证多个模型时，使用批量接口减少开销。

```typescript
/**
 * 批量验证模型
 */
export function batchValidateModels(
  role: string, 
  models: string[]
): Map<string, boolean> {
  const perm = getFieldPermission(role, 'baseagents.claude.model');
  const results = new Map<string, boolean>();
  
  if (!perm) {
    models.forEach(m => results.set(m, false));
    return results;
  }
  
  const allowedModels = perm.allowedModels || [];
  
  for (const model of models) {
    const allowed = isModelAllowed(model, allowedModels);
    results.set(model, allowed);
    
    // 写入缓存
    const cacheKey = `${role}:${model}`;
    MODEL_VALIDATION_CACHE.set(cacheKey, {
      result: allowed,
      expiry: Date.now() + CACHE_TTL
    });
  }
  
  return results;
}
```

### 9.4 审计日志实现

#### 9.4.1 日志格式

使用 JSONL（JSON Lines）格式，每行一个事件，便于流式处理和分析。

```jsonl
{"timestamp":"2026-06-27T10:30:00.123Z","type":"role_model_permission_updated","role":"member","user":"admin.aid.pub","changes":{"defaultModel":"haiku","allowedModels":["claude-haiku-*"]},"reason":"成本控制策略调整"}
{"timestamp":"2026-06-27T10:35:12.456Z","type":"model_validation_failed","role":"member","user":"alice.aid.pub","model":"claude-opus-4-8","reason":"model_not_allowed","fallback":"claude-sonnet-4-6"}
{"timestamp":"2026-06-27T10:40:30.789Z","type":"model_catalog_refreshed","source":"v1/models","modelCount":15}
```

#### 9.4.2 日志记录器

```typescript
// ecweb/src/sources/audit-logger.ts

import fs from 'fs/promises';
import path from 'path';

interface AuditEvent {
  timestamp: string;
  type: string;
  [key: string]: any;
}

class AuditLogger {
  private logPath: string;
  private writeQueue: AuditEvent[] = [];
  private isWriting: boolean = false;
  
  constructor() {
    this.logPath = path.join(process.cwd(), 'logs', 'model-config-audit.jsonl');
    this.ensureLogDir();
  }
  
  private async ensureLogDir(): Promise<void> {
    const dir = path.dirname(this.logPath);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
  }
  
  /**
   * 记录审计事件
   */
  async log(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const fullEvent: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event
    };
    
    this.writeQueue.push(fullEvent);
    
    if (!this.isWriting) {
      await this.flush();
    }
  }
  
  /**
   * 刷新写队列
   */
  private async flush(): Promise<void> {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }
    
    this.isWriting = true;
    
    try {
      const events = this.writeQueue.splice(0);
      const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      
      await fs.appendFile(this.logPath, lines, 'utf-8');
    } catch (error) {
      console.error('[audit-logger] Failed to write log:', error);
      // 出错时重新放回队列
      this.writeQueue.unshift(...events);
    } finally {
      this.isWriting = false;
    }
    
    // 如果队列还有数据，继续刷新
    if (this.writeQueue.length > 0) {
      setImmediate(() => this.flush());
    }
  }
  
  /**
   * 查询审计日志
   */
  async query(options: {
    type?: string;
    role?: string;
    user?: string;
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): Promise<AuditEvent[]> {
    const content = await fs.readFile(this.logPath, 'utf-8').catch(() => '');
    const lines = content.trim().split('\n').filter(Boolean);
    
    let events = lines.map(line => JSON.parse(line) as AuditEvent);
    
    // 过滤
    if (options.type) {
      events = events.filter(e => e.type === options.type);
    }
    if (options.role) {
      events = events.filter(e => e.role === options.role);
    }
    if (options.user) {
      events = events.filter(e => e.user === options.user);
    }
    if (options.startTime) {
      events = events.filter(e => new Date(e.timestamp) >= options.startTime!);
    }
    if (options.endTime) {
      events = events.filter(e => new Date(e.timestamp) <= options.endTime!);
    }
    
    // 限制数量
    if (options.limit) {
      events = events.slice(-options.limit);
    }
    
    return events;
  }
}

// 单例
export const auditLogger = new AuditLogger();
```

#### 9.4.3 使用示例

```typescript
// 在 API 中记录审计日志

// 1. 配置更新
await auditLogger.log({
  type: 'role_model_permission_updated',
  role: 'member',
  user: req.user?.aid,
  changes: { defaultModel, allowedModels },
  reason: '管理员调整成本控制策略'
});

// 2. 权限违规
await auditLogger.log({
  type: 'model_validation_failed',
  role: 'member',
  user: 'alice.aid.pub',
  model: 'claude-opus-4-8',
  reason: 'model_not_allowed',
  fallback: 'claude-sonnet-4-6'
});

// 3. 模型目录刷新
await auditLogger.log({
  type: 'model_catalog_refreshed',
  source: catalog.source,
  modelCount: catalog.models.length
});
```

### 9.5 错误处理

#### 9.5.1 网关请求失败

```typescript
async function getCatalogWithFallback(): Promise<CatalogResult> {
  try {
    // 尝试从网关获取
    const catalog = await getCatalog();
    return catalog;
  } catch (error) {
    console.error('[model-catalog] Failed to fetch from gateway:', error);
    
    // 降级到 mock catalog
    return {
      models: MOCK_CATALOG,
      source: 'mock'
    };
  }
}
```

#### 9.5.2 配置文件损坏

```typescript
function readRolesConfigSafe(): RolesConfig {
  try {
    const config = readRolesConfig();
    validateRolesConfig(config);
    return config;
  } catch (error) {
    console.error('[roles] Config invalid, fallback to builtin:', error);
    
    // 发送告警
    notifyConfigError(error);
    
    // 回退到内置配置
    return getBuiltinRolesConfig();
  }
}
```

#### 9.5.3 前端错误处理

```javascript
async function saveRoleModelConfig(role) {
  try {
    const response = await fetch(`/api/role-definitions/${role}/model-permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || '保存失败');
    }
    
    const result = await response.json();
    
    if (result.success) {
      showNotification('success', '✅ 保存成功');
      await loadRoleModelConfig(role);
    } else {
      throw new Error(result.error || '未知错误');
    }
  } catch (error) {
    console.error('Failed to save config:', error);
    showNotification('error', `❌ 保存失败: ${error.message}`);
  }
}

function showNotification(type, message) {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}
```

---

## 十、部署与迁移方案

### 10.1 部署前准备

#### 10.1.1 环境检查

```bash
# 1. 检查 Node.js 版本
node --version  # >= 18.0.0

# 2. 检查现有配置文件
ls -la roles.json
ls -la agents/*/config.json

# 3. 备份现有配置
mkdir -p backups/$(date +%Y%m%d)
cp roles.json backups/$(date +%Y%m%d)/roles.json.bak
cp -r agents backups/$(date +%Y%m%d)/agents.bak

# 4. 检查网关连通性
curl -H "Authorization: Bearer $API_KEY" \
  https://mg-new.evolai.cn/claude-proxy/v1/models
```

#### 10.1.2 依赖更新

```bash
# 安装依赖（无新增依赖）
npm install

# 运行测试
npm test -- tests/model-config.test.ts
```

### 10.2 迁移步骤

#### 10.2.1 Phase 1: 后端实现（第 1 周）

**第 1-2 天：实现 API 接口**

```bash
# 1. 在 ecweb/src/server.ts 中添加 /api/models/catalog 路由
# - GET /api/models/catalog

# 2. 在 ecweb/src/sources/role-definitions.ts 中扩展角色模型权限 API
# - GET /api/role-definitions/:role/configurable-models
# - POST /api/role-definitions/:role/preview-models
# - PUT /api/role-definitions/:role/model-permissions

# 3. 保存角色配置时复用 ConfigManager writeRoles()

# 4. 测试 API
npm run dev
curl http://localhost:3000/api/models/catalog
```

**第 3-4 天：配置校验与兼容确认**

```bash
# 1. 确认首期不写 selectionMode，roles.schema.3.json 无需变更

# 2. 确认 defaultModel 必须被 allowedModels 允许

# 3. 如要迁移默认模型为 opus/sonnet/haiku，先实现并测试 resolveModelAlias()

# 4. 运行测试验证
npm test -- tests/roles.test.ts
```

**第 5 天：审计日志和缓存优化**

```bash
# 1. 实现审计日志
# 2. 实现权限验证缓存
# 3. 测试性能

# 运行性能测试
npm run test:perf -- model-validation
```

#### 10.2.2 Phase 2: 前端实现（第 2 周）

**第 1-3 天：角色定义页面增强**

```bash
# 1. 修改 ecweb/src/static/app.js
# 在现有的 renderRoleDefinitions() 中添加模型配置区块

# 2. 添加交互逻辑
# 创建 ecweb/src/static/model-config.js

# 3. 添加 CSS 样式
# 创建 ecweb/src/static/model-config.css

# 4. 本地测试
npm run dev
# 访问 http://localhost:3000 → 角色定义 Tab
```

**第 4-5 天：模型目录页面**

```bash
# 1. 添加新 Tab
# 在 ecweb/src/static/app.js 中添加 "模型目录" Tab

# 2. 实现模型列表渲染
# 创建 ecweb/src/static/model-catalog.js

# 3. 测试交互
# - 模型筛选
# - 角色权限概览
# - 刷新功能
```

#### 10.2.3 Phase 3: 测试与上线（第 3 周）

**第 1-2 天：集成测试**

```bash
# 1. 运行完整测试套件
npm test

# 2. 端到端测试
npm run test:e2e

# 3. 手动测试清单
# - [ ] 查看模型目录
# - [ ] 修改角色权限
# - [ ] 验证白名单生效
# - [ ] 检查别名条目展示；如果实现了 resolveModelAlias，再测试别名解析
# - [ ] 检查审计日志
```

**第 3-4 天：用户验收测试（UAT）**

```bash
# 1. 部署到测试环境
npm run build
npm run start:prod

# 2. 邀请管理员测试
# 3. 收集反馈并修复问题
```

**第 5 天：生产部署**

```bash
# 1. 最终备份
./scripts/backup-config.sh

# 2. 部署
git tag v3.7.0-model-config
git push origin v3.7.0-model-config
npm run deploy

# 3. 监控
tail -f logs/model-config-audit.jsonl
```

### 10.3 配置迁移脚本

#### 10.3.1 批量迁移脚本

```typescript
// scripts/migrate-model-config.ts

import fs from 'fs/promises';
import path from 'path';

/**
 * 迁移脚本：将硬编码的模型版本号改为别名
 */
async function migrateModelConfig() {
  console.log('Starting model config migration...');
  
  // 1. 迁移 roles.json
  await migrateRolesJson();
  
  // 2. 迁移所有 behavior.json
  await migrateBehaviorJsons();
  
  console.log('Migration completed!');
}

async function migrateRolesJson() {
  const rolesPath = path.join(process.cwd(), 'roles.json');
  
  try {
    const content = await fs.readFile(rolesPath, 'utf-8');
    const config = JSON.parse(content);
    
    let modified = false;
    
    for (const [roleName, roleDef] of Object.entries(config.roles)) {
      const modelPerm = (roleDef as any).permissions?.['baseagents.claude.model'];
      
      if (modelPerm?.default) {
        const newDefault = convertToAlias(modelPerm.default);
        if (newDefault !== modelPerm.default) {
          console.log(`  ${roleName}: ${modelPerm.default} → ${newDefault}`);
          modelPerm.default = newDefault;
          modified = true;
        }
      }
      
      // 添加 allowedModels 如果不存在
      if (modelPerm && !modelPerm.allowedModels) {
        modelPerm.allowedModels = inferAllowedModels(roleName);
        modified = true;
      }
    }
    
    if (modified) {
      await fs.writeFile(rolesPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log('✅ roles.json migrated');
    } else {
      console.log('⏭️  roles.json already up-to-date');
    }
  } catch (error) {
    console.error('❌ Failed to migrate roles.json:', error);
  }
}

async function migrateBehaviorJsons() {
  const agentsDir = path.join(process.cwd(), 'agents');
  
  try {
    const aids = await fs.readdir(agentsDir);
    
    for (const aid of aids) {
      const relationsDir = path.join(agentsDir, aid, 'relations');
      
      try {
        const peerKeys = await fs.readdir(relationsDir);
        
        for (const peerKey of peerKeys) {
          const behaviorPath = path.join(relationsDir, peerKey, 'behavior.json');
          
          try {
            const content = await fs.readFile(behaviorPath, 'utf-8');
            const config = JSON.parse(content);
            
            if (config.baseagents?.claude?.model) {
              const oldModel = config.baseagents.claude.model;
              const newModel = convertToAlias(oldModel);
              
              if (newModel !== oldModel) {
                console.log(`  ${aid}/${peerKey}: ${oldModel} → ${newModel}`);
                config.baseagents.claude.model = newModel;
                
                await fs.writeFile(behaviorPath, JSON.stringify(config, null, 2), 'utf-8');
              }
            }
          } catch {
            // behavior.json 不存在或无效，跳过
          }
        }
      } catch {
        // relations 目录不存在，跳过
      }
    }
    
    console.log('✅ behavior.json files migrated');
  } catch (error) {
    console.error('❌ Failed to migrate behavior.json:', error);
  }
}

/**
 * 将精确型号转换为别名
 */
function convertToAlias(model: string): string {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model; // 保持不变
}

/**
 * 根据角色推断 allowedModels
 */
function inferAllowedModels(role: string): string[] {
  switch (role) {
    case 'owner':
    case 'admin':
      return ['*'];
    case 'member':
      return ['claude-sonnet-*', 'claude-haiku-*'];
    case 'guest':
    case 'anonymous':
      return ['claude-haiku-*'];
    default:
      return ['claude-haiku-*'];
  }
}

// 运行迁移
migrateModelConfig().catch(console.error);
```

**运行迁移脚本**：

```bash
# 1. 备份
mkdir -p backups/pre-migration
cp roles.json backups/pre-migration/
cp -r agents backups/pre-migration/

# 2. 运行迁移
npx tsx scripts/migrate-model-config.ts

# 3. 验证结果
git diff roles.json
git diff agents/*/relations/*/behavior.json
```

### 10.4 回滚方案

#### 10.4.1 回滚步骤

```bash
# 1. 停止服务
pm2 stop evolclaw

# 2. 恢复配置文件
cp backups/$(date +%Y%m%d)/roles.json.bak roles.json
cp -r backups/$(date +%Y%m%d)/agents.bak agents

# 3. 回滚代码
git revert <commit-hash>

# 4. 重启服务
pm2 start evolclaw

# 5. 验证
curl http://localhost:3000/api/health
```

#### 10.4.2 数据恢复

```bash
# 如果审计日志损坏
mv logs/model-config-audit.jsonl logs/model-config-audit.jsonl.corrupted
touch logs/model-config-audit.jsonl

# 如果缓存需要清理
rm -rf .cache/roles
rm -rf .cache/model-catalog
```

### 10.5 监控与告警

#### 10.5.1 关键指标

```yaml
监控指标:
  - 模型白名单违规次数 (每小时)
  - 模型目录刷新失败次数 (每小时)
  - 配置文件写入失败次数 (每小时)
  - 网关请求延迟 (p50, p95, p99)
  - 别名解析失败率 (每小时)

告警规则:
  - 违规次数 > 100/小时 → 发送邮件
  - 刷新失败 > 10/小时 → 发送告警
  - 写入失败 > 0 → 立即告警
  - 延迟 p99 > 5000ms → 发送告警
  - 解析失败率 > 5% → 发送告警
```

#### 10.5.2 监控脚本

```bash
#!/bin/bash
# scripts/monitor-model-config.sh

LOG_FILE="logs/model-config-audit.jsonl"

# 统计最近 1 小时的违规次数
VIOLATIONS=$(tail -n 10000 "$LOG_FILE" | \
  jq -r 'select(.type == "model_validation_failed") | .timestamp' | \
  awk -v cutoff="$(date -u -d '1 hour ago' +%s)" \
  '{if ($1 >= cutoff) count++} END {print count+0}')

echo "Violations in last hour: $VIOLATIONS"

if [ "$VIOLATIONS" -gt 100 ]; then
  echo "⚠️ High violation rate detected!"
  # 发送告警
  curl -X POST https://your-alert-webhook.com \
    -d "text=Model config violations: $VIOLATIONS in last hour"
fi
```

### 10.6 文档与培训

#### 10.6.1 管理员文档

创建 `docs/admin/model-config-guide.md`，包含：

1. **模型配置概念**
   - 什么是模型别名
   - 什么是模型白名单
   - 角色与成本控制

2. **操作指南**
   - 如何查看可用模型
   - 如何修改角色权限
   - 如何处理违规情况

3. **最佳实践**
   - 推荐使用别名而非精确型号
   - 成本控制策略建议
   - 定期审查权限配置

4. **故障排除**
   - 网关连接失败
   - 配置文件损坏
   - 模型解析失败

#### 10.6.2 用户文档

创建 `docs/user/model-selection-guide.md`，包含：

1. **模型介绍**
   - Opus: 最强性能，适合复杂任务
   - Sonnet: 平衡选择，适合日常使用
   - Haiku: 快速经济，适合简单查询

2. **如何选择模型**
   - 根据任务复杂度选择
   - 成本考虑
   - 响应速度需求

3. **常见问题**
   - 为什么我不能使用某个模型？
   - 如何申请更高权限？
   - 模型版本如何更新？

---

## 十一、总结与展望

### 11.1 方案总结

本设计方案为 EvolClaw 建立了**可渐进落地的模型配置管理体系**，核心特点：

✅ **自动化基础**：网关模型目录自动拉取，通配符白名单可自动覆盖新上线模型  
✅ **灵活性**：支持通配符和精确型号两种白名单模式  
✅ **可视化**：ecweb 后台提供直观的配置界面  
✅ **安全性**：多层权限验证，防止成本失控  
✅ **可扩展**：架构清晰，易于添加新模型系列

### 11.2 技术亮点

1. **模型目录与别名扩展点**：目录已支持稳定别名条目，后续可扩展为解析到最新具体型号
2. **多级回退策略**：网关 API → 远端接口 → Mock 数据，确保高可用
3. **通配符白名单**：`claude-sonnet-*` 支持系列级授权，灵活且易维护
4. **配置即代码**：所有配置可追溯、可审计、可回滚
5. **渐进式增强**：向后兼容，平滑迁移，不影响现有功能

### 11.3 后续改进方向

#### 11.3.1 成本控制增强

- **用量配额**：为每个角色设置月度/周度模型使用配额
- **成本预警**：实时统计各角色的模型使用成本，超过阈值告警
- **自动降级**：成本超限时自动降级到低成本模型

#### 11.3.2 智能推荐

- **任务分类**：根据用户输入自动推荐合适的模型
- **历史分析**：分析用户历史使用习惯，优化默认模型选择
- **A/B 测试**：对比不同模型在相同任务上的表现

#### 11.3.3 多厂商支持

- **统一抽象**：扩展模型目录支持 OpenAI、Gemini、DeepSeek 等
- **跨厂商切换**：支持在不同厂商的同级模型间切换
- **成本对比**：展示不同厂商同类模型的成本差异

#### 11.3.4 高级分析

- **使用趋势**：可视化各模型的使用趋势和分布
- **成本分析**：按角色、用户、时间段分析成本
- **性能监控**：监控各模型的响应时间和成功率

### 11.4 参考资料

- [EvolClaw 角色系统详细设计文档](./config/ROLE-SYSTEM-DETAILED-DESIGN.md)
- [模型目录设计文档](./model-command-design.md)
- [角色权限当前分析](./role-permission-current-analysis.md)
- [Claude API 官方文档](https://docs.anthropic.com)

### 11.5 联系方式

如有问题或建议，请联系：

- **技术支持**: dev@evolai.cn
- **问题反馈**: https://github.com/evolai/evolclaw/issues
- **文档贡献**: https://github.com/evolai/evolclaw/pulls

---

**文档修订历史**

| 版本 | 日期 | 作者 | 说明 |
|------|------|------|------|
| v1.0 | 2026-06-27 | 系统架构组 | 初始版本 |
