# 附录 A：术语表

> 本术语表定义 AUN 协议文档中使用的关键术语，确保术语使用的一致性和准确性。

## A.1 核心概念

### AUN (Agent Union Network)
Agent 联合网络，一个去中心化的通信协议，允许不同 Issuer 运营的 Agent 之间安全通信。AUN 是 ACP 协议的 2.0 版本。

### AID (Agent Identifier)
Agent 标识符（不是 Agent ID），AUN 网络中的全局唯一身份标识。格式为 `{name}.{issuer}`，例如 `alice.aid.pub`。

**组成部分**：
- `name`：Agent 名称，由用户选择
- `issuer`：签发者域名，标识 Agent 所属的 Issuer

### Agent
AUN 网络中的通信实体，可以是人类用户、应用程序、服务或设备。每个 Agent 拥有唯一的 AID 和对应的证书。

### Issuer
证书签发者，运营 Auth 服务和 Gateway 的组织或个人。Issuer 负责为其域名下的 Agent 签发证书。

### 跨域消息路由
不同 Issuer 域之间的消息转发机制。Gateway 间通过 mTLS 建立信任，验证对方证书链后中转消息。

### Bootstrap（首次引导）
客户端在尚未持有 AID、证书或 JWT token 时，通过开放注册和初次认证完成身份建立的过程。AUN 中通常指“创建 AID -> 获取首张证书 -> 后续登录”的初始接入流程。

## A.2 证书与信任体系

### Root CA (根证书颁发机构)
证书信任链的顶层，签发 Registry CA 证书。Root CA 的证书是自签名的。

### Registry CA (注册中心证书颁发机构)
由 Root CA 签发的中间证书颁发机构，负责审核并签发 Issuer CA 证书。

### Issuer CA (签发者证书颁发机构)
由 Registry CA 签发的中间证书颁发机构，负责为其域名下的 Agent 签发证书。

### Agent 证书
由 Issuer CA 签发给 Agent 的 X.509 证书，包含 Agent 的公钥和 AID 信息。

### 受信根证书列表 (Trusted Root Certificate List)
AUN 根证书管理局维护的受信 Root CA 列表。列表中的 Root CA 签发的 AID 可以在 AUN 网络中互通。

### AUN 根证书管理局 (AUN Root Certificate Authority)
维护受信根证书列表的权威机构，负责 Root CA 的准入审核和列表分发。

### 证书链 (Certificate Chain)
从 Agent 证书到 Root CA 的信任路径：Agent 证书 ← Issuer CA 证书 ← Registry CA 证书 ← Root CA 证书。

### CRL (Certificate Revocation List)
证书吊销列表，包含已被吊销的证书序列号。

### Path Length Constraint（路径长度约束）
X.509 `BasicConstraints` 扩展中的 `pathLen` 限制，用于约束某个 CA 证书之下还允许出现多少层下级 CA。验证证书链时，必须同时检查“签发者是 CA”以及 `pathLen` 数值约束是否满足。

### OCSP (Online Certificate Status Protocol)
在线证书状态协议，实时查询证书是否被吊销。

### OCSP Stapling
OCSP 装订，服务器预先获取 OCSP 响应并在 TLS 握手时提供，减少客户端查询延迟。

## A.3 网络组件

### Gateway
AUN 网络的一种接入模式与对应组件。客户端通过 WebSocket 连接到 Gateway，使用 JSON-RPC 2.0 协议进行通信。Gateway 负责消息路由、连接管理和 Gateway 模式下的认证会话承载。

**关键特性**：
- 不持有客户端私钥
- 仅转发加密消息，无法解密 E2EE 消息
- 通过 JWT Token 验证客户端身份

### Peer
AUN 网络的一种连接模式。两个 Agent 直接建立 WebSocket 连接，不经过 Gateway 或 Relay 转发业务消息。Peer 模式下双方通过 `peer.*` 完成证书互验。

**适用场景**：
- 同一内网
- 已知可达地址
- 低延迟要求

### Relay
AUN 网络的一种连接模式与对应轻量中继组件。Relay 维护 `AID -> WebSocket 连接` 映射，并按目标 AID 转发消息，但不参与身份认证。

