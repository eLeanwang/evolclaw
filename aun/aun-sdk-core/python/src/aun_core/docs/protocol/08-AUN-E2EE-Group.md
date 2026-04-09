# AUN-E2EE 群组扩展规范

> 版本：1.0-draft
> 状态：规范性文档
> 适用范围：AUN 客户端 SDK、客户端应用、跨语言实现
> 不适用范围：Group Service 服务端加解密实现
> 前置依赖：[08-AUN-E2EE](./08-AUN-E2EE.md)（P2P E2EE 规范）、[10-Group-子协议](./10-Group-子协议.md)
> 定位：**群组消息端到端加密层**，基于 Epoch Group Key 机制

---

## 1. 目标与边界

本规范定义 AUN 群组成员之间的端到端消息加密协议。

### 1.1 目标

- 让群组内的 N 个成员在现有 `group.send` / `event/group.message_created` 之上实现端到端加密
- 让 Group Service 仅看到最小必要路由元数据和密文 payload
- 保持与 P2P E2EE 一致的**无状态设计**——每条群消息独立可解密，不依赖任何历史状态
- 为各语言 SDK 提供统一的群组密文格式、密钥分发协议和恢复机制

### 1.2 服务端职责

Group Service **只做**：

- 认证发送方（JWT token）
- 校验群成员权限
- 透传 `encrypted: true` 的 payload
- 存储和广播密文 payload
- **Epoch 版本协调**：提供 `group.e2ee.get_epoch` 和 `group.e2ee.rotate_epoch` RPC，作为 epoch 版本的 CAS（Compare-And-Swap）同步点，确保并发轮换不冲突

Group Service **绝不做**：

- 加解密群消息
- 持有或管理 group_secret 明文
- 参与密钥协商或密钥派生

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **无状态** | 每条消息独立派生密钥，不维护链式状态，不可能断链 |
| **复用 P2P E2EE** | group_secret 分发完全复用 P2P E2EE 通道（prekey_ecdh_v2 / long_term_key） |
| **不信任服务端** | group_secret 从未经过服务端明文，通过成员列表承诺辅助检测注入 |
| **最小状态** | 每个群客户端需保存 `epoch`、`group_secret`、`commitment`、`member_aids`、`updated_at`；可选保留 `old_epochs[]` 用于历史消息解密 |

### 1.4 无状态设计哲学

本规范延续 P2P E2EE（[08-AUN-E2EE](./08-AUN-E2EE.md) §2）确立的**完全无状态**工程哲学。

经典群组 E2EE 方案（Signal Sender Keys、MLS TreeKEM、ANP Group Session）均维护有状态的密钥链：每个 sender 持有 hash chain，接收方需要同步 chain_index，消息必须按序处理。这在 Agent 场景下带来严重的工程风险：

| 有状态群组方案的代价 | AUN 场景下的问题 |
|-------------------|----------------|
| 每个 sender 一个 chain state | Agent 数量动态变化，状态管理复杂 |
| 消息乱序需要缓存跳过的密钥 | Agent 通信天然异步，乱序是常态 |
| chain_index 不同步导致断链 | 断链后整个群组通信中断，不可接受 |
| 状态丢失不可恢复（独立 Sender Keys） | Agent 重启频繁 |

AUN Group E2EE 选择 **Epoch Group Key**——每条消息从 group_secret + message_id 独立派生密钥，不维护任何链式状态：

- **不可能断链**：消息乱序、丢失、客户端重启均不影响解密
- **状态可恢复**：group_secret 在手，任何消息都能解密；丢失时可向任意成员请求补发
- **O(n) 分发**：无需每个 sender 逐人广播 chain key（Signal/ANP 为 O(n²)）

代价是放弃 epoch 内前向安全（同一 epoch 内的消息共享 group_secret），通过**缩短 epoch 生命周期**（定时轮换）来弥补。

---

## 2. 与 AUN-Core 的关系

AUN-E2EE-Group 建立在以下核心能力之上：

- **P2P E2EE**（08-AUN-E2EE）：group_secret 分发通道
- **Group 子协议**（10-Group-子协议）：群组管理、成员管理、消息传输
- **AID + 证书链身份体系**：成员身份验证

群组密文消息通过 `group.send` 承载；Group Service 无需识别 payload 内部字段。

---

## 3. 术语

### 3.1 Epoch

群组密钥的版本号。每次需要轮换 group_secret 时，epoch 递增。epoch 从 1 开始。

### 3.2 Group Secret

群组对称密钥。256 位随机字节，用于派生每条群消息的加密密钥。每个 epoch 对应一个独立的 group_secret。

