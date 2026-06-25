# AUN Thought 协议改造提案

> 面向对象：AUN 服务端团队 + EvolClaw 客户端团队 + 其他 AUN SDK 实现者
> 状态：提案（Draft）
> 关联协议：`group.thought.put` / `group.thought.get` / `message.thought.put` / `message.thought.get`

## 1. 背景

### 1.1 现状问题

当前 AUN thought 协议使用 `reply_to.message_id` 作为存储键的一部分：

```
存储键：group_id + sender_aid + reply_to.message_id
```

这在以下场景失效：

| 场景 | 问题 |
|------|------|
| Cron 定时任务触发 | 无触发消息，无 `message_id` 可锚定，thought 无法发送 |
| Webhook 触发（非 AUN 消息） | 同上 |
| Agent 主动发起任务（如欢迎消息） | 同上 |
| Task 被撤回 | 原锚定消息被删，thought 失去关联 |

### 1.2 语义错位

`reply_to.message_id` 本意是"回应某条消息"的语义标记。但在 thought 场景里，它被重载为"任务标识"。这导致：

- 语义歧义：thought 可能是针对某条消息，也可能只是一次长任务的过程展示
- 生命周期耦合：thought 的可查询性绑定到消息的存在性
- 扩展性差：未来 `event/task.*` 事件与 thought 无法通过统一 ID 关联

---

## 2. 改造方案

### 2.1 核心变更

**将 thought 存储键从 `reply_to.message_id` 迁移到新字段 `task_id`：**

```
存储键：group_id + sender_aid + task_id
```

`reply_to.message_id` 降级为**可选的语义锚点**（"这个 thought 在回应某条消息"），不再影响存储。

### 2.2 RPC 参数变更

#### `group.thought.put` / `message.thought.put`

| 字段 | 改造前 | 改造后 | 说明 |
|------|:------:|:------:|------|
| `group_id` / `to` | 必填 | 必填 | 不变 |
| `task_id` | — | **必填（新增）** | 任务唯一标识，客户端生成 |
| `reply_to.message_id` | 必填 | **可选** | 语义锚点，描述 thought 回应哪条消息 |
| `payload` | 必填 | 必填 | 不变（使用同一套业务负载约定） |
| `thought_id` | 可选 | 可选 | 不变（SDK 自动生成） |
| `encrypt` | 必填 true | 必填 true | 不变 |

#### `group.thought.get` / `message.thought.get`

| 字段 | 改造前 | 改造后 | 说明 |
|------|:------:|:------:|------|
| `group_id` / `to` | 必填 | 必填 | 不变 |
| `sender_aid` | 必填 | 必填 | 不变 |
| `task_id` | — | **必填（新增）** | 替代 `reply_to.message_id` 作为主查询键 |
| `reply_to.message_id` | 必填 | **废弃** | 服务端接收但忽略；兼容期后移除 |

### 2.3 task_id 规范

#### 格式

```
task-{10 字符小写 hex}
```

示例：`task-a1b2c3d4e5`

- 固定前缀 `task-`（与 AUN 既有 `gt-` / `mt-` / `gm-` 前缀约定一致）
- 后 10 字符取自客户端 `crypto.randomUUID()` 去 hyphen 后的前 10 位
- 总长 15 字符

#### 生成方

**客户端生成**。理由：
- 客户端需在任务最开始就持有 task_id（用于 `task.started` 事件 + 后续 thoughts）
- 避免额外一次服务端 RPC 申请 ID 的延迟
- 服务端通过 `(group_id, sender_aid, task_id)` 复合主键去重兜底

#### 生命周期

**一次"任务处理"对应一个 task_id**：

```
客户端收到触发（用户消息/cron/webhook/自发起）
  ↓
生成 task_id = task-{10hex}
  ↓
发送 task.started 事件（data.task_id = task_id）
  ↓
处理过程中产生流式事件（text / tool_use / tool_result 等）
  ↓  每个事件通过 *.thought.put 发出，带同一个 task_id
  ↓
发送 task.completed / task.error / task.interrupted / task.timeout
(data.task_id = task_id)
```

边界规则：
- **新任务 = 新 task_id**：无论触发源是什么
- **打断 = 新任务**：用户打断后的后续消息进入新处理循环，生成新 task_id
- **子任务 / 多 complete 事件共享**：subagent、auto-compact 重试等仍属于同一用户任务
- **context-too-long 压缩重试**：共享同一 task_id（用户视角上是同一请求的恢复）

