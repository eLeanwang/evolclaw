# EvolClaw 设计方案改进建议

## 当前设计回顾

基于已完成的设计文档（ARCHITECTURE.md、GATEWAY.md、SESSION-DESIGN.md、SESSION-ID-MAPPING.md），EvolClaw 的核心设计：

**架构特点**：
- Gateway 模式：每个会话独立的 Claude Code 进程
- 三层映射：渠道ID → EvolClaw会话ID → 项目路径 + Claude会话ID
- 会话隔离：每个渠道会话独立的对话历史
- 项目共享：多个会话可操作同一项目文件

**技术栈**：
- 飞书：简化的单一连接
- ACP：基础协议支持
- 并发：InstanceManager 实例池
- 通信：stdin/stdout IPC

---

## 核心问题分析

### 1. Feishu 模块缺少生产级可靠性

**问题**：
```typescript
// 当前设计（简化版）
class FeishuChannel implements IChannel {
  private client: lark.Client;
  private wsClient: lark.WSClient;

  async connect(): Promise<void> {
    this.wsClient = new lark.WSClient({ appId, appSecret });
    await this.wsClient.start({ eventDispatcher });
  }
}
```

**缺失的关键特性**：
- ❌ 无健康检查（无法检测 WebSocket 断线）
- ❌ 无自动重连（断线后需手动重启）
- ❌ 无消息去重（可能重复处理消息）
- ❌ 无 Backfill 机制（重连后丢失消息）
- ❌ 无热重连支持（重启时堆积消息全部处理）

**影响**：
- 生产环境不可用（网络抖动导致服务中断）
- 消息可能丢失或重复
- 重启后消息风暴

---

### 2. 并发控制不足

**问题**：
```typescript
// 当前设计（事件驱动）
feishuChannel.on('message', async (channelId, content) => {
  const session = await sessionManager.getOrCreateSession('feishu', channelId);
  const instance = await instanceManager.getOrCreateInstance(session.id, session.projectPath);
  const result = await instance.query(content);
  await feishuChannel.sendMessage(channelId, result);
});
```

**缺失的关键特性**：
- ❌ 无会话级消息队列（同一会话的消息可能并发执行）
- ❌ 无全局并发限制（可能同时启动过多实例）
- ❌ 无消息顺序保证（后发的消息可能先处理）
- ❌ 无失败重试机制

**影响**：
- 消息顺序混乱（用户体验差）
- 资源耗尽（内存/CPU 爆满）
- 实例启动失败（无重试）

---

### 3. IPC 通信机制缺失

**问题**：
```typescript
// 当前设计（无 IPC 注入）
class ClaudeInstance {
  async query(prompt: string): Promise<string> {
    // 通过 stdin 发送，等待 stdout 响应
    this.process.stdin.write(JSON.stringify({ prompt }));
    return await this.readResponse();
  }
}
```

**缺失的关键特性**：
- ❌ 实例运行中无法接收新消息（需等待当前查询完成）
- ❌ 无 IPC 文件通道（无法异步注入消息）
- ❌ 无消息队列（新消息会阻塞或丢失）

**影响**：
- 用户体验差（发送新消息需等待）
- 消息可能丢失（实例忙时）
- 无法实现流式交互

---

### 4. 会话管理过于简化

**问题**：
```typescript
// 当前设计（单表设计）
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  UNIQUE(channel, channel_id)
);
```

**缺失的关键特性**：
- ❌ 无会话元数据（创建时间、最后活跃时间、标签等）
- ❌ 无会话状态管理（active/idle/archived）
- ❌ 无会话清理机制（长期不活跃的会话）
- ❌ 无会话分组功能

**影响**：
- 会话管理混乱
- 数据库膨胀
- 无法实现高级功能（会话搜索、统计等）

---

## 改进建议

### 改进 #1：引入生产级 Feishu 连接管理

