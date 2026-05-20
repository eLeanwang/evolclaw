# 出站消息统一设计方案

**Status**: Implemented（全三阶段完成）
**Date**: 2026-05-16 / Last updated: 2026-05-20
**Scope**: 定义 EvolClaw 出站消息三件套（Event / Payload / Envelope），让 channel 层基于消息语义按需订阅和渲染

---

## 1. 背景与目标

EvolClaw 出站路径统一改造，已完成。原有问题：`StreamFlusher` 混合处理文本片段和工具活动，`ThoughtEmitter` 自定义 stage 分类与 SDK 事件无对应关系，`ChannelAdapter` 接口按能力拆分（sendText/sendFile/sendImage/sendProcessingStatus）导致 channel 实现者无法按语义组合消息。

**解决方案**：定义出站三件套（Event → Payload → Envelope），channel 层基于消息语义（payload.kind）按需渲染，而非按传输能力硬编码。工具活动结构化为 `activity.batch + ThoughtItem[]`，AUN 渠道双发 thought 通道，非 AUN 渠道降级为文本拼接。

---

## 2. 核心概念

| 概念 | 职责 | 生产者 | 消费者 |
|---|---|---|---|
| **Event** | 内部领域事件，描述"发生了什么" | Runner / Channel / Queue / Gateway | IMRenderer |
| **Payload** | 出站语义类型，描述"要传达什么" | IMRenderer（投影 Event） | ChannelAdapter |
| **Envelope** | 上下文信封，描述"在什么场景下" | IMRenderer（附加上下文） | ChannelAdapter |

流向：

```
Runner / Channel / Queue / Gateway
        │
        ▼ emit Event
   ┌─────────────┐
   │  IMRenderer  │  投影 + 聚合 + 抑制
   └─────────────┘
        │
        ▼ send(Envelope, Payload)
   ┌─────────────────┐
   │  ChannelAdapter  │  按 capabilities 降级渲染
   └─────────────────┘
        │
        ▼ 协议原生消息
   Feishu / WeChat / AUN / ...
```

三者关系：Event 是原材料，IMRenderer 是加工厂（决定哪些 Event 产出 Payload、哪些被抑制、哪些被聚合），Envelope 是每个出站包裹的运单。

---

## 3. Event 完整定义

Event 是系统内部的领域事件，按产出方分九类。每类只列代码中真实存在或明确将要实现的事件。

> **命名约定**：文档统一用点号分隔（`runner.text.delta` / `session.created`），EventBus TypeScript 字面量则用冒号（`runner:text.delta` / `session:created`）。两者一一对应，仅分隔符差异。

### 3.1 RunnerEvent（AI 后端执行流）

来源：`src/agents/*-runner.ts` 的 `transformStream()`。

| Event | 关键字段 | 说明 |
|---|---|---|
| `runner.text.delta` | `text: string` | 流式文本片段 |
| `runner.text.done` | `text: string` | 完整文本（最终拼接结果） |
| `runner.thinking` | `text: string` | reasoning 过程 |
| `runner.tool_use` | `tool: string, input: object` | 工具调用 |
| `runner.tool_result` | `tool: string, output: string, ok: boolean` | 工具结果 |
| `runner.session_id` | `sessionId: string` | 会话 ID 通知 |
| `runner.complete` | `isError: boolean, subtype?: string, durationMs: number` | 执行结束 |
| `runner.error` | `message: string, recoverable: boolean` | 运行时错误 |
| `runner.compact-start` | `sessionId, preTokens?: number` | 上下文压缩开始（UI 显示压缩中占位） |
| `runner.compact-complete` | `sessionId, preTokens: number, postTokens?: number` | 上下文压缩完成 |
| `runner.task_progress` | `summary?: string, toolUses?: number, durationMs?: number` | 子任务进度（claude-runner） |
| `runner.permission_request` | `toolName: string, input: object, requestId: string` | Agent 申请工具权限（→ interaction） |
| `runner.permission_resolved` | `requestId: string, approved: boolean` | 权限审批回调（仅 events.log，不出站） |
| `runner.permission_timeout` | `requestId: string` | 权限审批超时（仅 events.log，不出站） |
| `runner.state_changed` | `state: 'idle' \| 'running' \| 'requires_action'` | Agent 状态机转移（不出站，仅 events.log） |
| `runner.status` | `subtype: string, message: string` | Agent 状态文本通知（reset / abort / safe 等） |
| `runner.idle-timeout` | `sessionId: string, idleSec: number` | 空闲监控告警（warn/notify=任务继续，kill=强制中断） |
| `runner.file-sent` | `filePath: string, channel: string` | SEND_FILE 标记处理成功的副作用事件 |
| `runner.model-changed` | `model: string` | `/model` 切换模型（命令回显已覆盖，仅 events.log） |

