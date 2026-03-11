# EvolClaw 轻量化改进方案

## 设计原则

1. **最小化数据库表**：只保留核心业务表
2. **日志驱动监控**：用独立日志文件替代数据库表
3. **配置驱动**：高级功能通过环境变量控制
4. **简单重试**：移除复杂的熔断器机制

---

## 架构调整

### 简化前（6 层 + 4 张表）
```
6 层架构：
- Message Channel Layer
- Message Queue Layer
- Monitoring Layer（HookCollector + CircuitBreaker + StateRecovery + Notification）
- Session Management Layer
- Instance Management Layer
- Storage Layer

数据库表：
- sessions
- processed_messages
- session_messages
- session_events
```

### 简化后（4 层 + 2 张表）
```
4 层架构：
- Channel Layer（消息渠道）
- Session Layer（会话管理）
- Agent Layer（Claude SDK 封装）
- Storage Layer（数据库 + 日志）

数据库表：
- sessions（会话管理）
- processed_messages（消息去重）

日志文件：
- logs/evolclaw.log（系统运行，必需）
- logs/messages.log（消息追溯，可选）
- logs/events.log（Hook 事件，可选）
```

---

## 数据库设计

### 1. 保留的表

#### sessions 表（已有，无需修改）
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, channel_id, project_path)
);
```

#### processed_messages 表（新增）
```sql
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE INDEX idx_processed_at ON processed_messages(processed_at);
```

**用途**：防止飞书重推的历史消息被重复处理

**清理策略**：定期删除 24 小时前的记录
```sql
DELETE FROM processed_messages WHERE processed_at < ?
```

### 2. 移除的表

- ❌ `session_messages`（用 messages.log 替代）
- ❌ `session_events`（用 events.log 替代）

---

## 日志系统设计

### 1. 日志文件结构

```
logs/
  evolclaw.log      # 系统运行日志（必需）
  messages.log      # 消息追溯日志（可选，MESSAGE_LOG=true）
  events.log        # Hook 事件日志（可选，EVENT_LOG=true）
```

### 2. 日志格式

#### evolclaw.log（人类可读）
```
[2026-03-09T05:45:21.931Z] [INFO] Feishu connected
[2026-03-09T05:45:22.100Z] [INFO] Session created: session_xxx
[2026-03-09T05:45:25.678Z] [ERROR] API error: 429 rate limit
```

#### messages.log（JSONL 格式）
```json
{"ts":"2026-03-09T05:45:21.931Z","msgId":"xxx","sessionId":"yyy","dir":"inbound","status":"received"}
{"ts":"2026-03-09T05:45:23.142Z","msgId":"xxx","sessionId":"yyy","dir":"inbound","status":"processing"}
{"ts":"2026-03-09T05:45:25.678Z","msgId":"xxx","sessionId":"yyy","dir":"inbound","status":"completed","duration":3747}
{"ts":"2026-03-09T05:45:25.890Z","msgId":"zzz","sessionId":"yyy","dir":"outbound","status":"sent"}
```

#### events.log（JSONL 格式）
```json
{"ts":"2026-03-09T05:45:23.500Z","type":"stop","sessionId":"yyy","data":{}}
{"ts":"2026-03-09T05:45:24.200Z","type":"post_tool_use","sessionId":"yyy","tool":"read_file"}
```

### 3. 日志轮转

使用简单的启动脚本检查文件大小：

```bash
#!/bin/bash
# evolclaw.sh

