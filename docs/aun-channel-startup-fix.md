# AUN 渠道启动优化方案

## 问题背景

### 现象

2026-06-18 11:46 生产环境出现问题：

- AUN gateway (`gateway.agentid.pub:20001`) 宕机
- daemon 进程在对话进行中收到 `SIGTERM` 触发重启
- 重启后用户感知“feishu 等所有渠道都起不来”
- 日志大量出现 `[AUN] Well-known discovery failed: timeout` 和 `Cannot resolve gateway URL` 错误

### 结论

优化方向正确：AUN 首连失败不应该阻塞其它渠道启动。

但原 v1.0 方案里“新增 `data/aun-gateway-cache.json`”不应作为主修复。当前 `@agentunion/fastaun` SDK 已经有 gateway metadata 缓存，且 `authenticate()` 明确禁止外部传入 gateway。更合适的修复是：

1. 移除或弱化 `AUNChannel` 里 SDK 之前的应用层 well-known pre-discovery，避免它在 SDK 使用自身缓存前先失败。
2. 让普通渠道初始连接后台化，并保留逐个渠道 connected 事件、trigger 启动和启动摘要。
3. 将 Feishu thread preload 提前到任何 `connect()` 之前，避免后台连接引入新竞态。

---

## 根因分析

### 缺陷 A：AUN 应用层 pre-discovery 阻断了 SDK 自愈路径

当前代码位置：`src/channels/aun.ts:725-741`

```typescript
let gateway = this.config.gatewayUrl || '';
if (!gateway) {
  const wellKnownUrl = `https://${aidName}/.well-known/aun-gateway`;
  try {
    const discovery = new GatewayDiscovery({});
    gateway = await discovery.discover(wellKnownUrl);
    logger.info(`${this.logPrefix()} Gateway discovered: ${gateway}`);
  } catch (e) {
    logger.warn(`${this.logPrefix()} Well-known discovery failed (${e}), no fallback available`);
  }
}

if (!gateway) {
  logger.error(`${this.logPrefix()} Cannot resolve gateway URL from AID`);
  throw new Error('Cannot resolve gateway URL from AID');
}
```

问题点：

1. 这段代码发生在 `getAidStore()` / `loadClient()` 之前。
2. well-known 超时后，`AUNChannel` 直接抛错，SDK 没有机会读取它自己的 gateway metadata 缓存。
3. SDK 当前已有缓存逻辑：`AUNClient._resolveGatewayForAid()` 会先读 token store metadata 的 `gateway_url`，发现成功后也会写回 `gateway_url`。
4. SDK `authenticate()` 明确禁止外部传入 `gateway` / `gateways`，所以在 EvolClaw 层新增一个独立 JSON 缓存不是最小正确解。

当前代码里 `gateway` 变量还存在一个误导点：它被写入 `this.gatewayUrl` 用于日志/状态，但没有作为 `client.authenticate()` 的参数传入。真正认证时仍由 SDK 自己解析 gateway。

### 缺陷 B：`connectAll()` 初始连接阻塞 daemon 主流程

当前代码位置：

- `src/index.ts:944`
- `src/core/channel-loader.ts:161`

```typescript
const connected = await channelLoader.connectAll(channelInstances);
```

```typescript
async connectAll(instances, { concurrency = 3, intervalMs = 50 }) {
  for (const inst of instances) {
    while (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }
    // ...
  }
}
```

问题点：

1. 多个 AUN agent 排在前面时，会占满 3 个初始连接并发槽。
2. gateway 宕机时，每个 AUN 首连都会在 discovery/auth/connect 阶段等待超时。
3. 排在后面的 feishu/wechat/dingtalk 等渠道要等前面连接释放并发槽，用户感知为“所有渠道都起不来”。

### 缺陷 C：后台连接不能只改一行

`connected` 当前不只用于最后摘要，还用于：

- 发布 `channel:connected` 事件
- 启动 trigger scheduler
- 发送上线通知
- 打印 `EvolClaw is running with ...` 摘要
- 发布 `system:started`

因此不能简单把 `await channelLoader.connectAll(...)` 改成 `const connectedPromise = ...` 后继续使用旧代码。需要把“连接结果相关逻辑”显式搬进连接完成/单通道连接回调中。

此外，Feishu 的 `preloadThreads()` 当前在 `connectAll()` 之后执行。如果连接后台化，应移动到 `connectAll()` 之前，否则 Feishu 可能先收到消息、后加载已知 thread_id，重新引入话题误判竞态。

---

## 修复方案

### 方案 A：删除 AUN 应用层强制 pre-discovery

目标：不要在 SDK 使用自身 gateway 缓存前失败；让 SDK 负责 discovery、metadata cache、auth 和 reconnect。

#### 推荐修改

在 `src/channels/aun.ts` 中删除当前手写 discovery 的硬门槛，改成：

```typescript
const aunPath = this.config.keystorePath || resolveRoot();
const aidName = this.config.aid;
const configuredGateway = this.config.gatewayUrl || '';

