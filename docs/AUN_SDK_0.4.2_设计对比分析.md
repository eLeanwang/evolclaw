# AUN SDK 0.4.2 — 设计文档 vs 实际实现对比分析

**分析日期**：2026-05-30  
**SDK 版本**：`@agentunion/fastaun@0.4.2`  
**对比基准**：`docs/AUN_SDK_重构设计方案_v3.md`（实际标题 v4.0）

---

## 一、一致的部分

| 设计项 | SDK 0.4.2 实现 |
|--------|---------------|
| 三主体架构 AIDStore / AID / AUNClient | ✅ 全部导出，职责分离 |
| AIDStore 构造 `{ aunPath, encryptionSeed, deviceId?, slotId? }` | ✅ 一致（额外有 `verifySsl?`, `rootCaPath?`, `debug?`） |
| AIDStore.load(aid) → `Result<{ aid: AID }>` | ✅ 一致（同步） |
| AIDStore.list() → `Result<{ identities: AIDInfo[] }>` | ✅ 一致（同步） |
| AIDStore.changeSeed(old, new) → `Result<{ changed, count }>` | ✅ 一致（同步） |
| AIDStore.register(aid) → `Promise<Result<{ registered: true }>>` | ✅ 一致 |
| AIDStore.exists(aid) → `Promise<Result<{ exists: boolean }>>` | ✅ 一致 |
| AIDStore.resolve / fetchAgentMd / headAgentMd / checkAgentMd / diagnose / renewCert / rekey | ✅ 全部存在，0.4.2 已补强类型 |
| AID 只读属性 `aid`, `aunPath`, `certPem`, `publicKey`, `certSubject`, `certNotBefore`, `certNotAfter`, `certIssuer`, `certFingerprint` | ✅ 全部存在 |
| AID.isCertValid() / isPrivateKeyValid() | ✅ 一致 |
| AID.sign / verify / signAgentMd / verifyAgentMd → `Result<T>` | ✅ 一致 |
| Result\<T\> 统一格式 | ✅ 完全一致 |
| AUNClient 构造可选传入 AID | ✅ 一致 |
| AUNClient.loadIdentity / authenticate / connect / disconnect / close | ✅ 全部存在 |
| AUNClient.call / on / off | ✅ 一致 |
| AUNClient capability getters: hasIdentity, canSign, canConnect, canSend, isReady, isOnline, isClosed | ✅ 全部存在 |
| AUNClient 重连 getters: nextRetryAt, nextRetryInSeconds, retryAttempt, retryMaxAttempts, lastError, lastErrorCode | ✅ 全部存在 |
| AUNClient.setProtectedHeaders / getProtectedHeaders | ✅ 一致 |
| AUNClient.publishAgentMd() | ✅ 存在 |
| AUNClient 对端管理: lookupPeer, getPeer, cachePeer, peers | ✅ 全部存在 |
| ConnectionState 枚举 9 个状态 | ✅ 全部一致 |
| AUNClient.state / currentAid / aunPath / gatewayHealth getters | ✅ 存在 |
| ResolveOpts.timeout | ✅ 0.4.2 已补充（默认 10000ms） |

---

## 二、仍存在的差异

### 2.1 返回字段命名：snake_case vs 设计文档的 camelCase

设计文档用 camelCase，SDK 0.4.2 统一改为 snake_case，且 0.4.2 changelog 明确说"移除冗余 camelCase 别名"。

| 设计文档字段 | SDK 0.4.2 实际字段 |
|------------|-----------------|
| `agentMd.verification.status` | `agent_md.verification.status` |
| `source.certFromCache` | `source.cert_from_cache` |
| `source.agentMdFetched` | `source.agent_md_fetched` |
| `renewCert` 返回 `newCertNotAfter` | `new_cert_not_after` |
| `rekey` 返回 `newFingerprint` | `new_fingerprint` |
| `checkAgentMd` 返回 `needsUpdate`, `localEtag`, `remoteEtag`, `lastModified` | `needs_update`, `local_etag`, `remote_etag`（无 `lastModified`，改为 `local_found`/`remote_found`/`ttl_days`） |
| `headAgentMd` 返回 `etag`, `lastModified`, `contentLength` | `etag`, `last_modified`, `content_length`，额外有 `found`, `aid` |
| `diagnose` 返回 `localValid`, `remoteRegistered`, `suggestions` | `local_valid`, `remote_registered`, `suggestions`，额外有 `status`, `local`, `remote` |

**结论**：设计文档需全面改为 snake_case。

---

### 2.2 AID 额外只读属性

设计文档未提及，SDK 0.4.2 实际有：

| 属性 | 类型 | 说明 |
|------|------|------|
| `deviceId` | `string` | 来自创建它的 AIDStore |
| `slotId` | `string` | 来自创建它的 AIDStore |
| `verifySsl` | `boolean` | 0.4.2 新增，由 AIDStore 注入 |
| `rootCaPath` | `string \| null` | 0.4.2 新增，由 AIDStore 注入 |
| `debug` | `boolean` | 0.4.2 新增，由 AIDStore 注入 |

---

### 2.3 AIDInfo 额外字段

设计文档：`{ aid, certNotAfter, certIssuer }`  
SDK 实际：额外有 `certFingerprint: string`

