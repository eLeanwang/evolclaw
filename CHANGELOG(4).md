# Changelog

本文件记录 fastaun (Python) SDK 的版本变更。最新版本在最前面。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## 0.4.8 — 2026-06-03

### 新功能
- `_cert_utils.py` 新增 `normalize_fingerprint_hex`、`cert_fingerprint_hexes`、`cert_matches_fingerprint`、`public_key_matches_fingerprint`、`public_key_fingerprint` 指纹工具函数，支持 16 位短指纹、`sha256:` 前缀、冒号分隔等多种格式（四语言对齐）
- `build_agent_md_signature_block` 新增可选 `public_key_fingerprint` 字段写入签名块（四语言对齐）
- `aid.py` 签名时写入 `public_key_fingerprint`；验签返回结果携带该字段（四语言对齐）
- `_v2_sender_pub_der_from_cache_or_cert` 新增 `cert_fingerprint` 参数，缓存命中和 PKI 拉取后均做指纹比对（四语言对齐）
- `agent_md.py` `_resolve_peer` 新增 `cert_fingerprint` 参数，从签名块提取指纹后精确匹配对端 AID（四语言对齐）

### 修复
- `aid.py` 证书指纹比较改用 `cert_matches_fingerprint`，兼容短指纹和 SPKI 指纹（四语言对齐）
- `_fetch_peer_cert` 移除带指纹失败后降级无指纹请求的回退逻辑（四语言对齐）
- 带指纹的证书缓存只写入带指纹 key，无指纹时才写裸 key，防止旧证书污染新版本查询（四语言对齐）
- 证书缓存命中时增加指纹二次校验，避免裸缓存被错误复用于带指纹查询（四语言对齐）
- `AUNClient.__init__` 构建 `raw_config` 时补充 `verify_ssl`、`debug`、`root_ca_path` 字段透传，防止身份加载后配置丢失
- `_verify_event_signature` 证书指纹比对改用 `cert_matches_fingerprint`（四语言对齐）

### 优化
- `AUNClient` 大规模拆分重构：核心逻辑分散至 `LifecycleController`、`MessageDeliveryEngine`、`RpcPipeline`、`PeerDirectory`、`IdentityRuntimeManager`、`V2E2EECoordinator`、`GroupStateCoordinator` 子组件（四语言对齐）
- `AIDStore.__init__` 移除 `device_id` 参数，改为直接调用 `get_device_id`（四语言对齐）
- `config.py` 以 `get_device_id` 替换 `normalize_device_id`（四语言对齐）
- `aid_store.py` `resolve_peer` 回调支持按 `cert_fingerprint` 精确拉取对应版本证书（四语言对齐）

---

## 0.4.7 — 2026-06-01

### Added
- **`AIDStore.upload_agent_md(aid, content=None)`**：将 `upload_agent_md` 从 `AUNClient` 迁移到 `AIDStore`，支持指定任意本地 AID 上传 agent.md；内部独立创建 `LocalTokenStore` 和 `AuthFlow` 完成认证，不依赖 `AUNClient` 实例。
- **`UploadAgentMdResult` TypedDict**：新增上传结果类型（`aid`、`etag`、`last_modified`、`agent_md_url`）。

### Changed
- **`AUNClient.upload_agent_md()`**：移除，功能迁移至 `AIDStore.upload_agent_md(aid)`。
- **CLI `agentmd upload` 命令**：不再通过 `CLISession`（`AUNClient`）执行，改为直接调用 `AIDStore.upload_agent_md()`。
- **`sqlite_db.py`**：`slot_id_full` 列补齐逻辑提取为独立函数，供多处复用。

---

## 0.4.6 — 2026-06-01

