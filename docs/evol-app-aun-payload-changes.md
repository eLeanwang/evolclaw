# Evol App 对接文档 — AUN payload 结构变更

> 适用范围：相对 `321ad37` 之后的 AUN 出站 payload 结构（`src/channels/aun.ts`）。
> 受影响端：通过 AUN 网络接收 EvolClaw（agent 侧）消息的 Evol 前端（App / Web / Desktop）。

## TL;DR（破坏性变更速览）

| # | 变更点 | 旧格式 | 新格式 | 破坏性 |
|---|--------|--------|--------|:------:|
| 1 | **任务状态** task status | `message.send` / `group.send` 消息，`{ type:'status', state, ref_message_id }` | **`notify` 通知**（`event/app.task.status`），`{ type:'task.status', status, terminal }` | 🔴 高 |
| 2 | **活动/思考** activity | 一条 `type:'thought'` + `items[]`（整批） | **逐条** `type:'activity'` + 单个 `item`（无 items 数组） | 🔴 高 |
| 3 | **系统通知/错误** notice/error | 纯文本消息（`sendMessage`） | 结构化消息 `type:'notice'` / `type:'error'` | 🟠 中 |
| 4 | **进度状态** status:'progress' | proactive 模式下也下发 `task.status` 的 `status:'progress'` | proactive 模式**不再下发** `status:'progress'`（过程统一由 §2 activity/thought 表达） | 🟠 中 |

下面逐项说明。

---

## 1. 任务状态：从「消息」改为「notify 通知」🔴

这是最大的破坏性变更：任务状态不再作为普通消息（`message.send`/`group.send`）下发，改为通过 AUN 的 **notify 机制**（`event/app.task.status`）推送。

### 传输通道变更

| | 旧 | 新 |
|---|---|---|
| RPC 方法 | `message.send` / `group.send` | `client.notify('event/app.task.status', payload, options)` |
| 是否入消息历史 | 是（作为消息） | **否**（notify 不持久化为消息） |
| 寻址 | `to` / `group_id` 在 params | `options.to` / `options.groupId` |
| TTL | 无 | `ttlMs: 60000`（60 秒） |

### Payload 字段变更

旧：
```json
{
  "type": "status",
  "state": "completed",
  "task_id": "...",
  "session_id": "...",
  "severity": "info",
  "ref_message_id": "msg-123"
}
```

新：
```json
{
  "type": "task.status",
  "status": "completed",
  "task_id": "...",
  "session_id": "...",
  "severity": "info",
  "terminal": true,
  "chatmode": "interactive",
  "thread_id": "...",
  "initiator": "...",
  "ref_message_id": "msg-123",
  "metadata": { }
}
```

字段级 diff：
- `type`: `"status"` → **`"task.status"`**
- `state` → **`status`**（值不变：`started`/`completed`/`interrupted`/`error`/`timeout`/`queued`/`progress`）
- **新增 `terminal`**：布尔，`status ∈ {completed, interrupted, error, timeout}` 时为 `true`，表示任务终态
- **`ref_message_id` 保留**：存在 `context.replyToMessageId` 时附带，供客户端定位被回复的消息
- `severity`：`error`/`timeout` 为 `"error"`，其余 `"info"`（不变）
- `chatmode` / `thread_id` / `initiator`：存在时附带
- `metadata`：仅当非空时附带（如 completed 带 token/context 用量、progress 带 activityType 等）

### Evol App 需要做的事
1. **订阅 notify 事件** `event/app.task.status`，不要再从消息流里找 `type:'status'`。
2. 用 `status` 字段（而非 `state`）判断阶段。
3. 用 `terminal` 字段判断任务是否结束，驱动 UI 收尾（停止 loading 等）。
4. 用 `ref_message_id` 定位被回复的消息（存在时）。

---

## 2. 活动/思考：逐条 `type:'activity'`，字段收进 `item` 🔴

