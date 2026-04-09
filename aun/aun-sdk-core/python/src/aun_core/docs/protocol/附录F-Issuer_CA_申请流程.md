# Issuer CA 证书申请流程

## F.1 概述

### F.1.1 四级证书体系

AUN 采用四级证书体系，通过 `pathlen` 约束严格限定每级 CA 的签发范围：

| 层级 | 证书 | pathlen | 可签发对象 | 部署方式 |
|:----:|------|:-------:|-----------|---------|
| Level 0 | Root CA | 2 | Registry CA | 离线 HSM，30+ 年 |
| Level 1 | Registry CA | 1 | Issuer CA | 在线服务，5-10 年 |
| Level 2 | Issuer CA | 0 | Agent 终端证书 | 在线（Auth 服务），10 年 |
| Level 3 | Agent 证书 | — | 不可签发 | 终端实体，1-3 年 |

### F.1.2 Registry CA 的角色

**Registry CA** 是 Root CA 签发的在线中间 CA，专门负责 Issuer CA 证书的自动化签发：

- **在线服务**：Registry CA 私钥部署在在线 HSM 中，可自动签发证书
- **职责单一**：只签发 Issuer CA 证书（pathlen:1 强制约束），不签发 Agent 证书
- **自动化验证**：域名所有权验证和泛域名解析验证全程自动化
- **Root CA 隔离**：Root CA 私钥始终离线，只在签发 Registry CA 时使用

### F.1.3 多根证书体系下的 Registry CA

每个 Root CA 运营商独立签发自己的 Registry CA：

```
Root CA A (离线) → Registry CA A (在线) → Issuer CA → Agent
Root CA B (离线) → Registry CA B (在线) → Issuer CA → Agent
```

- Issuer 申请者向**任意一个** Registry CA 提交申请即可
- 不需要多个 Root CA 的签名，一个 Registry CA 签发即可
- 客户端验证时，只要证书链能追溯到**任意一个受信 Root CA**，即为有效

### F.1.4 Issuer CA 申请条件

申请 Issuer CA 证书的组织必须满足：

1. **域名所有权**：必须是 Issuer 域名的合法持有者
2. **HTTPS 服务**：域名必须部署 HTTPS 服务，能在 `/.well-known/` 下放置验证文件
3. **泛域名解析**：必须配置泛域名解析 `*.{issuer}` 指向其服务

## F.2 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Issuer CA 签发系统架构                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  申请者                                                      │
│    │                                                        │
│    │ HTTPS API                                              │
│    ↓                                                        │
│  Registry CA 服务 (在线)                                     │
│    ├─ 接收申请，验证 CSR 格式                                │
│    ├─ 生成签名验证文件，返回给申请者                           │
│    ├─ 验证 .well-known 文件可访问且内容正确                    │
│    ├─ 验证泛域名解析                                         │
│    ├─ 全部通过 → HSM 在线签名，签发 Issuer CA 证书            │
│    ├─ 提交 CT 日志                                           │
│    └─ 返回证书给申请者                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## F.3 Issuer CA 证书申请流程

### F.3.1 整体流程

```
申请者                              Registry CA 服务 (在线)
  │                                        │
  │ 1. 生成密钥对                            │
  │ 2. 创建 CSR                             │
  │ 3. 提交申请 ──────────────────────────>│
  │                                        │ 4. 验证 CSR 格式
  │                                        │ 5. 生成签名验证文件
  │<──── 返回 verification_file ───────────│
  │                                        │
  │ 6. 放置验证文件到                        │
  │    https://{issuer}/.well-known/       │
  │    aun-issuer-verification.json        │
  │                                        │
  │ 7. 通知验证就绪 ─────────────────────>│
  │                                        │ 8. HTTPS 获取验证文件 ✓
  │                                        │ 9. 验证文件签名和内容 ✓
  │                                        │ 10. 泛域名解析验证 ✓
  │                                        │ 11. HSM 在线签名
  │                                        │ 12. 提交 CT 日志
  │<──────── 返回证书 + 证书链 ────────────│
  │                                        │
  │ 13. 部署证书                            │
```

**全程自动化，无需人工审核，分钟级完成。**

### F.3.2 详细步骤

#### 步骤 1-2：申请者生成密钥对和 CSR

申请者在本地安全环境中生成 Issuer CA 密钥对（推荐 P-384）：

```bash
# 生成 P-384 私钥
openssl ecparam -name secp384r1 -genkey -noout -out issuer-ca.key

# 创建 CSR（证书签名请求）
openssl req -new -key issuer-ca.key -out issuer-ca.csr \
  -subj "/CN=aid.pub/O=YourOrganization/C=US" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
```

