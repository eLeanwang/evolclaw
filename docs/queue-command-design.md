# 消息队列查询功能设计方案

## 一、需求概述

设计一个跨层级的消息队列查询与操作功能，支持通过 CLI 和 CTL 两种入口查看、管理 Agent 的消息队列。

**核心诉求**：
- **ctl**：查询当前 session 的队列（托管环境内）
- **cli**：查询指定 agent 的所有队列（运维视角）
- **操作支持**：查看、清空、取消指定消息、打断处理中任务

---

## 二、架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                         入口层                               │
├──────────────────────────────┬──────────────────────────────┤
│  ctl (托管环境)               │  cli (运维工具)               │
│  evolclaw ctl queue          │  evolclaw queue --agent <aid>│
└──────────────┬───────────────┴────────────────┬─────────────┘
               │                                 │
               │  IPC (Unix Socket)              │
               │                                 │
┌──────────────▼───────────────┬────────────────▼─────────────┐
│  command-handler.ts          │  ipc.ts                       │
│  handleQueueCommand()        │  queue-snapshot handler       │
└──────────────┬───────────────┴────────────────┬─────────────┘
               │                                 │
               │         MessageQueue            │
               │                                 │
┌──────────────▼─────────────────────────────────▼─────────────┐
│  message-queue.ts                                             │
│  - getQueueItemsBySession(sessionId)  ← ctl 用               │
│  - getQueueItemsByAgent(agentName)     ← cli 用               │
│  - cancelMessageByIdInSession()                               │
│  - cancelMessageById()                                        │
│  - clearBySession()                                           │
│  - clearByAgent()                                             │
│  - interruptBySession()                                       │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 入口层设计

#### ctl 入口（托管环境）

**路径**：`evolclaw ctl queue` → IPC `ctl` → `command-handler.ts` 特殊分支

**特点**：
- 依赖 `EVOLCLAW_SESSION_ID` 环境变量（自动限定到当前 session）
- 参数使用 `sessionId`（格式 `meta_YYYYMMDD_TS`），通过 `handleCtl` 的现有流程传入 `handleQueueCommand`
- `MessageQueue` 内部通过 `matchesSession`（`key.startsWith(sessionId + '::')`）定位队列项
- 仅显示 pending 队列（等待中的消息）
- 不显示 session 标识列（因为只有一个 session）

#### cli 入口（运维工具）

**路径**：`evolclaw queue --agent <aid>` → IPC `queue-snapshot` → 直接查询 MessageQueue

**特点**：
- 必须指定 `--agent <aid>`
- 显示该 agent 所有 session 的队列（active + pending）
- 显示 sessionKey 列（区分不同会话）

---

## 三、数据层设计

### 3.1 核心数据结构

```typescript
// message-queue.ts
export interface QueueItemSnapshot {
  status: 'active' | 'pending';
  sessionKey: string;       // 格式：channelType#urlEncode(channelId)#urlEncode(threadId)
  channelType: string;      // 从 sessionKey 解析
  channelId: string;        // 从 sessionKey 解析（解码后，人类可读）
  projectPath: string;      // 从 queueKey 解析（格式：sessionId::projectPath）
  peerName?: string;        // 发送者名称
  preview: string;          // 消息内容（默认 80 字符截断，--full 显示完整）
  messageId?: string;       // 消息 ID
  elapsedMs?: number;       // 处理时长（仅 active 有值）
}
```

**说明**：
- 不保留 `rawCount` 字段：出队合并已取消，`queue.length` 直接等于原始消息数
- `elapsedMs` 通过新增 `processingStartTime` Map（queueKey → Date.now()）追踪，不依赖 StreamIdleMonitor（后者跟踪的是空闲时长而非运行总时长）。若 `processingStartTime` 中无记录（异常路径），`elapsedMs` 设为 `undefined`
- `sessionKey` 从 `session.sessionKey` 字段获取（存储于 Session 对象中，格式为 `channelType#urlEncode(channelId)#urlEncode(threadId)`）
- `channelType` 和 `channelId` 由 `parseSessionKey` 从 sessionKey 解析：按 `#` 分割，`channelId` 需 `decodeURIComponent` 解码

