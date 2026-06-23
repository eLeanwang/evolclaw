# Trigger 事件源驱动扩展改造方案

## 一、背景与目标

### 1.1 现有 Trigger 能力

当前 Trigger 是**时间驱动**的系统：

| 能力维度 | 现状 |
|---------|------|
| **触发源** | 仅时间：`delay`/`at`/`cron`/`interval` |
| **动作** | ✅ 发消息（direct-message）<br>✅ 喂 prompt 给 agent（agent-session；兼容 legacy agent-runner）<br>✅ 执行脚本（node/python/bash） |
| **配置** | 声明式 JSON 文件 + 热重载 |
| **生命周期** | create/update/enable/disable/cancel/run |

**现状评估**：
- ✅ 动作侧能力完整（发消息、agent 执行、脚本执行）
- ❌ 触发源单一（只支持时间）
- ❌ 无法响应系统内部事件（消息到达、会话切换、对端上线等）
- ❌ 无法基于状态变化触发（如会话消息数超阈值、对端长时间未联系等）

### 1.2 改造目标

将 Trigger 从**时间驱动**扩展为**事件+状态驱动**：

```
现有:  [时间调度器] → 时间到 → 执行动作

扩展:  [事件总线 + 状态观察器] → 匹配规则 → 执行动作
```

**核心价值**：
- 支持系统内部事件触发（Agent 内部事件、Channel 通道事件）
- 支持状态变化触发（Session/会话状态、自定义业务状态）
- 复用现有执行层（script + feedback），只扩展触发源
- 保持声明式配置，运行时热重载
- 渐进式实现，不破坏现有时间触发器

---

## 二、核心架构设计

### 2.1 整体分层

```typescript
┌─────────────────────────────────────────────┐
│  事件源层 (Event Source Layer)              │
├─────────────────────────────────────────────┤
│  1. TimeSource     时间触发器（现有）        │
│  2. EventSource    EventBus 事件订阅         │
│  3. StateRegistry  状态变化观察              │
└─────────────────────────────────────────────┘
         ↓ fire TriggerSourceEvent
┌─────────────────────────────────────────────┐
│  触发调度层 (TriggerRuntimeScheduler)        │
│  - 条件匹配（pattern + filter）              │
│  - 上下文注入（变量展开）                    │
│  - 并发控制（复用现有 concurrency）          │
└─────────────────────────────────────────────┘
         ↓ fire
┌─────────────────────────────────────────────┐
│  执行层 (Executor)  ← 完全复用现有           │
│  - script-executor.ts                       │
│  - feedback.ts (agent-session/direct-message)│
└─────────────────────────────────────────────┘
```

### 2.2 关键设计决策：State → Event 转换

**核心思路**：状态变化转换为合成事件，统一在 EventBus 上处理。

```
EventBus ──→ EventSource ──→ TriggerRuntimeScheduler.startRun()
              ↑
StateRegistry ──→ publish synthetic event (state:*:changed)
```

**优势**：
1. **语义统一**：Event 是基础概念，State 是派生概念（值变化 = 变化事件）
2. **实现清晰**：只维护一套事件处理逻辑，状态只是特殊事件源
3. **调试友好**：所有触发在 EventBus 上可见，日志统一
4. **渐进演进**：先实现 EventSource，再加 StateRegistry（自动转成事件）

### 2.3 当前代码适配约束

MVP 必须以当前实现为边界，不引入新的调度器大重构：

| 现有实现 | 对 MVP 的影响 |
|---------|--------------|
| `EventBus` 使用 `publish()/subscribe()/subscribeAll()/subscribePrefix()`，不是 Node 原生 `emit/on` 语义 | `EventSource` 不能直接假设 `eventBus.on(glob)`；需要通过 `subscribeAll` 自行匹配，或给 `EventBus` 增加返回 `Unsubscribe` 的 pattern 订阅方法 |
| `TriggerRuntimeScheduler` 当前只管理 timer 和 running run | event trigger 要在同一 scheduler 内增加 `eventSubscriptions`，并在 `init/create/update/enable/disable/stop` 时完整注册/注销 |
| 每个 agent 一个 `TriggerRuntimeScheduler`，但 `EventBus` 是进程级共享 | 事件订阅可以共享同一个 bus；隔离依赖 `agentAid` 所属 scheduler、trigger 自身 `filter` 和反馈目标校验 |
| 模板渲染目前只注入 `trigger/session/result/error/timestamp` | MVP 必须把事件 payload 注入为 `event`/`source.payload`，否则 `{{event.content}}` 这类模板不可用 |
| 现有事件载荷字段已经固定，例如 `message:received` 是 `{ channel, channelId, content, userId, sessionId }` | MVP 示例和验收必须使用真实字段，不引入 `channelType`/`peerId`/`content.text` 这类尚不存在的别名 |

因此，MVP 的原则是：**只接入现有 EventBus 事件，事件源触发后复用 `startRun()`，先不做状态系统、任意 glob、节流/防抖、表达式引擎。**

---

## 三、类型系统设计

### 3.1 扩展 TriggerSource

```typescript
export type TriggerSource =
  // ── 现有时间类 ──
  | { type: 'delay'; afterMs: number }
  | { type: 'at'; at: string }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; everyMs: number }

  // ── 新增事件类 ──
  | EventSource
  // ── 阶段 2 新增状态类（MVP 中解析时报错）──
  | StateSource;

// ── 事件源配置 ──
interface EventSource {
  type: 'event';

  // 必填：事件模式
  // MVP 支持精确事件名和单段前缀通配：'message:received'、'channel:*'
  // 后续阶段再扩展为更完整 glob。
  eventPattern: string;

  // 可选：过滤器
  filter?: EventFilter;

  // 后续阶段：节流/防抖
  throttle?: {
    mode: 'leading' | 'trailing' | 'debounce';
    windowMs: number;
  };

  // 后续阶段：事件载荷提取（点分 path）
  // MVP 默认整个事件对象都进 payload。
  payloadPick?: string[];   // 例：['channelId', 'content']
}

// ── 事件触发传给 scheduler 的运行时对象 ──
interface TriggerSourceEvent {
  sourceType: 'event' | 'state';
  eventName?: string;
  firedAt: number;
  payload: Record<string, unknown>;
}

// ── 状态源配置 ──
interface StateSource {
  type: 'state';

  // 必填：状态键（命名空间约定见下文）
  stateKey: string;

  // 必填：触发条件
  condition: StateCondition;

  // 可选：初始状态加载时是否触发
  // - 'never'（默认）：首次读取的值不算变化
  // - 'if-match'：首次读取就符合条件就触发一次
  initialFire?: 'never' | 'if-match';

  // 可选：防抖（状态稳定 N 毫秒才触发，避免抖动）
  debounceMs?: number;

  // 可选：自定义轮询间隔（仅 poll 模式有效）
  pollIntervalMs?: number;
}
```

