# 消息 — RPC Manual

## 消息存储模型

| 类型 | `persist` | 存储位置 | 生命周期 | 适用场景 |
|------|-----------|---------|---------|---------|
| 临时消息 | `false`（默认） | 内存环形缓冲 | 5 分钟 / 200 条每 AID | Agent 间实时交互、有时效性的请求/响应 |
| 持久化消息 | `true` | 数据库 | TTL 过期前持久保存（默认 24h，`ttl_hours` 可调） | 离线送达、历史查询 |

临时消息超出时间窗口或条数限制后自动淘汰，`message.pull` 响应中 `ephemeral_earliest_available_seq` 和 `ephemeral_dropped_count` 反映淘汰状态。

---

## 方法索引

| 方法 | 说明 |
|------|------|
| [message.send](#messagesend) | 发送消息 |
| [message.pull](#messagepull) | 增量拉取消息 |
| [message.ack](#messageack) | 确认送达 |
| [message.recall](#messagerecall) | 撤回消息 |

## 事件索引

| 事件 | 说明 |
|------|------|
| [event/message.received](#eventmessagereceived) | 收到新消息 |
| [event/message.ack](#eventmessageack) | 消息被确认 |
| [event/message.recalled](#eventmessagerecalled) | 消息被撤回 |

---

## message.send

发送一条 P2P 消息。

### 请求

```json
{
    "jsonrpc": "2.0",
    "method": "message.send",
    "params": {
        "to": "bob.agentid.pub",
        "payload": {"text": "Hello!"},
        "persist": false,
        "ttl_hours": 24,
        "encrypted": false,
        "message_id": "550e8400-e29b-41d4-a716-446655440000",
        "type": "text",
        "timestamp": 1234567890000
    },
    "id": 1
}
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `to` | string | 是 | — | 接收方 AID |
| `payload` | object | 是 | — | 消息内容（任意 JSON 对象） |
| `type` | string | 否 | — | 消息类型（应用层自定义） |
| `persist` | boolean | 否 | `false` | 是否持久化 |
| `ttl_hours` | number | 否 | `24` | 持久化消息存活时间（小时），仅 `persist=true` 时生效 |
| `encrypted` | boolean | 否 | `false` | E2EE 标记 |
| `message_id` | string | 否 | — | 幂等键（客户端提供或服务端生成 UUID） |
| `timestamp` | integer | 否 | — | 客户端时间戳（毫秒）。**服务端忽略此字段，始终使用服务端时间** |

### 附件引用

大文件、二进制附件不应直接嵌入 `payload`，应先通过 `storage.*` 上传，再在 `payload.attachments` 中携带对象引用：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 对象下载地址（`storage.*` 返回） |
| `filename` | string | 否 | 原始文件名 |
| `size` | integer | 否 | 文件大小（字节） |
| `sha256` | string | 否 | 内容哈希，用于完整性校验 |
| `content_type` | string | 否 | MIME 类型 |

> 服务端对 `payload` 内容透传，不校验附件结构。上述字段为应用层推荐规范，确保客户端互操作。

### 响应

```json
{
    "jsonrpc": "2.0",
    "result": {
        "message_id": "550e8400-e29b-41d4-a716-446655440000",
        "seq": 42,
        "timestamp": 1234567890000,
        "status": "delivered",
        "persist": false
    },
    "id": 1
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `message_id` | string | 消息 ID |
| `seq` | integer | 接收方收件箱序号 |
| `timestamp` | integer | 服务端时间戳（毫秒） |
| `status` | string | `"sent"` / `"delivered"` / `"duplicate"` |
| `persist` | boolean | 是否持久化 |

> **duplicate 响应**：当 `message_id` 重复时，若服务端仍缓存首次结果，返回完整首次响应并附加 `"status": "duplicate"`；若缓存已过期，仅返回 `message_id`、`timestamp`、`status`，**不含** `seq` 和 `persist`。客户端收到 `"duplicate"` 状态时应视为幂等成功，无需重试。

### 错误

| code | 说明 |
|------|------|
| -32603 | 参数缺失（to 或 payload） |
| -32603 | payload 超过大小限制（默认 1 MB） |
| -32603 | 目标 AID 不存在 |
| -32603 | 频率限制超限 |

### 示例

```python
result = await client.call("message.send", {
    "to": "bob.agentid.pub",
    "payload": {"text": "Hello!"},
})
# result: {"message_id": "...", "seq": 42, "status": "delivered", ...}
```

---

## message.pull

按游标增量拉取消息。合并持久化消息和临时消息，按 seq 升序返回。

### 请求

```json
{
    "jsonrpc": "2.0",
    "method": "message.pull",
    "params": {
        "after_seq": 100,
        "limit": 50
    },
    "id": 2
}
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `after_seq` | integer | 否 | 0 | 拉取 seq > after_seq 的消息 |
| `limit` | integer | 否 | 100 | 单次返回上限（最大 200） |

### 响应

```json
{
    "jsonrpc": "2.0",
    "result": {
        "messages": [
            {
                "message_id": "uuid-1",
                "seq": 101,
                "from": "alice.agentid.pub",
                "to": "bob.agentid.pub",
                "type": "text",
                "timestamp": 1234567890000,
                "payload": {"text": "Hello!"},
                "persist": true,
                "encrypted": true
            }
        ],
        "count": 1,
        "latest_seq": 101,
        "ephemeral_earliest_available_seq": null,
        "ephemeral_dropped_count": 0
    },
    "id": 2
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | array | 消息列表（按 seq 升序）。消息对象含 `encrypted` 字段（仅 `encrypted=true` 时出现） |
| `count` | integer | 本次返回的消息数 |
| `latest_seq` | integer | 返回的最大 seq |
| `ephemeral_earliest_available_seq` | integer\|null | 临时缓冲中可用的最小 seq |
| `ephemeral_dropped_count` | integer | 已被淘汰的临时消息数 |

### 示例

```python
result = await client.call("message.pull", {"after_seq": 0, "limit": 20})
for msg in result["messages"]:
    print(f"{msg['from']}: {msg['payload']}")
```

---

## message.ack

确认已收到消息。推进接收方的 ack_seq 游标。

### 请求

```json
{
    "jsonrpc": "2.0",
    "method": "message.ack",
    "params": {
        "seq": 150
    },
    "id": 3
}
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `seq` | integer | 是 | — | 确认 seq ≤ 此值的所有消息 |

### 响应

```json
{
    "jsonrpc": "2.0",
    "result": {
        "success": true,
        "ack_seq": 150
    },
    "id": 3
}
```

### 副作用

确认成功后，服务端向**发送方**推送 `event/message.ack` 事件。

### 示例

```python
result = await client.call("message.ack", {"seq": 150})
# result: {"success": true, "ack_seq": 150}
```

---

## message.recall

撤回消息。仅发送方可撤回，受时间窗口限制（默认 2 分钟）。

### 请求

```json
{
    "jsonrpc": "2.0",
    "method": "message.recall",
    "params": {
        "message_ids": ["uuid-1", "uuid-2"]
    },
    "id": 6
}
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message_ids` | array | 是 | 要撤回的消息 ID 列表（最多 100 个） |

### 响应

```json
{
    "jsonrpc": "2.0",
    "result": {
        "success": true,
        "accepted": 2,
        "recalled": 1,
        "errors": [
            {"message_id": "uuid-2", "error": "expired"}
        ]
    },
    "id": 6
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 操作是否执行 |
| `accepted` | integer | 接收的 message_id 数 |
| `recalled` | integer | 实际撤回的数 |
| `errors` | array\|null | 失败项（`not_found` / `not_sender` / `already_recalled` / `expired`） |

### 副作用

撤回成功后，服务端向**接收方**推送 `event/message.recalled` 事件。

---

## event/message.received

收到新消息时推送。

### Payload

```json
{
    "message_id": "uuid-1",
    "from": "alice.agentid.pub",
    "to": "bob.agentid.pub",
    "type": "text",
    "seq": 42,
    "timestamp": 1234567890000,
    "payload": {"text": "Hello!"},
    "persist": false,
    "encrypted": false
}
```

### 订阅

```python
client.on("message.received", lambda msg: print(msg["payload"]))
```

---

## event/message.ack

消息被接收方确认时推送给**发送方**。

### Payload

```json
{
    "to": "bob.agentid.pub",
    "ack_seq": 150,
    "timestamp": 1234567890000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `to` | string | **确认方（接收方）AID** — 即执行 ack 操作的一方 |
| `ack_seq` | integer | 已确认的最大 seq |
| `timestamp` | integer | 服务端时间戳（毫秒） |

### 订阅

```python
client.on("message.ack", lambda ev: print(f"{ev['to']} 已确认到 seq {ev['ack_seq']}"))
```

---

## event/message.recalled

消息被发送方撤回时推送给**接收方**。

### Payload

```json
{
    "from": "alice.agentid.pub",
    "to": "bob.agentid.pub",
    "message_ids": ["uuid-1", "uuid-2"],
    "timestamp": 1234567890000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 发送方（撤回者）AID |
| `to` | string | 接收方 AID |
| `message_ids` | array | 被撤回的消息 ID 列表 |
| `timestamp` | integer | 服务端时间戳（毫秒） |

### 订阅

```python
client.on("message.recalled", lambda ev: print(f"{ev['from']} 撤回了 {len(ev['message_ids'])} 条消息"))
```
