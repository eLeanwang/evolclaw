# EvolClaw 状态监控模块设计

## 问题分析

### Stop Hook 的局限性

**Stop Hook 触发条件**：Agent 响应完成后

**无法覆盖的场景**：
1. ❌ 进程崩溃（Stop Hook 未触发）
2. ❌ 网络中断（无法同步）
3. ❌ 长时间卡死（无输出）
4. ❌ API 限流（需要退避重试）
5. ❌ 重复失败（需要熔断）

### 架构缺陷

```
当前设计：
消息 → query() → Stop Hook → 同步
         ↑
      假设总能正常结束
```

**实际情况**：
- query() 可能永远不返回
- 进程可能突然终止
- 网络可能随时中断

---

## 监控模块架构

### 整体设计

```
┌─────────────────────────────────────────────────┐
│              消息队列层                           │
│         (MessageQueue)                          │
└─────────────┬───────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────┐
│           状态监控层（新增）                       │
│         (StateMonitor)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │心跳检测  │  │超时检测  │  │错误统计  │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│  ┌──────────┐  ┌──────────┐                    │
│  │熔断机制  │  │状态恢复  │                    │
│  └──────────┘  └──────────┘                    │
└─────────────┬───────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────┐
│           实例管理层                              │
│         (InstanceManager)                       │
│              query() + Stop Hook                │
└─────────────────────────────────────────────────┘
```

---

## 核心组件

### 1. 心跳检测 (Heartbeat)

**目的**：检测 Agent 是否还在运行

**机制**：
```typescript
class HeartbeatMonitor {
  private lastHeartbeat = new Map<string, number>();
  private heartbeatInterval = 30000; // 30 秒
  private heartbeatTimeout = 90000;  // 90 秒无心跳视为死亡

  // 启动心跳监控
  startMonitoring(sessionId: string) {
    this.lastHeartbeat.set(sessionId, Date.now());

    const timer = setInterval(() => {
      const last = this.lastHeartbeat.get(sessionId);
      const now = Date.now();

      if (now - last > this.heartbeatTimeout) {
        // 心跳超时，视为异常
        this.handleHeartbeatTimeout(sessionId);
        clearInterval(timer);
      }
    }, this.heartbeatInterval);
  }

  // 更新心跳（在流式输出时调用）
  updateHeartbeat(sessionId: string) {
    this.lastHeartbeat.set(sessionId, Date.now());
  }

  private async handleHeartbeatTimeout(sessionId: string) {
    logger.error(`会话 ${sessionId} 心跳超时`);

    // 1. 标记会话为异常
    await db.updateSessionStatus(sessionId, "heartbeat_timeout");

    // 2. 尝试同步已完成的部分
    await this.emergencySync(sessionId);

    // 3. 清理资源
    await this.cleanup(sessionId);

    // 4. 通知用户
    await this.notifyUser(sessionId, "执行异常中断");
  }
}
```

**集成点**：
- 在 query() 开始时启动心跳
- 在流式输出时更新心跳
- 在 Stop Hook 时停止心跳

### 2. 超时检测 (Timeout)

**目的**：防止任务无限期运行

**机制**：
```typescript
class TimeoutMonitor {
  private timeoutLimit = 30 * 60 * 1000; // 30 分钟

  async executeWithTimeout<T>(
    sessionId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("EXECUTION_TIMEOUT"));
      }, this.timeoutLimit);
    });

    try {
      return await Promise.race([task(), timeoutPromise]);
    } catch (error) {
      if (error.message === "EXECUTION_TIMEOUT") {
        await this.handleTimeout(sessionId);
      }
      throw error;
    }
  }

  private async handleTimeout(sessionId: string) {
    logger.warn(`会话 ${sessionId} 执行超时`);

    // 1. 标记会话状态
    await db.updateSessionStatus(sessionId, "timeout");

    // 2. 强制同步
    await this.emergencySync(sessionId);

    // 3. 终止执行
    await this.terminate(sessionId);

    // 4. 通知用户
    await this.notifyUser(sessionId, "执行超时");
  }
}
```

### 3. 错误统计 (ErrorTracker)

**目的**：追踪和分类错误

