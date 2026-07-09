# 群聊 Owner 权限拒绝问题 — 诊断与修复报告

**日期**: 2026-07-09
**问题级别**: 🔴 P0（阻断性缺陷）
**状态**: ✅ 已修复并验证

---

## 一、问题描述

### 现象

- 用户 `mujxf.agentid.pub` 是股神0号（`stock-god.agentid.pub`）的 **config owner**（`config.json` 的 `owners` 数组成员）。
- 在**群聊**（`group.agentid.pub/11816`）中 @ 股神0号时，agent 回复"没有权限"。
- 同一个用户在**私聊**中一切正常。
- 同一个用户在群里执行 `/status` 等**斜杠命令**也能被正确识别为 owner。

### 日志证据

**失败场景**（agent 自己 spawn 的 Bash 子进程执行 `ec msg send`）：

```
[WARN] [CommandAudit:DENY]
  operation=ec.msg.send
  role=anonymous
  actor=mujxf.agentid.pub
  code=ROLE_ACCESS_DENIED
  reason: Role anonymous is not allowed to access commands
```

**成功场景**（用户直接输入 `/status` 斜杠命令）：

```
[INFO] [ctl] identity resolved:
  role=owner
  source=agent-config-owner
  selfAid=stock-god.agentid.pub
  actor=mujxf.agentid.pub
```

**关键差异**：同一个 actor，走不同路径解析出的角色不同。

---

## 二、根因分析

### 核心缺陷

`src/index.ts` 的 `resolveSessionIdentity` 闭包**硬编码了 `chatType: 'private'`**：

```typescript
// ❌ 修复前
const resolveSessionIdentity = (channel: string, userId?: string): SessionIdentity => {
  const parsed = tryParseChannelKey(channel);
  const owningAgent = agentRegistry.resolveByChannel(channel);
  const selfAid = owningAgent?.aid ?? parsed?.selfAID;
  if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType: 'private',    // ❌ 硬编码，即使实际是群聊
    actorId: userId,
    conversationId: userId, // ❌ 群聊场景应为 groupId
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

`resolveSessionIdentity` 的函数签名只有 `(channel, userId)`，**在传参层就丢失了 chatType 和 groupId 信息**，只能在内部硬编码成私聊语义。

### 为什么私聊正常、群聊出错？

角色解析函数 `resolvePeerRoleDetail`（`src/config/peer-role-resolver.ts`）本身是**正确的**：owner/admin 检查在最前面，之后按 `chatType` 分支查询群成员角色表。

问题在于**传给它的 `chatType` 是错的**：

| 场景 | 传入 chatType | conversationId | 结果 |
|------|--------------|----------------|------|
| 私聊 | `'private'` ✅ 恰好正确 | `userId` ✅ | 正确解析 owner |
| 群聊 | `'private'` ❌ 应为 `'group'` | `userId` ❌ 应为 `groupId` | 走错分支，回退到 `null`/`'none'` |

### 为什么斜杠命令能识别 owner？

斜杠命令走 **ctl 路径**（`command-handler.ts` 的 `resolveCtlIdentity`），每次执行时**从 session metadata 重新读取真实 chatType** 并重新计算 identity，因此不受此 bug 影响。

### 为什么 agent 执行 `ec` 命令被拒绝？

Agent 自己 spawn 的 Bash 工具走 **PreToolUse hook**（`claude-runner.ts`），使用**缓存的 `session.identity.role`**：

```typescript
const ecAuthCtx = {
  // ...
  role: session?.identity?.role || 'none',  // ⚠️ 使用缓存值，不重新计算
};
```

如果创建 session 时 `resolveSessionIdentity` 解析出了错误的角色，这个错误会一直缓存在 session 生命周期内。

### 完整问题链路

```
用户在群里 @ agent
        ↓
session 创建/复用时走 resolveIdentity fallback
        ↓
resolveSessionIdentity 硬编码 chatType='private'  ❌
        ↓
resolvePeerRoleDetail 走错分支，返回 null/'none'
        ↓
session.identity.role 被缓存为错误值
        ↓
agent 执行 ec 命令 → PreToolUse hook 用缓存的错误 role
        ↓
authorizeCommand 拒绝：ROLE_ACCESS_DENIED
        ↓
agent 回复"没有权限"
```

> **补充说明**：日志里的 `role=anonymous` 来自历史版本残留的旧 session 文件（当前活跃代码只用 `'none'` 兜底，`'anonymous'` 仅存在于 `src/core/message/_archived/` 死代码中）。

---

## 三、修复方案

### 核心思路

把 `chatType` 和 `conversationId` **贯穿整条 `IdentityResolver` 调用链**，让每个解析身份的路径都能拿到真实的会话上下文，不再依赖私聊默认值。

### 改动清单（5 个文件）

#### 1. `src/core/session/session-manager.ts` — 拓宽类型与方法签名

```typescript
// 类型定义新增 chatType / conversationId
export type IdentityResolver = (
  channel: string,
  userId?: string,
  chatType?: 'private' | 'group',
  conversationId?: string,
) => SessionIdentity;

// resolveIdentity 方法同步拓宽
resolveIdentity(
  channel: string,
  userId?: string,
  chatType?: 'private' | 'group',
  conversationId?: string,
): SessionIdentity {
  return this.identityResolver?.(channel, userId, chatType, conversationId)
    ?? { role: 'none', mode: 'interactive' };
}
```

`getOrCreateSession` 内部 4 处 fallback 调用统一计算 conversationId：

```typescript
// 群聊用 groupId，私聊用 userId
const identityConversationId = chatType === 'group'
  ? (metadata?.groupId || channelId)
  : userId;