### 3.3 Epoch Key Distribution

通过 P2P E2EE 通道向群组成员分发 group_secret 的过程。

### 3.4 Membership Commitment

群成员列表的 SHA-256 摘要，用于防止服务端篡改成员列表。

### 3.5 密文群消息

通过 `group.send` 传输的加密群消息，`encrypted` **MUST** 为 `true`，`payload.type` **MUST** 为 `e2ee.group_encrypted`。

---

## 4. 算法套件

与 P2P E2EE 保持一致：

- **MUST** 支持 `P256_HKDF_SHA256_AES_256_GCM`
- **MAY** 支持其他套件

### 4.1 密钥派生

每条群消息的加密密钥从 group_secret 独立派生：

```
msg_key = HKDF-SHA256(
    ikm    = group_secret,
    salt   = None,
    info   = "aun-group:{group_id}:msg:{message_id}",
    length = 32
)
```

- `group_id`：群组唯一标识
- `message_id`：消息 UUID，由**发送方客户端**在加密前生成（格式 `gm-{uuid}`），写入 AAD 并参与密钥派生。注意：Group Service 会在外层消息记录中填充自己的 `message_id`，该值与 AAD 中的 `message_id` 可能不同。解密时 **MUST** 使用 AAD 中的 `message_id`。

### 4.2 消息加密

```
nonce      = random(12 bytes)
aad_bytes  = canonical_json(aad)
ciphertext = AES-256-GCM(msg_key, nonce, plaintext, aad_bytes)
```

### 4.3 消息解密

接收方从密文 payload 内部的 `aad` 字段读取 `group_id` 和 `message_id`（即发送方加密时写入的原始值），结合本地持有的 `group_secret`，执行相同的 HKDF 派生和 AES-256-GCM 解密。

> **实现注意**：外层消息记录中的 `message_id`、`sender_aid` 由 Group Service 填充，可能与 AAD 中的值不同。密钥派生和 AAD 校验 **MUST** 以 payload 内部的 `aad` 为准。同时，接收方 **MUST** 校验外层 `group_id` 与 AAD 中的 `group_id` 一致，外层 `sender_aid`/`from` 与 AAD 中的 `from` 一致，不一致时拒绝解密。

---

## 5. Epoch 生命周期

### 5.1 Epoch 轮换触发条件

| 触发条件 | 是否 MUST 轮换 | 说明 |
|----------|:-----------:|------|
| 成员被踢出（`group.kick`） | **MUST** | 离开者仍持有旧 group_secret |
| 成员主动退出（`group.leave`） | **MUST** | 离开者仍持有旧 group_secret；剩余在线 admin/owner 负责轮换，离开者自身不执行轮换 |
| 成员加入（`group.add_member`） | **MUST NOT**（默认） | 新成员无旧 group_secret，直接发当前密钥即可；**MAY** 通过 `rotate_on_join` 配置启用加入时轮换 |
| 定时轮换 | **MAY** | 缩小密钥泄露窗口，建议每 24 小时 |
| 管理员手动轮换 | **MAY** | 怀疑密钥泄露时主动触发 |
| 群组解散（`group.dissolve`） | 不适用 | 群组不再存在 |

### 5.2 Epoch 轮换流程

```
1. 触发者（admin/owner）生成新的 group_secret：
   group_secret = random(32 bytes)
   epoch += 1

2. 计算 Membership Commitment（§6）

3. 构建并签名 Membership Manifest（§6A）

4. 通过 P2P E2EE 逐个分发给每个当前成员：
   for member in current_members:
       p2p_encrypt_send(member, {
           type: "e2ee.group_key_distribution",
           group_id,
           epoch,
           group_secret,           // 32 bytes, base64
           commitment,             // SHA-256 hex
           member_aids,            // 排序后的完整成员 AID 列表
           distributed_by,         // 分发者 AID
           distributed_at,         // 分发时间戳（ms）
           manifest                // 签名的 Membership Manifest（§6A）
       })

4. 本地持久化新的 group_secret 和 epoch
5. 安全擦除旧的 group_secret（MAY 保留至旧 epoch 消息超时）
```

### 5.2.1 Epoch CAS 轮换 RPC

通过 `group.e2ee.rotate_epoch` RPC 在服务端进行 CAS（Compare-And-Swap）轮换。

**必填参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `group_id` | string | 群组标识 |
| `current_epoch` | int | 当前 epoch（CAS 条件） |
| `rotation_signature` | string | base64 编码的 ECDSA 签名 |
| `rotation_timestamp` | string | 签名时间戳（Unix 秒），5 分钟新鲜度窗口 |