#### 与 `event/task.*` 对齐

当前 `09-payload-reference.md` 规定 `event/task.*` 的 `data.task_id`：

```json
{
  "type": "event",
  "event": "task.started",
  "data": {"task_id": "task-a1b2c3d4e5"}
}
```

**约定：thought RPC 的顶层 `task_id` 与 `event/task.*` 的 `data.task_id` 是同一个值**，客户端在整次任务处理中使用同一 ID，实现事件流 + thought 流的串联观测。

### 2.4 存储与查询语义

#### 存储规则

```
主键：(group_id | to, sender_aid, task_id)
```

- 同一 `(group_id | to, sender_aid)` 下，每个 task_id 维护独立的 thought head
- 同一 task_id 下可追加多条 thought item（实时流式特性）
- **同时存在多个活跃 task_id**：不同于旧协议"只保留最后一个 head"，新协议允许同一发送者同时有多个任务在进行（如 subagent 场景）
- **保留期建议**：task 结束后保留 10 分钟供查询，之后清理（服务端可配置）

#### 查询语义

`group.thought.get` / `message.thought.get` 响应格式**不变**：

```json
{
  "found": true,
  "group_id": "g-abc123.agentid.pub",
  "sender_aid": "alice.agentid.pub",
  "task_id": "task-a1b2c3d4e5",
  "thoughts": [
    {
      "thought_id": "gt-xxx",
      "payload": {"type": "thought", "text": "...", "stage": "thinking"},
      "created_at": 1234567890000
    }
  ],
  "updated_at": 1234567890000
}
```

响应新增 `task_id` 字段（回显请求）。`reply_to` 字段仅在 put 时携带过 `reply_to.message_id` 时才在 get 响应中返回。

### 2.5 Payload 内可选字段（不变）

thought payload 格式**保持不变**：

```json
{
  "type": "thought",
  "text": "...",
  "stage": "thinking|planning|tool|system|summary|error",
  "format": "plain|markdown",
  "metadata": {}
}
```

`09-payload-reference.md` 的 thought 类型小节只需调整一处措辞（将"`reply_to.message_id` 是顶层必填键"改为"`task_id` 是顶层必填键，`reply_to.message_id` 可选用于展示引用摘要"）。

---

## 3. 兼容性

### 3.1 版本策略

**不提供双协议兼容，一次性切换**。理由：
- 存储键变更涉及索引和主键，无法同时维护两套
- thought 是临时数据（非持久化），过渡期丢失可接受
- 提案阶段对齐版本，发布后即为新协议

### 3.2 版本号

- 服务端：Group Service / Message Service 协议版本 bump
- 客户端 SDK（`@agentunion/fastaun`）：次版本号升级（0.3.x 或 0.2.15+）
- 协议文档 `10-Group-子协议.md` / `09-payload-reference.md` 同步更新

### 3.3 错误码

建议新增错误码（如沿用 -33xxx 段）：

| 错误码 | 含义 | 场景 |
|--------|------|------|
| -33010 | Missing task_id | 请求未携带 task_id 或格式非法 |
| -33011 | Task not found | get 时 task_id 未找到存活记录 |

---

## 4. 客户端改造（以 EvolClaw 为例）

### 4.1 ChannelAdapter 接口

```typescript
interface ChannelAdapter {
  // 改造前
  // putThought?(channelId: string, replyToMessageId: string, payload: object): Promise<void>;

  // 改造后
  putThought?(
    channelId: string,
    taskId: string,               // 新增，必填
    payload: object,
    replyToMessageId?: string     // 降级为可选
  ): Promise<void>;

  // 改造前
  // sendProcessingStatus?(channelId, status, sessionId, context?): void;

  // 改造后
  sendProcessingStatus?(
    channelId: string,
    status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout',
    sessionId: string,
    taskId: string,               // 新增，必填
    context?: ReplyContext
  ): void;
}
```

### 4.2 AUN 通道实现

