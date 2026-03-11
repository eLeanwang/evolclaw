# EvolClaw 并发处理设计

## 并发能力总览

### ✅ 支持的并发场景

| 场景 | 并发能力 | 说明 |
|------|---------|------|
| **跨渠道** | ✅ 完全并发 | 飞书和 ACP 独立 WebSocket，可同时接收和处理消息 |
| **跨会话** | ✅ 并发（受限） | 不同飞书群组、不同 ACP 会话可并发，受全局并发数限制 |
| **跨项目** | ✅ 完全并发 | 不同项目目录的 Agent 完全隔离，可并发执行 |

### ⚠️ 串行处理场景

| 场景 | 处理方式 | 原因 |
|------|---------|------|
| **同一会话内** | 串行队列 | 保证消息顺序，避免上下文混乱 |
| **同一项目内** | Claude SDK 内部处理 | 文件系统操作需要协调 |

## 并发控制架构

```
消息到达
    ↓
ConcurrencyManager
    ├─ 会话队列 (Session Queue)
    │   ├─ Session A: [msg1, msg2, msg3]  ← 串行
    │   ├─ Session B: [msg1]              ← 串行
    │   └─ Session C: [msg1, msg2]        ← 串行
    │
    ├─ 全局并发池 (Global Pool)
    │   ├─ 最大并发数: 10
    │   ├─ 当前执行: 3
    │   └─ 可用槽位: 7
    │
    └─ 执行调度
        ├─ Session A.msg1 → AgentRunner → Claude SDK
        ├─ Session B.msg1 → AgentRunner → Claude SDK
        └─ Session C.msg1 → AgentRunner → Claude SDK
```

## 核心组件

### 1. ConcurrencyManager

**职责**：
- 管理所有会话的消息队列
- 控制全局并发数
- 调度任务执行

**关键特性**：
- **会话级队列**：每个会话维护独立的消息队列
- **会话级锁**：同一会话同时只能有一个消息在执行
- **全局并发限制**：默认最多 10 个并发执行
- **自动调度**：任务完成后自动处理下一个

**API**：
```typescript
class ConcurrencyManager {
  // 提交任务到队列
  async enqueue(sessionId: string, prompt: string, projectPath: string): Promise<any>

  // 获取当前状态
  getStatus(): {
    currentConcurrent: number;
    maxConcurrent: number;
    queuedSessions: number;
    totalQueued: number;
  }
}
```

### 2. AgentRunner (v2)

**集成并发管理**：
```typescript
class AgentRunner {
  private concurrency: ConcurrencyManager;

  async runQuery(sessionId, prompt, projectPath) {
    // 提交到并发队列，自动处理
    return this.concurrency.enqueue(sessionId, prompt, projectPath);
  }
}
```

## 并发处理流程

### 场景 1：单会话多消息

```
时间轴：
T0: 飞书群组A 收到消息1 → 加入队列 → 立即执行
T1: 飞书群组A 收到消息2 → 加入队列 → 等待消息1完成
T2: 消息1 完成 → 自动执行消息2
T3: 消息2 完成
```

**代码流程**：
```typescript
// T0
await agentRunner.runQuery('feishu-groupA', 'hello', '/project/a');
// → 队列: [msg1] → 执行中: msg1

// T1 (msg1 还在执行)
await agentRunner.runQuery('feishu-groupA', 'world', '/project/a');
// → 队列: [msg2] → 执行中: msg1 → msg2 等待

// T2 (msg1 完成)
// → 队列: [] → 执行中: msg2 → 自动开始

// T3 (msg2 完成)
// → 队列: [] → 执行中: 无
```

### 场景 2：多会话并发

```
时间轴：
T0: 飞书群组A 收到消息1 → 立即执行
T0: 飞书群组B 收到消息1 → 立即执行 (并发)
T0: ACP 会话C 收到消息1 → 立即执行 (并发)
T1: 三个消息同时处理中...
T2: 群组A 完成
T3: 群组B 完成
T4: 会话C 完成
```

**代码流程**：
```typescript
// T0 - 三个消息几乎同时到达
Promise.all([
  agentRunner.runQuery('feishu-groupA', 'msg1', '/project/a'),
  agentRunner.runQuery('feishu-groupB', 'msg1', '/project/b'),
  agentRunner.runQuery('acp-sessionC', 'msg1', '/project/c')
]);

// 并发状态:
// currentConcurrent: 3
// activeExecutions: ['feishu-groupA', 'feishu-groupB', 'acp-sessionC']
```

### 场景 3：达到并发上限