**签名输入**：`"{group_id}|{current_epoch}|{new_epoch}|{aid}|{rotation_timestamp}"`

服务端 **MUST** 验证签名有效性、时间戳新鲜度，并拒绝重复签名。

### 5.3 新成员加入

新成员加入时 **MUST NOT** 触发 epoch 轮换。执行加入操作的 admin **MUST** 通过 P2P E2EE 向新成员发送当前 group_secret：

```
p2p_encrypt_send(new_member, {
    type: "e2ee.group_key_distribution",
    group_id,
    epoch,                     // 当前 epoch
    group_secret,
    commitment,
    member_aids,               // 含新成员的列表
    distributed_by,
    distributed_at,
    manifest                   // 签名的 Membership Manifest（§6A）
})
```

新成员收到后即可解密当前 epoch 的群消息。是否允许新成员解密加入前的历史消息，由应用层策略决定（§5.5）。

### 5.4 分发职责

group_secret 的分发 **MUST NOT** 依赖单一节点：

| 场景 | 分发者 |
|------|--------|
| 踢人 | 执行 `group.kick` 的 admin/owner |
| 成员退出 | 剩余在线 admin/owner（离开者不执行轮换） |
| 加人 | 执行 `group.add_member` 的 admin |
| 定时轮换 | 任意在线 admin/owner |
| 密钥补发 | 任意持有当前 group_secret 的成员（§8） |

### 5.5 历史消息访问策略

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| **允许看历史**（默认） | 新成员收到当前 group_secret 后可解密本 epoch 内所有历史消息 | 一般群聊 |
| **禁止看历史** | 加入时触发 epoch 轮换，新成员只拿到新 group_secret | 机密频道 |

SDK **SHOULD** 提供配置项 `rotate_on_join: bool`（默认 `false`）。

---

## 6. Membership Commitment

### 6.1 目的

让所有群成员能够**检测**成员列表篡改。当分发者将 group_secret 发送给群成员时，附带一个基于成员列表的哈希摘要。接收方通过重算摘要来验证自己收到的成员列表是否自洽。

> **局限性**：Membership Commitment 是纯哈希校验，不包含密码学签名。它能确保所有成员收到的列表一致（一致性检测），但**不能**独立阻止恶意分发者构造虚假列表。防御幽灵成员注入的有效性依赖于：(1) 合法成员能从其他渠道（如 `group.get_members` RPC）获取可信成员列表并比对；(2) 多个成员的 commitment 互相印证。

### 6.2 计算方式

```
commitment = SHA-256(
    sort(member_aids).join("|") + "|" + str(epoch) + "|" + group_id + "|" + SHA-256(group_secret).hex()
)
```

其中：
- `sort(member_aids)` 为所有当前群成员的 AID 按字典序升序排列
- `SHA-256(group_secret).hex()` 为 group_secret（32 字节原始密钥）的 SHA-256 哈希的十六进制表示
- 将 group_secret 的哈希绑定到 commitment 中，防止恶意分发者替换密钥但保持 commitment 不变

### 6.3 验证流程

接收方收到 `e2ee.group_key_distribution` 消息后 **MUST**：

1. 验证 `commitment == SHA-256(sort(member_aids) + "|" + epoch + "|" + group_id + "|" + SHA-256(group_secret).hex())`
2. 验证自己的 AID 在 `member_aids` 列表中
3. 如果 `member_aids` 与本地已知的成员列表存在差异，**SHOULD** 向用户发出告警
4. **SHOULD** 通过 `group.get_members` RPC 获取服务端成员列表进行比对（如果可用）

### 6.4 防护效果

| 攻击 | 防护级别 | 说明 |
|------|:-------:|------|
| 成员列表不一致 | ✅ 检测 | 所有人收到同一个 commitment，可互相比对 |
| 幽灵成员注入（分发者被骗） | ⚠️ 辅助检测 | 合法成员看到完整列表后有机会发现异常 AID，但需要额外的可信成员列表源进行比对 |
| 幽灵成员注入（分发者串通） | ❌ 无法防御 | commitment 由分发者构造，串通场景下哈希无意义 |
| epoch 轮换阻断 | ⚠️ 需检测 | 需要客户端检测：成员变更事件后应在合理时间内收到新 epoch |
| 选择性消息丢弃 | ❌ 无法防御 | 加密层无法解决，需消息确认/回执机制 |

---

## 6A. Membership Manifest（成员变更授权凭证）

