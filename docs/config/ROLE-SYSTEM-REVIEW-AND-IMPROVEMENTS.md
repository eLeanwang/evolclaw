# EvolClaw 角色系统自查与改进方案

> 创建时间：2026-06-23
> 基于现有代码和配置的全面审查

---

## 一、现有实现审查

### 1.1 现有角色定义（代码中）

根据 `src/core/model/config-scope.ts:218`：

```typescript
const BUILTIN_PERMISSION_BY_ROLE: Record<string, string> = {
  owner: 'bypass',
  admin: 'bypass',
  guest: 'readonly',
  anonymous: 'readonly',
};
```

**已有的内置角色**：
- `owner`: bypass
- `admin`: bypass
- `guest`: readonly
- `anonymous`: readonly
- 其他未定义角色：fallback 到 `auto`

### 1.2 permissionMode 可选值

根据 `behavior.schema.1.json:74-77`：
```json
"enum": ["auto", "bypass", "readonly", "request", "edit", "plan", "noask"]
```

### 1.3 现有优先级链

根据 `config-scope.ts:227`：
```
关系级 behavior.permissionMode
  → 角色级 roles.<role>.permissionMode
  → 内置角色默认（BUILTIN_PERMISSION_BY_ROLE）
  → 'auto'（fallback）
```

---

## 二、自查发现的问题

### 问题 1：owner 和 admin 权限完全相同

**现状**：
```typescript
owner: 'bypass',
admin: 'bypass',
```

**问题**：
- ❌ 两个角色没有任何区别
- ❌ 无法体现 owner 和 admin 的职责差异
- ❌ 实际业务中，admin 应该有所限制

**建议**：
- owner: 完全控制权限，`bypass`
- admin: 有限管理权限，应该是 `request`（每次请求）或 `edit`（允许编辑但需确认）

### 问题 2：缺少 "member" 角色

**现状**：测试代码中出现了 `member` 角色
```typescript
// tests/config-routing.test.ts:73
expect(resolvePermissionMode({ role: 'member' })).toBe('auto');
```

但 `BUILTIN_PERMISSION_BY_ROLE` 中没有定义 `member`。

**问题**：
- ❌ 存在第五种实际使用的角色，但没有明确定义
- ❌ member vs guest 的区别不清晰

**业务场景分析**：
- **anonymous**：完全匿名访客，无身份认证
- **guest**：有身份但未授权的外部用户
- **member**：有身份且有基本权限的普通成员（如团队成员、认证用户）
- **admin**：管理员，有部分管理权限
- **owner**：所有者，完全控制权限

**建议**：明确添加 `member` 角色，填补 guest 和 admin 之间的空白。

### 问题 3：guest 和 anonymous 权限完全相同

**现状**：
```typescript
guest: 'readonly',
anonymous: 'readonly',
```

**问题**：
- ❌ 两个角色没有区别
- ❌ 实际业务中，anonymous（匿名）应该比 guest（访客）更受限

**建议**：
- anonymous: 完全禁止执行，可以考虑 `readonly` 或更严格的模式
- guest: 只读模式，`readonly`

### 问题 4：角色缺少完整的字段配置

**现状**：只有 `permissionMode` 有内置默认值，其他字段都没有角色级约束。

**问题**：
- ❌ `dispatch`：所有角色都能自由设置 `broadcast`（群聊广播响应）
- ❌ `baseagents.model`：guest 可以配置使用 opus-4-8（成本极高）
- ❌ `chatmode`：没有角色级的默认策略

### 问题 5：缺少字段级的 allowOverride 控制

**现状**：关系级配置可以覆盖任何字段，包括 `permissionMode`。

**问题**：
- ❌ guest 用户可以在关系级配置中设置 `permissionMode: "bypass"`
- ❌ 没有机制阻止权限提升

---

## 三、改进后的角色设计

### 3.1 五级角色体系

| 角色 | 场景 | permissionMode | 模型限制 | dispatch | chatmode.private |
|------|------|----------------|----------|----------|------------------|
| **owner** | Agent 所有者 | `bypass` | 无限制 | 可配置 | `interactive` |
| **admin** | 管理员 | `request` | sonnet/opus | 可配置 | `interactive` |
| **member** | 团队成员 | `auto` | sonnet/haiku | `mention` | `interactive` |
| **guest** | 访客 | `readonly` | haiku only | `mention` | `proactive` |
| **anonymous** | 匿名用户 | `readonly` | haiku only | `mention` | `proactive` |

### 3.2 角色定义：roles.json

