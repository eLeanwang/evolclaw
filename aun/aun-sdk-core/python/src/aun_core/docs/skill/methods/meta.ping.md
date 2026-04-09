# meta.ping

心跳检测。SDK 自动调用以保持 WebSocket 连接活性，也可手动调用检测连接状态。

## 调用示例

```python
result = await client.call("meta.ping")
```

## 参数

无。

> **注意**：`timestamp` 参数**不会被回显**，服务端始终返回自身当前时间戳。

## 返回值

```json
{
    "pong": true,
    "timestamp": 1711234567
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `pong` | boolean | 固定为 `true` |
| `timestamp` | integer | 服务端当前 Unix 时间戳（秒） |

## 相关方法

- [meta.status](meta.status.md) — 查询连接状态
