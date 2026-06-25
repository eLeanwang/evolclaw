# AUN 消息协议与收发审计日志设计

**日期**：2026-06-10
**状态**：设计已确认，待实现
**范围**：`src/channels/aun.ts`、`src/core/message/im-renderer.ts`、`src/core/message/message-processor.ts`、本地日志/任务状态存储

---

## 背景

当前 AUN 出站消息混合了承载正文、活动流和任务状态的职责：

- `type=text` 使用普通可靠消息，`task_id/chatmode` 在 payload 顶层。
- `type=thought` 在 interactive 下使用 `message.send/group.send`，上下文放在 `client_context`。
- proactive 下的 thought 使用 `message.thought.put/group.thought.put`，同时有外层 `context.id` 和 payload 内部 `client_context.task_id`。
- `status.*` 仍作为消息 payload 发送，消息历史被迫承担 task 状态机职责。
- SDK 调用成功/失败分散在普通日志中，缺少稳定、可查询的 wire-level 收发审计日志。

这些问题会导致客户端解析分支多、trace 查询不稳定、消息历史语义混乱，并且排查 SDK 收发问题时缺少统一证据链。

---

## 目标

1. 将 AUN 协议拆成三层：状态层、内容层、终态层。
2. 所有 payload 业务上下文字段统一放顶层，废弃 `client_context`。
3. 内容流使用 `content_seq` 排序，状态流使用 `status_seq` 排序，两者互不混排。
4. `completed/error` 不依赖消息历史推断 task 状态；`error` 必须同时发送可靠内容消息，供用户和其它 Agent 消费。
5. 所有通过 fastaun SDK 发送/通知的调用都记录专用审计日志，入站消息也记录。
6. 审计日志不记录正文，不记录 `content_hash`，但必须包含定位所需 id、类型、时间戳和 SDK 结果。

---

## 非目标

- 不设计 UI 展示细节。
- 不改变 LLM runner 的语义事件模型，只改变 AUN 出站投影协议。
- 不在审计日志中保存消息正文、工具输出正文或可反推正文的哈希。
- 不保持 `client_context` 兼容。

---

## 协议分层

### 1. 状态层：notify

所有 task 状态变更走 fastaun notify：

```ts
notify('event/app.task.status', {
  type: 'task.status',
  task_id: string,
  session_id?: string,
  agent_name?: string,
  chatmode?: 'interactive' | 'proactive',
  status_seq: number,
  status: 'queued' | 'started' | 'progress' | 'interrupted' | 'timeout' | 'completed' | 'error',
  terminal?: boolean,
  metadata?: Record<string, unknown>,
  error?: {
    type?: string,
    message?: string,
    code?: string,
  },
  duration_ms?: number,
  token_usage?: Record<string, unknown>,
  context_usage?: Record<string, unknown>,
});
```

规则：

- `status_seq` 在同一 `task_id` 内单调递增。
- 状态通知不写入消息历史。
- `completed/error` 也使用该 notify；`terminal=true`。
- 客户端只用状态通知驱动任务状态 UI，不从消息历史推断任务是否完成。

### 2. 内容层：可靠消息或 thought 通道

正文、activity 和用户可见错误都属于内容流，统一使用 `content_seq`

#### 正文消息

正文走可靠消息 `message.send/group.send`：

```ts
{
  type: 'text',
  task_id: string,
  session_id?: string,
  agent_name?: string,
  chatmode: 'interactive' | 'proactive',
  content_seq: number,
  text: string,
  is_final?: boolean,
  thread_id?: string,
  ref_message_id?: string,
  initiator?: string,
  mentions?: string[]
}
```

#### 活动消息

activity 使用单 item，不再使用 `activity.batch`：

```ts
{
  type: 'activity',
  task_id: string,
  session_id?: string,
  agent_name?: string,
  chatmode: 'interactive' | 'proactive',
  content_seq: number,
  item: ActivityItem,
  thread_id?: string,
  ref_message_id?: string,
  initiator?: string
}
```

