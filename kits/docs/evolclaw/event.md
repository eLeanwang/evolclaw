# ec trigger event - EventBus 事件目录

本目录用于编写 `source.type = "event"` 的 trigger 时按需查阅。最终事实源是
`$PACKAGE_ROOT/src/core/event-bus.ts` 的 `GatewayEvent` 类型；本文只做面向 trigger
作者的事件索引和使用约定。

## Event Source 规则

`source.eventPattern` 支持三种形式：

| 形式 | 示例 | 含义 |
|------|------|------|
| 精确事件名 | `message:received` | 只监听这一种事件 |
| 命名空间前缀 | `task:*` | 监听该命名空间下所有事件 |
| 全量 | `*` | 监听所有 EventBus 事件，需谨慎使用 filter |

`source.filter.match` 用事件 payload 的字段路径做匹配，支持：

| 操作 | 示例 |
|------|------|
| 等值 | `{ "channel": "feishu" }` |
| `$in` | `{ "toolName": { "$in": ["Bash", "Edit"] } }` |
| `$regex` | `{ "content": { "$regex": "^/echo" } }` |
| 数值比较 | `{ "durationMs": { "$gte": 30000 } }` |
| 存在性 | `{ "userId": { "$exists": true } }` |

字段路径支持点号，例如 `replyContext.threadId`。禁止使用 `__proto__`、`prototype`、
`constructor` 路径段。

## 循环防护

监听 `trigger:*` 时，系统默认禁止 trigger 响应自身产生的 trigger 事件：
当事件带有 `originTriggerId` 且等于当前 trigger id 时，该事件会被跳过。

跨 trigger 的链式触发仍然允许。需要追踪链路时使用：

| 字段 | 含义 |
|------|------|
| `runId` | 本次 trigger run 的唯一 ID |
| `originTriggerId` | 产生当前 `trigger:*` 事件的 trigger id |

## 常用事件

| 事件 | 常见用途 |
|------|----------|
| `message:received` | 用户消息触发自动化 |
| `task:completed` | agent 完成回复后触发后处理 |
| `task:error` | agent 任务失败后触发诊断或告警 |
| `permission:requested` | 观察权限请求 |
| `permission:cancelled` | 权限请求因中断等原因被取消 |
| `runner:model-changed` | 模型或推理强度变化后同步状态 |
| `agent:*` | agent 生命周期、配置变化、运行态变化 |
| `trigger:*` | trigger 编排、链式触发、审计 |

## 事件目录

### system

| 事件 | Payload |
|------|---------|
| `system:started` | `{ channels, timestamp }` |
| `system:shutdown` | `{ reason?, timestamp? }` |
| `system:restart` | `{ channel, channelId }` |

### channel

| 事件 | Payload |
|------|---------|
| `channel:connected` | `{ channel, channelName?, timestamp? }` |
| `channel:disconnected` | `{ channel, channelName?, reason? }` |
| `channel:error` | `{ channel, channelName?, status, message, timestamp? }` |
| `channel:owner-bound` | `{ channel, channelName?, userId }` |

### session

| 事件 | Payload |
|------|---------|
| `session:created` | `{ sessionId, channel, channelName?, channelId, projectPath?, name?, chatType?, threadId?, timestamp? }` |
| `session:switched` | `{ sessionId, fromSessionId, toSessionId }` |
| `session:deleted` | `{ sessionId }` |
| `session:renamed` | `{ sessionId, oldName, newName }` |
| `session:forked` | `{ sessionId, sourceSessionId, name? }` |
| `session:rewind` | `{ sessionId, turnNum, mode }` |
| `session:imported` | `{ sessionId, agentSessionId, projectPath }` |
| `session:chat-mode-changed` | `{ sessionId, mode, timestamp? }` |
| `session:dispatch-mode-changed` | `{ sessionId, mode, timestamp? }` |

### message

| 事件 | Payload |
|------|---------|
| `message:received` | `{ sessionId, channel, channelName?, channelId, content, userId?, agentName?, timestamp? }` |
| `message:text` | `{ sessionId, text, isFinal }` |
| `message:thought-put` | `{ agentName, channelId, taskId?, text? }` |

### task

| 事件 | Payload |
|------|---------|
| `task:started` | `{ sessionId, agentName?, encrypt?, chatmode? }` |
| `task:queued` | `{ channel, channelId, replyContext? }` |
| `task:completed` | `{ sessionId, channel, channelName?, channelId, finalText?, durationMs?, terminalReason?, agentName?, numTurns?, timestamp? }` |
| `task:error` | `{ sessionId, error, errorType, terminalReason?, agentName? }` |
| `task:interrupted` | `{ sessionId, reason?, agentName? }` |