### 行为变更
旧：聚合窗口内所有 activity 项打包成**一条** `type:'thought'` 消息，带 `items[]` 数组。
新：**逐条**发送，每个 activity 项一条消息。

### Payload 字段变更

旧（整批）：
```json
{
  "type": "thought",
  "items": [ { "kind": "tool_call", ... }, { "kind": "text", ... } ],
  "client_context": { "task_id": "...", "chatmode": "...", "agent_name": "..." },
  "thread_id": "..."
}
```

新（逐条）：
```json
{
  "type": "activity",
  "task_id": "...",
  "session_id": "...",
  "agent_name": "...",
  "chatmode": "...",
  "thread_id": "...",
  "initiator": "...",
  "ref_message_id": "msg-123",
  "item": {
    "kind": "tool_call",
    "call_id": "call_001",
    "name": "Read",
    "arguments": { "file_path": "/home/evolclaw/src/channels/aun.ts" },
    "text": "读取 aun.ts"
  }
}
```

字段级 diff：
- `type`: `"thought"` → **`"activity"`**
- **移除 `items[]` 数组**：改为单个 **`item`** 对象（每条消息只承载一个 activity 项）
- **移除 `client_context` 包裹**：原 `client_context.{task_id,chatmode,agent_name}` 改为**平铺到顶层**，并扩充为 `task_id`/`session_id`/`agent_name`/`chatmode`/`thread_id`/`initiator`/`ref_message_id`（共用字段集与 §1 task.status、§3 notice/error 一致）
- **共用字段在顶层，类型特有字段在 `item` 内**

### `item` 的结构（按 `kind` 区分）
`item.kind` 取值及其特有字段（对应 `ThoughtItem`）：

| kind | 特有字段 |
|------|----------|
| `text` | `text`, `duration_ms?` |
| `reasoning` | `text`, `duration_ms?` |
| `tool_call` | `call_id`, `name`, `arguments?`, `text?` |
| `tool_result` | `call_id`, `name`, `ok`, `result?`, `error?`, `duration_ms?`, `text?` |
| `notice` | `text`, `severity`('info'\|'warn'), `subtype?` |
| `summary` | `text`, `subtype?`, `is_error?`, `duration_ms?` |

> 注：`kind: 'progress'` 的项**不会**走 activity payload。
> - **interactive**：被拦截转成任务状态 notify（见 §1，`status:'progress'`）。
> - **proactive**：直接丢弃，既不发 activity 也不发 `status:'progress'`（见 §4）。

### Evol App 需要做的事
1. 监听 `type:'activity'`，从 **`item`** 读取内容（不再是 `items[0]`）。
2. 共用元信息（`task_id`/`chatmode` 等）从**顶层**读，不再从 `client_context`。
3. UI 上按到达顺序逐条 append（不再是一次性整批渲染）。
4. 区分 proactive / interactive：
   - **proactive**：走 `message.thought.put` / `group.thought.put`（thought 实时渲染，不入历史）
   - **interactive**：走可靠投递（outbox → `message.send` / `group.send`，入消息历史）
   - 两种模式 payload 结构一致，仅传输 RPC 不同。

---

## 3. 系统通知 / 错误：纯文本 → 结构化 🟠

旧：`system.notice` / `system.error` / `result.error` 三种都当**纯文本**用 `sendMessage` 发出（与普通回复无异）。
新：改为**结构化 payload**，通过可靠投递发送。

三者顶层都带与 §2 activity 相同的共用字段（`task_id`/`session_id`/`agent_name`/`chatmode`/`thread_id`/`initiator`/`ref_message_id`，存在时附带），下面示例用 `"...": "..."` 略去。

### system.notice
```json
{
  "type": "notice",
  "...": "...",
  "subtype": "<子类型>",
  "text": "<文本>",
  "severity": "info"
}
```

### system.error
```json
{
  "type": "error",
  "...": "...",
  "subtype": "<子类型>",
  "message": "<文本>",
  "user_message": "<文本>",
  "recoverable": true,
  "terminal": false
}
```
（`terminal = !recoverable`）

