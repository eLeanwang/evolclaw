# AUN-E2EE 扩展规范

> 版本：2.0-draft
> 状态：规范性文档
> 适用范围：AUN 客户端 SDK、客户端应用、跨语言实现
> 不适用范围：Gateway、Message 模块的加解密实现
> 定位：**独立安全层**，横跨 `gateway`、`peer`、`relay` 三种连接模式

---

## 1. 目标与边界

AUN-E2EE 定义 AUN 客户端之间的端到端消息层加密协议。

本规范的目标是：

- 让 A 与 B 在现有 `message.send` / `event/message.received` 之上实现端到端加密
- 让 Gateway、Message 模块仅看到最小必要路由元数据和密文 payload
- 为各语言 SDK 提供统一的密文格式、降级策略、重放保护和错误语义

服务端职责为：

- 认证发送方
- 校验消息路由权限
- 透传 `encrypted: true` 的 payload
- 存储和转发密文 payload
- 存储和分发接收方预存的临时公钥（Prekey）

---

## 2. 无状态设计哲学

AUN-E2EE 的核心工程哲学是**完全无状态**——每条消息独立可解密，不依赖任何历史状态。

### 2.1 设计选择

经典 IM 协议（Signal Double Ratchet、MLS TreeKEM）通过维护有状态的棘轮链实现消息级前向安全和 post-compromise security。AUN-E2EE 有意放弃这条路径，选择每条消息独立生成临时 ECDH 密钥对，原因如下：

| 有状态方案的代价 | AUN 场景下的问题 |
|----------------|----------------|
| 必须维护 per-peer 的 ratchet state | Agent 可能跨进程、跨设备、无持久连接 |
| 消息必须按序处理 | Agent 通信天然异步、乱序 |
| 状态丢失导致断链 | Agent 重启频繁，断链不可接受 |
| 需要双向在线握手建立会话 | Agent 可能长期离线 |

### 2.2 无状态的含义

- `E2EEManager` 是**纯工具类**，不持有任何会话状态
- 每条消息的加密密钥仅取决于当次生成的临时密钥对 + 对方的 prekey/长期公钥
- 客户端重启、状态丢失、消息乱序均不影响后续消息的加解密
- 不存在"断链"的概念——任何一条消息都可以独立解密

### 2.3 安全折中

无状态设计放弃了：

- **Post-compromise Security**：密钥泄露后无法通过 ratchet 自愈（通过 prekey 每小时轮换 + 7 天过期来限制影响范围）
- **消息级前向安全的连续演进**：不像 Double Ratchet 那样每条消息的 key 都从上一条演进而来

换来了：

- **零断链风险**：任何故障场景下都不会丢失解密能力
- **零状态同步**：无需 seq 计数器、无需 chain index、无需 skipped key 缓存
- **极简实现**：各语言 SDK 可以独立实现，不需要复杂的状态机
- **天然适配 Agent 场景**：跨进程、跨设备、无持久连接均可正常工作

这一哲学同样延伸到群组 E2EE（见 [08-AUN-E2EE-Group](./08-AUN-E2EE-Group.md)）。

---

## 3. 协议分层与 AUN-Core 的关系

AUN-E2EE 是 Layer 3 扩展协议，建立在以下核心能力之上：

- `message.send`
- `event/message.received`
- `message.pull`
- AID + 证书链身份体系

密文消息通过普通 `message.send` 承载；Gateway 和 Message 模块无需识别其内部字段。

---

## 4. 明文信封与密文载荷

### 4.1 明文信封

以下字段必须保持为服务端可见的明文，以便进行路由和离线存储：

- `to`
- `persist`
- `encrypted`
- `message_id`
- `timestamp`
- `type`

### 4.2 密文载荷

业务内容位于 `payload` 中，由发送方客户端在调用 `message.send` 前完成加密。服务端不负责加解密，不验证 `payload` 是否真的是密文。

---

## 5. 术语

### 5.1 Prekey

接收方预先生成的临时 ECDH 密钥对。公钥（附身份签名）上传到服务端，私钥保存在本地。发送方获取后用于 ECDH 密钥协商。Prekey 不消耗（可多次读取），定期轮换。

