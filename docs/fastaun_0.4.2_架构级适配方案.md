# fastaun 0.4.3 架构级适配方案

**SDK 版本**：`@agentunion/fastaun@0.4.3`
**日期**：2026-05-30（0.4.3 核查更新 2026-05-31）
**状态**：三个 SDK 缺口已在 0.4.3 全部修复，方案可全量实施

> **0.4.3 更新摘要**：第二节的三个公开层缺口（connection_kind/short_ttl_ms、extra_info、slot_id 空格）已在 0.4.3 全部修复并验证（公开 `connect()` 实现透传 + `_normalizeConnectParams` 保留 + slot_id 正则放开）。**但 0.4.3 引入了 slot 隔离键新语义，对本方案的 slot 命名有重大影响——见第二节末尾"⚠️ 0.4.3 隔离键语义"。**

---

## 一、宏观理解

### 1.1 evolclaw 的两进程模型

```
┌────────────────────────── Daemon 进程 ──────────────────────────┐
│  src/index.ts → main()                                          │
│  · 为每个 self-agent 的 AUN channel 创建 AUNChannel            │
│  · 每个 AUNChannel 持有 1 条【长连接】AUNClient               │
│  · 事件推送收消息：client.on('message.received', ...)         │
│  · auto_reconnect=true，断线自动重连                          │
│  · 同时跑 IPC server，供 CLI 查询状态                         │
└─────────────────────────────────────────────────────────────────┘
                          ▲ IPC (unix socket / named pipe)
                          │ status / aun-aids / ctl / stats-record
┌────────────────────────── CLI 进程 ─────────────────────────────┐
│  src/cli/index.ts → cmd*()                                      │
│  · msg/group 命令：createShortConnection → 【短连接】发完即断 │
│  · bench / net-check：短连接做压测和诊断                      │
│  · connection_kind='short'，auto_reconnect=false              │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 长连接 vs 短连接的本质区别（来自 SDK 协议文档）

同一 `(aid, device_id, slot_id)` 槽位下：**1 条长连接 + 最多 10 条短连接**，短连接不会顶掉长连接。

| | 长连接（daemon） | 短连接（CLI） |
|---|---|---|
| `connection_kind` | `long`（默认） | `short` |
| 服务端推送 | ✅ 网关主动推消息事件 | ❌ 需主动 pull |
| 心跳/token刷新 | ✅ 后台任务维持 | ❌ 不启动 |
| 用途 | 实时收消息 | 发消息 / 拉消息 / 诊断 |
| 占用名额 | 独占长连接位 | 共享短连接位（≤10），不踢长连接 |

**这是 evolclaw 架构的基石**：daemon 用长连接挂在网关上收推送，CLI 用短连接发消息且不打断 daemon。

### 1.3 当前的三个 SDK 入口（都在 src/aun/aid/client.ts）

| 函数 | 用途 | 连接类型 |
|------|------|---------|
| `createAunClient(opts)` | 裸构造 client（不认证不连接） | — |
| `getAunClient(aid)` | 构造 + authenticate | — |
| `createShortConnection(aid)` (rpc/connection.ts) | 构造 + 认证 + 短连接 | short |
| AUNChannel._initClientInner (channels/aun.ts) | 构造 + 认证 + 长连接 | long |

---

## 二、SDK 0.4.2 公开层三个待补能力（均"内部支持、公开 connect 未透传"）

> 三个缺口同源：SDK 内部 `_connect` / `normalizeInstanceId` 都支持，但**公开 `connect(opts: ConnectionOptions)` 的白名单和 slot_id 正则没放开**。SDK 方已确认很快会补。三者都**不阻塞本方案的代码改造**（代码可先写好），只影响"实际连接联调"。

### 缺口一：`connection_kind` / `short_ttl_ms`（短连接）

- **现状**：公开 `connect()` 白名单只有 `auto_reconnect / connect_timeout / retry_* / heartbeat_interval / call_timeout`，**不含 `connection_kind` / `short_ttl_ms`**。`client.js` 公开 connect 方法体只把白名单字段拼进内部 params，`_normalizeConnectParams` 里 `connection_kind` 永远取默认值 `'long'`。
- **内部支持**：私有 `_connect` 第 3988/4014 行读 `params.connection_kind`，`_normalizeConnectParams`（6543 行）校验 long/short。Python 文档（`_packed_docs/sdk/04-连接与认证.md`）写支持。
- **对本方案影响**：原本 evolclaw 靠 `connection_kind='short'` 让 CLI 不踢 daemon。**路径 2 改用不同 slot 后缀绕开**——daemon/CLI 在不同槽位，本就独立，CLI 用默认长连接也不抢占 daemon。所以此缺口**不阻塞**，代价仅是 CLI 用长连接（起后台任务、不复用 token、发完即 close）。
- **SDK 补齐后的收益**：未来 CLI 可改回短连接 + 同 slot 复用 token（路径 1），更省认证开销。

### 缺口二：`extra_info`（长连接互踢诊断名片）

- **用途（已核实代码）**：`extra_info` 是连接时上报的**进程自描述名片**（app/version/pid/hostname/agent_name/channel_name 等，见 `buildConnectExtraInfo` aun.ts:36）。**专用于同槽位互踢诊断**：当同 AID+同 slot 的另一进程抢连接踢掉本连接时，SDK `gateway.disconnect` 事件 detail 带 `self_extra_info`（被踢方自己上报的）+ `new_extra_info`（踢人方上报的），被踢方据此打日志"谁在哪台机器/PID 把我踢了"（`handleGatewayDisconnect` aun.ts:1421、`buildKickDetail` aun.ts:1602）。
- **长短连接区别**：**短连接不踢人，不需要带 extra_info；长连接才需要带**（互踢只发生在长连接之间）。
- **现状**：公开 `connect()` 白名单**不含 `extra_info`**（内部 `_connect` 3967 行支持读取）。**接收侧不受影响**——`gateway.disconnect` 事件原样透传 detail（`_onGatewayDisconnect` 6872 行），evolclaw 消费侧照常工作。**只有发送侧（上报本进程名片）暂时失效**。
- **对本方案影响**：路径 2 后 daemon↔CLI 不互踢，但 **daemon↔daemon 仍会互踢**（同 AID 在多机 / 多 EVOLCLAW_HOME / 重复启动，都用同一个 `evolclaw daemon` slot）——这正是 extra_info 最有价值的场景。所以 **extra_info 应保留，不该移除**，只是 SDK 补齐发送侧前暂时无法上报，互踢诊断降级为单向（能看到对方、对方看不到我）。
- **结论**：daemon 长连接保留 `buildConnectExtraInfo` 逻辑；SDK 公开 connect 补 `extra_info` 后接回。短连接（若未来启用）不带。

### 缺口三：slot_id 空格校验

- **现状**：`normalizeInstanceId` 用 `INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/`（config.js:12），**不含空格**。本方案的带空格 slot（`evolclaw daemon` 等）会被抛 `ValidationError: slot_id contains unsupported characters`。
- **对本方案影响**：阶段二实际连接依赖此项放开。SDK 方表示很快支持空格 + 正反斜杠。

### 小结（0.4.3 已全部修复）

| 缺口 | 0.4.2 现状 | **0.4.3 状态** |
|------|-----------|:--------------:|
| connection_kind/short_ttl_ms | 公开 connect 未透传 | ✅ 已透传（`ConnectionOptions` + connect 实现 + normalize 保留） |
| extra_info | 公开 connect 未透传 | ✅ 已透传（`ConnectionOptions.extra_info: JsonObject`，connect 实现透传） |
| slot_id 空格 | 正则 `[A-Za-z0-9._-]` 拒绝 | ✅ 新增 `SLOT_ID_PATTERN`，允许空格/`/`/`:`（非首字符） |

**核查证据（0.4.3 实际代码）**：
- `ConnectionOptions`（client.d.ts:22-35）新增 `connection_kind` / `short_ttl_ms` / `delivery_mode` / `extra_info` / `background_sync`
- 公开 `connect()` 实现逐个透传上述字段到内部 `options`（client.js）
- `_normalizeConnectParams` 用 `{ ...params }` 保留全部字段，不剥离
- `SLOT_ID_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._/ :-]{0,127}$/`（config.js:14）

---

### ⚠️ 0.4.3 隔离键新语义（重大影响本方案 slot 命名）

0.4.3 新增 `slotIsolationKey(slotId)`：**提取第一个分隔符（`/`、`:`、空格）之前的部分作为"隔离键"**（config.js:37）。

```
slotIsolationKey('evolclaw daemon')   === 'evolclaw'
slotIsolationKey('evolclaw cli')      === 'evolclaw'
slotIsolationKey('evolclaw bench')    === 'evolclaw'
```

**隔离键才是真正的隔离边界**，分隔符后的后缀只是同隔离槽位内的"标签"（存 `slot_id_full` 列）：
- **keystore 索引用隔离键**（aid-db.js:199/204/209，`instance_state`/`seq_tracker` 主键是 `(device_id, slotKey)`）→ `evolclaw daemon` 和 `evolclaw cli` **共享同一份 token 和 seq 游标**
- **消息过滤用隔离键**（client.js:2603，`slotIsolationKey(target) !== slotIsolationKey(self)` 才过滤）→ 隔离键相同视为同槽位
- **连接上报完整 slot_id**（client.js:6512 `normalizeSlotId` 不截断），服务端拿到完整值

#### 这彻底改变了我们 slot 方案的语义判断

之前路径 2 的假设是"不同后缀 = 不同槽位 = 完全隔离 = 不复用 token"。**0.4.3 下完全相反**：

| slot | 隔离键 | 含义 |
|------|--------|------|
| `evolclaw daemon` | `evolclaw` | 与 cli **同隔离键** |
| `evolclaw cli` | `evolclaw` | 与 daemon **同隔离键** |

→ daemon 和 cli 用空格后缀时，**隔离键都是 `evolclaw`，本地共享 token**（反而实现了之前路径 1 想要的 token 复用！），且消息过滤层视为同槽位。

**关键待确认（向 SDK 方）**：服务端的"1 长 + 10 短连接"踢线判定，是按**完整 slot_id** 还是按**隔离键**？
- **若按隔离键**：daemon(`evolclaw daemon`) 和 cli(`evolclaw cli`) 隔离键都是 `evolclaw` → 同槽位 → daemon 长连接 + cli 短连接共存（1长+N短），**这才是 0.4.3 设计的本意**（空格后缀正是为"同槽位多连接打标签"而生）。此时必须靠 `connection_kind` 区分长短（缺口一已修复，可用），CLI 必须用 `connection_kind: 'short'` 才不踢 daemon。
- **若按完整 slot_id**：则不同后缀 = 不同槽位，CLI 长连接也不踢 daemon。

> **这直接推翻了"路径 2 绕开 connection_kind"的结论**——如果服务端按隔离键判定（极可能，因为这是 0.4.3 引入隔离键的目的），则带空格后缀的 slot 反而是"同槽位多连接"，**CLI 必须重新用 connection_kind: 'short'**。所幸缺口一已在 0.4.3 修复，短连接可用。详见第三节修订。

---

## 三、deviceId / slotId / encryptionSeed 决策（回应问题 2）

### 3.1 deviceId — 用系统默认

`new AIDStore({ ... })` 不传 `deviceId`，SDK 自动从 `{aunPath}/.device_id` 读取或生成（`getDeviceId()`）。daemon 和 CLI 在同一台机器、同一 aunPath 下会拿到**同一个 device_id**——这正是长短连接共存机制所要求的（同一 device 下 1 长 + N 短）。✅ 决策：不传 deviceId。

### 3.2 slotId — 路径 2：不同后缀，完全隔离（已定稿）

#### token 存储机制（已审查 SDK 代码确认）

SDK 按 `(aid, device_id, slot_id)` 三元组存储 instance_state（含最后的 access_token / refresh_token / gateway）。见 client.js：
- `this._stateKey = JSON.stringify([this._aid, this._deviceId, this._slotId])`（3816 行）
- keystore 的 `loadAll/saver/deleter` 都以 `(aid, deviceId, slotId)` 为键（3730-3891 行）
- `authenticate()` 成功后把 token 持久化到该三元组

**推论**：slot 不同 → token 不通用。token 复用与"不同 slot 后缀"互斥，只能二选一。

#### 决策：用不同后缀，完全隔离（放弃 token 复用）

| 用途 | slotId | 连接类型 |
|------|--------|---------|
| daemon | `evolclaw daemon` | 长连接 |
| CLI（msg/group） | `evolclaw cli` | 长连接（默认即可） |
| bench | `evolclaw bench` | 长连接 |
| net-check | `evolclaw netcheck` | 长连接 |

**好处**：
- daemon 与各 CLI 工具是**独立槽位**，CLI 无论怎么连都**绝不会踢掉 daemon 长连接**
- **绕开阻塞问题 A**：CLI 不再需要 SDK 支持 `connection_kind: 'short'`，用默认长连接即可（slot 不同，无抢占）
- 压测/诊断（bench/netcheck）与正常发消息（cli）互不干扰

**代价**：
- CLI 每次命令重新两阶段认证（短命进程，开销可接受）
- CLI 长连接会起心跳/token刷新后台任务，但发完即 `close()`，影响很小

#### ⚠️ 依赖项：SDK 放开 slot_id 空格校验

当前 SDK `normalizeInstanceId` 用 `INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/`（config.js:12），**不含空格**。`'evolclaw daemon'` 会抛 `ValidationError: slot_id contains unsupported characters`。

> SDK 方表示很快支持空格 + 正反斜杠。**本方案依赖该改动落地后才能用带空格的 slot**。在 SDK 放开前，daemon/CLI 无法用 `'evolclaw daemon'` 这类带空格的 slot 连接。

#### slot_id 如何传给 SDK

`connect()` 公开层不接受 `slot_id`，SDK 从 AID 对象读取（`this._slotId = inputAid?.slotId || 'default'`，client.js:604）。所以 slot 必须在 **`new AIDStore({ slotId })`** 构造时注入——load 出来的 AID 携带该 slotId，再 `new AUNClient(aidObj)` 即生效。

#### 当前代码现状（梳理结果）

- daemon（channels/aun.ts）：`connect()` 没传 slot_id，走默认 `''`（空 slot），靠 `connection_kind='long'`
- CLI（rpc/connection.ts）：`createShortConnection` 的 `slotId` 默认 `''`，靠 `connection_kind='short'`
- **新方案**：daemon/cli/bench/netcheck 各用显式带后缀的 slot，靠 slot 隔离而非 connection_kind 区分

### 3.3 encryptionSeed — 维持现状

```
loadProcessConfig().aun?.encryptionSeed ?? process.env.AUN_ENCRYPTION_SEED ?? 'evol'
```
daemon 和 CLI 用同一套解析逻辑，保证 secret-store 能解开同一份私钥。AIDStore 构造时传入。✅ 不变。

> 注：私钥本身（keystore）按 aid 存储，与 slot 无关。不同 slot 共享同一份私钥，只是各自独立认证、各存各的 token。所以 encryptionSeed 一致即可解私钥，slot 不同不影响签名能力。

---

## 四、六个待确认事项的代码审查结论（回应问题 1）

> 已逐条审查 SDK 0.4.2 源码（client.js / client.d.ts），结论如下。

### 待确认 1：`connect()` 是否支持 `extra_info`？

**审查结论：不支持。** 公开 `connect()` 白名单不含 `extra_info`，内部 `_normalizeConnectParams` 也不读取它（虽然 `_connect` 私有方法签名里有 `extraInfo`，但公开层无法传入）。

- 当前 channels/aun.ts:717 传了 `extra_info`，迁移后**必须移除**
- **建议**：确认 `extra_info` 原本承载什么（看代码是连接元信息）。如果是必要的，需向 SDK 方确认新的传入通道；如果只是观测用途，直接删除。

### 待确认 2：`connect()` 的 retry 是对象还是平铺字段？

**审查结论：平铺字段。** 公开 `ConnectionOptions` 用 `retry_initial_delay` / `retry_max_delay` / `retry_max_attempts`（SDK 内部再组装成 `retry` 对象）。

- 当前 channels/aun.ts:720 传 `{ retry: { max_attempts: 0, initial_delay: 1.0, max_delay: 300.0 } }`
- **迁移为**：`connect({ auto_reconnect: true, retry_max_attempts: 0, retry_initial_delay: 1, retry_max_delay: 300 })`

### 待确认 3：`connect()` 是否支持 `slot_id` / `connection_kind`？

**审查结论：都不支持（公开层）。**
- `slot_id`：不在公开 connect 参数里，但 SDK 从 AID 对象取（`this._slotId = inputAid?.slotId`）。→ **改为 `new AIDStore({ slotId })` 注入**。
- `connection_kind`：不在公开 connect 参数里，恒为 `'long'`。→ **这就是问题 A，CLI 短连接阻塞点**。

### 待确认 4：长连接断开后如何拿 gateway URL 做日志？（已审查定稿）

**12 处 `_gatewayUrl` 已分类**（grep 全量核查）：

| 类别 | 位置 | 处理 |
|------|------|------|
| A. 写入（旧 SDK 手动塞值） | aun.ts:627,689；identity.ts:249 | **全删**——connect/AIDStore 内部自动发现 |
| B. 读取喂给 connect 参数 | aun.ts:715,717；connection.ts:27；net-check.ts:288,443；bench.ts:356 | **全删**——connect 不再收 gateway |
| C. 读取用于状态展示/日志 | aun.ts:730,745,746,1459 | **改用公开渠道**（见下） |

只有 C 类（4 处）是真正需要替代方案的——用途是 `setAidStatus`/`appendAidLifecycle` 里展示"daemon 连到了哪个网关"。

**修正结论（推翻"配置 fallback"建议）**：0.4.2 有两个公开渠道拿到**实际连接的** gateway，不需读私有属性也不需配置 fallback：

1. **`authenticate()` 返回值**：`result.gateway`（client.js:1587 `return result`，含 gateway）。初次连接前显式 `const auth = await client.authenticate()`，存 `this.gatewayUrl = auth.gateway`。
2. **`connection.state` 事件 payload**：`{ state, gateway }`（client.js:4026 `publish('state_change', { state, gateway })`）。重连后的 `handleConnectionState`（aun.ts:1459）直接从 `data.gateway` 读，最权威。

> 之前建议"配置 fallback"已收回——配置里的 `gatewayUrl` 只是 fallback，未必等于实际连接网关。用 `authenticate()` 返回值 + `connection.state` 事件 payload 才准确，且都是公开 API。

### 待确认 5：`createAunClient` —— 直接废弃（已定稿）

**决策：直接废弃 `createAunClient` 和 `getAunClient`**，新增 `getAidStore()` / `loadClient()` 工厂（见第五节）。当前 `createAunClient` 做的事在新模型里全部由 `AIDStore` 构造接管：
- `setAgentMdPath` 已移除（AIDStore 自动用 `{aunPath}/AIDs/`）
- `root_ca_path` → `AIDStore({ rootCaPath })`
- `aunSdkLog` → `AIDStore({ debug })`
- `encryptionSeed` → `AIDStore({ encryptionSeed })`
- `slotId` → `AIDStore({ slotId })`

- **建议**：废弃 `createAunClient`，新增一个 **`getAidStore(opts)` 工厂**（统一构造 AIDStore + 注入 encryptionSeed/slotId/rootCaPath/debug）。所有调用方先 `getAidStore()` → `store.load(aid)` → `new AUNClient(aidObj)`。

### 待确认 6：AIDStore 生命周期——每次创建还是长期持有？

**审查结论：分场景。**
- AIDStore 持有 keystore 句柄 + gateway 缓存 + agent.md 缓存，有 `close()` 方法
- **daemon**：长期持有一个 AIDStore（与长连接同生命周期），复用缓存。AUNChannel 持有 store 引用。
- **CLI**：每条命令 `getAidStore()` → 用完 `store.close()`。短命进程，无需长期持有。
- **建议**：
  - daemon：AUNChannel 内持有 `this.store: AIDStore`，channel 关闭时 `store.close()`
  - CLI：`createShortConnection` 内部 `getAidStore()` + try/finally `store.close()`

---

## 五、目标架构设计

### 5.1 新增统一工厂（替代 createAunClient）

slot 后缀由调用方显式传入，工厂不设默认值的"业务语义"（避免误用）。约定常量集中定义。

```typescript
// src/aun/aid/store.ts （新文件）

