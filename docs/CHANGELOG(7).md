# Changelog

本文件记录 `@agentunion/fastaun` (Node.js) SDK 的版本变更。最新版本在最前面。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## 0.4.2 — 2026-05-30

### Added
- **`AIDStore` 新增具名返回类型**：`ResolveResult`、`FetchAgentMdResult`、`HeadAgentMdResult`、`CheckAgentMdResult`、`DiagnoseResult`、`RenewCertResult`、`RekeyResult`、`ChangeSeedResult`、`ListResult`，替代原来的 `Record<string, unknown>`。
- **`AID` 新增 `verifySsl` 只读字段**：创建时由 `AIDStore` 注入，供内部 HTTP 请求使用。
- **`AUNClientOptions` 新增 `rootCaPath` / `debug`**：支持私有部署自定义根证书路径，以及构造时直接传入调试开关。

### Changed
- **移除 `discoveryPort`**：`AIDStore` 构造选项删除 `discoveryPort`，gateway URL 改为纯自动发现。
- **`fetchAgentMd` 新增 `timeoutMs` 参数**（默认 30000ms），`resolve` 内部调用时透传 `opts.timeout`（默认 10000ms）。
- **返回字段精简**：`fetchAgentMd` / `headAgentMd` / `checkAgentMd` / `diagnose` 移除冗余的 camelCase 别名字段，统一使用 snake_case。
- **`resolve` 返回 `source` 字段精简**：移除 `certFromCache` / `agentMdFetched` camelCase 别名，只保留 `cert_from_cache` / `agent_md_fetched`。
- **`AID._create` 透传 `verifySsl` / `rootCaPath` / `debug`**：`AIDStore` 在 `load` / `resolve` 时自动注入这三个配置项到 `AID` 实例。

---

## 0.4.0 — 2026-05-30

> **破坏性重构版本。** 与 Python SDK 0.4.0 对齐：身份管理剥离为 `AID` / `AIDStore`；删除 `auth` / `custody` / `meta` 公开命名空间；引入 `Result` 与字符串错误码；连接状态机扩展为 9 态。

### Breaking Changes
- **删除公开命名空间**：移除 `client.auth` / `client.custody` / `client.meta`。身份相关功能迁移到 `AIDStore` 与 `AID`，其余 RPC 走 `client.call()`。
- **构造函数签名变更**：`constructor(config?, debug?)` → `constructor(aid?: AID, options?: AUNClientOptions)`；移除 `debug` 布尔参数。
- **初始连接状态变更**：`'idle'` → `'no_identity'`。
- **目录约定变更**：`{aun_path}/AgentMDs/` → `{aun_path}/AIDs/`。

### Added
- **`AID` 类**：封装证书 + 可选私钥，提供 `sign` / `verify` / `signAgentMd` / `verifyAgentMd` / `isCertValid` / `isPrivateKeyValid`。
- **`AIDStore` 类**：离线 `load` / `list` / `exists`，联网 `register` / `resolve` / `fetchAgentMd` / `checkAgentMd` / `diagnose` / `renewCert` / `rekey` / `changeSeed`。
- **`Result<T>` 类型**：统一结果类型（`{ ok: true; data: T }` 或 `{ ok: false; error: ErrorInfo }`）。
- **新增错误类**：`NotFoundError` / `IdentityConflictError` / `VersionConflictError` / `ClientSignatureError`。
- **`ConnectionState` 枚举**：9 态（`NO_IDENTITY` / `STANDBY` / `CONNECTING` / `READY` / `RETRY_BACKOFF` / `RECONNECTING` / `CONNECTION_FAILED` / `CLOSED`）。
- **实例级 `protected_headers`**：`setProtectedHeaders()` 自动合并到 `message.send` / `group.send` / `*.thought.put`。
- **重连状态可观测**：`nextRetryAt` / `retryAttempt` / `retryMaxAttempts` / `lastError` / `lastErrorCode` 属性。
- **客户端属性**：`currentAid` / `hasIdentity` / `canSign` / `canConnect` / `canSend`。
- **导出**：`VERSION` 常量、`STATE_TO_PUBLIC` 映射表。
- **keystore 扩展**：新增 `prekeys` / `group_current` / `group_old_epochs` / `e2ee_sessions` 表及相关读写方法；新增字段级加解密（旧 E2EE 互操作）。

### Fixed
- **agent.md 请求超时**：新增 `fetchWithTimeout()` 防止挂起。
- **agent.md 下载并发控制**：新增 `AGENT_MD_DOWNLOAD_CONCURRENCY` 限制。

### Removed
- 删除 `ts/src/namespaces/auth.ts`、`ts/src/namespaces/custody.ts`、`ts/src/namespaces/meta.ts`。