### Added
- **`LocalIdentityStore` 类**（`keystore/local_identity_store.py`）：`KeyStore` Protocol 的文件系统 + SQLite 实现，支持私钥加密存储、证书管理、信任根管理、pending 原子注册。替代 `FileKeyStore`。
- **`LocalTokenStore` 类**（`keystore/local_token_store.py`）：`TokenStore` Protocol 的文件系统实现，不含私钥操作，供 `AuthFlow` / `AUNClient` 持有。
- **`AgentMdManager` 类**（`agent_md.py`）：独立的 agent.md 管理器，负责下载、验证、ETag 缓存、TTL 检查、签名验证，通过回调获取 token/gateway/AID，避免反向依赖 `AUNClient`。
- **`GatewayCertificateVerifier` 类**（`cert_verifier.py`）：独立的网关证书验证器，支持证书链缓存、CRL/OCSP 撤销检查、信任根管理。
- **`KeyStore` 接口新增方法**：`load_cert` / `save_cert`（证书管理）、`change_seed`（种子变更）、`trust_root_dir` / `save_trust_roots` / `save_issuer_root_cert`（信任根管理）。
- **`TokenStore` 接口新增方法**：`get_metadata_value` / `set_metadata_value`（元数据 KV 操作）。
- **`RegisterFlow` 新增公开方法**：`validate_aid_name`、`fetch_peer_cert`、`short_rpc`、`generate_identity`、`new_client_nonce`、`verify_phase1_response`、`reload_trusted_roots`。
- **`AuthFlow` 新增方法**：`cache_gateway_ca_chain` / `discard_gateway_ca_chain`（网关 CA 链缓存管理）。
- **`AIDStore` 新增方法**：`download_agent_md`（替代 `fetch_agent_md`）、`check_agent_md`（替代 `head_agent_md`）。
- **`AUNClient.upload_agent_md()`**：`content` 参数改为可选（`str | None = None`）。

### Changed
- **Keystore 架构重构**：`FileKeyStore` 拆分为 `LocalIdentityStore`（含私钥）和 `LocalTokenStore`（仅 token）；`__all__` 同步更新。
- **Agent.md 管理重构**：缓存、同步逻辑从 `AUNClient` / `AIDStore` 提取到 `AgentMdManager`；`AUNClient` 移除 `_agent_md_path`、`_local_agent_md_etag`、`_remote_agent_md_etag`、`_agent_md_cache` 等内部字段。
- **`AIDStore.fetch_agent_md()`** 重命名为 `download_agent_md()`，返回类型 `FetchAgentMdResult` 重命名为 `DownloadAgentMdResult`。
- **证书验证职责分离**：`AuthFlow` 中的证书验证逻辑提取到 `GatewayCertificateVerifier`；`RegisterFlow` 持有该实例。
- **`AID` 验证、短连接 RPC、身份生成**：从 `AuthFlow` 内部方法迁移到 `RegisterFlow` 公开方法，`AIDStore` 内部调用同步更新。

### Removed
- **`FileKeyStore` 类**：拆分为 `LocalIdentityStore` 和 `LocalTokenStore`，不再导出。
- **`AIDStore.head_agent_md()`**：功能并入 `check_agent_md()`。
- **`AIDStore._agent_md_url()`、`_agent_md_cache`**：由 `AgentMdManager` 接管。

---

## 0.4.5 — 2026-05-31

### Added
- **`RegisterFlow` 独立模块**（`register_flow.py`）：将 AID 注册流程从 `AuthFlow` 中剥离为独立类，负责 keypair 生成、服务端 RPC、pending 目录原子提交、崩溃恢复。
- **`KeyStore` 接口扩展**：新增 pending 目录操作协议（`pending_identity_dir` / `save_pending_key_pair` / `promote_pending_identity` / `discard_pending_identity` 等），支持注册原子性。
- **`FullKeyStore` 组合类型**：`TokenStore + KeyStore` 的组合 Protocol，供注册流程显式使用。

### Changed
- **`AuthFlow` 改用 `TokenStore`**：构造参数 `keystore` 重命名为 `token_store`，类型收窄为 `TokenStore`（不含私钥读写），私钥操作全部移出 `AuthFlow`。
- **`AuthFlow.set_identity()`**：新增方法，由 `AUNClient.load_identity` 注入内存私钥；`AuthFlow` 内部不再从 `token_store` 解密私钥。
- **`AIDStore.register()` 私钥写入职责转移**：注册结果由 `AIDStore` 负责调用 `keystore.save_cert` / `save_key_pair` 写入，`RegisterFlow` 不再直接写 key.json。

---

## 0.4.4 — 2026-05-31

### Added
- **`AID` 新增 `private_key_pem` 只读字段**：`AIDStore.load()` 加载时注入明文私钥，`AUNClient` 直接从 `AID` 读取，无需再经 keystore 解密。