// slot 后缀常量（统一管理，避免散落字符串）
export const SLOT = {
  daemon:   'evolclaw daemon',
  cli:      'evolclaw cli',
  bench:    'evolclaw bench',
  netcheck: 'evolclaw netcheck',
} as const;

export function getAidStore(opts: {
  slotId: string;          // 必传：调用方明确自己是哪个 slot（SLOT.daemon / SLOT.cli / ...）
  aunPath?: string;
  debug?: boolean;
}): AIDStore {
  const aunPath = opts.aunPath ?? defaultAunPath();
  const encryptionSeed = loadProcessConfig().aun?.encryptionSeed
    ?? process.env.AUN_ENCRYPTION_SEED ?? 'evol';
  const caCertPath = path.join(aunPath, 'CA', 'root', 'root.crt');
  return new AIDStore({
    aunPath,
    encryptionSeed,
    slotId: opts.slotId,
    ...(fs.existsSync(caCertPath) ? { rootCaPath: caCertPath } : {}),
    debug: opts.debug ?? false,
  });
}

// 加载身份并构造已就绪的 client（不连接）
export function loadClient(store: AIDStore, aid: string): AUNClient {
  const r = store.load(aid);
  if (!r.ok) throw new AidError(r.error.code, r.error.message);
  return new AUNClient(r.data.aid);
}
```

### 5.2 daemon 长连接（channels/aun.ts）

```typescript
import { getAidStore, SLOT } from '../aun/aid/store.js';