### 3.2 ChannelEvent（渠道状态）

来源：`src/channels/*.ts`。具体原因下沉到字段。

| Event | 关键字段 | 说明 |
|---|---|---|
| `channel.connected` | `channel: string` | 连接成功 |
| `channel.disconnected` | `channel: string, reason?: string` | 断开 |
| `channel.notice` | `channel: string, severity: 'info' \| 'warn', subtype: string` | 信息类（token_refreshed / session_paused / session_resumed / chat_dissolved / owner_bound） |
| `channel.error` | `channel: string, subtype: string, recoverable: boolean` | 错误类（auth_failed / session_expired / poll_failed） |

### 3.3 InboundEvent（入站消息）

来源：channel 收到消息时。事件按类型分，内容下沉到 `type` 字段。

| Event | 关键字段 | 说明 |
|---|---|---|
| `inbound.message` | `type: 'text' \| 'file' \| 'image' \| 'audio' \| 'video', content: object` | 收到消息 |
| `inbound.recall` | `messageId: string` | 撤回 |
| `inbound.interaction_response` | `requestId: string, result: object` | 交互卡片回调 |

`content` 按 `type` 变化：
- `text`: `{ text, mentions? }`
- `file`: `{ filePath, fileName, mimeType }`
- `image`: `{ filePath, mimeType }`
- `audio` / `video`: `{ filePath, duration }`

### 3.4 ControlEvent（agent CLI → IPC）

来源：`aun-cli` 经 IPC。

| Event | 关键字段 | 说明 |
|---|---|---|
| `ctl.send` | `type: 'text' \| 'file' \| 'image', content: object, channelId?: string` | 主动发送 |

`content` 按 `type` 变化：
- `text`: `{ text }`
- `file`: `{ filePath }`
- `image`: `{ data }`

### 3.5 TaskEvent（消息队列状态机）

来源：`message-queue.ts` + runner。

| Event | 关键字段 | 说明 |
|---|---|---|
| `task.enqueued` | `taskId, position` | 入队 |
| `task.started` | `taskId, sessionId` | 开始执行 |
| `task.interrupted` | `taskId, reason` | 被中断 |
| `task.completed` | `taskId, durationMs` | 正常完成 |
| `task.error` | `taskId, error` | 异常终止 |
| `task.timeout` (预留) | `taskId, idleSec` | 超时强制中断（由 runner.idle-timeout kill 投影） |

### 3.6 SessionEvent（会话管理）

来源：`session-manager.ts` + 命令。

| Event | 关键字段 | 说明 |
|---|---|---|
| `session.created` | `sessionId, projectPath, name?` | 新建（含 `/new` 清除后新建） |
| `session.switched` | `sessionId, fromSessionId, toSessionId` | `/s` 切换激活 |
| `session.deleted` | `sessionId` | `/del` 删除 |
| `session.renamed` | `sessionId, oldName, newName` | `/name` 重命名 |
| `session.forked` | `sessionId, sourceSessionId, name?` | `/fork` 分叉 |
| `session.rewind` | `sessionId, turnNum, mode` | `/rewind` 回退 |
| `session.imported` | `sessionId, agentSessionId, projectPath` | `/resume` 导入 SDK 会话 |
| `session.safe-mode-entered` | `sessionId, consecutiveErrors?, reason?` | 连续错误进入安全模式 |
| `session.safe-mode-exited` | `sessionId, method?` | `/safe` 退出 |
| `session.chat-mode-changed` | `sessionId, mode` | `/chatmode` 切换（interactive/proactive） |
| `session.dispatch-mode-changed` | `sessionId, mode` | `/dispatch` 切换（mention/all） |

### 3.7 ProjectEvent（项目管理）

来源：`/bind` + `/project` 命令。

| Event | 关键字段 | 说明 |
|---|---|---|
| `project.bound` | `projectPath, name?` | 新项目绑定 |
| `project.switched` | `fromPath, toPath` | 切换当前项目 |

### 3.8 EvolAgentEvent（EvolAgent 生命周期）

来源：`agent-registry.ts`。

| Event | 关键字段 | 说明 |
|---|---|---|
| `evolagent.created` | `name, config` | 新建 |
| `evolagent.loaded` | `name, channels` | 启动扫描加载 |
| `evolagent.reloaded` | `name, changes` | 热重载 |
| `evolagent.deleted` | `name` | 删除 |
| `evolagent.notice` | `name, subtype, metadata` | 信息类（owner_bound / route_updated） |
| `evolagent.error` | `name, subtype, message` | 错误类（fingerprint_conflict / config_invalid） |

### 3.9 SystemEvent（网关生命周期）