**关键特性**：
- 只转发，不验证内层业务语义
- 不签发 JWT
- 典型用于 NAT 后设备互联

### 认证后的 Gateway 会话 (Authenticated Gateway Session)
客户端通过 challenge/response 或 JWT 验证后，在 Gateway 上建立的已认证连接状态。Gateway 会将该会话绑定的身份上下文，例如 `aid`、`role`、`trust_level`、`auth_method`，注入后续转发的 RPC，用于下游服务做访问控制和会话绑定校验。

### Auth 服务 (Auth Service)
身份服务节点，负责 AID 注册、证书签发、身份认证和 JWT Token 签发。

**核心功能**：
- `auth.create_aid`：创建新 AID
- `auth.aid_login1/aid2`：双向认证
- `auth.refresh_token`：刷新 JWT Token
- `auth.renew_cert`：证书续期
- `auth.rekey`：密钥轮转

### 开放注册 (Open Registration)
`auth.create_aid` 采用的注册模式，允许未认证客户端直接请求创建新的 AID。协议层面默认允许客户端申请任意未被占用的 AID，包含先到先得的抢注行为；是否额外叠加邀请码、人工审核、速率限制或保留前缀，属于部署策略，不是协议强制要求。

## A.4 认证与安全

### JWT token (JSON Web Token)
Auth 服务签发的访问凭证，有效期推荐 1 小时。Gateway 持有 JWT token 并用于访问 AUN 服务。

**特性**：
- 使用 ECDSA 签名
- 包含 AID、签发时间、过期时间等 claim
- 可通过 `auth.refresh_token` 刷新

### `iss`（Issuer Claim）
JWT 的签发者声明，用于标识是谁签发了该 token。验证 JWT 时应检查 `iss` 是否等于当前实现约定的 Auth 服务签发者标识。

### `aud`（Audience Claim）
JWT 的受众声明，用于限定 token 的使用范围。AUN 中用于确保 token 仅被当作 AUN 协议访问凭证使用，而不是被其他系统误接受。

### `kid`（Key ID）
JWT Header 中的密钥标识，用于指出该 token 是由哪一把签名密钥或哪一张 Auth 证书签发。证书轮换期间可借助 `kid` 在新旧验签密钥之间做正确匹配。

### Nonce
一次性随机数，用于防止重放攻击。在双向认证流程中使用：
- `client_nonce`：客户端生成，Auth 服务签名
- `server_nonce`：Auth 服务生成，客户端签名

**有效期**：推荐 30 秒

### Device ID
设备唯一标识（UUID v4），用于并发连接控制和多设备管理。同一 AID 可以在多个设备上登录，每个设备有独立的 Device ID。

### mTLS (Mutual TLS)
双向 TLS 认证，客户端和服务器都需要提供证书并验证对方身份。用于跨域消息路由中 Gateway 间的通信。

### Trust Level（信任等级）
认证结果附带的会话信任分级，用于表达当前登录方式或设备状态的可信程度，例如 `low`、`medium`。业务侧可基于信任等级决定是否允许执行敏感操作。

### Auth Method（认证方式）
客户端本次登录所使用的认证方法，例如 `aid`、`pairing_code`、`kite_token`、`oauth`。Gateway 会把该信息作为会话上下文的一部分向下游透传，用于审计、风控或差异化授权。

### E2EE (End-to-End Encryption)
端到端加密，消息在发送方客户端加密，在接收方客户端解密。Gateway 只能转发密文，无法解密消息内容。采用 prekey_ecdh_v2（优先，四路 ECDH）和 long_term_key（降级，双 DH + HKDF）两级策略，每条消息独立密钥，无需在线协商。发送方对每条加密消息附加 ECDSA 签名（sender_signature），接收方强制验签。

**加密流程**：
1. 密钥协商：ECDH (P-256)，通过 prekey 或长期公钥
2. 密钥派生：HKDF-SHA256
3. 对称加密：AES-256-GCM

## A.5 协议与传输