// 持有 store（与 channel 同生命周期）
this.store = getAidStore({ slotId: SLOT.daemon, aunPath, debug: aunSdkLog });
const loadR = this.store.load(aid);              // 同步
if (!loadR.ok) { /* 处理 CERT_NOT_FOUND 等，scheduleReconnect */ }
this.client = new AUNClient(loadR.data.aid);

// 注册事件（连接前）—— gateway 从事件 payload 取
this.client.on('message.received', ...);
this.client.on('connection.state', (data) => {
  // data.gateway 是实际连接的网关，直接用于状态展示
  this.handleConnectionState(data);   // 内部 setAidStatus({ gatewayUrl: data.gateway })
});

// 显式认证拿首个 gateway（用于初次 connected 事件日志）
const auth = await this.client.authenticate();   // { access_token, gateway, aid }
this.gatewayUrl = String(auth.gateway ?? '');    // 存实例字段，替代 (client as any)._gatewayUrl

// 长连接（connection_kind 默认 long；slot 已由 AID 携带）
// extra_info：保留 buildConnectExtraInfo 逻辑（互踢诊断名片）。
// 当前公开 connect 不接受 extra_info（缺口二），SDK 补齐后接回；
// 在此之前发送侧暂缺，接收侧（gateway.disconnect 事件）照常工作。
await this.client.connect({
  auto_reconnect: true,
  retry_max_attempts: 0,
  retry_initial_delay: 1,
  retry_max_delay: 300,
  // extra_info: buildConnectExtraInfo({...}),  // ← SDK 公开 connect 补齐后启用
});
```

> daemon 用 `SLOT.daemon`，与所有 CLI slot 不同——CLI 永不踢 daemon。
> **extra_info 保留不删**：daemon↔daemon（多机/多 home/重复启动同 AID，都用 `evolclaw daemon` slot）仍会互踢，名片用于诊断。详见缺口二。短连接不带 extra_info（短连接不踢人）。

### 5.3 CLI 长连接发完即断（rpc/connection.ts）— 不依赖问题 A

路径 2 下 CLI 用独立 slot，**不需要 connection_kind: 'short'**，用默认长连接即可，发完即 close。函数名保留 `createShortConnection`（语义仍是"短命连接"）或更名 `createCliConnection`。

```typescript
import { getAidStore, loadClient, SLOT } from '../aid/store.js';

