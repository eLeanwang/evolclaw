# 附录 M：JWT 认证实现指南（非规范性）

> **本文档为非规范性内容**：提供 JWT Token 认证的实现建议、代码示例和安全考虑，不是协议强制要求。

## M.1 Token 签发实现

### M.1.1 签发流程

**Auth 服务端实现**：

```
1. 客户端完成两阶段认证
   ↓
2. Auth 服务验证签名和证书
   - 从 cert 中提取公钥
   - 验证 signature = sign(privateKey, nonce)
   - 验证 cert 由 CA 签发
   - 验证 cert 未过期
   - 验证 cert.CN == aid
   ↓
3. Auth 服务生成 JWT token
   - Header: {"alg": "ES256", "typ": "JWT"}  (P-256 Auth 服务) 或 {"alg": "ES384", "typ": "JWT"} (P-384 Auth 服务)
   - Payload: {
       "aid": "alice.aid.pub",
       "iat": 1709712000,        // 签发时间
       "exp": 1709798400,        // 过期时间（24小时后）
       "iss": "auth.aid.pub",      // 签发者（Auth 服务的 AID）
       "sub": "alice.aid.pub",   // 主体（用户 AID）
       "aud": "aun"              // 受众（固定值 "aun"，标识 token 用途）
     }
   - Signature: ECDSA-SHA256(Header + Payload, Auth_PrivateKey) 或 ECDSA-SHA384
   ↓
4. Auth 服务返回 token
   → {token: "eyJhbGc...", expires_in: 3600}
```

### M.1.2 JWT Token 结构

```
eyJhbGciOiJFUzM4NCIsInR5cCI6IkpXVCJ9.eyJhaWQiOiJhbGljZS5haWQucHViIiwiaWF0IjoxNzA5NzEyMDAwLCJleHAiOjE3MDk3OTg0MDAsImlzcyI6ImFwLmFpZC5wdWIiLCJzdWIiOiJhbGljZS5haWQucHViIn0.signature_bytes
│                                   │                                                                                                                                  │
│         Header (Base64)           │                                    Payload (Base64)                                                                              │  Signature
```

**签名算法**：
- 算法：ES256（ECDSA-SHA256）或 ES384（ECDSA-SHA384）
- Auth 服务密钥为 P-256 时使用 ES256，P-384 时使用 ES384
- 使用 Auth 服务私钥进行 ECDSA 签名（非对称签名）
- 所有服务持有 Auth 服务公钥证书，可独立验证 token（无需共享密钥）

## M.2 Token 验证实现

### M.2.1 验证流程

**所有 AUN 服务端实现**：

```
1. 服务收到请求（携带 JWT token）
   ↓
2. 提取 token
   - WebSocket: 从 initialize 消息中获取
   - 连接状态：token 验证后存储在连接上下文
   ↓
3. 解析 token
   - Base64 解码 Header 和 Payload
   - 提取签名部分
   ↓
4. 验证签名
   - 使用 Auth 服务的公钥证书
   - 验证 ECDSA 签名
   - 算法：ES256（ECDSA-SHA256）或 ES384（ECDSA-SHA384）
   ↓
5. 验证 Payload
   - 检查 exp（过期时间）：exp > now
   - 检查 iss（签发者）：iss == "auth.aid.pub"
   - 检查 aud（受众）：aud == "aun"
   - 检查 aid（用户身份）：aid 格式正确
   ↓
6. 提取用户信息
   - aid: 用户的 Agent Identifier
   - aud: 验证 aud == "aun"，确认 token 用途
   - 用于标识请求来源身份（身份认证）
   - **注意**：JWT 仅提供身份认证，不包含授权信息。资源访问控制由各 AUN 服务根据业务逻辑自行实现
```

### M.2.2 Go 实现示例