```typescript
async sendThought(
  channelId: string,
  taskId: string,
  payload: object,
  replyToMessageId?: string
): Promise<void> {
  const params: Record<string, any> = {
    task_id: taskId,
    payload,
    encrypt: true,
  };
  if (replyToMessageId) {
    params.reply_to = { message_id: replyToMessageId };
  }

  if (isGroupId(channelId)) {
    params.group_id = channelId;
    await client.call('group.thought.put', params);
  } else {
    params.to = channelId;
    await client.call('message.thought.put', params);
  }
}

sendProcessingStatus(channelId, status, sessionId, taskId, context?): void {
  const payload = {
    type: 'event',
    event: `task.${statusMap[status]}`,
    data: {
      task_id: taskId,             // 对齐 event/task.* 约定
      session_id: sessionId,
    },
    severity: ...,
  };
  // ...
}
```

### 4.3 ThoughtEmitter 简化

```typescript
class ThoughtEmitter {
  constructor(
    adapter: ChannelAdapter,
    channelId: string,
    taskId: string,                // 新：主锚点
    replyToMessageId?: string      // 可选：语义锚点
  ) { ... }

  // 删除 updateReplyTo —— 不再需要动态切换（新消息 = 新 task）

  async emit(event: AgentEvent): Promise<void> {
    const payload = this.mapEventToPayload(event);
    if (!payload) return;
    await this.adapter.putThought?.(
      this.channelId,
      this.taskId,
      payload,
      this.replyToMessageId
    );
  }
}
```

### 4.4 MessageProcessor 入口

```typescript
private async _processMessageInternal(message, session, ...) {
  const taskId = `task-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

  // task.started
  adapter.sendProcessingStatus(
    message.channelId, 'start', session.id, taskId, replyContext
  );

  // ThoughtEmitter（条件从 3 个降为 2 个）
  let thoughtEmitter: ThoughtEmitter | null = null;
  if (isProactive && adapter.putThought) {
    thoughtEmitter = new ThoughtEmitter(
      adapter,
      message.channelId,
      taskId,
      message.messageId  // 可选，Cron/Webhook 场景为 undefined
    );
  }

  // ... 事件循环 ...

  // task.completed / task.error / task.interrupted
  adapter.sendProcessingStatus(..., taskId, ...);
}
```

### 4.5 删除的逻辑

- `EventBus.message:new-inbound` 事件订阅（动态切换 replyTo 不再需要）
- `ThoughtEmitter.updateReplyTo` 方法
- `MessageProcessor` 中的 `thoughtNewInboundHandler` 订阅/清理
- `MessageBridge` 中 `message:new-inbound` 事件发布（可保留供其他用途，或删除）

### 4.6 保留的逻辑

- `MessageQueue` / `StreamDebouncer` merge 时保留最新 messageId —— 仍有用，作为 `reply_to.message_id` 可选锚点
- `AUN channel` 的 `isGroupId` 分发逻辑
- 所有 thought payload 格式

---

## 5. 服务端改造清单

### 5.1 必须修改

- [ ] `group.thought.put` / `message.thought.put` 接受 `task_id` 参数并作为存储键
- [ ] `reply_to.message_id` 参数从"必填"改为"可选"，不再参与存储键
- [ ] `group.thought.get` / `message.thought.get` 以 `task_id` 为查询键
- [ ] 存储索引：由 `(group_id, sender_aid, message_id)` 改为 `(group_id, sender_aid, task_id)`
- [ ] 允许同一 `(group_id, sender_aid)` 下同时存在多个活跃 task
- [ ] 新增错误码 -33010 / -33011
- [ ] task 保留期策略（建议默认 10 分钟）

### 5.2 校验规则

- [ ] `task_id` 格式校验：`^task-[a-f0-9]{10}$`
- [ ] `task_id` 长度上限（建议 32 字符，留客户端扩展空间）
- [ ] 缺失 `task_id` → 返回 -33010

### 5.3 事件广播（可选增强）

- [ ] `event/group.thought_updated` 可携带 `task_id`，方便订阅者按任务过滤

---

## 6. 示例对比

### 6.1 场景 A：用户消息触发的群聊任务

**改造前：**

```json
// put
{
  "group_id": "g-abc.agentid.pub",
  "reply_to": {"message_id": "gm-user-msg-001"},
  "payload": {"type": "thought", "text": "分析中", "stage": "thinking"},
  "encrypt": true
}
```

**改造后：**

```json
// put
{
  "group_id": "g-abc.agentid.pub",
  "task_id": "task-a1b2c3d4e5",
  "reply_to": {"message_id": "gm-user-msg-001"},
  "payload": {"type": "thought", "text": "分析中", "stage": "thinking"},
  "encrypt": true
}
```

### 6.2 场景 B：Cron 定时任务触发（新协议独有）

```json
// task.started 事件
{
  "group_id": "g-abc.agentid.pub",
  "payload": {
    "type": "event",
    "event": "task.started",
    "data": {"task_id": "task-f5e4d3c2b1", "session_id": "sess-xxx"}
  }
}