### 3.2 事件过滤器设计

分层设计：**先结构化匹配，再表达式过滤**。

```typescript
interface EventFilter {
  // 第一层：结构化字段匹配（高效，命中率高）
  match?: {
    [path: string]: MatchValue;   // path 是点分路径，不是完整 JSONPath
  };

  // 第二层：表达式（兜底，复杂逻辑）
  // 注意：第一期暂不实现，避免安全问题
  where?: string;   // 安全表达式引擎（JSONLogic/CEL）
}

type MatchValue =
  | string | number | boolean      // 精确等值
  | { $in: unknown[] }              // 列表匹配
  | { $regex: string }              // 正则
  | { $gt?: number; $gte?: number; $lt?: number; $lte?: number }
  | { $exists: boolean }
  | { $not: MatchValue };
```

**配置示例**：

```json
{
  "filter": {
    "match": {
      "channel": { "$in": ["feishu", "aun"] },
      "channelId": "oc_xxx",
      "content": { "$regex": "^/report" }
    }
  }
}
```

**安全性说明**：
- `where` 表达式第一期**不实现**，避免 eval 安全问题
- 如用户需求强烈，二期引入 JSONLogic（纯数据描述，零代码执行）

**MVP 限制**：
- `filter.match` 的 path 采用点分读取，不实现完整 JSONPath。
- MVP 支持：精确等值、`$in`、`$regex`、`$gt/$gte/$lt/$lte`、`$exists`。
- `$not`、`where`、复杂数组匹配、payloadPick 留到后续阶段。

**eventPattern 校验**：
- MVP 只允许三种形式：`*`、精确事件名（如 `message:received`）、单段前缀通配（如 `message:*`）。
- 不支持 `message:*:foo`、`message:**`、`*received`、正则 pattern。
- 精确事件名建议来自事件目录；未知但语法合法的事件名允许创建，用于兼容后续新增事件。

**filter 校验**：
- `filter` 必须是 object；MVP 只接受 `filter.match`，出现 `where` 应报错或明确提示“暂不支持”。
- `filter.match` 的每个 key 必须是非空字符串，不能包含 `__proto__`、`prototype`、`constructor` 这类危险属性段。
- `$regex` 在创建 trigger 时就要尝试 `new RegExp(pattern)`，失败则拒绝创建。
- 数值比较操作符只接受 number；`$in` 只接受 array。
- 同一个 MatchValue object 中多个操作符默认按 AND 处理；如果实现不支持 AND，应在校验阶段禁止多操作符混用。

### 3.3 状态条件设计

```typescript
type StateCondition =
  // ── 变化类 ──
  | { operator: 'changed' }                                    // 任何变化
  | { operator: 'changed-to'; value: unknown }                 // 变化为某值
  | { operator: 'changed-from'; value: unknown }               // 从某值变化
  | { operator: 'transition'; from: unknown; to: unknown }     // 精确转移

  // ── 比较类 ──
  | { operator: 'eq' | 'ne'; value: unknown }
  | { operator: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { operator: 'in' | 'not-in'; values: unknown[] }
  | { operator: 'exists' | 'not-exists' }
  | { operator: 'matches'; pattern: string }                   // 正则

  // ── 特殊类 ──
  | { operator: 'crossed'; threshold: number; direction: 'up' | 'down' | 'both' }
  | { operator: 'stable'; durationMs: number };                // 稳定 N 毫秒
```

**关键语义辨析**（易混淆，需明确文档化）：

| 条件 | 发时机 | 典型场景 |
|------|---------|---------|
| `changed` | 每次值变 | 通用变化监听 |
| `eq` | 值等于 X 时，**每次状态更新都检查** | 值满足条件（含同值更新） |
| `changed-to` | 值**变为** X（前值不是 X） | 状态机进入边沿 |
| `transition` | 精确 from → to | 状态机转移 |
| `crossed` | 跨越阈值（边沿触发） | 阈值告警 |
| `stable` | 值稳定 N 毫秒 | 防抖等待 |

**重要区别**：
- `eq` 会在 `idle → idle`（同值更新）时也触发
- `changed-to` 只在边沿触发一次（值从非 X 变为 X）

---

## 四、状态系统设计

### 4.1 StateRegistry 架构

**核心思路**：状态是带访问器的统一资源，访问器声明监听方式（push/poll/hybrid）。

```typescript
interface StateAccessor<T> {
  readonly key: string;              // 状态唯一标识，如 "session.messageCount"
  readonly mode: 'push' | 'poll' | 'hybrid';

  // 读取当前值（poll 模式周期调用，push 模式按需调用）
  read(): Promise<T>;

  // push 模式必填：状态源主动通知
  subscribe?(cb: (newVal: T, oldVal: T) => void): Unsubscribe;

  // poll 模式可选：自定义轮询周期（默认 5000ms）
  pollIntervalMs?: number;

  // 比较函数（处理对象/深比较，默认 ===）
  equals?(a: T, b: T): boolean;
}

// ── StateRegistry 核心接口 ──
class StateRegistry {
  // 注册状态访问器（由各模块在初始化时注册）
  register<T>(accessor: StateAccessor<T>): void;

  // 订阅状态变化（Trigger 系统调用）
  subscribe(stateKey: string, cb: StateChangeCallback): Unsubscribe;

  // 内部：状态变化时 publish 到 EventBus
  private onStateChange(key: string, oldVal: any, newVal: any): void {
    this.eventBus.publish({
      type: `state:${key}:changed`,
      stateKey: key,
      oldValue: oldVal,
      newValue: newVal,
      changedAt: Date.now(),
    });
  }
}
```

**关键优势**：
1. **统一抽象**：Trigger 系统只跟 StateRegistry 打交道，不关心底层 push/poll
2. **可演进**：今天 poll 实现的状态，明天换 push，配置不变
3. **多消费者共享**：N 个 trigger 监听同一状态，只跑 1 个 watcher
4. **hybrid 模式**：有 push 用 push，定期 poll 做对账（防丢事件）

### 4.2 状态命名空间约定

```
session.<sessionId>.messageCount         会话级状态
session.<sessionId>.permissionMode
session.<sessionId>.idleMinutes

peer.<peerKey>.lastSeenAt                对端级状态（跨会话）
peer.<peerKey>.online
peer.<peerKey>.relationScore

agent.<aid>.status                       agent 级状态
agent.<aid>.queueLength

channel.<channel>.connected              渠道级状态
channel.<channel>.latencyMs

custom.<userKey>                         用户自定义业务状态
```

**状态注册示例**：