### 5.2 密文消息

通过 `message.send` 传输的加密业务消息，`encrypted` 必须为 `true`，`payload.type` 必须为 `e2ee.encrypted`。

---

## 6. 算法套件

### 6.1 实现要求

所有 AUN-E2EE 实现：

- **MUST** 支持 `P-256 + HKDF-SHA256 + AES-256-GCM`
- **MAY** 支持其他套件

### 6.2 套件标识

- `P256_HKDF_SHA256_AES_256_GCM`（必须支持）

### 6.3 身份绑定

- 发送方 **MUST** 用接收方证书验证 prekey 签名
- Prekey 签名格式：`sign(identity_private_key, "prekey_id|public_key_b64|created_at")`，其中 `created_at` 为 prekey 创建时间戳（ms）
- 仅交换公钥而不做签名验证的实现**不符合本规范**

---

## 7. 加密模式

AUN-E2EE 支持两种加密模式，SDK 自动按优先级选择。

### 7.1 模式 1：prekey_ecdh_v2（优先）

**条件**：服务端有接收方的 prekey

**流程**：
1. 发送方获取接收方 prekey（含签名）
2. 用接收方证书验证 prekey 签名（含 `created_at` 年龄检查，最大 30 天）
3. 生成临时 ECDH 密钥对
4. 四路 ECDH 派生密钥材料：
   - dh1 = ECDH(ephemeral_private, prekey_public)
   - dh2 = ECDH(ephemeral_private, recipient_identity_public_key)
   - dh3 = ECDH(sender_identity_private, prekey_public)
   - dh4 = ECDH(sender_identity_private, recipient_identity_public_key)
   - combined = dh1 || dh2 || dh3 || dh4
5. HKDF-SHA256(combined, info="aun-prekey-v2:{prekey_id}") → message_key（32 字节）
6. AES-256-GCM(message_key, plaintext, AAD) → ciphertext + tag
7. 发送方用身份私钥对 `ciphertext + tag + aad_bytes` 签名（ECDSA-SHA256），附带 `sender_signature` 和 `sender_cert_fingerprint`

**安全特性**：
- 前向安全（临时密钥用完即丢）
- 一消息一密钥（每条消息独立临时密钥对）
- 四路 ECDH 绑定双方身份（类似 X3DH：dh3/dh4 将发送方身份绑定到密钥协商中），防止 prekey 被替换后的中间人攻击
- 发送方签名提供不可否认性和消息来源认证
- 支持接收方离线

### 7.2 模式 2：long_term_key（降级）

**条件**：接收方无 prekey，但有证书

**流程**：
1. 发送方获取接收方证书
2. 生成临时 ECDH 密钥对
3. 双路 ECDH 派生密钥材料：
   - dh1 = ECDH(ephemeral_private, recipient_identity_public_key)
   - dh2 = ECDH(sender_identity_private, recipient_identity_public_key)
   - combined = dh1 || dh2
4. HKDF-SHA256(combined, info="aun-longterm-v2") → message_key（32 字节）
5. AES-256-GCM(message_key, plaintext, AAD) → ciphertext + tag
6. 发送方用身份私钥对 `ciphertext + tag + aad_bytes` 签名

**安全特性**：
- 一消息一密钥（每条消息独立临时密钥对）
- dh2 绑定双方身份，提供发送方认证
- 无前向安全（长期私钥泄露则历史消息可解密）
- 发送方签名提供不可否认性
- 支持接收方离线

### 7.3 模式选择策略

SDK **MUST** 按以下优先级自动选择：

1. **优先**：prekey_ecdh_v2（服务端有接收方 prekey）
2. **降级**：long_term_key（无 prekey 时，需客户端安全策略允许）

> Python SDK 默认 `require_forward_secrecy=true`，无 prekey 时拒绝 long_term_key 降级并抛出错误。需显式配置 `require_forward_secrecy=false` 才允许降级。

### 7.4 兼容性

- 发送端 **MUST** 使用 `prekey_ecdh_v2` 模式发送

---

## 8. 密文 payload 格式