### tool

| 事件 | Payload |
|------|---------|
| `tool:use` | `{ sessionId, toolName, input, timestamp? }` |
| `tool:result` | `{ sessionId, toolName, isError?, agentName?, timestamp? }` |

### permission

| 事件 | Payload |
|------|---------|
| `permission:requested` | `{ sessionId, requestId, toolName, input }` |
| `permission:resolved` | `{ sessionId, requestId, approved }` |
| `permission:cancelled` | `{ sessionId, requestId, toolName?, reason? }` |

### runner

| 事件 | Payload |
|------|---------|
| `runner:compact-start` | `{ sessionId }` |
| `runner:compact-complete` | `{ sessionId, preTokens }` |
| `runner:model-changed` | `{ sessionId?, agentName?, baseagent?, model?, effort?, timestamp? }` |
| `runner:idle-timeout` | `{ sessionId, idleSec }` |
| `runner:idle-notify` | `{ sessionId, idleSec, totalEvents, totalToolCalls, lastToolName? }` |
| `runner:idle-warn` | `{ sessionId, idleSec, totalEvents, totalToolCalls, lastToolName? }` |
| `runner:file-sent` | `{ sessionId, filePath, channel, channelName? }` |
| `runner:state-changed` | `{ sessionId, state }` |
| `runner:status` | `{ sessionId, subtype, message, timestamp? }` |

### self-heal

| 事件 | Payload |
|------|---------|
| `self-heal:started` | `{ reason }` |
| `self-heal:attempt` | `{ attemptNumber, maxAttempts }` |
| `self-heal:completed` | `{ success, attempts }` |

### trigger

| 事件 | Payload |
|------|---------|
| `trigger:registered` | `{ triggerId, name, peerId?, targetChannel?, targetChannelId?, scheduleType, scheduleValue, timestamp? }` |
| `trigger:updated` | `{ triggerId, name, peerId?, scheduleType, scheduleValue, timestamp? }` |
| `trigger:fired` | `{ triggerId, name, runId, originTriggerId, fireTime, targetChannel?, targetChannelId?, scheduleType, timestamp? }` |
| `trigger:completed` | `{ triggerId, name, runId, originTriggerId, messageId, durationMs, targetChannel, targetChannelId, fireTime }` |
| `trigger:failed` | `{ triggerId, name, runId, originTriggerId, messageId, error, targetChannel, targetChannelId, fireTime, phase }` |
| `trigger:skipped` | `{ triggerId, name, runId, originTriggerId, reason, targetChannel, targetChannelId, fireTime? }` |
| `trigger:cancelled` | `{ triggerId, name, by }` |

### agent

| 事件 | Payload |
|------|---------|
| `agent:created` | `{ aid, name?, baseagent?, projectPath?, owner?, timestamp? }` |
| `agent:updated` | `{ aid, timestamp? }` |
| `agent:reloaded` | `{ aid, timestamp? }` |
| `agent:enabled` | `{ aid, reloaded?, timestamp? }` |
| `agent:disabled` | `{ aid, reloaded?, timestamp? }` |
| `agent:deleted` | `{ aid, purged?, timestamp? }` |
| `agent:started` | `{ aid, timestamp? }` |
| `agent:stopped` | `{ aid, timestamp? }` |
| `agent:error` | `{ aid, action?, error, timestamp? }` |
| `agent:baseagent-changed` | `{ aid, baseagent, previousBaseagent?, scope, timestamp? }` |

## 示例

监听飞书用户消息：

```json
{
  "source": {
    "type": "event",
    "eventPattern": "message:received",
    "filter": {
      "match": {
        "channel": "feishu",
        "content": { "$regex": "^/echo" }
      }
    }
  }
}
```

监听非自身产生的 trigger 完成事件：

```json
{
  "source": {
    "type": "event",
    "eventPattern": "trigger:completed",
    "filter": {
      "match": {
        "targetChannel": { "$exists": true }
      }
    }
  }
}
```

## 不存在或已移除的事件

不要使用这些历史设计稿中出现过的事件：

| 事件 | 替代 |
|------|------|
| `message:sent-out` | 使用 `task:completed` |
| `permission:timeout` | 当前权限不会 timeout；取消用 `permission:cancelled` |
| `session:safe-mode-entered` / `session:safe-mode-exited` | 已移除 |
| `project:switched` / `project:bound` | 已移除 |
| `config:corrupted` | 已移除 |
| `agent:create-failed` | 使用 `agent:error` 且 `action = "create"` |