```typescript
// SessionManager 注册 session.* 状态
stateRegistry.register({
  key: 'session.*.messageCount',
  mode: 'push',
  read: async () => {
    // 从 active.json 读取
  },
  subscribe: (cb) => {
    // 监听 EventBus 的 message:received 事件
    return eventBus.on('message:*', (event) => {
      const sessionId = event.sessionId;
      const oldCount = this.getMessageCount(sessionId);
      const newCount = oldCount + 1;
      cb(newCount, oldCount);
    });
  },
});

// PeerManager 注册 peer.* 状态（poll 模式）
stateRegistry.register({
  key: 'peer.*.lastSeenAt',
  mode: 'poll',
  pollIntervalMs: 60_000,  // 每分钟检查一次
  read: async () => {
    // 从 $PEERS_DIR/<aid>.md 读取 lastSeenAt
  },
});
```

### 4.3 状态持久化策略

| 命名空间 | 策略 | 理由 |
|---------|------|------|
| `session.*` | 内存态，重启丢失 | 会话是临时的，重启后不补触发 |
| `peer.*` | 持久化到 `$AGENT_DIR/state/peer/` | 对端状态跨会话，重启后恢复 |
| `agent.*` | 内存态 | agent 级状态通常是运行时状态 |
| `channel.*` | 内存态 | 渠道连接状态重启后重新探测 |
| `custom.*` | 持久化到 `$AGENT_DIR/state/custom/` | 用户自定义状态，需要持久化 |

**存储格式**：
```
$AGENT_DIR/state/
├── peer/
│   └── <urlEncode(peerKey)>.json       { "stateKey": "peer.xxx", "value": ..., "updatedAt": 123 }
└── custom/
    └── <urlEncode(userKey)>.json
```

---

## 五、事件目录

### 5.1 MVP 事件目录（基于当前 `src/core/event-bus.ts`）

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `message:received` | `{ sessionId, channel, channelName?, channelId, content, userId?, agentName?, timestamp? }` | 消息到达 |
| `message:sent-out` | `{ agentName, channelId, taskId? }` | 消息输出完成的轻量事件 |
| `task:completed` | `{ sessionId, channel, channelName?, channelId, finalText?, durationMs?, terminalReason?, agentName?, numTurns?, timestamp? }` | agent 任务完成，可作为“消息发出/回复完成”的更完整事件 |
| `session:created` | `{ sessionId, channel, channelName?, channelId, projectPath?, name?, chatType?, threadId?, timestamp? }` | 会话创建 |
| `session:switched` | `{ sessionId, fromSessionId, toSessionId }` | 会话切换 |
| `channel:connected` | `{ channel, channelName?, timestamp? }` | 渠道连接成功 |
| `channel:disconnected` | `{ channel, channelName?, reason? }` | 渠道断开 |

字段命名以现有事件类型为准：当前代码使用 `channel` 表示渠道类型或 channel key 的业务字段，不使用 `channelType`；`message:received.content` 当前是字符串，不是 `{ text }` 对象。需要更友好的别名时，应先在事件生产端补字段并同步事件目录，不能只在 trigger 文档中假设存在。

### 5.2 后续可补充事件

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `agent:started` | `{ agentAid, startedAt }` | agent 启动 |
| `agent:stopped` | `{ agentAid, stoppedAt }` | agent 停止 |
| `session:idle` | `{ sessionId, idleMinutes }` | 会话空闲 N 分钟 |
| `trigger:fired` | `{ triggerId, runId }` | trigger 触发（可再触发其他 trigger，需防环） |
| `channel:peer-online` | `{ peerId, channel }` | 对端上线（AUN 特有） |
| `channel:peer-offline` | `{ peerId, channel }` | 对端下线（AUN 特有） |
| `channel:group-member-added` | `{ groupId, peerId }` | 群成员加入 |
| `channel:group-dissolved` | `{ groupId }` | 群解散 |

### 5.3 合成状态事件（阶段 2）

StateRegistry 自动生成：

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `state:<key>:changed` | `{ stateKey, oldValue, newValue, changedAt }` | 状态任意变化 |
| `state:<key>:crossed-up` | `{ stateKey, threshold, oldValue, newValue }` | 跨越阈值向上 |
| `state:<key>:crossed-down` | `{ stateKey, threshold, oldValue, newValue }` | 跨越阈值向下 |
| `state:<key>:transitioned` | `{ stateKey, from, to }` | 状态精确转移 |

TypeScript 类型注意：当前 `GatewayEvent` 是封闭联合类型。阶段 2 引入动态 `state:${key}:changed` 时，需要新增 `StateBusEvent` 类型，例如：

```typescript
type StateBusEvent =
  | { type: `state:${string}:changed`; stateKey: string; oldValue: unknown; newValue: unknown; changedAt: number }
  | { type: `state:${string}:crossed-up`; stateKey: string; threshold: number; oldValue: unknown; newValue: unknown }
  | { type: `state:${string}:crossed-down`; stateKey: string; threshold: number; oldValue: unknown; newValue: unknown }
  | { type: `state:${string}:transitioned`; stateKey: string; from: unknown; to: unknown };
```

**事件白名单维护**：
- 所有事件在 `$KITS_DOCS/triggers/event-catalog.md` 维护清单
- 每个事件注明：事件名、载荷字段、触发时机、典型用途
- 用户写 trigger 时参考此清单
- 事件目录应从 `src/core/event-bus.ts` 的 `GatewayEvent` 联合类型生成或人工同步校验，避免文档字段和代码字段漂移

---

## 六、核心模块实现

### 6.1 EventSource 实现

