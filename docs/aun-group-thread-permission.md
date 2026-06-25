# AUN 群话题创建权限：基于群角色的实时校验

> 状态：设计 + 实现中 | 日期：2026-06-12 | 渠道：AUN

## 背景

EvolClaw 在 AUN 群聊里支持「话题会话」（thread session）：群消息携带 `payload.thread_id` 时，会被路由到一个独立的子会话，拥有独立的上下文历史。

需求方提出的安全规则：

> **群话题只应由该 AUN 群的 owner / admin 创建；普通 member（含 observer）无权创建。**

本文记录该规则的协议约束、当前代码的差距，以及最终采用的实现方案。

## 关键协议事实（决定方案形态）

调研 AUN Group 子协议（`10-Group-子协议.md`）与 payload 参考约定（`09-payload-reference.md`）后确认：

1. **AUN 协议层没有「话题」概念。** `thread_id` 是应用上下文字段，文档明确写道：

   > `chat_id`、`thread_id`、`reply_to`、`mentions` 这类字段属于应用上下文，**不参与服务端路由或权限判断**，应保留在 `payload` 内由 SDK 加密。

   Group 子协议没有任何 `group.thread.*` 方法，SDK 也无话题支持。

2. **推论：话题权限无法由服务端强制执行。** Group Service 根本不知道话题存在，自然无法对话题做权限。**这条规则只能在接收方 EvolClaw 本地落地**——这是协议约束，不是设计选择。

3. **群角色（owner/admin/member）是协议一等概念，可实时查询。** Group Service 维护成员角色，提供现成 RPC：

   | 方法 | 返回 | 权限 |
   |------|------|------|
   | `group.get_admins` | `{ admins: [{aid, role, ...}] }`（owner+admin） | 群成员即可调用 |
   | `group.get_members` | 全量成员，可按 role 过滤 | 群成员即可 |
   | `group.get_master` | 仅 owner AID | 群成员即可 |

   `group.get_admins` 正好返回「有权创建话题的白名单」，一次调用即可。

## 当前代码的差距

`src/core/message/message-processor.ts` 的 `resolveSession()` 已有一道守卫（创建话题前检查权限）：

```typescript
if (message.chatType === 'group' && message.threadId
    && message.source !== 'trigger' && message.source !== 'owner-inject') {
  const existing = await this.sessionManager.getThreadSession(...);
  if (!existing) {
    const role = this.sessionManager.resolveIdentity(message.channel, message.peerId).role;
    if (role !== 'owner' && role !== 'admin') {
      throw new Error('群聊中无权限创建话题');
    }
  }
}
```

问题在 `role` 的语义。`resolveIdentity` 走 `ownerResolver`/`adminResolver`，最终落到 `EvolAgent.isOwner/isAdmin`，查的是 **bot 的归属者**（agent.json / evolclaw.json 配置的 `owners`/`admins`，首通信者绑定）——**不是 AUN 群里的角色**。两套语义只在「bot 主人恰好是群主」时重合。

需求要的是后者：**发送者在该 AUN 群里的角色**。

## 为什么不用「本地角色缓存」

考虑过本地维护群角色副本（订阅 `event/group.changed` 的 `role_changed`/`owner_transferred` 增量更新）。否决，因为需求方指出的一致性代价：

- 每个 evolagent 都是群成员、都收到同一条群广播、都各自维护副本 → N 份副本要保持一致
- 副本与 Group Service 之间需要持续对账，抖动/丢事件即不一致
- 收益不足以覆盖这套机制的复杂度

## 采用方案：创建时一次性实时查询权威源

核心洞察：**话题创建是稀有事件。** 只在某个 `thread_id` 第一次出现时发生。话题一旦建好（`thread-index.json` 有记录），后续同 thread 消息直接命中 `existingEntry`，不走创建分支、零校验（`session-manager.ts` 的 `getOrCreateThreadSession` 早返回）。

所以校验粒度是「**每个新话题一次**」，不是「每条消息一次」。这让实时查询的成本可接受，且彻底回避缓存一致性问题。

### 数据流

```
群消息携带新 thread_id
  → resolveSession 守卫：thread 不存在（新建场景）
  → 调 adapter.getGroupMemberRole(groupId, senderAid)   ← 实时 RPC group.get_admins
  → owner/admin → 放行建话题
  → member/observer/非成员 → 拒绝，抛 '群聊中无权限创建话题'
  → 查询失败（网络/超时/服务不可达）→ fail-closed，拒绝
```

### 改动点

1. **`ChannelAdapter` 接口**（`src/types.ts`）：新增可选方法
   ```typescript
   /** 查询某成员在群里的角色（AUN 经 group.get_admins）。
    *  返回 'owner'|'admin'|'member'；非成员返回 'none'；查询失败返回 undefined（调用方 fail-closed）。 */
   getGroupMemberRole?(groupId: string, aid: string): Promise<'owner' | 'admin' | 'member' | 'none' | undefined>;
   ```

2. **AUN channel**（`src/channels/aun.ts`）：实现 `getGroupMemberRole`，仿 `getGroupName` 的形态
   - 走 `callAndTrace('group.get_admins', { group_id })`
   - 命中 admins 列表 → 返回其 `role`；否则 `'none'`
   - 未连接 / 异常 → 返回 `undefined`（绝不抛出）
   - **不缓存**：每次查权威源，结果天然最新（话题创建稀有，无性能压力）
   - 在 `AUNChannelPlugin.createInstance` 的 adapter 对象里挂上 `getGroupMemberRole`

3. **守卫改造**（`message-processor.ts` `resolveSession`）：
   - 拿到 `adapter = this.resolveChannelInfo(message.channel)?.adapter`
   - 若 adapter 暴露 `getGroupMemberRole`：用群角色判定
     ```typescript
     const role = await adapter.getGroupMemberRole(message.channelId, message.peerId);
     if (role !== 'owner' && role !== 'admin') {
       throw new Error('群聊中无权限创建话题');  // member/observer/none/undefined 全拒
     }
     ```
   - 若 adapter 不暴露该方法（非 AUN 渠道，如 Feishu）：保留原 `resolveIdentity` 逻辑（向后兼容）

### 失败处理：fail-closed

Group Service 不可达 / 超时 → `getGroupMemberRole` 返回 `undefined` → 守卫视为无权限，拒绝建话题，提示稍后重试。安全优先，符合规则初衷；不做缓存兜底（与「不维护本地副本」一致）。

### observer 处理

observer（协议预留只读角色）按 member 同等对待，禁止建话题。`getGroupMemberRole` 只在 admins 列表命中才返回 owner/admin，observer 不在该列表 → 返回 `'none'` → 拒绝。无需特殊分支。

## 影响面

- **仅影响 AUN 群聊新话题创建**。私聊、主会话、已存在话题、trigger/owner-inject 来源消息均不受影响。
- **Feishu 等其他渠道**：adapter 不实现 `getGroupMemberRole`，走原 `resolveIdentity` 兜底，行为不变。
- 每个新话题，每个收到它的 evolagent 各打一次 `group.get_admins`。稀有事件，无状态，无缓存负担。

## 验证

- 构建：`npm run build`
- 单测：守卫分支（owner 放行 / member 拒绝 / 查询失败拒绝 / 非 AUN 走旧逻辑 / 已存在话题不校验）