来源：`index.ts` + `cli.ts`。SystemEvent 在文档语义上聚合了 EventBus 的 `SystemEvent` / `SelfHealEvent` / `ConfigEvent` 三类——出站时统一收敛到 `system.notice` / `system.error`。

| Event | 关键字段 | 说明 |
|---|---|---|
| `system.started` | `version, channels, agents` | 启动完成 |
| `system.shutdown` | `reason` | 关闭 |
| `system.restart` | `channel, channelId` | `/restart` 命令触发的重启完成 |
| `system.notice` | `subtype, metadata` | 信息类（restarted / self_heal_started / self_heal_attempt / self_heal_succeeded / config_changed）；来源含 SelfHealEvent |
| `system.error` | `subtype, message, recoverable` | 错误类（self_heal_failed / config_corrupted / fatal）；来源含 SelfHealEvent / ConfigEvent |

---

## 4. OutboundPayload 完整定义

OutboundPayload 是 IMRenderer 投影后交给 ChannelAdapter 的出站语义类型。13 个 kind，按用途分七组。

### 4.1 任务流·结果（Agent 最终输出）

| kind | 字段 | 说明 |
|---|---|---|
| `result.text` | `text: string, isFinal: boolean, format?: 'markdown' \| 'plain'` | 文本回复。isFinal=false 为流式片段，true 为最终回复 |
| `result.file` | `filePath: string, fileName?: string, targetChannel?: string` | 文件输出。fileName 为展示名，缺省取 basename(filePath) |
| `result.image` | `data: Buffer, mimeType?: string, alt?: string` | 图片输出。alt 为无障碍描述 |
| `result.error` | `text: string, reason?: string` | 任务失败终结 |

### 4.2 任务流·中间过程（受 showActivities 抑制）

中间过程统一用 `activity.batch` 承载，内部是 `ThoughtItem[]` 结构化数组。IMRenderer 在聚合窗口（interactive）或逐事件（proactive）触发时构造 batch payload 发出。非 AUN 渠道通过 `formatItemsAsText()` helper 把 items 降级为纯文本发送。

```typescript
// ThoughtItem 联合类型（src/types.ts）
type ThoughtItem =
  | { kind: 'thinking'; text: string; duration_ms?: number }          // 流式文本 delta
  | { kind: 'reasoning'; text: string; duration_ms?: number }         // 模型内部推理（reasoning block）
  | { kind: 'tool_call'; call_id: string; name: string; arguments?: Record<string, unknown>; text?: string }
  | { kind: 'tool_result'; call_id: string; name: string; ok: boolean; result?: unknown; error?: string; duration_ms?: number; text?: string }
  | { kind: 'progress'; text: string; state?: 'processing' \| 'waiting'; tool_uses?: number; duration_ms?: number }
  | { kind: 'notice'; text: string; severity: 'info' \| 'warn'; subtype?: string }
  | { kind: 'summary'; text: string; subtype?: string; is_error?: boolean; duration_ms?: number };  // runner.complete 映射
```

| kind | 字段 | 说明 |
|---|---|---|
| `activity.batch` | `items: ThoughtItem[]` | 聚合的结构化思考/工具活动。AUN 渠道走 thought 通道双发（见§8），非 AUN 渠道降级为文本拼接 |

### 4.3 任务流·状态信号

| kind | 字段 | 说明 |
|---|---|---|
| `status.started` | `metadata?: {}` | 任务开始 |
| `status.completed` | `metadata?: { durationMs?: number }` | 正常完成 |
| `status.interrupted` | `metadata?: { reason: string }` | 被中断 |
| `status.error` | `metadata?: { errorType?: string }` | 异常终止 |
| `status.timeout` | `metadata?: { idleSec?: number }` | 超时终止 |

> **AUN 双发**：AUN 渠道的 `status.*` 当前采用兼容过渡方案，串行发送两条消息：①旧路 `{ type: 'event', event: 'task.*', ... }`（前后兼容），②新路 `{ type: 'status', state, task_id, severity }`（下游直接读字段，无需解析 event 字符串）。旧路在前端全面迁移到新路后废弃。

### 4.4 命令回显

| kind | 字段 | 说明 |
|---|---|---|
| `command.result` | `text: string, format?: 'markdown' \| 'plain'` | 命令执行成功 |
| `command.error` | `text: string, reason?: string` | 命令执行失败 |

> ✅ **Phase 3 完成**：`MessageBridge.handleCommand` 已改走 `adapter.send(envelope, { kind: 'command.result' | 'command.error', text })`，渠道层按 kind 自行决定呈现形式。

### 4.5 交互

| kind | 字段 | 说明 |
|---|---|---|
| `interaction` | `interaction: InteractionRequest, fallbackText?: string` | 需要用户操作（权限审批 / 问题确认 / 计划审批等） |