### 8.1 prekey_ecdh_v2 格式

```json
{
  "type": "e2ee.encrypted",
  "version": "1",
  "encryption_mode": "prekey_ecdh_v2",
  "suite": "P256_HKDF_SHA256_AES_256_GCM",
  "prekey_id": "uuid",
  "ephemeral_public_key": "base64(X9.62 uncompressed point)",
  "nonce": "base64(12 bytes)",
  "ciphertext": "base64",
  "tag": "base64(16 bytes)",
  "sender_signature": "base64(ECDSA-SHA256 over ciphertext+tag+aad_bytes)",
  "sender_cert_fingerprint": "sha256:hex",
  "aad": {
    "from": "alice.agentid.pub",
    "to": "bob.agentid.pub",
    "message_id": "uuid",
    "timestamp": 1710504000000,
    "encryption_mode": "prekey_ecdh_v2",
    "suite": "P256_HKDF_SHA256_AES_256_GCM",
    "ephemeral_public_key": "base64",
    "recipient_cert_fingerprint": "sha256:...",
    "sender_cert_fingerprint": "sha256:...",
    "prekey_id": "uuid"
  }
}
```

### 8.2 long_term_key 格式

```json
{
  "type": "e2ee.encrypted",
  "version": "1",
  "encryption_mode": "long_term_key",
  "suite": "P256_HKDF_SHA256_AES_256_GCM",
  "ephemeral_public_key": "base64(X9.62 uncompressed point)",
  "nonce": "base64(12 bytes)",
  "ciphertext": "base64",
  "tag": "base64(16 bytes)",
  "sender_signature": "base64(ECDSA-SHA256 over ciphertext+tag+aad_bytes)",
  "sender_cert_fingerprint": "sha256:hex",
  "aad": {
    "from": "alice.agentid.pub",
    "to": "bob.agentid.pub",
    "message_id": "uuid",
    "timestamp": 1710504000000,
    "encryption_mode": "long_term_key",
    "suite": "P256_HKDF_SHA256_AES_256_GCM",
    "ephemeral_public_key": "base64",
    "recipient_cert_fingerprint": "sha256:...",
    "sender_cert_fingerprint": "sha256:..."
  }
}
```

### 8.3 AAD 字段

两种模式使用相同的 AAD 字段集（`prekey_id` 仅在 prekey_ecdh_v2 模式中存在）：

| 字段 | 说明 |
|------|------|
| `from` | 发送方 AID |
| `to` | 接收方 AID |
| `message_id` | 消息唯一标识 |
| `timestamp` | 发送时间戳（ms） |
| `encryption_mode` | 加密模式 |
| `suite` | 算法套件 |
| `ephemeral_public_key` | 发送方临时公钥 |
| `recipient_cert_fingerprint` | 接收方证书公钥指纹 |
| `sender_cert_fingerprint` | 发送方证书公钥指纹 |
| `prekey_id` | Prekey 标识（仅 prekey_ecdh_v2） |

AAD 序列化方式：按 key 字典序排列的 JSON，`ensure_ascii=False, sort_keys=True, separators=(",",":")`。

AAD 匹配校验时 **MAY** 跳过 `timestamp`（服务端可能替换外层时间戳）。

---

## 9. Prekey 管理

### 9.1 接收方职责

- **MUST** 上线后上传 prekey
- **SHOULD** 定期轮换 prekey（建议每小时）
- **MUST** 用身份私钥签名 prekey：`sign("prekey_id|public_key_b64|created_at")`
- **MUST** 保留旧 prekey 私钥至少 7 天（解密在途消息）
- Prekey **SHOULD** 每小时轮换，最大有效期 30 天

### 9.2 服务端职责

- **MUST** 存储接收方最新的 prekey
- **MUST** 提供 `message.e2ee.get_prekey` 和 `message.e2ee.put_prekey` RPC
- Prekey 不消耗（读取不删除），由接收方主动覆盖更新

### 9.3 Prekey RPC

**上传 prekey**：

```json
{"method": "message.e2ee.put_prekey", "params": {
  "prekey_id": "uuid",
  "public_key": "base64(DER SubjectPublicKeyInfo)",
  "signature": "base64(ECDSA signature)",
  "created_at": 1710504000000
}}
```

