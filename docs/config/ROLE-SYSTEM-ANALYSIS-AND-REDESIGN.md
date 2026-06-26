# EvolClaw 角色系统分析与重构建议

> 创建时间：2026-06-23
> 当前版本：v3 配置体系
> 问题分析：现有角色系统设计混乱，缺少清晰的权限边界和配置管理

---

## 一、现状问题分析

### 1.1 当前实现的混乱点

#### 问题 1：角色定义位置不明确

**现状**：`roles` 字段定义在 `behavior.json` 内部
```json
// agents/{aid}/behavior.json
{
  "roles": {
    "vip": {
      "baseagents": {"claude": {"model": "claude-opus-4-8"}},
      "permissionMode": "bypass"
    }
  }
}
```

**问题**：
- ❌ 角色是**全局概念**（owner/admin/guest），却存储在每个 agent 的 behavior.json 中
- ❌ 没有统一的角色定义文件，每个 agent 可以自己定义角色行为
- ❌ 不同 agent 对同一角色（如 "owner"）的定义可能不一致

#### 问题 2：角色与用户的映射关系不清晰

**现状**：用户角色定义在 H 链配置中
```json
// agents/{aid}/config.json (H 链)
{
  "owners": ["alice.aid.pub", "bob.aid.pub"],
  "admins": ["charlie.aid.pub"]
}
```

**问题**：
- ❌ `owners`/`admins` 定义在 H 链，但角色行为配置在 HA 链（behavior.json）
- ❌ 没有明确的"guest"角色定义（所有非 owner/admin 的用户）
- ❌ 角色映射逻辑散落在代码中，不在配置文件中体现

#### 问题 3：关系级配置覆盖角色配置

**现状**：优先级链
```
agent behavior → roles.<role> → relation behavior
```

**问题**：
- ❌ 关系级配置可以覆盖角色配置，导致角色权限失效
- ❌ 如果在 `relations/{peerKey}/behavior.json` 中设置 `permissionMode: bypass`，即使该用户是 guest，也能绕过权限
- ❌ 没有"角色配置是否允许用户级覆盖"的控制

#### 问题 4：字段级权限控制缺失

**现状**：所有 behavior 字段都可以在关系级覆盖

**问题**：
- ❌ 没有区分哪些字段允许用户级个性化，哪些必须由角色控制
- ❌ 例如 `permissionMode` 应该由角色强制，不应该被关系级覆盖
- ❌ 例如 `chatmode` 可以个性化，允许不同用户有不同偏好

---

## 二、正确的角色系统设计

### 2.1 核心原则

1. **角色是全局概念**：在系统级别定义，而非 agent 级别
2. **角色决定权限边界**：security 相关的字段由角色强制，不可覆盖
3. **用户偏好可个性化**：非 security 字段允许关系级覆盖
4. **配置分离清晰**：角色定义 vs 角色映射 vs 角色行为

### 2.2 建议的文件结构

```
{evolclaw_home}/
├── roles.json                           # 全局角色定义（新增）
├── agents/
│   ├── defaults.json                    # H 链默认
│   ├── defaults.behavior.json           # HA 链默认（计划中）
│   └── {aid}/
│       ├── config.json                  # H 配置（含 owners/admins 映射）
│       ├── behavior.json                # HA 行为配置（移除 roles 字段）
│       └── relations/{peerKey}/
│           ├── config.json              # 关系 H 配置
│           └── behavior.json            # 关系行为配置（受角色约束）
```

---

## 三、全局角色定义文件：roles.json

### 3.1 文件位置
```
{evolclaw_home}/roles.json
```

### 3.2 Schema 设计

```json
{
  "$schema_version": 1,
  "roles": {
    "owner": {
      "description": "Agent 拥有者，完全控制权限",
      "permissions": {
        "permissionMode": {
          "default": "bypass",
          "allowOverride": false
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-opus-4-8",
              "effort": "high"
            }
          },
          "allowOverride": true,
          "allowedModels": ["*"]
        },
        "chatmode": {
          "default": {
            "private": "interactive",
            "group": "proactive"
          },
          "allowOverride": true
        },
        "dispatch": {
          "default": "broadcast",
          "allowOverride": true
        },
        "show_activities": {
          "default": "all",
          "allowOverride": true
        }
      }
    },
    "admin": {
      "description": "管理员，有限的管理权限",
      "permissions": {
        "permissionMode": {
          "default": "request",
          "allowOverride": false
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-sonnet-4-6",
              "effort": "medium"
            }
          },
          "allowOverride": true,
          "allowedModels": ["claude-sonnet-*", "claude-haiku-*"]
        },
        "chatmode": {
          "default": {
            "private": "interactive",
            "group": "proactive"
          },
          "allowOverride": true
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": false
        }
      }
    },
    "guest": {
      "description": "访客，只读权限",
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-haiku-4-5-20251001",
              "effort": "low"
            }
          },
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"]
        },
        "chatmode": {
          "default": {
            "private": "proactive",
            "group": "proactive"
          },
          "allowOverride": false
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": false
        }
      }
    }
  }
}
```

