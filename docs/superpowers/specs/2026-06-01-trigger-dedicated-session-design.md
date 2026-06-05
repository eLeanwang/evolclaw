# Trigger 专属会话设计

**日期**: 2026-06-02  **状态**: Final Draft  **关联**: 2026-05-13-trigger-feature-design.md

---

## 1. 背景

现有触发器（`2026-05-13-trigger-feature-design.md`）的两种策略：

| 策略 | 问题 |
|------|------|
| `latest` | 触发时劫持用户当前活跃会话，上下文串台 |
| `silent` | 每次触发 `createNewSession` 新建会话，`persistSession 'set'` 覆写 active.json 后靠「切走→切回」恢复；存在竞态窗口 + prevActive 空洞两个缺陷；cron 每次产生全新会话，无上下文累积 |

**本次迭代**：移除 `silent`，新增 `current` 和 `thread`，**不考虑向下兼容**（triggers.json 可清空）。`latest` 不变。

---

## 2. 三种策略

### 策略总览

| 策略 | 触发时行为 | 输出可见性 | 上下文 |
|------|-----------|----------|--------|
| `latest`（不变） | 续接触发时的当前活跃会话 | 按 sessionMode | 当前活跃会话历史 |
| `current`（新增） | 续接**创建时**绑定的会话（切 active，切过不切回） | 可见 | 该会话历史，跨触发累积 |
| `thread`（新增） | 专属 thread 话题会话（AUN 合成 ID / 飞书首次 reply 后回填） | 可见（落在话题里） | 该 thread 会话，跨触发累积 |

### `current` 策略详解

**核心机制**：
1. **注册时**：记录创建时活跃会话的 `sessionId`（`boundSessionId`）。
2. **触发时**：检查目标会话是否正忙（`messageQueue.isProcessing(boundSessionId)`）。
   - **忙** → 延迟补发：等 `task:completed[sessionId === boundSessionId]` 事件，或 30 秒兜底（先到先触发，触发后退订 + 清 timeout，防泄漏）。
   - **空闲** → 用 `bound.projectPath`（从 `getSessionById` 取，非 `primaryProjectPath`）和 `boundSessionId` 入队，与用户消息同队列串行。
3. **出队后（resolveSession）**：`getSessionById` 取 bound 会话 → `switchToSession(bound.channel, bound.channelId, bound.id)` 切成 active → 续接执行。切过**不切回**。

**为什么切 active**：`isBackgroundSession`（`message-processor.ts:117-122`）对「主会话且 `session.id !== active.id`」返回 true，输出会在 `:513-514` 被静默丢弃。切 active 后 `session.id === active.id`，输出正常发出。

**为什么用 bound.projectPath 入队**：队列 key = `${sessionKey}::${path.resolve(projectPath)}`（`:85-88`）。用户消息入队用 `session.projectPath`（`:207`）。两者 projectPath 必须一致，否则落进不同队列、串行保证失效。

**补发兜底**：等待期间若 bound 会话被 `/del` 删除（`getSessionById` 返回 undefined）→ **直接取消补发**，不降级（降级到 latest 行为不可预期）。

### `thread` 策略详解

复用现有 thread 会话机制（`getOrCreateThreadSession`，`session-manager.ts:645`）：
- thread 会话存在 `_threads/` 子目录，`persistSession 'none'`，**从不碰 active.json**，且 `threadId` 非空天然豁免 `isBackgroundSession` 后台门控（`:118`），输出直接发出。
- 同 threadId 多次触发命中同一会话，跨触发累积上下文。

**AUN**：注册时直接生成合成 threadId（`trigger-<triggerId>`），立即可用，无需 root 消息。

**飞书**：thread_id 由服务端在 `reply(reply_in_thread=true)` 后生成，不可预先指定。
- 注册时记 `rootMessageId`（创建触发器那条消息的 messageId），设 `pendingThread=true`。
- 首次触发：走主会话路径执行，输出以 `reply(rootMessageId, reply_in_thread=true)` 发出 → 飞书返回 thread_id → 回填 `trigger.targetThreadId`，清 `pendingThread`。首次执行的上下文**不计入话题会话**（话题此刻刚建立）。
- 第二次起：`targetThreadId` 已就绪，走 `getOrCreateThreadSession` 命中话题会话，续接上下文。
- 兜底：root 消息被撤/过期（230011/99992354）→ 降级普通消息，清 `pendingThread`（标记建话题失败，不再重试 reply_in_thread）。

---

## 3. 数据模型变更

### `TriggerSessionStrategy`（`types.ts:824`）
```typescript
export type TriggerSessionStrategy = 'latest' | 'current' | 'thread';
```

### `Trigger` 接口新增字段（`types.ts:826`）
```typescript
boundSessionId?: string;       // current：注册时绑定的 sessionId
threadKind?: 'aun' | 'feishu'; // thread：区分 AUN/飞书两条路径
rootMessageId?: string;        // thread(feishu)：注册时那条命令的 messageId
pendingThread?: boolean;       // thread(feishu)：true=首次触发待建话题
targetChannelType?: string;    // 已存在字段，注册时须填（供精确目录定位）
```

### `Message.triggerMeta` 调整（`types.ts:266`）
```typescript
triggerMeta?: {
  triggerId: string;
  // 移除 silent（silent 策略已删除）
  boundSessionId?: string;     // current
  pendingThread?: boolean;     // thread(feishu) 首次触发
  rootMessageId?: string;      // thread(feishu) 首次触发
};
```

### `ChannelCapabilities` 新增 `thread`（`types.ts:812`）
```typescript
thread: boolean;  // AUN/飞书: true；微信: false
```

---

## 4. 渠道能力差异（关键约束）

| | AUN | 飞书 | 微信 |
|---|---|---|---|
| thread_id 来源 | 客户端自由指定（出站 payload `thread_id`，`aun.ts:1847`） | 服务端生成，reply 后返回（`feishu.ts:581` 目前丢弃返回值） | 不支持 |
| 注册时能否确定 threadId | ✅ 立即生成 | ❌ 首次触发后回填 | — |
| 需要 root messageId | ❌ | ✅ | — |
| capabilities.thread | true | true | false |

---

## 5. 命令参数

`--session` 接受 `latest | current | thread`（移除 `silent`）。

**互斥与校验**：
- `--session`、`--thread <id>` 互斥（都决定 session 路由）。
- `--session thread` 校验 `adapter.capabilities.thread`，不支持则报错。
- `--session current` 要求创建时存在活跃会话，否则报错。
- `--session thread` + 飞书：注册时必须有 `messageId`（从 `handle()` 透传），否则报错。

---

## 6. 既有并发隐患说明（非本功能引入）

`latest` 策略今天就存在「触发器与并发用户消息可能 resume 同一 agentSessionId」的双轨 keying 问题（触发器 key = `channel:channelId`，用户消息 key = `session.id`）。本功能不扩大此隐患：
- `current` 通过改用 `boundSessionId` 入队 + 忙检查，**实际消除了**该策略下的并发风险。
- `thread` 因解析到独立话题会话，与主会话碰撞概率极低。
- `latest` 的既有隐患保持原状，属独立架构改动范围。
