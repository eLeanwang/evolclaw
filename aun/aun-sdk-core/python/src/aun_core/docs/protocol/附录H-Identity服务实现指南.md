# 附录 H：Auth 服务实现指南（非规范性）

> **本文档为非规范性内容**：提供 Auth 服务的实现建议、验证流程、安全约束和代码示例，不是协议强制要求。

## H.1 证书链验证实现

### H.1.1 Auth 服务验证客户端证书链

在 `auth.aid_login1` 阶段，Auth 服务需要验证客户端提交的证书链：

**推荐验证步骤**：
```
1. 解析客户端提交的 Agent 证书（如 alice.aid.pub）
2. 提取证书中的 AIA 扩展，获取 Issuer CA URL
3. 下载 Issuer CA 证书（aid.pub）并缓存
4. 验证证书链签名：
   - 用 aid.pub 公钥验证 alice.aid.pub 签名 ✓
   - 用 Root CA 公钥验证 aid.pub 签名 ✓
5. 检查证书有效期（notBefore/notAfter）
6. 检查证书吊销状态（推荐，CRL/OCSP）
7. 验证证书 CN 与 AID 一致
8. 验证通过，继续处理
```

**实现示例（Node.js）**：
```javascript
const crypto = require('crypto');
const x509 = require('@peculiar/x509');

async function verifyCertChain(certPem, aid) {
  // 1. 解析证书
  const cert = new x509.X509Certificate(certPem);

  // 2. 验证 CN 与 AID 一致
  const cn = cert.subject.split(',').find(s => s.startsWith('CN=')).split('=')[1];
  if (cn !== aid) {
    throw new Error('Certificate CN does not match AID');
  }

  // 3. 检查有效期
  const now = new Date();
  if (now < cert.notBefore || now > cert.notAfter) {
    throw new Error('Certificate expired or not yet valid');
  }

  // 4. 提取 AIA 扩展，下载 Issuer CA
  const aiaExt = cert.getExtension('1.3.6.1.5.5.7.1.1'); // AIA OID
  const issuerCaUrl = extractIssuerCaUrl(aiaExt);
  const issuerCaCert = await downloadAndCacheCert(issuerCaUrl);

  // 5. 验证签名链
  const issuerPublicKey = issuerCaCert.publicKey;
  const isValid = cert.verify(issuerPublicKey);
  if (!isValid) {
    throw new Error('Certificate signature verification failed');
  }

  // 6. 验证 Issuer CA 到 Root CA
  const rootCaCert = await getRootCaCert();
  const issuerValid = issuerCaCert.verify(rootCaCert.publicKey);
  if (!issuerValid) {
    throw new Error('Issuer CA signature verification failed');
  }

  // 7. 检查吊销状态（可选但推荐）
  await checkRevocationStatus(cert);

  return true;
}
```

### H.1.2 客户端验证 Auth 服务证书链

在 `auth.aid_login1` 响应阶段，客户端需要验证 Auth 服务的证书链：

**推荐验证步骤**：
```
1. 解析 Auth 服务返回的 auth_cert（如 auth.aid.pub）
2. 提取 AIA 扩展，下载 Issuer CA（aid.pub）
3. 验证证书链签名到 Root CA
4. 检查证书有效期
5. 用 auth_cert 公钥验证 client_nonce_signature
6. 验证通过，确认 Auth 服务身份真实
```

**实现示例（浏览器 JavaScript）**：
```javascript
async function verifyAuthService(authCert, clientNonce, clientNonceSignature) {
  // 1. 解析证书
  const certDer = pemToDer(authCert);
  const cert = await parseCertificate(certDer);

  // 2. 检查有效期
  const now = Date.now();
  if (now < cert.notBefore || now > cert.notAfter) {
    throw new Error('Auth service certificate expired');
  }

  // 3. 下载并验证 Issuer CA
  const issuerCaUrl = extractIssuerCaUrl(cert);
  const issuerCaCert = await fetch(issuerCaUrl).then(r => r.text());

  // 4. 验证证书链到 Root CA
  await verifyCertChainToRoot(cert, issuerCaCert);

  // 5. 验证 client_nonce 签名
  const publicKey = await crypto.subtle.importKey(
    'spki',
    cert.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  const signatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64ToArrayBuffer(clientNonceSignature),
    new TextEncoder().encode(clientNonce)
  );

  if (!signatureValid) {
    throw new Error('Auth service signature verification failed');
  }

  return true;
}
```

## H.2 签名验证实现

### H.2.1 login_aid2 服务端验证流程