### 4.6 任务流外通知

| kind | 字段 | 说明 |
|---|---|---|
| `system.notice` | `text: string, subtype: 'welcome' \| 'restarted' \| 'background' \| 'shutdown' \| 'reconnect' \| 'health' \| 'self_heal_started' \| 'self_heal_attempt' \| 'self_heal_succeeded' \| 'config_changed'` | 系统通知 |
| `system.error` | `text: string, subtype: 'auth_failed' \| 'channel_down' \| 'agent_error' \| 'self_heal_failed' \| 'config_corrupted' \| 'fatal', recoverable?: boolean` | 系统错误 |

### 4.7 渠道私有扩展

| kind | 字段 | 说明 |
|---|---|---|
| `custom` | `channelType: string, payload: unknown` | 渠道自定义，不经过通用投影 |

### Event → Payload → AUN type 映射

一张表对齐三方：内部 Event 来源、投影后的 Payload kind、序列化到 AUN 协议的 payload.type。

> **`self-heal.*` / `config.*` 命名说明**：这两类在 §3.9 已被收敛到 `system.notice` / `system.error` 出站，但 EventBus 内部仍是独立类（`SelfHealEvent` / `ConfigEvent`）。本表保留原始事件名以便对照代码追溯，实施时按 Payload kind 列出站。

| Event | → Payload kind | → AUN payload.type | 备注 |
|---|---|---|---|
| `runner.text.delta` | `result.text (isFinal=false)` | `text` | payload 带 `is_final: false`，流式片段 |
| `runner.text.done` | `result.text (isFinal=true)` | `text` | payload 带 `is_final: true`，最终文本 |
| `runner.thinking` | `activity.batch { items: [{ kind:'thinking', text }] }` | `thought` | 流式文本 delta；proactive 逐条 thought.put，interactive 聚合后双发 |
| `runner.tool_use` | `activity.batch { items: [{ kind:'tool_call', call_id, name, arguments }] }` | `thought` | 结构化工具调用；proactive 逐条，interactive 聚合后双发 |
| `runner.tool_result` | `activity.batch { items: [{ kind:'tool_result', call_id, name, ok, result? }] }` | `thought` | 结构化工具结果；proactive 逐条，interactive 聚合后双发 |
| `runner.complete` | `activity.batch { items: [{ kind:'summary', text }] }` (proactive) | `thought` | proactive 模式下 complete 映射为 summary item；interactive 模式最终文本走 result.text |
| `runner.error` | `result.error` | `text` | 任务失败的人类可读描述（状态信号由 status.error 表达） |
| `runner.compact-start` | （仅 events.log） | — | 压缩开始信号，前端可显示占位（不出站到聊天） |
| `runner.compact-complete` | `activity.batch { items: [{ kind:'notice', subtype:'compact' }] }` | `thought` | severity=info；带 preTokens |
| `runner.task_progress` | `activity.batch { items: [{ kind:'progress', text, tool_uses, duration_ms }] }` | `thought` | subtask 阶段汇报 |
| `runner.permission_request` | `interaction` | `action_card` | Agent 申请工具权限（入站回调 action_card_reply → InteractionRouter） |
| `runner.state_changed` | （仅 events.log） | — | Agent 状态机内部事件，不出站 |
| `task.started` | `status.started` | `event` + `status` | 双发：旧路 event=task.started（兼容）+ 新路 type=status state=started |
| `task.completed` | `status.completed` | `event` + `status` | 双发：event=task.completed + type=status state=completed |
| `task.interrupted` | `status.interrupted` | `event` + `status` | 双发：event=task.interrupted + type=status state=interrupted |
| `task.error` | `status.error` | `event` + `status` | 双发：event=task.error + type=status state=error, severity=error |
| `task.timeout` | `status.timeout` | `event` + `status` | 双发：event=task.timeout + type=status state=timeout |
| `ctl.send (type=text)` | `result.text (isFinal=true)` | `text` | proactive 主动发送 |
| `ctl.send (type=file)` | `result.file` | `file` | 带 attachments |
| `ctl.send (type=image)` | `result.image` | `image` | 带 attachments |
| `channel.notice` | `system.notice` | `event` | severity=info |
| `channel.notice (subtype=owner_bound)` | `system.notice (subtype=owner_bound)` | `event` | 首次交互自动绑定 owner 通知 |
| `channel.error` | `system.error (subtype=channel_down)` | `event` | severity=error；AUN 重连失败、跨通道 auth_error 告警 |
| `system.started` | `system.notice (subtype=restarted)` | `event` | agent 上线通知（adapter.send，走 system.notice 路径） |
| `system.shutdown` | `system.notice (subtype=shutdown)` | `event` | severity=info |
| `system.restart` | `system.notice (subtype=restarted)` | `event` | /restart 命令触发的重启完成 |
| `system.notice` | `system.notice` | `event` | severity=info |
| `system.error` | `system.error` | `event` | severity=error |
| `self-heal.started` | `system.notice (subtype=self_heal_started)` | `event` | 自愈开始 |
| `self-heal.attempt` | `system.notice (subtype=self_heal_attempt)` | `event` | 单次重试 |
| `self-heal.completed (success=true)` | `system.notice (subtype=self_heal_succeeded)` | `event` | 自愈成功 |
| `self-heal.completed (success=false)` | `system.error (subtype=self_heal_failed)` | `event` | 自愈失败，recoverable=false |
| `config.corrupted` | `system.error (subtype=config_corrupted)` | `event` | 配置文件损坏，已备份 |
| `evolagent.error` | `system.error (subtype=agent_error)` | `event` | fingerprint_conflict / config_invalid 等启动失败 |
| `evolagent.reloaded` | `command.result` | `text` | owner 主动 reload 的命令回显（不单独发通知） |
| `runner.idle-timeout` (warn/notify) | `activity.batch { items: [{ kind:'notice', subtype:'health' }] }` | `thought` | 任务流内告警，任务继续 |
| `runner.idle-timeout` (kill) | `status.timeout` | `event` + `status` | event=task.timeout 双发，强制中断 |
| `runner.file-sent` | （仅 events.log） | — | SEND_FILE 副作用事件，不出站 |
| `runner.model-changed` | `command.result` | `text` | /model 命令回显已覆盖；Event 仅 events.log |
| `runner.status` | `activity.batch { items: [{ kind:'notice' }] }` | `thought` | reset / abort / safe 等 Agent 状态文本通知 |
| 命令成功 | `command.result` | `text` | 命令回显 |
| 命令失败 | `command.error` | `text` | 命令错误 |
| 子任务进度 | `activity.batch { items: [{ kind:'progress' }] }` | `thought` | state=processing, 带 progress |
| SessionEvent (created/switched/deleted/renamed/forked/rewind/imported/safe-mode-*/chat-mode-changed/dispatch-mode-changed) | `command.result` | `text` | 命令触发，回显已覆盖；Event 本身仅用于 events.log 落盘 |
| ProjectEvent (bound/switched) | `command.result` | `text` | 同上 |
| 渠道扩展 | `custom` | `custom` | 透传 |