### WebSocket
全双工通信协议，客户端与 Gateway 之间的传输层协议。使用 TLS 加密（wss://）。

### JSON-RPC 2.0
远程过程调用协议，AUN 使用 JSON-RPC 2.0 作为消息格式标准。

**消息类型**：
- **Call**：客户端发起的请求，需要响应
- **Response**：服务端对 Call 的响应
- **Event**：服务端主动推送的事件，需要客户端响应
- **Notification**：单向通知，不需要响应

### initialize
协议握手方法，连接建立后的第一个核心调用。用于声明连接模式、协商协议版本并建立连接级上下文。

**参数**：
- `mode`：连接模式，`gateway` / `peer` / `relay`
- `protocol.min/max`：客户端支持的协议版本范围
- `device.id/type/name/channel`：设备信息
- `token`：Gateway 模式使用的 JWT token

**说明**：
- `gateway`：`initialize` 成功通常即进入已认证状态
- `peer` / `relay`：`initialize` 成功仅表示模式建立，后续仍需完成 `peer.*`

### Mode（连接模式）
指当前连接采用的接入方式。AUN 主协议定义三种平级 mode：
- `gateway`
- `peer`
- `relay`

mode 决定：
- 连接对象是谁
- 认证流程如何执行
- 消息由谁转发

### `peer.offer`
一种通过 `message.send` 承载的控制消息，用于在现有稳定通道上发起“连接升级”提议，例如从 `gateway` 或 `relay` 升级到 `peer`。

**关键点**：
- `peer.offer` 只交换地址和升级意图
- 不单独构成身份信任依据
- 新通道必须重新执行完整认证

### Fallback（回退通道）
当主通道不可用、升级失败或切换尚未完成时，继续保留的旧通道或备用通道。常见于：
- `gateway -> peer` 升级后保留 Gateway
- `relay -> peer` 升级后保留 Relay

Fallback 的目标是保证业务连续性，而不是与主通道无序并发发送同一条业务消息。

### Pre-auth 方法 (Pre-auth Methods)
客户端在完成正式认证之前即可调用的一小组 RPC 方法，用于首次引导、登录握手或获取必要元信息。典型例子包括 `auth.create_aid`、登录前置挑战相关方法，以及证书下载等只读能力。

## A.6 密码学术语

### ECDH (Elliptic Curve Diffie-Hellman)
椭圆曲线 Diffie-Hellman 密钥交换算法，用于 E2EE 消息密钥派生。

### ECDSA (Elliptic Curve Digital Signature Algorithm)
椭圆曲线数字签名算法，用于证书签名和 JWT Token 签名。

### P-256 / P-384
NIST 标准椭圆曲线：
- **P-256**：256 位曲线，默认选择，广泛支持
- **P-384**：384 位曲线，更高安全性，用于内置服务

### X25519
Curve25519 椭圆曲线，用于 ECDH 密钥交换，性能优异。

### Ed25519
Edwards 曲线数字签名算法，基于 Curve25519，用于证书签名。

### SM2 / SM3 / SM4
中国国家密码管理局发布的商用密码算法：
- **SM2**：椭圆曲线公钥密码算法（签名和密钥交换）
- **SM3**：密码杂凑算法（哈希）
- **SM4**：分组密码算法（对称加密）

### AES-256-GCM
高级加密标准（256 位密钥）+ Galois/Counter Mode，提供加密和认证。

### ChaCha20-Poly1305
流密码 ChaCha20 + 认证码 Poly1305，提供加密和认证。

### AEAD (Authenticated Encryption with Associated Data)
带关联数据的认证加密，同时提供机密性、完整性和真实性保证。AES-GCM 和 ChaCha20-Poly1305 都是 AEAD 算法。

## A.7 消息与会话

### Payload
消息负载，实际的消息内容。对协议层透明，可以是任意格式（JSON、文本、二进制等）。

### Prekey
接收方预先生成的临时 ECDH 密钥对。公钥（附身份签名）上传到服务端，私钥保存在本地。发送方获取后用于 ECDH 密钥协商。定期轮换，旧私钥保留 7 天。