**推荐验证步骤**：
```
1. 验证 request_id 与 login_aid1 中的一致
2. 验证 nonce 与 login_aid1 中返回的一致且未过期（推荐有效期 30 秒）
3. 从 cert 中提取公钥
4. 验证签名：ECDSA_verify(public_key, SHA256(nonce + ":" + client_time), signature)
5. （可选）检查 client_time 与 server_time 的偏差，仅用于审计日志，不影响认证
6. 签名验证通过后，生成 JWT token
```

**实现示例（Node.js）**：
```javascript
async function verifyLoginAid2(params, sessionData) {
  // 1. 验证 request_id
  if (params.request_id !== sessionData.request_id) {
    throw new Error('Request ID mismatch');
  }

  // 2. 验证 nonce
  if (params.nonce !== sessionData.nonce) {
    throw new Error('Nonce mismatch');
  }

  const nonceAge = Date.now() - sessionData.nonceCreatedAt;
  if (nonceAge > 30000) { // 30 秒
    throw new Error('Nonce expired');
  }

  // 3. 提取公钥
  const cert = new x509.X509Certificate(params.cert);
  const publicKey = await crypto.subtle.importKey(
    'spki',
    cert.publicKey.rawData,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  // 4. 验证签名
  const message = `${params.nonce}:${params.client_time}`;
  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = Buffer.from(params.signature, 'base64');

  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signatureBuffer,
    messageBuffer
  );

  if (!isValid) {
    throw new Error('Signature verification failed');
  }

  // 5. 时钟偏移检查（仅审计）
  const serverTime = Math.floor(Date.now() / 1000);
  const clockSkew = Math.abs(serverTime - params.client_time);
  if (clockSkew > 300) { // 5 分钟
    console.warn(`Large clock skew detected: ${clockSkew}s for ${params.aid}`);
  }

  // 6. 生成 JWT token
  const token = await generateJwtToken(params.aid);

  return { token, expires_in: 3600 };
}
```

### H.2.2 客户端签名实现

**浏览器实现示例**：
```javascript
// 客户端签名 nonce
async function signNonce(privateKey, nonce, clientTime) {
  const message = `${nonce}:${clientTime}`;
  const messageBuffer = new TextEncoder().encode(message);

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    messageBuffer
  );

  return arrayBufferToBase64(signature);
}

// 使用示例
const nonce = "server_challenge_nonce";
const clientTime = Math.floor(Date.now() / 1000);
const signature = await signNonce(privateKey, nonce, clientTime);
```

## H.3 Nonce 管理实现

### H.3.1 Nonce 生命周期管理

**推荐实现**：
```javascript
class NonceManager {
  constructor() {
    this.nonces = new Map(); // key: aid+request_id, value: {nonce, createdAt, consumed}
  }

  // 生成 nonce
  create(aid, requestId) {
    const nonce = crypto.randomUUID();
    const key = `${aid}:${requestId}`;

    this.nonces.set(key, {
      nonce,
      createdAt: Date.now(),
      consumed: false
    });

    // 60 秒后自动清理
    setTimeout(() => this.nonces.delete(key), 60000);

    return nonce;
  }

  // 验证并消费 nonce
  consume(aid, requestId, nonce) {
    const key = `${aid}:${requestId}`;
    const entry = this.nonces.get(key);

    if (!entry) {
      throw new Error('Nonce not found or expired');
    }

    if (entry.consumed) {
      throw new Error('Nonce already consumed');
    }

    if (entry.nonce !== nonce) {
      throw new Error('Nonce mismatch');
    }

    const age = Date.now() - entry.createdAt;
    if (age > 60000) { // 60 秒
      this.nonces.delete(key);
      throw new Error('Nonce expired');
    }

    // 标记为已消费
    entry.consumed = true;

    return true;
  }
}
```

**推荐配置**：
- Nonce 有效期：30-60 秒
- Nonce 格式：UUID v4
- 存储：内存（Redis）或数据库
- 清理策略：过期自动删除

## H.4 Token 刷新限制实现

### H.4.1 刷新链管理

**推荐限制**：
- 刷新链总时长：不超过 30 天
- 最大刷新次数：720 次（每小时刷新一次 × 30 天）
- 达到限制后：返回错误，客户端必须重新执行完整认证