---

## 5. OutboundEnvelope 定义

每个出站消息都携带一个信封：

```typescript
interface OutboundEnvelope {
  taskId: string;
  channel: string;
  channelId: string;
  agentName: string;
  chatmode: 'interactive' | 'proactive';
  replyContext?: ReplyContext;
  timestamp: number;
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `taskId` | MessageQueue 分配 | 关联同一次任务的所有 payload；任务流外用固定值 `_system` |
| `channel` | ChannelAdapter.channelName | 路由到哪个 adapter |
| `channelId` | 入站消息携带 | 发回哪个对话 |
| `agentName` | EvolAgent.name | 多 agent 并行时标识来源 |
| `chatmode` | Session 配置 | 决定 IMRenderer 投影策略 |
| `replyContext` | Channel 入站时预构建 | 透传给 adapter，core 不解读 |
| `timestamp` | IMRenderer emit 时 | 排序 / 审计 |

---

## 6. 处理规则（chatmode × kind）

| kind | interactive | proactive |
|---|---|---|
| `result.text (isFinal=true)` | adapter.send → AUN message.send type=text | adapter.send → AUN message.send type=text |
| `result.text (isFinal=false)` | IMRenderer 聚合为 thinking item（isFinal flush 时单独发 result.text） | activity.batch items=[{kind:'thinking'}] → adapter.send |
| `result.file` | adapter.send → AUN message.send type=file（降级文本路径） | adapter.send → AUN message.send type=file |
| `result.image` | adapter.send → AUN message.send type=image（降级丢弃） | adapter.send → AUN message.send type=image |
| `result.error` | adapter.send（必发） | adapter.send（必发） |
| `activity.batch` | IMRenderer 聚合窗口 → adapter.send（AUN 双发 thought 通道；其他渠道文本拼接） | IMRenderer 逐事件 → adapter.send（AUN thought.put；其他渠道文本拼接） |
| `status.*` | adapter.send（AUN 双发 event+status；非 AUN 无操作） | adapter.send（同左） |
| `command.result` | adapter.send（必发） | adapter.send（必发） |
| `command.error` | adapter.send（必发） | adapter.send（必发） |
| `interaction` | adapter.send（必发；降级发 fallbackText） | adapter.send（必发；降级发 fallbackText） |
| `system.notice` | adapter.send（必发） | adapter.send（必发） |
| `system.error` | adapter.send（必发） | adapter.send（必发） |
| `custom` | adapter.send → 渠道自行处理 | adapter.send → 渠道自行处理 |

**抑制规则**（由 IMRenderer 的 suppressActivities 控制）：
- `suppressActivities=true`：activity.batch 的 tool_call/tool_result/progress/notice 被丢弃（text items 仍收集用于 result.text final flush）
- `suppressActivities=false`（默认）：interactive 下全部聚合发送，proactive 下全部 thought 通道

**必发内容**（不受 suppressActivities 影响）：`result.error` / `command.*` / `interaction` / `system.*` / `status.*`

---

## 7. 完整示例：AUN 私聊端到端

场景：owner 在 AUN 私聊（interactive 模式）让 agent 读取一个文件并总结内容。

### 入站

```
用户发送: "帮我总结一下 ./README.md"
```

**InboundEvent**:
```json
{ "type": "inbound.message", "content": { "type": "text", "text": "帮我总结一下 ./README.md" } }
```

### 任务流

**TaskEvent / RunnerEvent 序列**：

```
task.enqueued      → { taskId: "t-001", position: 0 }
task.started       → { taskId: "t-001" }
runner.thinking    → { text: "用户要求总结 README.md，我需要先读取文件内容" }
runner.tool_use    → { tool: "Read", input: { file_path: "./README.md" } }
runner.tool_result → { tool: "Read", output: "# EvolClaw\n...", ok: true }
runner.text.delta  → { text: "这是一个轻量级 AI Agent 网关系统" }
runner.text.delta  → { text: "，主要功能包括：\n1. 多后端支持..." }
runner.text.done   → { text: "这是一个轻量级 AI Agent 网关系统，主要功能包括：\n1. 多后端支持..." }
runner.complete    → { isError: false, durationMs: 3200 }
task.completed     → { taskId: "t-001", durationMs: 3200 }
```

### IMRenderer 投影

| Event | → Payload | 行为（interactive） |
|---|---|---|
| `task.started` | `status.started` | AUN 双发：event=task.started + type=status state=started |
| `runner.thinking` | thinking item 进入 itemsQueue | 抑制（showActivities=result，isFinal flush 时只发 result.text） |
| `runner.tool_use` | `activity.batch { items: [{ kind:'tool_call', call_id:'c1', name:'Read', arguments:{...} }] }` | 加入聚合窗口 |
| `runner.tool_result` | `activity.batch { items: [{ kind:'tool_result', call_id:'c1', name:'Read', ok:true }] }` | 加入聚合窗口 |
| 聚合窗口到期 | — | flush → send（AUN 双发 thought.put + message.send type=thought） |
| `runner.text.delta` ×2 | thinking item 进入 itemsQueue | 聚合后与其他 items 一起 flush |
| `runner.text.done` | `result.text { isFinal: true, text: "..." }` | flush → send（AUN: text），isFinal=true 单独发 message.send type=text |
| `task.completed` | `status.completed { metadata: { durationMs: 3200 } }` | AUN 双发：event=task.completed + type=status state=completed |

### ChannelAdapter 出站（AUN）

AUN adapter 收到 `send(envelope, payload)` 后转为 AUN 协议原生消息：

```javascript
// status.started → event + status 双发
rpc("message.send", { to: peer, payload: {
  type: "event", event: "task.started", severity: "info",
  data: { task_id: "t-001" }, thread_id: "t-001"
}})
rpc("message.send", { to: peer, payload: {
  type: "status", state: "started",
  task_id: "t-001", session_id: "...", severity: "info", thread_id: "t-001"
}})

