# 4. Peer 子协议

## 4.1 目标与适用场景

`peer.*` 是 AUN 核心协议的**对等认证子协议**。

**适用场景**：

- **Peer 直连模式** — 双方有可达网络地址，直接 WebSocket 连接
- **Relay 模式** — 穿透 [Relay](05-Relay-子协议.md) 完成端到端认证

**设计目标**：

- 复用 AID + X.509 证书链信任（见 [02-证书与信任体系](02-证书与信任体系.md)）
- 不依赖 JWT
- 对称 challenge-response 双向认证
- 认证后用 `message.*` 通信

## 4.2 角色与前置条件

- **发起方（Initiator）**：主动发起 `peer.hello` 的一方
- **响应方（Responder）**：接收并回复的一方

**前置条件**：

- 双方各持有有效 AID 证书和对应私钥
- 双方各持有受信根证书列表（用于验证对端证书链）

## 4.3 状态机

```
CONNECTED
  → initialize(mode=peer)
  → INITIALIZED
  → peer.hello
  → PEER_CHALLENGED
  → peer.hello_reply
  → PEER_VERIFIED
  → peer.confirm
  → AUTHENTICATED
  → notification/initialized
  → READY
```

## 4.4 peer.hello

发起对等认证。

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| aid | string | 是 | 发起方 AID |
| cert | string | 是 | 发起方 Agent 证书（PEM） |
| nonce | string | 是 | 发起方随机挑战（UUID） |
| protocol | object | 是 | `{min, max}` 协议版本范围 |

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "peer.hello",
  "params": {
    "aid": "alice.aid.pub",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "nonce": "550e8400-e29b-41d4-a716-446655440000",
    "protocol": { "min": "0.1", "max": "0.1" }
  }
}
```

## 4.5 peer.hello_reply

响应对等认证并签名对端 nonce。

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| aid | string | 响应方 AID |
| cert | string | 响应方 Agent 证书（PEM） |
| nonce | string | 响应方随机挑战（UUID） |
| nonce_signature | string | 响应方用私钥对**发起方 nonce** 的签名（Base64） |
| protocol | string | 协商后的协议版本 |

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "aid": "bob.aid.pub",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "nonce": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "nonce_signature": "MEUCIQD...",
    "protocol": "0.1"
  }
}
```

## 4.6 peer.confirm

发起方验证响应方签名后，签名响应方 nonce。

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| nonce_signature | string | 是 | 发起方用私钥对**响应方 nonce** 的签名（Base64） |

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "peer.confirm",
  "params": {
    "nonce_signature": "MEYCIQCx..."
  }
}
```

## 4.7 peer.confirmed

认证完成确认。响应方验证签名后返回。

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| status | string | `"ok"` |
| authenticated | boolean | `true` |
| identity | object | `{aid: "alice.aid.pub"}` |

## 4.8 证书链验证规则

1. 验证对端证书链到受信 Root CA（Root CA → Registry CA → Issuer CA → Agent cert）
2. 校验证书 CN/SAN 与声称的 `aid` 一致
3. 检查证书有效期
4. 检查证书吊销状态（CRL 或 OCSP，如可用）

## 4.9 Nonce 与签名规则

- Nonce **一次性使用**，推荐有效期 30-60 秒
- 签名算法根据证书曲线：
  - P-256 → ECDSA-SHA256
  - P-384 → ECDSA-SHA384
- 验证方使用证书中的公钥验证签名
- 签名输入为 nonce 原始字节（UTF-8 编码）

## 4.10 版本协商

发起方在 `peer.hello` 中提供 `{min, max}` 版本范围，响应方在 `peer.hello_reply` 中返回双方都支持的**最高版本**。如无交集，返回错误码 -32000。

## 4.11 Peer 地址发现

四种方式：

1. **手动配置** — 直接指定对端地址
2. **DNS SRV** — `_aun-peer._tcp.{domain}`
3. **Gateway 信令交换** — 通过 Gateway 传递 `peer.offer` → `peer.accept`（NAT 穿透辅助）
4. **Agent 目录服务** — 查询 Agent 目录获取端点信息

## 4.12 错误码

| 错误码 | 说明 |
|--------|------|
| -32100 | 证书链验证失败 |
| -32101 | Nonce 已过期 |
| -32102 | Nonce 重用检测 |
| -32103 | 签名验证失败 |
| -32104 | AID 与证书不匹配 |
| -32105 | 握手状态非法 |

## 4.13 认证完成后的会话语义

认证完成后：

- 双方进入 AUTHENTICATED → READY 状态
- 可调用所有业务方法（`message.*` 等）
- 身份由**证书链验证结果**确定，非 JWT
- 会话生命周期与 WebSocket 连接绑定