logger.info(
  `${this.logPrefix()} Initializing: aid=${aidName}, `
  + `gateway=${configuredGateway || '<sdk-discovery>'}, aun_path=${aunPath}`
);

const store = await getAidStore({
  slotId: SLOT.daemon,
  aunPath,
  debug: this.config.aunSdkLog ?? false,
});
this.store = store;

const client = await loadClient(store, aidName);
this.client = client;
if (configuredGateway) {
  // SDK public API 当前不允许 authenticate(opts.gateway)，但 config.gatewayUrl
  // 仍是 EvolClaw 的显式配置语义。若 SDK 后续提供公开 setter，应在这里接入；
  // 当前版本不要访问私有 _gatewayUrl，除非明确接受 SDK 内部字段耦合。
  this.gatewayUrl = configuredGateway;
}
```

然后保持后续：

```typescript
const auth = await client.authenticate();
const resolvedGateway = String(auth?.gateway ?? this.gatewayUrl ?? '');
this.gatewayUrl = resolvedGateway;
```

#### 是否保留 `GatewayDiscovery`

默认不保留。原因：

- SDK 已经会尝试 AID well-known 和 `gateway.<issuer>` well-known。
- SDK 已经会读写 gateway metadata cache。
- EvolClaw 层提前 discovery 会重复请求，并且失败时容易误伤 SDK 缓存路径。

如果为了日志诊断保留，必须满足：

- discovery 失败只能 warn，不能 throw。
- discovery 不能挡住 `getAidStore()` / `loadClient()` / `client.authenticate()`。
- 不新增独立 `data/aun-gateway-cache.json`，避免双缓存不一致。

#### 关于 `config.gatewayUrl`

当前 SDK `authenticate()` 不接受外部 gateway 参数，`connect()` public options 也不接受 `gateway` 字段。若要完整支持 `config.gatewayUrl`，有三个选择：

1. 上游 SDK 增加公开 API，例如 `client.setGatewayUrl(url)` 或允许构造参数注入 gateway。
2. EvolClaw 临时写 SDK 私有字段 `(client as any)._gatewayUrl = configuredGateway`，但这会耦合 SDK 内部实现，不推荐作为长期方案。
3. 保持当前语义为“日志/状态字段”，实际解析仍交给 SDK。该方式最稳，但 `config.gatewayUrl` 不再是强制 fallback。

建议本轮先选 3，另开任务推动 SDK public API。

### 方案 B：后台连接普通渠道，并提供单通道回调

目标：daemon 核心服务启动不等待全部渠道首连；任一渠道故障不占用其它渠道启动机会。

#### 1. 扩展 `connectAll()` 选项

修改 `src/core/channel-loader.ts`：

```typescript
export interface ConnectAllOptions {
  concurrency?: number;
  intervalMs?: number;
  onConnected?: (inst: ChannelInstance) => void | Promise<void>;
  onFailed?: (inst: ChannelInstance, error: unknown) => void | Promise<void>;
}