# 日志轮转（超过 10MB）
for log in logs/*.log; do
  if [ -f "$log" ]; then
    size=$(stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null)
    if [ "$size" -gt 10485760 ]; then
      mv "$log" "$log.$(date +%Y%m%d_%H%M%S)"
    fi
  fi
done

# 清理 7 天前的旧日志
find logs/ -name "*.log.*" -mtime +7 -delete

# 启动服务
node dist/index.js
```

---

## 代码实现

### 1. Logger 工具（新增）

**文件**：`src/utils/logger.ts`

```typescript
import fs from 'fs';
import path from 'path';

const LOG_DIR = 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// 配置开关
const config = {
  messageLog: process.env.MESSAGE_LOG === 'true',
  eventLog: process.env.EVENT_LOG === 'true'
};

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 创建写入流
const streams = {
  main: fs.createWriteStream(path.join(LOG_DIR, 'evolclaw.log'), { flags: 'a' }),
  message: config.messageLog ? fs.createWriteStream(path.join(LOG_DIR, 'messages.log'), { flags: 'a' }) : null,
  event: config.eventLog ? fs.createWriteStream(path.join(LOG_DIR, 'events.log'), { flags: 'a' }) : null
};

function shouldLog(level: string): boolean {
  return LEVELS[level as keyof typeof LEVELS] >= LEVELS[LOG_LEVEL as keyof typeof LEVELS];
}

function write(stream: fs.WriteStream | null, data: any) {
  if (!stream) return;
  const line = typeof data === 'string' ? data : JSON.stringify(data);
  stream.write(`${line}\n`);
}

function log(level: string, ...args: any[]) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] [${level}] ${args.join(' ')}`;
  console.log(msg);
  write(streams.main, msg);
}

export const logger = {
  debug: (...args: any[]) => log('DEBUG', ...args),
  info: (...args: any[]) => log('INFO', ...args),
  warn: (...args: any[]) => log('WARN', ...args),
  error: (...args: any[]) => log('ERROR', ...args),

  // 消息日志（JSONL 格式）
  message: (data: any) => {
    write(streams.message, { ts: new Date().toISOString(), ...data });
  },

  // 事件日志（JSONL 格式）
  event: (data: any) => {
    write(streams.event, { ts: new Date().toISOString(), ...data });
  }
};
```

### 2. 消息去重实现

**文件**：`src/channels/feishu.ts`（修改）

```typescript
// 移除内存 Map，改用数据库查询
private async isDuplicate(messageId: string): Promise<boolean> {
  const result = this.db.prepare(
    'SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1'
  ).get(messageId);
  return !!result;
}

private async markSeen(messageId: string, channelId: string): Promise<void> {
  this.db.prepare(
    'INSERT OR IGNORE INTO processed_messages (message_id, channel, channel_id, processed_at) VALUES (?, ?, ?, ?)'
  ).run(messageId, 'feishu', channelId, Date.now());
}

// 定期清理（在 connect() 中启动）
private startCleanupTask() {
  setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 小时前
    const result = this.db.prepare(
      'DELETE FROM processed_messages WHERE processed_at < ?'
    ).run(cutoff);
    if (result.changes > 0) {
      logger.info(`Cleaned ${result.changes} old processed messages`);
    }
  }, 60 * 60 * 1000); // 每小时清理一次
}
```

### 3. 消息处理流程（添加日志）

**文件**：`src/index.ts`（修改）

```typescript
// 在消息处理流程中添加日志
feishu.onMessage(async (messageId, senderId, content) => {
  try {
    // 记录收到消息
    logger.message({
      msgId: messageId,
      sessionId: session.id,
      dir: 'inbound',
      status: 'received'
    });

    // 处理消息
    logger.message({
      msgId: messageId,
      sessionId: session.id,
      dir: 'inbound',
      status: 'processing'
    });

    const startTime = Date.now();
    const response = await agentRunner.runQuery(content, session.claudeSessionId);
    const duration = Date.now() - startTime;

    // 记录处理完成
    logger.message({
      msgId: messageId,
      sessionId: session.id,
      dir: 'inbound',
      status: 'completed',
      duration
    });

    // 发送响应
    await feishu.sendMessage(senderId, response);

    logger.message({
      msgId: `${messageId}_reply`,
      sessionId: session.id,
      dir: 'outbound',
      status: 'sent'
    });

  } catch (error) {
    logger.error('Message processing failed:', error);
    logger.message({
      msgId: messageId,
      sessionId: session.id,
      dir: 'inbound',
      status: 'failed',
      error: error.message
    });

    await feishu.sendMessage(senderId, getErrorMessage(error));
  }
});
```

### 4. Hook 事件记录

**文件**：`src/gateway/claude-instance.ts`（修改）

```typescript
import { logger } from '../utils/logger.js';

// 在 Hook 回调中记录事件
this.agent.onStop((input) => {
  logger.event({
    type: 'stop',
    sessionId: this.sessionId,
    data: input
  });
  this.emit('hook', { type: 'stop', data: input });
});

this.agent.onPostToolUse((input) => {
  logger.event({
    type: 'post_tool_use',
    sessionId: this.sessionId,
    tool: input.tool_name
  });
  this.emit('hook', { type: 'post_tool_use', data: input });
});
```

### 5. 错误消息细化

**文件**：`src/utils/error-handler.ts`（新增）

```typescript
export function getErrorMessage(error: any): string {
  const msg = error?.message || String(error);

  if (msg.includes('API Error: 400')) {
    return '⚠️ 请求格式错误，请检查输入内容';
  }
  if (msg.includes('API Error: 500')) {
    return '⚠️ API 服务暂时不可用，请稍后重试';
  }
  if (msg.includes('API Error: 429')) {
    return '⚠️ 请求过于频繁，请稍后再试';
  }
  if (msg.includes('timeout')) {
    return '⚠️ 请求超时，请重试';
  }
  if (msg.includes('permission') || msg.includes('im:resource')) {
    return '⚠️ 权限不足，请联系管理员配置应用权限';
  }

  return '⚠️ 处理消息时出错，请稍后重试';
}
```

### 6. 简单重试机制

**文件**：`src/utils/retry.ts`（新增）

```typescript
export async function simpleRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 最后一次失败直接抛出
      if (i === maxRetries - 1) {
        throw error;
      }

      // 线性退避：1s, 2s, 3s
      const delay = (i + 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

**使用示例**：
```typescript
import { simpleRetry } from './utils/retry.js';

// 在 AgentRunner.runQuery() 中使用
const response = await simpleRetry(async () => {
  return await this.instance.query(message, options);
}, 3);
```

---

## 数据库迁移

### 迁移脚本

**文件**：`src/core/database.ts`（修改）

```typescript
import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // 启用 WAL 模式（性能优化）
  db.pragma('journal_mode = WAL');

  // 创建 processed_messages 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      processed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_processed_at
    ON processed_messages(processed_at);
  `);

  logger.info('Database initialized');
  return db;
}
```

---

## 配置说明

### 环境变量

```bash
# 日志等级（DEBUG | INFO | WARN | ERROR）
LOG_LEVEL=INFO

# 启用消息追溯日志
MESSAGE_LOG=true

# 启用 Hook 事件日志
EVENT_LOG=false
```

### 启动脚本

**文件**：`evolclaw.sh`（修改）

```bash
#!/bin/bash

# 配置环境变量
export LOG_LEVEL=INFO
export MESSAGE_LOG=true
export EVENT_LOG=false

# 日志轮转
for log in logs/*.log; do
  if [ -f "$log" ]; then
    size=$(stat -f%z "$log" 2>/dev/null || stat -c%s "$log" 2>/dev/null)
    if [ "$size" -gt 10485760 ]; then
      mv "$log" "$log.$(date +%Y%m%d_%H%M%S)"
    fi
  fi
done

# 清理 7 天前的旧日志
find logs/ -name "*.log.*" -mtime +7 -delete

# 启动服务
node dist/index.js
```

---

## 移除的组件

### 1. 监控组件
- ❌ `src/monitor/state-recovery.ts`（删除）
- ❌ `src/monitor/notification.ts`（删除）
- ❌ `src/monitor/circuit-breaker.ts`（删除或改为可选）
- ✅ `src/monitor/hook-collector.ts`（简化为日志输出）

### 2. 健康检查
- ❌ HTTP 服务器相关代码（删除）
- ❌ `/health` 端点（删除）

---

## 实施步骤

### 阶段 1：基础设施（1-2 小时）

1. **创建 logger 工具**
   - 新建 `src/utils/logger.ts`
   - 实现日志等级控制
   - 实现独立日志文件

2. **创建 processed_messages 表**
   - 修改 `src/core/database.ts`
   - 添加表创建和索引

3. **修改消息去重逻辑**
   - 修改 `src/channels/feishu.ts`
   - 移除内存 Map
   - 改用数据库查询

### 阶段 2：日志集成（1-2 小时）

4. **替换现有日志**
   - 全局替换 `console.log` 为 `logger.info`
   - 全局替换 `console.error` 为 `logger.error`

5. **添加消息追溯日志**
   - 在 `src/index.ts` 消息处理流程中添加 `logger.message()`

6. **添加 Hook 事件日志**
   - 在 `src/gateway/claude-instance.ts` Hook 回调中添加 `logger.event()`

### 阶段 3：错误处理（1 小时）

7. **创建错误处理工具**
   - 新建 `src/utils/error-handler.ts`
   - 实现错误消息细化

8. **创建重试工具**
   - 新建 `src/utils/retry.ts`
   - 实现简单重试机制

9. **集成到消息处理**
   - 在 `src/index.ts` 中使用 `getErrorMessage()`
   - 在 `src/agent-runner.ts` 中使用 `simpleRetry()`

### 阶段 4：清理（0.5 小时）

10. **移除废弃组件**
    - 删除 `src/monitor/state-recovery.ts`
    - 删除 `src/monitor/notification.ts`
    - 删除健康检查相关代码

11. **更新启动脚本**
    - 修改 `evolclaw.sh`
    - 添加日志轮转逻辑

---

## 测试计划

### 1. 消息去重测试
```bash
# 启动服务
npm run dev

# 发送测试消息
# 重启服务
# 飞书重推历史消息，验证不会重复处理
```

### 2. 日志测试
```bash
# 检查日志格式
tail -f logs/evolclaw.log

# 启用消息日志
MESSAGE_LOG=true npm run dev
tail -f logs/messages.log

# 启用事件日志
EVENT_LOG=true npm run dev
tail -f logs/events.log
```

### 3. 日志轮转测试
```bash
# 创建大文件模拟
dd if=/dev/zero of=logs/evolclaw.log bs=1M count=11

# 运行启动脚本
./evolclaw.sh

# 检查是否生成备份文件
ls -lh logs/
```

### 4. 错误处理测试
```bash
# 模拟 API 错误（修改 API key）
# 发送消息，验证错误提示

# 模拟超时（设置短超时时间）
# 发送消息，验证重试机制
```

### 5. 查询测试
```bash
# 查询特定消息
grep '"msgId":"xxx"' logs/messages.log | jq .

# 统计失败消息
grep '"status":"failed"' logs/messages.log | wc -l

# 查看特定会话事件
grep '"sessionId":"yyy"' logs/events.log | jq .
```

---

## 预估工作量

- 阶段 1：1-2 小时
- 阶段 2：1-2 小时
- 阶段 3：1 小时
- 阶段 4：0.5 小时

**总计**：3.5-5.5 小时

---

## 风险评估

### 低风险
- ✅ 新增 logger 工具（不影响现有功能）
- ✅ 新增 processed_messages 表（独立功能）
- ✅ 错误消息细化（只改提示文本）

### 中风险
- ⚠️ 移除内存 Map 改用数据库（需要性能测试）
- ⚠️ 全局替换日志调用（需要仔细检查）

### 缓解措施
- 保留 git tag 用于回滚
- 分阶段实施，每阶段测试后再继续
- 数据库查询添加索引优化性能

---

## 回滚方案

如果出现问题：

1. **代码回滚**
   ```bash
   git checkout <previous-tag>
   npm run build
   ```

2. **数据库兼容**
   - 新增的 `processed_messages` 表不影响旧版本
   - 可以保留表，旧代码仍可运行

3. **日志兼容**
   - 新日志格式向后兼容
   - 旧代码仍可使用 console.log

---

## 对比总结

| 项目 | 原计划 | 轻量化方案 |
|------|--------|------------|
| 数据库表 | 4 张 | 2 张 |
| 监控组件 | 4 个 | 0 个（日志替代）|
| 新增代码 | 500-800 行 | 200-300 行 |
| 工作量 | 8-11 小时 | 3.5-5.5 小时 |
| HTTP 依赖 | 需要 | 不需要 |
| 复杂度 | 中高 | 低 |

---

## 下一步

等待确认后开始实施阶段 1。
