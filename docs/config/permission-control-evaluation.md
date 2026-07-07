# 权限控制方案评估（正确版）

执行时间：2026-07-07

## ✅ 结论先行

**你的方案完全正确且可行！** 而且核心机制**已经实现**了！

我之前的分析错误地认为"Bash 工具不可拦截"，实际上 Claude Code 有完整的 **PreToolUse Hook** 机制，你已经在用它做 read/write 权限控制。

---

## 📋 三种执行场景（全部可行）

### ✅ 场景 1：主机直接执行
```bash
$ ec config set owners [...] --self bot.aid.pub
✓ 允许（无 EVOLCLAW_SESSION_ID = 主机权限）
```
**状态**：已实现（`src/cli/config.ts:40-42`）

### ✅ 场景 2：Menu exec 执行
```
AUN 消息 → 已知对端 AID → 授权检查 → 执行
```
**状态**：已实现（`src/core/command/menu-handler.ts:2113-2206`）

### ✅ 场景 3：Agent 调用（PreToolUse Hook）
```
Agent 调用 Bash → PreToolUse Hook 拦截 → 获取对端身份 → 权限判断
```
**状态**：机制已实现，ec send/file 命令已接入，**config 命令待接入**

---

## 🔍 PreToolUse Hook 机制详解

### Hook 注册
**位置**：`src/agents/claude-runner.ts:1535`
```typescript
PreToolUse: [{ matcher: '.*', hooks: [preToolUseHook] }]
```
- ✅ `matcher: '.*'` 匹配所有工具
- ✅ 在工具执行前调用
- ✅ 返回 `{ decision: 'block', reason }` 可拒绝

### Hook 中可获取的完整上下文
**位置**：`src/agents/claude-runner.ts:1280-1294`
```typescript
if (input.tool_name === 'Bash') {
  const command = input.tool_input?.command;
  const permCtx = this.permissionContexts.get(sessionId);
  const session = sessionManager?.getActiveSession?.(sessionId);
  
  const ecAuthCtx = {
    actorId: permCtx?.userId,              // ✅ 对端 ID
    channel: permCtx?.channel,             // ✅ 渠道
    channelId: session?.identity?.channel,
    chatType: session?.identity?.chatType, // ✅ private/group
    selfAid: session?.identity?.self,      // ✅ 自己的 AID
    peerKey: session?.identity?.peerKey,   // ✅ 对端 Key
    role: session?.identity?.role,         // ✅ 对端角色！
    isDaemonOwner: false,
    fromControlChannel: ...,
  };
}
```

**关键**：Hook 中**已经可以拿到对端的 role**（owner/admin/guest）！

---

## 🎯 群聊批次权限一致性（已解决！）

### 你的担忧
> 如果是群，因为消息是成批处理的，这就要求一个批次的消息他的对端必须是相同权限的发言人。

### 已实现的解决方案

**位置**：`src/core/message/message-queue.ts:327-338`

```typescript
// commonRole：批次中所有消息的共同角色
private commonRole(items): SessionIdentity['role'] | undefined {
  let role: SessionIdentity['role'] | undefined;
  for (const item of items) {
    if (!item.role) return undefined;      // 有未知角色 → 返回 undefined
    if (!role) {
      role = item.role;
    } else if (role !== item.role) {
      return undefined;                     // 角色不一致 → 返回 undefined！
    }
  }
  return role;  // 所有消息角色相同 → 返回该角色
}
```

**这正是你要的逻辑**：
- ✅ 批次内所有消息**角色相同** → 返回该角色（`batchRole`）
- ✅ 批次内角色**不一致** → 返回 `undefined`（无共同角色）

### batchRole 的传递
**位置**：`src/core/message/message-queue.ts:656-657`
```typescript
const batchRole = this.commonRole(rawItems);
if (batchRole && !merged.message.batchRole) {
  merged.message.batchRole = batchRole;  // 写入消息
}
```

**日志记录**：`message-queue.ts:680`
```typescript
logger.info(`[Queue] processing batch: ... batchRole=${merged.message.batchRole ?? '<mixed>'} ...`);
// batchRole 为 undefined 时显示 <mixed>（混合角色）
```

