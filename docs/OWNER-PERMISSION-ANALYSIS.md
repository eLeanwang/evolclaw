# Owner 权限配置分析报告

> 版本：v1.0  
> 日期：2026-07-03  
> 状态：分析报告

---

## 📋 概述

本文档分析 EvolClaw 系统中 Owner 角色的权限配置机制，特别是 Agent 级别的 owners 配置和权限体系。

---

## 一、Owner 权限的层次结构

### 1.1 两个层次的 Owner 概念

EvolClaw 系统中存在**两个不同层次**的 Owner 配置：

#### **1. 进程级 Owner（Process Level）**
- **配置位置**：`evolclaw.json` 顶层 `owners` 字段
- **作用范围**：整个 EvolClaw 守护进程
- **权限范围**：
  - 可以执行 `/system` 命令（重启、升级守护进程）
  - 可以执行 `/agent` 命令（创建、删除、启用、禁用 Agent）
  - 进程级 menu 操作的最高权限

**配置示例**：
```json
{
  "$schema_version": 1,
  "owners": ["eleans-2022.agentid.pub"],
  "admins": ["admin.agentid.pub"]
}
```

**代码位置**：`src/index.ts:641-648`
```typescript
// 进程级 menu 操作（/system /agent）鉴权：owners 来自 evolclaw.json 顶层
if (evolclawConfig.owners?.length === 0) {
  throw new Error('evolclaw.json.owners is required when EVOLCLAW_REQUIRE_OWNERS=1');
}
```

#### **2. Agent 级 Owner（Agent Level）**
- **配置位置**：`agents/<aid>/config.json` 中的 `owners` 字段
- **作用范围**：单个 Agent 实例
- **权限范围**：
  - 该 Agent 的完全控制权限
  - 可以管理该 Agent 的所有配置
  - 可以管理该 Agent 的角色分配（owners/admins/members）
  - 拥有 `owner` 角色的所有权限

**Schema 定义**：虽然 `agent-config.schema.2.json` 中**没有显式定义** `owners` 字段，但代码中大量使用了 `config.owners`。

**代码证据**：
```typescript
// src/config/role-resolver.ts 的逻辑（推测）
if (config.owners?.includes(peerKey)) return 'owner';
if (config.admins?.includes(peerKey)) return 'admin';
if (config.members?.includes(peerKey)) return 'member';
```

---

## 二、Agent 级 Owner 配置的缺失问题

### 2.1 Schema 中缺少 owners 定义

**问题发现**：
在 `kits/schemas/agent-config.schema.2.json` 中，**没有定义** `owners`、`admins`、`members` 字段。

但是在代码中广泛使用：
- `ecweb/src/static/app.js:2801` - 读取 `config.owners`
- `src/core/message/command-handler-agent-control.ts:183` - 返回 `owners: config.owners ?? []`
- 多个文档引用 `config.owners`

### 2.2 应该添加的 Schema 定义

**建议**：在 `agent-config.schema.2.json` 中添加以下字段：

```json
{
  "owners": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Agent 所有者 AID 列表，拥有该 Agent 的完全控制权限",
    "x-merge": "list"
  },
  "admins": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Agent 管理员 AID 列表，拥有受保护的管理权限",
    "x-merge": "list"
  },
  "members": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Agent 成员 AID 列表，拥有基本使用权限",
    "x-merge": "list"
  }
}
```

---

## 三、Owner 角色的权限定义

### 3.1 内置 Owner 角色权限

从 `src/config/builtin-roles.ts` 中定义的 `owner` 角色：

```typescript
owner: {
  description: 'Agent owner with full control',
  allowAccess: true,
  permissions: {
    permissionMode: { default: 'bypass', allowOverride: false },
    'baseagents.claude.model': { 
      default: 'claude-opus-4-8', 
      allowOverride: true, 
      allowedModels: ['*']  // 可以使用任何模型
    },
    'baseagents.claude.effort': { default: 'high', allowOverride: true },
    chatmode: { 
      default: { private: 'interactive', group: 'proactive', nothuman: 'proactive' }, 
      allowOverride: true 
    },
    dispatch: { default: 'broadcast', allowOverride: true },
    show_activities: { default: 'all', allowOverride: true },
    flush_delay: { default: 3, allowOverride: true },
    debounce: { default: 0, allowOverride: true },
    enable_rich_content: { default: true, allowOverride: true },
  },
  commandPermissions: {
    'role.assign': { allow: true, scopes: ['agent'] },
    'role.revoke': { allow: true, scopes: ['agent'] },
    '*': { allow: true },  // 允许所有命令
    'dangerous:*': { 
      allow: true, 
      dangerous: true, 
      constraints: { requireDaemonOwner: true }  // 危险操作需要进程级 owner
    },
  },
}
```