// activity.batch → thought 类型（双发：thought.put 实时渲染 + message.send 历史持久化）
rpc("message.thought.put", { to: peer,
  context: { type: "task", id: "t-001" },
  payload: {
    type: "thought",
    items: [
      { kind: "tool_call", call_id: "c1", name: "Read", arguments: { file_path: "./README.md" } },
      { kind: "tool_result", call_id: "c1", name: "Read", ok: true, result: "# EvolClaw..." }
    ],
    client_context: { task_id: "t-001", chatmode: "interactive", agent_name: "..." }
  }
})
rpc("message.send", { to: peer, payload: {
  type: "thought",
  items: [/* 同上 */],
  thread_id: "t-001",
  client_context: { task_id: "t-001", chatmode: "interactive", agent_name: "..." }
}})

// result.text (isFinal) → text 类型
rpc("message.send", { to: peer, payload: {
  type: "text", text: "这是一个轻量级 AI Agent 网关系统，主要功能包括：...",
  format: "markdown", thread_id: "t-001",
  client_context: { task_id: "t-001", chatmode: "interactive" }
}})

// status.completed → event + status 双发
rpc("message.send", { to: peer, payload: {
  type: "event", event: "task.completed", severity: "info",
  data: { task_id: "t-001", duration_ms: 3200 }, thread_id: "t-001"
}})
rpc("message.send", { to: peer, payload: {
  type: "status", state: "completed",
  task_id: "t-001", session_id: "...", severity: "info", thread_id: "t-001"
}})
```

---

## 8. ChannelAdapter 接口

Phase 3 已完成。旧的分散方法（sendText/sendFile/sendImage/sendProcessingStatus/sendCustomPayload/sendInteraction/putThought）已全部删除，接口收敛为：

```typescript
interface ChannelAdapter {
  readonly channelName: string;
  readonly capabilities: ChannelCapabilities;  // 必填

