# fastaun 0.4.2 适配清单

**SDK 版本**：`@agentunion/fastaun@0.4.2`  
**分析日期**：2026-05-30  
**状态**：待确认

---

## 一、变更全景

### 核心 Breaking Changes（0.4.0 引入）

| 旧 API | 新 API | 影响范围 |
|--------|--------|---------|
| `client.auth.authenticate({ aid })` | `client.loadIdentity(aidObj)` + `client.authenticate()` | 所有认证点 |
| `client.auth.registerAid({ aid })` | `AIDStore.register(aid)` | identity.ts |
| `client.auth.signAgentMd(content, { aid })` | `aidObj.signAgentMd(content)` | identity.ts |
| `client.auth.verifyAgentMd(content, { aid, certPem })` | `aidObj.verifyAgentMd(content)` | identity.ts, agentmd.ts |
| `new AUNClient(opts, bool)` | `new AUNClient(aidObj?)` | client.ts |
| `client.setAgentMdPath(path)` | 已移除（AID 构造时自动注入） | client.ts |
| `client.connect({ access_token, gateway, ... }, { auto_reconnect })` | `client.connect(ConnectionOptions?)` | aun.ts, connection.ts, bench.ts, net-check.ts |
| `(client as any)._gatewayUrl` | `client.gatewayHealth` / `AIDStore` 内部管理 | 多处 |
| `(client as any)._access_token` | 不再需要（connect 内部自动处理） | 多处 |

---

## 二、逐文件调整清单

### 📄 `src/aun/aid/client.ts`

**问题 1**：`createAunClient` 工厂函数整体需要重写

- 当前：`new AUNClient(clientOpts, opts.aunSdkLog)` — 构造函数不再接受这两个参数
- 当前：`client.setAgentMdPath(aidsDir())` — 方法已移除
- 当前：`aunSdkLog` 选项 — 构造函数不再接受 debug bool 参数

**调整方案**：
```
createAunClient(opts) 改为：
  1. new AIDStore({ aunPath, encryptionSeed, deviceId?, slotId? })
  2. 返回 AIDStore 实例（或保持返回 AUNClient，但需先 store.load(aid) 拿到 AID 再 new AUNClient(aid)）
```

**问题 2**：`getAunClient(aid)` 中 `client.auth.authenticate({ aid })`

- 当前：`await client.auth.authenticate({ aid })`
- 新 API：`client.loadIdentity(aidObj)` + `await client.authenticate()`
- 前提：需先 `AIDStore.load(aid)` 拿到 `AID` 对象

**问题 3**：`aunSdkLog` 选项

- 当前：`CreateClientOpts.aunSdkLog?: boolean`，传给 `new AUNClient(opts, bool)`
- 新 API：构造函数只接受 `AID`，无 debug 参数
- 调整：`aunSdkLog` 选项废弃，或通过 `AIDStore({ debug: true })` 传入

---

### 📄 `src/aun/aid/identity.ts`

**问题 1**：`verifySignAbility()` 中 `client.auth.signAgentMd` / `client.auth.verifyAgentMd`

- 当前（L120）：`signed = await client.auth.signAgentMd(probe, { aid })`
- 当前（L129）：`result = await client.auth.verifyAgentMd(signed, { aid, certPem })`
- 新 API：`aidObj.signAgentMd(content)` / `aidObj.verifyAgentMd(content)`（同步，返回 `Result<T>`）
- 调整：需先 `AIDStore.load(aid)` 拿到 `AID` 对象，再调用实例方法

**问题 2**：`aidCreate()` 中 `client.auth.registerAid({ aid })`

- 当前（L229）：`const result = await client.auth.registerAid({ aid })`
- 新 API：`await AIDStore.register(aid)` 返回 `Result<{ registered: true }>`
- 调整：整个 `aidCreate` 流程需重写，改用 `AIDStore.register` + `AIDStore.load`

**问题 3**：`aidCreate()` 中 `recoverClient.auth.authenticate({ aid })` / `client.auth.authenticate({ aid })`

