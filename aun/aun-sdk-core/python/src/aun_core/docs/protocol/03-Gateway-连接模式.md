# 3. Gateway 连接模式

## 3.1 Gateway 模式定位

Gateway 是 AUN 三种平级连接模式之一（Gateway / [Peer](04-Peer-子协议.md) / [Relay](05-Relay-子协议.md)），**不是协议唯一入口**。

**适用场景**：浏览器、移动端、需要设备管理和在线状态的标准接入。

**Gateway 职责**：

- 本域消息路由（按 AID 转发到本地服务）
- 跨域消息路由（Gateway-to-Gateway 转发）
- JWT token 验证
- 请求转发到 AUN 服务（Auth、Message 等）
- **不持有**用户 AID 私钥
- **不处理**业务逻辑

## 3.2 前置条件

- 已创建 AID（通过 `auth.create_aid`）
- 已获取 JWT token（通过 `auth.aid_login1` + `auth.aid_login2`）
- 或已有未过期的 token（重连场景）

## 3.3 Gateway 发现

客户端通过 Well-Known 端点自动发现可用的 Gateway 地址。

**请求**：

```
GET https://{aid}/.well-known/aun-gateway
```

其中 `{aid}` 为目标 Agent 的完整 AID（如 `my-agent.agentid.pub`）。

**响应**（`Content-Type: application/json`）：

```json
{
  "gateways": [
    {"url": "wss://gw1.agentid.pub/ws", "priority": 1},
    {"url": "wss://gw2.agentid.pub/ws", "priority": 2}
  ]
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `gateways` | array | ✅ | 可用 Gateway 列表，不可为空 |
| `gateways[].url` | string | ✅ | Gateway WebSocket 地址（`ws://` 或 `wss://`） |
| `gateways[].priority` | integer | ❌ | 优先级，数值越小优先级越高，默认 999 |

**客户端行为**：

1. 按 `priority` 升序排序
2. 选择优先级最高（数值最小）的 Gateway 尝试连接
3. 连接失败时可降级到下一优先级
4. 发现结果应缓存，避免每次连接重复查询

## 3.4 连接时序

```
WebSocket 连接建立
  ← challenge（服务端推送 nonce）
  → auth.aid_login1 (可选，已有 token 时跳过)
  → auth.aid_login2 (可选)
  → auth.connect(nonce, auth, protocol)
  ← {status: "ok", protocol, identity, ...}
  → READY，进入 relay 模式
```

> `auth.aid_login1/2` 为可选：如果客户端已持有有效 token，可直接调用 `auth.connect`。

## 3.5 auth.connect

客户端通过 `auth.connect` 完成会话初始化，Gateway 验证 token 后建立到 Kernel 的代理连接，返回 `status: "ok"` 即进入 READY 状态。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| nonce | string | 是 | 服务端 challenge 中下发的 nonce |
| auth.method | string | 是 | 认证方式（`"kite_token"` / `"aid"` / `"pairing"`） |
| auth.token | string | 是 | JWT token |
| protocol.min | string | 是 | 客户端支持的最低协议版本 |
| protocol.max | string | 是 | 客户端支持的最高协议版本 |
| device.id | string | 推荐 | 设备唯一标识 |
| device.type | string | 推荐 | 设备类型（desktop/mobile/browser） |
| capabilities | object | 否 | 客户端能力声明 |
| client | object | 否 | 客户端信息（名称、版本等） |

**capabilities 字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `e2ee` | boolean | 是否支持 P2P E2EE（接收和发送） |
| `group_e2ee` | boolean | 是否支持群组 E2EE（接收、解密、密钥协议处理）。所有现代客户端必须声明为 `true` |

请求示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "auth.connect",
  "params": {
    "nonce": "challenge-nonce-from-server",
    "auth": {"method": "kite_token", "token": "eyJhbGciOi..."},
    "protocol": {"min": "1.0", "max": "1.0"},
    "device": {"id": "dev-001", "type": "browser"}
  }
}
```

### 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | `"ok"` 表示成功 |
| protocol | string | 协商后的协议版本 |
| server_time | number | 服务器时间（Unix 时间戳） |
| authenticated | boolean | 认证状态 |
| identity | object | 认证身份信息（含 module_id、role、aid） |
| connection | object | 连接信息（id、device_id） |
| bridgeInfo | object | Bridge 信息（name、version） |
| capabilities | object | 服务端能力声明 |
| trust_level | string | 信任等级 |
| token | string | 可选，首次登录时返回 kite_token 供后续重连 |

响应示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "status": "ok",
    "protocol": "1.0",
    "server_time": 1711234567.890,
    "authenticated": true,
    "identity": {
      "module_id": "gateway-client-abc123",
      "role": "admin",
      "aid": "alice.agentid.pub"
    },
    "trust_level": "low",
    "connection": {"id": "conn_gateway-client-abc123", "device_id": "dev-001"},
    "bridgeInfo": {"name": "Kite Gateway", "version": "0.1"},
    "capabilities": {}
  }
}
```

### 错误码

| 错误码 | 说明 |
|--------|------|
| -32000 | 协议版本不匹配 |
| 4000 | 缺少必要参数（auth.method、nonce 等） |
| 4001 | 认证失败（token 无效或过期） |
| 4010 | Nonce 无效或已过期 |
| 4500 | 服务端内部错误（Auth 服务或 Kernel 不可达） |

### 连接超时

WebSocket 连接建立后 **30 秒**内未完成 `auth.connect`，服务端关闭连接。

## 3.6 心跳与重连

- **心跳**：应用层 `meta.ping`，推荐间隔 30 秒
- **Token 过期**：连接期间 token 过期时，调用 `auth.refresh_token` 刷新
- **重连**：新建 WebSocket 连接 → `auth.connect(token)` 重新初始化

> 重连不保留前一次连接的会话状态，需重新 `auth.connect`。

## 3.7 与 auth.* 的关系

| 职责 | 负责方 |
|------|--------|
| AID 创建 / 登录 / token 签发与刷新 | `auth.*`（Auth 服务） |
| Gateway 会话初始化与连接管理 | `auth.connect` |
| token 转发验证 | Gateway |

- `auth.aid_login1/2` 用于获取 token（身份凭证）
- Gateway 不处理 `auth.*` 登录逻辑，仅转发到 Auth 服务
- `auth.connect` 完成 Gateway 模式的会话初始化

## 3.8 跨域消息路由（Gateway-to-Gateway）

当本域客户端需要向其他 Issuer 域的 AID 发送消息时，Gateway 负责跨域中继。

### 路由流程

```
本域客户端 → 本域 Gateway → 远端 Gateway → 远端服务 → 目标 AID
```

**关键特性**：
- 本域服务（Message/Group/Mail）无需感知远端域，只需将跨域请求发给本地 Gateway
- Gateway 根据目标 AID 的 Issuer 部分（如 `bob.example.com` 中的 `example.com`）发现远端 Gateway
- Gateway 间通过 WebSocket 长连接通信，复用 JSON-RPC 2.0 协议
- 远端 Gateway 验证请求后转发到本域服务
- **auth 管凭证，auth.connect 管连接**——两者职责不同
