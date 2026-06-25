# 角色管理功能重新设计方案

## 📋 当前问题分析

### 现有实现的问题
当前实现将"角色定义"和"角色分配"混在一起，导致：
1. **概念混淆**：角色权限配置（roles.json）和用户角色分配（agent/config.json）在同一个界面
2. **功能不清晰**：用户不知道在哪里管理角色定义，在哪里分配角色
3. **扩展性差**：无法方便地查看和修改内置角色的权限配置

---

## 🎯 重新设计方案

### 方案概述

将角色管理拆分为 **两个独立的 Tab**：

```
Roles Tab (角色定义)          →  管理角色本身及其权限
Role Assignment (角色分配)    →  管理 Agent 和对端的角色分配
```

---

## 📊 详细设计

### Tab 1: Roles (角色定义)

**位置**: 主导航栏新增 "Roles" Tab

**功能**: 管理内置角色及其权限配置

#### 1.1 角色列表视图

```
+---------------------------------------------------------------+
| 🎭 Roles Management                                          |
+---------------------------------------------------------------+
| 
| +---------------------------+  +---------------------------+  |
| | 👑 Owner                  |  | 🛡️ Admin                  |  |
| | Complete control          |  | Needs confirmation        |  |
| |                           |  |                           |  |
| | permissionMode: bypass    |  | permissionMode: request   |  |
| | model: claude-opus-4-8    |  | model: claude-sonnet-4-6  |  |
| | dispatch: broadcast       |  | dispatch: mention         |  |
| |                           |  |                           |  |
| | [View Details] [Edit]     |  | [View Details] [Edit]     |  |
| +---------------------------+  +---------------------------+  |
|                                                               |
| +---------------------------+  +---------------------------+  |
| | 👥 Member                 |  | 👤 Guest                  |  |
| | Basic permissions         |  | Read-only                 |  |
| |                           |  |                           |  |
| | permissionMode: auto      |  | permissionMode: readonly  |  |
| | model: claude-sonnet-4-6  |  | model: claude-haiku-4-5   |  |
| | dispatch: mention         |  | dispatch: mention         |  |
| |                           |  |                           |  |
| | [View Details] [Edit]     |  | [View Details] [Edit]     |  |
| +---------------------------+  +---------------------------+  |
|                                                               |
| +---------------------------+                                 |
| | 🚫 Anonymous              |                                 |
| | Not authenticated         |                                 |
| |                           |                                 |
| | permissionMode: readonly  |                                 |
| | model: claude-haiku-4-5   |                                 |
| | dispatch: mention         |                                 |
| |                           |                                 |
| | [View Details] [Edit]     |                                 |
| +---------------------------+                                 |
+---------------------------------------------------------------+
```

#### 1.2 角色详情/编辑视图

点击 "View Details" 或 "Edit" 后，弹出详情面板：

