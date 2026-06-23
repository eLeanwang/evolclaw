# EvolClaw 系统改进实施计划

## 需求确认

基于问卷调研结果，确定以下实施方案：

---

## 第一阶段：紧急修复（P0）

### 1. 消息去重持久化 ⚠️
**问题**：内存 Map 重启后清空，导致飞书重推的历史消息被重复处理

**数据库统一方案**：
- 将 `sessions.db` 重命名为 `evolclaw.db`
- 所有表（业务 + 监控）统一存储，简化部署和事务管理

**方案**：
```sql
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_processed_at ON processed_messages(processed_at);
```

**实现要点**：
- 修改 `FeishuChannel.isDuplicate()` 查询数据库
- 修改 `FeishuChannel.markSeen()` 写入数据库
- 定期清理 24 小时前的记录
- 保留内存缓存作为一级缓存（性能优化）

---

### 2. 日志系统改进（含时间戳 + 等级 + 轮转）
**方案**：简单包装 console.log，添加时间戳和等级控制

**实现**：
```typescript
// src/utils/logger.ts
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function shouldLog(level: string): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

function log(level: string, ...args: any[]) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}]`, ...args);
}

export const logger = {
  debug: (...args: any[]) => log('DEBUG', ...args),
  info: (...args: any[]) => log('INFO', ...args),
  warn: (...args: any[]) => log('WARN', ...args),
  error: (...args: any[]) => log('ERROR', ...args)
};
```

**日志轮转**：
- 按大小轮转（10MB 一个文件）
- 修改 `evolclaw.sh` 和 `restart-monitor.sh`
- 使用追加模式 `>>`
- 实现简单的日志轮转脚本

**配置方式**：
```bash
# 启动时设置日志等级
LOG_LEVEL=DEBUG node dist/index.js

# 或在 evolclaw.sh 中配置
export LOG_LEVEL=INFO  # 生产环境
export LOG_LEVEL=DEBUG # 调试环境
```

---

## 第二阶段：监控系统（P0）

### 3. 启用监控组件
**启用组件**：
- ✅ HookCollector - 事件收集
- ✅ CircuitBreaker - 熔断器
- ✅ StateRecovery - 状态恢复
- ✅ Notification - 通知处理

**实现要点**：
```typescript
// src/index.ts
import Database from 'better-sqlite3';
import { HookCollector, CircuitBreaker, StateRecovery } from './monitor/index.js';

// 使用统一数据库
const db = new Database('data/evolclaw.db');

// 初始化监控组件
const hookCollector = new HookCollector(db);
const circuitBreaker = new CircuitBreaker(db, {
  failureThreshold: 5,
  resetTimeout: 60000,
  windowSize: 300000
});
const stateRecovery = new StateRecovery(hookCollector, {
  enableStartupRecovery: true,
  emergencySyncOnError: true
});

// 启动时恢复状态
await stateRecovery.recoverOnStartup();

// 在 AgentRunner 中注册 Hook
agentRunner.on('hook', (event) => {
  hookCollector.collect(event);
});
```

---

### 4. 创建消息元数据表
**方案**：
```sql
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  direction TEXT NOT NULL, -- 'inbound' / 'outbound'
  content_preview TEXT,
  content_type TEXT, -- 'text' / 'image' / 'file'
  status TEXT, -- 'received' / 'processing' / 'completed' / 'failed'
  error_message TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_msg_session ON session_messages(session_id, created_at);