```json
{
  "$schema_version": 1,
  "roles": {
    "owner": {
      "description": "Agent 所有者，完全控制权限",
      "permissions": {
        "permissionMode": {
          "default": "bypass",
          "allowOverride": false,
          "reason": "所有者权限不可降级"
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-opus-4-8",
              "effort": "high"
            }
          },
          "allowOverride": true,
          "allowedModels": ["*"],
          "reason": "所有者可使用任意模型"
        },
        "chatmode": {
          "default": {
            "private": "interactive",
            "group": "proactive",
            "nothuman": "proactive"
          },
          "allowOverride": true
        },
        "dispatch": {
          "default": "broadcast",
          "allowOverride": true,
          "reason": "所有者可自由配置响应策略"
        },
        "show_activities": {
          "default": "all",
          "allowOverride": true
        },
        "flush_delay": {
          "default": 3,
          "allowOverride": true
        },
        "debounce": {
          "default": 0,
          "allowOverride": true
        },
        "enable_rich_content": {
          "default": true,
          "allowOverride": true
        }
      }
    },
    
    "admin": {
      "description": "管理员，有限的管理权限，需要确认敏感操作",
      "permissions": {
        "permissionMode": {
          "default": "request",
          "allowOverride": false,
          "reason": "管理员必须逐次确认操作"
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-sonnet-4-6",
              "effort": "medium"
            }
          },
          "allowOverride": true,
          "allowedModels": ["claude-opus-*", "claude-sonnet-*", "claude-haiku-*"],
          "reason": "管理员可使用主流模型，成本可控"
        },
        "chatmode": {
          "default": {
            "private": "interactive",
            "group": "proactive",
            "nothuman": "proactive"
          },
          "allowOverride": true
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": true,
          "allowedValues": ["mention"],
          "reason": "管理员不能配置 broadcast，避免打扰"
        },
        "show_activities": {
          "default": "all",
          "allowOverride": true
        },
        "flush_delay": {
          "default": 3,
          "allowOverride": true
        },
        "debounce": {
          "default": 0,
          "allowOverride": true
        },
        "enable_rich_content": {
          "default": true,
          "allowOverride": true
        }
      }
    },
    
    "member": {
      "description": "团队成员，有基本使用权限",
      "permissions": {
        "permissionMode": {
          "default": "auto",
          "allowOverride": false,
          "reason": "成员使用智能判断模式"
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-sonnet-4-6",
              "effort": "medium"
            }
          },
          "allowOverride": true,
          "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
          "reason": "成员可使用中低成本模型"
        },
        "chatmode": {
          "default": {
            "private": "interactive",
            "group": "proactive",
            "nothuman": "proactive"
          },
          "allowOverride": true
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": false,
          "reason": "成员只能使用 mention 模式"
        },
        "show_activities": {
          "default": "all",
          "allowOverride": true
        },
        "flush_delay": {
          "default": 3,
          "allowOverride": true
        },
        "debounce": {
          "default": 0,
          "allowOverride": true
        },
        "enable_rich_content": {
          "default": false,
          "allowOverride": true
        }
      }
    },
    
    "guest": {
      "description": "访客，只读权限，有身份但未授权",
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false,
          "reason": "访客只能查询，不能执行"
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-haiku-4-5-20251001",
              "effort": "low"
            }
          },
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "访客只能使用最低成本模型"
        },
        "chatmode": {
          "default": {
            "private": "proactive",
            "group": "proactive",
            "nothuman": "proactive"
          },
          "allowOverride": false,
          "reason": "访客必须使用主动模式，避免过度消耗"
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": false,
          "reason": "访客只能通过 @mention 触发"
        },
        "show_activities": {
          "default": "none",
          "allowOverride": false,
          "reason": "访客不应看到内部处理过程"
        },
        "flush_delay": {
          "default": 5,
          "allowOverride": false,
          "reason": "访客消息批次延迟更长"
        },
        "debounce": {
          "default": 0,
          "allowOverride": false
        },
        "enable_rich_content": {
          "default": false,
          "allowOverride": false
        }
      }
    },
    
    "anonymous": {
      "description": "匿名用户，完全未认证，极度受限",
      "permissions": {
        "permissionMode": {
          "default": "readonly",
          "allowOverride": false,
          "reason": "匿名用户只读"
        },
        "baseagents": {
          "default": {
            "claude": {
              "model": "claude-haiku-4-5-20251001",
              "effort": "low"
            }
          },
          "allowOverride": false,
          "allowedModels": ["claude-haiku-*"],
          "reason": "匿名只能使用最低成本模型"
        },
        "chatmode": {
          "default": {
            "private": "proactive",
            "group": "proactive",
            "nothuman": "proactive"
          },
          "allowOverride": false
        },
        "dispatch": {
          "default": "mention",
          "allowOverride": false
        },
        "show_activities": {
          "default": "none",
          "allowOverride": false
        },
        "flush_delay": {
          "default": 10,
          "allowOverride": false,
          "reason": "匿名用户延迟最长"
        },
        "debounce": {
          "default": 0,
          "allowOverride": false
        },
        "enable_rich_content": {
          "default": false,
          "allowOverride": false
        }
      }
    }
  }
}
```

---

## 四、字段分类与权限矩阵

### 4.1 Security 字段（所有角色不可覆盖）

| 字段 | owner | admin | member | guest | anonymous |
|------|-------|-------|--------|-------|-----------|
| `permissionMode` | bypass | request | auto | readonly | readonly |
| **allowOverride** | ❌ | ❌ | ❌ | ❌ | ❌ |