### 3.2 Owner 权限的特点

1. **permissionMode: bypass** - 绕过权限检查，无需确认
2. **allowedModels: ['*']** - 可以使用任何模型，无限制
3. **所有字段 allowOverride: true** - 可以在关系级别自由覆盖
4. **命令权限 '*': allow: true** - 允许执行所有命令
5. **危险操作约束** - 需要同时是进程级 owner（requireDaemonOwner）

---

## 四、角色解析优先级

### 4.1 解析顺序

根据代码和文档，角色解析的优先级（从高到低）：

```
1. config.owners[]         → 'owner'     (最高优先级)
2. config.admins[]         → 'admin'
3. config.members[]        → 'member'
4. relation.role           → 显式设置的角色
5. 已认证用户             → 'guest'      (defaultRole fallback)
6. 未认证用户             → 'anonymous'
```

**代码逻辑**（推测自文档）：
```typescript
function resolveUserRole(agentId: string, peerKey: string): string {
  const config = readAgentConfig(agentId);
  
  // 1. Agent 级列表角色（最高优先级）
  if (config.owners?.includes(peerKey)) return 'owner';
  if (config.admins?.includes(peerKey)) return 'admin';
  if (config.members?.includes(peerKey)) return 'member';
  
  // 2. 关系级显式设置
  const relation = readRelationConfig(agentId, peerKey);
  if (relation?.role) return relation.role;
  
  // 3. 默认角色
  return getDefaultRole(); // 通常是 'guest' 或 'anonymous'
}
```

### 4.2 优先级说明

- **Agent 级列表角色** 优先于 **关系级显式设置**
- 这意味着：如果某人在 `config.owners` 列表中，即使在关系配置中设置为 `guest`，仍然是 `owner`
- 这是**系统级配置**，关系级无法降级

---

## 五、Owner 配置的使用场景

### 5.1 初始化时配置 Owner

**场景**：Agent 创建时，配置初始 owner

**代码位置**：`src/cli/init.ts:608,622`
```typescript
// 创建 agent 时设置 owner
{
  aid: agentAid,
  channels: [...],
  owners: [ownerAid],  // 初始 owner
}
```

### 5.2 没有建立关系时的 Owner

**关键点**：
- Owner 配置在 `agents/<aid>/config.json` 中
- **不需要**建立关系（relations/<peerKey>）就生效
- 首次通信时，系统会根据 `config.owners` 判断角色

**流程**：
```
1. 用户 alice.aid.pub 首次向 agent 发消息
2. 系统读取 agents/<aid>/config.json
3. 检查 alice.aid.pub 是否在 config.owners 中
4. 如果在，直接赋予 owner 角色
5. 无需预先创建 relations/aun#alice.aid.pub/ 目录
```

### 5.3 Observable 模式中的 Owner

**场景**：观察者模式中，owner 自动接收消息转发

**代码位置**：`src/index.ts:1226`
```typescript
owners: owningAgent ? 
  listRoleAssignments(owningAgent.aid, { 
    scope: 'private', 
    role: 'owner' 
  }).map(a => a.peerId).filter((peerId): peerId is string => !!peerId) 
  : []
```

---

## 六、发现的问题和建议

### 6.1 问题清单

#### **问题 1：Schema 定义缺失**
- `agent-config.schema.2.json` 中缺少 `owners`/`admins`/`members` 字段定义
- 导致 schema 验证不完整
- 文档和代码不一致

**影响**：
- 配置验证可能失效
- IDE 无法提供正确的自动补全
- 新手不知道这些字段存在

