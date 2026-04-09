# 1. 身份与凭证协议 auth.*

> 本文档定义 `auth.*` 命名空间的完整规范，覆盖 AID 创建、双向认证、JWT token 生命周期、证书管理等所有身份与凭证相关方法。

## 1.1 目标与角色边界

`auth.*` 命名空间的职责范围：

- **身份初始化**：AID 创建（`auth.create_aid`），为尚无身份的客户端提供 bootstrap 入口
- **双向认证**：两阶段挑战-响应（`auth.aid_login1` / `auth.aid_login2`），完成客户端与 Auth 服务的双向身份验证
- **Token 生命周期**：JWT 签发、刷新（`auth.refresh_token`）
- **证书生命周期**：下载（`auth.download_cert`）、续期（`auth.renew_cert`）、密钥轮转（`auth.rekey`）、额外曲线申请（`auth.request_cert`）

**不承担的职责**：

- 连接模式协商和会话管理 — 由 `auth.connect` 完成（见 [03-Gateway-连接模式](03-Gateway-连接模式.md)）
- Peer / Relay 模式下的对等认证 — 由 `peer.*` 完成
- Gateway 路由与转发逻辑 — Gateway 仅负责将 `auth.*` 请求转发到 Auth 服务

**职责分工**：

| 角色 | 职责 |
|------|------|
| **Auth 服务** | 处理所有 `auth.*` 方法，签发证书和 JWT |
| **Gateway** | 仅路由转发 `auth.*` 请求到 Auth 服务，不参与认证逻辑 |
| **客户端** | 生成和保管私钥，发起认证请求，管理本地证书和 token |

## 1.2 AID、证书、私钥、Token 关系

```
私钥 (客户端本地)
  │
  ├── 生成公钥 ──→ auth.create_aid ──→ AID + 证书
  │                                       │
  │                                       ├── AID = {name}.{issuer}，全局唯一
  │                                       └── 证书 = X.509 v3，Issuer CA 签发，ECDSA
  │
  └── 签名 nonce ──→ auth.aid_login1/2 ──→ JWT Token
                                              │
                                              └── Auth 服务签发，Gateway 模式使用
```

关键约束：

- **私钥**永不传输，客户端本地生成和存储
- **AID** 格式为 `{name}.{issuer}`，全局唯一标识符（详见 [02-证书与信任体系](02-证书与信任体系.md) §2.1）
- **证书**由 Issuer CA 签发，遵循四级证书链：Root CA → Registry CA → Issuer CA → Agent（详见 [02-证书与信任体系](02-证书与信任体系.md) §2.3）
- **JWT Token** 由 Auth 服务签发，仅在 Gateway 模式下使用，用于 `initialize` 握手认证
- 创建 AID 时固定使用 P-256 曲线，额外曲线通过 `auth.request_cert` 申请

## 1.3 auth.create_aid

开放注册接口，可在未认证状态下调用。用于让尚无 AID 的客户端完成首次 bootstrap。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier，格式 `{name}.{issuer}` |
| `public_key` | string | 是 | Base64 编码的 SPKI 格式公钥，必须为 P-256 |