### 3.2 MessageQueue 新增方法

#### 查询方法

```typescript
/**
 * 通过 human-readable sessionKey 反查 sessionId（cli interrupt 用）
 * @param sessionKey - 格式：channelType#urlEncode(channelId)#urlEncode(threadId)
 * @returns sessionId（meta_YYYYMMDD_TS）或 undefined
 */
findSessionIdBySessionKey(sessionKey: string): string | undefined

/**
 * 按 sessionId 查询队列（ctl 用）
 * @param sessionId - 即 EVOLCLAW_SESSION_ID，Session.id
 * @returns 仅返回 pending 状态的消息
 */
getQueueItemsBySession(sessionId: string): QueueItemSnapshot[]

/**
 * 按 agent 查询队列（cli 用）
 * @param agentName - agent 内部名称（从 aid 解析）
 * @returns 返回所有状态（active + pending）的消息
 */
getQueueItemsByAgent(agentName: string): QueueItemSnapshot[]
```

**实现要点**：
- 遍历 `this.queues` Map（pending 消息）和 `this.activeBatches` Map（processing 消息）
- session 作用域筛选：复用现有 `matchesSession(key, sessionId)`，判断 `key.startsWith(sessionId + '::')`
- agent 作用域筛选：按 `QueuedMessage.agentName` 匹配
- 解析 sessionKey：从 `queueKeyToSessionKey` Map 获取（enqueue 时写入），fallback 到 `sessionKeyFromQueueKey()`（从 queueKey 提取 sessionId 部分）
- `elapsedMs`：active 项从 `processingStartTime` 计算，pending 项为 `undefined`

**sessionKey 来源**：queueKey 格式为 `sessionId::projectPath`，其中 sessionId 对应 `Session.id`。要拿到 human-readable 的 sessionKey（`feishu#oc_xxx#main`），在 `enqueue()` 时通过新增的可选参数 `sessionKeyField` 写入 `queueKeyToSessionKey` Map。调用方（`message-bridge.ts`、`index.ts` 的 trigger/resume 路径）传入 `session.sessionKey`。

#### 新增字段：processingStartTime + queueKeyToSessionKey

```typescript
/** queueKey → 处理开始时间戳，仅在 activeBatches 有对应项时存在 */
private processingStartTime = new Map<string, number>();

/** queueKey → sessionKey（human-readable 格式），在 enqueue 时写入 */
private queueKeyToSessionKey = new Map<string, string>();
```

**processingStartTime 生命周期**：
- `processNext()` 中 `activeBatches.set(queueKey, activeItem)` 后写入 `processingStartTime.set(queueKey, Date.now())`
- `processNext()` finally 块中 `activeBatches.delete(queueKey)` 后清除 `processingStartTime.delete(queueKey)`
- `cancelActive()` 中当 `remaining.length === 0`（全部撤回）时也需同步 `processingStartTime.delete(queueKey)`

**queueKeyToSessionKey 写入时机**：
- `enqueue()` 方法接收新增可选参数 `sessionKeyField?: string`，在 `getQueueKey()` 后写入 Map
- 调用方（`message-bridge.ts`、`index.ts` trigger/resume 路径）传入 `session.sessionKey`

#### enqueue 签名变更

```typescript
async enqueue(
  sessionKey: string,
  message: Message,
  projectPath: string,
  options?: {
    interruptible?: boolean;
    interruptSamePeer?: boolean;
    agentName?: string;
    role?: SessionIdentity['role'];
    sessionKeyField?: string;   // 新增：human-readable sessionKey
  }
): Promise<void>
```

#### 操作方法