### result.error
```json
{
  "type": "error",
  "...": "...",
  "reason": "<原因>",
  "message": "<文本>",
  "user_message": "<文本>",
  "terminal": true
}
```

### Evol App 需要做的事
- 识别 `type:'notice'` 和 `type:'error'`，按结构化字段渲染（severity / recoverable / terminal）。
- 旧客户端若只认纯文本：`notice` 仍有 `text`，`error` 用 `message`/`user_message` 承载可读文本，可作降级展示。

---

## 4. proactive 模式：不再下发 `status:'progress'` 🟠

proactive 模式下，过程信息由 **thought（`type:'activity'`）** 完整表达，因此**不再额外下发** `status:'progress'` 任务状态。

### 行为变更

| 事件 | interactive | proactive（旧） | proactive（新） |
|------|-------------|-----------------|-----------------|
| text / tool_call / tool_result | `status:'progress'` + activity | `status:'progress'` + activity | **仅 activity**（去掉 progress） |
| `task_progress`（子任务进度） | `status:'progress'` | `status:'progress'` | **完全丢弃**（无 progress 无 activity） |

旧逻辑下 proactive 每个事件会**双发**：一条 `status:'progress'`（结构化状态字段）+ 一条 `type:'activity'`（可读内容）。两者职责不同但内容场景重叠，proactive 下统一只保留 activity。

### 与状态信号的边界

本变更**只移除 proactive 下的 `status:'progress'`**，不影响任务生命周期信号：`status:'started'` / `'completed'` / `'interrupted'` / `'error'` / `'queued'`（由 message-processor 发送）在两种模式下**均照常下发**。Evol App 仍可据此驱动 loading 起止。

### Evol App 需要做的事
- **proactive 模式**：不要依赖 `status:'progress'` 渲染进度，进度信息从 `type:'activity'` 的逐条流中获取。
- 任务是否在跑、是否结束，仍以 `status:'started'`/`terminal` 系列信号为准（不受影响）。
- **interactive 模式**：`status:'progress'` 行为不变。

---

## 未变更（仍兼容）的部分

- **最终回复** `result.text` / `command.result` / `command.error`：仍走 `sendMessage`，纯文本，`isFinal` 时带标题「✅ 最终回复:」。
- **文件** `result.file`：仍走 `sendFile`。
- **图片** `result.image`：仍走 `sendContentPayload`，`type:'image'` + `data_base64` + `mime_type` + `alt`。
- **交互卡片** `interaction`：仍是 `type:'action_card'`。

---

## 字段映射速查表（旧 → 新）

| 语义 | 旧字段 | 新字段 |
|------|--------|--------|
| 状态消息类型 | `type:'status'` | `type:'task.status'`（且改走 notify） |
| 状态阶段 | `state` | `status` |
| 状态终态标记 | （无） | `terminal` |
| 被回复消息 ID | `ref_message_id` | `ref_message_id`（保留，存在时附带） |
| 活动消息类型 | `type:'thought'` | `type:'activity'` |
| 活动内容 | `items[]`（数组） | `item`（单对象） |
| 活动元信息 | `client_context.{...}` | 顶层平铺 `task_id`/`session_id`/`agent_name`/`chatmode`/`thread_id`/`initiator`/`ref_message_id` |
| 系统通知 | 纯文本 | `type:'notice'` |
| 系统/结果错误 | 纯文本 | `type:'error'` |

---

## 迁移建议（Evol App 侧）

1. **优先适配 §1（task.status notify）**——破坏性最大，旧逻辑完全收不到状态。
2. 适配 §2（activity）——改读 `item`，按逐条流式渲染。
3. 适配 §3（notice/error）——结构化渲染，保留纯文本降级。
4. 回归验证：proactive 与 interactive 两种 chatmode 各跑一遍，确认 thought.put 与 message.send 两条链路都正确解析。