**方案**：直接复用 HappyClaw 的 `createFeishuConnection` 工厂函数

**实现**：
```typescript
// evolclaw/src/channels/feishu.ts
import { createFeishuConnection, FeishuConnection } from 'happyclaw/src/feishu.js';

export class FeishuChannel implements IChannel {
  private connection: FeishuConnection | null = null;

  async connect(config: FeishuConfig): Promise<void> {
    this.connection = createFeishuConnection({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    await this.connection.connect({
      onReady: () => {
        logger.info('Feishu connected');
      },
      onNewChat: async (chatJid: string, chatName: string) => {
        const channelId = chatJid.replace('feishu:', '');
        await this.handleNewChat(channelId, chatName);
      },
      ignoreMessagesBefore: Date.now(),
      onCommand: async (chatJid: string, command: string) => {
        return await this.handleCommand(chatJid, command);
      },
    });
  }

  private async handleNewChat(channelId: string, chatName: string): Promise<void> {
    // 创建或获取会话
    const session = await sessionManager.getOrCreateSession('feishu', channelId);
    logger.info({ channelId, sessionId: session.id }, 'New Feishu chat registered');
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.connection) {
      throw new Error('Feishu connection not initialized');
    }
    await this.connection.sendMessage(channelId, text);
  }

  async stop(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = null;
    }
  }
}
```

**收益**：
- ✅ 获得完整的健康检查和自动重连
- ✅ 获得消息去重和 Backfill
- ✅ 获得热重连支持
- ✅ 代码复用，减少维护成本

---

### 改进 #2：实现会话级消息队列

**方案**：引入 SessionQueue 管理器

**实现**：
```typescript
// evolclaw/src/core/session-queue.ts
interface QueuedMessage {
  prompt: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timestamp: number;
}

export class SessionQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private activeExecutions = new Set<string>();
  private maxConcurrent = 20;

  async enqueue(sessionId: string, prompt: string): Promise<any> {
    // 检查全局并发限制
    if (this.activeExecutions.size >= this.maxConcurrent) {
      logger.warn({ sessionId }, 'Global concurrency limit reached, queueing message');
    }

    // 如果会话空闲且未达到全局限制，立即执行
    if (!this.activeExecutions.has(sessionId) && this.activeExecutions.size < this.maxConcurrent) {
      return this.execute(sessionId, prompt);
    }

    // 否则入队等待
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) || [];
      queue.push({ prompt, resolve, reject, timestamp: Date.now() });
      this.queues.set(sessionId, queue);
      logger.debug({ sessionId, queueLength: queue.length }, 'Message queued');
    });
  }

  private async execute(sessionId: string, prompt: string): Promise<any> {
    this.activeExecutions.add(sessionId);
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      const instance = await instanceManager.getOrCreateInstance(sessionId, session.projectPath);
      const result = await instance.query(prompt);
      return result;
    } finally {
      this.activeExecutions.delete(sessionId);
      this.processNext(sessionId);
    }
  }

  private processNext(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    // 检查全局并发限制
    if (this.activeExecutions.size >= this.maxConcurrent) {
      logger.debug('Global concurrency limit reached, deferring next message');
      return;
    }

    const next = queue.shift()!;
    this.execute(sessionId, next.prompt)
      .then(next.resolve)
      .catch(next.reject);
  }

  getQueueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length || 0;
  }

  isActive(sessionId: string): boolean {
    return this.activeExecutions.has(sessionId);
  }
}

// 使用
const sessionQueue = new SessionQueue();

// 消息到达时入队
feishuChannel.on('message', async (channelId, content) => {
  const session = await sessionManager.getOrCreateSession('feishu', channelId);
  const result = await sessionQueue.enqueue(session.id, content);
  await feishuChannel.sendMessage(channelId, result);
});
```

**收益**：
- ✅ 保证消息顺序（同一会话串行执行）
- ✅ 全局并发控制（最多 20 个实例）
- ✅ 自动队列管理（忙时排队，闲时立即执行）