**CSR 必须包含**：
- `CN`（Common Name）：Issuer 域名（如 `aid.pub`）
- `basicConstraints`：`CA:TRUE, pathlen:0`（只能签发终端证书，不能签发下级 CA）
- `keyUsage`：`keyCertSign, cRLSign`

#### 步骤 3-5：提交申请，获取验证文件

申请者通过 Registry CA 的 HTTPS API 提交申请：

**请求**：
```http
POST https://registry.aun.network/api/v1/issuer-ca/apply
Content-Type: application/json

{
  "issuer": "aid.pub",
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----",
  "contact_email": "admin@aid.pub",
  "organization": "YourOrganization"
}
```

**响应**：
```json
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "pending_verification",
  "verification_file": {
    "content": {
      "application_id": "app-2026-03-16-a1b2c3d4",
      "issuer": "aid.pub",
      "challenge": "e5f6g7h8i9j0k1l2m3n4o5p6",
      "issued_at": "2026-03-16T10:00:00Z",
      "expires_at": "2026-03-17T10:00:00Z",
      "registry_ca": "AUN Registry CA A"
    },
    "signature": "MEUCIQDx..."
  },
  "placement_url": "https://aid.pub/.well-known/aun-issuer-verification.json",
  "created_at": "2026-03-16T10:00:00Z",
  "expires_at": "2026-03-17T10:00:00Z"
}
```
Registry CA 对 CSR 执行以下验证：
- CSR 格式合法（X.509 标准）
- CN 是合法域名
- `basicConstraints` 包含 `CA:TRUE, pathlen:0`
- `keyUsage` 包含 `keyCertSign, cRLSign`
- 密钥算法为 ECDSA P-384（推荐）或 P-256

验证通过后，Registry CA 生成一个**签名验证文件**（JSON 格式，包含 Registry CA 的签名），返回给申请者。

#### 步骤 6：放置验证文件

申请者将收到的验证文件原样放置到域名的 `.well-known` 路径下：

```
https://aid.pub/.well-known/aun-issuer-verification.json
```

文件内容即为 Registry CA 返回的 `verification_file` 字段（包含 `content` 和 `signature`）。

**要求**：
- 必须通过 HTTPS 访问（有效的 TLS 证书）
- 返回 `Content-Type: application/json`
- 文件内容必须与 Registry CA 返回的完全一致（不可修改）

#### 步骤 7：通知验证就绪

申请者放置好文件后，通知 Registry CA 开始验证：

**请求**：
```http
POST https://registry.aun.network/api/v1/issuer-ca/verify
Content-Type: application/json

{
  "application_id": "app-2026-03-16-a1b2c3d4"
}
```

#### 步骤 8-10：自动验证

Registry CA 自动执行三项验证：

**8. HTTPS 文件验证**

```
Registry CA 发起 HTTPS 请求：
  GET https://aid.pub/.well-known/aun-issuer-verification.json

验证：
  ✓ HTTPS 可访问（TLS 证书有效）
  ✓ 返回内容与签发的验证文件一致
  ✓ 签名验证通过（防篡改）
  ✓ 文件未过期（expires_at 未到）
```

**9. 验证文件签名验证**

Registry CA 验证返回的文件中 `signature` 是否为自己签发的有效签名，确保文件未被篡改。

**10. 泛域名解析验证**

```bash
# Registry CA 测试多个随机子域名
dig test-{random1}.aid.pub
dig test-{random2}.aid.pub
dig test-{random3}.aid.pub

# 验证规则：
# ✓ 至少 3 个随机子域名全部能解析
# ✓ 所有子域名解析到相同的 IP 段（允许负载均衡）
# ✓ 可选：验证 HTTPS 服务返回有效响应
```

#### 步骤 11：HSM 在线签名

三项验证全部通过后，Registry CA 使用在线 HSM 自动签发 Issuer CA 证书：

```
证书配置：
- Issuer: Registry CA (CN=AUN Registry CA A)
- Subject: CN=aid.pub
- Serial Number: 唯一序列号
- Validity: 10 年
- Extensions:
  - basicConstraints: critical, CA:TRUE, pathlen:0
  - keyUsage: critical, keyCertSign, cRLSign
  - subjectKeyIdentifier: <hash of Issuer CA public key>
  - authorityKeyIdentifier: <hash of Registry CA public key>
  - AIA: http://aid.pub/ca/cert
  - CRL Distribution Points: http://registry.aun.network/crl
```