`ActivityItem`：

```ts
type ActivityItem =
  | { kind: 'tool_call'; call_id: string; name: string; arguments?: Record<string, unknown>; text?: string }
  | { kind: 'tool_result'; call_id: string; name: string; ok: boolean; result?: unknown; error?: string; duration_ms?: number; text?: string }
  | { kind: 'progress'; text: string; state?: 'processing' | 'waiting'; tool_uses?: number; duration_ms?: number }
  | { kind: 'notice'; text: string; severity: 'info' | 'warn'; subtype?: string }
  | { kind: 'summary'; text: string; subtype?: string; is_error?: boolean; duration_ms?: number }
  | { kind: 'reasoning'; text: string; duration_ms?: number }
  | { kind: 'thought'; text: string; duration_ms?: number };
```

规则：

- `content_seq` 在同一 `task_id` 内单调递增。
- `text` 和 `activity` 共用同一条内容序列。
- interactive 下 `activity` 建议走可靠消息，确保可回放。
- proactive 下可以走 `message.thought.put/group.thought.put`，但 payload 仍必须是单 item 且带 `content_seq`。
- `activity.batch` 废弃。
- `client_context` 删除。

#### 错误内容消息

task 终态错误必须发送一条可靠内容消息，不能只依赖 notify，也不能伪装成普通 `type=text`：

```ts
{
  type: 'error',
  task_id: string,
  session_id?: string,
  agent_name?: string,
  chatmode: 'interactive' | 'proactive',
  content_seq: number,
  error_type?: string,
  error_code?: string,
  message: string,
  user_message?: string,
  retryable?: boolean,
  terminal: true,
  thread_id?: string,
  ref_message_id?: string,
  initiator?: string
}
```

规则：

- `type=error` 走可靠消息 `message.send/group.send`。
- `message` 是结构化错误正文，可供其它 Agent/客户端处理。
- `user_message` 是面向用户的友好提示；为空时客户端可展示 `message`。
- `status.error` 只表示 task 状态进入错误终态，不承载完整错误内容。
- 工具级错误仍作为 `activity.item.kind='tool_result'` 且 `ok=false` 发送；只有 task 终态错误使用 `type=error`。

#### proactive thought.put 外层

`thought.put` 外层 selector 继续保留：

```ts
{
  context: { type: 'task', id: task_id },
  payload: {
    type: 'activity',
    task_id,
    content_seq,
    item,
    ...
  },
  encrypt,
  to? / group_id?
}
```

说明：

- `context.id` 是服务端聚合 selector，不是客户端业务上下文来源。
- 客户端只读取 payload 顶层字段。

### 3. 终态层：可靠错误内容 + notify + 本地 task 状态

`completed` 不作为消息历史内容发送；`error` 必须先发送可靠 `type=error` 内容消息，再发送 terminal status notify，并落盘本地 task 状态。

完成时：

```ts
notify('event/app.task.status', {
  type: 'task.status',
  task_id,
  session_id,
  status_seq,
  status: 'completed',
  terminal: true,
  duration_ms,
  token_usage,
  context_usage
});
```

错误时：

```ts
// 1. 可靠内容消息，供用户和其它 Agent 处理
{
  type: 'error',
  task_id,
  session_id,
  chatmode,
  content_seq,
  error_type,
  error_code,
  message,
  user_message,
  retryable,
  terminal: true
}

// 2. 状态通知，驱动 task 状态机
notify('event/app.task.status', {
  type: 'task.status',
  task_id,
  session_id,
  status_seq,
  status: 'error',
  terminal: true,
  error: { type, code, message }
});
```

同时本地落盘 task 状态。建议文件路径：

```text
data/tasks/{task_id}.json
```

建议结构：