```
假设 maxConcurrent = 3

T0: 会话1-10 同时收到消息
    → 会话1,2,3 立即执行
    → 会话4-10 进入队列等待

T1: 会话1 完成
    → 会话4 自动开始执行

T2: 会话2 完成
    → 会话5 自动开始执行

...依此类推
```

**队列状态**：
```typescript
// T0
{
  currentConcurrent: 3,  // 已达上限
  maxConcurrent: 3,
  queuedSessions: 7,     // 7个会话在等待
  totalQueued: 7         // 总共7条消息在队列中
}

// T1 (会话1完成)
{
  currentConcurrent: 3,  // 会话4自动补上
  maxConcurrent: 3,
  queuedSessions: 6,
  totalQueued: 6
}
```

## 资源隔离

### 1. 会话隔离

每个会话拥有独立的：
- **消息队列**：`sessionQueues.get(sessionId)`
- **执行状态**：`activeExecutions.has(sessionId)`
- **Claude 会话ID**：`activeSessions.get(sessionId)`

### 2. 项目隔离

每个项目拥有独立的：
- **工作目录**：`projectPath`
- **`.claude/` 目录**：会话数据
- **文件系统**：完全隔离

### 3. 渠道隔离

每个渠道拥有独立的：
- **WebSocket 连接**：飞书 / ACP
- **消息处理器**：`onMessage` 回调
- **发送队列**：渠道内部管理

## 性能优化

### 1. 内存管理

```typescript
// 限制队列长度
const MAX_QUEUE_LENGTH = 100;

if (queue.length >= MAX_QUEUE_LENGTH) {
  throw new Error('Queue full');
}
```

### 2. 超时控制

```typescript
// 单个查询超时
const QUERY_TIMEOUT = 5 * 60 * 1000; // 5分钟

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Query timeout')), QUERY_TIMEOUT);
});

await Promise.race([queryPromise, timeoutPromise]);
```

### 3. 优雅降级

```typescript
// 并发数动态调整
if (systemLoad > 0.8) {
  concurrency.setMaxConcurrent(5); // 降低并发
} else {
  concurrency.setMaxConcurrent(10); // 恢复并发
}
```

## 监控指标

### 实时指标

```typescript
const status = agentRunner.getStatus();

console.log({
  currentConcurrent: status.currentConcurrent,  // 当前执行数
  maxConcurrent: status.maxConcurrent,          // 最大并发数
  queuedSessions: status.queuedSessions,        // 排队会话数
  totalQueued: status.totalQueued,              // 总排队消息数
  activeSessions: status.activeSessions         // 活跃会话数
});
```

### 性能指标

- **平均响应时间**：从消息到达到回复发送的时间
- **队列等待时间**：消息在队列中的等待时间
- **并发利用率**：`currentConcurrent / maxConcurrent`
- **队列积压**：`totalQueued` 的趋势

## 配置建议

### 1. 并发数设置

```typescript
// 根据服务器资源调整
const config = {
  // 低配置 (2核4G)
  maxConcurrent: 3,

  // 中配置 (4核8G)
  maxConcurrent: 10,

  // 高配置 (8核16G)
  maxConcurrent: 20
};
```

### 2. 超时设置

```typescript
const timeouts = {
  queryTimeout: 5 * 60 * 1000,      // 单个查询超时: 5分钟
  sessionIdleTimeout: 30 * 60 * 1000, // 会话空闲超时: 30分钟
  channelReconnect: 5 * 1000         // 渠道重连间隔: 5秒
};
```

## 错误处理

### 1. 执行失败

```typescript
try {
  await agentRunner.runQuery(sessionId, prompt, projectPath);
} catch (error) {
  // 错误不影响其他会话
  logger.error('Query failed', { sessionId, error });

  // 发送错误消息给用户
  await channel.sendMessage(channelId, '抱歉，处理失败，请稍后重试');
}
```

### 2. 队列满

```typescript
if (queue.length >= MAX_QUEUE_LENGTH) {
  await channel.sendMessage(channelId, '系统繁忙，请稍后再试');
  return;
}
```

### 3. 超时处理

```typescript
// 超时后自动清理
setTimeout(() => {
  if (activeExecutions.has(sessionId)) {
    activeExecutions.delete(sessionId);
    processNext(); // 处理下一个
  }
}, QUERY_TIMEOUT);
```

## 总结

**EvolClaw 的并发能力**：

✅ **支持**：
- 多渠道同时接收消息
- 多会话并发处理（最多10个）
- 多项目完全隔离

⚠️ **限制**：
- 同一会话内消息串行处理
- 全局并发数限制（可配置）

🎯 **优势**：
- 自动队列管理
- 会话级隔离
- 资源可控
- 性能可监控