**实现示例**：
```javascript
class TokenRefreshManager {
  constructor() {
    this.refreshChains = new Map(); // key: aid, value: {firstIssued, refreshCount}
  }

  async refreshToken(aid, currentToken) {
    // 验证当前 token
    const payload = await verifyJwtToken(currentToken);

    // 获取刷新链信息
    let chain = this.refreshChains.get(aid);
    if (!chain) {
      chain = {
        firstIssued: payload.iat * 1000,
        refreshCount: 0
      };
      this.refreshChains.set(aid, chain);
    }

    // 检查时长限制（30 天）
    const chainAge = Date.now() - chain.firstIssued;
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 天
    if (chainAge > maxAge) {
      this.refreshChains.delete(aid);
      throw new Error('Refresh chain expired, please re-authenticate');
    }

    // 检查次数限制（720 次）
    if (chain.refreshCount >= 720) {
      this.refreshChains.delete(aid);
      throw new Error('Refresh limit exceeded, please re-authenticate');
    }

    // 生成新 token
    const newToken = await generateJwtToken(aid);
    chain.refreshCount++;

    return { token: newToken, expires_in: 3600 };
  }
}
```

**说明**：
- 这些限制值是推荐值，具体由服务端实现决定
- 可以根据安全需求调整限制值
- 建议在 token payload 中包含刷新链信息

## H.5 证书续期实现

### H.5.1 renew_cert 验证流程

**推荐验证步骤**：
```
1. 客户端调用 auth.aid_login1 获取 nonce
2. 用旧私钥签名 nonce
3. 调用 auth.renew_cert，提交旧证书 + 签名
4. Auth 服务验证：
   - nonce 未被消费且未过期
   - 旧证书中的公钥与签名匹配
   - 旧证书的 Subject 与 AID 一致
   - 旧证书在宽限期内（推荐 ≤ 90 天）
5. Auth 服务用同一公钥生成新 CSR，提交 CA 签发新证书
6. nonce 标记为已消费，不可复用
7. 返回新证书，客户端替换本地证书
```

**安全约束（推荐值）**：
- 宽限期：≤ 90 天（证书过期后 90 天内可续期）
- 超过宽限期：必须重新走 `auth.create_aid`
- 旧证书必须未被吊销
- 新证书复用原公钥

**实现示例**：
```javascript
async function renewCert(params) {
  // 1. 验证 nonce
  await nonceManager.consume(params.aid, params.request_id, params.nonce);

  // 2. 解析旧证书
  const oldCert = new x509.X509Certificate(params.old_cert);

  // 3. 检查证书 Subject 与 AID 一致
  const cn = extractCN(oldCert.subject);
  if (cn !== params.aid) {
    throw new Error('Certificate CN does not match AID');
  }

  // 4. 检查宽限期（90 天）
  const now = Date.now();
  const expiredAt = oldCert.notAfter.getTime();
  const gracePeriod = 90 * 24 * 60 * 60 * 1000; // 90 天

  if (now - expiredAt > gracePeriod) {
    throw new Error('Certificate expired beyond grace period');
  }

  // 5. 检查吊销状态
  const isRevoked = await checkRevocationStatus(oldCert);
  if (isRevoked) {
    throw new Error('Certificate has been revoked');
  }

  // 6. 验证签名（证明持有私钥）
  const publicKey = oldCert.publicKey;
  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(params.signature, 'base64'),
    new TextEncoder().encode(params.nonce)
  );

  if (!isValid) {
    throw new Error('Signature verification failed');
  }

  // 7. 用同一公钥生成新证书
  const newCert = await caService.signCert({
    aid: params.aid,
    publicKey: publicKey,
    validityDays: 365
  });

  return {
    status: 'renewed',
    cert: newCert.certPem,
    ca_cert: newCert.caCertPem
  };
}
```

## H.6 密钥轮转实现

### H.6.1 rekey 验证流程

**推荐验证步骤**：
```
1. 客户端生成新密钥对
2. 调用 auth.aid_login1 获取 nonce
3. 用旧私钥签名 nonce + new_public_key（防止公钥替换攻击）
4. 调用 auth.rekey，提交旧证书 + 新公钥 + 签名
5. Auth 服务验证：
   - nonce 未被消费且未过期
   - 旧证书公钥与签名匹配
   - Subject 与 AID 一致
   - 旧证书在有效期内或宽限期内
6. Auth 服务用新公钥生成 CSR，提交 CA 签发新证书
7. nonce 标记为已消费
8. 返回新证书，客户端保存新证书和新私钥
```

**签名内容**：
```
message = nonce + new_public_key
signature = ECDSA_sign(old_private_key, SHA256(message))
```