AID 命名规则：
- `name`：3-64 字节，仅允许 `[a-z0-9_-]`，首字符不允许为 `-`，不允许包含 `.`，不能以 `guest` 开头
- `issuer`：合法的可注册域名（如 `aid.pub`、`company.co.uk`）

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "auth.create_aid",
  "params": {
    "aid": "alice.aid.pub",
    "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "aid": "alice.aid.pub",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "curve": "P-256"
  }
}
```

**说明**：
- Gateway 将请求转发到 Auth 服务，Auth 服务调用 CA 签发证书
- 创建 AID 时固定签发 P-256 证书，确保最大兼容性
- 协议默认允许创建任意 `aid`；命名冲突、抢注、保留名、审批制等约束由具体网络运营策略决定
- 客户端需保存返回的证书和本地生成的私钥

## 1.4 auth.aid_login1 / auth.aid_login2

两阶段双向认证，客户端与 Auth 服务互相验证身份。

### Phase 1：auth.aid_login1

客户端发送 `client_nonce` 要求 Auth 服务证明身份，Auth 服务返回 `server_nonce` 要求客户端证明身份。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier |
| `cert` | string | 是 | 客户端 AID 证书（PEM 格式） |
| `client_nonce` | string | 是 | 客户端随机 nonce（UUID），有效期 1 分钟 |

> **注意**：`request_id` 由服务端在 Phase 1 响应中生成并返回，客户端在 Phase 2 中回传。客户端无需在 Phase 1 请求中提供 `request_id`。

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "auth.aid_login1",
  "params": {
    "aid": "alice.aid.pub",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "client_nonce": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "request_id": "req-a1b2c3d4e5f6",
    "nonce": "server_challenge_nonce",
    "server_time": 1735689600,
    "client_nonce_signature": "ecdsa_signature_of_client_nonce",
    "auth_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "auth_curve": "P-256"
  }
}
```

**双向认证机制**：

Auth 服务侧（验证客户端）：
1. 解析客户端提交的 Agent 证书
2. 提取证书中的 AIA 扩展，获取 Issuer CA URL
3. 验证证书链签名到 Root CA
4. 检查证书有效期和吊销状态
5. 签名 `client_nonce`，连同 Auth 服务证书一起返回

客户端侧（验证 Auth 服务）：
1. 解析 `auth_cert`，验证证书链到 Root CA
2. 用 `auth_cert` 公钥验证 `client_nonce_signature`
3. 验证通过，确认 Auth 服务身份真实

**Nonce 生命周期**：
- `nonce` 绑定 `aid` + `request_id`，一次性消费
- 被 `aid_login2`、`renew_cert` 或 `rekey` 中任一操作消费后立即失效
- 有效期 1 分钟，超时未消费自动失效

### Phase 2：auth.aid_login2

客户端签名 Auth 服务的 `nonce`，提交验证并获取 JWT token。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier |
| `request_id` | string | 是 | 与 login1 中的 request_id 一致 |
| `nonce` | string | 是 | 来自 login1 响应的服务端挑战 nonce |
| `client_time` | number | 是 | 客户端时间戳（Unix timestamp） |
| `signature` | string | 是 | 对 `nonce:client_time` 的 ECDSA 签名 |
| `cert` | string | 是 | 客户端 AID 证书（PEM 格式） |

**签名算法**：

```
message = nonce + ":" + client_time
signature = ECDSA_sign(private_key, SHA256(message))
```

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "auth.aid_login2",
  "params": {
    "aid": "alice.aid.pub",
    "request_id": "request-uuid-12345",
    "nonce": "server_challenge_nonce",
    "client_time": 1735689550,
    "signature": "ecdsa_signature_of_nonce_and_time",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "status": "ok",
    "aid": "alice.aid.pub",
    "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expires_in": 3600,
    "new_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  }
}
```

**响应字段说明**：

| 字段 | 说明 |
|------|------|
| `status` | 认证状态，`ok` 表示成功 |
| `aid` | 认证成功的 AID |
| `token` | JWT token，推荐有效期 1 小时 |
| `expires_in` | Token 有效期（秒） |
| `new_cert` | 可选，仅当证书有效期过半时自动续期返回 |

**服务端验证流程**：
1. 验证 `request_id` 和 `nonce` 与 login1 中一致且未过期
2. 从 `cert` 中提取公钥，验证证书链
3. 验证签名：`ECDSA_verify(public_key, SHA256(nonce + ":" + client_time), signature)`
4. 签名验证通过后，签发 JWT token

**关键说明**：
- `login2` 返回 token 但**不改变连接状态**，客户端需调用 `auth.connect` 完成会话初始化（见 [03-Gateway-连接模式](03-Gateway-连接模式.md)）
- `client_time` 仅用于审计日志中的时钟偏移检查，不影响认证结果
- 当 `new_cert` 存在时，客户端必须保存新证书替换旧证书，下次登录使用新证书

## 1.5 auth.refresh_token

刷新 JWT token。客户端显式提交 `refresh_token` 换取新的 `access_token` 和 `refresh_token`。

> **注意**：此方法不要求在已认证连接上调用，可通过独立的 HTTP/WebSocket 请求调用（refresh token grant 模式）。

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "auth.refresh_token",
  "params": {
    "refresh_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "success": true,
    "access_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "new_refresh_token...",
    "expires_in": 3600
  }
}
```