**获取对方 prekey**：

```json
{"method": "message.e2ee.get_prekey", "params": {"aid": "bob.agentid.pub"}}
// 返回: {"found": true, "prekey": {"prekey_id": "...", "public_key": "...", "signature": "...", "created_at": 1710504000000}}
```

---

## 10. 重放保护

### 10.1 本地防重放

- 接收方 **MUST** 维护本地 `seen_messages` 集合
- 以 `{sender_aid}:{message_id}` 为 key 去重
- 同一 key 的消息 **MUST** 被拒绝

### 10.2 服务端防重放（可选增强）

- 接收方 **MAY** 调用 `message.e2ee.record_replay_guard` RPC 进行跨进程防重放
- 参数：`sender_aid`, `message_id`, `encryption_mode`, `timestamp_ms`, `ephemeral_pk_hash`
- 返回 `duplicate: true` 表示消息已被处理

> **注意**：Python SDK 当前仅在单条消息解密路径（推送/单条接收）上调用服务端 replay guard；`message.pull` 批量解密路径仅做本地批内去重，不逐条调用服务端。

### 10.3 防篡改

- 所有路由关键字段纳入 AAD，任何篡改导致 AEAD 解密失败
- 接收方 **MUST** 校验 AAD 中 `from`、`to`、`message_id`、`encryption_mode`、`suite`、`ephemeral_public_key`、`recipient_cert_fingerprint`、`sender_cert_fingerprint` 与 payload 一致

---

## 11. 发送方签名

### 11.1 签名要求

所有 E2EE 加密消息（prekey_ecdh_v2 和 long_term_key 模式）**MUST** 附带发送方签名。

### 11.2 签名载荷

```
sign_payload = ciphertext_bytes + tag_bytes + aad_bytes
```

其中 `aad_bytes` 为 AAD 的 JSON 序列化（`sort_keys=True, separators=(",",":")`）。

### 11.3 签名算法

使用发送方身份私钥（与 AID 证书绑定的密钥对）执行 ECDSA-SHA256 签名。

### 11.4 Envelope 字段

| 字段 | 说明 |
|------|------|
| `sender_signature` | base64 编码的 ECDSA-SHA256 签名 |
| `sender_cert_fingerprint` | 发送方证书公钥指纹，格式 `sha256:hex`，用于接收方查找证书验签 |

### 11.5 接收端行为

- 接收方 **MUST** 验证 `sender_signature`
- 缺少 `sender_signature` 的消息 **MUST** 被拒绝（返回解密失败）
- 验签失败的消息 **MUST** 被拒绝
- 接收方通过 `sender_cert_fingerprint` 查找本地缓存的发送方证书公钥进行验签

---

## 12. 安全约定

- 加密失败时 **MUST NOT** 静默降级为明文
- 临时密钥用完即丢
- Prekey 私钥 **SHOULD** 加密存储
- 每条消息使用独立的临时密钥对和 nonce

---

## 13. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.0-draft-r3 | 2026-04 | 明确前向保密默认策略；补充 server_replay_guard 覆盖范围说明 |
| 2.0-draft-r2 | 2026-04 | prekey_ecdh_v2 升级为四路 ECDH（§7.1）；long_term_key 改为 2DH+HKDF 取代 ECIES（§7.2）；新增发送方签名（§11）；AAD 增加 sender_cert_fingerprint 和 prekey_id（§8.3）；prekey 签名格式增加 created_at（§6.3, §9.1）|
| 2.0-draft-r1 | 2026-04 | 升级为 prekey_ecdh_v2（四路 ECDH）；HKDF info 改为 `aun-prekey-v2:{prekey_id}` |
| 2.0-draft | 2026-04 | 简化为 prekey_ecdh_v2 + long_term_key 两级降级；移除在线协商（ephemeral_ecdh）；移除会话状态机；E2EEManager 退化为纯工具类 |
| 1.0-draft | — | 初始版本，三级降级（ephemeral_ecdh + prekey + long_term_key） |
