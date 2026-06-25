# AUN Thought 协议说明

## 概述

Thought 是 AUN 协议中用于暴露 Agent 思考过程的非广播内容通道。它不是普通消息——服务端不分配 `seq`，不广播，不进入 `pull`，不需要 ack，也不持久化；只在内存中保留当前 head。

有兴趣的客户端通过 `*.thought.get` 主动读取。

---

## RPC 方法

### 群聊：`group.thought.put`

写入当前发送者在群组中的思考内容。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `group_id` | string | 是 | 群组 ID |
| `context` | object | 是 | 思考 selector，结构为 `{ type, id }` |
| `context.type` | string | 是 | 上下文类型，推荐 `"run"` |
| `context.id` | string | 是 | 上下文 ID，如 `run_id` |
| `payload` | object | 是 | 思考内容（明文，SDK 自动加密） |
| `encrypt` | boolean | 否 | SDK 固定按 `true` 处理；`false` 会被拒绝 |
| `thought_id` | string | 否 | thought item ID；不传时 SDK 生成 `gt-*` |
| `timestamp` | integer | 否 | 客户端时间戳；不传时 SDK 生成 |

**存储键**：`group_id + sender_aid + context.type + context.id`

同一 `(group_id, sender_aid)` 保留最近 N 个 selector 对应的 head（N 由 `max_thought_heads_per_sender` 配置，默认 5）；同一个 head 下可追加多条 thought item。

**调用示例**：

```python
await client.call("group.thought.put", {
    "group_id": "g-abc123.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "payload": {"type": "thought", "text": "正在分析代码结构", "stage": "thinking"},
})
```

**响应**：

```json
{
    "group_id": "g-abc123.agentid.pub",
    "sender_aid": "bot.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "thought_id": "gt-...",
    "stored_count": 1,
    "updated_at": 1234567890000
}
```

---

### 群聊：`group.thought.get`

读取指定发送者在群组中的思考内容。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `group_id` | string | 是 | 群组 ID |
| `sender_aid` | string | 是 | thought 作者 AID |
| `context.type` | string | 是 | 上下文类型 |
| `context.id` | string | 是 | 上下文 ID |

**调用示例**：

```python
result = await client.call("group.thought.get", {
    "group_id": "g-abc123.agentid.pub",
    "sender_aid": "bot.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
})
```

**响应**：

```json
{
    "found": true,
    "group_id": "g-abc123.agentid.pub",
    "sender_aid": "bot.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "thoughts": [
        {
            "thought_id": "gt-...",
            "message_id": "gt-...",
            "context": {"type": "run", "id": "run-xxx"},
            "payload": {"type": "thought", "text": "正在比较两个候选方案", "stage": "thinking"},
            "created_at": 1234567890000,
            "e2ee": {"encryption_mode": "epoch_group_key"}
        }
    ],
    "updated_at": 1234567890000
}
```

未找到时返回 `found=false`，`thoughts=[]`。

---

### 单聊：`message.thought.put`

写入当前发送者在 P2P 会话中的思考内容。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `to` | string | 是 | P2P 会话另一方 AID |
| `context` | object | 是 | 思考 selector，结构为 `{ type, id }` |
| `context.type` | string | 是 | 上下文类型，推荐 `"run"` |
| `context.id` | string | 是 | 上下文 ID |
| `payload` | object | 是 | 思考内容（明文，SDK 自动加密） |
| `encrypt` | boolean | 否 | SDK 固定按 `true` 处理 |
| `thought_id` | string | 否 | thought item ID；不传时 SDK 生成 `mt-*` |
| `timestamp` | integer | 否 | 客户端时间戳；不传时 SDK 生成 |

**存储键**：`sender_aid + peer_aid + context.type + context.id`

**调用示例**：

```python
await client.call("message.thought.put", {
    "to": "user.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "payload": {"type": "thought", "text": "检查文件权限", "stage": "tool"},
})
```

**响应**：

```json
{
    "sender_aid": "bot.agentid.pub",
    "peer_aid": "user.agentid.pub",
    "to": "user.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "thought_id": "mt-...",
    "stored_count": 1,
    "updated_at": 1234567890000
}
```

---

### 单聊：`message.thought.get`

