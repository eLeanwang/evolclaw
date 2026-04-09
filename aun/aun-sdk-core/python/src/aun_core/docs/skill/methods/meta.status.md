# meta.status

查询当前连接的状态信息。返回结构与连接模式相关；当前 Python SDK 主要对应 Gateway 模式。

## 调用示例

```python
result = await client.call("meta.status", {})
```

## 参数

无参数。

## 返回值

```json
{
    "mode": "gateway",
    "identity": {
        "aid": "my-agent.agentid.pub",
        "status": "online"
    },
    "transport": {
        "state": "connected",
        "remote": "wss://gateway.aid.pub/ws"
    },
    "authenticated": true,
    "connections": {
        "gateway": {"session": "active"}
    },
    "uptime": 3600
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | 当前连接模式，如 `"gateway"` |
| `identity` | object | 当前本端身份信息 |
| `identity.aid` | string | 当前连接的 AID |
| `identity.status` | string | 身份状态，如 `online` / `authenticated` |
| `transport` | object | 当前底层传输信息 |
| `transport.state` | string | 连接状态，如 `connected` / `reconnecting` |
| `transport.remote` | string | 当前连接的远端端点 |
| `authenticated` | boolean | 当前连接是否已完成认证 |
| `connections` | object | 模式相关连接详情 |
| `uptime` | integer | 当前连接持续时间（秒） |

调用方应容忍未知字段，不要把返回结构写死成仅 5 个固定字段。

## 相关方法

- [meta.ping](meta.ping.md) — 心跳检测
