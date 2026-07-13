# 消息记录（Message Log）

## 概述

在每个 session store path 下持久化收发消息记录，格式为 JSONL（一行一条），文件名 `messages.jsonl`。

```
{EVOLCLAW_HOME}/data/sessions/{channel}/{selfId}/{channelId}/messages.jsonl
```

## 记录结构

```jsonc
{
  "ts": 1716000000000,           // Unix 毫秒时间戳
  "time": "2026-05-16 14:30:00", // 人类可读时间（本地时区）
  "dir": "in",                   // "in" 收 | "out" 发
  "from": "toleiliang.agentid.pub",
  "to": "toleiliang5.agentid.pub",
  "chatType": "group",           // "private" | "group"
  "groupId": "group.agentid.pub/11117", // 群聊时的群 ID，单聊为 null
  "msgId": "msg-uuid-001",       // 消息唯一 ID
  "msgType": "text",             // "text" | "image" | "file" | "command"
  "content": "帮我看看这个bug",   // 消息正文
  "replyTo": null,               // 引用的 msgId（回复场景）
  "agent": null,                 // 出方向时用的 agent 后端（如 "claude"）
  "model": null,                 // 出方向时用的模型（如 "sonnet"）
  "permMode": null,              // 当时的权限模式
  "cmdParsed": null,             // 如果是命令，记录命令名（如 "/switch"）
  "durationMs": null             // 出方向时 agent 处理耗时（毫秒）
}
```

## 字段说明

| 字段 | 类型 | 方向 | 说明 |
|------|------|:----:|------|
| `ts` | number | 双向 | Unix 毫秒时间戳，用于排序和计算 |
| `time` | string | 双向 | `YYYY-MM-DD HH:mm:ss` 格式，快速浏览用 |
| `dir` | `"in"` \| `"out"` | 双向 | 消息方向 |
| `from` | string | 双向 | 发送方标识（AID / userId） |
| `to` | string | 双向 | 接收方标识（AID / userId） |
| `chatType` | `"private"` \| `"group"` | 双向 | 聊天类型 |
| `groupId` | string \| null | 双 | 群聊时的群 ID |
| `msgId` | string | 双向 | 消息唯一 ID，用于去重和引用 |
| `msgType` | string | 双向 | 消息类型 |
| `content` | string | 双向 | 消息正文（出方向为完整回复文本） |
| `replyTo` | string \| null | 双向 | 被引用消息的 msgId |
| `agent` | string \| null | out | agent 后端名称 |
| `model` | string \| null | out | 模型标识 |
| `permMode` | string \| null | in | 入方向时的权限模式 |
| `cmdParsed` | string \| null | in | 命令名（`/switch`、`/new` 等） |
| `durationMs` | number \| null | out | agent 处理耗时 |

## 设计决策

1. **Append-only JSONL**：无锁写入，崩溃安全（最多丢最后一条不完整行）
2. **每条自包含**：`from`/`to` 每条完整写入，单条可独立理解
3. **与 session-fs-store 复用**：使用已有的 `appendJsonl` 工具函数
4. **写入时机**：
   - 入方向：`MessageBridge` 构造完 `Message` 后立即写入
   - 出方向：`MessageProcessor` 完成处理后写入（包含 durationMs）
5. **不阻塞主流程**：写入失败只 log warning，不影响消息处理
6. **只保存消息历史**：`menu.*`、`activity*`、`status*`、`event(s)*`、`task.status*`、`thought`、`handoff_state/result` 等协议与运行状态仅不写入 `messages.jsonl`，协议处理、传输和可观测性不受影响
7. **handoff 正文仍是消息**：跨会话请求、对端回复和回流正文按普通消息保存；只允许附带 v2 `handoff_trace` 关联信息，不保存旧 `handoff` metadata 或状态事件

## 协议与运行状态的观测位置

| 类型 | 处理/观测位置 | 持久化范围 |
|------|---------------|------------|
| `menu.*` | `logs/channel-in-*.log`、`logs/channel-out-*.log`、`logs/evolclaw-*.log` | 原始请求、响应和执行决策；不进入会话正文 |
| `status.*` / `task.status` | `logs/channel-out-*.log`、`logs/evolclaw-*.log`、AUN `notify.task_status` trace、AID 运行统计 | 任务状态实时传输与短期运行日志 |
| `activity.*` | `logs/channel-out-*.log`；runner 事件另见 `logs/events-*.log` | 工具调用、工具结果和进度事件 |
| `thought` | AUN `thought.put`、`logs/events-*.log` 的 `message:thought-put`、`logs/evolclaw-*.log`、内存统计 | 实时 thought 与事件审计，不进入会话正文 |
| 入站 `event(s).*` | `logs/evolclaw-*.log` 的 AUN dispatch/drop 决策；开启 AUN trace 时另见 `logs/aun-*.log` | 协议接收与过滤决策 |
| handoff 状态/结果 | `data/handoff/<aid>/handoffs/<handoff_id>/handoff.json`、`data/handoff/<aid>/history.jsonl`，通过 `ec handoff status/list/trace` 查询 | durable 权威状态与 append-only 审计历史 |

`logs/channel-in/out` 默认按小时轮转并保留 24 小时；`events` 日志由 `EVENT_LOG=true` 启用，daemon 默认开启。上述日志是协议观测面，`messages.jsonl` 是会话正文面，两者不可混用。

## 实现位置

- 类型定义与统一过滤：`src/core/message/message-log.ts`
- 写入调用点：
  - 入方向：`src/core/message/message-bridge.ts`（Message 构造后）
  - 出方向：`src/core/message/response-engine.ts` 与各渠道发送实现