```
+---------------------------------------------------------------+
| 👑 Owner Role Configuration                          [×]     |
+---------------------------------------------------------------+
| 
| 📝 Basic Info
| ┌───────────────────────────────────────────────────────────┐
| │ Name: owner                                                │
| │ Description: Agent 所有者，完全控制权限                     │
| └───────────────────────────────────────────────────────────┘
|
| 🔐 Permission Configuration
| ┌───────────────────────────────────────────────────────────┐
| │ Permission Mode                                            │
| │ ┌─────────────────────────────────────────────────────┐  │
| │ │ ○ bypass   (直接执行，无需确认)                      │  │
| │ │ ○ request  (每次操作需确认)                         │  │
| │ │ ○ auto     (智能判断)                               │  │
| │ │ ○ readonly (只读，不能执行)                         │  │
| │ └─────────────────────────────────────────────────────┘  │
| │ □ Allow user override                                     │
| └───────────────────────────────────────────────────────────┘
|
| 🤖 Model Configuration
| ┌───────────────────────────────────────────────────────────┐
| │ Default Model                                              │
| │ ┌─────────────────────────────────────────────────────┐  │
| │ │ claude-opus-4-8                                ▼    │  │
| │ └─────────────────────────────────────────────────────┘  │
| │                                                            │
| │ ☑ Allow user override                                    │
| │                                                            │
| │ Allowed Models                                             │
| │ ┌─────────────────────────────────────────────────────┐  │
| │ │ ☑ claude-opus-*                                      │  │
| │ │ ☑ claude-sonnet-*                                    │  │
| │ │ ☑ claude-haiku-*                                     │  │
| │ │ ☑ All models (*)                                     │  │
| │ └─────────────────────────────────────────────────────┘  │
| │                                                            │
| │ Reasoning Effort                                           │
| │ ┌─────────────────────────────────────────────────────┐  │
| │ │ high                                           ▼    │  │
| │ └─────────────────────────────────────────────────────┘  │
| │ ☑ Allow user override                                    │
| └───────────────────────────────────────────────────────────┘
|
| 📡 Dispatch Configuration
| ┌───────────────────────────────────────────────────────────┐
| │ Default Dispatch Mode                                      │
| │ ┌─────────────────────────────────────────────────────┐  │
| │ │ ○ broadcast (响应所有消息)                          │  │
| │ │ ○ mention   (仅响应 @提及)                          │  │
| │ └─────────────────────────────────────────────────────┘  │
| │ ☑ Allow user override                                    │
| │                                                            │
| │ Allowed Values: [broadcast] [mention]                     │
| └───────────────────────────────────────────────────────────┘
|
| 🎛️ Other Permissions
| ┌───────────────────────────────────────────────────────────┐
| │ Chat Mode                                                  │
| │   private: interactive ▼    group: proactive ▼            │
| │   nothuman: proactive ▼                                   │
| │   ☑ Allow user override                                   │
| │                                                            │
| │ Show Activities                                            │
| │   ○ all  ○ summary  ○ none                               │
| │   ☑ Allow user override                                   │
| │                                                            │
| │ Flush Delay (seconds)                                      │
| │   [3]  ☑ Allow user override                             │
| │                                                            │
| │ Debounce (milliseconds)                                    │
| │   [0]  ☑ Allow user override                             │
| │                                                            │
| │ Enable Rich Content                                        │
| │   ☑ Enabled  ☑ Allow user override                       │
| └───────────────────────────────────────────────────────────┘
|
| [Cancel]  [Save Changes]  [Reset to Default]
+---------------------------------------------------------------+
```

#### 1.3 数据来源

- **读取**: `roles.json` 或内置 `getBuiltinRolesConfig()`
- **写入**: 保存到 `roles.json`

#### 1.4 API 设计

```typescript
// GET /api/roles/definitions
// 返回所有角色定义
{
  "roles": {
    "owner": { ... },
    "admin": { ... },
    "member": { ... },
    "guest": { ... },
    "anonymous": { ... }
  }
}

// GET /api/roles/definition/{roleName}
// 返回单个角色定义
{
  "name": "owner",
  "description": "...",
  "permissions": { ... }
}

// PUT /api/roles/definition/{roleName}
// 更新角色定义
// Body: { "permissions": { ... } }

// POST /api/roles/definition/reset/{roleName}
// 重置角色为默认配置
```

---

### Tab 2: Role Assignment (角色分配)

**位置**: 主导航栏新增 "Role Assignment" Tab

**功能**: 管理 Agent 及其对端的角色分配

#### 2.1 主视图布局

