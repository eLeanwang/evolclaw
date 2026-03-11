# EvolClaw Gateway 架构设计

## 架构概览

EvolClaw 作为 Gateway 服务，为每个会话启动独立的 Claude Code 实例，通过 Hook 监控执行状态，实现故障恢复。

```
┌─────────────────────────────────────────────────────────────┐
│                    EvolClaw Gateway                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │              Message Router                         │    │
│  │   (飞书/ACP 消息 → 会话路由 → 实例分发)              │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │           Instance Manager                          │    │
│  │   ┌──────────────┐  ┌──────────────┐  ┌─────────┐ │    │
│  │   │ Instance 1   │  │ Instance 2   │  │ Inst 3  │ │    │
│  │   │ (会话A)      │  │ (会话B)      │  │ (会话C) │ │    │
│  │   │ Claude Code  │  │ Claude Code  │  │ Claude  │ │    │
│  │   │ Process      │  │ Process      │  │ Process │ │    │
│  │   └──────────────┘  └──────────────┘  └─────────┘ │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │              Hook Monitor                           │    │
│  │   - 监控实例状态                                     │    │
│  │   - 捕获 Hook 事件                                   │    │
│  │   - 记录执行日志                                     │    │
│  └────────────────────────────────────────────────────┘    │
│                          ↓                                   │
│  ┌────────────────────────────────────────────────────┐    │
│  │           Failure Handler                           │    │
│  │   - 异常检测                                         │    │
│  │   - 自动重试                                         │    │
│  │   - 实例重启                                         │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. Instance Manager

**职责**：管理 Claude Code 实例的生命周期

**功能**：
- 启动新实例
- 停止实例
- 实例池管理
- 资源限制

**API**：
```typescript
interface IInstanceManager {
  // 获取或创建实例
  getOrCreateInstance(sessionId: string, projectPath: string): Promise<ClaudeInstance>;

  // 停止实例
  stopInstance(sessionId: string): Promise<void>;

  // 重启实例
  restartInstance(sessionId: string): Promise<void>;

  // 获取实例状态
  getInstanceStatus(sessionId: string): InstanceStatus;

  // 获取所有实例
  getAllInstances(): Map<string, ClaudeInstance>;
}
```

### 2. Claude Instance

**职责**：封装单个 Claude Code 进程

**特性**：
- 独立进程
- 独立工作目录
- 独立会话数据
- IPC 通信

**生命周期**：
```
创建 → 启动 → 运行中 → 空闲 → 停止 → 清理
  ↓      ↓       ↓       ↓      ↓      ↓
 init  spawn   active  idle   kill  cleanup
```

**状态机**：
```typescript
enum InstanceState {
  INITIALIZING = 'initializing',
  RUNNING = 'running',
  IDLE = 'idle',
  BUSY = 'busy',
  ERROR = 'error',
  STOPPED = 'stopped'
}
```

### 3. Hook Monitor

**职责**：监控实例执行状态

**监控的 Hook 事件**：
- `onQueryStart` - 查询开始
- `onQueryEnd` - 查询结束
- `onToolUse` - 工具使用
- `onError` - 错误发生
- `onTimeout` - 超时
- `onContextCompact` - 上下文压缩

**数据收集**：
```typescript
interface HookEvent {
  sessionId: string;
  instanceId: string;
  hookType: string;
  timestamp: number;
  data: any;
}
```

### 4. Failure Handler

**职责**：处理实例故障

**故障类型**：
1. **进程崩溃**：进程意外退出
2. **超时**：查询执行超时
3. **错误率高**：连续多次错误
4. **资源耗尽**：内存/CPU 过高

**恢复策略**：
```typescript
interface RecoveryStrategy {
  // 重试策略
  retry: {
    maxAttempts: number;
    backoff: 'linear' | 'exponential';
    initialDelay: number;
  };

  // 重启策略
  restart: {
    enabled: boolean;
    maxRestarts: number;
    cooldown: number;
  };