### 6A.1 目的

Membership Commitment（§6）是纯哈希检测，无法证明「谁发起了这次成员变更」。Membership Manifest 补充了密码学签名层，让接收方能验证：

- **谁**发起了 epoch 轮换（`initiator_aid`）
- **哪些成员**被添加或移除（`added`、`removed`）
- 该操作经过了**合法授权**（ECDSA 签名）

### 6A.2 Manifest 结构

```json
{
  "manifest_version": 1,
  "group_id": "grp_abc123",
  "epoch": 2,
  "prev_epoch": 1,
  "member_aids": ["alice.agentid.pub", "bob.agentid.pub", "carol.agentid.pub"],
  "added": ["carol.agentid.pub"],
  "removed": [],
  "initiator_aid": "alice.agentid.pub",
  "issued_at": 1710504000000,
  "signature": "base64(ECDSA-SHA256)"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `manifest_version` | integer | Manifest 格式版本，当前为 `1` |
| `group_id` | string | 群组标识 |
| `epoch` | integer | 本次轮换后的 epoch |
| `prev_epoch` | integer / null | 上一个 epoch（首次创建时为 `null`） |
| `member_aids` | string[] | 本 epoch 的完整成员列表（排序） |
| `added` | string[] | 本次新增的成员 |
| `removed` | string[] | 本次移除的成员 |
| `initiator_aid` | string | 发起者 AID |
| `issued_at` | integer | 签发时间戳（ms） |
| `signature` | string | 发起者对 manifest 内容的 ECDSA-SHA256 签名 |

### 6A.3 签名载荷

签名覆盖除 `signature` 字段外的所有字段，序列化方式：

```
sign_data = canonical_json(manifest_without_signature)
// canonical_json: sort_keys=True, separators=(",",":"), ensure_ascii=False
signature = ECDSA-SHA256(initiator_private_key, sign_data)
```

### 6A.4 验证流程

接收方收到包含 `manifest` 的 `e2ee.group_key_distribution` 消息后 **SHOULD**：

1. 从本地缓存获取 `initiator_aid` 的证书公钥
2. 验证 `signature`
3. 检查 `member_aids` 与 manifest 中 `added`/`removed` 的一致性
4. 检查 `epoch` == `prev_epoch + 1`（首次创建时 `prev_epoch` 为 `null`）
5. 验签失败时 **SHOULD** 拒绝该 distribution（返回 `"distribution_rejected"`）

> **注意**：Manifest 验证是**建议性的**（SHOULD），不是强制性的。这是因为在某些场景下（如跨域成员加入），接收方可能尚未缓存发起者证书。实现 **MAY** 在验签失败时仍接受 distribution，但 **MUST** 在后台尝试获取发起者证书并进行延迟验证。

---

## 7. 消息格式与 AAD

### 7.1 群组密文 payload

```json
{
  "type": "e2ee.group_encrypted",
  "version": "1",
  "encryption_mode": "epoch_group_key",
  "suite": "P256_HKDF_SHA256_AES_256_GCM",
  "epoch": 3,
  "nonce": "base64(12 bytes)",
  "ciphertext": "base64",
  "tag": "base64(16 bytes)",
  "sender_signature": "base64(ECDSA-SHA256 over ciphertext+tag+aad_bytes)",
  "sender_cert_fingerprint": "sha256:hex",
  "aad": {
    "group_id": "grp_abc123",
    "from": "alice.agentid.pub",
    "message_id": "gm-550e8400-...",
    "timestamp": 1710504000000,
    "epoch": 3,
    "encryption_mode": "epoch_group_key",
    "suite": "P256_HKDF_SHA256_AES_256_GCM"
  }
}
```

**发送方签名**：

- 发送方 **MUST** 用身份私钥对 `ciphertext_bytes + tag_bytes + aad_bytes` 执行 ECDSA-SHA256 签名
- `sender_cert_fingerprint` 用于接收方查找发送方证书
- 接收方 **MUST** 验证 `sender_signature`，缺失或验签失败时 **MUST** 拒绝该消息

### 7.2 外层 group.send 信封

```json
{
  "jsonrpc": "2.0",
  "method": "group.send",
  "params": {
    "group_id": "grp_abc123",
    "type": "e2ee.group_encrypted",
    "payload": { "<上述密文 payload>" },
    "encrypted": true
  }
}
```

### 7.3 AAD 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `group_id` | string | 群组唯一标识 |
| `from` | string | 发送方 AID |
| `message_id` | string | 消息唯一标识（发送方客户端生成，参与密钥派生） |
| `timestamp` | integer | 发送时间戳（ms） |
| `epoch` | integer | 当前密钥版本号 |
| `encryption_mode` | string | 固定为 `epoch_group_key` |
| `suite` | string | 算法套件标识 |

AAD 序列化方式与 P2P E2EE 一致：按 key 字典序排列的 JSON，`ensure_ascii=False, sort_keys=True, separators=(",",":")`。

### 7.4 明文信封字段（服务端可见）

以下字段保持为 Group Service 可见的明文，用于路由和存储：

| 字段 | 说明 |
|------|------|
| `group_id` | 群组标识（路由用） |
| `type` | 固定为 `e2ee.group_encrypted` |
| `encrypted` | 固定为 `true` |

`message_id`、`seq`、`sender_aid`、`created_at` 由 Group Service 自动填充到消息记录中。

> **外层与 AAD 绑定校验**：接收方 **MUST** 校验外层 `group_id` 与 AAD 中的 `group_id` 一致（防止跨群路由篡改），外层 `from`/`sender_aid` 与 AAD 中的 `from` 一致（防止发送者冒充）。不一致时 **MUST** 拒绝解密。

---

## 8. 密钥恢复机制

### 8.1 场景

以下场景可能导致成员缺失当前 epoch 的 group_secret：

- P2P 分发消息丢失（网络故障）
- 客户端重启后本地存储损坏
- 成员离线期间发生了 epoch 轮换

### 8.2 Epoch Key Request

缺失密钥的成员 **MAY** 向群内候选成员发送密钥请求（SDK 优先从本地成员列表选择，零状态时退化为向当前消息发送者请求）：

```json
{
  "type": "e2ee.group_key_request",
  "group_id": "grp_abc123",
  "epoch": 3,
  "requester_aid": "bob.agentid.pub"
}
```

此消息 **MUST** 通过 P2P E2EE 通道发送。

### 8.3 Epoch Key Response

收到请求的成员 **MUST** 先验证请求者确实是当前群成员（通过 `group.get_members` 或本地缓存），然后 **MAY** 回复：

```json
{
  "type": "e2ee.group_key_response",
  "group_id": "grp_abc123",
  "epoch": 3,
  "group_secret": "base64(32 bytes)",
  "commitment": "sha256hex",
  "member_aids": ["alice.agentid.pub", "bob.agentid.pub", "carol.agentid.pub"]
}
```

此消息 **MUST** 通过 P2P E2EE 通道发送。

### 8.4 安全约束

- 响应者 **MUST** 验证请求者是群成员后才能回复
- 请求者 **MUST** 验证 commitment 和 member_aids 的一致性（§6.3）
- 实现 **SHOULD** 对 key_request 做频率限制，防止被滥用

### 8.5 恢复时序

密钥恢复是**异步过程**：

1. 成员收到无法解密的群消息（epoch 不匹配或无密钥）
2. SDK 自动向候选成员发送 `e2ee.group_key_request`（优先本地已知成员，零状态时向消息发送者请求）
3. 在线成员验证请求者身份后回复 `e2ee.group_key_response`
4. 请求者收到响应后存储 group_secret，后续 pull 或再次收到消息时才能成功解密

> `group.use_invite_code` 加入群组后不保证立即拥有 group_secret。SDK 会在后续群消息解密失败时自动发起恢复请求。

---

## 9. 客户端密钥存储

### 9.1 存储位置

group_secret **MUST** 持久化到本地存储。推荐存储在 FileKeyStore 的 metadata 中：

```
~/.aun/AIDs/{safe_aid}/tokens/meta.json
```

### 9.2 存储结构

在 metadata 中新增 `group_secrets` 字段：

```json
{
  "e2ee_prekeys": { "..." },
  "group_secrets": {
    "grp_abc123": {
      "epoch": 3,
      "secret_protection": {
        "scheme": "dpapi",
        "name": "group_secrets/grp_abc123/secret",
        "persisted": true,
        "blob": "base64(...)"
      },
      "commitment": "sha256hex...",
      "member_aids": ["alice.agentid.pub", "bob.agentid.pub"],
      "updated_at": 1710504000000,
      "old_epochs": [
        {
          "epoch": 2,
          "secret_protection": { "..." },
          "commitment": "sha256hex...",
          "member_aids": ["alice.agentid.pub", "bob.agentid.pub", "carol.agentid.pub"],
          "updated_at": 1710500000000
        }
      ]
    }
  }
}
```

> **说明**：`old_epochs` 数组保留旧 epoch 的密钥信息，用于解密历史消息。保留期由 `old_epoch_retention_seconds`（默认 7 天）控制，过期后由 SDK 自动清理。

### 9.3 敏感字段保护

- `group_secret` 的明文 **MUST NOT** 直接写入磁盘
- **MUST** 通过 SecretStore（DPAPI / Keychain / libsecret）保护
- 存储格式与 P2P prekey 私钥保护方式一致：明文替换为 `secret_protection` 记录

保护流程：

```
写入时：
  secret_name = f"group_secrets/{group_id}/secret"
  record["secret_protection"] = secret_store.protect(scope, secret_name, group_secret)
  // group_secret 明文不落盘

