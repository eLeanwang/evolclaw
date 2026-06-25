# AUN SDK 0.4.0 — 设计文档 vs 实际实现对比分析

**分析日期**：2026-05-30  
**SDK 版本**：`@agentunion/fastaun@0.4.0`  
**对比基准**：`docs/AUN_SDK_重构设计方案_v3.md`（实际标题 v4.0）

---

## 一、一致的部分

| 设计项 | SDK 实现 | 状态 |
|--------|----------|:----:|
| **三主体架构** AIDStore / AID / AUNClient | 全部导出，职责分离 | ✅ |
| **AIDStore 构造** `{ aunPath, encryptionSeed, deviceId?, slotId? }` | 完全一致，额外有 `verifySsl`, `discoveryPort`, `rootCaPath`, `debug` | ✅ |
| **AIDStore.load(aid)** 返回 `Result<{ aid: AID }>` | 一致（同步） | ✅ |
| **AIDStore.register(aid)** 返回 `Promise<Result<{ registered: true }>>` | 一致 | ✅ |
| **AIDStore.list()** 返回 `Result<{ identities: AIDInfo[] }>` | 一致（同步） | ✅ |
| **AIDStore.exists(aid)** 返回 `Promise<Result<{ exists: boolean }>>` | 一致 | ✅ |
| **AIDStore.resolve(aid, opts?)** | 一致，`ResolveOpts` 有 `forceRefresh` + `skipAgentMd` | ✅ |
| **AIDStore.fetchAgentMd / headAgentMd / checkAgentMd / diagnose / renewCert / rekey** | 全部存在 | ✅ |
| **AIDStore.changeSeed(old, new)** | 一致（同步） | ✅ |
| **AID 只读属性** `aid`, `aunPath`, `certPem`, `publicKey`, `certSubject`, `certNotBefore`, `certNotAfter`, `certIssuer`, `certFingerprint` | 全部存在 | ✅ |
| **AID.isCertValid() / isPrivateKeyValid()** | 一致 | ✅ |
| **AID.sign / verify / signAgentMd / verifyAgentMd** 返回 `Result<T>` | 一致 | ✅ |
| **VerifyResult** `{ status, payload, reason? }` | 一致，额外有 `aid?`, `cert_fingerprint?`, `timestamp?` | ✅ |
| **Result\<T\>** 统一格式 `{ ok, data } \| { ok, error: { code, message, cause? } }` | 完全一致 | ✅ |
| **AUNClient 构造** 可选传入 AID | 一致：`constructor(options?)` 或 `constructor(aid, options?)` | ✅ |
| **AUNClient.loadIdentity(aid: AID)** | 一致 | ✅ |
| **AUNClient.authenticate() / connect() / disconnect() / close()** | 全部存在 | ✅ |
| **AUNClient.call(method, params)** | 一致 | ✅ |
| **AUNClient.on / off** | 一致 | ✅ |
| **AUNClient capability getters** `hasIdentity`, `canSign`, `canConnect`, `canSend`, `isReady`, `isOnline`, `isClosed` | 全部存在 | ✅ |
| **AUNClient 重连 getters** `nextRetryAt`, `nextRetryInSeconds`, `retryAttempt`, `retryMaxAttempts`, `lastError`, `lastErrorCode` | 全部存在 | ✅ |
| **AUNClient.setProtectedHeaders / getProtectedHeaders** | 一致 | ✅ |
| **AUNClient.publishAgentMd()** | 存在 | ✅ |
| **AUNClient 对端管理** `lookupPeer`, `getPeer`, `cachePeer`, `peers` | 全部存在 | ✅ |
| **ConnectionState 枚举** 9 个状态 | 全部一致 | ✅ |
| **AUNClient.gatewayHealth** getter | 存在 | ✅ |
| **AUNClient.state / currentAid / aunPath** getters | 存在 | ✅ |

---

## 二、不一致 / 差异

### 2.1 同步 vs 异步

| # | 方法 | 设计文档 | SDK 实际 | 影响 |
|---|------|---------|---------|------|
| 1 | `AIDStore.load()` | `Promise<Result<...>>` | **同步** `Result<{ aid: AID }>` | 调用方不需要 await |
| 2 | `AIDStore.list()` | `Promise<Result<...>>` | **同步** `Result<{ identities: AIDInfo[] }>` | 同上 |
| 3 | `AIDStore.changeSeed()` | `Promise<Result<...>>` | **同步** `Result<{ changed, count }>` | 同上 |

**评估**：SDK 实现更优（纯本地操作无需异步），设计文档需更新。

---

### 2.2 类型精度

| # | 方法 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 4 | `AIDStore.resolve()` | `Promise<Result<ResolveData>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 5 | `AIDStore.fetchAgentMd()` | `Promise<Result<AgentMdFetchData>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 6 | `AIDStore.headAgentMd()` | `Promise<Result<AgentMdHeadData>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 7 | `AIDStore.checkAgentMd()` | `Promise<Result<AgentMdCheckData>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 8 | `AIDStore.diagnose()` | `Promise<Result<DiagnoseData>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 9 | `AIDStore.renewCert()` | `Promise<Result<{ renewed, newCertNotAfter }>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |
| 10 | `AIDStore.rekey()` | `Promise<Result<{ rekeyed, newFingerprint }>>`（强类型） | `Promise<Result<Record<string, unknown>>>` |