```typescript
// src/trigger/sources/event-source.ts
export class EventSource {
  private subscriptions = new Map<string, Unsubscribe>();

  constructor(
    private eventBus: EventBus,
    private fire: (triggerId: string, event: TriggerSourceEvent) => void,
  ) {}

  register(trigger: TriggerDefinition): Unsubscribe {
    if (trigger.source.type !== 'event') return () => {};

    const { eventPattern, filter } = trigger.source;

    // MVP：EventBus 现有接口不支持 glob on()，通过 subscribeAll 后自行匹配。
    const handler = (event: GatewayEvent) => {
      if (!this.matchPattern(event.type, eventPattern)) return;

      // 1. 过滤器匹配
      if (filter && !this.matchFilter(event, filter)) return;

      // 2. MVP 默认整个 event 作为 payload，后续再支持 payloadPick。
      const payload = event as unknown as Record<string, unknown>;

      // 3. 触发 scheduler，scheduler 内部复用 startRun()/并发控制/审计。
      this.fire(trigger.id, {
        sourceType: 'event',
        eventName: event.type,
        firedAt: Date.now(),
        payload,
      });
    };
    this.eventBus.subscribeAll(handler);
    const unsubscribe = () => this.eventBus.unsubscribe('*', handler);

    this.subscriptions.set(trigger.id, unsubscribe);
    return unsubscribe;
  }

  private matchPattern(eventType: string, pattern: string): boolean {
    if (pattern === '*' || pattern === eventType) return true;
    if (pattern.endsWith(':*')) return eventType.startsWith(pattern.slice(0, -1));
    return false;
  }

  private matchFilter(event: any, filter: EventFilter): boolean {
    if (!filter.match) return true;

    // 遍历 match 规则，所有规则都通过才匹配
    for (const [path, matchValue] of Object.entries(filter.match)) {
      const actualValue = this.getByPath(event, path);
      if (!this.matchValue(actualValue, matchValue)) return false;
    }

    return true;
  }

  private matchValue(actual: any, expected: MatchValue): boolean {
    // 处理精确等值
    if (typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean') {
      return actual === expected;
    }

    // 处理操作符
    if ('$in' in expected) return expected.$in.includes(actual);
    if ('$regex' in expected) return new RegExp(expected.$regex).test(actual);
    if ('$gt' in expected) return actual > expected.$gt!;
    if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    // ... 其他操作符

    return false;
  }

  private getByPath(obj: any, path: string): any {
    // 点分 path 简单实现
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  unregister(triggerId: string): void {
    const unsubscribe = this.subscriptions.get(triggerId);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(triggerId);
    }
  }
}
```

### 6.2 StateRegistry 实现

```typescript
// src/trigger/sources/state-registry.ts
export class StateRegistry {
  private accessors = new Map<string, StateAccessor<any>>();
  private watchers = new Map<string, StateWatcher<any>>();

  constructor(
    private eventBus: EventBus,
  ) {}

  // 注册状态访问器（各模块初始化时调用）
  register<T>(accessor: StateAccessor<T>): void {
    this.accessors.set(accessor.key, accessor);
    logger.info(`[StateRegistry] registered state: ${accessor.key} (${accessor.mode})`);
  }

  // 订阅状态变化（Trigger 系统调用）
  subscribe(stateKey: string, cb: StateChangeCallback): Unsubscribe {
    // 支持通配符匹配（如 session.*.messageCount）
    const matchingKeys = this.findMatchingKeys(stateKey);
    const unsubscribes: Unsubscribe[] = [];

    for (const key of matchingKeys) {
      const watcher = this.getOrCreateWatcher(key);
      const unsub = watcher.subscribe(cb);
      unsubscribes.push(unsub);
    }

    return () => unsubscribes.forEach(u => u());
  }

  private getOrCreateWatcher<T>(key: string): StateWatcher<T> {
    if (this.watchers.has(key)) return this.watchers.get(key)!;

    const accessor = this.accessors.get(key);
    if (!accessor) throw new Error(`state accessor not found: ${key}`);

    const watcher = new StateWatcher(
      accessor,
      (oldVal, newVal) => this.onStateChange(key, oldVal, newVal),
    );
    this.watchers.set(key, watcher);
    watcher.start();

    return watcher;
  }

  private onStateChange(key: string, oldVal: any, newVal: any): void {
    // 投递合成事件到 EventBus
    this.eventBus.publish({
      type: `state:${key}:changed`,
      stateKey: key,
      oldValue: oldVal,
      newValue: newVal,
      changedAt: Date.now(),
    });
  }

  private findMatchingKeys(pattern: string): string[] {
    // 通配符匹配（session.*.messageCount → session.abc.messageCount, session.def.messageCount）
    const regex = new RegExp('^' + pattern.replace(/\*/g, '[^.]+') + '$');
    return Array.from(this.accessors.keys()).filter(k => regex.test(k));
  }
}

// ── StateWatcher 实现 ──
class StateWatcher<T> {
  private currentValue: T | undefined;
  private subscribers = new Map<string, StateChangeCallback>();
  private unsubscribe?: Unsubscribe;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private accessor: StateAccessor<T>,
    private emitChange: (oldVal: T, newVal: T) => void,
  ) {}

  start(): void {
    if (this.accessor.mode === 'push' || this.accessor.mode === 'hybrid') {
      if (!this.accessor.subscribe) throw new Error(`push mode requires subscribe: ${this.accessor.key}`);
      this.unsubscribe = this.accessor.subscribe((newVal, oldVal) => {
        this.handleChange(oldVal, newVal);
      });
    }

    if (this.accessor.mode === 'poll' || this.accessor.mode === 'hybrid') {
      const interval = this.accessor.pollIntervalMs || 5000;
      this.pollTimer = setInterval(() => this.poll(), interval);
      this.poll();  // 立即执行一次
    }
  }

  private async poll(): Promise<void> {
    try {
      const newVal = await this.accessor.read();
      const equals = this.accessor.equals || ((a, b) => a === b);

      if (this.currentValue !== undefined && !equals(this.currentValue, newVal)) {
        this.handleChange(this.currentValue, newVal);
      }
      this.currentValue = newVal;
    } catch (err) {
      logger.error(`[StateWatcher] poll failed: ${this.accessor.key}`, err);
    }
  }

  private handleChange(oldVal: T, newVal: T): void {
    this.currentValue = newVal;
    this.emitChange(oldVal, newVal);
    for (const cb of this.subscribers.values()) {
      cb(oldVal, newVal);
    }
  }

  subscribe(cb: StateChangeCallback): Unsubscribe {
    const id = Math.random().toString(36);
    this.subscribers.set(id, cb);
    return () => this.subscribers.delete(id);
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
```

### 6.3 `TriggerRuntimeScheduler` 扩展

复用现有 `TriggerRuntimeScheduler`，扩展以支持事件触发。MVP 不引入独立 `RuleEngine` 类，事件命中后直接走现有 `startRun()`，这样并发控制、active run、脚本 retry、feedback 和 audit 都保持一致。

```typescript
// src/trigger/scheduler.ts (扩展)
export class TriggerRuntimeScheduler {
  private eventSource?: EventSource;
  private eventSubscriptions = new Map<string, Unsubscribe>();

  constructor(
    private manager: TriggerDefinitionManager,
    // ... 现有依赖
    private eventBus?: EventBus,
  ) {
    if (eventBus) {
      this.eventSource = new EventSource(eventBus, (triggerId, event) => {
        void this.fireEventTrigger(triggerId, event);
      });
    }
  }

  private schedule(definition: TriggerDefinition): void {
    this.clearTimer(definition.id);
    this.unregisterEvent(definition.id);

    if (definition.source.type === 'event') {
      this.registerEvent(definition);
      return;
    }

    // 时间触发器（现有逻辑）
    // ...
  }

  private registerEvent(definition: TriggerDefinition): void {
    if (!this.eventSource) {
      logger.warn(`[Trigger] event source disabled; skip ${definition.id}`);
      return;
    }
    const unsubscribe = this.eventSource.register(definition);
    this.eventSubscriptions.set(definition.id, unsubscribe);
  }

  private unregisterEvent(triggerId: string): void {
    this.eventSubscriptions.get(triggerId)?.();
    this.eventSubscriptions.delete(triggerId);
  }

  private async fireEventTrigger(triggerId: string, event: TriggerSourceEvent): Promise<void> {
    const trigger = this.manager.get(triggerId);
    if (!trigger || !trigger.enabled) return;

    await this.startRun(trigger, {
      firedAt: event.firedAt,
      payload: event.payload,
    });
  }
}
```