**签名操作审计日志**：
```json
{
  "operation": "sign_issuer_ca",
  "application_id": "app-2026-03-16-a1b2c3d4",
  "issuer": "aid.pub",
  "registry_ca": "AUN Registry CA A",
  "timestamp": "2026-03-16T10:05:00Z",
  "hsm_serial": "HSM-67890",
  "certificate_serial": "0x2a3b4c5d6e7f",
  "verification_result": {
    "https_file": "passed",
    "file_signature": "passed",
    "wildcard_dns": "passed"
  },
  "validity": {
    "not_before": "2026-03-16T10:05:00Z",
    "not_after": "2036-03-16T10:05:00Z"
  }
}
```
#### 步骤 12：提交 CT 日志

证书签发后，Registry CA 将 Issuer CA 证书信息写入透明日志（CT）：

- 提交日志条目到 CT 日志服务（包含 Issuer CA 证书、签发 Registry CA、验证结果摘要）
- 获取签名日志证明（SCT）
- SCT 作为独立证明随证书一同返回给申请者

#### 步骤 13：返回证书

验证和签名全部完成后，Registry CA 返回证书：

**响应**：
```json
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "approved",
  "issuer": "aid.pub",
  "certificate": "-----BEGIN CERTIFICATE-----\n...(Issuer CA)...\n-----END CERTIFICATE-----",
  "certificate_chain": [
    "-----BEGIN CERTIFICATE-----\n...(Issuer CA)...\n-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----\n...(Registry CA)...\n-----END CERTIFICATE-----",
    "-----BEGIN CERTIFICATE-----\n...(Root CA)...\n-----END CERTIFICATE-----"
  ],
  "serial_number": "0x2a3b4c5d6e7f",
  "not_before": "2026-03-16T10:05:00Z",
  "not_after": "2036-03-16T10:05:00Z",
  "sct": {
    "log_id": "sha256:<日志服务公钥哈希>",
    "timestamp": 1710576300000,
    "signature": "MEUCIQDx..."
  }
}
```

#### 步骤 14：申请者部署证书

申请者收到证书后：
1. 验证证书链的完整性（Issuer CA ← Registry CA ← Root CA）
2. 将 Issuer CA 私钥安全存储（推荐 HSM）
3. 部署 Auth 服务，配置 Issuer CA 证书和私钥
4. 配置 `https://{issuer}/ca/cert` 返回完整证书链
5. 可选：删除 `.well-known/aun-issuer-verification.json` 验证文件
6. 测试证书签发功能

## F.4 Registry CA API 规范

### F.4.1 提交申请

```http
POST /api/v1/issuer-ca/apply
Content-Type: application/json

{
  "issuer": "aid.pub",
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----",
  "contact_email": "admin@aid.pub",
  "organization": "YourOrganization"
}

Response 201:
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "pending_verification",
  "verification_file": {...},
  "placement_url": "https://aid.pub/.well-known/aun-issuer-verification.json",
  "created_at": "2026-03-16T10:00:00Z",
  "expires_at": "2026-03-17T10:00:00Z"
}
```

### F.4.2 通知验证就绪

```http
POST /api/v1/issuer-ca/verify
Content-Type: application/json

{
  "application_id": "app-2026-03-16-a1b2c3d4"
}

Response 200 (验证通过，直接返回证书):
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "approved",
  "certificate": "...",
  "certificate_chain": [...],
  "serial_number": "...",
  "sct": {...}
}

Response 200 (验证失败):
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "verification_failed",
  "errors": [
    {"check": "https_file", "message": "无法访问 https://aid.pub/.well-known/aun-issuer-verification.json"},
    {"check": "wildcard_dns", "message": "test-abc123.aid.pub 无法解析"}
  ]
}
```

### F.4.3 查询申请状态

```http
GET /api/v1/issuer-ca/status/{application_id}

Response 200:
{
  "application_id": "app-2026-03-16-a1b2c3d4",
  "status": "approved",
  "issuer": "aid.pub",
  "created_at": "2026-03-16T10:00:00Z",
  "issued_at": "2026-03-16T10:05:00Z"
}
```

**状态值**：
- `pending_verification`: 等待申请者放置验证文件并触发验证
- `verification_failed`: 验证失败（可重试）
- `approved`: 已签发，证书可用
- `expired`: 申请已过期（24 小时内未完成验证）

### F.4.4 列出申请历史

```http
GET /api/v1/issuer-ca/applications?issuer=aid.pub

Response 200:
{
  "applications": [
    {
      "application_id": "app-2026-03-16-a1b2c3d4",
      "issuer": "aid.pub",
      "status": "approved",
      "created_at": "2026-03-16T10:00:00Z",
      "issued_at": "2026-03-16T10:05:00Z"
    }
  ]
}
```
## F.5 安全考虑