async connectAll(
  instances: ChannelInstance[],
  { concurrency = 3, intervalMs = 50, onConnected, onFailed }: ConnectAllOptions = {},
): Promise<string[]> {
  const connected: string[] = [];
  const failed: { name: string; error: unknown }[] = [];
  const inflight = new Set<Promise<void>>();

  for (const inst of instances) {
    while (inflight.size >= concurrency) {
      await Promise.race(inflight);
    }

    const task = (async () => {
      try {
        await inst.connect();
        connected.push(inst.adapter.channelName);
        await onConnected?.(inst);
      } catch (e) {
        failed.push({ name: inst.adapter.channelName, error: e });
        logger.warn(`[connectAll] ${inst.adapter.channelName} connect failed: ${e}`);
        await onFailed?.(inst, e);
      }
    })();

    const tracked = task.finally(() => { inflight.delete(tracked); });
    inflight.add(tracked);

    if (intervalMs > 0) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  await Promise.allSettled(inflight);

  if (failed.length > 0) {
    logger.warn(
      `[connectAll] ${failed.length} channel(s) failed initial connect `
      + `(will retry in background): ${failed.map(f => f.name).join(', ')}`
    );
  }

  return connected;
}
```

注意：这个方法仍然返回 Promise，兼容 hot-load/reload 等需要等待首连的路径。daemon 首启是否等待，由 `src/index.ts` 决定。

#### 2. Feishu preload 提前

在 `src/index.ts` 中，将 `preloadThreads()` 移到启动连接前：

```typescript
for (const inst of channelInstances) {
  const channelType = inst.channelType || inst.adapter.channelName;
  if (channelType === 'feishu' && 'preloadThreads' in inst.channel) {
    const threadIds = sessionManager.getKnownThreadIds(inst.adapter.channelKey);
    (inst.channel as any).preloadThreads(threadIds);
  }
}
```

#### 3. 用集合维护已连接渠道

在 `src/index.ts` 中创建状态集合和公共 helper：

```typescript
const connectedChannels = new Set<string>();

const markChannelConnected = async (inst: ChannelInstance): Promise<void> => {
  const name = inst.adapter.channelName;
  if (connectedChannels.has(name)) return;
  connectedChannels.add(name);

  const type = inst.channelType || name;
  eventBus.publish({
    type: 'channel:connected',
    channel: type.toLowerCase(),
    channelName: name,
    timestamp: Date.now(),
  });

  const agent = agentRegistry.resolveByChannel(name);
  if (agent) {
    await startTriggerScheduler(agent);
  }
};
```

`startTriggerScheduler()` 本身应保持幂等：重复调用同一个 agent 不应重复注册同一批 trigger。

#### 4. 后台启动连接

替换 daemon 首启的阻塞 `await connectAll()`：

```typescript
logger.info(`🚀 EvolClaw core is ready; connecting ${channelInstances.length} channel(s) in background`);

const connectAllPromise = channelLoader.connectAll(channelInstances, {
  concurrency: 10,
  onConnected: markChannelConnected,
  onFailed: (inst, error) => {
    logger.warn(`[startup] ${inst.adapter.channelName} initial connect failed: ${error}`);
  },
});

connectAllPromise.then((connected) => {
  const connectedTypeCount = new Map<string, number>();
  const typeOrder: string[] = [];

  for (const inst of channelInstances) {
    const name = inst.adapter.channelName;
    if (!connected.includes(name)) continue;
    const type = inst.channelType || name;
    if (!connectedTypeCount.has(type)) {
      connectedTypeCount.set(type, 0);
      typeOrder.push(type);
    }
    connectedTypeCount.set(type, connectedTypeCount.get(type)! + 1);
  }

  const channelSummary = typeOrder
    .map(type => {
      const n = connectedTypeCount.get(type)!;
      return n === 1 ? type : `${type}×${n}`;
    })
    .join(', ');

  logger.info(`✅ ${connected.length} channel(s) connected: ${channelSummary}`);
  eventBus.publish({
    type: 'system:started',
    channels: connected.map(c => c.toLowerCase()),
    timestamp: Date.now(),
  });
}).catch((e) => {
  logger.warn(`[startup] channel connection task failed unexpectedly: ${e}`);
});
```

#### 5. 移除旧的连接后循环

原来的这些逻辑要删除或迁移：

- `for (const name of connected) eventBus.publish(...)`
- `for (const agent of triggerStartupAgents) await startTriggerScheduler(agent)`
- 最后基于 `connected` 的 `EvolClaw is running with ...` 摘要

上线通知也不能再依赖局部变量 `connected`。推荐改成在 `markChannelConnected()` 中按渠道或按 agent 触发一次；或者保留延迟通知但从 `connectedChannels` 读取。

### 方案 C：控制 AID 保持当前软失败策略

`controlChannel.connect()` 当前在 `try/catch` 中独立执行，失败只 warn，不影响 daemon 主流程。这个行为是正确的，可以暂不纳入普通渠道后台化。

后续如要彻底统一，也可以把控制 AID 接入同一后台连接框架，但要先确认：

- `/pair` 和 menu control 在控制 AID 未连接时的状态展示
- service proxy 对动态 client 的依赖
- IPC status 中 `controlAid.connected` 的语义

### 方案 D: Trigger 启动与渠道解耦（2026-06-18 补充修复）

#### 发现的回归问题

在代码审查中发现:**方案 B 让 trigger 启动依赖渠道首连成功,存在回归风险**。

**问题场景**:
- 原逻辑:`for (agent of triggerStartupAgents) await startTriggerScheduler(agent)` — 无条件全部启动
- 新逻辑:只在 `markChannelConnected`(即 `onConnected` 回调)里通过 `ensureTriggerSchedulerStarted` 启动
- **风险**:某 AUN agent 在 gateway 宕机时**首连失败**(走 `onFailed`,不是 `onConnected`)→ trigger 不启动。而 AUN 渠道的后台重连**没有对外的"重连成功"回调**,即使后台重连成功,也不会补触发 `markChannelConnected` → **该 agent 的 trigger 永久不启动,直到下次进程重启**

**根因**:Trigger scheduler(cron 定时任务)本应**独立于渠道连接**运行——触发时再处理发送(渠道未连接可排队/重试),不该因为首连失败就彻底不启动。这恰恰是本次要解决的"gateway 宕机"场景下的新隐患。

#### 修复方案

在 `connectAllPromise` 发起后,**无条件**确保所有 runnable agent 的 trigger 启动,与渠道连接解耦:

```typescript
connectAllPromise.then((connected) => {
  const channelSummary = summarizeConnectedChannels(connected);
  logger.info(`✅ ${connected.length} channel(s) connected: ${channelSummary}`);
  eventBus.publish({
    type: 'system:started',
    channels: connected.map(c => c.toLowerCase()),
    timestamp: Date.now()
  });
}).catch((e) => {
  logger.warn(`[startup] channel connection task failed unexpectedly: ${e}`);
});

// Trigger scheduler 与渠道连接解耦:cron 定时任务独立于渠道可用性运行
// (触发时若渠道未连,发送侧自行排队/重试)。markChannelConnected 里的
// ensureTriggerSchedulerStarted 仅作"尽早启动"优化,此处保证即使渠道首连
// 全部失败(如 gateway 宕机),trigger 仍无条件启动。Set 去重,不会重复。
for (const agent of triggerStartupAgents) {
  ensureTriggerSchedulerStarted(agent).catch((e) => {
    logger.warn(`[startup] trigger scheduler start failed for ${agent.aid}: ${e}`);
  });
}
```

**关键点**:
- `ensureTriggerSchedulerStarted` 内部用 `startedTriggerAgents` Set 做 AID 去重,与 `markChannelConnected` 里的调用不会重复启动
- `markChannelConnected` 里的调用保留,作"尽早启动"优化(渠道连上立刻启动,不用等循环遍历到)
- 两条路径的 agent 对象都来自 `agentRegistry`(同一 Map),是同一对象引用,去重完全生效

#### 验证结果

**启动日志对比**:
- **修复前**(13:12:05):trigger scheduler 在各渠道连接成功时陆续 init(06.306 → 07.896,跟随 AUN 连接节奏)
- **修复后**(13:21:28):5 个 trigger scheduler **几乎同时 init**(28.990 全部完成),**在渠道连接之前/并行**,不再依赖各渠道连上

```
[2026-06-18T13:21:28.989] [INFO] 🚀 EvolClaw core is ready; connecting 13 channel(s) in background
[2026-06-18T13:21:28.990] [INFO] [Trigger] scheduler initialized for eleanbot.agentid.pub
[2026-06-18T13:21:28.990] [INFO] [Trigger] scheduler initialized for evolagent.agentid.pub
[2026-06-18T13:21:28.998] [INFO] [Trigger] scheduler initialized for evolai.agentid.pub
[2026-06-18T13:21:28.998] [INFO] [Trigger] scheduler initialized for multica.agentid.pub
[2026-06-18T13:21:28.999] [INFO] [Trigger] scheduler initialized for wcguard.agentid.pub
[2026-06-18T13:21:30.022] [INFO] ✅ 13 channel(s) connected: aun×5, feishu×4, wechat, qqbot, dingtalk, wecom
```

**测试覆盖**:
- ✅ `npx tsc --noEmit` 通过
- ✅ `npm run build` 通过  
- ✅ `npx vitest run tests/unit` 全过:132 文件,1572 passed,25 skipped
- ✅ 重启后日志确认:trigger 独立启动,不依赖渠道连接

---

## 风险评估

### 1. `system:started` 事件语义变化

影响：事件从“所有初始连接完成后发布”变成“后台连接任务完成后发布”。如果某些渠道超时，事件仍会延迟到本轮初始连接全部 settle。

评估：低风险。当前代码内没有业务订阅者依赖它驱动功能；主要是日志/观测用途。

建议：如果需要更清晰语义，可以新增 `system:core_ready`，保留 `system:started` 表示初始连接 settle。

### 2. `ready.signal` 时机

影响：无。`ready.signal` 已在 `connectAll()` 之前写入。

评估：正确。daemon 是否可被 CLI/IPC 发现，不应依赖外部网络渠道可用。

### 3. trigger scheduler 启动时机

影响：原来所有已连接渠道完成后统一启动；现在应按 agent 的渠道连接成功后启动。

风险：如果同一个 agent 有多个渠道，`onConnected` 可能多次触发。

要求：`startTriggerScheduler(agent)` 必须幂等，或外层增加 `startedTriggerAgents = new Set<string>()` 去重。

### 4. restart notification 可能早于渠道连接

影响：`restart-pending.json` 的重启成功通知现在可能在目标 adapter 未连接时发送。

风险：取决于各 adapter 的发送实现。若 adapter 未连接会直接失败，通知会丢。

建议：重启通知最好挂到目标渠道 `markChannelConnected()` 后执行；或者发送失败时保留 pending 文件，稍后重试。

### 5. `config.gatewayUrl` 语义

影响：如果移除 EvolClaw 层 pre-discovery，当前 SDK 没有公开 API 接收 `config.gatewayUrl`。

风险：用户手动配置 `gatewayUrl` 时可能不再作为强制 fallback 生效。

建议：短期在文档和日志中明确；中期推动 SDK 提供公开 setter 或 authenticate/connect gateway 参数。

---

## 测试验证

### 单元测试 1：`connectAll` 单通道回调

新增测试覆盖：

- 成功连接时调用 `onConnected(inst)`
- 失败连接时调用 `onFailed(inst, error)`
- 单个失败不影响其它实例连接
- `connectAll()` 返回值仍只包含成功连接的 channelName

### 单元测试 2：连接并发不阻塞后续渠道

构造：

- 3 个 AUN mock：`connect()` 返回一个 5 秒后 reject 的 Promise
- 1 个 Feishu mock：`connect()` 立即 resolve
- `concurrency = 10`

预期：

- Feishu 的 `connect()` 立即被调用，而不是等 AUN reject 后才调用。
- `onConnected` 能收到 Feishu。

### 集成测试 1：gateway 宕机时启动

操作：

1. 屏蔽 `gateway.agentid.pub:20001` 或让 AUN gateway 不可达。
2. 执行 `evolclaw restart`。

预期：

- `ready.signal` 仍快速写入。
- Feishu/wechat/dingtalk 等非 AUN 渠道可以独立连接。
- AUN 首连失败只记录 warn，不阻塞 daemon 主流程。
- `evolclaw status` 能看到 AUN AID 处于 reconnecting/failed，而非整个服务不可用。

### 集成测试 2：SDK gateway metadata cache 生效

操作：

1. 正常连接一次 AUN，让 SDK 写入 token store metadata。
2. 临时阻断 AID well-known。
3. 保持 gateway WebSocket 可达，重启 daemon。

预期：

- 不应出现 EvolClaw 应用层 `Cannot resolve gateway URL from AID` 阻断。
- SDK 能从 metadata `gateway_url` 进入认证/连接流程。

### 集成测试 3：Feishu preload 顺序

操作：

1. 启动 daemon，观察日志或 mock。
2. 验证 `preloadThreads()` 在 Feishu `connect()` 前调用。

预期：

- 重启后已知 thread_id 已预加载。
- 首条 Feishu 话题消息不会被误判为新话题。

### 集成测试 4：重启通知

操作：

1. 通过远程指令触发 restart，生成 `restart-pending.json`。
2. 重启后让目标渠道延迟连接。

预期：

- 重启成功通知不应因目标渠道未连接而永久丢失。
- 如果首次发送失败，pending 文件保留或进入重试逻辑。

---

## 部署步骤

1. 修改 `src/channels/aun.ts`
   - 移除应用层强制 well-known pre-discovery。
   - 保留 SDK `authenticate()` 后的 `this.gatewayUrl` 状态更新。
   - 不新增 `data/aun-gateway-cache.json`。

2. 修改 `src/core/channel-loader.ts`
   - 增加 `onConnected` / `onFailed` 回调。
   - 保持 `connectAll()` 返回 Promise，兼容 hot-load/reload。

3. 修改 `src/index.ts`
   - 将 Feishu `preloadThreads()` 移到 `connectAll()` 前。
   - 首启不 await 普通渠道 `connectAll()`。
   - 用 `connectedChannels` 和 `markChannelConnected()` 承接事件、trigger 和上线通知。
   - 移除旧的 `connected` 后处理代码。

4. 编译和测试

```bash
npm run build
npm test
```

5. 重启并观察

```bash
evolclaw restart
tail -f logs/evolclaw.log
evolclaw status
```

重点观察：

- `Ready signal written` 仍快速出现。
- `EvolClaw core is ready; connecting ... in background` 快速出现。
- 非 AUN 渠道不被 AUN gateway timeout 阻塞。
- AUN 状态能在 `status` 中正常显示 failed/reconnecting/connected。

---

## 回滚方案

如果修复后发现问题：

```bash
git checkout -- src/channels/aun.ts src/core/channel-loader.ts src/index.ts
npm run build
evolclaw restart
```

如果曾经试验性创建过独立 gateway 缓存文件，可清理：

```bash
rm -f /home/evolclaw/data/aun-gateway-cache.json
```

---

## 后续优化

1. 推动 `@agentunion/fastaun` 暴露公开 gateway override API，恢复 `config.gatewayUrl` 的强 fallback 能力。
2. 增加 channel priority：关键渠道如 Feishu 可以优先进入连接队列。
3. 为重启通知和上线通知建立“目标渠道连接后再发送”的统一机制。
4. 将 `system:started` 拆成 `system:core_ready` 与 `system:channels_settled`，避免事件语义混淆。
5. 在 `evolclaw status` 中显示 initial connect 失败原因和下一次重试时间。

---

## 相关文件

- `src/channels/aun.ts`：AUN channel 初始化、authenticate、connect、reconnect 状态
- `src/core/channel-loader.ts`：`connectAll()` 并发控制和连接结果收集
- `src/index.ts`：daemon 主启动流程、ready signal、渠道连接、trigger、重启通知
- `src/cli/daemon-commands.ts`：`evolclaw start` 对 ready signal 和启动日志的展示
- `src/cli/restart-monitor.ts`：restart 后的 ready signal 监控
- `node_modules/@agentunion/fastaun/dist/client.js`：SDK gateway metadata cache 实现
- `node_modules/@agentunion/fastaun/dist/client/lifecycle.js`：SDK authenticate/connect public option 限制

---

**文档版本**：v1.2  
**创建时间**：2026-06-18  
**修订记录**：

- v1.2（2026-06-18）：**补充方案 D — Trigger 启动与渠道解耦修复**。代码审查发现方案 B 让 trigger 依赖渠道首连成功存在回归风险(gateway 宕机时 trigger 永久不启动),补充无条件启动逻辑,附验证结果。
- v1.1（2026-06-18）：修正 gateway 缓存方案;明确 SDK 已有 metadata cache;补全后台连接的事件、trigger、preload、通知风险。
- v1.0（2026-06-18）：初版,包含项目级 gateway 缓存和简单后台连接方案。