`eventName` 应写入 `TriggerSourceRunInfo.eventName` 或从 `payload.type` 读取，不建议混入 `payload.eventName`，避免与原始事件字段冲突。若保持现有 `startRun(definition, payload)` 签名不改，可在 `buildSourceInfo()` 中对 `source.type === "event"` 读取 `(payload?.type ?? event.eventName)`。

生命周期要求：
- `init()` 遍历 enabled trigger 时，event trigger 注册订阅，time trigger 注册 timer。
- `create/update/setEnabled(false)/cancel()` 必须先清理旧 timer 和旧 event subscription。
- `stop()` 必须清理全部 timer、running run 和 event subscription。
- `run(triggerId)` 仍然保留手动触发能力，event trigger 手动运行时 payload 至少包含 `{ eventPattern }`。

阶段 2 的 state trigger 不在 MVP 中实现。等 `StateRegistry` 落地后，`source.type === 'state'` 可在 `schedule()` 中展开为对 `state:<key>:changed` 的 event trigger。

### 6.4 事件上下文注入

MVP 必须同步扩展模板和脚本上下文，否则事件触发只能启动动作，不能消费事件内容。

```typescript
// renderTemplate() 的完整上下文增加 event/source：
const fullCtx = {
  timestamp,
  date,
  time,
  trigger,
  session: trigger.session,
  result,
  error,
  event: sourcePayload,          // 事件触发时为完整 GatewayEvent
  source: {
    type: trigger.source.type,
    payload: sourcePayload,
  },
};
```

落地时需要贯穿两条渲染路径：

| 位置 | 当前行为 | MVP 必须补齐 |
|------|----------|-------------|
| `TriggerRuntimeScheduler.runProcessing()` | template/prompt 只用 `{ trigger, timestamp }` 渲染 | 传入 `sourcePayload`，让 processing 文本可用 `{{event.*}}` |
| `TriggerFeedbackDispatcher.dispatch()` | feedback template 只用 `{ trigger, result, error, timestamp }` 渲染 | 传入同一个 `sourcePayload`，让 feedback template 可用 `{{event.*}}` |
| `TriggerScriptExecutor.execute()` | stdin 已有 `source.payload` | 保持结构，确保 event trigger 的 payload 是完整 `GatewayEvent` |

建议把 `TriggerRunPayload.payload` 重命名或注释为 `sourcePayload`，避免和 channel payload、feedback payload 混淆。

最小侵入接口可以保持字段名不变，但在类型注释中明确语义：

```typescript
interface TriggerRunPayload {
  scheduledAt?: number;
  firedAt: number;
  /** Source payload: time source summary or full GatewayEvent for event triggers. */
  payload?: Record<string, unknown>;
  dryRun?: boolean;
}

interface TriggerFeedbackDispatchInput {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  branch: TriggerFeedbackBranch;
  action: TriggerFeedbackAction;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  sourcePayload?: Record<string, unknown>;
  dryRun?: boolean;
}
```

脚本执行 stdin 已经包含 `source.payload`，MVP 保持这个结构，同时确保 event trigger 的 `source.payload` 是事件对象：

```json
{
  "trigger": { "id": "trig_x", "name": "消息转发", "agentAid": "evolai.agentid.pub" },
  "run": { "id": "run_...", "firedAt": 1780000000000 },
  "source": {
    "type": "event",
    "payload": {
      "type": "message:received",
      "sessionId": "sess_x",
      "channel": "feishu",
      "channelId": "oc_xxx",
      "content": "@evolai hello",
      "userId": "ou_xxx"
    }
  },
  "args": {}
}
```

模板渲染示例：

```text
[来自 {{event.channel}}] {{event.userId}}: {{event.content}}
```

---

## 七、配置示例

### 7.1 事件触发器示例

**示例 1：对端上线通知**

> 该示例依赖后续补充 `channel:peer-online` 事件，非 MVP 验证用例。

```json
{
  "$schema_version": 2,
  "agentAid": "evolai.agentid.pub",
  "name": "对端上线通知",
  "enabled": true,
  "source": {
    "type": "event",
    "eventPattern": "channel:peer-online",
    "filter": {
      "match": {
        "channel": "aun",
        "peerId": "alice.agentid.pub"
      }
    }
  },
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#main",
    "channelId": "oc_xxx",
    "strategy": "latest"
  },
  "processing": {
    "mode": "template",
    "template": "{{event.peerId}} 上线了！"
  },
  "feedback": {
    "mode": "direct-message",
    "target": {
      "channelKey": "feishu#evolai.agentid.pub#main",
      "channelId": "oc_xxx"
    }
  },
  "reliability": {
    "concurrency": "allow",
    "missedPolicy": "skip",
    "scriptRetry": { "maxAttempts": 0, "backoffMs": 0 }
  }
}
```

**示例 2：飞书消息转发到 AUN 群**

```json
{
  "$schema_version": 2,
  "agentAid": "evolai.agentid.pub",
  "name": "飞书消息转发",
  "enabled": true,
  "source": {
    "type": "event",
    "eventPattern": "message:received",
    "filter": {
      "match": {
        "channel": "feishu",
        "content": { "$regex": "^@evolai" }
      }
    }
  },
  "session": {
    "channelKey": "aun#evolai.agentid.pub#main",
    "channelId": "team.group.company.com",
    "strategy": "latest"
  },
  "processing": {
    "mode": "template",
    "template": "[来自 {{event.channel}}] {{event.userId}}: {{event.content}}"
  },
  "feedback": {
    "mode": "direct-message",
    "target": {
      "channelKey": "aun#evolai.agentid.pub#main",
      "channelId": "team.group.company.com"
    }
  },
  "reliability": {
    "concurrency": "allow",
    "missedPolicy": "skip",
    "scriptRetry": { "maxAttempts": 0, "backoffMs": 0 }
  }
}
```

**示例 3：MVP 本地验证用 direct-message**

该示例只依赖现有 `message:received` 事件。实际 target 需要替换为当前 agent 已配置的 channel key 和 channelId。