  /** 统一出站入口（必填） */
  send(envelope: OutboundEnvelope, payload: OutboundPayload): Promise<void>;

  /** 入站回调（可选） */
  acknowledge?(messageId: string): Promise<void>;
  onInteraction?(callback: (response: InteractionResponse) => void): void;
  onChatDissolved?(callback: (channelId: string) => void): void;

  /** 连接管理（可选） */
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;

  /** AUN 协议私有扩展（可选） */
  uploadAgentMd?(content: string): Promise<void>;
  downloadAgentMd?(aid: string): Promise<string>;
}

interface ChannelCapabilities {
  file: boolean;          // 支持文件发送
  image: boolean;         // 支持图片发送
  interaction: boolean;   // 支持交互卡片
  markdown: boolean;      // 支持 markdown 渲染
  thought: boolean;       // 支持 thought 通道（AUN 双发）
  status: boolean;        // 支持处理状态信号（typing / 表情 / 结构化事件）
}
```

### 降级矩阵

| kind | 需要能力 | 降级方式 |
|---|---|---|
| `result.file` | `file` | 输出文件路径文本 |
| `result.image` | `image` | 丢弃 |
| `interaction` | `interaction` | 发送 fallbackText 纯文本 |
| `result.text (format=markdown)` | `markdown` | 转 plain text |
| `status.*` | `status` | 有能力：按渠道方式表达（typing / 表情 / 事件）；无能力：无操作 |
| `activity.batch`（thought=false） | `thought` | `formatItemsAsText(items)` 拼文本后发送 |
| `activity.batch`（thought=true，AUN） | `thought` | 双发：thought.put（实时渲染）+ message.send type=thought（历史持久化） |

### AUN send() 分发规则

AUN 渠道的 `send(envelope, payload)` 按 payload.kind 内部分发：

| payload.kind | AUN RPC | AUN payload.type | 备注 |
|---|---|---|---|
| `result.text` / `command.*` / `system.*` / `result.error` | `message.send` / `group.send` | `text` | 带 client_context |
| `result.file` | `message.send` + storage.put | `file` | 带 attachments |
| `result.image` | `message.send` | `image` | base64 编码 |
| `activity.batch` | `thought.put` + `message.send`（双发） | `thought` | items 数组，见下方 thought payload 格式 |
| `status.*` | `message.send`（双发） | `event` + `status` | 兼容过渡，两路并行 |
| `interaction` | `message.send` | `action_card` | fallbackText 降级 |
| `custom` | `message.send` | 透传 payload 字符串 | menu.query 响应等 |

### 各渠道能力声明

| 渠道 | file | image | interaction | markdown | thought | status |
|---|---|---|---|---|---|---|
| AUN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（结构化事件） |
| Feishu | ✓ | ✓ | ✓ | ✓ | ✗ | ✓（✓ 表情） |
| WeChat | ✗ | ✗ | ✗ | ✗ | ✗ | ✓（sendTyping） |
| DingTalk | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| QQBot | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| WeCom | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |

WeChat 当前仅文本 + typing，CDN 下载已实现（入站 image/file），出站 image/file 是后续迭代方向。

### AUN 序列化规则

AUN 协议的 `payload` 是任意 JSON 对象，服务端只做大小和可序列化检查，不校验业务字段。

#### thought payload（activity.batch）

`activity.batch` 在 AUN 渠道双发为 `type: 'thought'` 消息：

```javascript
// thought.put（前端实时渲染，不进消息历史）
client.call('message.thought.put', {
  to: targetAid,
  context: { type: 'task', id: envelope.taskId },  // 顶层 selector
  encrypt: shouldEncrypt,
  payload: {
    type: 'thought',
    items: payload.items,   // ThoughtItem[]
    client_context: {
      task_id: envelope.taskId,
      chatmode: envelope.chatmode,
      agent_name: envelope.agentName,
    }
  }
})