```typescript
/**
 * 按 sessionId 清空待处理消息（ctl 用）
 * @returns 被清除的消息数量
 */
clearBySession(sessionId: string): number

/**
 * 按 agent 清空待处理消息（cli 用）
 * @returns 被清除的消息数量
 */
clearByAgent(agentName: string): number  // 已存在，复用

/**
 * 按 messageId 取消消息（sessionId 作用域，ctl 用）
 * @returns 是否成功
 */
cancelMessageByIdInSession(sessionId: string, messageId: string): boolean

/**
 * 按 messageId 取消消息（agent 作用域，cli 用）
 * @returns 是否成功
 */
cancelMessageById(agentName: string, messageId: string): boolean

/**
 * 打断 session 的处理中任务（ctl 用）
 * 一个 session 只可能有一个 queueKey（sessionId + 一个 projectPath），无需遍历多个。
 * @returns 是否有任务被打断
 */
interruptBySession(sessionId: string): Promise<boolean>
```

**实现逻辑**：
- **clearBySession**：遍历 queues，用 `matchesSession` 匹配，while 循环 shift 移除 pending 消息，调用 `resolve()` 解除阻塞，触发 `persistQueuesImmediate()`
- **cancelMessageByIdInSession**：遍历 queues，用 `matchesSession` 限定 sessionId 作用域，找到 messageId 匹配项后复用已有的 parts/splice/resolve 逻辑
- **cancelMessageById**：同 `cancel` 逻辑，但按 agentName 过滤
- **interruptBySession**：遍历 `this.processing` **Set**（⚠ 注意：`processing` 是 `Set<string>`，不是 `Map`，遍历时用 `for (const queueKey of this.processing)` 而非 `for (const [queueKey] of ...)` 解构），用 `matchesSession` 找到匹配的 queueKey → 从 `processingAgent` 获取 agentName → 发布 `task:interrupted` 事件 → 调用 `interruptCallback`

---

## 四、IPC 层设计

### 4.1 ctl 路由（command-handler.ts）

在 `handleCtl` 方法中新增 `/queue` 特殊分支（类似现有的 `/agent`、`/send` 处理方式）：

```typescript
// src/core/command/command-handler.ts — handleCtl() 内
// 3.2 /queue: 消息队列查询与操作（不走 handle()，直接操作 MessageQueue）
if (cmd === '/queue' || cmd.startsWith('/queue ')) {
  const args = cmd.slice('/queue'.length).trim();
  return await this.handleQueueCommand(sessionId, args);
}
```

**新增方法**：
```typescript
private async handleQueueCommand(sessionId: string, args: string): Promise<IpcCtlResponse> {
  const showId = args.includes('--showid');
  const formatJson = args.includes('--format json');
  const full = args.includes('--full');

  // 操作分支
  if (args.includes('--clear')) {
    const count = this.messageQueue.clearBySession(sessionId);
    return { ok: true, result: `✅ 已清空 ${count} 条待处理消息` };
  }

  if (args.includes('--cancel')) {
    const msgId = extractArg(args, '--cancel');
    const success = this.messageQueue.cancelMessageByIdInSession(sessionId, msgId);
    return success
      ? { ok: true, result: `✅ 已取消消息 ${msgId}` }
      : { ok: false, error: `❌ 未找到消息 ${msgId}` };
  }

  if (args.includes('--interrupt')) {
    const interrupted = await this.messageQueue.interruptBySession(sessionId);
    return interrupted
      ? { ok: true, result: `✅ 已打断处理中任务` }
      : { ok: false, error: `❌ 当前无处理中任务` };
  }

  // 查询
  const items = this.messageQueue.getQueueItemsBySession(sessionId);
  if (formatJson) {
    return { ok: true, result: JSON.stringify({ items }, null, 2) };
  }
  return { ok: true, result: renderQueueItemsCtl(items, showId, full) };
}
```

### 4.2 cli 路由（ipc.ts）

**统一使用 `queue-snapshot` IPC 类型处理查询和操作**（方案 A）：