---

### 改进 #3：实现 IPC 消息注入

**方案**：为 ClaudeInstance 添加 IPC 文件通道

**实现**：
```typescript
// evolclaw/src/gateway/claude-instance.ts
import fs from 'fs';
import path from 'path';

export class ClaudeInstance extends EventEmitter {
  private ipcDir: string;
  private ipcWatcher: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    // 创建 IPC 目录
    this.ipcDir = path.join('/tmp/evolclaw-ipc', this.sessionId);
    fs.mkdirSync(path.join(this.ipcDir, 'input'), { recursive: true });

    // 启动 Claude Code 进程
    this.process = spawn('claude', ['code'], {
      cwd: this.projectPath,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: this.claudeSessionId || '',
        IPC_INPUT_DIR: path.join(this.ipcDir, 'input'),
      },
    });

    // 启动 IPC 监听
    this.startIpcWatcher();

    this.state = 'RUNNING';
    this.emit('started');
  }

  async query(prompt: string): Promise<string> {
    if (this.state === 'IDLE') {
      // 空闲状态：直接通过 stdin 发送
      return this.queryViaStdin(prompt);
    } else if (this.state === 'BUSY') {
      // 忙碌状态：通过 IPC 文件注入
      return this.queryViaIpc(prompt);
    } else {
      throw new Error(`Cannot query in state: ${this.state}`);
    }
  }

  private async queryViaStdin(prompt: string): Promise<string> {
    this.state = 'BUSY';
    try {
      this.process.stdin.write(JSON.stringify({ prompt }) + '\n');
      const result = await this.readResponse();
      return result;
    } finally {
      this.state = 'IDLE';
    }
  }

  private async queryViaIpc(prompt: string): Promise<string> {
    // 写入 IPC 文件
    const msgFile = path.join(this.ipcDir, 'input', `${Date.now()}.json`);
    fs.writeFileSync(msgFile, JSON.stringify({ prompt }));

    // 等待响应（通过事件）
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('IPC query timeout'));
      }, 60000);

      this.once('ipc-response', (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  private startIpcWatcher(): void {
    this.ipcWatcher = setInterval(() => {
      const inputDir = path.join(this.ipcDir, 'input');
      if (!fs.existsSync(inputDir)) return;

      const files = fs.readdirSync(inputDir);
      for (const file of files) {
        const filePath = path.join(inputDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const { prompt } = JSON.parse(content);

          // 注入到 Claude Code 实例（通过 stdin）
          this.process.stdin.write(JSON.stringify({ prompt }) + '\n');

          // 删除已处理的文件
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ err, file }, 'Failed to process IPC message');
        }
      }
    }, 1000);
  }

  async stop(): Promise<void> {
    if (this.ipcWatcher) {
      clearInterval(this.ipcWatcher);
      this.ipcWatcher = null;
    }

    // 清理 IPC 目录
    if (fs.existsSync(this.ipcDir)) {
      fs.rmSync(this.ipcDir, { recursive: true, force: true });
    }

    // ... 停止进程
  }
}
```

**收益**：
- ✅ 实例运行中可接收新消息
- ✅ 异步消息注入（不阻塞）
- ✅ 支持流式交互

---

### 改进 #4：增强会话管理

**方案**：扩展 sessions 表，增加元数据和状态管理

**实现**：
```sql
-- 改进后的 sessions 表
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT DEFAULT 'active',  -- 'active' | 'idle' | 'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  tags TEXT,  -- JSON array
  metadata TEXT,  -- JSON object
  UNIQUE(channel, channel_id)
);

-- 索引
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_last_active ON sessions(last_active_at);
CREATE INDEX idx_sessions_channel ON sessions(channel, channel_id);
```