```
+---------------------------------------------------------------+
| 🎯 Role Assignment                                           |
+---------------------------------------------------------------+
| 
| Select Agent:  [demo.aid.pub                          ▼]    |
|                                                               |
| +-----------------------------------------------------------+ |
| | 📊 Agent Overview: demo.aid.pub                           | |
| +-----------------------------------------------------------+ |
| |                                                           | |
| | Owners (2)   Admins (1)   Members (3)   Total: 6         | |
| |                                                           | |
| +-----------------------------------------------------------+ |
|
| ┌─────────────────────────────────────────────────────────┐ |
| │ 👤 Direct Role Assignments (Agent Level)                │ |
| ├─────────────────────────────────────────────────────────┤ |
| │                                                          │ |
| │ +------------------+  +------------------+  +---------+ │ |
| │ | 👑 Owners        |  | 🛡️ Admins        |  | 👥 Mem  | │ |
| │ |                  |  |                  |  |         | │ |
| │ | alice.aid.pub [×]|  | bob.aid.pub  [×] |  | char... | │ |
| │ | admin.aid.pub [×]|  |                  |  | davi... | │ |
| │ |                  |  |                  |  | eve.... | │ |
| │ | [+ Add Owner]    |  | [+ Add Admin]    |  | [+ Add] | │ |
| │ +------------------+  +------------------+  +---------+ │ |
| │                                                          │ |
| └─────────────────────────────────────────────────────────┘ |
|
| ┌─────────────────────────────────────────────────────────┐ |
| │ 🔗 Peer Role Assignments (Relation Level)               │ |
| ├─────────────────────────────────────────────────────────┤ |
| │                                                          │ |
| │ 🔍 Filter: [All Channels ▼] [All Roles ▼] [Search...]  │ |
| │                                                          │ |
| │ ┌──────────────────────────────────────────────────────┐ |
| │ │ Peer Key          │ Channel │ Role   │ Source │ ... │ │ |
| │ ├──────────────────────────────────────────────────────┤ |
| │ │ feishu#ou_abc123  │ Feishu  │ admin  │ agent  │ [Edit] │ |
| │ │ wecom#user_456    │ WeCom   │ member │ relation │ [Edit] │ |
| │ │ aun#peer_xyz      │ AUN     │ owner  │ agent  │ [Edit] │ |
| │ │ qq#123456789      │ QQ      │ guest  │ auto   │ [Edit] │ |
| │ └──────────────────────────────────────────────────────┘ |
| │                                                          │ |
| │ Showing 4 of 4 relations                                │ |
| │                                                          │ |
| └─────────────────────────────────────────────────────────┘ |
|
| [Export CSV]  [Import CSV]  [Refresh]
+---------------------------------------------------------------+
```

#### 2.2 编辑对端角色

点击 "Edit" 后弹出对话框：

```
+-------------------------------------------------------+
| Edit Role for feishu#ou_abc123                   [×] |
+-------------------------------------------------------+
|                                                       |
| Current Effective Role: admin                         |
| Source: agent (from agent-level assignment)           |
|                                                       |
| Override with Relation-Level Role:                    |
| ┌─────────────────────────────────────────────────┐  |
| │ ○ No override (use agent-level role)            │  |
| │ ● Set relation-level role:                      │  |
| │   ┌───────────────────────────────────────────┐ │  |
| │   │ owner     ▼                               │ │  |
| │   └───────────────────────────────────────────┘ │  |
| └─────────────────────────────────────────────────┘  |
|                                                       |
| ℹ️ Info:                                              |
| - Agent-level role: bob.aid.pub is in admins list   |
| - Relation-level override: (none)                    |
| - Final effective role: admin                        |
|                                                       |
| [Cancel]  [Save]                                      |
+-------------------------------------------------------+
```

#### 2.3 数据来源

- **Agent 级别角色**: `agents/{aid}/config.json` 的 `owners/admins/members`
- **Relation 级别角色**: `agents/{aid}/relations/{peerKey}/config.json` 的 `role` 字段
- **有效角色**: 通过 `RoleResolver.resolveUserRole()` 计算

#### 2.4 API 设计