---

## 0.3.6 — 2026-05-28

### Added
- **Encrypted push 解密管线**：收到加密推送时即时尝试 V2 解密，成功则发 `message.received` / `group.message_created`（含明文 payload + e2ee 元数据），失败则发 `message.undecryptable` / `group.message_undecryptable`（含诊断字段 `_decrypt_error` / `_decrypt_stage` / `_envelope_type`）
- **`auth.fetchPeerCert(gatewayUrl, aid)`**：公开 API 实现落地（v0.3.5 声明，v0.3.6 实现独立方法体）
- **`storage.get_limits` RPC**：查询上传限制和配额使用情况
- **`storage.check_upload` RPC**：上传预检（秒传检测 + 超限检测）

### Fixed
- **Identity cache 自愈**：V2 session init 时检测 `private_key_pem` 缺失，自动从 keystore 重新加载并清理脏 instance_state
- **`loadIdentity` 字段白名单**：只合并 `_INSTANCE_STATE_FIELDS` 定义的字段，防止 instance_state 表中的脏数据覆盖核心字段
- **`.seed.migrated` 兼容**：`FileSecretStore` 解密失败时自动尝试 `.seed.migrated.*` 文件作为 fallback（半迁移状态兼容）

### Changed
- **Auth namespace gateway_url 持久化**：`registerAid` / `authenticate` 成功后自动持久化 gateway_url 到 instance_state

---

## 0.3.5 — 2026-05-28

### Breaking Changes
- **`createAid()` 兼容别名移除**：仅保留 `registerAid()`，旧 `createAid` 已删除
- **注册与认证分离**：`authenticate()` 不再隐式注册；身份不完整时抛 `StateError`

### Added
- **`IdentityConflictError`**：新增错误类型（继承 `AuthError`），AID 注册冲突时抛出
- **`auth.loadIdentityOrNull()`**：公开 API，只读加载本地已注册身份，不存在时返回 null（`auth.loadIdentity()` 已有）
- **`auth.fetchPeerCert()`**：公开 API，获取对端 AID 证书 PEM（本地缓存优先，未命中走 PKI HTTP + 链验证）（已有）

### Changed
- **`registerAid` 半成品恢复**：本地有 keypair 无 cert 时，查服务端恢复；服务端无记录则用现有 keypair 注册（不再直接拒绝）
- **agent.md 下载**：改为无条件 GET（移除条件头）；304 时本地有缓存直接用，无缓存重试
- **错误消息**：所有 `createAid` 引用更新为 `registerAid`
- **`.seed` fallback 迁移**：`FileSecretStore` 启动时检测旧 `.seed` 文件，自动迁移到 `seed_password` 派生方式
- **`ChangeSeed` API**：`FileKeyStore.ChangeSeed()` / `FileKeyStore.changeSeed()` 支持运行时更换 seed

### Removed
- **`namespaces/auth.ts` 中 `createAid` 兼容别名**

---

## 0.3.3 — 2026-05-25

### Added
- **V2 Thought 加解密**：`group.thought.get` / `message.thought.get` 返回值自动解密；发送端自动加密；`attachV2EnvelopeMetadata` 附加 E2EE 元数据
- **V2 Sender IK 延迟解密**：`_v2SenderIKPending` / `_v2SenderIKFetching` 机制，对端 IK 未缓存时挂起消息、异步拉取后重试解密
- **agent.md 本地缓存体系**：`setAgentMdPath` / `publishAgentMd()` / `fetchAgentMd(aid?)`；基于文件系统的 list.json 索引 + 按 AID 存储 + etag 比对 + 自动拉取缺失
- **KeyStore agent_md_cache 持久化**：文件系统 + SQLite 双后端支持
- **V2 辅助函数**：`getV2DeviceId` / `_v2B64ToBytesStrict` / `_v2BytesEqual` / `_v2ConcatBytes` / `_v2LengthPrefixedTextKey` / `_v2LengthPrefixedBytes`
- **V2 envelope 元数据**：`attachV2EnvelopeMetadata` / `attachV2EnvelopeMetadataFromSource` / `extractV2EnvelopeFromSource` / `metadataWithoutAuth`
- **签名跳过策略**：对内部方法和系统事件跳过签名验证

### Changed
- **V2 消息处理路径重构**：统一 P2P/Group 解密入口，支持 sender IK pending 延迟模式
- **V2 SPK rotation**：thought 解密失败时触发 group SPK rotation / registration after peer fallback
- **消息调试日志增强**：thought.get 全链路 debug 日志

### Fixed
- **service-plane envelope 解包**：修复 Kernel trace 字段传递丢失
- **trace 树状展示**：enter/exit 配对 + 嵌套缩进

