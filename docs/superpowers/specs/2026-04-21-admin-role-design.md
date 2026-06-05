# Admin 角色设计

## 概述

EvolClaw 当前只有 `owner` 和 `guest` 两级角色，权限划分过于粗糙。新增 `admin` 角色作为二级管理员，能执行大部分管理操作但不能做系统级运维。

## 角色层级

```
owner > admin > guest > anonymous
```

| 角色 | 来源 | 默认 permissionMode |
|------|------|-------------------|
| owner | 渠道配置 `owner` 字段（不变） | bypass |
| admin | 渠道配置 `admins` 数组（新增） | auto |
| guest | 已识别但无特殊权限的用户（不变） | readonly |
| anonymous | 无 userId（不变） | — |

## 身份判定链

```
isOwner(config, channel, userId) → true: owner
↓ false
isAdmin(config, channel, userId) → true: admin
↓ false
guest (有 userId) / anonymous (无 userId)
```

## 存储

在 `evolclaw.json` 的渠道配置中新增 `admins` 字段，与 `owner` 同级：

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "owner": "ou_owner_id",
      "admins": ["ou_admin_1", "ou_admin_2"]
    },
    "wechat": {
      "owner": "wx_owner_id",
      "admins": ["wx_admin_1"]
    }
  }
}
```

多实例配置同理，每个实例各自维护 `admins` 列表：

```json
{
  "channels": {
    "feishu": [
      { "name": "feishu-prod", "owner": "ou_xxx", "admins": ["ou_aaa"] },
      { "name": "feishu-test", "owner": "ou_xxx", "admins": ["ou_bbb"] }
    ]
  }
}
```

admin 管理方式：手工编辑 `evolclaw.json`，不提供运行时命令。

## 命令权限划分

### 三级权限层

| 级别 | 可用角色 | 命令 |
|------|---------|------|
| owner only | owner | `/bind`, `/restart`, `/file`, `/perm`(模式切换) |
| owner only (群聊) | owner | `/p`, `/agent` |
| admin+ | owner, admin | `/pwd`, `/p`(私聊), `/model`, `/effort`, `/agent`(私聊), `/fork`, `/rewind`, `/compact`, `/clear`, `/stop`, `/check`, `/perm`(allow/deny/always 审批) |
| user | 所有人 | `/new`, `/s`, `/slist`, `/name`, `/del`, `/status`, `/help` |

### 关键细节

- `/p` 和 `/agent`：私聊中 admin 可用，群聊中 owner only（影响全群）
- `/perm`：模式切换（`/perm auto`、`/perm bypass` 等）owner only；审批操作（`/perm allow|deny|always`）admin 可用
- `/check`：admin 完全可用（包括 `/check rty` 重连）

## 受影响的模块

### 1. `src/types.ts`

`SessionIdentity.role` 增加 `'admin'`：

```typescript
export interface SessionIdentity {
  role: 'owner' | 'admin' | 'guest' | 'anonymous';  // 新增 'admin'
  mode: 'interactive' | 'autonomous';
}
```

渠道配置类型增加 `admins` 字段（所有渠道配置接口）。

### 2. `src/config.ts`

新增查询函数：

```typescript
export function isAdmin(config: Config, channelOrType: string, userId: string): boolean
```

查找逻辑与 `isOwner` 一致：先按实例名精确匹配 `admins` 数组，再按 channelType 遍历所有实例。

### 3. `src/core/session/session-manager.ts`

构造函数增加 `adminResolver` 参数（与 `ownerResolver` 同模式）。

`resolveIdentity` 增加 admin 判定层：

```typescript
resolveIdentity(channel: string, userId?: string): SessionIdentity {
  if (!userId) return { role: 'anonymous', mode: 'interactive' };
  if (this.ownerResolver?.(channel, userId)) return { role: 'owner', mode: 'interactive' };
  if (this.adminResolver?.(channel, userId)) return { role: 'admin', mode: 'interactive' };
  return { role: 'guest', mode: 'interactive' };
}
```

### 4. `src/index.ts`

初始化 `SessionManager` 时注入 `adminResolver`：

```typescript
const sessionManager = new SessionManager(undefined, eventBus,
  (channel, userId) => isOwner(config, channel, userId),
  (channel, userId) => isAdmin(config, channel, userId)  // 新增
);
```

### 5. `src/core/command-handler.ts`（主要改动）

权限变量语义变更：

```typescript
// 现有
const isAdmin = identity.role === 'owner';

// 变更为
const isOwner = identity.role === 'owner';
const isAdmin = identity.role === 'owner' || identity.role === 'admin';
```

具体命令权限检查：

- owner only 命令（`/bind`, `/restart`, `/file`, `/perm` 模式切换）：检查 `isOwner`
- 群聊 `/p` 和 `/agent`：检查 `isOwner`
- admin+ 命令：检查 `isAdmin`（现在包含 admin 角色）
- `/help` 输出按三级角色区分展示
- `getMenuItems(role, chatType)` 参数从 `isAdmin: boolean` 改为 `role: string`，按角色返回对应菜单

### 6. `src/core/message/message-processor.ts`

默认权限模式增加 admin 层：

```typescript
// 现有
const defaultPermMode = session.identity?.role === 'owner' ? 'bypass' : 'readonly';

// 变更为
const defaultPermMode =
  session.identity?.role === 'owner' ? 'bypass' :
  session.identity?.role === 'admin' ? 'auto' :
  'readonly';
```

### 7. `src/core/message/message-bridge.ts`

`menu.query` 处理传递 role 而非 boolean：

```typescript
const items = this.cmdHandler.getMenuItems(identity.role, msg.chatType || 'private');
```

### 8. 测试

- 现有权限相关测试适配三级角色
- 新增 admin 角色的命令权限验证

## 不涉及的内容

- 不新增 DB 表或 DB 迁移
- 不新增 `/admin` 运行时命令（admin 管理通过手工编辑 config）
- 不涉及跨渠道身份关联