---

## 📊 权限模型层级

### 角色等级（message-queue.ts:311-318）
```typescript
const rank = {
  anonymous: 0,
  guest: 1,
  member: 2,
  admin: 3,
  owner: 4,
};
```

### 两种角色计算策略

| 策略 | 逻辑 | 用途 |
|------|------|------|
| `commonRole` | 全部相同才返回，否则 undefined | **权限判断**（保守，防提升） |
| `highestRole` | 返回最高等级 | 显示/日志 |

**权限判断用 commonRole**：确保批次内所有发言人权限一致，防止低权限用户"搭便车"。

---

## ✅ 已实现的 ec 命令权限控制

### 当前已接入的命令
**位置**：`src/core/command/ec-command-permission.ts`

```typescript
// 已覆盖：ec msg send / ec group send / ec ctl send|file
export function authorizeEcCommand(command, ctx) {
  const parsed = parseEvolclawSendCommand(command);
  if (!parsed) return null;  // 非 send/file 命令，跳过
  
  const operation = `ec.${parsed.scope}.${parsed.action}`;
  const decision = authorizeCommand({
    ...ctx,
    intent: { operation, scope, ... }
  });
  
  // 审计日志
  auditCommandAuthorization({ ... });
  
  return decision;
}
```

**范围说明**（代码注释）：
> 仅覆盖 send / file 两个写操作（ec msg / ec group / ec ctl）。
> ec ctl status / ec ctl queue 等只读命令暂不纳入。

---

## 🔧 config 命令接入方案

### 现状
- ✅ PreToolUse Hook 机制完备
- ✅ 对端身份/角色可获取
- ✅ 群聊 batchRole 已实现
- ✅ ec send/file 命令已接入
- ❌ **ec config 命令未接入 Hook 权限控制**

### 需要做的：接入 ec config 到 Hook

#### Step 1: 扩展命令识别
**位置**：`src/core/permission.ts` 的 `parseEvolclawSendCommand`

添加对 `ec config set/unset` 的识别：
```typescript
// 现有：识别 ec msg send / ec group send / ec ctl send
// 新增：识别 ec config set/unset
export function parseEvolclawConfigCommand(command: string): EvolclawConfigCommand | null {
  // 匹配 ec config set <field> <value> --self <aid> [--peer <key>]
  const match = command.match(/^ec\s+config\s+(set|unset)\s+(\S+)/);
  if (!match) return null;
  
  return {
    action: match[1],  // 'set' | 'unset'
    field: match[2],   // 字段路径
    // ... 解析 --self, --peer 等
  };
}
```

#### Step 2: 添加 config 操作的权限判断
**位置**：新建或扩展 `ec-command-permission.ts`

```typescript
export function authorizeEcConfigCommand(
  command: string,
  ctx: EcCommandAuthorizationContext
): CommandAuthorizationDecision | null {
  const parsed = parseEvolclawConfigCommand(command);
  if (!parsed) return null;
  
  // 字段级权限判断
  const fieldPermission = getFieldPermission(parsed.field);
  
  // 基础设施字段：只有 owner 能改
  if (fieldPermission === 'infrastructure') {
    if (ctx.role !== 'owner') {
      return {
        allow: false,
        code: 'FORBIDDEN_INFRASTRUCTURE',
        reason: `字段 ${parsed.field} 是基础设施配置，仅 owner 可修改`
      };
    }
  }
  
  // 运行时配置字段：owner 和 admin 能改
  if (fieldPermission === 'runtime') {
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return {
        allow: false,
        code: 'FORBIDDEN_RUNTIME',
        reason: `字段 ${parsed.field} 需要 admin 以上权限`
      };
    }
  }
  
  return { allow: true };
}
```

#### Step 3: 在 PreToolUse Hook 中调用
**位置**：`src/agents/claude-runner.ts:1295` 附近

```typescript
if (input.tool_name === 'Bash') {
  const command = input.tool_input?.command;
  
  // 现有：ec send/file 权限
  const ecDecision = authorizeEcCommand(command, ecAuthCtx);
  if (ecDecision) {
    if (!ecDecision.allow) return { decision: 'block', reason: ecDecision.reason };
    return {};
  }
  
  // 新增：ec config 权限
  const configDecision = authorizeEcConfigCommand(command, ecAuthCtx);
  if (configDecision) {
    if (!configDecision.allow) return { decision: 'block', reason: configDecision.reason };
    return {};
  }
}
```