---

## 0.3.1 — 2026-05-22

### Added
- **`auth.checkAid` handler**：本地证书自检（解析有效期、公钥）+ 远端注册状态查询；新增 `parseCertValidity` / `parseAsn1Time` ASN.1 时间解析
- **RPC trace 增强**：`RPCTransport` 增加 `setTraceMode()` / `setTraceObserver()`；`sortTraceSpansForDisplay` / `formatTraceTree` / `traceDisplay` 树状展示按 ts 排序 + 嵌套缩进；`TraceObserver` 类型导出
- **V2 群组 SPK 生命周期**：`V2KeyStore.saveGroupSPK` / `loadGroupSPK` / `loadCurrentGroupSPK`；`V2Session.ensureGroupRegistered` / `rotateGroupSPK` / `_publishGroupSPK`；`DESTROY_DELAY_MS = 7d`
- **V2 P2P push 解密**：`AUNClient._onV2PushNotification` / `_decryptV2PushMessage` 实现带 payload 的就地解密 + 失败回退到 pull

### Changed
- **`SeqTracker.forceContiguousSeq`**：原 `contiguousSeq = minSeq` 跳过空洞（会丢消息），改为 `contiguousSeq = minSeq - 1` 由连续前缀自然推进，避免误丢

### Fixed
- **`client.ts:4026` 类型错误**：`_publishOrderedMessage` 的 `decrypted` 实参补 `as EventPayload` 断言（`Record<string, unknown>` 与 `JsonValue | Error` 不兼容）
- short RPC 请求增加 `debug` 完整报文日志，便于跨语言诊断

---

## 0.3.0 — 2026-05-21 ⚠️ BREAKING CHANGE

> **V2-only 版本**：移除全部 V1 E2EE（含群组加密），新增 V2 加密原语，API 不向后兼容。

### BREAKING
- **移除 V1 E2EE 全部实现**：`GroupE2EEManager`、V1 epoch key 逻辑全部删除
- **移除 V1 群组加密测试**：`e2ee.test.ts`、`e2ee-group.test.ts`、`epoch-key-server.spec.ts` 等
- **E2EE 接口简化**：`e2ee.ts` 仅保留 V2 路径，V1 加解密方法不再可用
- **配置变更**：`AUNConfig` 移除 V1 相关配置项
- **KeyStore 重构**：`keystore/` 目录结构调整，`aid-db.ts` / `file.ts` 接口变更

### Added
- **agent.md 主 API**：`AUNClient.publishAgentMd(path)` / `AUNClient.fetchAgentMd(aid?, savePath?)`
- **V2 加密原语**（跨语言 golden vector 一致性）：ECDH P-256、HKDF-SHA256、AES-256-GCM、ECDSA-SHA256 RAW (RFC 6979)、1DH/3DH wrap_key、Recipients Sort + Merkle Digest、State Commitment

### Removed
- `AUNClient.setLocalAgentMdPath()` / `getLocalAgentMdEtag()` / `getRemoteAgentMdEtag()` — 由主 API 自动维护

### Deprecated
- `client.auth.signAgentMd` / `verifyAgentMd` / `uploadAgentMd` / `downloadAgentMd` — 建议迁移到 `client.publishAgentMd` / `client.fetchAgentMd`

---

## 0.2.20 — 2026-05-18

### Added
- **agent.md 版本一致性 API**：`AUNClient.setLocalAgentMdPath(path)` / `getLocalAgentMdEtag()` / `getRemoteAgentMdEtag()`。Node 用 `fs.readFileSync` + `crypto.createHash` 计算 etag，浏览器场景返回空串并 warn。SDK 自动从 RPC envelope `_meta.agent_md_etag` 提取服务端 etag，应用层订阅 `message.received` / `group.message_created` 等事件时 payload 多 `_agent_md.{local_etag, remote_etag}` 字段供版本比对。
- **`downloadAgentMd` 条件请求缓存**：内部维护 ETag/Last-Modified，未变化时返回上次缓存内容；外部 API 形态不变。
- **transport meta observer**：`RPCTransport.setMetaObserver(fn)` 透传 envelope `_meta`，observer 抛错被吞，不影响 RPC result。

### Changed
- **RPC call 默认超时 10s → 35s**：与服务端 30s handler timeout 对齐，留 5s buffer。
- **multi-device 架构**：对端无 prekey 时 `_sendEncrypted` 直接抛错（`no registered device prekeys for ...`），不再降级到 `long_term_key`。

### Docs
- 仓库根 `docs/`（agent.md 规范、protocol、SDK 手册）随 npm tarball 打包到 `_packed_docs/`，安装后可读。`.gitignore` 排除项（如内部测试指南）不进包。

---