```typescript
// src/ipc.ts
case 'queue-snapshot': {
  if (!this.queueSnapshotProvider) return { ok: false, error: 'not configured' };
  if (!cmd.agent) return { ok: false, error: 'missing agent' };
  if (!cmd.action) {
    // 纯查询
    return { ok: true, items: this.queueSnapshotProvider({ agent: cmd.agent }) };
  }
  // 操作：clear / cancel / interrupt
  if (!this.queueActionExecutor) return { ok: false, error: 'queue actions not configured' };
  return await this.queueActionExecutor({
    agent: cmd.agent,
    action: cmd.action,            // 'clear' | 'cancel' | 'interrupt'
    messageId: cmd.messageId,
    sessionKey: cmd.sessionKey,
  });
}
```

**在 index.ts 注入 provider 和 executor**：
```typescript
// 查询 provider
ipcServer.setQueueSnapshotProvider((params: { agent: string }) => {
  const handle = agentRegistry.get(params.agent);
  const agentName = handle?.name;
  if (!agentName) return [];
  return messageQueue.getQueueItemsByAgent(agentName);
});

// 操作 executor
ipcServer.setQueueActionExecutor(async (params) => {
  const handle = agentRegistry.get(params.agent);
  const agentName = handle?.name;
  if (!agentName) return { ok: false, error: `agent not found: ${params.agent}` };

  switch (params.action) {
    case 'clear':
      return { ok: true, cleared: messageQueue.clearByAgent(agentName) };
    case 'cancel':
      if (!params.messageId) return { ok: false, error: 'missing messageId' };
      return { ok: true, cancelled: messageQueue.cancelMessageById(agentName, params.messageId) };
    case 'interrupt':
      if (!params.sessionKey) return { ok: false, error: 'missing sessionKey' };
      // sessionKey 是 human-readable 格式（feishu#oc_xxx#main），先反查 sessionId
      {
        const sessionId = messageQueue.findSessionIdBySessionKey(params.sessionKey);
        if (!sessionId) return { ok: false, error: `session not found: ${params.sessionKey}` };
        return { ok: true, interrupted: await messageQueue.interruptBySession(sessionId) };
      }
    default:
      return { ok: false, error: `unknown action: ${params.action}` };
  }
});
```

---

## 五、输出格式设计

### 5.1 ctl 输出（人类可读）

#### 默认（不显示 messageId）

```
当前会话队列 (2 条待处理)

  [张三]  "再看看那个配置文件"
  [李四]  "/status"
```

#### 带 `--showid`

```
当前会话队列 (2 条待处理)

  msg_d4e5f6  [张三]  "再看看那个配置文件"
  msg_g7h8i9  [李四]  "/status"
```

#### 空队列

```
当前会话队列 (0 条待处理)

(无待处理消息)
```

**列对齐规则**：
- messageId 列宽（`--showid` 时）：最长 messageId 长度 + 2
- 发送者列宽：`[最长名称]` 长度 + 2
- 内容列：剩余空间，默认截断 80 字符（`--full` 不截断）

---

### 5.2 cli 输出（人类可读）

#### 默认（不显示 messageId）

```
mybot.agentid.pub — 队列 (5 条)

  [active]   aun#alice.pub      [张三]  12s  "帮我分析这个 bug，顺便看看..."
  [pending]  aun#alice.pub      [张三]   —   "再看看那个配置文件"
  [pending]  aun#alice.pub      [李四]   —   "/status"
  [pending]  aun#group-xyz      [王五]   —   "帮我优化一下这段代码"
  [pending]  feishu#oc_abc123   [赵六]   —   "这个接口怎么调用？"
```

#### 带 `--showid`

```
mybot.agentid.pub — 队列 (5 条)

  [active]   aun#alice.pub      msg_a1b2c3  [张三]  12s  "帮我分析这个 bug，顺便看看..."
  [pending]  aun#alice.pub      msg_d4e5f6  [张三]   —   "再看看那个配置文件"
  [pending]  aun#alice.pub      msg_g7h8i9  [李四]   —   "/status"
  [pending]  aun#group-xyz      msg_j1k2l3  [王五]   —   "帮我优化一下这段代码"
  [pending]  feishu#oc_abc123   msg_m4n5o6  [赵六]   —   "这个接口怎么调用？"
```