```ts
{
  task_id: string,
  session_id?: string,
  agent_name?: string,
  channel: 'aun',
  channel_id: string,
  chatmode: 'interactive' | 'proactive',
  status: 'queued' | 'started' | 'progress' | 'interrupted' | 'timeout' | 'completed' | 'error',
  terminal: boolean,
  started_at?: string,
  updated_at: string,
  completed_at?: string,
  last_status_seq: number,
  last_content_seq: number,
  error?: { type?: string; code?: string; message?: string; user_message?: string; retryable?: boolean },
  duration_ms?: number,
  token_usage?: Record<string, unknown>,
  context_usage?: Record<string, unknown>
}
```

客户端恢复 task 状态时读取本地 task 状态或状态 API，不依赖消息历史。

---

## 序列号规则

### content_seq

- 每个 task 从 1 开始。
- 每发一条 `type=text` 或 `type=activity` 增加 1。
- activity 单 item，因此一个 `content_seq` 对应一个内容事件。
- 客户端按 `(task_id, content_seq)` 去重和排序。

### status_seq

- 每个 task 从 1 开始。
- 每发一次 `event/app.task.status` 增加 1。
- 状态流与内容流互不比较顺序。
- 客户端按 `(task_id, status_seq)` 去重和排序。

### 两条流的关系

状态流只说明 task 生命周期，内容流只说明用户可见内容和过程活动。客户端不得用 `status_seq` 推断 `content_seq`，也不得用最后一条内容推断 task 结束。

---

## 专用收发审计日志

### 文件

```text
logs/aun-wire-YYYYMMDD.jsonl
```

该日志为 wire-level 审计日志，仅记录 SDK 收发元数据和结果，不记录正文。

### 出站 attempt

调用 fastaun SDK 前写一条完整定位记录：

```ts
{
  ts: string,
  dir: 'out',
  phase: 'attempt',
  op_id: string,

  aid: string,
  method: string,
  payload_type?: string,
  encrypted?: boolean,

  task_id?: string,
  session_id?: string,
  content_seq?: number,
  status_seq?: number,
  chatmode?: string,
  agent_name?: string,

  peer_aid?: string,
  group_id?: string,
  thread_id?: string,
  ref_message_id?: string,
  initiator?: string,

  item_kind?: string,
  content_len?: number
}
```

### 出站 result

SDK 返回或抛错后写一条必要结果记录：

```ts
{
  ts: string,
  dir: 'out',
  phase: 'result',
  op_id: string,

  ok: boolean,
  method: string,

  message_id?: string,
  thought_id?: string,
  event_id?: string,

  duration_ms?: number,

  error_name?: string,
  error_code?: string,
  error_message?: string,

  retry_of?: string,
  fallback_plaintext?: boolean
}
```

说明：

- attempt 记录完整上下文。
- result 只通过 `op_id` 关联 attempt，不重复 task/session/seq/target 字段。
- fallback 重试使用新的 `op_id`，并通过 `retry_of` 指向原始失败 op。
- 不记录 `content_hash`。
- 不记录正文。

### 入站记录

收到 fastaun SDK 消息或通知时写一条完整定位记录：

```ts
{
  ts: string,
  dir: 'in',

  aid: string,
  sdk_event: string,
  payload_type?: string,

  message_id?: string,
  thought_id?: string,
  event_id?: string,
  seq?: number,

  task_id?: string,
  session_id?: string,
  content_seq?: number,
  status_seq?: number,
  chatmode?: string,

  sender_aid?: string,
  peer_aid?: string,
  group_id?: string,
  thread_id?: string,
  ref_message_id?: string,

  encrypted?: boolean,
  content_len?: number
}
```

### 审计 wrapper

所有 SDK 发送和通知必须走统一 wrapper：

```ts
callAndAudit(method, params, meta)
```

要求：

- 写 attempt 后再调用 SDK。
- SDK 成功写 result `ok=true`。
- SDK 失败写 result `ok=false`。
- wrapper 不保存正文，只从 payload 提取类型、id、seq、长度等元数据。
- 禁止新增直接 `client.call(...)` 的发送路径。
- 审计日志写入失败不能阻断主业务，但必须写普通 error 日志。

---

## 现有路径改造

### `status.*`

现状：`sendProcessingStatus()` 使用 `message.send/group.send` 发送 `type=status`。