```json
{
  "$schema_version": 2,
  "agentAid": "evolai.agentid.pub",
  "name": "MVP消息回显",
  "enabled": true,
  "source": {
    "type": "event",
    "eventPattern": "message:received",
    "filter": {
      "match": {
        "channel": "feishu",
        "content": { "$regex": "^/echo" }
      }
    }
  },
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#main",
    "channelId": "oc_xxx",
    "strategy": "latest"
  },
  "processing": {
    "mode": "template",
    "template": "echo: {{event.content}}"
  },
  "feedback": {
    "mode": "direct-message"
  },
  "reliability": {
    "concurrency": "allow",
    "missedPolicy": "skip",
    "scriptRetry": { "maxAttempts": 0, "backoffMs": 0 }
  }
}
```

### 7.2 状态触发器示例

> 以下示例属于阶段 2，MVP 中 `source.type === "state"` 仍应在解析阶段报错。

**示例 1：会话消息数超阈值提醒**

```json
{
  "$schema_version": 2,
  "agentAid": "evolai.agentid.pub",
  "name": "会话超 100 轮提醒",
  "enabled": true,
  "source": {
    "type": "state",
    "stateKey": "session.*.messageCount",
    "condition": {
      "operator": "crossed",
      "threshold": 100,
      "direction": "up"
    }
  },
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#main",
    "channelId": "oc_xxx",
    "strategy": "thread",
    "thread": { "mode": "reuse", "threadId": "trigger:session-message-count" }
  },
  "processing": {
    "mode": "prompt",
    "prompt": "当前会话已超过 100 轮（{{event.newValue}} 条消息），是否需要压缩历史？"
  },
  "feedback": {
    "mode": "agent-session"
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "skip",
    "scriptRetry": { "maxAttempts": 0, "backoffMs": 0 }
  }
}
```

**示例 2：对端长时间未联系提醒**

```json
{
  "$schema_version": 2,
  "agentAid": "evolai.agentid.pub",
  "name": "对端 7 天未联系提醒",
  "enabled": true,
  "source": {
    "type": "state",
    "stateKey": "peer.*.lastSeenAt",
    "condition": {
      "operator": "stable",
      "durationMs": 604800000
    }
  },
  "session": {
    "channelKey": "feishu#evolai.agentid.pub#main",
    "channelId": "oc_xxx",
    "strategy": "latest"
  },
  "processing": {
    "mode": "script",
    "script": {
      "path": "scripts/check-peer-inactive.js",
      "runtime": "node",
      "timeoutMs": 10000
    }
  },
  "feedback": {
    "onSuccess": {
      "mode": "direct-message",
      "target": {
        "channelKey": "feishu#evolai.agentid.pub#main",
        "channelId": "oc_xxx"
      },
      "template": "{{event.stateKey}} 已 7 天未联系"
    },
    "onNoop": { "mode": "none" },
    "onFailure": { "mode": "none" }
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "skip",
    "scriptRetry": { "maxAttempts": 0, "backoffMs": 0 }
  }
}
```

### 7.3 语法糖：State 简写（可选）

**完整写法**（基于事件）：
```json
{
  "source": {
    "type": "event",
    "eventPattern": "state:session.*.messageCount:changed",
    "filter": {
      "match": { "newValue": { "$gt": 100 } }
    }
  }
}
```

**简写语法糖**（解析时展开）：
```json
{
  "source": {
    "type": "state",
    "stateKey": "session.*.messageCount",
    "condition": { "operator": "gt", "value": 100 }
  }
}
```

---

## 八、实现路线图

### 阶段 1：MVP（事件源基础）

**目标**：支持 EventBus 原生事件触发

**交付物**：
1. 扩展 `TriggerSource` 类型，加入 `EventSource` 类型定义
2. 扩展 `normalizeSource()` 校验 `source.type === 'event'`，并校验 `eventPattern`、`filter.match`
3. 实现 `EventSource` 类（通过 `EventBus.subscribeAll()` 订阅，内部做 pattern + filter 匹配）
4. 扩展 `TriggerRuntimeScheduler.schedule()` 支持 event 类型，维护 `eventSubscriptions`
5. 扩展 `startRun()` 的 source payload 传递和模板上下文，让 `{{event.*}}` 可用
6. 对齐并验证现有核心事件：
   - `message:received`
   - `message:sent-out`
   - `task:completed`
   - `session:created`
   - `session:switched`
   - `channel:connected`
7. CLI 第一阶段先支持 `--file` 创建完整 JSON；`create --event <pattern> --filter <json>` 作为 MVP+，不阻塞核心验收
8. 实际验证场景：飞书 `message:received` → 触发 direct-message/template 或 agent-session

**文件清单**：
- `src/trigger/types.ts` — 扩展类型
- `src/trigger/sources/event-source.ts` — EventSource 实现（新增）
- `src/trigger/scheduler.ts` — 扩展 event 注册/注销和 fire 入口
- `src/trigger/validation.ts` — 扩展 source 校验和模板上下文
- `src/trigger/feedback.ts` — feedback 模板渲染透传 source payload
- `src/core/event-bus.ts` — 可选：增加返回 unsubscribe 的订阅辅助；否则 EventSource 自行封装
- `src/cli/trigger-command.ts` — MVP+：flag 模式支持 event/filter

**验收标准**：
- ✅ 创建一个监听 `message:received` 的 trigger
- ✅ 发送消息后，trigger 自动触发
- ✅ filter 规则生效（`channel`/`channelId`/`content`/`userId` 过滤）
- ✅ 模板能渲染 `{{event.channel}}`、`{{event.content}}`
- ✅ 脚本 stdin 能收到 `source.type === "event"` 和完整 `source.payload`
- ✅ update/disable/cancel 后旧订阅不再触发，stop 后没有残留订阅
- ✅ 多 agent scheduler 共享 EventBus 时，不会触发未启用或非本 agent 的 trigger
- ✅ 日志可见：事件 publish → filter 匹配 → trigger fired

**测试建议**：
- `tests/unit/trigger-event-source.test.ts`：pattern、filter、unsubscribe、错误隔离。
- `tests/integration/trigger-v2.test.ts` 增补事件触发场景：publish `message:received` 后触发 direct-message。
- `tests/unit/trigger-manager.test.ts` 增补 `normalizeTriggerDefinition()` 对 event source 的校验。