**列对齐规则**：
- 状态列：`[active]` 或 `[pending]`，固定 10 字符
- sessionKey 列：最长 sessionKey 长度 + 2
- messageId 列（可选）：最长 messageId 长度 + 2
- 发送者列：`[最长名称]` 长度 + 2
- 时长列：固定 5 字符（`12s`、`—`）
- 内容列：剩余空间，默认截断 80 字符

---

### 5.3 JSON 输出（cli 和 ctl 一致）

```json
{
  "items": [
    {
      "status": "active",
      "sessionKey": "aun#alice.agentid.pub#main",
      "channelType": "aun",
      "channelId": "alice.agentid.pub",
      "projectPath": "/projects/foo",
      "peerName": "张三",
      "elapsedMs": 12000,
      "preview": "帮我分析这个 bug，顺便看看...",
      "messageId": "msg_a1b2c3"
    },
    {
      "status": "pending",
      "sessionKey": "aun#alice.agentid.pub#main",
      "channelType": "aun",
      "channelId": "alice.agentid.pub",
      "projectPath": "/projects/foo",
      "peerName": "张三",
      "preview": "再看看那个配置文件",
      "messageId": "msg_d4e5f6"
    }
  ]
}
```

**特点**：
- 永远包含完整字段（包括 messageId）
- 不受 `--showid` 影响
- 适合脚本解析

---

## 六、命令参考

### 6.1 ctl 命令集

```bash
# 查看当前 session 队列
evolclaw ctl queue

# 显示 messageId
evolclaw ctl queue --showid

# 显示完整内容（不截断）
evolclaw ctl queue --full

# JSON 输出
evolclaw ctl queue --format json

# 清空待处理队列
evolclaw ctl queue --clear

# 取消指定消息
evolclaw ctl queue --cancel <messageId>

# 打断处理中任务
evolclaw ctl queue --interrupt
```

**环境要求**：
- 必须在托管环境中运行（`EVOLCLAW_SESSION_ID` 已设置）
- 如果环境变量缺失，报错：`❌ EVOLCLAW_SESSION_ID 未设置，ctl queue 仅在托管环境可用`

---

### 6.2 cli 命令集

```bash
# 查看指定 agent 的队列
evolclaw queue --agent <aid>

# 显示 messageId
evolclaw queue --agent <aid> --showid

# 显示完整内容（不截断）
evolclaw queue --agent <aid> --full

# JSON 输出
evolclaw queue --agent <aid> --format json

# 清空所有待处理队列
evolclaw queue --agent <aid> --clear

# 取消指定消息
evolclaw queue --agent <aid> --cancel <messageId>

# 打断指定 session 的处理中任务
evolclaw queue --agent <aid> --interrupt --sessionkey <sessionKey>
```

**参数说明**：
- `--agent <aid>`：必填，指定目标 agent（如 `mybot.agentid.pub`）
- `--interrupt` 必须配合 `--sessionkey` 使用（精准打断，防止误伤其他用户）

---

## 七、操作支持矩阵

| 操作 | ctl | cli |
|---|---|---|
| **查看队列** | `evolclaw ctl queue` | `evolclaw queue --agent <aid>` |
| **显示 messageId** | `--showid` | `--showid` |
| **显示完整内容** | `--full` | `--full` |
| **JSON 输出** | `--format json` | `--format json` |
| **清空待处理** | `--clear` | `--clear` |
| **取消指定消息** | `--cancel <msgId>` | `--cancel <msgId>` |
| **打断处理中** | `--interrupt` | `--interrupt --sessionkey <key>` |

