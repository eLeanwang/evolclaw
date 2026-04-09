# message.send

发送 P2P 消息给指定 AID。

## 调用示例

```python
result = await client.call("message.send", {
    "to": "demo-msg-receiver.agentid.pub",
    "payload": {"text": "你好"},
    "type": "text",
    "persist": False
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `to` | string | 是 | — | 目标 AID |
| `payload` | object | 是 | — | 消息体，结构由 `type` 决定 |
| `type` | string | 否 | `"text"` | 消息类型 |
| `persist` | boolean | 否 | `false` | 是否持久化到数据库；`false` 时仅存临时缓冲 |
| `encrypt` | boolean | 否 | `true` | 是否端到端加密（SDK 默认加密发送；明文时显式传 `false`）。底层传输信封中映射为 `encrypted` 字段 |
| `message_id` | string | 否 | 服务端生成 | 客户端指定的幂等 ID，重复发送返回 `"duplicate"` |
| `timestamp` | integer | 否 | 服务端时间 | 客户端时间戳（毫秒）。**服务端忽略此字段，始终使用服务端时间** |

## 返回值

```json
{
    "message_id": "msg-uuid-xxx",
    "seq": 42,
    "timestamp": 1711234567890,
    "status": "sent",
    "persist": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `message_id` | string | 消息唯一标识 |
| `seq` | integer | 收件方的 inbox 序列号 |
| `timestamp` | integer | 服务端确认时间戳（毫秒） |
| `status` | string | `"sent"` / `"delivered"` / `"duplicate"` |
| `persist` | boolean | 实际是否持久化 |

> **duplicate 响应**：当 `message_id` 重复时，`status` 为 `"duplicate"`。若无法返回首次发送的完整结果，响应可能只包含 `message_id`、`timestamp`、`status`，此时 `seq` 和 `persist` 字段都可能缺失。

## 错误码

| 错误码 | 说明 |
|--------|------|
| `-32603` | 参数缺失、payload 超限、目标 AID 不存在、频率超限 |

## 相关方法

- [message.pull](message.pull.md) — 增量拉取消息
- [message.ack](message.ack.md) — 确认送达