```typescript
// GET /api/assignments/agent/{aid}
// 获取 agent 的角色分配概览
{
  "aid": "demo.aid.pub",
  "owners": ["alice.aid.pub", "admin.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub", "david.aid.pub"]
}

// POST /api/assignments/agent/{aid}
// 更新 agent 级别的角色分配
// Body: { "field": "owners|admins|members", "users": ["..."] }

// GET /api/assignments/peers/{aid}
// 获取 agent 的所有对端关系及角色
{
  "peers": [
    {
      "peerKey": "feishu#ou_abc123",
      "channel": "feishu",
      "effectiveRole": "admin",
      "source": "agent",
      "agentLevelRole": "admin",
      "relationLevelRole": null
    }
  ]
}

// PUT /api/assignments/peer/{aid}/{peerKey}
// 设置对端的 relation 级别角色覆盖
// Body: { "role": "owner|admin|member|null" }
// null 表示移除覆盖，使用 agent 级别角色
```

---

## 🔄 数据流和优先级

### 角色解析优先级

```
1. Relation-level role (agents/{aid}/relations/{peerKey}/config.json)
   ↓ 如果不存在
2. Agent-level role (agents/{aid}/config.json 的 owners/admins/members)
   ↓ 如果不在任何列表
3. Guest (已认证的 AID 格式)
   ↓ 如果不是 AID 格式
4. Anonymous (未认证)
```

### 配置文件结构

**角色定义**: `roles.json`
```json
{
  "$schema_version": 1,
  "roles": {
    "owner": {
      "description": "...",
      "permissions": {
        "permissionMode": { "default": "bypass", "allowOverride": false },
        "baseagents.claude.model": { 
          "default": "claude-opus-4-8",
          "allowOverride": true,
          "allowedModels": ["*"]
        }
      }
    }
  }
}
```

**Agent 级别角色分配**: `agents/{aid}/config.json`
```json
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub"],
  "members": ["charlie.aid.pub"]
}
```

**Relation 级别角色覆盖**: `agents/{aid}/relations/{peerKey}/config.json`
```json
{
  "role": "admin"
}
```

---

## 🎨 UI/UX 改进

### 导航栏更新

```
Before:
[Agents] [Messages] [Sessions] [Triggers] [Cache] [System] [Gateway] [Usage] [Monitor] [Roles]

After:
[Agents] [Messages] [Sessions] [Triggers] [Cache] [System] [Gateway] [Usage] [Monitor] [Roles] [Role Assignment]
```

### 颜色和图标