### 4.2 成本控制字段（部分可覆盖）

| 字段 | owner | admin | member | guest | anonymous |
|------|-------|-------|--------|-------|-----------|
| `baseagents.*.model` | * | opus/sonnet/haiku | sonnet/haiku | haiku | haiku |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |
| `baseagents.*.effort` | high | medium | medium | low | low |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |

### 4.3 行为控制字段（部分可覆盖）

| 字段 | owner | admin | member | guest | anonymous |
|------|-------|-------|--------|-------|-----------|
| `dispatch` | broadcast | mention | mention | mention | mention |
| **allowOverride** | ✅ | ✅ | ❌ | ❌ | ❌ |
| `chatmode.private` | interactive | interactive | interactive | proactive | proactive |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |
| `show_activities` | all | all | all | none | none |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |

### 4.4 用户偏好字段（高权限可覆盖）

| 字段 | owner | admin | member | guest | anonymous |
|------|-------|-------|--------|-------|-----------|
| `flush_delay` | 3 | 3 | 3 | 5 | 10 |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |
| `debounce` | 0 | 0 | 0 | 0 | 0 |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |
| `enable_rich_content` | true | true | false | false | false |
| **allowOverride** | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## 五、关键改进点总结

### 5.1 角色权限分离

- ✅ **owner**：完全控制（bypass）
- ✅ **admin**：需要确认（request），模型受限
- ✅ **member**：智能判断（auto），中低成本模型
- ✅ **guest**：只读（readonly），最低成本，主动模式
- ✅ **anonymous**：只读，最严格限制

### 5.2 成本控制

- ✅ guest/anonymous 只能用 haiku
- ✅ member 可用 sonnet/haiku
- ✅ admin 可用 opus/sonnet/haiku
- ✅ owner 无限制

### 5.3 安全边界

- ✅ `permissionMode` 所有角色不可覆盖
- ✅ guest/anonymous 的 `dispatch`/`chatmode`/`show_activities` 不可覆盖
- ✅ 防止权限提升攻击

### 5.4 用户体验

- ✅ owner/admin/member 使用 interactive 模式（流畅）
- ✅ guest/anonymous 使用 proactive 模式（受控）
- ✅ 高权限用户可个性化配置

---

## 六、代码改动点

### 6.1 更新内置角色定义

```typescript
// src/core/model/config-scope.ts
const BUILTIN_PERMISSION_BY_ROLE: Record<string, string> = {
  owner: 'bypass',
  admin: 'request',      // 改：原来是 bypass
  member: 'auto',        // 新增
  guest: 'readonly',
  anonymous: 'readonly',
};
```

### 6.2 创建 roles.json schema

```
kits/schemas/roles.schema.1.json
```

### 6.3 实现角色约束合并

```typescript
// src/config/roles.ts
export function mergeWithRoleConstraints(
  role: string,
  relationConfig: BehaviorConfig
): BehaviorConfig;
```

### 6.4 更新测试

```typescript
// tests/config-routing.test.ts
expect(resolvePermissionMode({ role: 'admin' })).toBe('request'); // 改
expect(resolvePermissionMode({ role: 'member' })).toBe('auto');   // 已存在
```

---

## 七、向后兼容

### 7.1 已有 admin 用户

**问题**：现有 admin 用户的 permissionMode 会从 `bypass` 变为 `request`

**解决方案**：
1. 在关系级配置中显式设置 `permissionMode: "bypass"`（迁移脚本）
2. 或者提供过渡期配置项 `roles.admin.legacyBypass: true`

### 7.2 未定义的角色

**问题**：如果有自定义角色（如 "vip"）

**解决方案**：
- fallback 到 `member` 级别权限
- 或者在 roles.json 中允许自定义角色定义

---

## 八、实施优先级

**P0（立即）**：
1. ✅ 修正 admin 权限为 `request`
2. ✅ 添加 member 角色定义
3. ✅ 更新测试用例

**P1（短期）**：
4. 创建 roles.json 和 schema
5. 实现字段级 allowOverride 检查
6. 编写迁移脚本

**P2（中期）**：
7. 实现完整的角色约束合并
8. 移除 behavior.json 内的 roles 字段
9. CLI 角色管理命令

---

## 九、最终建议

### 是否需要添加新角色？

**答案：是的，需要添加 `member` 角色**

**理由**：
1. 测试代码中已经使用了 member
2. 填补了 guest（只读）和 admin（管理员）之间的空白
3. 符合实际业务场景：团队成员需要正常使用权限，但不是管理员

### 权限设置是否合理？

**需要调整**：
- ❌ admin 不应该是 bypass，应该是 request
- ✅ owner bypass 合理
- ✅ guest/anonymous readonly 合理
- ✅ 新增 member auto 合理

### 默认配置是否完整？

**需要补充**：
- ❌ 当前只有 permissionMode 有角色默认值
- ✅ 应该为所有 behavior 字段定义角色级默认值
- ✅ 应该明确哪些字段允许关系级覆盖