读取时：
  group_secret = secret_store.reveal(scope, secret_name, record["secret_protection"])
```

### 9.4 旧 Epoch 密钥保留

- 实现 **MAY** 保留旧 epoch 的 group_secret 一段时间（建议 7 天），用于解密在途或离线期间的历史消息
- 旧 epoch 密钥 **SHOULD** 在保留期过后安全擦除
- 旧 epoch 密钥 **MUST NOT** 用于加密新消息

---

## 10. 防重放与防篡改

### 10.1 防篡改

所有路由关键字段纳入 AAD（§7.3），任何篡改导致 AES-GCM tag 校验失败：

- `group_id` 被篡改 → AAD mismatch → 解密异常
- `from`（sender_aid）被替换 → AAD mismatch → 解密异常
- `epoch` 被篡改 → HKDF 派生出错误的 msg_key → 解密失败
- `message_id` 被篡改 → msg_key 派生不同 + AAD mismatch → 解密失败

### 10.2 防重放

群组消息的防重放与 P2P 一致：

- 接收方 **MUST** 维护本地 `seen_messages` 集合
- 以 `{group_id}:{sender_aid}:{message_id}` 为 key 去重
- 同一 key 的消息 **MUST** 被拒绝

### 10.3 Epoch 降级防护

- 接收方 **MUST** 拒绝 epoch 低于本地已知最新 epoch 的加密消息
- 例外：如果实现保留了旧 epoch 密钥（§9.4），**MAY** 允许解密旧 epoch 消息。实现可选择在解密结果中标记 `historical: true`，但不做强制要求

---

## 11. 安全约定

### 11.1 通用约定

- 加密失败时 **MUST NOT** 静默降级为明文
- 每条消息使用独立的随机 nonce
- group_secret **MUST** 由密码学安全随机数生成器生成
- 实现 **MUST NOT** 在日志中输出 group_secret 或 msg_key

### 11.2 分发通道安全

- group_secret 的分发 **MUST** 通过 P2P E2EE 通道（prekey_ecdh_v2 或 long_term_key 模式）
- 分发消息的发送方身份 **MUST** 通过 P2P E2EE 的 AAD 机制验证
- 分发消息 **SHOULD** 附带签名的 Membership Manifest（§6A）

### 11.3 客户端操作签名

以下群组操作 **MUST** 附加客户端 ECDSA 签名（`client_signature` 字段），服务端强制验签：

- `group.send`
- `group.add_member`
- `group.kick`
- `group.leave`
- `group.remove_member`
- `group.update_rules`

签名格式：`"{method}|{aid}|{timestamp}|{params_hash}"`，其中 `params_hash` 为业务字段（排除 `client_signature` 和 `_` 前缀字段）的 JSON SHA-256 哈希。

> Python SDK 自动附加 `client_signature`，裸客户端必须自行实现。

### 11.4 成员移除后的安全保证

- 成员被踢出或退出后 **MUST** 立即触发 epoch 轮换
- 新的 group_secret **MUST NOT** 分发给已离开的成员
- 旧的 group_secret 仅用于解密历史消息，不用于加密新消息

---

## 12. 安全属性分析

### 12.1 安全属性总览

| 属性 | 表现 | 说明 |
|------|:----:|------|
| **epoch 间前向安全** | ✅ | 旧 group_secret 安全擦除后，该 epoch 历史消息不可解密 |
| **epoch 内前向安全** | ❌ | 同一 epoch 内所有消息共享同一 group_secret |
| **Post-compromise Security** | ⚠️ | 下次 epoch 轮换时恢复；可通过定时轮换缩短窗口 |
| **防中间人** | ✅ | group_secret 通过已认证的 P2P E2EE 分发 |
| **防服务端注入** | ✅ 检测 | Membership Commitment 绑定 group_secret（§6），配合 Membership Manifest 签名验证（§6A），提供密钥绑定 + 成员变更授权双重防护 |
| **防篡改** | ✅ | AAD 覆盖所有路由关键字段 |
| **防重放** | ✅ | 本地 seen_messages 去重 |

### 12.2 与 P2P E2EE 的对比

| 维度 | P2P E2EE | Group E2EE |
|------|---------|-----------|
| **加密模式** | prekey_ecdh_v2 / long_term_key | epoch_group_key |
| **密钥来源** | 每消息临时 ECDH | group_secret + HKDF 派生 |
| **前向安全** | 单消息级（每消息独立临时密钥对） | epoch 级 |
| **状态** | 零（纯工具类） | 最小（epoch + group_secret） |
| **可断链** | 不可能 | 不可能 |
| **密码学操作/条** | 1×ECDH + 1×HKDF + 1×AES-GCM | 1×HKDF + 1×AES-GCM |

### 12.3 与其他协议群组方案的对比

| 维度 | AUN (Epoch Group Key) | Signal (Sender Keys) | MLS (TreeKEM) | ANP (独立 Sender Keys) |
|------|:---:|:---:|:---:|:---:|
| **epoch 轮换分发** | O(n) | O(n²) | O(log n) | O(n²) |
| **每消息加密代价** | 1×HKDF + AES | 1×HMAC + AES | 1×HMAC + AES | 1×HMAC + AES |
| **epoch 内前向安全** | ❌ | ✅ | ✅ | ✅ |
| **状态量** | 2 字段 | n 个 chain state | 二叉树 | n 个 chain state |
| **断链风险** | 无 | 有 | 有 | 有 |
| **状态可恢复** | ✅ | ❌ | ❌ | ❌ |

### 12.4 设计折中说明

本方案选择 **epoch 级前向安全**（而非消息级），换取：

1. **零链状态**——不维护 hash chain，不需要 seq 同步
2. **不可能断链**——消息乱序、丢失、重启均不影响后续消息解密
3. **状态可恢复**——任何成员均可通过 epoch_key_request 恢复密钥
4. **O(n) 分发**——无需每个 sender 逐人广播自己的 chain key

epoch 内前向安全的缺失通过**缩短 epoch 生命周期**（定时轮换）来弥补。在 Agent 通信场景中，群组通常生命周期短、成员变更频繁，epoch 自然轮换速度快，该折中是合理的。

---

## 13. 完整交互时序

### 13.1 建群并发送加密消息

```
Alice (owner)                   Group Service                 Bob (member)
─────────────────────────────────────────────────────────────────────────
1. group.create({name: "..."})
   ← {group_id: "grp_abc"}