### 3.3 字段说明

#### `roles.<roleName>`
- **`description`**: 角色描述
- **`permissions`**: 该角色的权限配置

#### `permissions.<field>`
- **`default`**: 该字段的默认值
- **`allowOverride`**: 是否允许关系级覆盖
  - `false`: 强制使用角色配置，关系级不可覆盖（security 字段）
  - `true`: 允许关系级个性化
- **`allowedModels`**: （仅 baseagents）允许使用的模型列表
  - `["*"]`: 允许所有模型
  - `["claude-sonnet-*"]`: 仅允许特定模型

---

## 四、角色映射与解析

### 4.1 用户角色映射

**在 `agents/{aid}/config.json` (H 链) 中定义**：

```json
{
  "aid": "myagent.aid.pub",
  "owners": ["alice.aid.pub", "bob.aid.pub"],
  "admins": ["charlie.aid.pub"]
}
```

### 4.2 角色解析逻辑

```typescript
function resolveUserRole(aid: string, peerKey: string): 'owner' | 'admin' | 'guest' {
  const config = read(ConfigTarget.Agent, { self: aid });
  if (config.owners?.includes(peerKey)) return 'owner';
  if (config.admins?.includes(peerKey)) return 'admin';
  return 'guest';
}
```

### 4.3 关系级配置约束

**当前问题**：关系级配置可以任意覆盖

**重构后**：关系级配置受角色约束

```typescript
function mergeWithRoleConstraints(
  roleConfig: RolePermissions,
  relationConfig: BehaviorConfig
): BehaviorConfig {
  const result = {};
  
  for (const [field, roleRule] of Object.entries(roleConfig.permissions)) {
    if (!roleRule.allowOverride) {
      // 强制使用角色配置
      result[field] = roleRule.default;
    } else {
      // 允许关系级覆盖
      result[field] = relationConfig[field] ?? roleRule.default;
    }
    
    // 模型白名单检查
    if (field === 'baseagents' && roleRule.allowedModels) {
      validateAllowedModels(result[field], roleRule.allowedModels);
    }
  }
  
  return result;
}
```

---

## 五、配置示例与对比

### 5.1 现状示例（混乱）

**agents/myagent/behavior.json**:
```json
{
  "permissionMode": "auto",
  "baseagents": {
    "claude": {"model": "claude-opus-4-8"}
  },
  "roles": {
    "vip": {
      "permissionMode": "bypass"
    }
  }
}
```

**agents/myagent/relations/guest.aid.pub/behavior.json**:
```json
{
  "permissionMode": "bypass"  // ❌ guest 绕过了权限！
}
```

### 5.2 重构后示例（清晰）

**roles.json** (全局):
```json
{
  "roles": {
    "guest": {
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false  // 强制只读
        }
      }
    }
  }
}
```

**agents/myagent/config.json**:
```json
{
  "owners": ["alice.aid.pub"],
  "admins": []
  // guest.aid.pub 不在任何列表中 → 自动为 guest 角色
}
```

**agents/myagent/relations/guest.aid.pub/behavior.json**:
```json
{
  "permissionMode": "bypass"  // ✅ 写入时被拒绝或忽略
  "chatmode": {
    "private": "interactive"  // ✅ 如果允许覆盖，则生效
  }
}
```

**effective 配置解析**:
```typescript
// guest.aid.pub 与 myagent 对话时
{
  "permissionMode": "readonly",  // ← 来自 roles.json，关系级覆盖被忽略
  "chatmode": {
    "private": "interactive"  // ← 来自关系级，如果角色允许覆盖
  }
}
```

---

## 六、字段分类建议

### 6.1 Security 字段（不可覆盖）