### Changed
- **`AUNClient` 剥离私钥读写**：V2 session 初始化、`_sign_client_operation`、`propose_state` 签名均改从 `_current_aid.private_key_pem` 读取，删除 keystore fallback 重解密路径。
- **`auth._persist_identity` 不再写私钥**：写入前剥离 `private_key_pem` / `public_key_der_b64` / `curve`，AUNClient 的 keystore 只持久化 token / cert / instance_state，彻底避免用空 seed 覆盖写入 key.json。
- **`AUNClient` keystore 构造不再传 `encryption_seed`**：seed 作用域收窄至 AIDStore，不外漏。
- **SQLite 明文化清理**：删除 `_reveal_text` / `_protect_text` 等加密兼容残留代码，所有 SQLite 字段（prekey / group secret / session）直接明文读写。

---

## 0.4.3 — 2026-05-31

### Added
- **`normalize_slot_id` / `slot_isolation_key`**：新增 slot_id 校验与隔离键提取工具函数，支持 `/` `:` 空格作为分隔符（首字符不允许）。
- **`ConnectOptions` 新增字段**：`connection_kind`、`short_ttl_ms`、`extra_info`、`delivery_mode`、`background_sync`，与 Go / TS / JS SDK 对齐。

### Changed
- **`delivery_mode` 语义简化**：移除 `queue_routing` / `affinity_ttl_ms` 便捷字段，统一走 `delivery_mode` dict。
- **slot_id 隔离逻辑**：`connect` 时若目标 slot_id 隔离键与当前不同，自动拒绝跨 slot 连接。

---

## 0.4.2 — 2026-05-30

### Added
- **`AIDStore` 新增结构化返回类型**：`FetchAgentMdResult`、`HeadAgentMdResult`、`CheckAgentMdResult`、`DiagnoseResult`、`RenewCertResult`、`RekeyResult`、`ChangeSeedResult`、`ResolveResult`、`ListResult`（均为 `TypedDict`），替代原来的裸 `dict`。
- **`AUNClientOptions` 新增 `root_ca_path`**：支持私有部署指定自定义根证书路径。
- **`AUNClientOptions` 新增 `debug`**：可在构造时直接传入调试模式开关。

### Changed
- **移除 `discovery_port`**：`AUNClientOptions` 删除 `discovery_port` 字段，gateway URL 改为纯自动发现。
- **`fetch_agent_md` 透传 `verify_ssl` / `root_ca_path` / `debug`**：内部创建 `AIDStore` 时自动注入这三个配置项。

---

## 0.4.0 — 2026-05-30

> **破坏性重构版本。** 身份管理从 `AUNClient` 中剥离为独立的 `AID` / `AIDStore`；删除 `auth` / `custody` / `meta` 三个公开命名空间；引入统一的 `Result` 与字符串错误码；连接状态机扩展为 9 态。升级前请阅读 Breaking Changes。

### Breaking Changes
- **删除公开命名空间**：移除 `client.auth` / `client.custody` / `client.meta`。身份相关功能迁移到 `AIDStore` 与 `AID`，其余 RPC 走 `client.call()`。
- **构造函数签名变更**：`AUNClient.__init__(config)` → `AUNClient(aid: AID | None)`。身份先由 `AIDStore.load()` 离线加载，再传入 client。
- **`connect()` 签名变更**：移除 `auth` 参数，改为 `connect(options)`；身份与认证在 connect 之前完成。
- **连接状态枚举重命名**：`IDLE → NO_IDENTITY`、`CONNECTED → READY`、`TERMINAL_FAILED → CONNECTION_FAILED`，并区分内部状态 `_state` 与对外状态 `_public_state`。
- **目录约定变更**：`{aun_path}/AgentMDs/` → `{aun_path}/AIDs/`。

### Added
- **`AID` 值对象**（`aid.py`）：封装证书 + 可选私钥，提供 `sign` / `verify` / `sign_agent_md` / `verify_agent_md` / `is_cert_valid` / `is_private_key_valid`。
- **`AIDStore` 身份管理器**（`aid_store.py`）：离线 `load` / `list` / `exists`，联网 `register` / `resolve` / `fetch_agent_md` / `diagnose` / `renew_cert` / `rekey` / `change_seed`。
- **`Result[T]` / `ErrorInfo`**（`result.py`）：统一结果类型（`ok` / `data` 或 `error`）。
- **字符串错误码**（`error_codes.py`）：标准化常量（`CERT_NOT_FOUND`、`IDENTITY_CONFLICT`、`KEYPAIR_MISMATCH` 等），跨语言一致。
- **`client.authenticate()`**：完成两阶段认证并缓存 token，但不建立长连接。
- **`client.call()`**：统一 RPC 调用入口（替代已删除命名空间的方法）。
- **实例级 `protected_headers`**：`set_protected_headers()` 设置后自动合并到 `message.send` / `group.send` / `*.thought.put`，调用方显式传参优先。
- **对端 AID 缓存**：peer cache 减少重复 PKI 解析。
- **9 态连接状态机**：`NO_IDENTITY → STANDBY → AUTHENTICATED → CONNECTING → READY`，外加 `RETRY_BACKOFF` / `RECONNECTING` / `CONNECTION_FAILED` / `CLOSED`，重连状态可观测。