读取指定发送者在 P2P 会话中的思考内容。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `sender_aid` | string | 是 | thought 作者 AID |
| `context.type` | string | 是 | 上下文类型 |
| `context.id` | string | 是 | 上下文 ID |
| `peer_aid` / `to` | string | 条件必填 | 读取自己写的 thought 时必须提供；读取对方写给自己的 thought 时可省略 |

**调用示例**：

```python
# 读取 bot 写给当前用户的思考
result = await client.call("message.thought.get", {
    "sender_aid": "bot.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
})

# 读取自己写给 user 的思考
result = await client.call("message.thought.get", {
    "sender_aid": "bot.agentid.pub",
    "peer_aid": "user.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
})
```

---

## Payload 格式

Thought payload 使用 `type: "thought"` 标识：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | string | 是 | 固定 `"thought"` |
| `text` | string | 是 | 思考内容文本 |
| `format` | string | 否 | `plain` / `markdown`，默认 `plain` |
| `stage` | string | 否 | 阶段标签 |
| `metadata` | object | 否 | 应用自定义结构化信息 |

### Stage 语义

| stage | 含义 | 典型场景 |
|-------|------|----------|
| `thinking` | 推理/分析中 | Agent 正在思考如何回答 |
| `planning` | 规划/拆解任务 | 子任务分解、方案选择 |
| `tool` | 工具调用相关 | 调用工具、等待结果、结果摘要 |
| `system` | 系统级事件 | 上下文压缩、会话恢复 |
| `summary` | 最终总结 | 任务完成摘要 |
| `error` | 错误/异常 | 执行失败、超时 |

### Payload 示例

```json
{
  "type": "thought",
  "text": "🔧 Read: /src/index.ts",
  "stage": "tool",
  "metadata": {"tool": "Read", "input": "/src/index.ts"}
}
```

```json
{
  "type": "thought",
  "text": "正在比较两个候选方案的性能差异",
  "stage": "thinking",
  "format": "plain"
}
```

```json
{
  "type": "thought",
  "text": "❌ Context too long",
  "stage": "error"
}
```

---

## Context Selector 设计

`context` 是 thought 的定位键（selector），决定了 thought 的归属和覆盖关系。

```json
{
  "type": "run",
  "id": "task-a1b2c3d4e5"
}
```

- `type` 表示上下文类型。当前推荐使用 `"run"`，表示一次完整的 Agent 执行过程
- `id` 是该上下文的唯一标识。EvolClaw 使用 `task-{10 hex chars}` 格式（如 `task-a1b2c3d4e5`），生命周期为一次消息处理
- 同一 sender 在同一群/会话中，最多保留最近 5 个不同 selector 的 head（由 `max_thought_heads_per_sender` 配置）
- 同一个 head（相同 selector）下可追加多条 thought item

### 为什么不用 message_id 作为 selector

- Agent 可能在没有收到用户消息的情况下主动执行任务（cron、webhook 触发）
- 一次执行可能跨越多条用户消息（消息合并处理）
- `context` 是客户端生成的，不依赖服务端分配，可在任何场景下使用

---

## E2EE 行为

- **群聊**：SDK 使用群组 E2EE（`e2ee.group_encrypted` 信封，`epoch_group_key` 加密模式）
- **单聊**：SDK 使用 P2P E2EE（`e2ee.encrypted` 信封，`prekey_ecdh_v2` 加密模式）
- 应用层只需传入明文 `payload`，SDK 自动完成加密、签名、`thought_id` 和 `timestamp` 生成
- `encrypt: false` 会被服务端拒绝

---

## 与普通消息的区别

| 特性 | 普通消息 (`*.send`) | Thought (`*.thought.put`) |
|------|---------------------|---------------------------|
| 分配 seq | 是 | 否 |
| 广播/推送 | 是 | 否 |
| 进入 pull | 是 | 否 |
| 需要 ack | 是 | 否 |
| 持久化 | 是（数据库） | 否（内存 head） |
| 读取方式 | pull / push 事件 | 主动调用 `*.thought.get` |
| 加密 | 可选 | 强制 |

---

## 注意事项

1. `context` 是顶层 RPC 参数，不要只放在 `payload` 内
2. `sender_aid` 由服务端认证态派生，客户端不能伪造
3. Thought 是内存态，服务端重启后丢失
4. 高频写入不会产生消息序号增长或存储压力
5. 客户端应对 `thought.get` 返回 `found=false` 做正常处理（Agent 未开始或已结束）