- 当前（L217, L238）：`await client.auth.authenticate({ aid })`
- 新 API：`client.loadIdentity(aidObj)` + `await client.authenticate()`

**问题 4**：`aidCreate()` 中 `(client as any)._gatewayUrl = gatewayUrl`

- 当前（L249）：直接写私有属性
- 新 API：`connect()` 内部自动发现 gateway，无需手动设置

**问题 5**：`aidShow()` 中 `client.auth.verifyAgentMd`

- 当前（L326）：`await client.auth.verifyAgentMd(content, { aid, certPem })`
- 新 API：`aidObj.verifyAgentMd(content)`（同步）

---

### 📄 `src/aun/aid/agentmd.ts`

**问题 1**：`obtainCertPem()` 中 `(client as any)._gatewayUrl` / `(client as any)._fetchPeerCert`

- 当前（L46-50）：直接访问私有属性 `_gatewayUrl` 和私有方法 `_fetchPeerCert`
- 新 API：`AIDStore.resolve(aid)` 或 `AIDStore.fetchAgentMd(aid)` 内部自动处理证书获取
- 调整：`obtainCertPem` 函数可删除，改用 `AIDStore.resolve(aid, { skipAgentMd: true })`

**问题 2**：`verifyContent()` 中 `client.auth.verifyAgentMd`

- 当前（L76）：`await client.auth.verifyAgentMd(content, { aid, certPem })`
- 新 API：`aidObj.verifyAgentMd(content)`（同步）
- 调整：需先通过 `AIDStore.load(aid)` 或 `AIDStore.resolve(aid)` 拿到 `AID` 对象

**问题 3**：`agentmdGet()` 整体流程

- 当前：依赖 `createBareClient()` 创建无身份 client，再调 `client.fetchAgentMd(aid)`
- 新 API：`AIDStore.fetchAgentMd(aid)` 直接替代（AIDStore 不需要身份即可拉对端 agent.md）
- 调整：`agentmdGet` 改用 `AIDStore.fetchAgentMd`，`createBareClient` 可删除

---

### 📄 `src/aun/rpc/connection.ts`

**问题 1**：`createShortConnection()` 整体流程

- 当前：`createAunClient` → `client.auth.authenticate({ aid })` → 手动提取 token/gateway → `client.connect({ access_token, gateway, ... }, { auto_reconnect: false })`
- 新 API：`AIDStore.load(aid)` → `new AUNClient(aidObj)` → `client.loadIdentity(aidObj)` → `client.connect({ auto_reconnect: false })`
- `connect()` 内部自动完成 authenticate + gateway 发现，无需手动传 `access_token` / `gateway`

**问题 2**：`(client as any)._access_token` / `(client as any)._gatewayUrl`

- 当前（L26-27）：访问私有属性提取 token 和 gateway
- 新 API：不再需要，`connect()` 内部自动处理

**问题 3**：`connect()` 参数格式

- 当前：`client.connect({ access_token, gateway, slot_id, connection_kind }, { auto_reconnect })`
- 新 API：`client.connect(ConnectionOptions?)` — `ConnectionOptions` 只有 `auto_reconnect`, `connect_timeout`, `retry_*`, `heartbeat_interval`, `call_timeout`
- `slot_id` / `connection_kind` / `access_token` / `gateway` 不再是 connect 参数

---

### 📄 `src/channels/aun.ts`

**问题 1**：`_initClientInner()` 中 `createAunClient` + `client.auth.authenticate`

- 当前（L620-690）：`createAunClient(opts)` → `client.auth.authenticate({ aid })` → 手动提取 token/gateway → `client.connect({ access_token, gateway, extra_info }, { auto_reconnect, retry })`
- 新 API：`AIDStore.load(aid)` → `new AUNClient(aidObj)` → `client.connect(ConnectionOptions)`
- `extra_info` 需确认是否仍可通过 `ConnectionOptions` 传入（待核查）

**问题 2**：`(client as any)._gatewayUrl` 多处访问