---

### 2.4 AIDStore 构造参数差异

设计文档无 `discoveryPort`（0.4.2 已移除），但 SDK 多了：

| 参数 | 设计文档 | SDK 0.4.2 |
|------|---------|----------|
| `verifySsl?` | 未提及 | 存在 |
| `rootCaPath?` | 未提及 | 存在（0.4.2 新增） |
| `debug?` | 未提及 | 存在（0.4.2 新增） |
| `discoveryPort?` | 未提及 | **已移除**（0.4.2 删除） |

---

### 2.5 AIDStore.close() 未在设计文档中提及

SDK 有 `close(): void`，设计文档无此方法。

---

### 2.6 fetchAgentMd 新增 timeoutMs 参数

设计文档：`fetchAgentMd(aid: string)`  
SDK 0.4.2：`fetchAgentMd(aid: string, timeoutMs?: number)`（默认 30000ms）

---

### 2.7 ~~AUNClient 独立性保留~~ — 已核查，与设计一致

构造函数签名 `constructor(aid?: AID)`，只接受 AID 对象。实现中从 AID 读取 `aunPath`、`verifySsl`、`rootCaPath`、`debug`、`deviceId`——所有配置来自 AID（由 AIDStore 创建时注入）。`AUNClientOptions` 类型虽仍导出，但构造函数不接受它作为参数，仅供内部使用。✅ 与设计一致。

---

### 2.8 uploadAgentMd 是私有方法

设计文档：`uploadAgentMd(content)` 是公开方法。  
SDK 实际：`_uploadAgentMd` 是私有方法，公开只有 `publishAgentMd()`（自动签名+上传）。

---

### 2.9 setLocalAgentMdPath 未移除

设计文档（迁移表 A.2）：`setAgentMdPath` 已移除。  
SDK 实际：`setLocalAgentMdPath` **不是公开方法**，仅在注释中被引用（`client.d.ts:202`）。✅ 与设计一致，此条差异不成立。

---

### 2.10 ConnectionState 枚举命名风格

设计文档用 kebab-case 字符串值（`'no-identity'`, `'retry-backoff'`）。  
SDK 实际用 snake_case（`'no_identity'`, `'retry_backoff'`）。

---

### 2.11 ~~authenticate() 可调状态比设计宽松~~ — 已核查，设计文档正确

代码（`client.js:1578`）：
```js
if (publicState !== ConnectionState.STANDBY) {
    throw new StateError(`authenticate not allowed in state ${publicState}`);
}
```
严格只允许 Standby，与设计文档一致。✅ 此条差异不成立，之前分析有误。

---

## 三、0.4.0 → 0.4.2 已修复的问题

| 问题 | 0.4.0 | 0.4.2 |
|------|-------|-------|
| 返回类型精度 | `Record<string, unknown>` | ✅ 补充了 `ResolveResult`, `FetchAgentMdResult`, `HeadAgentMdResult`, `CheckAgentMdResult`, `DiagnoseResult`, `RenewCertResult`, `RekeyResult`, `ChangeSeedResult`, `ListResult` |
| ResolveOpts.timeout | 缺失 | ✅ 已补充 |
| AIDStore 构造有 `discoveryPort` | 存在 | ✅ 已移除 |

---

## 四、总结

### 一致性评估

| 维度 | 状态 |
|------|------|
| 三主体架构与职责划分 | ✅ 完全一致 |
| AIDStore API 签名 | ✅ 基本一致，字段命名 snake_case 化 |
| AID 值对象与密码学操作 | ✅ 一致，SDK 多了内部配置属性 |
| AUNClient 状态机（9 态） | ✅ 完全一致 |
| Result\<T\> 统一错误处理 | ✅ 完全一致 |
| 返回字段命名风格 | ⚠️ 设计文档 camelCase，SDK 统一 snake_case |
| AUNClient 独立性 | ✅ 与设计一致（构造只接受 AID，配置从 AID 读取） |
| uploadAgentMd 可见性 | ⚠️ 设计说公开，SDK 是私有 |

### 需要更新设计文档的地方

1. 所有返回字段改为 snake_case（`agent_md`、`cert_from_cache`、`new_cert_not_after` 等）
2. ConnectionState 枚举值改为 snake_case（`'no_identity'`、`'retry_backoff'` 等）
3. `load()` / `list()` / `changeSeed()` 标注为同步（去掉 `Promise`）
4. 补充 `AIDStore.close()`、`verifySsl`、`rootCaPath`、`debug` 构造参数
5. 补充 AID 的 `deviceId`、`slotId`、`verifySsl`、`rootCaPath`、`debug` 属性
6. 补充 `AIDInfo.certFingerprint`
7. `fetchAgentMd` 补充 `timeoutMs?` 参数
8. `uploadAgentMd` 改为私有，说明只用 `publishAgentMd`
9. 删除 `discoveryPort` 构造参数

### 已核查确认与设计一致的项（之前误判为不一致）

- ~~`setLocalAgentMdPath` 未移除~~ → 实际已不是公开方法，仅注释引用
- ~~`authenticate()` 可调状态比设计宽松~~ → 实际严格只允许 Standby，与设计一致