### Changed
- **CLI 适配**：`identity list/check/register` 改用 `AIDStore`；移除 `--gateway`（改为自动发现）；新增 `encryption_seed` 配置项。
- **WebSocket 连接超时**：新增 10s 连接超时；`verify_ssl=False` 时跳过 WSS 证书校验。
- **新增 `_cert_utils.py`**：抽取证书签名 / 验证 / 指纹等工具函数。

### Fixed
- **per-namespace 消息处理锁**：防止同一 namespace 并发处理导致的乱序。

### Removed
- 删除 `namespaces/auth_namespace.py`、`namespaces/custody_namespace.py`、`namespaces/meta_namespace.py`（合计约 1763 行）。

---

## 0.3.6 — 2026-05-28

### Added
- **Encrypted push 解密管线**：收到加密推送时即时尝试 V2 解密，成功则发 `message.received` / `group.message_created`（含明文 payload + e2ee 元数据），失败则发 `message.undecryptable` / `group.message_undecryptable`（含诊断字段 `_decrypt_error` / `_decrypt_stage` / `_envelope_type`）
- **`auth.fetch_peer_cert(gateway_url, aid)`**：公开 API 实现落地（v0.3.5 声明，v0.3.6 实现独立方法体）
- **`storage.get_limits` RPC**：查询上传限制和配额使用情况
- **`storage.check_upload` RPC**：上传预检（秒传检测 + 超限检测）

### Fixed
- **Identity cache 自愈**：V2 session init 时检测 `private_key_pem` 缺失，自动从 keystore 重新加载并清理脏 instance_state
- **`_load_identity` 字段白名单**：`load_identity` 只合并 `_INSTANCE_STATE_FIELDS` 定义的字段，防止 instance_state 表中的脏数据覆盖核心字段（如 `private_key_pem`）

### Changed
- **transport 诊断字段**：`_DIAG_PARAM_FIELDS` 新增 `force` 字段

---

## 0.3.5 — 2026-05-28

### Breaking Changes
- **`create_aid()` → `register_aid()`**：客户端 API 重命名，旧方法已移除（服务端 RPC 方法名 `auth.create_aid` 不变）
- **注册与认证分离**：`authenticate()` 不再隐式注册；身份不完整时直接抛 `StateError`，应用层必须先显式调 `register_aid()`

### Added
- **`IdentityConflictError`**：新增错误类型（继承 `AuthError`），AID 注册冲突时抛出（code 4090）
- **`auth.load_identity()`**：公开 API，只读加载本地已注册身份（密钥对 + 证书 + 实例状态），无副作用
- **`auth.load_identity_or_none()`**：同上，不存在时返回 None
- **`auth.fetch_peer_cert()`**：公开 API，获取对端 AID 证书 PEM（本地缓存优先，未命中走 PKI HTTP + 链验证）
- **Pull Gate**：per-key 序列化 pull 操作（`message.pull` / `group.pull` / `group.pull_events`），防止同一 namespace 并发 pull
- **RPC Inflight 限制**：transport 层全局最大 16 个并发 RPC + 后台 RPC 独立限制 8 个，排队超时抛 `TimeoutError`
- **`_assert_cert_matches_local_keypair`**：authenticate 前显式校验 cert 公钥与本地 keypair 一致