**关键差异**：
- **ctl**：所有操作自动作用于当前 session（`EVOLCLAW_SESSION_ID` 限定）
- **cli**：需要 `--agent` 指定目标，`--interrupt` 额外需要 `--sessionkey` 精准打断

---

## 八、实现清单

### 8.1 数据层（message-queue.ts）

- [x] 新增 `QueueItemSnapshot` 接口
- [x] 新增 `processingStartTime` Map（queueKey → timestamp），在 processNext activeBatches.set/delete + cancelActive 时同步维护
- [x] 新增 `queueKeyToSessionKey` Map（queueKey → sessionKey），enqueue 时通过 `sessionKeyField` 参数写入
- [x] `enqueue()` 签名新增可选参数 `sessionKeyField?: string`
- [x] 实现 `findSessionIdBySessionKey(sessionKey)` — 反向查找，供 cli interrupt 使用
- [x] 实现 `getQueueItemsBySession(sessionId)`
- [x] 实现 `getQueueItemsByAgent(agentName)`
- [x] 实现 `clearBySession(sessionId)`
- [x] 实现 `cancelMessageByIdInSession(sessionId, messageId)`
- [x] 实现 `cancelMessageById(agentName, messageId)`
- [x] 实现 `interruptBySession(sessionId)` — 注意 `for (const queueKey of this.processing)` 非 Map 解构
- [x] 调用方传入 `sessionKeyField`：`message-bridge.ts` ×1、`index.ts` trigger ×2、`index.ts` restart resume ×1

### 8.2 IPC 层

**command-handler.ts**：
- [x] `/queue` 加入 CTL_COMMANDS 白名单
- [x] `handleQueueCommand(sessionId, args)` 方法
- [x] 参数解析（`--showid`、`--full`、`--format json`、`--clear`、`--cancel`、`--interrupt`）
- [x] `extractArg` 辅助函数（解析 `--cancel <msgId>`）
- [x] 调用 MessageQueue 方法
- [x] 调用渲染函数 `renderQueueItemsCtl`

**ipc.ts**：
- [x] 新增 `queue-snapshot` case（统一处理查询 + action）
- [x] 添加 `setQueueSnapshotProvider` 注入方法（查询）
- [x] 添加 `setQueueActionExecutor` 注入方法（clear/cancel/interrupt）
- [x] 在 `index.ts` 注入 provider 和 executor（`findSessionIdBySessionKey` 做 sessionKey → sessionId 转换）

### 8.3 CLI 层（cli/queue-command.ts 新建）

- [x] 解析参数（`--agent`、`--showid`、`--full`、`--format json`、`--clear`、`--cancel`、`--interrupt`、`--sessionkey`）
- [x] 验证 `--agent` 必填，不可省略
- [x] 验证 `--interrupt` 必须配合 `--sessionkey`
- [x] 调用 IPC `queue-snapshot`（查询和操作统一走同一个 IPC 类型）
- [x] 调用渲染函数 `renderQueueItemsCli`
- [x] help 文本（`--help` / 无参数时输出）

### 8.4 渲染层（共用工具函数）

- [x] `renderQueueItemsCtl(items, showId, full)` — ctl 专用，在 `command-handler.ts` 中
- [x] `renderQueueItemsCli(items, showId, full, aid)` — cli 专用，在 `queue-command.ts` 中
- [x] 列宽动态计算
- [x] 内容截断（80 字符，`--full` 禁用）
- [x] 空队列处理

### 8.5 集成

- [x] `cli/index.ts` 注册 `queue` 顶层命令 + import `cmdQueue` + help 文本
- [x] `ctl-command.ts` help 文本更新（加入 queue 说明）
- [x] 单元测试：22 个新增测试覆盖所有方法 + QueueItemSnapshot 结构验证（`tests/unit/message-queue.test.ts`）
- [x] 全文测试套件通过（153 files, 1797 tests, 0 failures）

---

## 九、安全与权限

### 9.1 权限控制