```go
import (
    "github.com/golang-jwt/jwt/v5"
)

// Auth 服务的公钥证书（ECDSA 非对称签名，所有服务持有公钥）
var authPublicKey *ecdsa.PublicKey

func verifyToken(tokenString string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
        // 验证签名算法（ES256 或 ES384）
        if _, ok := token.Method.(*jwt.SigningMethodECDSA); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return authPublicKey, nil
    })

    if err != nil {
        return nil, err
    }

    if claims, ok := token.Claims.(*Claims); ok && token.Valid {
        return claims, nil
    }

    return nil, fmt.Errorf("invalid token")
}

type Claims struct {
    AID string `json:"aid"`
    jwt.RegisteredClaims
}
```

## M.3 客户端 Token 使用

### M.3.1 客户端签名实现

在 `auth.aid_login2` 阶段，客户端需要对 nonce 进行签名：

**签名内容**：
```
message = nonce + ":" + client_time
signature = ECDSA_sign(private_key, SHA256(message))
```

**JavaScript 实现示例**：
```javascript
// 客户端签名
const nonce = "server_challenge_nonce";
const client_time = Math.floor(Date.now() / 1000);
const message = `${nonce}:${client_time}`;
const signature = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  privateKey,
  new TextEncoder().encode(message)
);

// 发送 login_aid2 请求
const response = await rpc.call('auth.aid_login2', {
  request_id: requestId,
  nonce: nonce,
  client_time: client_time,
  signature: arrayBufferToBase64(signature),
  cert: certPem
});

// 获取 token
const token = response.token;
```

### M.3.2 Token 使用示例

Token 统一通过 `initialize` 消息传递。每次 WebSocket 连接（包括重连）都必须调用 `initialize`：

```javascript
// 首次登录：先调用 auth.* 获取 token，再 initialize
const ws = new WebSocket('wss://gateway.example.com/aun');
ws.onopen = async () => {
  // 1. 在 initialize 之前调用 auth.* 获取 token
  const token = await loginFlow(ws); // login_aid1 + login_aid2

  // 2. 用 token 调用 initialize 完成认证
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '1.0',
      token: token,
      clientInfo: { name: 'MyApp', version: '1.0.0' }
    }
  }));
};

// 重连：直接用已有 token 调用 initialize
const ws2 = new WebSocket('wss://gateway.example.com/aun');
ws2.onopen = () => {
  ws2.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '1.0',
      token: saved_jwt_token,
      clientInfo: { name: 'MyApp', version: '1.0.0' }
    }
  }));
};
```

**优势**：
- Token 不出现在 URL、服务器日志和浏览器历史中
- 统一的传递方式，所有客户端实现一致
- 与 JSON-RPC 2.0 协议自然融合

## M.4 安全架构

### M.4.1 单一信任根

```
┌─────────────────────────────────────────────────┐
│              单一信任根架构                        │
├─────────────────────────────────────────────────┤
│                                                 │
│   Auth 服务                                  │
│   ├─ 持有私钥（唯一能签发 token）                 │
│   └─ 签发 JWT token                             │
│                                                 │
│   所有 AUN 服务                                  │
│   ├─ HB (Heartbeat)                             │
│   ├─ MSG (Message)                              │
│   ├─ Storage                                    │
│   ├─ Group                                      │
│   └─ 都持有 Auth 服务的公钥证书               │
│      └─ 可以验证 token（ECDSA 非对称签名）       │
│                                                 │
│   Gateway                                       │
│   ├─ 只能转发认证请求                            │
│   ├─ 无法伪造 Auth 服务的签名                │
│   └─ 恶意 Gateway 签发的假 token 会被拒绝        │
│                                                 │
└─────────────────────────────────────────────────┘
```

### M.4.2 防止 Gateway 作恶

1. **无法伪造 token**：
   - Gateway 没有 Auth 服务的私钥
   - 无法生成有效的 ECDSA 签名
   - 所有服务都会拒绝无效签名的 token

2. **无法冒充其他用户**：
   - Token 中的 `aid` 字段标识用户身份
   - 即使恶意 Gateway 用自己的 AID 获取 token
   - 也无法访问其他用户的资源（token 中的 aid 与资源归属不匹配）

3. **私钥不经过 Gateway**：
   - 客户端本地签名 nonce
   - Gateway 只转发签名，看不到私钥
   - 无法伪造用户签名

## M.5 Token 生命周期管理