### Changed
- **`register_aid` 半成品恢复**：本地有 keypair 无 cert 时，查服务端恢复（而非拒绝）；服务端无记录则用现有 keypair 注册
- **agent.md 元数据存储**：从全局 `list.json` 改为 per-AID `agentmd.json`（与 TS/C++ 对齐）
- **agent.md 下载**：改为无条件 GET（移除 If-None-Match/If-Modified-Since）；304 时本地有缓存直接用，无缓存重试
- **`_load_identity_or_raise`**：增加 keypair 完整性检查（缺 private_key_pem 或 public_key_der_b64 直接抛错）
- **`ensure_authenticated`**：移除隐式创建逻辑，无 cert 直接抛 `StateError`
- **`.seed` fallback 迁移**：启动时检测旧 `.seed` 文件，自动迁移到 `seed_password` 派生方式；迁移失败时 fallback 到旧 seed 内容
- **`ChangeSeed` API**：支持运行时更换 seed（重加密所有私钥和 DB 加密字段）

### Removed
- **`_ensure_local_identity` / `_ensure_identity`**：已移除，注册路径不再隐式生成密钥

## 0.3.3 — 2026-05-25

### Added
- **V2 Thought 加解密**：`_decrypt_group_thoughts` / `_decrypt_message_thoughts` 支持 `group.thought.get` / `message.thought.get` 返回值自动解密；发送端 `message.thought.put` 自动加密
- **V2 Sender IK 延迟解密**：`_schedule_v2_sender_ik_pending` / `_schedule_v2_sender_ik_fetch` / `_resolve_v2_sender_ik_pending`，对端 IK 未缓存时挂起消息、异步拉取后重试解密
- **agent.md 本地缓存体系**：`set_agent_md_path` / `check_agent_md` / `publish_agent_md` / `fetch_agent_md`；基于文件系统的 list.json 索引 + 按 AID 存储内容 + etag 比对 + 自动拉取缺失
- **KeyStore agent_md_cache 持久化**：`FileKeyStore.load_agent_md_cache` / `upsert_agent_md_cache`；SQLite 版本同步支持
- **`auth.head_agent_md` handler**：仅获取对端 agent.md 元信息（etag/last_modified），不下载内容
- **`SeqTracker.update_max_seen` / `repair_contiguous_seq`**：支持 server_ack_seq 推进 retention floor
- **`GatewayDiscovery.discover_all`**：返回所有可用网关 URL 列表（多网关容灾）
- **DNS 容灾连接工厂**：`_make_connection_factory` 支持 `net` 参数注入 DNS 容灾层
- **V2 SPK 设备验签**：`_v2_verify_spk_device` 验证对端 SPK 签名合法性
- **签名跳过策略**：`_should_skip_client_signature` / `_should_skip_event_signature` 对内部方法和系统事件跳过签名
- **`_clamp_ack_params`**：message.ack seq 参数自动钳位，防止客户端发送超前 seq

### Changed
- **V2 消息处理路径重构**：`_decrypt_v2_message` 统一 P2P/Group 解密入口，支持 `allow_pending` 延迟解密模式
- **`_process_and_publish_message`**：增加 slot_id 传递、V2 envelope metadata 附加
- **CLI `aun_cli`**：group 子命令增强（create/join/leave/info/list/send/pull）、diag 子命令增强、config 支持多 profile 切换
- **session 默认选项**：新增 `background_sync: True`

### Fixed
- **service-plane envelope 解包**：修复 Kernel trace 字段传递丢失
- **trace 树状展示**：enter/exit 配对 + 嵌套缩进 + 按 ts 排序 + offset 时间轴

---

## 0.3.1 — 2026-05-22

### Added
- **CLI 工具 `aun_cli`**：基于 typer 的命令行工具，支持 identity（register / login / whoami / list）、message（send / pull）、group、diag 等子命令；TOML profile 配置；统一 table/json/dict/error 输出格式
- **RPC trace 增强**：`RPCTransport` 增加 `set_trace_mode()` / `set_trace_observer()`；client trace 树状展示按 ts 排序 + 嵌套缩进，enter span 携带业务字段、exit span 携带结果或失败上下文
- **`auth.check_aid` handler**：本地证书自检 + 远端注册状态查询
- **V2 群组 SPK 生命周期**：`V2KeyStore.{save,load,load_current}_group_spk`、`V2Session.ensure_group_spk` / `ensure_group_registered` / `rotate_group_spk` / `get_group_decrypt_keys` / `is_last_uploaded_group_spk`
- **`SeqTracker.has_pending_gaps(ns)`**：Pull 返回空时判断是否仍有 push 标记的上界，用于双重修复机制
- **AUNClient 群组 SPK 调度**：`_schedule_group_spk_registration` / `_schedule_group_spk_rotation` / `_schedule_group_spk_registration_after_peer_fallback`
- **消息载荷调试日志**：`_log_message_debug` / `_log_app_message_publish` / `_message_payload_for_debug` 等内部诊断辅助