// ...
session.identity = identity ?? this.resolveIdentity(channel, userId, chatType, identityConversationId);
```

#### 2. `src/index.ts` — 修复闭包（核心）

```typescript
// ✅ 修复后
const resolveSessionIdentity = (
  channel: string,
  userId?: string,
  chatType?: 'private' | 'group',
  conversationId?: string,
): SessionIdentity => {
  const parsed = tryParseChannelKey(channel);
  const owningAgent = agentRegistry.resolveByChannel(channel);
  const selfAid = owningAgent?.aid ?? parsed?.selfAID;
  if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
  const actualChatType = chatType || 'private';
  const actualConversationId = actualChatType === 'group'
    ? (conversationId || userId)  // 群聊按群 ID 命中群成员角色表
    : userId;
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType: actualChatType,
    actorId: userId,
    conversationId: actualConversationId,
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

#### 3. `src/core/command/command-handler.ts` — ctl fallback 分支

fallback 调用传入 `session.chatType` 与 `conversationId`：

```typescript
const fallback = session.identity
  ?? this.sessionManager.resolveIdentity(session.channel, userId, chatType, conversationId ?? undefined);
```

#### 4. `src/core/command/slash-handler.ts` — 斜杠命令入口

从函数参数收窄 chatType 后传入：

```typescript
const narrowedChatType = chatType === 'group' ? 'group' : chatType === 'private' ? 'private' : undefined;
const identityConversationId = narrowedChatType === 'group' ? channelId : userId;
const identity = overrideIdentity
  ?? this.sessionManager.resolveIdentity(channel, userId, narrowedChatType, identityConversationId);
```

#### 5. `src/core/command/menu-handler.ts` — 菜单 UI（13 处调用）

新增辅助函数统一从 session 推导群上下文，避免重复：

```typescript
function menuIdentityArgs(session: Session | null | undefined): readonly [('private' | 'group')?, string?] {
  if (!session) return [];
  const chatType = session.chatType === 'group' ? 'group'
    : session.chatType === 'private' ? 'private' : undefined;
  const conversationId = chatType === 'group'
    ? (session.metadata?.groupId || session.channelId)
    : session.metadata?.peerId;
  return [chatType, conversationId];
}

// 13 个调用点统一改为：
const identity = overrideIdentity
  ?? this.sessionManager.resolveIdentity(channel, userId, ...menuIdentityArgs(session));
```

### 设计要点

- **向后兼容**：新增参数均为可选，缺省回退到私聊语义，不影响未改造的调用方。
- **单一数据源**：conversationId 的推导逻辑（群聊 `groupId`、私聊 `userId`）在每个调用点保持一致，与 `message-bridge.ts` 入站路径的既有正确实现对齐。

---

## 四、验证结果

| 验证项 | 结果 |
|--------|------|
| `npm run build`（tsc 类型检查） | ✅ 通过，无类型错误 |
| `vitest run` 单元测试 | ✅ 906 passed |
| 失败用例（5 个） | ⚠️ 与本次改动**无关**，干净基线（`git stash`）上同样失败，为既有问题 |

**既有失败用例**（非本次引入）：
- `tests/integration/observer-insert-runtime.test.ts`（3）— observer 提示注入
- `tests/unit/codex-runner-alignment.test.ts`（1）— codex approval bridge
- `tests/unit/config-manager.test.ts`（1）— `show_activities` schema

---

## 五、上线建议

### 运维止血（立即执行）

重启 daemon，清除内存中已缓存错误 identity 的旧 session：

```bash
ec daemon stop
ec daemon start
```

### 验证修复效果

```bash
# 在群里 @ agent 发消息，预期正常响应，不再报"没有权限"
# 查看日志确认角色解析正确：
tail -f ~/.evolclaw/logs/evolclaw.log | grep "identity resolved"
# 预期：role=owner source=agent-config-owner
```

---

## 六、后续可选增强（未实施）

| 优先级 | 项目 | 说明 |
|--------|------|------|
| P1 | Session identity 自动刷新 | 检测到 `session.identity.role` 为非法值（不在角色定义表）时强制重新解析，防御历史残留的旧 session 文件 |
| P2 | 废弃 `'anonymous'` 角色名 | 当前仅存在于 `_archived/` 死代码，活跃代码已用 `'none'` 兜底；P0 修复后正常路径不再产生错误角色 |
| P3 | 更新 `ROLE_ACCESS_CONTROL.md` | 该文档描述的是旧版 guest/anonymous 模型，已与当前实现脱节 |

---

## 附：相关文件索引

| 文件 | 作用 |
|------|------|
| `src/index.ts` | `resolveSessionIdentity` 闭包（缺陷源头） |
| `src/core/session/session-manager.ts` | `IdentityResolver` 类型 + `resolveIdentity` + `getOrCreateSession` |
| `src/config/peer-role-resolver.ts` | `resolvePeerRoleDetail` 角色解析核心逻辑（本身正确） |
| `src/core/command/command-handler.ts` | ctl 路径 identity 重解析 |
| `src/core/command/slash-handler.ts` | 斜杠命令入口 |
| `src/core/command/menu-handler.ts` | 菜单 UI 角色过滤（13 处） |
| `src/core/message/message-bridge.ts` | 入站消息路径（既有正确实现，参考基准） |
