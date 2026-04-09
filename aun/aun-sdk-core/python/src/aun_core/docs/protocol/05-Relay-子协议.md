# 5. Relay 子协议

## 5.1 目标与适用场景

`relay.*` 是 AUN 核心协议的**中继传输子协议**。

**适用场景**：双方都在 NAT 后无公网 IP，需要轻量中继转发。

Relay 实现极简，核心逻辑约 200 行代码即可完成。

## 5.2 Relay 职责边界

**职责**：

- 维护 AID → WebSocket 连接映射
- 按目标 AID 转发消息
- 维持连接与基础流控

**非职责**：

- 不验证证书链
- 不签发 JWT
- 不解析内层 `peer.*` 或 `message.*`
- 不存储历史消息

> Relay 是**零信任笨管道**，所有安全保障由端到端的 [peer.*](04-Peer-子协议.md) 完成。

## 5.3 状态机

```
CONNECTED
  → initialize(mode=relay)
  → INITIALIZED
  → relay.register
  → RELAY_REGISTERED
  → relay.forward(peer.hello)
  → ...peer.* 穿透认证...
  → AUTHENTICATED
  → notification/initialized
  → READY
```

## 5.4 relay.register

注册 AID 到 Relay，建立 AID → 连接映射。

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "relay.register",
  "params": { "aid": "alice.aid.pub" }
}
```

**响应**：

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "status": "ok" } }
```

## 5.5 relay.forward

向指定 AID 转发任意 JSON-RPC 消息。

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| to | string | 是 | 目标 AID |
| message | object | 是 | 要转发的完整 JSON-RPC 消息 |

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "relay.forward",
  "params": {
    "to": "bob.aid.pub",
    "message": {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "peer.hello",
      "params": {
        "aid": "alice.aid.pub",
        "cert": "-----BEGIN CERTIFICATE-----\n...",
        "nonce": "550e8400-e29b-41d4-a716-446655440000",
        "protocol": { "min": "0.1", "max": "0.1" }
      }
    }
  }
}
```

**响应**：

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "status": "forwarded" } }
```

## 5.6 event/relay.message

Relay 向目标 Agent 投递消息（JSON-RPC Notification）。

```json
{
  "jsonrpc": "2.0",
  "method": "event/relay.message",
  "params": {
    "from": "alice.aid.pub",
    "message": {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "peer.hello",
      "params": { "..." : "..." }
    }
  }
}
```

## 5.7 内层消息透明封装规则

- Relay **不解析** `message` 内容
- Relay 将 `from` 绑定到当前连接已注册的 AID（**不信任**内层 message 中的 from）
- 可限制最大转发消息尺寸（推荐 64KB）和速率

## 5.8 与 peer.* 的关系

Relay 模式下的身份认证流程：

1. 双方连接 Relay → `initialize(mode=relay)` → `relay.register`
2. 发起方：`relay.forward({to: "bob", message: peer.hello})`
3. 对端收到 `event/relay.message`，提取内层 `peer.hello` 处理
4. 响应方：`relay.forward({to: "alice", message: peer.hello_reply})`
5. 继续 `peer.confirm` / `peer.confirmed` 流程（均通过 relay.forward 传输）
6. 认证完成后，业务消息同样通过 `relay.forward` / `event/relay.message` 交换

**Relay 只是传输管道，认证由 [peer.*](04-Peer-子协议.md) 完成。**

## 5.9 Relay 发现

1. **手动配置** — 直接指定 Relay 地址
2. **公共 Relay 列表** — 自动选择延迟最低的节点
3. **Gateway 兼任 Relay** — Gateway 实现可同时提供 Relay 功能

## 5.10 错误码

| 错误码 | 说明 |
|--------|------|
| -32150 | 未注册，需先 relay.register |
| -32151 | 目标 AID 未找到 |
| -32152 | 发送方 AID 不匹配 |
| -32153 | 转发消息体过大 |
| -32154 | 速率限制 |

## 5.11 安全说明

- Relay 是**零信任笨管道**，不参与任何认证
- 不持有 JWT，不验证身份
- 消息内容对 Relay 完全透明（尤其适合 E2EE 场景）
- 所有身份验证由端到端 `peer.*` 完成
- Relay 唯一的安全保障是 `from` 字段绑定（防止 AID 伪装）