### Changed
- **`AUNClient._publish_app_event`** 与消息发布路径重构，`_normalize_outbound_message_payload` 在发送前规范化 message params

### Fixed
- short RPC 请求/响应增加完整报文 debug 日志，便于跨语言诊断

---

## 0.3.0 — 2026-05-21 ⚠️ BREAKING CHANGE

> **V2-only 版本**：移除全部 V1 E2EE（含群组加密），新增 V2 加密原语，API 不向后兼容。

### BREAKING
- **移除 V1 E2EE 全部实现**：`GroupE2EEManager`、`e2ee_group.py`、epoch key 相关逻辑全部删除
- **移除 V1 群组加密测试**：`e2e_group_test`、`integration_epoch_key_server_test`、`integration_group_e2ee_test` 等
- **E2EE 接口简化**：`e2ee.py` 仅保留 V2 路径，V1 加解密方法不再可用
- **配置变更**：`AUNConfig` 移除 V1 相关配置项

### Added
- **agent.md 主 API**：`AUNClient.publish_agent_md(path)` 一键完成"读文件 → 签名 → 上传 → 刷新本地 etag"；`AUNClient.fetch_agent_md(aid=None, save_path=None)` 一键完成"下载 → 自动验签 → 可选写盘 → 刷新本地 etag（aid 是自己时）"
- **V2 加密原语**（跨语言 golden vector 一致性）：ECDH P-256、HKDF-SHA256、AES-256-GCM、ECDSA-SHA256 RAW、1DH/3DH wrap_key、Recipients Merkle、State Commitment

### Removed
- `AUNClient.set_local_agent_md_path()` / `get_local_agent_md_etag()` / `get_remote_agent_md_etag()` — 由主 API 自动维护

### Deprecated
- `client.auth.sign_agent_md` / `verify_agent_md` / `upload_agent_md` / `download_agent_md` — 建议迁移到 `client.publish_agent_md` / `client.fetch_agent_md`

---

## 0.2.20 — 2026-05-18

### Added
- **agent.md 版本一致性 API**：`AUNClient.set_local_agent_md_path(path)` / `get_local_agent_md_etag()` / `get_remote_agent_md_etag()`。SDK 自动从 RPC envelope `_meta.agent_md_etag` 提取服务端 etag，应用层订阅 `message.received` / `group.message_created` 等事件时 payload 多 `_agent_md.{local_etag, remote_etag}` 字段供版本比对。
- **`download_agent_md` 条件请求缓存**：内部维护 ETag/Last-Modified，未变化时返回上次缓存内容；外部 API 形态不变。
- **transport meta observer**：`RPCTransport.set_meta_observer(fn)` 透传 envelope `_meta`，observer 抛错被吞，不影响 RPC result。

### Changed
- **RPC call 默认超时 10s → 35s**：与服务端 30s handler timeout 对齐，留 5s buffer，避免短超时把慢路径误判为失败。
- **multi-device 架构**：对端无 prekey 时 `_send_encrypted` 直接抛错（`no registered device prekeys for ...`），不再降级到 `long_term_key`。无 prekey 的接收方需先连一次以上传 prekey。
- **Python `_publish_app_event`**：在 dict payload 上 `setdefault("_agent_md", ...)`，不覆盖业务已有同名字段。

### Fixed
- **Python `_process_and_publish_message` 缺失 `_t_start`**：P2P push 处理在某些路径下抛 `name '_t_start' is not defined`，导致 group/E2EE 测试间歇失败。
- **测试环境 dedup 标记泄漏**：跨域 `message.send` 走 dedup 后若中间步骤抛错（如 self_copies 落库失败），dedup 标记泄漏，重试同 message_id 拿到 `{status: "duplicate", result: None}` 假成功。改为 try/finally 保证 record_result 或 dedup_remove 必有其一。

### Docs
- 仓库根 `docs/`（agent.md 规范、protocol、SDK 手册）随 wheel 打包到 `aun_core/_packed_docs/`，pip 安装后可读。`.gitignore` 排除项（如内部测试指南）不进包。

---
