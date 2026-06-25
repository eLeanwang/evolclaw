# fastaun 0.4.3 适配实施计划（最终定稿）

**SDK 版本**：`@agentunion/fastaun@0.4.3`
**日期**：2026-05-31
**状态**：待确认后由 agent team 实施

---

## 一、slot 隔离方案（已定稿）

利用 0.4.3 隔离键语义：`slotIsolationKey` 取第一个分隔符（空格/`/`/`:`）前的部分为隔离键。

| 主体 | slotId | 隔离键 | 连接类型 | 消费通道 |
|------|--------|--------|---------|---------|
| daemon | `evolclaw daemon` | `evolclaw` | 长连接 | **共享 `evolclaw`** |
| CLI（msg/group 默认） | `evolclaw cli` | `evolclaw` | **短连接** | **共享 `evolclaw`** |
| CLI `--app <name>` | `<name>` | `<name>` | 短连接 | 独立通道 |
| bench（整体） | `evolclaw-bench` | `evolclaw-bench` | 长连接 | 独立通道 |
| bench 并发单元 N | `evolclaw-bench-<N>` | `evolclaw-bench-<N>` | 长连接 | 各自独立 |
| netcheck | `evolclaw netcheck` | `evolclaw` | 长连接 | **共享 `evolclaw`** |

**机制验证**（已用 SDK 正则实测隔离键）：
- 空格分隔（daemon/cli/netcheck）→ 隔离键都是 `evolclaw` → 共享 token、seq 游标、消费通道
- 连字符（bench）→ 整串即隔离键 → 独立
- daemon 长连接 + cli 短连接共存于 `evolclaw`（1 长 + N 短）
- netcheck 长连接抢 `evolclaw` 的长连接位 → 踢掉 daemon（踢人测试）

**关键前提（阶段二联调验证）**：服务端按**隔离键**而非完整 slot_id 维护「连接槽位 / 消费游标」。这是整套设计成立的基础，SDK 本地层（keystore/消息过滤）已按隔离键，服务端行为需联调确认。

---

## 二、四个决策（已确认）

1. **`--app <name>`** → `slotId = '<name>'`（独立隔离键、独立通道）；不传则默认 `evolclaw cli`
2. **netcheck 踢人测试** → 本次一并实现（长连接挤 daemon，验证 `gateway.disconnect` + extra_info）
3. **ack 警告** → 重新设计文案（cli/daemon 共享 `evolclaw` 通道是设计意图，ack 推进共享游标需提示风险）
4. **createAunClient** → 废弃，换 `getAidStore()` / `loadClient()`

---

## 三、实施任务分解

### T1. 新建 `src/aun/aid/store.ts`（基础工厂，所有任务的依赖）

```typescript
export const SLOT = {
  daemon:   'evolclaw daemon',
  cli:      'evolclaw cli',
  bench:    'evolclaw-bench',
  netcheck: 'evolclaw netcheck',
} as const;

// 统一构造 AIDStore（注入 encryptionSeed/slotId/rootCaPath/debug）
export function getAidStore(opts: { slotId: string; aunPath?: string; debug?: boolean }): AIDStore;

// load + 构造 AUNClient（不连接）；load 失败抛 AidError
export function loadClient(store: AIDStore, aid: string): AUNClient;
```

### T2. 废弃 `src/aun/aid/client.ts` 的 createAunClient/getAunClient

- 删除 `createAunClient`、`getAunClient`
- 保留 `resolveAunCoreSdkPkg` / `ensureAunSdk` / `downloadCaRoot` 等非 client 构造逻辑
- 全仓引用改指 store.ts

### T3. `src/aun/aid/identity.ts` 迁移

- `aidCreate`：`client.auth.registerAid` → `AIDStore.register(aid)` + `store.load(aid)`
- `verifySignAbility`：`client.auth.signAgentMd/verifyAgentMd` → `aidObj.signAgentMd/verifyAgentMd`（同步 Result）
- `aidShow`：`client.auth.verifyAgentMd` → `aidObj.verifyAgentMd`
- 移除 `(client as any)._gatewayUrl` 写入

### T4. `src/aun/aid/agentmd.ts` 迁移

- `agentmdGet`：`createBareClient + client.fetchAgentMd` → `AIDStore.fetchAgentMd(aid)`
- `verifyContent`：`client.auth.verifyAgentMd` → `aidObj.verifyAgentMd`
- 删除 `obtainCertPem`（`_fetchPeerCert` 私有访问）→ 用 `AIDStore.resolve`
- 移除 `(client as any)._gatewayUrl`

### T5. `src/aun/rpc/connection.ts` — CLI 短连接

```typescript
export async function createShortConnection(aid, opts?: { aunPath?; slotId? }) {
  const store = getAidStore({ slotId: opts?.slotId ?? SLOT.cli, aunPath: opts?.aunPath });
  try {
    const client = loadClient(store, aid);
    await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });
    return { call, close: async()=>{ await client.close(); store.close(); } };
  } catch(e) { store.close(); throw e; }
}
```
- slotId 默认 `SLOT.cli`（`evolclaw cli`），`--app` 时为 `<name>`
- 恢复 `connection_kind: 'short'`（0.4.3 已支持）