```typescript
// evolclaw/src/core/session-manager.ts
interface SessionMetadata {
  displayName?: string;
  description?: string;
  owner?: string;
  [key: string]: any;
}

export class SessionManager {
  async getOrCreateSession(
    channel: string,
    channelId: string,
    options?: {
      projectPath?: string;
      metadata?: SessionMetadata;
      tags?: string[];
    }
  ): Promise<Session> {
    // 查询现有会话
    let session = db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ?
    `).get(channel, channelId);

    if (session) {
      // 更新最后活跃时间
      db.prepare(`
        UPDATE sessions
        SET last_active_at = ?, updated_at = ?, message_count = message_count + 1
        WHERE id = ?
      `).run(Date.now(), Date.now(), session.id);

      return session;
    }

    // 创建新会话
    const id = this.generateSessionId(channel, channelId);
    const now = Date.now();

    db.prepare(`
      INSERT INTO sessions (
        id, channel, channel_id, project_path, status,
        created_at, updated_at, last_active_at, message_count,
        tags, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      channel,
      channelId,
      options?.projectPath || config.defaultProjectPath,
      'active',
      now,
      now,
      now,
      0,
      JSON.stringify(options?.tags || []),
      JSON.stringify(options?.metadata || {})
    );

    return this.getSession(id);
  }

  async archiveInactiveSessions(inactiveDays: number = 30): Promise<number> {
    const threshold = Date.now() - inactiveDays * 24 * 60 * 60 * 1000;

    const result = db.prepare(`
      UPDATE sessions
      SET status = 'archived', updated_at = ?
      WHERE status = 'active' AND last_active_at < ?
    `).run(Date.now(), threshold);

    return result.changes;
  }

  async searchSessions(query: {
    channel?: string;
    status?: string;
    tags?: string[];
    projectPath?: string;
  }): Promise<Session[]> {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: any[] = [];

    if (query.channel) {
      sql += ' AND channel = ?';
      params.push(query.channel);
    }

    if (query.status) {
      sql += ' AND status = ?';
      params.push(query.status);
    }

    if (query.projectPath) {
      sql += ' AND project_path = ?';
      params.push(query.projectPath);
    }

    if (query.tags && query.tags.length > 0) {
      // 简单的标签匹配（生产环境建议使用 FTS）
      for (const tag of query.tags) {
        sql += ` AND tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    sql += ' ORDER BY last_active_at DESC';

    return db.prepare(sql).all(...params);
  }

  private generateSessionId(channel: string, channelId: string): string {
    const timestamp = Date.now();
    const shortChannelId = channelId.substring(0, 20);
    return `${channel}-${shortChannelId}-${timestamp}`;
  }
}
```

**收益**：
- ✅ 完整的会话元数据
- ✅ 会话状态管理（active/idle/archived）
- ✅ 自动归档不活跃会话
- ✅ 支持会话搜索和统计

---

### 改进 #5：实现故障恢复机制

**方案**：为 InstanceManager 添加自动重试和重启

**实现**：
```typescript
// evolclaw/src/gateway/failure-handler.ts
export class FailureHandler {
  private retryAttempts = new Map<string, number>();
  private restartCounts = new Map<string, number>();
  private readonly MAX_RETRIES = 3;
  private readonly MAX_RESTARTS = 5;
  private readonly RESTART_COOLDOWN = 60000; // 60s

  constructor(private instanceManager: InstanceManager) {
    // 监听实例错误
    instanceManager.on('instanceError', (sessionId, error) => {
      this.handleInstanceError(sessionId, error);
    });

    // 监听实例退出
    instanceManager.on('instanceExit', (sessionId, code) => {
      this.handleInstanceExit(sessionId, code);
    });
  }