**机制**：
```typescript
interface ErrorRecord {
  sessionId: string;
  errorType: string;
  errorMessage: string;
  timestamp: number;
  count: number;
}

class ErrorTracker {
  private errors = new Map<string, ErrorRecord[]>();

  recordError(sessionId: string, error: Error) {
    const errorType = this.classifyError(error);

    if (!this.errors.has(sessionId)) {
      this.errors.set(sessionId, []);
    }

    const records = this.errors.get(sessionId)!;
    const existing = records.find(r => r.errorType === errorType);

    if (existing) {
      existing.count++;
      existing.timestamp = Date.now();
    } else {
      records.push({
        sessionId,
        errorType,
        errorMessage: error.message,
        timestamp: Date.now(),
        count: 1,
      });
    }

    // 持久化到数据库
    db.storeErrorRecord(sessionId, errorType, error.message);

    // 检查是否需要熔断
    if (this.shouldCircuitBreak(sessionId, errorType)) {
      this.triggerCircuitBreaker(sessionId, errorType);
    }
  }

  private classifyError(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes("rate limit")) return "RATE_LIMIT";
    if (message.includes("timeout")) return "TIMEOUT";
    if (message.includes("network")) return "NETWORK";
    if (message.includes("authentication")) return "AUTH";
    if (message.includes("permission")) return "PERMISSION";

    return "UNKNOWN";
  }

  private shouldCircuitBreak(sessionId: string, errorType: string): boolean {
    const records = this.errors.get(sessionId) || [];
    const record = records.find(r => r.errorType === errorType);

    if (!record) return false;

    // 5 分钟内同一错误超过 3 次
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return record.count >= 3 && record.timestamp > fiveMinutesAgo;
  }
}
```

### 4. 熔断机制 (CircuitBreaker)

**目的**：防止重复失败消耗资源

**机制**：
```typescript
enum CircuitState {
  CLOSED = "closed",     // 正常运行
  OPEN = "open",         // 熔断开启
  HALF_OPEN = "half_open" // 尝试恢复
}

class CircuitBreaker {
  private state = new Map<string, CircuitState>();
  private failureCount = new Map<string, number>();
  private lastFailureTime = new Map<string, number>();

  private failureThreshold = 3;      // 失败阈值
  private timeout = 5 * 60 * 1000;   // 5 分钟后尝试恢复
  private halfOpenMaxAttempts = 1;   // 半开状态最多尝试 1 次

  async execute<T>(
    sessionId: string,
    task: () => Promise<T>
  ): Promise<T> {
    const state = this.state.get(sessionId) || CircuitState.CLOSED;

    if (state === CircuitState.OPEN) {
      // 检查是否可以进入半开状态
      const lastFailure = this.lastFailureTime.get(sessionId) || 0;
      if (Date.now() - lastFailure > this.timeout) {
        this.state.set(sessionId, CircuitState.HALF_OPEN);
      } else {
        throw new Error("CIRCUIT_BREAKER_OPEN");
      }
    }

    try {
      const result = await task();

      // 成功，重置状态
      this.onSuccess(sessionId);
      return result;
    } catch (error) {
      // 失败，记录并可能触发熔断
      this.onFailure(sessionId);
      throw error;
    }
  }

  private onSuccess(sessionId: string) {
    this.failureCount.set(sessionId, 0);
    this.state.set(sessionId, CircuitState.CLOSED);
  }

  private onFailure(sessionId: string) {
    const count = (this.failureCount.get(sessionId) || 0) + 1;
    this.failureCount.set(sessionId, count);
    this.lastFailureTime.set(sessionId, Date.now());

    if (count >= this.failureThreshold) {
      this.state.set(sessionId, CircuitState.OPEN);
      logger.warn(`会话 ${sessionId} 熔断器开启`);

      // 通知用户
      this.notifyCircuitBreak(sessionId);
    }
  }

  private async notifyCircuitBreak(sessionId: string) {
    const chatJid = await db.getChatJidBySession(sessionId);
    await imManager.sendMessage(chatJid, {
      type: "circuit_break",
      message: "检测到连续失败，已暂停执行。5 分钟后自动恢复。",
    });
  }
}
```

### 5. 状态恢复 (StateRecovery)

**目的**：异常终止后的清理和恢复

**机制**：
```typescript
class StateRecovery {
  // 紧急同步（异常情况下）
  async emergencySync(sessionId: string) {
    try {
      const transcriptPath = this.getTranscriptPath(sessionId);

      // 1. 检查 JSONL 文件是否存在
      if (!existsSync(transcriptPath)) {
        logger.warn(`会话 ${sessionId} 的 JSONL 文件不存在`);
        return;
      }

      // 2. 强制全量同步
      await messageSync.syncAll(sessionId, transcriptPath);

      logger.info(`会话 ${sessionId} 紧急同步完成`);
    } catch (error) {
      logger.error(`会话 ${sessionId} 紧急同步失败: ${error}`);
    }
  }

  // 清理资源
  async cleanup(sessionId: string) {
    // 1. 清理内存状态
    heartbeatMonitor.stop(sessionId);

    // 2. 清理临时文件
    await this.cleanupTempFiles(sessionId);

    // 3. 更新数据库状态
    await db.updateSessionStatus(sessionId, "terminated");

    logger.info(`会话 ${sessionId} 资源清理完成`);
  }

  // 启动时恢复（处理上次异常退出的会话）
  async recoverOnStartup() {
    // 1. 查找所有"运行中"状态的会话
    const runningSessions = await db.getSessionsByStatus("running");

    for (const session of runningSessions) {
      logger.warn(`发现异常退出的会话: ${session.id}`);

      // 2. 尝试同步
      await this.emergencySync(session.id);

      // 3. 标记为异常终止
      await db.updateSessionStatus(session.id, "crashed");

      // 4. 通知用户
      await this.notifyRecovery(session.id);
    }
  }
}
```

