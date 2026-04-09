# 连接管理

## 连接模式

当前仅支持 **Gateway 模式**：客户端通过网关中转与其他 AID 通信。

> Peer 模式（点对点直连）和 Relay 模式（中继转发）正在规划中。

## connect() 参数

```python
await client.connect({
    "access_token": "...",         # 必填，认证返回的访问令牌
    "gateway": "wss://...",        # 可选，显式覆盖 Gateway 地址
    "auto_reconnect": False,       # 可选，是否启用自动重连，默认 False
    "token_refresh_before": 60.0,  # 可选，令牌到期前多少秒开始刷新，默认 60.0
    "retry": {                     # 可选，重连策略配置
        "initial_delay": 0.5,      #   初始重连延迟（秒），默认 0.5
        "max_delay": 5.0,          #   最大重连延迟（秒），默认 5.0
    },
    "heartbeat_interval": 30.0,    # 可选，心跳间隔（秒），默认 30.0
    "timeouts": {                  # 可选，超时配置
        "connect": 5.0,            #   连接超时（秒）
        "call": 10.0,              #   RPC 调用超时（秒）
        "http": 30.0,              #   HTTP 请求超时（秒）
    },
})
```

如果此前已调用 `create_aid()` 或 `authenticate()`，SDK 会自动复用已发现并缓存的 Gateway，此时 `connect()` 只传 `access_token` 即可。

## 连接状态

连接生命周期包含以下状态：

```
idle → connecting → authenticating → connected → disconnected → reconnecting / closed
```

| 状态 | 说明 |
|------|------|
| `idle` | 初始状态，尚未调用 `connect()` |
| `connecting` | 正在建立 WebSocket 连接 |
| `authenticating` | WebSocket 已建立，正在进行网关认证握手 |
| `connected` | 认证成功，连接就绪，可收发消息 |
| `disconnected` | 连接断开（网络异常、服务端关闭等） |
| `reconnecting` | 启用 `auto_reconnect` 后，正在尝试重新连接 |
| `closed` | 主动调用 `close()` 关闭，不会自动重连 |

通过 `client.state` 随时获取当前状态：

```python
print(client.state)  # "connected"
```

## 心跳

SDK 自动管理心跳机制，保持连接活跃：

- 默认每 **30 秒**发送一次心跳
- 通过 `heartbeat_interval` 参数自定义间隔
- 心跳超时（连续未收到响应）将触发断线检测

## 令牌刷新提前量

SDK 会在 access token 过期前自动刷新。可通过 `token_refresh_before` 指定提前量，默认 **60 秒**。

```python
await client.connect({
    "access_token": auth["access_token"],
    "token_refresh_before": 120.0,
})
```

## 自动重连

启用 `auto_reconnect: True` 后，连接断开时 SDK 自动尝试重连：

- 采用**指数退避**策略，避免频繁重连
- 初始延迟 **0.5 秒**，逐次翻倍，最大 **5.0 秒**
- 重连成功后自动恢复 `connected` 状态
- 主动调用 `close()` 不会触发自动重连

```python
# 启用自动重连
await client.connect({
    "access_token": auth["access_token"],
    "auto_reconnect": True,
    "retry": {
        "initial_delay": 0.5,  # 首次重连等待 0.5 秒
        "max_delay": 5.0,      # 最大等待 5.0 秒
    },
})
```

## 事件

连接相关事件可通过 `client.on()` 订阅：

| 事件名 | 触发时机 | 回调参数 |
|--------|----------|----------|
| `connection.state` | 连接状态发生变化 | `{"state": "connected", "gateway": "wss://gw.example/ws"}` |
| `connection.error` | 连接发生错误 | `{"error": <Exception>, "attempt": 2}` |
| `token.refreshed` | 令牌自动刷新成功 | `{"aid": "alice.aid.pub", "expires_at": 1711234567}` |

```python
# 监听连接状态变化
async def on_state_change(data):
    print(f"当前状态: {data['state']}")

client.on("connection.state", on_state_change)

# 监听连接错误
async def on_error(data):
    print(f"连接错误: {data['error']}")

client.on("connection.error", on_error)
```