  // 降级策略
  fallback: {
    enabled: boolean;
    action: 'queue' | 'reject' | 'notify';
  };
}
```

## 进程管理

### 启动 Claude Code 实例

```typescript
import { spawn } from 'child_process';

class ClaudeInstance {
  private process: ChildProcess;
  private sessionId: string;
  private projectPath: string;

  async start(): Promise<void> {
    this.process = spawn('claude', ['code'], {
      cwd: this.projectPath,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: this.sessionId
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // 监听进程事件
    this.process.on('exit', this.handleExit.bind(this));
    this.process.on('error', this.handleError.bind(this));

    // 监听输出
    this.process.stdout.on('data', this.handleOutput.bind(this));
    this.process.stderr.on('data', this.handleError.bind(this));
  }
}
```

### IPC 通信协议

**输入（stdin）**：
```json
{
  "type": "query",
  "prompt": "用户消息",
  "sessionId": "session-123"
}
```

**输出（stdout）**：
```json
{
  "type": "response",
  "text": "Agent 回复",
  "sessionId": "session-123",
  "status": "success"
}
```

**Hook 事件（stdout）**：
```json
{
  "type": "hook",
  "hookType": "onQueryStart",
  "data": { ... },
  "timestamp": 1234567890
}
```

## Hook 监控机制

### Hook 配置

在每个实例的工作目录创建 `.claude/hooks/`：

```bash
.claude/
└── hooks/
    ├── on-query-start.sh
    ├── on-query-end.sh
    ├── on-error.sh
    └── on-timeout.sh
```

### Hook 脚本示例

```bash
#!/bin/bash
# on-query-start.sh

# 发送事件到 Gateway
curl -X POST http://localhost:3000/hooks/event \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$CLAUDE_SESSION_ID\",
    \"hookType\": \"onQueryStart\",
    \"timestamp\": $(date +%s)
  }"
```

### Gateway Hook 接收

```typescript
app.post('/hooks/event', (req, res) => {
  const event: HookEvent = req.body;

  hookMonitor.recordEvent(event);

  // 检查是否需要干预
  if (failureHandler.shouldIntervene(event)) {
    failureHandler.handle(event);
  }

  res.json({ status: 'ok' });
});
```

## 故障恢复流程

### 1. 异常检测

```typescript
class FailureDetector {
  detect(instance: ClaudeInstance): FailureType | null {
    // 进程崩溃
    if (!instance.isAlive()) {
      return FailureType.PROCESS_CRASH;
    }

    // 超时
    if (instance.getIdleTime() > TIMEOUT_THRESHOLD) {
      return FailureType.TIMEOUT;
    }

    // 错误率高
    if (instance.getErrorRate() > ERROR_RATE_THRESHOLD) {
      return FailureType.HIGH_ERROR_RATE;
    }

    return null;
  }
}
```

### 2. 重试逻辑

```typescript
class RetryHandler {
  async retry(sessionId: string, prompt: string, attempt: number): Promise<any> {
    if (attempt >= MAX_RETRY_ATTEMPTS) {
      throw new Error('Max retry attempts reached');
    }

    const delay = this.calculateBackoff(attempt);
    await this.sleep(delay);

    try {
      return await this.executeQuery(sessionId, prompt);
    } catch (error) {
      return this.retry(sessionId, prompt, attempt + 1);
    }
  }

  private calculateBackoff(attempt: number): number {
    // 指数退避：1s, 2s, 4s, 8s, 16s
    return Math.min(1000 * Math.pow(2, attempt), 30000);
  }
}
```

### 3. 实例重启

```typescript
class RestartHandler {
  async restart(sessionId: string): Promise<void> {
    const instance = instanceManager.getInstance(sessionId);

    // 1. 保存状态
    const state = await instance.saveState();

    // 2. 停止实例
    await instance.stop();

    // 3. 清理资源
    await instance.cleanup();

    // 4. 启动新实例
    const newInstance = await instanceManager.createInstance(sessionId);

    // 5. 恢复状态
    await newInstance.restoreState(state);

    logger.info('Instance restarted', { sessionId });
  }
}
```

## 资源管理

### 实例池配置

```typescript
interface InstancePoolConfig {
  // 最大实例数
  maxInstances: number;