改造：

- 改为 `notify('event/app.task.status')`。
- 增加 `status_seq`。
- completed/error 的 task 状态都走该 notify。
- `status.completed/status.error` 不再作为消息 payload；其中 error 另发可靠 `type=error` 内容消息。

### `result.text`

现状：`result.text` 由 adapter 转为 `type=text` 可靠消息。

改造：

- 显式注入 `content_seq`。
- 补齐顶层 `task_id/session_id/chatmode/agent_name`。
- 正文消息继续可靠发送。

### `activity.batch`

现状：多个 `ThoughtItem` 聚合为 `activity.batch`，AUN 中转为 `type=thought + items[] + client_context`。

改造：

- 废弃 batch。
- 每个 activity 单 item 发送。
- payload 类型改为 `type=activity`。
- 注入顶层 `content_seq/task_id/session_id/chatmode/agent_name`。
- 删除 `client_context`。

### proactive thought

现状：proactive activity 使用 `thought.put`，payload 为 batch。

改造：

- `thought.put` 外层 `context.id=task_id` 保留。
- payload 改为单 item `type=activity`。
- payload 顶层带 `content_seq`。

### 本地任务状态

新增 task 状态 writer：

- task start 写 `started`。
- 每次状态变化更新 `updated_at/last_status_seq`。
- 每次内容发送更新 `last_content_seq`。
- terminal 状态写 `completed_at/terminal/error/token_usage/context_usage`。

---

## 兼容策略

本设计选择硬切，不保留 `client_context`。

原因：

- `client_context` 与顶层字段职责重复。
- 旧结构导致 trace、客户端和消息历史解析分支增加。
- 当前需要建立长期稳定协议，优先降低未来维护成本。

要求：

- 客户端同步改为读取 payload 顶层 `task_id/chatmode/agent_name/content_seq/status_seq`。
- 服务端不再发送 `client_context`。
- 文档和测试中移除 `activity.batch` 示例。

---

## 测试计划

### 单元测试

- `text` payload 顶层字段完整，包含 `content_seq`。
- `activity` payload 单 item，包含 `content_seq`，不包含 `client_context`。
- `error` payload 走可靠消息，包含 `content_seq/error_type/message/terminal`。
- status notify 包含 `status_seq`，不走 `message.send/group.send`。
- completed 只发 terminal notify，不发送内容消息。
- error 同时发送可靠 `type=error` 内容消息和 terminal notify，不发送 `status.error` 消息 payload。
- `callAndAudit()` 成功时写 attempt + result。
- `callAndAudit()` 失败时写 attempt + result(ok=false)。
- fallback 写新 op，并带 `retry_of`。
- 入站消息写 wire audit，不包含正文。

### 集成测试

- interactive 一轮包含 text、tool_call、tool_result、completed：
  - 内容消息按 `content_seq` 递增。
  - 状态通知按 `status_seq` 递增。
  - completed 只出现在 notify 和本地 task 状态。
- proactive activity 使用 thought.put，payload 仍为单 item。
- trace/audit 可按 `task_id` 找到整条发送链。

### 回归检查

- 不记录正文。
- 不记录 `content_hash`。
- 不再出现 `client_context`。
- 不再出现 `activity.batch` 出站到 AUN。

---

## 待实现清单

- [ ] 新增 AUN wire audit writer。
- [ ] 收敛所有 fastaun SDK 发送/通知到 `callAndAudit()`。
- [ ] 入站消息/通知接入 wire audit。
- [ ] 为 task 增加 `content_seq/status_seq` 状态。
- [ ] `sendProcessingStatus()` 改为 notify。
- [ ] `IMRenderer` 从 batch 改为单 item activity。
- [ ] `result.text` 注入 `content_seq`。
- [ ] terminal error 改为可靠 `type=error` 内容消息 + notify + task 状态落盘。
- [ ] completed 改为 notify + task 状态落盘。
- [ ] 删除 AUN `client_context`。
- [ ] 更新测试和协议文档。
