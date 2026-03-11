# EvolClaw 轻量化改进方案

## 设计原则

**核心理念**：保持 EvolClaw 的轻量化特性，只引入最必要的改进。

**三个不变**：
1. 不引入容器（保持进程模式）
2. 不引入多用户（保持单用户）
3. 不引入完整 ACP 协议（保持简化）

**四个必改**：
1. 引入生产级 Feishu 连接（复用 HappyClaw）
2. 引入简化的消息队列（保证顺序）
3. 支持会话模式切换（shared/isolated）
4. 文件化会话日志（Agent 友好）

---

## 改进方案

### 改进 #1：复用 HappyClaw 的 Feishu 连接

**目标**：获得生产级可靠性，无需自己实现。

**实施**：
```typescript
// evolclaw/src/channels/feishu.ts
import { createFeishuConnection, FeishuConnection } from 'happyclaw/src/feishu.js';

export class FeishuChannel {
  private connection: FeishuConnection | null = null;

  async connect(config: { appId: string; appSecret: string }): Promise<void> {
    this.connection = createFeishuConnection(config);

    await this.connection.connect({
      onReady: () => console.log('Feishu connected'),
      onNewChat: async (chatJid, chatName) => {
        const channelId = chatJid.replace('feishu:', '');
        await this.handleMessage(channelId, '');  // 触发会话创建
      },
      ignoreMessagesBefore: Date.now(),
    });
  }

  private async handleMessage(channelId: string, content: string): Promise<void> {
    const session = await sessionManager.getOrCreateSession('feishu', channelId);
    const result = await messageQueue.enqueue(session.id, content);
    await this.connection!.sendMessage(channelId, result);
  }
}
```

**收益**：
- ✅ 健康检查 + 自动重连
- ✅ 消息去重 + Backfill
- ✅ 热重连支持
- ✅ 零额外复杂度（直接复用）

**实施成本**：低（仅需引入依赖）

---

### 改进 #2：简化的消息队列

**目标**：保证消息顺序，避免并发混乱。

**实施**：
```typescript
// evolclaw/src/core/message-queue.ts
export class MessageQueue {
  private queues = new Map<string, Array<{
    content: string;
    resolve: (result: any) => void;
    reject: (error: any) => void;
  }>>();
  private processing = new Set<string>();

  async enqueue(sessionId: string, content: string): Promise<any> {
    // 如果会话空闲，立即处理
    if (!this.processing.has(sessionId)) {
      return this.process(sessionId, content);
    }

    // 否则入队等待
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) || [];
      queue.push({ content, resolve, reject });
      this.queues.set(sessionId, queue);
    });
  }

  private async process(sessionId: string, content: string): Promise<any> {
    this.processing.add(sessionId);
    try {
      const session = await sessionManager.getSession(sessionId);
      const instance = await instanceManager.getOrCreateInstance(sessionId, session.projectPath);
      return await instance.query(content);
    } finally {
      this.processing.delete(sessionId);
      this.processNext(sessionId);
    }
  }

  private processNext(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    this.process(sessionId, next.content)
      .then(next.resolve)
      .catch(next.reject);
  }
}
```

**收益**：
- ✅ 保证消息顺序（同会话串行）
- ✅ 简单实现（不到 50 行代码）
- ✅ 无全局并发限制（保持轻量）

**实施成本**：低（独立模块）

---

### 改进 #3：支持会话模式切换

**目标**：支持个人助手（shared）和团队协作（isolated）两种场景。