2. group.add_member({group_id, aid: "bob"})
   ← {member: {...}}

3. 生成 group_secret (epoch=1)
   计算 commitment

4. P2P E2EE → Bob:
   {type: "e2ee.group_key_distribution",
    group_id, epoch: 1,
    group_secret, commitment, member_aids}
                                                        5. 验证 commitment
                                                           存储 group_secret

6. 发送加密群消息:
   msg_key = HKDF(group_secret,
       info="aun-group:grp_abc:msg:gm-xxx")
   ciphertext = AES-GCM(msg_key, plaintext, aad)

   group.send({
     group_id, encrypted: true,
     payload: {type: "e2ee.group_encrypted", ...}
   })
                              ↓ 透传密文
                              → event/group.message_created
                                                        7. 从信封读取 group_id, message_id
                                                           msg_key = HKDF(group_secret,
                                                               info="aun-group:grp_abc:msg:gm-xxx")
                                                           plaintext = AES-GCM.decrypt(...)
```

### 13.2 踢人触发 Epoch 轮换

```
Alice (owner)                   Group Service                 Bob      Carol
────────────────────────────────────────────────────────────────────────────
1. group.kick({group_id, aid: "bob"})
   ← success

2. 生成新 group_secret (epoch=2)
   计算新 commitment（不含 Bob）