**评估**：运行时数据可能是完整的，但 `.d.ts` 类型定义未细化。可能是：
- 有意为之（避免频繁改类型定义）
- 或 .d.ts 生成时未展开内部类型

**建议**：确认运行时返回的实际字段是否与设计一致，如果一致则补充 `.d.ts` 类型。

---

### 2.3 AIDStore 额外内容

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 11 | 构造参数 | 只有 `aunPath`, `encryptionSeed`, `deviceId?`, `slotId?` | 多了 `verifySsl?`, `discoveryPort?`, `rootCaPath?`, `debug?` |
| 12 | `close()` 方法 | 未提及 | 存在 `close(): void` |

**评估**：SDK 比设计多了运维/调试参数和资源清理方法，合理扩展。设计文档可补充。

---

### 2.4 AID 额外属性

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 13 | `deviceId` / `slotId` | AID 无此属性 | `readonly deviceId: string` / `readonly slotId: string` |

**评估**：AID 携带创建它的 store 的 deviceId/slotId，便于 AUNClient 使用。合理。

---

### 2.5 AIDInfo 额外字段

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 14 | `AIDInfo` 字段 | `{ aid, certNotAfter, certIssuer }` | 多了 `certFingerprint: string` |

**评估**：有用的额外信息，设计文档可补充。

---

### 2.6 AUNClient 构造与独立性

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 15 | 构造签名 | `constructor(aid?: AID)` | `constructor(options?: AUNClientOptions)` 或 `constructor(aid: AID, options?: AUNClientOptions)` |
| 16 | 独立使用 | 设计说配置由 AIDStore 管理，AUNClient 不接受配置 | `AUNClientOptions` 保留了 `aun_path`, `encryption_seed` 等，AUNClient 可独立使用 |
| 17 | `setLocalAgentMdPath` | 设计说已移除 | 实际仍存在 `setLocalAgentMdPath(path): string` |

**评估**：SDK 保留了向后兼容路径——不强制必须通过 AIDStore 使用 AUNClient。这是务实选择，但与设计文档"AUNClient 只接收 AID"的纯粹设计有偏差。

---

### 2.7 uploadAgentMd 可见性

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 18 | `uploadAgentMd` | 公开方法，在 AUNClient 上 | **私有** `_uploadAgentMd`，仅 `publishAgentMd()` 公开 |

**评估**：SDK 简化了公开 API——`publishAgentMd` 内部自动签名+上传，不再暴露裸上传。设计文档需更新。

---

### 2.8 authenticate 状态约束

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 19 | `authenticate()` 可调状态 | 仅 Standby | Standby **和** Authenticated 都可调 |

**评估**：SDK 允许在 Authenticated 状态重新认证（刷新 token），比设计宽松。合理。

---

### 2.9 connect() 参数

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 20 | `connect()` 参数 | `{ gateway? }` | `connect(options?: RpcParams)` 接受任意 RPC 参数 |

**评估**：更灵活，`gateway` 只是其中一个可选字段。

---

### 2.10 ConnectionState 命名风格

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 21 | 枚举值命名 | kebab-case: `'no-identity'`, `'retry-backoff'` | snake_case: `'no_identity'`, `'retry_backoff'` |

**评估**：设计文档需更新为 snake_case。

---

### 2.11 ResolveOpts 缺少 timeout

| # | 差异 | 设计文档 | SDK 实际 |
|---|------|---------|---------|
| 22 | `ResolveOpts.timeout` | 有，默认 10000ms | 不存在，只有 `forceRefresh?` 和 `skipAgentMd?` |

**评估**：SDK 未实现 timeout 参数。可能内部有默认超时，或后续版本补充。

---

## 三、总结

### 核心设计一致性：高

三主体架构、Result 统一错误处理、AID 不可变值对象、AUNClient 状态机、capability getters——这些核心设计全部落地，且实现质量高。

### 主要偏差分类

| 类别 | 数量 | 严重程度 | 建议 |
|------|:----:|:--------:|------|
| 同步 vs 异步（设计写 Promise，实际同步） | 3 | 低 | 更新设计文档 |
| 类型定义未细化（`Record<string, unknown>`） | 7 | 中 | 确认运行时字段，补充 .d.ts |
| SDK 比设计多内容（额外参数/属性/方法） | 6 | 低 | 更新设计文档 |
| AUNClient 独立性保留（未强制依赖 AIDStore） | 2 | 中 | 决策：是否在后续版本收紧 |
| uploadAgentMd 变私有 | 1 | 低 | 更新设计文档 |
| 命名风格（kebab vs snake） | 1 | 低 | 更新设计文档 |
| ResolveOpts 缺 timeout | 1 | 低 | 后续版本补充或设计文档删除 |

### 建议优先级

1. **P0**：确认 `resolve` / `fetchAgentMd` 等方法运行时返回的实际字段，决定是否补充强类型
2. **P1**：更新设计文档中 `load()` / `list()` / `changeSeed()` 为同步签名
3. **P1**：更新 ConnectionState 枚举命名为 snake_case
4. **P2**：决定 AUNClient 独立使用路径是否保留（当前保留是合理的兼容策略）
5. **P2**：补充设计文档中缺失的 `AIDStore.close()`、额外构造参数、AID.deviceId/slotId