### T6. `src/cli/index.ts` — msg/group 命令

- `--app <name>` → `slotId = name`（独立通道）；不传 → 不传 slotId（connection.ts 默认 `SLOT.cli`）
- 重新设计 ack/pull 警告文案：
  - 不传 `--app`：cli 与 daemon 共享 `evolclaw` 消费通道，pull/ack 会影响 daemon 看到的消息；要独立消费请 `--app <name>`
  - 移除旧的 `--as-daemon` 强制要求（语义已变），或保留为"显式确认共享通道操作"
- 移除 `slotId: ''` 默认空串语义

### T7. `src/channels/aun.ts` — daemon 长连接

- `getAidStore({ slotId: SLOT.daemon, debug })` + `loadClient`
- `client.connect({ auto_reconnect: true, retry_max_attempts: 0, retry_initial_delay: 1, retry_max_delay: 300, extra_info: buildConnectExtraInfo({...}) })`
  - `connection_kind` 默认 long；`extra_info` 0.4.3 已支持，**恢复传入**
- 移除 12 处 `(client as any)._gatewayUrl`：
  - 写入（627/689/249）→ 删
  - 喂 connect（715/717）→ 删（connect 不收 gateway）
  - 状态展示（730/745/746/1459）→ 用 `authenticate()` 返回值 `result.gateway` 存 `this.gatewayUrl` + `connection.state` 事件 `data.gateway`
- retry 改平铺字段
- `aunSdkLog` → `AIDStore({ debug })`
- 保留 `handleGatewayDisconnect` / `buildKickDetail`（消费 extra_info，不变）

### T8. `src/cli/bench.ts` — 独立通道 + 并发隔离

- 每个并发单元用独立 slot：`evolclaw-bench-<index>`（独立隔离键）
- 连接默认长连接（去掉 `connection_kind: 'short'`，或显式 long）
- 认证/发送/拉取统一走 store.ts 工厂
- `benchSlot` 从 `bench-${sessionId}` 改为 `SLOT.bench` 前缀 + 并发序号

### T9. `src/cli/net-check.ts` — slot + 踢人测试

- 3 处连接 slot 改为 `SLOT.netcheck`（`evolclaw netcheck`）
- ping/echo 连接改默认长连接
- **新增踢人测试步骤**：
  - netcheck 用 `evolclaw netcheck` 建长连接 → 抢 `evolclaw` 长连接位 → 踢掉本机 daemon
  - 验证：daemon 端收到 `gateway.disconnect`，detail 含 `new_extra_info`（netcheck 的名片）
  - 报告：踢人是否生效 + extra_info 是否正确传递
  - ⚠️ 该测试会断开 daemon，需提示用户/确认（daemon 会自动重连）

### T10. 测试 mock 更新

- `tests/unit/aid-management.test.ts`：mock `@agentunion/fastaun` 的 `AIDStore`/`AID` 结构（替代旧 `client.auth.*`）
- `tests/unit/aun-ops.test.ts`：同上
- mock `AIDStore.load/register/fetchAgentMd`、`AID.signAgentMd/verifyAgentMd`、`AUNClient.connect/call/on`

### T11. 构建 + 单测验证

- `npm run build`（tsc 通过）
- `npm test`（单测通过）

---

## 四、依赖顺序

```
T1 (store.ts)
 ├─ T2 (client.ts 废弃)
 ├─ T3 (identity)  ─┐
 ├─ T4 (agentmd)   ─┤
 ├─ T5 (connection)─┤
 │   └─ T6 (cli msg/group)
 ├─ T7 (channels/aun daemon)
 ├─ T8 (bench)
 └─ T9 (net-check)
      ↓
   T10 (测试 mock)
      ↓
   T11 (build + test)
```

T1 是所有任务的基础，必须先完成。T3-T9 可并行（互不依赖，都依赖 T1/T2）。T10/T11 最后。

---

## 五、阶段划分

- **阶段一（纯本地，立即可测）**：T1-T11 全部代码改造 + build + 单测。代码不依赖联网。
- **阶段二（联调，需服务端验证隔离键语义）**：
  1. daemon 启动 + 长连接收消息
  2. cli 短连接发消息（验证不踢 daemon）
  3. `--app` 独立通道验证
  4. bench 并发独立通道验证
  5. netcheck 踢人测试（验证踢 daemon + extra_info）

---

## 六、风险与确认点

| # | 风险 | 处理 |
|---|------|------|
| 1 | 服务端是否按隔离键维护连接槽位/消费游标 | 阶段二联调首先验证（cli 不踢 daemon、netcheck 踢 daemon） |
| 2 | ack 共享游标语义变化 | 重新设计警告文案；`--app` 提供独立通道逃生口 |
| 3 | netcheck 踢人测试会断 daemon | 测试前提示，daemon 自动重连恢复 |
| 4 | extra_info 发送侧 0.4.3 已支持 | daemon 恢复传入，netcheck 验证 |