  private async handleInstanceError(sessionId: string, error: Error): Promise<void> {
    const attempts = this.retryAttempts.get(sessionId) || 0;

    if (attempts < this.MAX_RETRIES) {
      // 指数退避重试
      const delay = Math.pow(2, attempts) * 1000;
      logger.warn(
        { sessionId, attempts, delay, error: error.message },
        'Instance error, retrying'
      );

      this.retryAttempts.set(sessionId, attempts + 1);

      setTimeout(async () => {
        try {
          await this.instanceManager.restartInstance(sessionId);
          this.retryAttempts.delete(sessionId);
        } catch (err) {
          logger.error({ sessionId, err }, 'Retry failed');
        }
      }, delay);
    } else {
      logger.error(
        { sessionId, attempts },
        'Max retries exceeded, giving up'
      );
      this.retryAttempts.delete(sessionId);
    }
  }

  private async handleInstanceExit(sessionId: string, code: number): Promise<void> {
    if (code === 0) {
      // 正常退出，清理计数
      this.restartCounts.delete(sessionId);
      return;
    }

    const restarts = this.restartCounts.get(sessionId) || 0;

    if (restarts < this.MAX_RESTARTS) {
      logger.warn(
        { sessionId, restarts, exitCode: code },
        'Instance crashed, restarting'
      );

      this.restartCounts.set(sessionId, restarts + 1);

      // 冷却时间后重启
      setTimeout(async () => {
        try {
          await this.instanceManager.restartInstance(sessionId);
        } catch (err) {
          logger.error({ sessionId, err }, 'Restart failed');
        }
      }, this.RESTART_COOLDOWN);
    } else {
      logger.error(
        { sessionId, restarts },
        'Max restarts exceeded, instance disabled'
      );
      this.restartCounts.delete(sessionId);
    }
  }
}
```

**收益**：
- ✅ 自动重试（指数退避）
- ✅ 自动重启（崩溃恢复）
- ✅ 防止无限重启（最大次数限制）

---

### 改进 #6：优化实例生命周期管理

**方案**：为 InstanceManager 添加预热和清理机制

**实现**：
```typescript
// evolclaw/src/gateway/instance-manager.ts
export class InstanceManager extends EventEmitter {
  private instances = new Map<string, ClaudeInstance>();
  private readonly IDLE_TIMEOUT = 30 * 60 * 1000; // 30分钟
  private readonly MAX_INSTANCES = 20;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startCleanupLoop();
  }

  async getOrCreateInstance(
    sessionId: string,
    projectPath: string
  ): Promise<ClaudeInstance> {
    let instance = this.instances.get(sessionId);

    if (instance && instance.state !== 'STOPPED') {
      // 更新最后活跃时间
      instance.updateLastActive();
      return instance;
    }

    // 检查实例数量限制
    if (this.instances.size >= this.MAX_INSTANCES) {
      // 清理最旧的空闲实例
      await this.cleanupOldestIdleInstance();
    }

    // 创建新实例
    instance = new ClaudeInstance(sessionId, projectPath);

    // 监听实例事件
    instance.on('error', (error) => {
      this.emit('instanceError', sessionId, error);
    });

    instance.on('exit', (code) => {
      this.emit('instanceExit', sessionId, code);
      this.instances.delete(sessionId);
    });

    await instance.start();
    this.instances.set(sessionId, instance);

    logger.info(
      { sessionId, totalInstances: this.instances.size },
      'Instance created'
    );

    return instance;
  }

  async warmupInstance(sessionId: string, projectPath: string): Promise<void> {
    // 预热实例（提前启动，减少首次查询延迟）
    if (this.instances.has(sessionId)) return;

    const instance = new ClaudeInstance(sessionId, projectPath);
    await instance.start();
    this.instances.set(sessionId, instance);

    logger.info({ sessionId }, 'Instance warmed up');
  }

  private startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleInstances();
    }, 60000); // 每分钟检查一次

    this.cleanupTimer.unref();
  }

  private async cleanupIdleInstances(): Promise<void> {
    const now = Date.now();
    const toCleanup: string[] = [];

    for (const [sessionId, instance] of this.instances.entries()) {
      if (instance.state === 'IDLE' && now - instance.lastActiveAt > this.IDLE_TIMEOUT) {
        toCleanup.push(sessionId);
      }
    }

    for (const sessionId of toCleanup) {
      const instance = this.instances.get(sessionId);
      if (instance) {
        await instance.stop();
        this.instances.delete(sessionId);
        logger.info({ sessionId }, 'Idle instance cleaned up');
      }
    }
  }

  private async cleanupOldestIdleInstance(): Promise<void> {
    let oldestSessionId: string | null = null;
    let oldestTime = Infinity;

    for (const [sessionId, instance] of this.instances.entries()) {
      if (instance.state === 'IDLE' && instance.lastActiveAt < oldestTime) {
        oldestTime = instance.lastActiveAt;
        oldestSessionId = sessionId;
      }
    }

    if (oldestSessionId) {
      const instance = this.instances.get(oldestSessionId);
      if (instance) {
        await instance.stop();
        this.instances.delete(oldestSessionId);
        logger.info({ sessionId: oldestSessionId }, 'Oldest idle instance cleaned up');
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // 停止所有实例
    for (const [sessionId, instance] of this.instances.entries()) {
      await instance.stop();
    }

    this.instances.clear();
  }
}
```

**收益**：
- ✅ 自动清理空闲实例（节省资源）
- ✅ 实例数量限制（防止资源耗尽）
- ✅ 支持实例预热（减少首次延迟）

---

## 实施优先级

### 高优先级（立即实施）

**1. 引入生产级 Feishu 连接管理（改进 #1）**
- 复用 HappyClaw 的 `createFeishuConnection`
- 获得完整的可靠性保障
- 实施成本：低（直接复用）

**2. 实现会话级消息队列（改进 #2）**
- 保证消息顺序
- 全局并发控制
- 实施成本：中（需新增模块）

### 中优先级（后续优化）

**3. 实现 IPC 消息注入（改进 #3）**
- 支持实例运行中接收消息
- 提升用户体验
- 实施成本：中（需修改 ClaudeInstance）

**4. 增强会话管理（改进 #4）**
- 完整的元数据和状态管理
- 支持会话搜索
- 实施成本：低（扩展数据库表）

### 低优先级（长期规划）

**5. 实现故障恢复机制（改进 #5）**
- 自动重试和重启
- 提升系统稳定性
- 实施成本：中

**6. 优化实例生命周期管理（改进 #6）**
- 自动清理和预热
- 优化资源使用
- 实施成本：低

---

## 总结

### 核心改进方向

1. **生产级可靠性**：复用 HappyClaw 的成熟组件
2. **并发控制**：会话级队列 + 全局限制
3. **IPC 通信**：支持运行中消息注入
4. **会话管理**：完整的元数据和状态
5. **故障恢复**：自动重试和重启
6. **生命周期**：自动清理和预热

### 实施路径

**阶段1（高优先级）**：
- 集成 HappyClaw 的 Feishu 连接
- 实现 SessionQueue

**阶段2（中优先级）**：
- 实现 IPC 消息注入
- 扩展会话管理

**阶段3（低优先级）**：
- 实现故障恢复
- 优化实例生命周期

### 预期收益

- ✅ 生产环境可用（可靠性保障）
- ✅ 消息顺序正确（用户体验好）
- ✅ 资源使用合理（并发控制）
- ✅ 系统稳定性高（故障恢复）

### 与 HappyClaw 的关系

**复用部分**：
- Feishu 连接管理（完整复用）
- 消息队列机制（借鉴设计）
- IPC 通信协议（借鉴设计）

**保持独立**：
- 会话映射机制（三层映射 vs 二层映射）
- 执行模式（进程 vs 容器）
- 会话隔离策略（强制隔离 vs 可选隔离）

**建议**：将 Feishu 连接管理提取为独立的 npm 包，供两个项目共享。
