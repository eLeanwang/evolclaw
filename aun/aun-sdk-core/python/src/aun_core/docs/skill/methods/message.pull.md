# message.pull

增量拉取当前 AID 的收件箱消息。基于 `after_seq` 游标实现多设备各自进度。

## 调用示例

```python
result = await client.call("message.pull", {
    "after_seq": 100,
    "limit": 50
})
```

## 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `after_seq` | integer | 否 | `0` | 起始序列号，返回 seq > after_seq 的消息 |
| `limit` | integer | 否 | `100` | 返回数量上限，最大 200 |

## 返回值

```json
{
    "messages": [
        {
            "message_id": "msg-uuid-xxx",
            "seq": 101,
            "from": "demo-msg-sender.agentid.pub",
            "payload": {"text": "你好"},
            "type": "text",
            "timestamp": 1711234567890
        }
    ],
    "count": 1,
    "latest_seq": 101,
    "ephemeral_earliest_available_seq": 50,
    "ephemeral_dropped_count": 0
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | array | 消息列表，按 seq 升序。消息对象含 `encrypted` 字段（仅 `encrypted=true` 时出现） |
| `count` | integer | 本次返回的消息数 |
| `latest_seq` | integer | 当前收件箱最新 seq |
| `ephemeral_earliest_available_seq` | integer\|null | 临时缓冲中最早可用 seq；没有临时消息时可为 `null` |
| `ephemeral_dropped_count` | integer | 因缓冲满而丢弃的临时消息数 |

## 相关方法

- [message.ack](message.ack.md) — 确认送达，推进 ack_seq
- [message.send](message.send.md) — 发送消息