#### Step 4: 定义字段权限分类
**位置**：新建 `src/config/field-permissions.ts`

```typescript
export type FieldPermissionLevel = 'infrastructure' | 'runtime';

const INFRASTRUCTURE_FIELDS = new Set([
  'aid', 'enabled', 'channels', 'owners', 'admins',
  'projects', 'aun', 'lifecycle', 'observable', 'capabilities'
]);

const RUNTIME_FIELDS = new Set([
  'active_baseagent', 'baseagents', 'chatmode', 'show_activities',
  'dispatch', 'flush_delay', 'debounce', 'proactive',
  'render', 'enable_rich_content', 'permissionMode'
]);

export function getFieldPermission(fieldPath: string): FieldPermissionLevel {
  const topField = fieldPath.split('.')[0];
  if (INFRASTRUCTURE_FIELDS.has(topField)) return 'infrastructure';
  return 'runtime';  // 默认运行时（更宽松）
}
```

---

## 🎯 完整权限矩阵

### 私聊场景

| 字段类型 | owner | admin | guest | 示例 |
|---------|-------|-------|-------|------|
| 基础设施 | ✅ | ❌ | ❌ | owners, channels, enabled |
| 运行时 | ✅ | ✅ | ❌ | chatmode, active_baseagent |

### 群聊场景（使用 batchRole）

| batchRole | 基础设施 | 运行时 | 说明 |
|-----------|---------|--------|------|
| owner（全员owner） | ✅ | ✅ | 批次全是 owner |
| admin（全员admin） | ❌ | ✅ | 批次全是 admin |
| guest（全员guest） | ❌ | ❌ | 批次全是 guest |
| undefined（混合） | ❌ | ❌ | **角色不一致，全部拒绝** |

**关键**：群聊中如果批次角色不一致（`batchRole === undefined`），保守拒绝所有配置修改。

---

## 📝 实施清单

### 已完成 ✅
- [x] PreToolUse Hook 机制
- [x] 对端身份/角色获取
- [x] 群聊 batchRole 计算（commonRole）
- [x] ec send/file 命令权限控制

### 待实现 ⏳
- [ ] `parseEvolclawConfigCommand` - 识别 ec config 命令
- [ ] `field-permissions.ts` - 字段权限分类
- [ ] `authorizeEcConfigCommand` - config 权限判断
- [ ] 在 PreToolUse Hook 中接入 config 权限
- [ ] 移除旧的 `EVOLCLAW_SESSION_ID` 一刀切逻辑（cli/config.ts:88-92）
- [ ] 测试各种角色和场景

---

## 💡 关键洞察

### 你的方案完全正确
1. ✅ **PreToolUse Hook 可以拦截** - 已在用于 read/write 控制
2. ✅ **可以获取对端 AID 和角色** - session.identity.role
3. ✅ **群聊批次权限一致性** - commonRole 已实现

### 现有架构的优雅之处
1. **batchRole 机制**：自动处理群聊批次的权限一致性
2. **commonRole vs highestRole**：权限用保守的 commonRole，防止权限提升
3. **统一授权核心**：authorizeCommand() 可复用于所有命令类型

### 只需补齐最后一块
将 `ec config` 命令接入现有的 PreToolUse Hook 权限体系，复用已有的：
- 命令解析框架
- 授权核心（authorizeCommand）
- 审计日志（auditCommandAuthorization）
- batchRole 群聊处理

---

## 🚀 总结

**你的方案**：✅ 完全正确、完全可行

**实现难度**：⭐⭐ 中等（主要是接入工作，核心机制已就绪）

**关键优势**：
- 复用现有 PreToolUse Hook
- 复用现有授权核心
- 复用现有 batchRole 机制
- 只需添加 config 命令的识别和字段权限分类

**下一步**：将 ec config 命令接入 PreToolUse Hook，实现字段级权限控制。

需要我帮你实现这个接入吗？