- **ctl**：依赖托管环境，天然隔离（只能操作自己的 session）
- **cli**：通过 Unix socket 权限控制（owner-only）

### 9.2 操作风险等级

| 操作 | 风险等级 | 说明 |
|---|---|---|
| **查看队列** | 无 | 只读操作 |
| **清空待处理** | 低 | 只清未开始的消息，已处理的不受影响 |
| **取消指定消息** | 低 | 精准操作，影响面小 |
| **打断处理中** | 中 | 终止进行中对话，正在生成的回复丢失 |

### 9.3 操作确认机制

**当前方案**：所有操作直接执行，不需要二次确认

**理由**：
- 操作影响面已通过 scope 限制（ctl 限当前 session，cli 需指定 session）
- 清空/取消只影响未开始的消息（低风险）
- 如需二次确认，可在后续版本加 `--force` 跳过

---

## 十、测试计划

### 10.1 功能测试（已实现）

**单元测试覆盖**（`tests/unit/message-queue.test.ts`，22 个新增测试）：

| 测试组 | 测试数 | 覆盖内容 |
|--------|--------|----------|
| `getQueueItemsBySession` | 4 | 空队列、pending 项、跨 session 隔离、projectPath |
| `getQueueItemsByAgent` | 4 | active+pending、未知 agent、agent 隔离、elapsedMs |
| `clearBySession` | 3 | 清空、空队列、跨 session 不清 |
| `clearByAgent` | 1 | 跨 session 清空 |
| `cancelMessageByIdInSession` | 2 | 取消指定消息、未找到返回 false |
| `cancelMessageById` | 2 | agent 作用域取消、未找到 |
| `interruptBySession` | 3 | 触发回调、无活跃任务、发布事件 |
| `findSessionIdBySessionKey` | 1 | 未找到 |
| `QueueItemSnapshot structure` | 2 | 所有字段验证、内容截断 80 字符 |

**后续待补（手动/集成测试）**：
- [ ] ctl + cli 端到端流程（需启动 daemon）
- [ ] `--format json` 输出格式校验
- [ ] `--full` 不截断内容
- [ ] 非托管环境 `EVOLCLAW_SESSION_ID` 缺失报错

---

## 十一、未来扩展

### 11.1 可选功能（Phase 2）

- **批量操作**：`--cancel 1-3` 按范围取消
- **过滤查询**：`--status pending`、`--peer 张三`
- **历史记录**：查看已完成的消息历史
- **队列优先级**：调整消息处理顺序

### 11.2 监控集成

- 与 `evolclaw watch` 集成，实时监控队列变化
- 暴露 Prometheus metrics（队列长度、处理时长）

---

## 十二、文档更新

- [ ] `CLAUDE.md` 更新（新增 queue 命令说明）
- [ ] `docs/commands.md` 新建（完整命令参考）
- [ ] `README.md` 更新（快速开始加入 queue 示例）

---

**文档版本**：v1.2  
**最后更新**：2026-06-16  
**状态**：✅ 已实现

### v1.2 变更记录

| 变更 | 说明 |
|------|------|
| 新增 `findSessionIdBySessionKey` | cli interrupt 路径：sessionKey → sessionId 反查，避免 IPC executor 直接访问内部 Map |
| `enqueue` 签名新增 `sessionKeyField` | 调用方传入 `session.sessionKey`，写入 `queueKeyToSessionKey` Map |
| `processingStartTime` 清理扩展 | `cancelActive()` 全部撤回时也需 `processingStartTime.delete()` |
| `interruptBySession` Set 迭代修复 | `this.processing` 是 `Set<string>`，非 `Map`，迭代应为 `for (const queueKey of ...)` 而非解构 |
| `elapsedMs` fallback 修正 | `buildSnapshot` 中 `processingStartTime` 缺失时返回 `undefined`，避免错误地显示 0ms |
| 实现清单全部 ✅ | 8.1~8.5 全部完成，22 个单元测试通过，全文 153 files/1797 tests 通过 |