**角色图标**:
- 👑 Owner - 金色 (#fef3c7 / #92400e)
- 🛡️ Admin - 蓝色 (#dbeafe / #1e40af)
- 👥 Member - 绿色 (#d1fae5 / #065f46)
- 👤 Guest - 灰色 (#f3f4f6 / #374151)
- 🚫 Anonymous - 红色 (#fee2e2 / #991b1b)

**来源标识**:
- `agent` - 普通文本
- `relation` - **加粗**显示
- `auto` - 斜体显示

---

## 📊 实施计划

### Phase 1: 角色定义管理 (Roles Tab)

**工作量**: 3-4 天

1. **后端**:
   - 新增 `sources/role-definitions.ts` 数据源
   - 实现角色定义的 CRUD API
   - 读写 `roles.json` 文件

2. **前端**:
   - 角色卡片列表视图
   - 角色详情/编辑弹窗
   - 表单验证和保存

3. **测试**:
   - 角色配置的读取和保存
   - 默认配置重置
   - 数据验证

### Phase 2: 角色分配管理 (Role Assignment Tab)

**工作量**: 4-5 天

1. **后端**:
   - 修改现有 `sources/roles.ts` 重命名为 `sources/role-assignments.ts`
   - 实现对端角色的编辑 API
   - 集成 RoleResolver

2. **前端**:
   - Agent 选择器和概览
   - Agent 级别角色管理（三列布局）
   - 对端关系列表和编辑
   - 筛选和搜索

3. **测试**:
   - 角色分配的增删改
   - Relation 级别覆盖
   - 有效角色计算

### Phase 3: 集成和优化

**工作量**: 2-3 天

1. 国际化完善
2. 响应式布局调整
3. 性能优化
4. 文档更新

**总工期**: 9-12 天

---

## 🔄 迁移方案

### 从现有实现迁移

1. **重命名**:
   - 现有 "Roles" Tab → "Role Assignment"
   - `sources/roles.ts` → `sources/role-assignments.ts`

2. **新增**:
   - 创建新的 "Roles" Tab
   - 创建 `sources/role-definitions.ts`

3. **数据兼容**:
   - 现有配置文件无需修改
   - 如果没有 `roles.json`，使用内置默认配置

4. **用户体验**:
   - 导航栏顺序调整为 `[... Roles] [Role Assignment]`
   - 文档和提示更新

---

## 📝 API 汇总

### Roles (角色定义)

```
GET    /api/roles/definitions           - 获取所有角色定义
GET    /api/roles/definition/:role      - 获取单个角色定义
PUT    /api/roles/definition/:role      - 更新角色定义
POST   /api/roles/definition/:role/reset - 重置为默认
```

### Role Assignment (角色分配)

```
GET    /api/assignments/agent/:aid      - 获取 agent 角色分配
POST   /api/assignments/agent/:aid      - 更新 agent 角色分配
GET    /api/assignments/peers/:aid      - 获取所有对端关系
PUT    /api/assignments/peer/:aid/:peer - 设置对端角色覆盖
DELETE /api/assignments/peer/:aid/:peer - 移除对端角色覆盖
```

---

## 🎯 验收标准

### Roles Tab
- [ ] 显示 5 个内置角色卡片
- [ ] 点击卡片查看详细权限
- [ ] 可以编辑角色权限配置
- [ ] 可以重置为默认配置
- [ ] 修改保存到 `roles.json`
- [ ] 支持中英文切换

### Role Assignment Tab
- [ ] 可以选择 Agent
- [ ] 显示 Agent 概览统计
- [ ] 三列显示 owners/admins/members
- [ ] 可以添加/删除用户
- [ ] 显示所有对端关系列表
- [ ] 可以设置对端的 relation 级别覆盖
- [ ] 显示有效角色和来源
- [ ] 支持筛选和搜索
- [ ] 支持中英文切换

---

## 🆚 对比：现有 vs 新设计

| 维度 | 现有实现 | 新设计 |
|------|---------|--------|
| Tab 数量 | 1 个 (Roles) | 2 个 (Roles + Role Assignment) |
| 角色定义管理 | ❌ 无法在 UI 管理 | ✅ 可视化编辑 |
| Agent 角色分配 | ✅ 支持 | ✅ 保留并优化 |
| 对端角色管理 | ⚠️ 仅查看 | ✅ 可编辑 relation 覆盖 |
| 角色来源显示 | ✅ 支持 | ✅ 更清晰的标识 |
| 权限详情展示 | ❌ 无 | ✅ 完整的权限配置 |
| 用户体验 | ⚠️ 概念混淆 | ✅ 功能清晰分离 |

---

## 📚 相关文档

- [角色系统设计](../config/config-roles-layer-design.md)
- [ConfigManager 文档](../../src/config/)
- [RoleResolver 实现](../../src/config/role-resolver.ts)
- [现有实施指南](./ROLES-IMPLEMENTATION-GUIDE.md)

---

## 💡 未来扩展

### 1. 自定义角色
支持创建自定义角色（非内置的 5 种）

### 2. 角色继承
支持角色继承机制，简化配置

### 3. 批量操作
支持批量导入/导出角色分配

### 4. 审计日志
记录所有角色变更操作

### 5. 角色模板
预设常用的角色配置模板

---

**提案版本**: v1.0  
**创建时间**: 2026-06-24  
**状态**: 待评审
