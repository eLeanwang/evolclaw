# AUN 协议文档索引

> 渐进式三层结构。Layer 1 极简地图；Layer 2 概念倒排索引；Layer 3 每篇文档的详细摘要。

---

## Layer 1: 文档地图

| 编号 | 文件 | 职责 |
|:----:|------|------|
| 00 | [00-总览与分层.md](00-总览与分层.md) | 协议目标、核心原则、四层架构、三种连接模式、文档导航 |
| 01 | [01-身份与凭证协议-auth.md](01-身份与凭证协议-auth.md) | `auth.*` 方法定义、AID/证书/私钥/token 关系、JWT 机制 |
| 02 | [02-证书与信任体系.md](02-证书与信任体系.md) | AID 体系、四级证书链、信任模型、吊销机制 |
| 03 | [03-Gateway-连接模式.md](03-Gateway-连接模式.md) | Gateway 模式定位、initialize 握手、心跳重连 |
| 04 | [04-Peer-子协议.md](04-Peer-子协议.md) | `peer.*` 对等认证四步握手、nonce 签名、状态机 |
| 05 | [05-Relay-子协议.md](05-Relay-子协议.md) | `relay.*` 中继注册转发、透明封装、与 peer.* 关系 |
| 06 | [06-服务协议.md](06-服务协议.md) | 业务层：message.* / meta.* / search.* / task.* / group.* + 跨域消息路由 |
| 07 | [07-错误码与状态机.md](07-错误码与状态机.md) | 错误码汇总、各模式状态机、重试分类 |
| E2EE | [08-AUN-E2EE.md](08-AUN-E2EE.md) | 端到端加密安全层（横跨三种模式） |
| E2EE-Group | [08-AUN-E2EE-Group.md](08-AUN-E2EE-Group.md) | 群组 E2EE：Epoch Group Key、Membership Commitment、密钥恢复 |
| 09 | [09-安全考虑.md](09-安全考虑.md) | 威胁模型、防护措施、升级安全、验签时序 |
| 10 | [10-Group-子协议.md](10-Group-子协议.md) | `group.*` 群组管理、群消息、邀请码、资源共享、在线状态 |

**附录**：A-术语表 | B-扩展性 | C-私钥管理 | D-Root CA 治理 | E-Root CA 准入 | F-Issuer CA 申请 | G-孤儿 AID | H-Auth 实现 | I-跨域消息路由 | J-客户端接入 | K-Agent Web | L-E2EE 实现 | M-JWT 实现

---

## Layer 2: 概念索引

| 概念 | 对应文档 |
|------|---------|
| AID 身份体系 | 00 §0.5, 02 §2.1-2.2 |
| 证书链（Root CA → Issuer CA → Agent） | 02 §2.3-2.4 |
| 证书吊销（CRL/OCSP） | 02 §2.5 |
| 受信根证书列表 | 02 §2.2, 06 meta.trust_roots |
| AID 创建（auth.create_aid） | 01 §1.3 |
| 两阶段登录（auth.aid_login1/2） | 01 §1.4 |
| JWT Token 机制 | 01 §1.7 |
| 证书续期与轮转（renew/rekey） | 01 §1.6 |
| Gateway 连接模式 | 03 |
| initialize 握手 | 03 §3.5 |
| Peer 对等认证 | 04 |
| Relay 中继传输 | 05 |
| 消息收发（message.*） | 06 §6.2 |
| 连接升级（peer.offer/switch） | 06 §6.2 连接升级控制消息 |
| Agent 搜索与发现（search.*） | 06 §6.4 |
| agent.md 规范 | 06 §6.4, 附录K |
| 任务协作（task.*） | 06 §6.5 |
| 跨域消息路由 | 06 §6.7 |
| E2EE 端到端加密 | AUN-E2EE, 06 §6.6 |
| 群组管理（group.*） | 10 |
| 群消息收发（group.send/pull） | 10 §10.5 |
| 群成员权限（owner/admin/member） | 10 §10.2 |
| 邀请码（group.create_invite_code） | 10 §10.7 |
| 群资源共享（group.resources.*） | 10 §10.9 |
| 错误码 | 07 §7.1 |
| 连接状态机 | 07 §7.3 |
| 威胁模型与安全 | 09 |
| 私钥管理 | 附录C |
| 客户端接入示例 | 附录J |

---

## Layer 3: 文档摘要

### 00-总览与分层
协议总入口。定义 AUN 协议目标、核心原则（Gateway 非唯一入口、业务层拓扑无关等）、四层架构概览（安全层 → 通信层 → 协议层 → 服务层）、三种连接模式对比、角色拆分和文档导航。

### 01-身份与凭证协议-auth
定义 `auth.*` 8 个方法：create_aid、aid_login1/2、refresh_token、download_cert、renew_cert、rekey、request_cert。包含 JWT Token 签发/验证机制和安全约束。

### 02-证书与信任体系
AID 格式与命名规则、AUN 网络与根证书管理局、四级证书链（Root CA → Registry CA → Issuer CA → Agent）、终端证书生命周期状态、信任模型与共识场景、CRL/OCSP 吊销机制。

### 03-Gateway-连接模式
Gateway 模式定位与职责、Gateway 发现机制、连接时序（auth.* → initialize → AUTHENTICATED）、initialize 请求/响应格式、心跳与重连策略。

### 04-Peer-子协议
`peer.*` 4 个方法：hello、hello_reply、confirm、confirmed。对称 challenge-response 双向认证，不依赖 JWT。状态机、证书链验证规则、nonce 签名规则、Peer 地址发现。

### 05-Relay-子协议
`relay.*` 3 个方法：register、forward、event/relay.message。Relay 职责边界（零信任笨管道）、透明封装规则、与 peer.* 配合完成端到端认证。

### 06-服务协议（业务层）
认证后可用的业务方法：auth.*（身份管理）、ca.*（证书管理）、message.*（P2P 消息、E2EE prekey）、meta.*（心跳、状态、受信根）、storage.*（文件存储）、group.*（群组）、mail.*（邮件）、stream.*（流式传输）、search.*（Agent 发现）、relay.*（中继）、peer.*（点对点）、task.*（协作任务）。

### 07-错误码与状态机
错误码分层汇总（JSON-RPC 通用 + AUN 协议级 + Peer/Relay/Search/Task/升级扩展码）。三种连接模式状态机。任务状态机。可重试/不可重试分类。

### AUN-E2EE
独立安全层，横跨三种连接模式。定义客户端间 E2EE 加解密（prekey_ecdh_v2 四路 ECDH / long_term_key 两级降级）、prekey 管理、密文格式、AAD 防篡改、防重放保护。无需在线协商。

### AUN-E2EE-Group
群组端到端加密规范。Epoch Group Key 机制（group_secret + HKDF 派生）、Membership Commitment（成员列表 SHA-256 摘要）、密钥分发与恢复协议、CAS epoch 轮换、群组密文格式与 AAD、防重放与降级防护。

### 09-安全考虑
威胁模型、传输层安全、认证安全、JWT 信任模型分析、连接升级安全（降级攻击/假地址注入/信令重放）、公开 AP 同步安全、证书轮换验签时序。

### 10-Group-子协议
`group.*` 命名空间完整协议规范。群组生命周期（create/suspend/close）、成员管理（add/kick/set_role/transfer_owner）、群消息（send/pull/ack）、入群申请与邀请码、群规则与公告、资源共享（put/get/request_add/review_add）、在线状态（go_online/heartbeat）、事件推送（group.created/changed/message_created）、错误码（-33001~-33009）。Group Service 作为独立 AID 持有者运行。