// thought put
{
  "group_id": "g-abc.agentid.pub",
  "task_id": "task-f5e4d3c2b1",
  "payload": {"type": "thought", "text": "执行定时任务", "stage": "planning"},
  "encrypt": true
}
// 注意：无 reply_to
```

### 6.3 场景 C：get 查询

**改造前：**

```json
{
  "group_id": "g-abc.agentid.pub",
  "sender_aid": "bot.agentid.pub",
  "reply_to": {"message_id": "gm-user-msg-001"}
}
```

**改造后：**

```json
{
  "group_id": "g-abc.agentid.pub",
  "sender_aid": "bot.agentid.pub",
  "task_id": "task-a1b2c3d4e5"
}
```

---

## 7. 开放问题

供双方对齐时讨论：

1. **task_id 长度上限**：服务端是否接受超过 10 位 hex 的格式？（允许其他客户端使用 nanoid / ULID 等）建议：上限 32 字符，格式约束 `^task-[A-Za-z0-9_-]{4,28}$`

2. **task 保留期**：10 分钟是否合适？长任务（如大型代码生成）可能超过此时限。建议：默认 10 分钟，服务端可配置，客户端通过 `task.completed` 时主动触发清理

3. **同一 (group, sender) 下并发 task 上限**：是否需要限制？建议：默认 16，防止客户端泄漏

4. **task_id 发现机制**：对端如何知道有哪些 task 可 get？
   - 方案 A：通过 `task.started` 事件广播
   - 方案 B：新增 `*.thought.list_tasks` RPC
   - 推荐 A

5. **跨设备场景**：同一 sender_aid 多设备是否共享 task_id 空间？建议：共享（因为存储键里已有 sender_aid），客户端自己保证不冲突

---

## 8. 落地时间表建议

| 阶段 | 内容 | 负责方 |
|------|------|--------|
| T+0 | 本文档 review / 开放问题对齐 | 双方 |
| T+3 天 | 服务端实现新协议（开发分支） | AUN 服务端 |
| T+3 天 | SDK 0.2.15 或 0.3.0 发布（新协议） | AUN SDK |
| T+5 天 | EvolClaw 集成新 SDK + ThoughtEmitter 改造 | EvolClaw |
| T+7 天 | 联调 + 发布 | 双方 |

---

## 附录 A：改造对 EvolClaw 的语义收益

| 场景 | 改造前 | 改造后 |
|------|--------|--------|
| 用户消息触发 | ✓ thought 正常 | ✓ thought 正常 + reply_to 保留 |
| Cron 定时任务 | ✗ 无 thought | ✓ thought 正常 |
| Webhook 触发 | ✗ 无 thought | ✓ thought 正常 |
| 主动欢迎消息 | ✗ 无 thought | ✓ thought 正常 |
| Agent 自发起后续任务 | ✗ 无 thought | ✓ thought 正常 |
| 打断/重试 | replyTo 需动态切换（复杂） | 新任务 = 新 task_id（简单） |
| 任务状态与过程关联 | 两条线各自独立 | 通过 task_id 统一串联 |

## 附录 B：代码改动规模估算（EvolClaw）

| 模块 | 改动类型 | 行数估算 |
|------|----------|----------|
| `src/types.ts` | 修改 ChannelAdapter 签名 | ±10 |
| `src/core/message/thought-emitter.ts` | 构造签名 + 删除 updateReplyTo | -20 / +15 |
| `src/core/message/message-processor.ts` | 入口生成 taskId + 传播 + 删除订阅 | -30 / +15 |
| `src/core/event-bus.ts` | 移除 message:new-inbound（可选） | -5 |
| `src/core/message/message-bridge.ts` | 移除 new-inbound 发布（可选） | -10 |
| `src/channels/aun.ts` | sendThought / sendProcessingStatus 签名 | ±30 |
| `src/channels/feishu.ts` 等 | sendProcessingStatus 签名适配 | ±5 each |
| 测试 | 签名变更同步 | ±50 |
| **合计** | **净减少** | **约 -50 行** |