### F.5.1 Registry CA 安全

- **HSM 保护**：Registry CA 私钥存储在在线 HSM 中（FIPS 140-2 Level 3+）
- **签发范围限制**：pathlen:1 在密码学层面限制只能签发 Issuer CA（pathlen:0），无法签发 Agent 证书
- **速率限制**：限制同一域名的申请频率（如每 24 小时最多 5 次）
- **审计日志**：所有签发操作记录完整审计日志
- **监控告警**：异常签发行为（如短时间大量签发）触发告警

### F.5.2 验证安全

- **防重放攻击**：验证文件包含 `application_id` 和 `expires_at`，一次性使用，有效期 24 小时
- **防伪造**：验证文件包含 Registry CA 的签名，申请者无法伪造或篡改
- **防 DNS 劫持**：泛域名验证使用随机子域名，降低定向劫持风险
- **HTTPS 强制**：验证文件必须通过 HTTPS 访问，防止中间人攻击

### F.5.3 申请者安全责任

- **私钥保护**：Issuer CA 私钥必须安全存储，推荐使用 HSM
- **证书续期**：在证书过期前及时续期（建议提前 3 个月）
- **吊销机制**：私钥泄露时立即申请吊销证书
- **访问控制**：严格控制 Auth 服务的访问权限

## F.6 证书续期流程

Issuer CA 证书到期前（建议提前 3 个月），申请者需要续期：

```
续期流程：
1. 申请者生成新的密钥对和 CSR（推荐轮换密钥）
2. 提交续期申请到 Registry CA（附带旧证书序列号）
3. Registry CA 验证旧证书有效且未吊销
4. Registry CA 重新验证 .well-known 文件和泛域名解析
5. 验证通过 → Registry CA 自动签发新证书
6. 提交 CT 日志
7. 申请者部署新证书，进入双证书过渡期
8. 旧证书到期后退役
```

**续期简化**：续期时 Registry CA 可跳过组织信息审查，只需重新验证域名控制权。

## F.7 证书吊销流程

如果 Issuer CA 私钥泄露或需要紧急吊销：

```
吊销流程：
1. 申请者或 Registry CA 运营方发起吊销请求
2. 验证申请者身份（通过旧证书签名或人工验证）
3. Registry CA 将证书加入 CRL（证书吊销列表）
4. 提交吊销记录到 CT 日志，获取 SCT
5. 通知相关 Gateway 更新证书状态
6. 该 Issuer CA 下的所有 Agent 证书立即失效
```

**紧急吊销**：Registry CA 运营方可在无需申请者确认的情况下紧急吊销（如发现恶意签发），事后通知申请者。

## F.8 Registry CA 的签发与管理

### F.8.1 Registry CA 证书签发

Registry CA 由 Root CA 离线签发，流程与 Root CA 准入类似：

```
Registry CA 签发流程：
1. Root CA 运营商在离线 HSM 环境中生成 Registry CA 密钥对
2. 创建 Registry CA 证书：
   - Issuer: Root CA
   - Subject: CN=AUN Registry CA {name}
   - basicConstraints: CA:TRUE, pathlen:1
   - keyUsage: keyCertSign, cRLSign
   - Validity: 10 年
3. 多人授权（3/5 多签）
4. HSM 签名
5. 部署 Registry CA 在线服务
6. 提交 CT 日志
```

### F.8.2 Registry CA 安全要求

| 项目 | 要求 |
|------|------|
| HSM | FIPS 140-2 Level 3+ |
| 可用性 | 99.9%（7x24 小时） |
| CRL 更新 | 每 1-6 小时 |
| OCSP 响应 | < 2 秒 |
| 审计日志 | 所有签发操作完整记录 |
| 监控 | 异常签发行为实时告警 |

## F.9 与现有 PKI 标准的对比

| 标准 | AUN 对应 | 相似点 | 差异点 |
|------|---------|--------|--------|
| Let's Encrypt ACME | Registry CA 自动签发 | 自动化域名验证、在线签发 | AUN 签发的是 CA 证书而非终端证书 |
| CA/Browser Forum | Issuer CA 申请 | 域名所有权验证 | AUN 增加泛域名解析要求 |
| WebPKI Root → Intermediate → EE | Root → Registry → Issuer → Agent | 多级 CA 层级 | AUN 多一级（Registry CA） |

AUN 的 Registry CA 在线签发模式借鉴了 ACME 协议的自动化理念，在保证 Root CA 离线安全的前提下，将 Issuer CA 签发时间从数周缩短到分钟级。