**实施**：
```typescript
// evolclaw/src/core/session-manager.ts
interface SessionConfig {
  mode: 'shared' | 'isolated';  // 会话模式
  projectPath?: string;          // 项目路径
}

export class SessionManager {
  private config: SessionConfig = {
    mode: 'isolated',  // 默认隔离模式
  };

  setConfig(config: SessionConfig): void {
    this.config = config;
  }

  async getOrCreateSession(channel: string, channelId: string): Promise<Session> {
    if (this.config.mode === 'shared') {
      // 共享模式：所有该渠道的会话映射到同一个 session
      return this.getSharedSession(channel);
    } else {
      // 隔离模式：每个渠道会话独立 session
      return this.getIsolatedSession(channel, channelId);
    }
  }

  private async getSharedSession(channel: string): Promise<Session> {
    const sharedId = `${channel}-shared`;
    let session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sharedId);

    if (!session) {
      db.prepare(`
        INSERT INTO sessions (id, channel, channel_id, project_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sharedId, channel, 'shared', this.config.projectPath || './projects/default', Date.now());
      session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sharedId);
    }

    return session;
  }

  private async getIsolatedSession(channel: string, channelId: string): Promise<Session> {
    let session = db.prepare(`
      SELECT * FROM sessions WHERE channel = ? AND channel_id = ?
    `).get(channel, channelId);

    if (!session) {
      const id = `${channel}-${channelId}-${Date.now()}`;
      db.prepare(`
        INSERT INTO sessions (id, channel, channel_id, project_path, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, channel, channelId, this.config.projectPath || './projects/default', Date.now());
      session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    }

    return session;
  }
}
```

**配置文件**（config.json）：
```json
{
  "session": {
    "mode": "isolated",
    "projectPath": "./projects/default"
  }
}
```

**收益**：
- ✅ 支持两种场景（个人助手 + 团队协作）
- ✅ 简单配置（一个字段切换）
- ✅ 向后兼容（默认 isolated）

**实施成本**：低（修改现有代码）

---

### 改进 #4：混合式会话日志存储（Hook 驱动）

**目标**：平衡 Agent 友好性和功能完整性，通过 Hook 机制自动同步。

**核心思路**：利用 Claude Code SDK 的 Hook 机制，在特定事件触发时自动将 JSONL 内容同步到数据库元数据。

**问题分析**：

| 方案 | 优势 | 劣势 |
|------|------|------|
| **纯数据库** | 快速搜索、统计分析、消息操作 | Agent 不友好、需要 MCP 工具 |
| **纯文件** | Agent 友好、零维护 | 搜索慢、无元数据、跨项目断裂 |
| **混合（主动双写）** | 兼具两者优势 | 需要同步两处、代码耦合 |
| **混合（Hook 驱动）** | 兼具优势 + 解耦 | 依赖 SDK Hook |

**可用的 Hook 事件**：

Claude Code SDK 提供以下 Hook（来自 `@anthropic-ai/claude-agent-sdk`）：

```typescript
type HookEvent =
  | 'PreToolUse'          // 工具使用前
  | 'PostToolUse'         // 工具使用后 ✅
  | 'PostToolUseFailure'  // 工具失败后
  | 'UserPromptSubmit'    // 用户提交消息时
  | 'SessionStart'        // 会话开始
  | 'SessionEnd'          // 会话结束 ✅
  | 'PreCompact'          // 上下文压缩前 ✅
  | 'Stop'                // 停止
  | 'SubagentStart'       // 子代理启动
  | 'SubagentStop'        // 子代理停止
  | 'Notification'        // 通知
  | 'PermissionRequest'   // 权限请求
  | 'Setup'               // 设置
  | 'TeammateIdle'        // 团队成员空闲
  | 'TaskCompleted';      // 任务完成
```

**实施方案**：

**策略**：使用 `PostToolUse` + `PreCompact` 双重保障

- **PostToolUse**：每次工具使用后同步最新消息（接近实时）
- **PreCompact**：上下文压缩前全量同步（兜底机制，确保一致性）

**数据库表结构**：

```typescript
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  message_count INTEGER DEFAULT 0,
  last_synced_line INTEGER DEFAULT 0,  -- 已同步的 JSONL 行数
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(channel, channel_id)
);

CREATE TABLE message_metadata (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  sender TEXT NOT NULL,
  content_preview TEXT,
  content_length INTEGER,
  INDEX(session_id, timestamp),
  INDEX(timestamp)
);
```

**Hook 实现**：

```typescript
// evolclaw/src/core/message-sync.ts
import { readFile } from 'fs/promises';
import { join } from 'path';

export class MessageSync {
  // 同步最新消息（增量）
  async syncLatest(sessionId: string, projectPath: string): Promise<void> {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return;

    const jsonlPath = join(projectPath, '.claude/sessions', sessionId, 'messages.jsonl');
    const lines = (await readFile(jsonlPath, 'utf-8')).split('\n').filter(Boolean);

    // 只同步新增的行
    const newLines = lines.slice(session.last_synced_line);

    for (const line of newLines) {
      const msg = JSON.parse(line);
      db.prepare(`
        INSERT OR IGNORE INTO message_metadata
        (id, session_id, timestamp, sender, content_preview, content_length)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(msg.id, sessionId, msg.timestamp, msg.sender,
             msg.content.slice(0, 100), msg.content.length);
    }

    // 更新同步位置
    db.prepare(`
      UPDATE sessions
      SET last_synced_line = ?, message_count = ?, updated_at = ?
      WHERE id = ?
    `).run(lines.length, lines.length, Date.now(), sessionId);
  }

  // 全量同步（PreCompact 时使用）
  async syncAll(sessionId: string, projectPath: string): Promise<void> {
    // 重置同步位置，强制全量同步
    db.prepare('UPDATE sessions SET last_synced_line = 0 WHERE id = ?').run(sessionId);
    await this.syncLatest(sessionId, projectPath);
  }
}
```

**Claude Instance 配置**：

```typescript
// evolclaw/src/gateway/claude-instance.ts
import { ClaudeInstance } from '@anthropic-ai/claude-agent-sdk';