CREATE INDEX idx_msg_status ON session_messages(status);
```

**实现要点**：
- 在 `src/index.ts` 的消息处理流程中记录
- 收到消息时：插入记录，status='received'
- 开始处理时：更新 status='processing'
- 处理完成时：更新 status='completed', processed_at
- 处理失败时：更新 status='failed', error_message

---

## 第三阶段：错误处理优化（P1）

### 5. 错误消息细化
**方案**：区分错误类型，返回具体提示

```typescript
// src/utils/error-handler.ts
export function getErrorMessage(error: Error): string {
  const msg = error.message || '';

  if (msg.includes('API Error: 400')) {
    return '⚠️ 请求格式错误，请检查输入内容';
  }
  if (msg.includes('API Error: 500')) {
    return '⚠️ API 服务暂时不可用，请稍后重试';
  }
  if (msg.includes('API Error: 429')) {
    return '⚠️ 请求过于频繁，请稍后再试';
  }
  if (msg.includes('process exited')) {
    return '⚠️ 处理进程异常退出，请重试';
  }
  if (msg.includes('timeout')) {
    return '⚠️ 请求超时，请重试';
  }
  if (msg.includes('permission') || msg.includes('im:resource')) {
    return '⚠️ 权限不足，请联系管理员配置应用权限';
  }

  return '处理消息时出错，请稍后重试';
}
```

---

### 6. 熔断器 + 重试机制
**方案**：配合使用，提高可用性

```typescript
// src/utils/retry.ts
export async function retryWithCircuitBreaker<T>(
  fn: () => Promise<T>,
  sessionId: string,
  circuitBreaker: CircuitBreaker,
  maxRetries: number = 3
): Promise<T> {
  // 检查熔断器状态
  if (circuitBreaker.isOpen(sessionId) && !circuitBreaker.canRetry(sessionId)) {
    throw new Error('Circuit breaker is open, too many failures');
  }

  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      circuitBreaker.recordSuccess(sessionId);
      return result;
    } catch (error) {
      circuitBreaker.recordFailure(sessionId);

      if (i === maxRetries - 1) throw error;

      // 指数退避
      await sleep(Math.pow(2, i) * 1000);
    }
  }

  throw new Error('Max retries exceeded');
}
```

---

## 第四阶段：运维功能（P2）

### 7. 健康检查端点
**注**：日志等级配置已在第一阶段实现


**方案**：
```typescript
// src/index.ts
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    channels: {
      feishu: feishu ? 'connected' : 'disconnected',
      aun: aun ? 'connected' : 'disconnected'
    },
    database: {
      sessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get(),
      messages: db.prepare('SELECT COUNT(*) as count FROM session_messages').get()
    }
  });
});
```

---

## 暂不实施的功能

以下功能暂不实施，保持现状：

- ❌ 图片接收功能修复（等待后期实现）
- ❌ 文件收发支持（等待后期实现）
- ❌ AUN 渠道实现（保持占位符）
- ❌ 配置文件加密（风险可控）
- ❌ 性能监控（后期优化）
- ❌ 数据库备份（后期优化）

---

## 实施顺序

按照以下顺序依次实施：

1. ✅ **消息去重持久化**（解决严重 bug）
2. ✅ **日志改进**（时间戳 + 等级 + 轮转）
3. ✅ **启用监控组件**（核心功能）
4. ✅ **创建 session_messages 表**（消息追溯）
5. ✅ **错误消息细化**（提升体验）
6. ✅ **熔断器 + 重试机制**（提高可用性）
7. ✅ **健康检查端点**（运维支持）

---

## 预估工作量

- 第一阶段（1-2）：2-3 小时
- 第二阶段（3-4）：3-4 小时
- 第三阶段（5-6）：2-3 小时
- 第四阶段（7）：1 小时

**总计**：8-11 小时

---

## 测试计划

每个阶段完成后进行测试：

1. **消息去重测试**：重启服务，验证历史消息不会重复处理
2. **日志测试**：检查日志时间戳格式，验证轮转功能
3. **监控测试**：触发错误，检查 session_events 表记录
4. **消息记录测试**：发送消息，检查 session_messages 表
5. **错误处理测试**：模拟各种错误，验证提示信息
6. **重试测试**：模拟 API 临时故障，验证重试和熔断
7. **健康检查测试**：访问 /health 端点，验证返回数据

---

## 风险评估

- **数据库迁移风险**：新增表不影响现有功能，风险低
- **性能风险**：消息去重查询数据库可能影响性能，需要索引优化
- **兼容性风险**：日志格式变化可能影响现有日志解析工具
- **测试风险**：监控组件从未使用过，可能存在未知 bug

---

## 回滚方案

如果出现问题，可以快速回滚：

1. 保留旧版本代码（git tag）
2. 数据库表可以保留，不影响旧版本运行
3. 日志格式向后兼容，旧代码仍可使用

---

## 下一步

等待确认后开始实施第一阶段。
