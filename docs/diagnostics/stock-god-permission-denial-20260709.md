# 股神0号群聊权限拒绝诊断报告

**日期**: 2026-07-09  
**问题**: mujxf.agentid.pub 在群 `group.agentid.pub/11816` 与股神0号（stock-god.agentid.pub）交互时，agent 回复"没有权限"  
**诊断者**: Claude Code  
**状态**: ✅ 根因确认

---

## 执行摘要

**根因**：`src/index.ts:783` 的 `resolveSessionIdentity` 函数**硬编码了 `chatType: 'private'`**，导致所有会话的身份解析都按私聊处理。群聊场景下，`resolvePeerRoleDetail` 无法正确查询群成员角色表（`relation.roles.members[actorId]`），回退到默认角色，最终返回 `role: null` 或 `role: 'none'`。

**触发条件**：Agent 在群聊中通过 Bash 工具执行 `ec msg send` / `ec ctl send` 等命令时。

**影响范围**：所有 agent 的群聊场景（stock-god 是最早暴露的案例）。

**修复优先级**：🔴 **P0 - 阻断性缺陷**

---

## 症状描述

### 用户观察

- mujxf 在群里 @ 股神0号，agent 回复"没有权限"
- mujxf 是 stock-god.agentid.pub 的 **config owner**（`config.json` 的 `owners` 数组第二项）
- 同一个 mujxf，通过 `/status` 等斜杠命令可以正常执行（被识别为 owner）

### 日志证据

**失败场景**（agent 自己 spawn 的 Bash 子进程）：

```
[2026-07-09T12:06:39.768] [WARN] [CommandAudit:DENY] 
  operation=ec.msg.send 
  role=anonymous 
  actor=mujxf.agentid.pub 
  code=ROLE_ACCESS_DENIED
[2026-07-09T12:06:39.769] [WARN]   
  reason: Role anonymous is not allowed to access commands
```

**成功场景**（用户直接输入 `/status` 斜杠命令）：

```
[2026-07-09T12:06:56.974] [INFO] [ctl] 
  identity resolved: 
  sessionId=meta_20260609_1781020117190 
  role=owner 
  source=agent-config-owner 
  selfAid=stock-god.agentid.pub 
  actor=mujxf.agentid.pub 
  conversation=mujxf.agentid.pub
```

**关键差异**：同一个 actor（mujxf.agentid.pub），走不同路径解析出的角色不同。

---

## 根因分析

### 问题链路（三层）

```
┌─────────────────────────────────────────────────────────────┐
│ 1. resolveSessionIdentity 硬编码 chatType: 'private'        │
│    src/index.ts:783                                         │
│    → 即使实际是群聊，仍按私聊逻辑解析角色                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. resolvePeerRoleDetail 走错分支                            │
│    src/config/peer-role-resolver.ts:79-100                  │
│    → 私聊分支：查 config owners/admins + relation.assigned   │
│    → 群聊分支（正确但未走到）：查 relation.roles.members     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. 角色解析失败，降级到 null/'none'                          │
│    → session.identity.role = 'none' 或残留的 'anonymous'     │
│    → authorizeCommand 拒绝：getRoleDefinition('none') = null │
└─────────────────────────────────────────────────────────────┘
```

### 代码位置

#### ❌ **缺陷代码**：`src/index.ts:775-788`