const messageSync = new MessageSync();

const instance = new ClaudeInstance({
  cwd: projectPath,
  sessionId: claudeSessionId,
  hooks: {
    // 每次工具使用后同步
    PostToolUse: [async (input) => {
      await messageSync.syncLatest(sessionId, projectPath);
    }],

    // 压缩前全量同步（兜底）
    PreCompact: [async (input) => {
      await messageSync.syncAll(sessionId, projectPath);
    }],

    // 会话结束时同步（可选）
    SessionEnd: [async (input) => {
      await messageSync.syncAll(sessionId, projectPath);
    }]
  }
});
```

**收益**：

- ✅ **解耦**：EvolClaw 不需要主动双写，SDK 触发同步
- ✅ **接近实时**：PostToolUse 后立即同步
- ✅ **可靠性**：PreCompact 兜底，确保一致性
- ✅ **Agent 友好**：JSONL 文件可直接读取
- ✅ **快速搜索**：数据库索引支持
- ✅ **代码简洁**：~80 行（vs 主动双写 ~100 行）

**代价**：

- ❌ 依赖 SDK Hook（但 SDK 稳定，风险低）
- ❌ 轻微延迟（Hook 触发后才同步）

**实施成本**：中等（~80 行代码）

---

## 不实施的改进

### 不实施 #1：完整的 ACP 协议

**理由**：
- 复杂度高（需要 AID 身份、P2P 通信、群组功能）
- 不符合轻量化原则
- 大多数场景用不到

**替代方案**：
- 保持简化的 ACP 客户端（仅接收消息）
- 如需 Agent 间协作，直接使用 OpenClaw

### 不实施 #2：IPC 消息注入

**理由**：
- 实现复杂（需要文件监听、IPC 协议）
- 收益有限（消息队列已解决顺序问题）
- 增加维护成本

**替代方案**：
- 消息队列自动排队
- 用户体验可接受

### 不实施 #3：复杂的会话管理

**理由**：
- 元数据、标签、搜索等功能过于复杂
- 不符合轻量化原则
- 大多数场景用不到

**替代方案**：
- 保持简单的数据库表
- 仅存储必要字段

---

## 实施计划

### 阶段 1：核心改进（1-2 天）

**任务**：
1. 引入 HappyClaw 的 Feishu 连接
2. 实现简化的消息队列
3. 支持会话模式切换
4. 实现 Hook 驱动的混合式会话日志存储

**验收标准**：
- Feishu 连接稳定（自动重连）
- 消息顺序正确（无乱序）
- 可通过配置切换会话模式
- Agent 可直接读取 JSONL 会话历史
- 数据库支持快速搜索和统计

### 阶段 2：测试与优化（1 天）

**任务**：
1. 测试 Feishu 连接稳定性
2. 测试消息队列正确性
3. 测试会话模式切换

**验收标准**：
- 网络断线后自动重连
- 高并发下消息不乱序
- shared/isolated 模式正常工作

---

## 项目结构

```
evolclaw/
├── src/
│   ├── channels/
│   │   ├── feishu.ts          # 复用 HappyClaw 连接
│   │   └── acp.ts             # 简化的 ACP 客户端
│   ├── core/
│   │   ├── session-manager.ts # 支持 shared/isolated
│   │   └── message-queue.ts   # 简化的消息队列
│   ├── gateway/
│   │   ├── claude-instance.ts # Claude Code 实例
│   │   └── instance-manager.ts# 实例管理
│   └── index.ts               # 入口
├── config.json                # 配置文件
├── data/
│   └── sessions.db            # 会话数据库
└── package.json
```

**代码量估算**：
- Feishu 连接：~50 行（复用）
- 消息队列：~50 行
- 会话管理：~100 行（修改现有代码）
- 会话日志同步：~80 行（MessageSync + Hook 配置）
- **总计**：~280 行新增/修改代码

---

## 配置文件

```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  },
  "acp": {
    "domain": "aid.pub",
    "agentName": "evolclaw"
  },
  "session": {
    "mode": "isolated",
    "projectPath": "./projects/default"
  },
  "gateway": {
    "maxInstances": 20,
    "idleTimeout": 1800000
  }
}
```

**配置说明**：
- `session.mode`：会话模式（shared/isolated）
- `session.projectPath`：默认项目路径
- `gateway.maxInstances`：最大实例数（可选）
- `gateway.idleTimeout`：空闲超时（可选）

---

## 对比总结

### 与 HappyClaw 的差异

| 特性 | HappyClaw | EvolClaw（改进后） |
|------|-----------|-------------------|
| **Feishu 连接** | 完整实现 | 复用 HappyClaw |
| **消息队列** | GroupQueue（复杂） | MessageQueue（简化） |
| **会话模式** | folder 级共享 | shared/isolated 可选 |
| **并发控制** | 全局限制 + 会话队列 | 仅会话队列 |
| **容器隔离** | Docker 容器 | 进程隔离 |
| **多用户** | ✅ | ❌ |
| **Web UI** | ✅ | ❌ |

### 与 OpenClaw 的差异

| 特性 | OpenClaw | EvolClaw（改进后） |
|------|----------|-------------------|
| **ACP 协议** | 完整实现 | 简化客户端 |
| **Agent 协作** | ✅ P2P + 群组 | ❌ |
| **Skills** | 60+ 内置 | ❌ |
| **多渠道** | 8+ 平台 | 2 个渠道 |
| **运行模式** | 4 种模式 | 1 种模式 |

---

## 总结

### 核心改进

1. **生产级 Feishu 连接**（复用 HappyClaw）
2. **简化的消息队列**（保证顺序）
3. **会话模式切换**（shared/isolated）
4. **Hook 驱动的混合式会话日志**（Agent 友好 + 快速搜索）

### 保持轻量

- ❌ 不引入容器
- ❌ 不引入多用户
- ❌ 不引入完整 ACP
- ❌ 不引入复杂的会话管理
- ❌ 不引入 IPC 消息注入

### 实施成本

- **代码量**：~200 行
- **时间**：2-3 天
- **复杂度**：低

### 预期收益

- ✅ 生产环境可用（Feishu 连接稳定）
- ✅ 消息顺序正确（用户体验好）
- ✅ 支持两种场景（个人 + 团队）
- ✅ Agent 友好（直接读取 JSONL 会话历史）
- ✅ 快速搜索（数据库索引支持关键词搜索）
- ✅ 统计分析（消息数、时间戳等元数据）
- ✅ 保持轻量化（代码简洁，~280 行）

### 最终建议

**优先实施**：
1. 复用 HappyClaw 的 Feishu 连接
2. 实现简化的消息队列
3. 支持会话模式切换
4. 实现 Hook 驱动的混合式会话日志存储

**暂不实施**：
- 完整的 ACP 协议
- IPC 消息注入
- 复杂的会话管理
- 故障恢复机制
- 实例预热

**如需更多功能**：
- 个人助手场景 → 使用 HappyClaw
- Agent 网络场景 → 使用 OpenClaw
- 轻量化场景 → 使用 EvolClaw（改进后）