**说明**：
- 调用时提交当前持有的 `refresh_token`
- 服务端验证后吊销旧 `refresh_token`，签发新的 `access_token` 和 `refresh_token`
- 旧 access_token 在其过期时间前仍然有效（JWT 标准行为），但客户端应立即切换到新 token
- 建议在 access_token 过期前 60 秒刷新

**刷新限制**：
- 刷新链总时长不超过 30 天，或最多刷新 720 次
- 达到限制后返回错误，客户端必须重新执行完整的两阶段认证
- 具体限制值由服务端实现决定

## 1.6 证书生命周期方法

### auth.download_cert

按证书序列号下载证书，用于证书链验证。

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "auth.download_cert",
  "params": {
    "cert_sn": "1234567890ABCDEF"
  }
}
```

**参数**：
- `cert_sn`：证书序列号（十六进制字符串）。特殊值 `"root"` 表示下载 Root CA 证书

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "cert_chain": [
      "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
    ]
  }
}
```

### auth.renew_cert

证书过期续期，复用原公钥获取新证书。适用于客户端离线较长时间、证书已过期但私钥仍在的场景。

**前置条件**：先调用 `auth.aid_login1` 获取 nonce。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier |
| `old_cert` | string | 是 | 已过期的旧证书（PEM 格式） |
| `signature` | string | 是 | 用旧私钥对 nonce 的 ECDSA 签名 |
| `nonce` | string | 是 | 从 `auth.aid_login1` 获取的一次性 nonce |
| `request_id` | string | 是 | 与 `auth.aid_login1` 中相同 |

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "auth.renew_cert",
  "params": {
    "aid": "alice.aid.pub",
    "old_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "signature": "BASE64_SIGNATURE",
    "nonce": "uuid-nonce",
    "request_id": "request-uuid-xxxxx"
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "status": "renewed",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  }
}
```

**安全约束**：
- 宽限期 ≤ 90 天，超过宽限期的证书无法续期，必须重新 `auth.create_aid`
- 旧证书必须未被吊销
- 新证书复用原公钥，无需重新生成密钥对
- nonce 消费后立即失效

### auth.rekey

密钥轮转，更换公私钥对并获取新证书。适用于私钥可能泄露、设备迁移或定期安全轮转。

**前置条件**：先调用 `auth.aid_login1` 获取 nonce。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier |
| `new_public_key` | string | 是 | 新公钥，SPKI Base64 格式 |
| `old_cert` | string | 是 | 当前证书（有效或宽限期内过期均可） |
| `signature` | string | 是 | 用旧私钥对 `nonce + new_public_key` 的 ECDSA 签名 |
| `nonce` | string | 是 | 从 `auth.aid_login1` 获取的一次性 nonce |
| `request_id` | string | 是 | 与 `auth.aid_login1` 中相同 |

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "auth.rekey",
  "params": {
    "aid": "alice.aid.pub",
    "new_public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...",
    "old_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "signature": "BASE64_SIGNATURE",
    "nonce": "uuid-nonce",
    "request_id": "request-uuid-xxxxx"
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "status": "rekeyed",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  }
}
```

**安全约束**：
- 签名内容包含新公钥（`nonce + new_public_key`），防止中间人替换公钥
- rekey 成功后旧证书**立即吊销**（加入 CRL）
- 旧证书如已过期，同样受宽限期限制（≤ 90 天）
- 客户端完成后应销毁旧私钥

### auth.request_cert

为已有 AID 申请不同曲线的额外证书。必须在已认证连接上调用。