  // 空闲超时（毫秒）
  idleTimeout: number;

  // 单实例资源限制
  limits: {
    memory: string;      // '512M'
    cpu: number;         // 1.0 (1 core)
    timeout: number;     // 300000 (5 min)
  };
}
```

### 实例清理策略

```typescript
class InstanceCleaner {
  async cleanup(): Promise<void> {
    const instances = instanceManager.getAllInstances();

    for (const [sessionId, instance] of instances) {
      // 清理空闲实例
      if (instance.getIdleTime() > IDLE_TIMEOUT) {
        await instanceManager.stopInstance(sessionId);
      }

      // 清理错误实例
      if (instance.getState() === InstanceState.ERROR) {
        await instanceManager.stopInstance(sessionId);
      }
    }
  }
}

// 定期清理
setInterval(() => cleaner.cleanup(), 60000); // 每分钟
```

## 监控指标

### 实例级指标

```typescript
interface InstanceMetrics {
  sessionId: string;
  state: InstanceState;
  uptime: number;
  queryCount: number;
  errorCount: number;
  lastQueryTime: number;
  memoryUsage: number;
  cpuUsage: number;
}
```

### Gateway 级指标

```typescript
interface GatewayMetrics {
  totalInstances: number;
  activeInstances: number;
  idleInstances: number;
  errorInstances: number;
  totalQueries: number;
  totalErrors: number;
  averageResponseTime: number;
}
```

## 配置示例

```json
{
  "gateway": {
    "port": 3000,
    "instancePool": {
      "maxInstances": 20,
      "idleTimeout": 1800000,
      "limits": {
        "memory": "512M",
        "cpu": 1.0,
        "timeout": 300000
      }
    },
    "hooks": {
      "enabled": true,
      "endpoint": "http://localhost:3000/hooks/event"
    },
    "recovery": {
      "retry": {
        "maxAttempts": 3,
        "backoff": "exponential",
        "initialDelay": 1000
      },
      "restart": {
        "enabled": true,
        "maxRestarts": 5,
        "cooldown": 60000
      }
    }
  }
}
```

## 部署架构

```
┌─────────────────────────────────────────┐
│         EvolClaw Gateway                 │
│         (Node.js Process)                │
│                                          │
│  ┌────────────────────────────────┐    │
│  │   HTTP Server (Port 3000)      │    │
│  │   - Hook 接收                   │    │
│  │   - 健康检查                    │    │
│  │   - 监控 API                    │    │
│  └────────────────────────────────┘    │
│                                          │
│  ┌────────────────────────────────┐    │
│  │   Instance Manager              │    │
│  │   ├─ Instance 1 (PID 1001)     │    │
│  │   ├─ Instance 2 (PID 1002)     │    │
│  │   └─ Instance 3 (PID 1003)     │    │
│  └────────────────────────────────┘    │
└─────────────────────────────────────────┘
           ↓           ↓           ↓
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Claude   │ │ Claude   │ │ Claude   │
    │ Code     │ │ Code     │ │ Code     │
    │ Process  │ │ Process  │ │ Process  │
    └──────────┘ └──────────┘ └──────────┘
```

## 优势

1. **隔离性**：每个会话独立进程，互不影响
2. **可靠性**：单个实例崩溃不影响其他会话
3. **可监控**：Hook 机制提供完整的执行可见性
4. **可恢复**：自动重试和重启机制
5. **可扩展**：可以轻松增加实例数量

## 与 HappyClaw 对比

| 特性 | HappyClaw | EvolClaw Gateway |
|------|-----------|------------------|
| 隔离方式 | Docker 容器 | 进程隔离 |
| 资源开销 | 高（容器） | 低（进程） |
| 启动速度 | 慢（秒级） | 快（毫秒级） |
| 监控方式 | 容器日志 | Hook 事件 |
| 故障恢复 | 容器重启 | 进程重启 |
| 多用户 | ✅ | ❌（单用户） |