- 当前（L627, L689, L715, L717, L730, L745, L746, L1459）：读取私有属性获取 gateway URL
- 新 API：`client.gatewayHealth` 可判断连接状态，但 gateway URL 本身不再公开
- 调整：记录 gateway URL 需在 `connect()` 前通过 `AIDStore` 的 gateway 发现获取，或监听 `connection.state` 事件

**问题 3**：`aunSdkLog` 配置项

- 当前（L74, L623, L2564）：`aunSdkLog` 传给 `createAunClient`，再传给 `new AUNClient(opts, bool)`
- 新 API：构造函数不接受 debug bool，`AIDStore({ debug: true })` 控制日志
- 调整：`aunSdkLog` 映射到 `AIDStore` 的 `debug` 参数

**问题 4**：`connect()` 参数格式（同 connection.ts 问题 3）

- 当前（L717-720）：`client.connect({ access_token, gateway, extra_info }, { auto_reconnect, retry })`
- 新 API：`client.connect(ConnectionOptions)` — 需确认 `extra_info` / `retry` 字段是否仍支持

---

### 📄 `src/cli/bench.ts`

**问题**：认证 + 连接流程（L354-359）

- 当前：`client.auth.authenticate({ aid })` → 提取 token/gateway → `client.connect({ access_token, gateway, slot_id, connection_kind }, { auto_reconnect: false })`
- 新 API：`AIDStore.load(aid)` → `new AUNClient(aidObj)` → `client.connect({ auto_reconnect: false })`

---

### 📄 `src/cli/net-check.ts`

**问题**：认证 + 连接流程（L239, L286-289, L441-444）

- 当前：同 bench.ts，`client.auth.authenticate` + 手动提取 token/gateway + `client.connect({ access_token, gateway, ... })`
- 新 API：同上，改用 `AIDStore.load` + `new AUNClient(aidObj)` + `client.connect()`

---

## 三、核心迁移模式

### 模式 A：认证 + 短连接（替换最多的模式）

```typescript
// 旧
const client = await createAunClient({ aunPath, encryptionSeed });
const authResult = await client.auth.authenticate({ aid });
const accessToken = authResult?.access_token ?? (client as any)._access_token;
const gateway = (client as any)._gatewayUrl ?? authResult?.gateway;
await client.connect({ access_token: accessToken, gateway, connection_kind: 'short' }, { auto_reconnect: false });

// 新
const store = new AIDStore({ aunPath, encryptionSeed });
const loadResult = store.load(aid);
if (!loadResult.ok) throw new Error(loadResult.error.message);
const aidObj = loadResult.data.aid;
const client = new AUNClient(aidObj);
await client.connect({ auto_reconnect: false });
store.close();
```

### 模式 B：注册新 AID（替换 aidCreate 流程）

```typescript
// 旧
const client = await createAunClient({ aunPath, encryptionSeed });
const result = await client.auth.registerAid({ aid });

// 新
const store = new AIDStore({ aunPath, encryptionSeed });
const result = await store.register(aid);
if (!result.ok) throw new Error(result.error.message);
const loadResult = store.load(aid);
const aidObj = loadResult.data!.aid;
```

### 模式 C：签名/验签（替换 auth.signAgentMd / verifyAgentMd）

```typescript
// 旧
const signed = await client.auth.signAgentMd(content, { aid });
const result = await client.auth.verifyAgentMd(signed, { aid, certPem });

// 新（同步）
const store = new AIDStore({ aunPath, encryptionSeed });
const aidObj = store.load(aid).data!.aid;
const signResult = aidObj.signAgentMd(content);          // Result<{ signed }>
const verifyResult = aidObj.verifyAgentMd(signed);       // Result<VerifyResult>
```

### 模式 D：获取对端 agent.md + 验签

```typescript
// 旧
const client = await createBareClient(aunPath);
const info = await client.fetchAgentMd(aid);

// 新
const store = new AIDStore({ aunPath, encryptionSeed: '' });
const result = await store.fetchAgentMd(aid);
// result.data: { content, verification, cert_pem, etag, last_modified }
```