#### **问题 2：文档分散**
- Owner 配置分散在多个文档中
- 进程级 owner 和 agent 级 owner 容易混淆
- 缺少统一的权限配置指南

#### **问题 3：CLI 权限管理缺失**
- Owner 可以执行所有命令 (`'*': allow: true`)
- 但缺少按功能分类的权限界面
- 难以理解 owner 具体有哪些权限

### 6.2 改进建议

#### **建议 1：补充 Schema 定义**

在 `agent-config.schema.2.json` 中添加：

```json
{
  "properties": {
    "owners": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
      "description": "Agent 所有者 AID 列表，拥有完全控制权限",
      "default": [],
      "x-merge": "list"
    },
    "admins": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
      "description": "Agent 管理员 AID 列表，拥有受保护的管理权限（需确认）",
      "default": [],
      "x-merge": "list"
    },
    "members": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[a-zA-Z0-9._-]+$" },
      "description": "Agent 成员 AID 列表，拥有基本使用权限",
      "default": [],
      "x-merge": "list"
    }
  }
}
```

#### **建议 2：创建统一的权限配置文档**

创建 `docs/OWNER-PERMISSION-GUIDE.md`，包含：
- 进程级 owner vs Agent 级 owner 的区别
- Owner 配置的完整流程
- Owner 权限的详细说明
- 常见问题解答

#### **建议 3：在 ECWeb 中增强 Owner 权限展示**

在角色管理界面中：
- 显示 Owner 角色的所有权限清单
- 按照我们设计的 7 个 Tab 分类展示
- 标注哪些权限需要进程级 owner（requireDaemonOwner）

#### **建议 4：增加 Owner 管理的安全提示**

在 ECWeb 的 Owner 管理界面：
- 添加警告：Owner 拥有完全控制权限
- 确认对话框：添加/删除 owner 需要二次确认
- 审计日志：记录 owner 变更历史

---

## 七、Owner 权限最佳实践

### 7.1 配置原则

1. **最少 Owner 原则**
   - 每个 Agent 至少保留 1 个 Owner
   - 建议不超过 2-3 个 Owner
   - Owner 应该是可信任的管理员

2. **进程级 Owner 独立性**
   - `evolclaw.json` 的 owners 应该是系统管理员
   - Agent 级 owner 可以是 Agent 的拥有者
   - 两者可以不同

3. **初始化时指定 Owner**
   - 创建 Agent 时必须指定 owner
   - 使用 `evolclaw init` 时会自动设置
   - 手动创建时不要遗漏

### 7.2 安全建议

1. **定期审计 Owner 列表**
   - 检查 `evolclaw.json` 的 owners
   - 检查每个 Agent 的 owners
   - 移除不再需要的 AID

2. **避免将群组 ID 加入 Owner**
   - 群组 ID 不应该出现在 `config.owners`
   - Owner 应该是个人 AID
   - 使用关系级配置管理群组权限

3. **使用 Observable 模式监控**
   - Owner 可以开启 observable 模式
   - 自动接收所有会话的转发
   - 便于监控和审计

---

## 八、总结

### 8.1 核心要点

1. **Owner 是系统级配置**
   - 配置在 `agents/<aid>/config.json` 中
   - 不需要建立关系就生效
   - 优先级高于关系级配置

2. **Owner 拥有最大权限**
   - `permissionMode: bypass` - 无需权限确认
   - `allowedModels: ['*']` - 无模型限制
   - `'*': allow: true` - 允许所有命令

3. **两层 Owner 概念**
   - 进程级：管理整个 EvolClaw 进程
   - Agent 级：管理单个 Agent 实例

4. **Schema 需要补充**
   - 当前缺少 owners/admins/members 字段定义
   - 需要添加到 agent-config.schema.2.json

### 8.2 下一步行动

- [ ] 更新 `agent-config.schema.2.json`，添加 owners/admins/members 字段
- [ ] 创建统一的权限配置文档
- [ ] 在 ECWeb 中增强 Owner 权限展示（使用 7-Tab 分类）
- [ ] 添加 Owner 管理的安全提示和审计功能

---

**文档维护**: Claude (Opus 4.8)  
**创建日期**: 2026-07-03  
**最后更新**: 2026-07-03