**建议实现顺序**：
1. `src/trigger/types.ts`：加入 `EventTriggerSource`、`EventFilter`、`MatchValue`、`TriggerSourceEvent`，并扩展 `TriggerSourceRunInfo.type`。
2. `src/trigger/validation.ts`：让 `normalizeSource()` 接受 `event`，实现 `eventPattern` 和 `filter.match` 的结构校验；扩展 `renderTemplate()` ctx，加入 `event` 和 `source`。
3. `src/trigger/sources/event-source.ts`：新增纯逻辑类，只依赖 `EventBus` 和 fire callback；先覆盖 pattern/filter/unsubscribe 单元测试。
4. `src/trigger/scheduler.ts`：构造函数可选注入 `EventBus`，`schedule()` 中分流 event/time，`stop/update/disable/cancel` 清理订阅；`runProcessing()` 把 `sourcePayload` 传入模板渲染。
5. `src/trigger/feedback.ts`：`TriggerFeedbackDispatchInput` 增加 `sourcePayload`，dispatch 渲染 feedback template 时透传。
6. `src/index.ts`：创建 `TriggerRuntimeScheduler` 时传入进程级 `eventBus`。
7. 测试通过后，再考虑 `src/cli/trigger-command.ts` 的 `--event/--filter` flag 语法糖。

**关联代码面检查清单**：
- `src/cli/trigger-command.ts` 的 `sourceLabel()` 需要支持 `event`，例如 `event message:received`。
- `src/core/command/command-handler.ts` 的 `scheduleViewFromSource()` 需要支持 `event`；对 event trigger 可返回 `{ scheduleType: 'event', scheduleValue: eventPattern }`。
- `nextFireAtForDefinition()` 对 event trigger 应返回 `undefined`，UI 文案应显示“事件触发”或“无固定时间”，不要显示“未计算”造成误导。
- `TriggerRuntimeScheduler.sourcePayload()` 需要支持 `event` 的手动 `run()` 场景，至少返回 `{ eventPattern }`。
- `buildSourceInfo()` 对 `source.type === "event"` 应填充 `eventName`，优先从 `payload.type` 读取，其次从运行时 `TriggerSourceEvent.eventName` 读取。
- `recoverOpenRuns()` 里用 `sourcePayload(definition.source)` 构造重启审计，必须支持 event source，否则 daemon 重启恢复会抛错。
- `validateTriggerFeedbackChannels()` 仍应校验 `session.channelKey` 和 feedback target；event source 不改变动作侧权限和路由约束。
- `list/show`、菜单卡片、trigger 详情中不要假设所有 trigger 都有 `nextFireAt`。

**MVP 非目标**：
- 不发布新的业务事件，只消费现有 `EventBus` 已有事件。
- 不支持 state trigger；`source.type === "state"` 仍然报错。
- 不支持任意 glob、JSONPath、`where`、`$not`、throttle/debounce、payloadPick。
- 不实现事件重放、停机期间补偿、跨进程事件同步。
- 不保证捕获 scheduler 启动前已经 publish 的事件；例如 daemon 启动早期的 `channel:connected` 可能先于 trigger scheduler 初始化。

**递归与回路约束**：
- MVP 不建议新增 `trigger:fired` 事件；如果后续加入，必须默认禁止 trigger 监听自身产生的 `trigger:*`，或在 payload 中带 `originTriggerId` 并自动过滤。
- direct-message 或 agent-session 的反馈可能间接产生 `message:*`/`task:*` 事件。用于转发的 trigger 应优先用 `filter.match` 限定 `channel`、`channelId`、`userId` 或 `agentName`，避免 A → B → A 的消息回路。
- 审计写入不应再次 publish 可触发业务动作的事件；可观测日志和 trigger fire 是两条路径。

**MVP 风险与处理**：

| 风险 | 处理 |
|------|------|
| 同一 trigger update 后旧订阅未清理，导致一次事件触发多次 | `schedule()` 入口统一 `clearTimer()` + `unregisterEvent()`；测试覆盖 update/disable/stop |
| feedback 模板拿不到事件内容 | `sourcePayload` 必须从 `startRun()` 贯穿到 `runProcessing()` 和 `TriggerFeedbackDispatcher.dispatch()` |
| EventBus handler 抛错影响其它订阅 | 继续依赖 `EventBus.publish()` 的 handler 隔离；`EventSource` 内部匹配错误也要 catch/log，不让单个 trigger 破坏事件分发 |
| event trigger 没有 `nextFireAt` 导致 UI/菜单异常 | 所有视图层用 source.type 分支处理 event，文案显示事件模式 |
| 多 agent 共享 EventBus 造成误触发 | 每个 scheduler 只注册本 agent 的定义；用户配置通过 filter 进一步限定 channel/channelId/userId |
| 事件载荷字段后续演进破坏旧 trigger | 事件目录保持兼容字段；新增字段优先 additive，不重命名现有字段 |
| 启动顺序导致 `channel:connected` 被错过 | MVP 验收不依赖启动期连接事件；若要可靠处理连接状态，阶段 2 用 `channel.<channel>.connected` 状态或调整启动顺序 |

### 阶段 2：状态观察

**目标**：支持状态变化触发

**交付物**：
1. 实现 `StateRegistry` + `StateAccessor` + `StateWatcher`
2. 状态变化自动 publish 到 EventBus（`state:*:changed`）
3. 预定义 3-5 个常用状态：
   - `session.<id>.messageCount`（push 模式）
   - `session.<id>.idleMinutes`（poll 模式）
   - `peer.<key>.lastSeenAt`（poll 模式）
4. SessionManager/PeerManager 注册对应状态访问器
5. 状态持久化到 `$AGENT_DIR/state/`（peer/custom 命名空间）
6. CLI 支持：`evolclaw trigger create --state <key> --condition <json>`

**文件清单**：
- `src/trigger/sources/state-registry.ts` — StateRegistry 实现（新增）
- `src/core/session/session-manager.ts` — 注册 session.* 状态
- `src/core/relation/peer-manager.ts` — 注册 peer.* 状态（如不存在则新建）
- `src/paths.ts` — 加入 `agentStateDir(aid)` 路径

**验收标准**：
- ✅ 创建一个监听 `session.*.messageCount` 的 trigger
- ✅ 发送消息后，messageCount 变化 → 状态事件 publish → trigger 触发
- ✅ 状态持久化（peer/custom 命名空间重启后恢复）
- ✅ 多个 trigger 监听同一状态，只运行 1 个 watcher

### 阶段 3：高级特性（可选）

**目标**：节流/防抖、表达式过滤、自定义状态

**交付物**：
1. EventSource 支持 `throttle` 配置（leading/trailing/debounce）
2. 引入安全表达式引擎（JSONLogic）用于 `filter.where`
3. CLI 支持用户自定义状态：`evolclaw state set/get <key> <value>`
4. 状态条件完善：`crossed`/`stable`/`transition` 操作符
5. 事件目录文档化：`$KITS_DOCS/triggers/event-catalog.md`

**交付时间**：根据用户反馈决定优先级

---

## 九、关键设计取舍总结