3. P2P E2EE → Carol:
   {type: "e2ee.group_key_distribution",
    epoch: 2, group_secret, ...}
                                                                    4. 验证 commitment
                                                                       更新本地 epoch=2

   × Bob 不会收到新 epoch 密钥
   × Bob 的旧 group_secret (epoch=1) 无法解密新消息
```

### 13.3 密钥恢复

```
Carol (成员)                                              Alice (成员)
────────────────────────────────────────────────────────────────────
1. 收到 epoch=3 的群消息
   本地只有 epoch=2 的 group_secret
   解密失败

2. P2P E2EE → Alice:
   {type: "e2ee.group_key_request",
    group_id, epoch: 3}

                                                3. 验证 Carol 是群成员
                                                   P2P E2EE → Carol:
                                                   {type: "e2ee.group_key_response",
                                                    epoch: 3, group_secret, commitment,
                                                    member_aids}

4. 验证 commitment
   存储 group_secret (epoch=3)
   重试解密群消息 → 成功
```

---

## 14. SDK 接口建议

### 14.1 加密

```python
# 通过 AUNClient 自动处理
await client.call("group.send", {
    "group_id": "grp_abc",
    "payload": {"text": "秘密消息"},
    "encrypt": True,
})
```

SDK 在发送前 **MUST** 检查本地是否持有该群的 group_secret：
- 有 → 使用 §4 的流程加密 payload
- 无 → 抛出 `E2EEError`，提示缺少群组密钥

### 14.2 解密

SDK 收到 `event/group.message_created` 且 `payload.type == "e2ee.group_encrypted"` 时自动解密：
- 从信封读取 `group_id`、`message_id`
- 查本地 group_secret（匹配 epoch）
- 执行 HKDF 派生 + AES-GCM 解密
- 解密失败时 **MAY** 触发 epoch_key_request

### 14.3 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `group_e2ee` | bool | `true` | 群组 E2EE 能力声明（必选能力，始终为 true，非用户开关） |
| `rotate_on_join` | bool | `false` | 新成员加入时是否轮换 epoch |
| `epoch_auto_rotate_interval` | int | `0` | 自动轮换间隔（秒），0 表示禁用 |
| `old_epoch_retention_seconds` | int | `604800` | 旧 epoch 密钥保留时间（默认 7 天） |

---

## 15. 错误码

| 错误码 | 名称 | 说明 |
|--------|------|------|
| -32040 | `E2EE_GROUP_SECRET_MISSING` | 缺少该群的 group_secret |
| -32041 | `E2EE_GROUP_EPOCH_MISMATCH` | 消息 epoch 与本地不匹配 |
| -32042 | `E2EE_GROUP_COMMITMENT_INVALID` | Membership Commitment 验证失败 |
| -32043 | `E2EE_GROUP_NOT_MEMBER` | 密钥请求者不是群成员 |
| -32044 | `E2EE_GROUP_DECRYPT_FAILED` | 群消息解密失败 |

---

## 16. 未来扩展方向

以下功能不在本规范范围内，但设计时已预留扩展空间：

### 16.1 Sender Keys 叠加（可选增强）

如需 epoch 内前向安全，可在 Epoch Group Key 基础上叠加 Sender Keys hash chain：

```
sender_chain_key[0] = HKDF(group_secret, info=f"sender:{sender_aid}:epoch:{epoch}")
sender_chain_key[i+1] = SHA-256(sender_chain_key[i])
msg_key[i] = HKDF(sender_chain_key[i], info="msg")
```

此方案从 group_secret 确定性派生，无需额外分发（O(0) 网络开销），但需要维护每个 sender 的 chain_index 状态。详见未来的 `08-AUN-E2EE-Group-SenderKeys.md`。

### 16.2 大群优化

当群规模超过 500 人时，epoch 轮换的 O(n) P2P 分发可能成为瓶颈。可考虑引入树状分发或分层密钥管理。

---

## 17. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0-draft-r4 | 2026-04 | 新增 Epoch CAS 轮换 RPC 的 rotation_signature 要求（§5.2.1）；新增客户端操作签名要求（§11.3）；补充密钥恢复异步语义（§8.5）；补充外层与 AAD 绑定校验说明；升级防服务端注入安全属性 |
| 1.0-draft-r3 | 2026-04 | Membership Commitment 绑定 group_secret 哈希（§6.2）；新增 Membership Manifest 签名机制（§6A）；群密文消息新增发送方签名（§7.1）；更新本地状态模型含 old_epochs（§9.2）；服务端角色明确 epoch CAS 协调（§1.2）；分发消息增加 manifest 字段（§5.2, §5.3） |
| 1.0-draft-r2 | 2026-04 | group_e2ee 默认值改为 true；成员加入轮换策略增加 rotate_on_join 配置说明；group.leave 明确离开者不执行轮换 |
| 1.0-draft-r1 | 2026-04 | 修正：Membership Commitment 去掉 "Signed" 命名，明确为哈希一致性检测而非签名防伪；修正 message_id 来源为客户端生成；新增外层路由字段与 AAD 绑定校验要求 |
| 1.0-draft | 2026-04 | 初始版本：Epoch Group Key 机制；Membership Commitment；密钥恢复协议 |