### M.5.1 有效期与刷新

**有效期**：
- 推荐：1-24 小时
- 具体由 Auth 服务决定

**过期处理**：
- 客户端需要重新认证
- 或使用 `auth.refresh_token` 刷新

**刷新机制**：

AUN 协议定义了简化的单 token 刷新模型（参见主规范 8.3.4 节）：
- 客户端在已认证连接上调用 `auth.refresh_token`（空参数）
- Auth 服务返回新的 JWT token
- 旧 token 在过期前仍然有效

**可选增强：双 Token 模式**

实现方可以选择使用更安全的双 token 模式：
```
短期 access_token（1小时）+ 长期 refresh_token（7天）
access_token 过期后，用 refresh_token 换取新的 access_token
```

这种模式的优势：
- access_token 有效期短，降低泄露风险
- refresh_token 只在刷新时使用，减少暴露
- 可以实现更细粒度的撤销控制

**注意**：双 token 模式需要扩展 `auth.refresh_token` 的参数和响应结构，不在核心协议规范中定义。

**JWT 与证书绑定**：
- JWT 的有效期不得超过签发该 JWT 的 Auth 服务证书的有效期
- 证书过期后所有由该证书签发的 JWT 自动失效

**刷新限制**：
- 刷新链总时长不超过 30 天，或最多刷新 720 次
- 达到限制后必须重新用证书签名登录

## M.6 证书轮换与双证书过渡

### M.6.1 轮换通用原则

整个证书层级（Root CA → Issuer CA → Auth 服务/Agent）都存在轮换需求，轮换期间必须保证新旧双证书同时有效：

```
证书轮换通用原则：

1. 新证书签发时，旧证书仍在有效期内
2. 进入双证书过渡期：新旧证书并存于证书库
3. 过渡期内，两张证书都可用于验证
4. 过渡期结束后（旧证书签发的所有下级证书/JWT 均已过期），旧证书退役
```

### M.6.2 各层级轮换要点

| 层级 | 典型有效期 | 过渡期 | 影响范围 |
|------|-----------|--------|---------|
| Root CA | 20-30 年 | 数年 | 全局信任锚，所有客户端证书库需更新 |
| Issuer CA | 10-15 年 | 1-2 年 | 该 Issuer 下所有 Agent |
| Auth 服务证书 | 1-2 年 | ≤ 旧 token 最大剩余有效期 | 已签发的 JWT |

### M.6.3 证书库要求

- `auth.download_cert` 返回的证书库必须包含过渡期内的新旧两张证书
- 客户端验证证书链时，按证书序列号匹配，新旧证书均可构成有效链
- Root CA 轮换时，客户端受信列表需同时包含新旧两个根证书，直到旧根签发的所有下级证书全部过期

### M.6.4 Auth 服务证书轮换与 JWT 有效性

Auth 服务证书轮换直接影响 JWT 验证，需特别处理：

- 新 JWT 用新证书私钥签发
- 旧 JWT 仍可用旧证书公钥验证
- JWT Header 中通过 `kid`（Key ID）标识签发证书：`{"alg": "ES256", "kid": "auth-cert-sn-002"}`
- 验证端按 `kid` 匹配证书公钥
- 过渡期 = 旧 token 最大剩余有效期（通常 ≤ 24 小时）
- 过渡期结束后，旧 Auth 服务证书退役
- 客户端无感知，无需重新登录

## M.7 审计与监控

### M.7.1 日志记录

**Auth 服务**：
- 记录所有 token 签发日志
- 包含：aid、签发时间、过期时间、客户端信息

**各 AUN 服务**：
- 记录 token 验证失败日志
- 包含：token 内容、失败原因、请求来源

### M.7.2 异常检测

- 追踪异常 token 使用模式
- 检测重放攻击
- 检测伪造 token 尝试

### M.7.3 Token 撤销

**黑名单机制**：
- 维护已撤销 token 的黑名单
- 验证时检查 token 是否在黑名单中
- 黑名单条目在 token 过期后自动清理

**撤销场景**：
- 用户主动登出
- 检测到账户异常
- 证书被吊销

---