---

## 集成方案

### 完整的执行流程

```typescript
class MonitoredInstanceManager {
  private heartbeat: HeartbeatMonitor;
  private timeout: TimeoutMonitor;
  private errorTracker: ErrorTracker;
  private circuitBreaker: CircuitBreaker;
  private recovery: StateRecovery;

  async processMessage(sessionId: string, prompt: string) {
    // 1. 检查熔断器
    if (this.circuitBreaker.isOpen(sessionId)) {
      throw new Error("会话已熔断，请稍后重试");
    }

    // 2. 标记会话为运行中
    await db.updateSessionStatus(sessionId, "running");

    // 3. 启动心跳监控
    this.heartbeat.startMonitoring(sessionId);

    try {
      // 4. 执行（带超时控制）
      const result = await this.timeout.executeWithTimeout(
        sessionId,
        () => this.executeQuery(sessionId, prompt)
      );

      // 5. 成功，重置熔断器
      this.circuitBreaker.onSuccess(sessionId);

      return result;
    } catch (error) {
      // 6. 记录错误
      this.errorTracker.recordError(sessionId, error);

      // 7. 熔断器记录失败
      this.circuitBreaker.onFailure(sessionId);

      // 8. 紧急同步
      await this.recovery.emergencySync(sessionId);

      throw error;
    } finally {
      // 9. 停止心跳
      this.heartbeat.stopMonitoring(sessionId);

      // 10. 更新状态
      await db.updateSessionStatus(sessionId, "completed");
    }
  }

  private async executeQuery(sessionId: string, prompt: string) {
    const stopHook: HookCallback = async (input) => {
      // Stop Hook 仍然是主要同步点
      await messageSync.syncLatest(input.session_id, input.transcript_path);
      return {};
    };

    let fullResponse = "";

    for await (const message of query({
      prompt,
      options: {
        hooks: { Stop: [{ hooks: [stopHook] }] },
      },
    })) {
      // 更新心跳（有输出说明还活着）
      this.heartbeat.updateHeartbeat(sessionId);

      if ("result" in message) {
        fullResponse = message.result;
      }
    }

    return fullResponse;
  }
}
```

---

## 数据库 Schema

```sql
-- 会话状态表
CREATE TABLE session_status (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  -- running, completed, timeout, heartbeat_timeout, crashed, terminated
  last_heartbeat INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  error_message TEXT
);

-- 错误记录表
CREATE TABLE error_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT,
  timestamp INTEGER NOT NULL,
  INDEX idx_session_error (session_id, error_type)
);

-- 熔断器状态表
CREATE TABLE circuit_breaker_state (
  session_id TEXT PRIMARY KEY,
  state TEXT NOT NULL, -- closed, open, half_open
  failure_count INTEGER DEFAULT 0,
  last_failure_time INTEGER,
  updated_at INTEGER
);
```

---

## 配置项

```json
{
  "monitor": {
    "heartbeat": {
      "interval": 30000,
      "timeout": 90000
    },
    "timeout": {
      "limit": 1800000
    },
    "circuitBreaker": {
      "failureThreshold": 3,
      "timeout": 300000,
      "halfOpenMaxAttempts": 1
    },
    "recovery": {
      "enableStartupRecovery": true,
      "emergencySyncOnError": true
    }
  }
}
```

---

## 总结

### 监控层级

| 层级 | 机制 | 覆盖场景 |
|------|------|---------|
| **L1: Stop Hook** | SDK 内置 | 正常完成、工具失败 |
| **L2: 心跳检测** | 外部监控 | 进程卡死、无响应 |
| **L3: 超时检测** | 外部监控 | 长时间运行 |
| **L4: 错误统计** | 外部监控 | 特定错误、重复失败 |
| **L5: 熔断机制** | 外部监控 | 连续失败保护 |
| **L6: 状态恢复** | 启动时 | 异常退出恢复 |

### 代码量估算

- HeartbeatMonitor: ~80 行
- TimeoutMonitor: ~50 行
- ErrorTracker: ~100 行
- CircuitBreaker: ~120 行
- StateRecovery: ~80 行
- MonitoredInstanceManager: ~100 行
- **总计**: ~530 行

### 更新后的总代码量

- 原设计: ~500 行
- 监控模块: ~530 行
- **总计**: ~1030 行

### 可行性评分

**维持 9/10**
- 监控机制清晰可行
- 所有异常场景有覆盖
- 代码量仍然可控
- 实现复杂度适中

---

*最后更新：2026-03-07*
*状态：设计完成，待实施*