**请求参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `aid` | string | 是 | Agent Identifier，必须与当前认证身份一致 |
| `public_key` | string | 是 | 目标曲线的 Base64 SPKI 格式公钥 |
| `curve` | string | 是 | 目标椭圆曲线，可选 `P-256`、`P-384` |

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "auth.request_cert",
  "params": {
    "aid": "alice.aid.pub",
    "public_key": "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE...",
    "curve": "P-384"
  }
}
```

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "status": "issued",
    "aid": "alice.aid.pub",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ca_cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "curve": "P-384"
  }
}
```

**说明**：
- 同一 AID 可持有多个曲线的证书，各证书独立管理（独立密钥对、独立有效期、独立续期）
- Auth 服务验证当前连接身份与请求的 `aid` 一致
- E2EE 协商时，客户端根据对方曲线选择匹配的证书
- 登录认证时可使用任一有效证书

## 1.7 JWT Token 机制

### 签发流程

```
1. 客户端完成两阶段认证（aid_login1 + aid_login2）
2. Auth 服务验证签名和证书链
3. 生成 JWT:
   - Header: { "alg": "ES256", "typ": "JWT", "kid": "cert-serial-number" }
   - Payload: {
       "aid": "alice.aid.pub",
       "iss": "auth.aid.pub",
       "sub": "alice.aid.pub",
       "aud": "aun",
       "iat": 1735689600,
       "exp": 1735693200
     }
   - Signature: ECDSA(Header + Payload, Auth_PrivateKey)
4. 返回 token
```

- Auth 服务密钥为 P-256 时使用 ES256，P-384 时使用 ES384
- `kid` 标识签发证书的序列号，支持证书轮换期间的双证书验证

### 验证流程

任何 AUN 服务均可独立验证 JWT（持有 Auth 服务公钥即可）：

1. 从 `initialize` 消息获取 token
2. Base64 解码 Header 和 Payload
3. 用 Auth 服务公钥验证 ECDSA 签名
4. 检查 `exp`（过期时间）、`iss`（签发者）、`aud`（固定 `"aun"`）、`aid`（格式正确）

### 安全约束

- JWT 有效期不超过签发证书的有效期
- 证书轮换时，新旧双证书过渡期内两张证书签发的 token 均有效
- `kid` 字段标识签发证书，验证方按 `kid` 选择对应公钥
- Gateway 无法伪造 token（不持有 Auth 服务私钥）
- JWT 仅提供身份认证，不包含授权信息；资源访问控制由各服务自行实现

> 详细实现指南见 [附录M-JWT认证实现指南](附录M-JWT认证实现指南.md)。

## 1.8 错误码

| 错误码 | 说明 |
|--------|------|
| `-32001` | Authentication failed — 认证失败 |
| `-32002` | Certificate invalid — 证书无效（过期、吊销、格式错误） |
| `-32003` | Signature verification failed — 签名验证失败 |
| `-32005` | Authentication expired — Token 过期或刷新链耗尽 |

> 通用 JSON-RPC 2.0 错误码（-32700/-32600/-32601/-32602/-32603）同样适用，见 [07-JSON-RPC](07-JSON-RPC.md)。

## 1.9 安全说明

- **私钥永不传输**：所有签名操作在客户端本地完成
- **双向 nonce challenge**：Phase 1 同时实现客户端验证 Auth 服务和 Auth 服务验证客户端，防止中间人和重放攻击
- **证书链验证到 Root CA**：每次认证都验证完整证书链（Agent → Issuer CA → Registry CA → Root CA）
- **JWT 非对称签名**：使用 ECDSA 签名，单一信任根（Auth 服务），所有验证方只需持有公钥
- **开放注册策略由运营方决定**：协议不强制限制注册，运营方可根据业务需求实施审批、限流等策略

> 完整威胁模型与防护措施见 [09-安全考虑](09-安全考虑.md)。证书层级与信任模型详见 [02-证书与信任体系](02-证书与信任体系.md)。连接模式与认证流程总览见 [03-Gateway-连接模式](03-Gateway-连接模式.md)。