**实现示例**：
```javascript
async function rekey(params) {
  // 1. 验证 nonce
  await nonceManager.consume(params.aid, params.request_id, params.nonce);

  // 2. 解析旧证书
  const oldCert = new x509.X509Certificate(params.old_cert);

  // 3. 检查证书 Subject 与 AID 一致
  const cn = extractCN(oldCert.subject);
  if (cn !== params.aid) {
    throw new Error('Certificate CN does not match AID');
  }

  // 4. 检查证书有效期或宽限期
  const now = Date.now();
  const expiredAt = oldCert.notAfter.getTime();
  const gracePeriod = 90 * 24 * 60 * 60 * 1000;

  if (now > expiredAt + gracePeriod) {
    throw new Error('Certificate expired beyond grace period');
  }

  // 5. 验证签名（nonce + new_public_key）
  const message = params.nonce + params.new_public_key;
  const publicKey = oldCert.publicKey;

  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(params.signature, 'base64'),
    new TextEncoder().encode(message)
  );

  if (!isValid) {
    throw new Error('Signature verification failed');
  }

  // 6. 解析新公钥
  const newPublicKey = Buffer.from(params.new_public_key, 'base64');

  // 7. 用新公钥生成新证书
  const newCert = await caService.signCert({
    aid: params.aid,
    publicKey: newPublicKey,
    validityDays: 365
  });

  return {
    status: 'rekeyed',
    cert: newCert.certPem,
    ca_cert: newCert.caCertPem
  };
}
```

## H.7 证书自动续期实现

### H.7.1 login_aid2 自动续期

在 `login_aid2` 响应中，当证书有效期过半时自动返回新证书：

**实现示例**：
```javascript
async function checkAndRenewCert(cert) {
  const now = Date.now();
  const notBefore = cert.notBefore.getTime();
  const notAfter = cert.notAfter.getTime();
  const totalValidity = notAfter - notBefore;
  const remaining = notAfter - now;

  // 有效期过半时自动续期
  if (remaining < totalValidity / 2) {
    const newCert = await caService.signCert({
      aid: extractCN(cert.subject),
      publicKey: cert.publicKey,
      validityDays: 365
    });

    return {
      new_cert: newCert.certPem,
      ca_cert: newCert.caCertPem
    };
  }

  return null;
}

// 在 login_aid2 响应中使用
async function loginAid2(params) {
  // ... 验证签名等 ...

  const token = await generateJwtToken(params.aid);
  const result = {
    status: 'ok',
    aid: params.aid,
    token,
    expires_in: 3600
  };

  // 检查是否需要续期
  const cert = new x509.X509Certificate(params.cert);
  const renewResult = await checkAndRenewCert(cert);

  if (renewResult) {
    result.new_cert = renewResult.new_cert;
  }

  return result;
}
```

**说明**：
- 自动续期是可选功能，由服务端实现决定
- 推荐在证书有效期过半时触发
- 客户端应检查 `new_cert` 字段并更新本地证书

---

## H.8 Token 生命周期与证书轮换实现

### H.8.1 Token 生命周期管理

**推荐配置**：
- **有效期**：1-24 小时（推荐 1 小时）
- **过期处理**：客户端需要重新认证
- **刷新机制**：通过 `auth.refresh_token` 刷新
- **刷新限制**：刷新链总时长不超过 30 天，或最多刷新 720 次

**双 Token 模式**（推荐）：
```
短期 access_token（1 小时）+ 长期 refresh_token（7 天）
access_token 过期后，用 refresh_token 换取新的 access_token
达到刷新限制后，必须重新用证书签名登录
```

### H.8.2 证书轮换参考数值

各层级证书轮换的推荐数值：

| 层级 | 典型有效期 | 过渡期 | 影响范围 |
|------|-----------|--------|---------|
| Root CA | 20-30 年 | 数年 | 全局信任锚，所有客户端证书库需更新 |
| Issuer CA | 10-15 年 | 1-2 年 | 该 Issuer 下所有 Agent |
| Auth 服务证书 | 1-2 年 | ≤ 旧 token 最大剩余有效期 | 已签发的 JWT |

**说明**：以上数值为推荐值，具体由各 Issuer 的安全策略决定。

### H.8.3 审计与监控

**推荐审计日志**：
- Auth 服务记录所有 token 签发日志
- 服务记录 token 验证失败日志
- 可以追踪异常 token 使用模式（如短时间内大量刷新、跨地域使用等）

**Token 撤销**（推荐实现）：
- 维护 token 黑名单（内存或 Redis）
- 检测到异常时可主动撤销 token
- 黑名单条目在 token 自然过期后自动清理

---