| 问题 | 方案 | 理由 |
|------|------|------|
| **Event vs State 实现关系** | State → Event 转换（方案 B） | 统一事件处理路径，调试友好，代码复用 |
| **状态监听方式** | StateRegistry + StateAccessor（push/poll/hybrid） | 统一抽象，可演进，多消费者共享 watcher |
| **过滤器安全性** | 第一期只支持 `match`（结构化），暂不开放 `where` | 避免 eval 安全问题，后续按需引入 JSONLogic |
| **状态命名空间** | `session.*` / `peer.*` / `agent.*` / `channel.*` / `custom.*` | 清晰分层，按模块注册访问器 |
| **状态持久化** | session/agent/channel 内存，peer/custom 久化 | 按状态生命周期区分 |
| **事件白名单** | 文档维护 `event-catalog.md` | 用户可发现，避免猜测事件名 |
| **语法糖 vs 完整配置** | 提供 `type: state` 语法糖，底层展开成 event | 用户友好，底层统一 |

---

## 十、兼容性与向后兼容

### 10.1 现有 Trigger 不受影响

- 时间触发器（delay/at/cron/interval）完全不变
- 现有 trigger.json 配置无需修改
- `TriggerRuntimeScheduler` 的时间调度逻辑保持不变；event trigger 只增加额外订阅路径

### 10.2 渐进式加载

- 第一期：只加 EventSource，StateRegistry 暂未实现 → state 类型的 trigger 解析报错
- 第二期：加 StateRegistry 后，state 类型自动生效
- event trigger 不补偿 daemon 停止期间错过的事件；`missedPolicy` 对 event trigger 无实际补发语义，建议固定视为 `skip`
- `delay/at` 一次性触发后会自动 disable；event trigger 是持续订阅，不会因一次触发自动 disable
- `trigger run <id>` 对 event trigger 表示手动执行动作链，不表示向 EventBus 注入真实事件；如需模拟事件，应另设测试 helper 或 debug 命令

### 10.3 错误处理

- `eventPattern` 语法错误 → trigger 创建时报错
- 当前进程未发布某个合法事件名 → trigger 可创建，但运行时不会触发
- 未知状态键 → trigger 创建时报错（StateRegistry.subscribe 抛异常）
- 过滤器语法错误 → trigger 创建时校验并报错

### 10.4 权限与安全

- event trigger 只是新增触发源，不降低 trigger 创建/更新权限；仍沿用现有 owner/admin 级别的 trigger 管理入口。
- 能执行 script 的 trigger 风险不变：事件源可能由普通消息触发，但脚本内容和反馈目标必须由有权限的人配置。
- `filter.match` 不执行用户代码；MVP 禁止 `where`，避免引入表达式执行面。
- 正则过滤可能被高频消息触发，需限制 regex 字符串长度，并在创建时编译校验；如出现性能问题，后续增加 per-trigger throttle。

---

## 十一、监控与可观测性

### 11.1 日志输出

```
[EventBus] publish message:received { channel: 'feishu', channelId: 'oc_xxx', content: '...', userId: 'ou_xxx' }
[EventSource] trigger-123 matched event: message:received
[TriggerRuntimeScheduler] trigger-123 fired (source: event, concurrency: allow)
[TriggerExecutor] trigger-123 running script: scripts/forward.js
[TriggerExecutor] trigger-123 completed: success

[StateRegistry] state changed: session.abc.messageCount 5 → 6
[EventBus] publish state:session.abc.messageCount:changed { oldValue: 5, newValue: 6 }
[EventSource] trigger-456 matched event: state:session.abc.messageCount:changed
```

### 11.2 审计记录

复用现有 `TriggerAuditRecord`，扩展 `source` 字段：

```typescript
interface TriggerAuditRecord {
  // ... 现有字段
  source: TriggerSourceRunInfo;
}

interface TriggerSourceRunInfo {
  type: 'delay' | 'at' | 'cron' | 'interval' | 'event' | 'state';

  // 事件触发专有
  eventName?: string;

  // 状态触发专有
  stateKey?: string;
  oldValue?: unknown;
  newValue?: unknown;

  // 时间触发（现有）
  scheduledAt?: number;
  firedAt: number;
  // event trigger: 完整 GatewayEvent payload；time trigger: 时间源配置摘要
  payload: Record<string, unknown>;
}
```

### 11.3 运行时展示

`trigger show/list` 和菜单视图建议展示 event trigger 的订阅状态：

| 字段 | 含义 |
|------|------|
| `source.type` | `event` |
| `source.eventPattern` | 监听的事件 pattern |
| `subscription` | `active` / `inactive` / `event-bus-unavailable` |
| `nextFireAt` | event trigger 始终为空 |
| `lastFiredAt` | 从 audit stats 汇总 |

如果 trigger enabled 但 event subscription 未注册，应在 show 中暴露 warning，便于排查 scheduler 未初始化或 eventBus 未注入。

### 11.4 调试工具

```bash
# 查看当前注册的状态
evolclaw trigger state list

# 手动触发状态变化（测试用）
evolclaw trigger state set session.test.messageCount 100

# 实时查看事件流
evolclaw trigger debug --events

# 实时查看状态变化
evolclaw trigger debug --states
```

---

## 十二、文档清单

实现完成后需补充以下文档：

1. **用户手册**：
   - `docs/triggers/event-triggers.md` — 事件触发器使用指南
   - `docs/triggers/state-triggers.md` — 状态触发器使用指南
   - `docs/triggers/event-catalog.md` — 事件目录（白名单）
   - `docs/triggers/filter-syntax.md` — 过滤器语法参考

2. **开发文档**：
   - `docs/triggers/architecture.md` — 本文档（架构设计）
   - `docs/triggers/state-accessor-guide.md` — 如何注册自定义状态访问器
   - `docs/triggers/event-injection-guide.md` — 如何在代码中 publish 新事件

3. **示例库**：
   - `examples/triggers/` 目录，包含 10+ 典型场景配置示例

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| **TriggerSource** | 触发源类型（time/event/state） |
| **EventSource** | 事件源管理器，订阅 EventBus 并触发 trigger |
| **StateRegistry** | 状态注册表，管理所有状态访问器 |
| **StateAccessor** | 状态访问器，定义如何读取/监听某个状态 |
| **StateWatcher** | 状态观察器，实际执行 push/poll 逻辑 |
| **合成事件** | 由 StateRegistry 自动生成的 `state:*` 事件 |
| **EventFilter** | 事件过滤器，包含 match（结构化）和 where（表达式） |
| **StateCondition** | 状态触发条件（changed/eq/gt/crossed 等） |
| **TriggerRuntimeScheduler fire 入口** | 现有 trigger 调度器中的触发入口，统一处理 startRun、并发控制、审计与反馈 |

---

**文档版本**：v1.0
**最后更新**：2026-06-23
**作者**：evolai.agentid.pub + 轮子（ou_2114acae0d376b26dfbc14bbca5b1f7e）