| 字段 | 说明 | owner | admin | guest |
|------|------|-------|-------|-------|
| `permissionMode` | 执行权限 | bypass | request | readonly |
| `dispatch` | 群聊响应策略 | 可配置 | mention | mention |
| `baseagents.*.allowedModels` | 模型白名单 | * | sonnet/haiku | haiku only |

### 6.2 Preference 字段（可覆盖）

| 字段 | 说明 | 关系级可覆盖 |
|------|------|-------------|
| `chatmode` | 对话模式 | ✓ |
| `show_activities` | 活动可见性 | ✓ |
| `flush_delay` | 推送延迟 | ✓ |
| `debounce` | 去抖间隔 | ✓ |
| `render` | 渲染模式 | ✓ |
| `enable_rich_content` | 富内容 | ✓ |

### 6.3 Model 字段（条件覆盖）

| 字段 | 说明 | 约束 |
|------|------|------|
| `baseagents.*.model` | 模型选择 | 必须在 `allowedModels` 内 |
| `baseagents.*.effort` | 推理强度 | 可能受角色限制 |

---

## 七、实施计划

### 7.1 阶段 R1：全局角色定义

**目标**：创建 `roles.json` 并定义内置角色

**产物**：
- `roles.json` 文件和 schema
- `roles.schema.1.json`
- `src/config/roles.ts` 读取和解析逻辑

**代码落点**：
- `kits/schemas/roles.schema.1.json`
- `src/config/roles.ts`
- `src/paths.ts` 添加 `rolesConfig()`

### 7.2 阶段 R2：角色约束合并

**目标**：实现受角色约束的配置合并

**产物**：
- `mergeWithRoleConstraints()` 函数
- 关系级写入时的角色校验

**代码落点**：
- `src/config/merge.ts` 新增角色约束合并
- `src/config/config-manager.ts` 集成到 `resolveEffective()`

### 7.3 阶段 R3：移除 behavior.json 内的 roles

**目标**：清理混淆的角色定义

**迁移策略**：
- 扫描现有 `behavior.json` 中的 `roles` 字段
- 迁移到全局 `roles.json`（如果是自定义角色）
- 或映射到内置角色（owner/admin/guest）

**代码落点**：
- 迁移脚本 `scripts/migrate-roles-to-global.ts`
- 更新 `behavior.schema.1.json` 移除 `roles` 字段（breaking change）

### 7.4 阶段 R4：CLI 支持

**目标**：提供角色管理命令

**命令设计**：
```bash
# 查看全局角色定义
ec role list

# 查看用户角色
ec role show --self myagent --peer alice.aid.pub

# 查看角色权限详情
ec role describe owner

# 测试配置是否符合角色约束
ec config validate --self myagent --peer guest.aid.pub
```

---

## 八、完成定义

重构完成后，应满足：

1. ✅ `roles.json` 存在并定义了 owner/admin/guest 三个内置角色
2. ✅ 每个角色明确定义了哪些字段可覆盖、哪些不可覆盖
3. ✅ 关系级配置写入时受角色约束校验
4. ✅ `resolveEffective()` 返回的配置符合角色权限边界
5. ✅ `behavior.json` 不再包含 `roles` 字段
6. ✅ CLI 能够清晰展示角色配置和约束
7. ✅ 文档更新反映新的角色系统设计

---

## 九、向后兼容性

### 9.1 兼容策略

**Phase 1（软迁移）**：
- 同时支持旧的 `behavior.json` 内 `roles` 和新的 `roles.json`
- 新的优先级更高
- 发出 deprecation warning

**Phase 2（硬切换）**：
- 只支持 `roles.json`
- `behavior.schema` 移除 `roles` 字段
- 旧配置加载失败

### 9.2 迁移工具

```bash
# 检查现有配置中的角色定义
ec role audit

# 自动迁移到新格式
ec role migrate --dry-run
ec role migrate --apply
```

---

## 十、总结

### 现状问题
- ❌ 角色定义分散在每个 agent 的 behavior.json 中
- ❌ 角色权限可被关系级配置绕过
- ❌ 缺少字段级的覆盖控制

### 重构目标
- ✅ 全局统一的角色定义（roles.json）
- ✅ 清晰的权限边界（allowOverride）
- ✅ 角色约束的配置合并
- ✅ Security 字段强制，Preference 字段灵活

### 核心设计
```
roles.json (全局角色定义)
  ↓
config.json (角色映射: owners/admins)
  ↓
resolveUserRole() (计算用户角色)
  ↓
mergeWithRoleConstraints() (角色约束合并)
  ↓
effective config (最终配置)
```