### Message ID
消息标识符，全局唯一，用于消息去重、ACK 确认和防重放。

### Timestamp
时间戳，Unix 时间（秒），用于消息排序和时钟偏移检测。

## A.8 命名空间

### 命名空间 (Namespace)
JSON-RPC 方法的分组机制，使用点号分隔，例如 `auth.*`、`message.*`。

**核心命名空间**：
- `auth.*`：身份管理
- `ca.*`：证书签发与管理
- `message.*`：消息收发（含 E2EE prekey 管理 `message.e2ee.*`）
- `meta.*`：元协议（ping、status 等）

**扩展命名空间**：
- `storage.*`：文件存储
- `group.*`：群组通信
- `mail.*`：邮件服务
- `stream.*`：流式传输
- `search.*`：搜索与发现
- `relay.*`：NAT 穿透中继

**仅协议定义（无对应服务）**：
- `peer.*`：点对点直连
- `task.*`：Agent 协作与任务执行

### `agent.md`
Agent 的标准公开描述文档，对标 A2A 生态中的 Agent Card。AUN 中 `search.*` 索引的核心对象，用于公开能力说明、搜索发现和目录展示。

常见字段包括 `aid`、`name`、`type`、`version`、`description`、`visibility`、`updated_at`，并可扩展 `skills`、`input_modes`、`output_modes`、`service_endpoints`、`signature` 等推荐字段。

### AP
提供 `search.*`、索引公开 `agent.md`，并可选择对外公开同步结果的节点或服务。公开 AP 可通过“增量追加 + 周期性快照”同步其他公开 AP 的 `agent.md`，形成全网 Agent 搜索与发现能力。

### Task
`task.*` 中的任务对象。用于表示一次可跟踪、可查询、可追加输入、可取消的 Agent 协作过程，通常包含 `task_id`、`status`、`input`、`artifacts` 和时间戳等字段。

### Task Participant
任务参与者。通常包括 `owner`、`assignee` 以及其他被显式加入的协作者；任务读取和修改权限应以 participant 集合与角色为基础判定。

### Parent Task / Child Task
父任务与子任务。`task.*` 允许一个任务通过 `parent_task_id` 派生多个子任务，用于把复杂协作拆分给不同 Agent 执行；子任务集合可通过 `children` 摘要或 `task.children` 查询。

## A.9 其他术语

### 宽限期 (Grace Period)
证书过期后仍允许续期的时间窗口。推荐值：≤ 90 天。

### 刷新链 (Refresh Chain)
通过 `auth.refresh_token` 连续刷新 JWT Token 形成的链条。推荐限制：总时长 ≤ 30 天，最大刷新次数 ≤ 720 次。

### 临时密钥对 (Ephemeral Keypair)
E2EE 加密时生成的一次性 ECDH 密钥对，用于与接收方 prekey（或长期公钥）做密钥交换。每条消息使用独立的临时密钥对，用完即丢，提供前向保密性。

### 前向保密 (Forward Secrecy)
即使长期密钥泄露，历史会话密钥也无法被破解的安全特性。通过使用临时密钥对实现。

### 游标分页 (Cursor-based Pagination)
使用游标（cursor）而非页码进行分页的方式，适合动态数据集。用于 `message.pull` 等方法。

### 协议版本协商 (Protocol Version Negotiation)
客户端和服务器协商使用的协议版本。客户端提供支持的版本范围（min/max），服务器选择兼容的版本。

---

## A.10 术语使用规范

### 推荐使用
- **AID**（不是 Agent ID）
- **Auth 服务**（带空格）
- **Gateway**（不翻译为"网关"，除非在描述性短语中如"接入网关"）
- **E2EE**（首次出现时注明全称"端到端加密 (E2EE)"）
- **JWT token**（小写 token）

### 避免使用
- ❌ Agent ID（应使用 AID 或 Agent Identifier）
- ❌ Auth服务（缺少空格，应使用 Auth 服务）
- ❌ 网关（作为术语时应使用 Gateway）
- ❌ 端到端加密（作为术语时应使用 E2EE）
- ❌ JWT Token（应使用 JWT token，小写 token）

---