// message.send（消息历史持久化）
client.call('message.send', {
  to: targetAid,
  payload: {
    type: 'thought',
    items: payload.items,
    thread_id: envelope.replyContext?.threadId,
    client_context: {
      task_id: envelope.taskId,
      chatmode: envelope.chatmode,
      agent_name: envelope.agentName,
    }
  }
})
```

**ThoughtItem 字段映射**：

| item.kind | AUN 字段 |
|---|---|
| `thinking` | `{ kind, text, duration_ms? }` |
| `reasoning` | `{ kind, text, duration_ms? }` |
| `tool_call` | `{ kind, call_id, name, arguments?, text? }` |
| `tool_result` | `{ kind, call_id, name, ok, result?, error?, duration_ms?, text? }` |
| `progress` | `{ kind, text, state?, tool_uses?, duration_ms? }` |
| `notice` | `{ kind, text, severity, subtype? }` |
| `summary` | `{ kind, text, subtype?, is_error?, duration_ms? }` |

#### status 双发

`status.*` 在 AUN 渠道串行发送两条消息（event 在前，status 在后）：

```javascript
// 旧路（兼容）
{ type: 'event', event: 'task.started', severity: 'info', data: { task_id, session_id }, thread_id? }
// 新路（结构化）
{ type: 'status', state: 'started', task_id, session_id, severity: 'info', thread_id? }
```

状态映射：`start→started`, `done→completed`, `interrupted→interrupted`, `error→error`, `timeout→timeout`

#### 通用消息（text / file / system）

```javascript
client.call('message.send', {
  to: targetAid,
  encrypt: shouldEncrypt,
  payload: {
    type: 'text',          // 或 'file' / 'event' 等
    text: payload.text,
    thread_id: envelope.replyContext?.threadId,
    client_context: {
      task_id: envelope.taskId,
      chatmode: envelope.chatmode,
      agent_name: envelope.agentName,
    }
  }
})
```
---

## 9. 改造范围与迁移路径

### 9.1 IMRenderer — 统一出站投影器

`stream-flusher.ts` 和 `thought-emitter.ts` 已删除，功能合并到 `src/core/message/im-renderer.ts`。

**IMRenderer 职责**（✅ 已实现）：
- 接收 AgentEvent 流，按 chatmode 投影
- interactive 模式：聚合窗口 → `activity.batch { items: ThoughtItem[] }` → `adapter.send`
- proactive 模式：逐事件 → 单条 `activity.batch` → `adapter.send`（fire-and-forget）
- 旁路 `logger.event()` 落盘 `events.log`
- 生命周期：per-task（processMessage 入口创建，出口销毁）

**降级路径**（由各渠道 `send()` 内部处理）：
- AUN（thought=true）：双发 thought.put + message.send type=thought
- 其他渠道（thought=false）：`formatItemsAsText(items)` 拼文本后 sendMessage

### 9.2 InteractionRouter 保留

InteractionRouter 是入站关联器（card action callback → pending request），不属于出站投影。保持不动。

### 9.3 events.log 旁路

IMRenderer 的 `emit()` 调用 `logger.event()` 落盘 `logs/events.log`（受 `EVENT_LOG=true` 环境变量控制）。每个 AgentEvent 都会旁路记录，用于调试和审计。

### 9.4 ChannelAdapter 接口收敛

✅ 已完成。旧分散方法全部删除，各渠道统一实现 `send(envelope, payload)` + switch payload.kind 内部分发。
见 §8 接口定义。

### 9.5 三阶段实施

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 1：协议定义** | 新增 `OutboundPayload` / `OutboundEnvelope` / `ChannelCapabilities` / `ThoughtItem` 类型到 `src/types.ts` | ✅ 完成 |
| **Phase 2：IMRenderer** | 新增 `src/core/message/im-renderer.ts`，替代 StreamFlusher + ThoughtEmitter；思考/工具活动结构化为 `activity.batch + ThoughtItem[]`；EventBus 事件改名（agent:* → runner:*、message:* → task:*） | ✅ 完成 |
| **Phase 3：Adapter 收敛** | 各渠道实现统一 `send()` 签名；旧分散方法（sendText/sendFile/sendImage/sendProcessingStatus/sendCustomPayload/sendInteraction/putThought）全部删除；命令回显 / 系统通知 / interaction 卡片迁移到 `adapter.send`；AUN status 双发（type=event + type=status）；AUN thought 双发（thought.put + message.send） | ✅ 完成 |

**当前状态**：全三阶段已完成。`ChannelAdapter` 接口只剩 `send` / `capabilities` + 入站回调 + 连接管理 + AUN 私有扩展。所有出站通过 `adapter.send(envelope, payload)` 统一分发，渠道按 capabilities 自行决定呈现（结构化 / 文本降级）。