### 模式 E：长连接（AUNChannel）

```typescript
// 旧
const client = await createAunClient({ aunPath, encryptionSeed, aunSdkLog });
const auth = await client.auth.authenticate({ aid });
const accessToken = auth.access_token;
const gateway = auth.gateway || configGateway;
(client as any)._gatewayUrl = gateway;
await client.connect({ access_token: accessToken, gateway, extra_info }, { auto_reconnect: true, retry: { max_attempts: 0 } });

// 新
const store = new AIDStore({ aunPath, encryptionSeed, debug: aunSdkLog });
const aidObj = store.load(aid).data!.aid;
const client = new AUNClient(aidObj);
await client.connect({ auto_reconnect: true, retry_max_attempts: 0 });
// gateway URL 通过 AIDStore 内部自动发现，不再需要手动传入
```

---

## 四、待确认事项

在执行适配前，需确认以下问题：

| # | 问题 | 影响文件 |
|---|------|---------|
| 1 | `connect()` 的 `ConnectionOptions` 是否支持 `extra_info` 字段？当前 aun.ts 传了 `extra_info` 给 connect | aun.ts:717 |
| 2 | `connect()` 的 `ConnectionOptions` 是否支持 `retry` 对象（`{ max_attempts, initial_delay, max_delay }`）？还是改为平铺的 `retry_max_attempts` 等？ | aun.ts:720, connection.ts:36 |
| 3 | `connect()` 是否还支持 `slot_id` / `connection_kind` 参数？ | connection.ts:34, bench.ts:358, net-check.ts:289 |
| 4 | 长连接断开后如何获取 gateway URL 用于日志记录？（当前通过 `(client as any)._gatewayUrl`） | aun.ts 多处 |
| 5 | `createAunClient` 工厂函数是否保留（作为 AIDStore 的薄封装），还是直接在调用方改用 AIDStore？ | client.ts, 所有调用方 |
| 6 | `AIDStore` 实例的生命周期管理：是每次操作创建/关闭，还是长期持有？ | 架构决策 |

---

## 五、文件影响汇总

| 文件 | 改动量 | 主要变更 |
|------|:------:|---------|
| `src/aun/aid/client.ts` | 大 | 整体重写 createAunClient/getAunClient，改用 AIDStore |
| `src/aun/aid/identity.ts` | 大 | registerAid、authenticate、signAgentMd、verifyAgentMd 全部迁移 |
| `src/aun/aid/agentmd.ts` | 中 | verifyContent 改用 AID 实例，agentmdGet 改用 AIDStore.fetchAgentMd |
| `src/aun/rpc/connection.ts` | 中 | createShortConnection 整体重写 |
| `src/channels/aun.ts` | 大 | _initClientInner 认证+连接流程重写，gateway URL 获取方式变更 |
| `src/cli/bench.ts` | 小 | 认证+连接片段替换 |
| `src/cli/net-check.ts` | 小 | 认证+连接片段替换（3处） |
| `tests/unit/aid-management.test.ts` | 中 | mock 结构需更新（auth 命名空间移除） |
| `tests/unit/aun-ops.test.ts` | 中 | mock 结构需更新 |

**总计**：7 个生产文件 + 2 个测试文件

---

## 六、建议执行顺序

1. **先解决待确认事项**（第四节），特别是 `connect()` 参数格式
2. `src/aun/aid/client.ts` — 重写工厂函数，这是所有其他文件的基础
3. `src/aun/aid/identity.ts` — 迁移 registerAid / authenticate / sign / verify
4. `src/aun/aid/agentmd.ts` — 迁移 verifyAgentMd / fetchAgentMd
5. `src/aun/rpc/connection.ts` — 重写 createShortConnection
6. `src/channels/aun.ts` — 重写 _initClientInner
7. `src/cli/bench.ts` + `src/cli/net-check.ts` — 替换认证片段
8. 测试文件 mock 更新
9. 构建验证：`npm run build`