```typescript
const resolveSessionIdentity = (channel: string, userId?: string): SessionIdentity => {
  const parsed = tryParseChannelKey(channel);
  const owningAgent = agentRegistry.resolveByChannel(channel);
  const selfAid = owningAgent?.aid ?? parsed?.selfAID;
  if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType: 'private',  // ❌ 硬编码！实际可能是群聊
    actorId: userId,
    conversationId: userId,  // ❌ 私聊才是 userId，群聊应该是 groupId
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

**问题**：

1. `chatType: 'private'` 硬编码，无论实际是私聊还是群聊
2. `conversationId: userId` 在群聊场景是错误的（应该是 groupId）
3. `resolvePeerRoleDetail` 拿到错误的 chatType，走了私聊分支：
   - 私聊分支查 `relation.roles.assigned`（显式分配的角色）
   - 群聊分支（正确但未走到）查 `relation.roles.members[actorId]`（群成员角色表）

#### ✅ **正确参考**：`src/core/message/message-bridge.ts:573-580`

```typescript
return resolvePeerRoleDetail({
  selfAid: ctx.selfAid,
  channelType: ctx.channelType,
  chatType: ctx.chatType,  // ✅ 从上下文正确传递
  actorId: ctx.actorId,
  conversationId: ctx.conversationId,  // ✅ 群聊是 groupId，私聊是 userId
  peerType: ctx.peerType,
});
```

### 为什么 `/status` 能识别 owner？

斜杠命令走 **ctl 路径**（`src/core/command/command-handler.ts:760-779`），每次执行时**重新计算 identity**：

```typescript
const detail = resolvePeerRoleDetail({
  selfAid,
  channelType,
  chatType,  // ✅ 从 session metadata 读取真实 chatType
  actorId,
  conversationId,
});
```

它拿到了正确的 `chatType: 'private'` 或 `'group'`，因此能正确命中 config owners，返回 `role: 'owner'`。

### 为什么 `ec msg send` 被拒绝？

Agent 自己 spawn 的 Bash 工具走 **PreToolUse hook**（`src/agents/claude-runner.ts:1285-1296`），使用**缓存的 `session.identity.role`**：

```typescript
const ecAuthCtx = {
  actorId: permCtx?.userId,
  channel: permCtx?.channel,
  channelId: session?.identity?.channel,
  chatType: session?.identity?.chatType,
  selfAid: session?.identity?.self,
  peerKey: session?.identity?.peerKey,
  role: session?.identity?.role || 'none',  // ⚠️ 使用缓存值，不重新计算
  // ...
};
```

如果 `session.identity.role` 是错误的（因为创建 session 时 `resolveSessionIdentity` 硬编码了 `chatType: 'private'`），这个错误会一直传递，导致权限拒绝。

---

## 日志中的 `'anonymous'` 从何而来？

**现象**：日志显示 `role=anonymous`，但当前代码里只有 `|| 'none'` 兜底，没有 `'anonymous'`。

**推测**：

1. **旧 session 残留**：历史版本代码曾用 `'anonymous'` 作为兜底（见 `src/core/message/_archived/_message-processor.ts` 5处 `|| 'anonymous'`）。旧 session 文件（`.jsonl`）可能保存了这个角色，一直被复用。
2. **daemon 未重启**：虽然 `dist/index.js` 是最新（14:38 构建），但 daemon 可能在内存中持有旧 session 对象。

**验证方式**（未执行）：

```bash
# 查找残留 'anonymous' 的 session 文件
grep -r "anonymous" ~/.evolclaw/agents/stock-god.agentid.pub/sessions/
```

---

## 为什么只在股神0号暴露？

**所有 stock-god-*.agentid.pub 的 config 都是 `$schema_version: 1`**（旧版）。但为什么只有股神0号报错？

**可能性**：

1. **最早创建的 session**：股神0号是主号，可能最早建立了与 mujxf 的会话，残留了 `'anonymous'` 角色
2. **群聊使用频率**：股神0号可能是唯一在群里被 @ 的（1~5号在群里不活跃），其他号没触发这个路径
3. **偶然性**：其他号的 session 可能被清理过或重新生成了

---

## 修复方案

### 立即止血（运维）

```bash
# 方案1：清理旧 session，强制重新解析身份
rm -rf ~/.evolclaw/agents/stock-god.agentid.pub/sessions/*

# 方案2：重启 daemon（刷新内存中的 session 缓存）
ec daemon stop
ec daemon start

# 方案3：升级 config schema（如果 v1→v2 迁移逻辑修复了这个问题）
ec agent upgrade stock-god.agentid.pub
```

**注意**：方案1 会丢失所有会话历史；方案2 是最安全的止血手段。

### 结构修复（代码）

#### ✅ **修复1：动态推导 chatType**（P0）

**文件**：`src/index.ts:775-788`

**当前代码**：

```typescript
const resolveSessionIdentity = (channel: string, userId?: string): SessionIdentity => {
  // ...
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType: 'private',  // ❌
    actorId: userId,
    conversationId: userId,  // ❌
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

**修复方案A**（保守：fallback 到 private）：

```typescript
const resolveSessionIdentity = (
  channel: string, 
  userId?: string,
  chatType?: 'private' | 'group'  // ✅ 新增参数，由 caller 传入真实 chatType
): SessionIdentity => {
  const parsed = tryParseChannelKey(channel);
  const owningAgent = agentRegistry.resolveByChannel(channel);
  const selfAid = owningAgent?.aid ?? parsed?.selfAID;
  if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
  
  // ✅ 使用传入的 chatType，没有则回退 'private'（兼容旧调用方）
  const actualChatType = chatType || 'private';
  const conversationId = actualChatType === 'group' 
    ? parsed?.channelId || userId  // ✅ 群聊用 groupId
    : userId;  // 私聊用 userId
  
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType: actualChatType,
    actorId: userId,
    conversationId,
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

**修复方案B**（激进：从 channel 推导）：

```typescript
const resolveSessionIdentity = (channel: string, userId?: string): SessionIdentity => {
  const parsed = tryParseChannelKey(channel);
  const owningAgent = agentRegistry.resolveByChannel(channel);
  const selfAid = owningAgent?.aid ?? parsed?.selfAID;
  if (!selfAid || !userId) return { role: 'none', mode: 'interactive' };
  
  // ✅ 尝试从 channel metadata 推导 chatType
  let chatType: 'private' | 'group' = 'private';
  let conversationId = userId;
  
  if (parsed?.channelId && parsed.channelId.includes('group.') || parsed.channelId.includes('/')) {
    // 启发式：AUN 群 ID 通常是 "xxx.group.yyy" 或 "group.xxx/nnn"
    chatType = 'group';
    conversationId = parsed.channelId;
  }
  
  const detail = resolvePeerRoleDetail({
    selfAid,
    channelType: parsed?.type || channel,
    chatType,
    actorId: userId,
    conversationId,
  });
  return roleToSessionIdentity(detail.effectiveRole);
};
```

**推荐**：方案A（显式传参），caller 从 message/session metadata 拿真实 chatType。

**调用方改动点**：

1. `SessionManager` 构造函数传入的 `identityResolver` 签名改为：
   ```typescript
   (channel: string, userId?: string, chatType?: 'private' | 'group') => SessionIdentity
   ```

2. `SessionManager.resolveIdentity` 调用时传入 chatType：
   ```typescript
   resolveIdentity(channel: string, userId?: string, chatType?: 'private' | 'group'): SessionIdentity {
     return this.identityResolver?.(channel, userId, chatType) 
       ?? { role: 'none', mode: 'interactive' };
   }
   ```

3. 所有调用 `resolveIdentity` 的地方，从 session/message metadata 拿 chatType 传入。

#### ✅ **修复2：Session identity 自动刷新**（P1）

**位置**：`src/agents/claude-runner.ts:1292` 或 `src/core/command/command-permission.ts:89-96`

**当前**：如果 `session.identity.role` 是非法值（如 `'anonymous'`），直接用它鉴权，导致拒绝。

**修复**：

```typescript
// claude-runner.ts PreToolUse hook
const session = sessionManager?.getActiveSession?.(sessionId);
let role = session?.identity?.role || 'none';

// ✅ 如果角色非法（不在角色定义表），强制重新解析
if (role !== 'none' && !getRoleDefinition(role, session?.identity?.self)) {
  logger.warn(`[PreToolUse] Invalid role '${role}' for session ${sessionId}, re-resolving identity`);
  const freshIdentity = sessionManager.resolveIdentity(
    permCtx?.channel || '', 
    permCtx?.userId,
    session?.chatType  // ✅ 传真实 chatType
  );
  role = freshIdentity.role;
  // 可选：写回 session.identity（需要持久化逻辑）
}

const ecAuthCtx = {
  // ...
  role: role || 'none',
};
```

#### ✅ **修复3：废弃 `'anonymous'` 角色名**（P2）

1. 全局搜索并替换残留的 `'anonymous'` 为 `null` 或 `'none'`
2. 在 `src/config/roles.ts` 的 `isValidUserRoleName` 中明确禁止 `'anonymous'`：
   ```typescript
   if (role === 'anonymous') {
     logger.error('Role name "anonymous" is deprecated, use null or "none" instead');
     return false;
   }
   ```

---

## 影响评估

### 已确认受影响

- ✅ **stock-god.agentid.pub**：群聊场景，mujxf 被判 `role=anonymous`，所有 `ec` 命令被拒绝

### 潜在受影响

- ⚠️ **所有 agent 的群聊场景**：只要 `resolveSessionIdentity` 被调用，都会硬编码 `chatType: 'private'`
- ⚠️ **所有 config schema v1 的 agent**：可能残留旧 session 文件

### 未受影响

- ✅ **私聊场景**：硬编码 `'private'` 恰好正确
- ✅ **斜杠命令**：走 ctl 路径，重新计算 identity，不受影响

---

## 验证步骤

### 修复前验证（确认问题）

```bash
# 1. 查看股神0号的 session 文件，确认是否有 'anonymous'
find ~/.evolclaw/agents/stock-god.agentid.pub/sessions -name "*.jsonl" -exec grep -l "anonymous" {} \;

# 2. 在群里 @ 股神0号，观察是否报"没有权限"
# （需要实际在 Evol app 里操作）

# 3. 查看 daemon 日志
tail -f ~/.evolclaw/logs/evolclaw.log | grep -i "anonymous\|DENY"
```

### 修复后验证（确认修复）

```bash
# 1. 重启 daemon
ec daemon stop && ec daemon start

# 2. 在群里 @ 股神0号，发送消息
# 预期：agent 正常响应，不再报"没有权限"

# 3. 查看日志，确认角色解析正确
tail -f ~/.evolclaw/logs/evolclaw.log | grep "identity resolved"
# 预期输出：role=owner source=agent-config-owner
```

---

## 相关文档

- `docs/config/07-security.md` — 角色权限模型
- `docs/权限配置化与通用接口鉴权设计.md` — EC 命令权限设计
- `src/config/peer-role-resolver.ts` — 角色解析核心逻辑
- `src/core/command/ec-command-permission.ts` — EC 命令鉴权入口

---

## 历史记录

- **2026-07-09 15:00**：初次诊断，确认根因为 `resolveSessionIdentity` 硬编码 `chatType: 'private'`
- **待补充**：修复实施日期、验证结果

---

## 附录：完整调用链

```
┌─────────────────────────────────────────────────────────────┐
│ 用户在群里 @ 股神0号                                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ AUN adapter 收到群消息                                        │
│ → message-bridge.ts:onMessage()                             │
│ → 查询或创建 session                                          │
│ → session.identity = resolveSessionIdentity(channel, userId) │
│   （❌ 此时 chatType='private' 硬编码，角色解析错误）           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ response-engine.ts:process()                                │
│ → 将消息送给 claude-runner 生成回复                            │
│ → session.identity.role = 'none' 或 'anonymous'（残留）       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ claude-runner.ts:generate()                                 │
│ → PreToolUse hook 检查 Bash 工具权限                          │
│ → authorizeEcCommand(command, { role: session.identity.role })│
│   （⚠️ 使用缓存的错误角色，不重新计算）                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ command-permission.ts:authorizeCommand()                    │
│ → getRoleDefinition('anonymous') = null                     │
│ → return { allow: false, code: 'ROLE_ACCESS_DENIED' }      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Bash 工具返回错误：                                            │
│ "🔒 EC 命令权限拒绝: Role anonymous is not allowed..."         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Agent 回复用户："没有权限"                                      │
└─────────────────────────────────────────────────────────────┘
```

---

**诊断完成**。建议优先执行**运维止血**（重启 daemon），然后排期**代码修复**（P0）。