export async function createShortConnection(aid: string, opts?: { aunPath?: string; slotId?: string }) {
  const store = getAidStore({ slotId: opts?.slotId ?? SLOT.cli, aunPath: opts?.aunPath });
  try {
    const client = loadClient(store, aid);
    await client.connect({ auto_reconnect: false });   // 默认长连接，但用完即断
    return {
      call: (m, p) => client.call(m, p),
      close: async () => { try { await client.close(); } finally { store.close(); } },
    };
  } catch (e) { store.close(); throw e; }
}
```

> bench / net-check 调用时传各自 slot：`createShortConnection(aid, { slotId: SLOT.bench })` / `{ slotId: SLOT.netcheck }`。

### 5.4 签名/验签（identity.ts、agentmd.ts）— 改用 AID 值对象

```typescript
// 旧：client.auth.signAgentMd(content, { aid })
// 新（同步）：
const store = getAidStore();
const aidObj = store.load(aid).data!.aid;
const signed = aidObj.signAgentMd(content);       // Result<{ signed }>
const verified = aidObj.verifyAgentMd(content);   // Result<VerifyResult>
store.close();
```

### 5.5 注册 AID（identity.ts aidCreate）— 改用 AIDStore.register

```typescript
// 旧：client.auth.registerAid({ aid }) + 手动 CA 下载 + 重连
// 新：
const store = getAidStore();
const reg = await store.register(aid);            // Result<{ registered }>
if (!reg.ok) throw ...;
const aidObj = store.load(aid).data!.aid;
// 验签自检改用 aidObj.signAgentMd/verifyAgentMd
```

### 5.6 获取对端 agent.md（agentmd.ts）— 改用 AIDStore.fetchAgentMd/resolve

```typescript
// 旧：createBareClient + client.fetchAgentMd + 手动 _fetchPeerCert
// 新：
const store = getAidStore();
const r = await store.fetchAgentMd(aid);          // 自动拉证书+验签
// r.data: { content, verification, cert_pem, etag, last_modified }
```

---

## 六、文件改动汇总

> 路径 2（不同 slot 后缀）下，CLI 用默认长连接即可，**不再依赖问题 A**（SDK 短连接支持）。唯一外部依赖是 SDK 放开 slot_id 空格校验。

| 文件 | 改动 | 依赖 SDK 放开空格？ |
|------|------|:----:|
| `src/aun/aid/store.ts`（新建） | getAidStore + loadClient + SLOT 常量 | — |
| `src/aun/aid/client.ts` | **删除** createAunClient/getAunClient | 否 |
| `src/aun/aid/identity.ts` | registerAid→AIDStore.register；sign/verify→AID 值对象 | 否 |
| `src/aun/aid/agentmd.ts` | verify→AID 值对象；fetch→AIDStore.fetchAgentMd | 否 |
| `src/channels/aun.ts` | 长连接重写；slot=SLOT.daemon；移除 _gatewayUrl(12处)；retry 平铺；gateway 从 authenticate()返回值+connection.state 事件取；**extra_info 保留**（待 SDK 公开 connect 补齐后接回） | 连接时是 |
| `src/aun/rpc/connection.ts` | CLI 连接重写；slot=SLOT.cli；默认长连接发完即断 | 连接时是 |
| `src/cli/bench.ts` | slot=SLOT.bench；连接片段重写 | 连接时是 |
| `src/cli/net-check.ts` | slot=SLOT.netcheck；连接片段重写（3处） | 连接时是 |
| `tests/unit/aid-management.test.ts` | mock 改为 AIDStore/AID 结构 | 否 |
| `tests/unit/aun-ops.test.ts` | mock 改为 AIDStore/AID 结构 | 否 |

> "连接时是"= 代码改动本身不依赖 SDK，但**实际建立连接**需要 SDK 先放开 slot_id 空格校验（否则带空格 slot 会被 ValidationError 拒绝）。代码可先写好，等 SDK 放开后联调。

---

## 七、执行计划

> 全部改动的代码层面都不卡，唯一外部依赖是 SDK 放开 slot_id 空格——这只影响"实际连接联调"，不影响写代码。

### 阶段一：纯本地改造（不需要连网，立即可做可测）
1. 新建 `src/aun/aid/store.ts`（getAidStore / loadClient / SLOT）
2. `client.ts`：删除 createAunClient/getAunClient
3. `identity.ts`：register→AIDStore.register；sign/verify→AID 值对象（同步）
4. `agentmd.ts`：fetch→AIDStore.fetchAgentMd；verify→AID 值对象
5. 测试 mock 更新（AIDStore/AID 结构）
6. `npm run build` 通过 + 单测通过

### 阶段二：连接联调（需 SDK 放开 slot_id 空格后）
7. `channels/aun.ts`：daemon 长连接（移除私有属性、retry 平铺、gateway 取值改造）
8. `rpc/connection.ts` + `bench.ts` + `net-check.ts`：CLI 各 slot 连接
9. 端到端联调：daemon 收消息 + CLI 各命令发消息（确认 CLI 不踢 daemon）

---

## 八、决策清单（已定稿）

| # | 决策项 | 结论 |
|---|--------|------|
| 1 | ~~问题 A：SDK 短连接支持~~ | **已绕开**——路径 2 用不同 slot + 默认长连接，CLI 不踢 daemon，无需短连接 |
| 2 | slotId 方案 | 路径 2：daemon=`evolclaw daemon`、cli=`evolclaw cli`、bench=`evolclaw bench`、netcheck=`evolclaw netcheck`。放弃 token 复用，换完全隔离 |
| 3 | deviceId | 不传，用系统默认（`{aunPath}/.device_id`） |
| 4 | gateway URL 日志 | 用 `authenticate()` 返回值 + `connection.state` 事件 payload，存实例字段 `this.gatewayUrl`；不读私有属性、不用配置 fallback |
| 5 | createAunClient | **直接废弃**，换 getAidStore / loadClient 工厂 |
| 6 | extra_info | **保留**——互踢诊断名片，daemon↔daemon 仍会互踢。仅长连接带，短连接不带。SDK 公开 connect 补齐后接回（缺口二） |
| 7 | 执行批次 | 阶段一纯本地改造立即做；阶段二连接联调等 SDK 放开 slot_id 空格 |

### 外部依赖（SDK 公开层三个待补能力，详见第二节）

均"内部支持、公开 connect 未透传"，SDK 方已确认很快补齐。都不阻塞代码改造，影响实际连接联调：

1. **slot_id 空格校验**（`INSTANCE_ID_PATTERN`，config.js:12）——带空格 slot 实际连接前必须放开
2. **`extra_info` 透传**——daemon 长连接互踢诊断名片，发送侧待补（接收侧已正常）
3. **`connection_kind` / `short_ttl_ms` 透传**——本方案路径 2 已绕开，非必需；补齐后未来可选路径 1（短连接复用 token）

> 阶段一（纯本地改造）完全不受这三项影响，可立即实施。阶段二实际连接依赖第 1 项落地。

