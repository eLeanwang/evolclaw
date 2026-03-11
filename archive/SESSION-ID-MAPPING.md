# 三层会话ID关联处理方案

## ID层次结构

```
┌─────────────────────────────────────────────────────────┐
│ 渠道会话层 (Channel Session)                             │
│ - 飞书群组ID: ou_fd9172e1d4d14ea18d90fe6b55a62462      │
│ - 飞书用户ID: ou_a1b2c3d4e5f6g7h8i9j0                  │
│ - ACP会话ID: session-abc-def-ghi                       │
│ (外部系统生成，不可控)                                   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ EvolClaw会话层 (EvolClaw Session)                       │
│ - 格式: {channel}-{channel_id}-{timestamp}              │
│ - 示例: feishu-ou_fd91-1709812345678                   │
│ (内部生成，主键，用于实例管理)                           │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Claude会话层 (Claude Session)                           │
│ - 格式: UUID 或 Claude SDK 生成的ID                     │
│ - 示例: 550e8400-e29b-41d4-a716-446655440000           │
│ (Claude SDK 生成，用于会话上下文)                        │
└─────────────────────────────────────────────────────────┘
```

## 数据库设计

### 单表方案（推荐）

```sql
CREATE TABLE sessions (
  -- EvolClaw会话ID（主键）
  id TEXT PRIMARY KEY,

  -- 渠道信息
  channel TEXT NOT NULL,              -- 'feishu' | 'acp'
  channel_id TEXT NOT NULL,           -- 渠道端会话ID

  -- 项目绑定
  project_path TEXT NOT NULL,         -- 项目路径

  -- Claude会话
  claude_session_id TEXT,             -- Claude会话ID（可为空）

  -- 元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_active_at INTEGER,

  -- 唯一约束：同一个渠道会话只能有一个EvolClaw会话
  UNIQUE(channel, channel_id)
);

-- 复合索引：加速渠道会话查询
CREATE UNIQUE INDEX idx_channel_session
ON sessions(channel, channel_id);

-- 索引：加速Claude会话查询
CREATE INDEX idx_claude_session
ON sessions(claude_session_id);
```

**优点**：
- 一次查询获得所有信息
- 关系清晰，1:1:1映射
- 性能好，索引优化

## ID生成策略

### 1. EvolClaw会话ID

```typescript
function generateEvolClessionId(channel: string, channelId: string): string {
  const timestamp = Date.now();
  // 截断channelId避免过长
  const shortChannelId = channelId.length > 20
    ? channelId.substring(0, 20)
    : channelId;

  return `${channel}-${shortChannelId}-${timestamp}`;
}

// 示例
generateEvolClessionId('feishu', 'ou_fd9172e1d4d14ea18d90fe6b55a62462')
// → 'feishu-ou_fd9172e1d4d14ea-1709812345678'

generateEvolClawSessionId('acp', 'session-abc-def-ghi')
// → 'acp-session-abc-def-gh-1709812345678'
```

**特点**：
- 可读性好，包含来源信息
- 时间戳保证唯一性
- 长度可控（避免过长）

### 2. Claude会话ID

```typescript
// Claude会话ID由SDK自动生成，我们只需要存储
interface ClaudeQueryResult {
  stream: AsyncIterator<any>;
  newSessionId?: string;  // SDK返回的新会话ID
}

// 首次查询
const result = await query({
  prompt: 'hello',
  apiKey: API_KEY,
  cwd: projectPath
  // 不传sessionId，SDK会创建新会话
});

// 保存返回的会话ID
if (result.newSessionId) {
  await sessionManager.updateSession(evolClawSessionId, {
    claudeSessionId: result.newSessionId
  });
}

// 后续查询
const result2 = await query({
  prompt: 'world',
  apiKey: API_KEY,
  sessionId: claudeSessionId,  // 传入已有会话ID
  cwd: projectPath
});
```

## 关联查询流程

### 流程1：首次消息（创建会话）

```typescript
async function handleFirstMessage(
  channel: 'feishu' | 'acp',
  channelId: string,
  content: string
): Promise<string> {

  // 1. 生成EvolClaw会话ID
  const evolClawSessionId = generateEvolClessionId(channel, channelId);

  // 2. 创建会话记录（Claude会话ID为空）
  await db.execute(`
    INSERT INTO sessions (id, channel, channel_id, project_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    evolClessionId,
    channel,
    channelId,
    defaultProjectPath,
    Date.now(),
    Date.now()
  ]);

  // 3. 启动Claude Code实例
  const instance = await instanceManager.getOrCreateInstance(
    evolClessionId,
    defaultProjectPath
  );

  // 4. 执行查询（不传sessionId）
  const result = await query({
    prompt: content,
    apiKey: API_KEY,
    cwd: defaultProjectPath
  });

  // 5. 保存Claude会话ID
  if (result.newSessionId) {
    await db.execute(`
      UPDATE sessions
      SET claude_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [result.newSessionId, Date.now(), evolClessionId]);
  }

  // 6. 返回响应
  return await consumeStream(result.stream);
}
```

### 流程2：后续消息（复用会话）

```typescript
async function handleSubsequentMessage(
  channel: 'feishu' | 'acp',
  channelId: string,
  content: string
): Promise<string> {

  // 1. 查询已有会话
  const session = await db.query(`
    SELECT id, project_path, claude_session_id
    FROM sessions
    WHERE channel = ? AND channel_id = ?
  `, [channel, channelId]);

  if (!session) {
    // 会话不存在，走首次消息流程
    return handleFirstMessage(channel, channelId, content);
  }

  // 2. 获取或创建实例
  const instance = await instanceManager.getOrCreateInstance(
    session.id,
    session.project_path
  );

  // 3. 执行查询（传入Claude会话ID）
  const result = await query({
    prompt: content,
    apiKey: API_KEY,
    sessionId: session.claude_session_id,  // 复用会话
    cwd: session.project_path
  });

  // 4. 更新最后活跃时间
  await db.execute(`
    UPDATE sessions
    SET last_active_at = ?, updated_at = ?
    WHERE id = ?
  `, [Date.now(), Date.now(), session.id]);

  // 5. 返回响应
  return await consumeStream(result.stream);
}
```

### 统一入口

```typescript
async function handleMessage(
  channel: 'feishu' | 'acp',
  channelId: string,
  content: string
): Promise<string> {

  // 查询会话
  const session = await sessionManager.getOrCreateSession(
    channel,
    channelId,
    defaultProjectPath
  );

  // 获取实例
  const instance = await instanceManager.getOrCreateInstance(
    session.id,
    session.projectPath
  );

  // 执行查询
  const result = await query({
    prompt: content,
    apiKey: API_KEY,
    sessionId: session.claudeSessionId,  // 可能为undefined
    cwd: session.projectPath
  });

  // 更新Claude会话ID
  if (result.newSessionId && result.newSessionId !== session.claudeSessionId) {
    await sessionManager.updateSession(session.id, {
      claudeSessionId: result.newSessionId
    });
  }

  return await consumeStream(result.stream);
}
```

## SessionManager实现

```typescript
export class SessionManager {
  private db: Database;

  async getOrCreateSession(
    channel: 'feishu' | 'acp',
    channelId: string,
    defaultProjectPath: string
  ): Promise<Session> {

    // 查询已有会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ?
    `).get(channel, channelId) as Session | undefined;

    if (existing) {
      return existing;
    }

    // 创建新会话
    const session: Session = {
      id: generateEvolClessionId(channel, channelId),
      channel,
      channelId,
      projectPath: defaultProjectPath,
      claudeSessionId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT INTO sessions
      (id, channel, channel_id, project_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.channel,
      session.channelId,
      session.projectPath,
      session.createdAt,
      session.updatedAt
    );

    return session;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Session>
  ): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.claudeSessionId !== undefined) {
      fields.push('claude_session_id = ?');
      values.push(updates.claudeSessionId);
    }

    if (updates.projectPath !== undefined) {
      fields.push('project_path = ?');
      values.push(updates.projectPath);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());

    values.push(sessionId);

    this.db.prepare(`
      UPDATE sessions
      SET ${fields.join(', ')}
      WHERE id = ?
    `).run(...values);
  }
}
```

## 查询优化

### 1. 索引策略

```sql
-- 主查询：通过渠道会话查找
CREATE UNIQUE INDEX idx_channel_session
ON sessions(channel, channel_id);

-- 反向查询：通过Claude会话查找（用于调试）
CREATE INDEX idx_claude_session
ON sessions(claude_session_id);

-- 清理查询：查找过期会话
CREATE INDEX idx_last_active
ON sessions(last_active_at);
```

### 2. 缓存策略

```typescript
class SessionManager {
  private cache: Map<string, Session> = new Map();

  async getOrCreateSession(...): Promise<Session> {
    const cacheKey = `${channel}:${channelId}`;

    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // 查询数据库
    const session = await this.queryDatabase(...);

    // 写入缓存
    this.cache.set(cacheKey, session);

    return session;
  }
}
```

## 会话清理

```typescript
class SessionCleaner {
  async cleanupExpiredSessions(maxIdleTime: number): Promise<void> {
    const threshold = Date.now() - maxIdleTime;

    // 查找过期会话
    const expiredSessions = this.db.prepare(`
      SELECT id FROM sessions
      WHERE last_active_at < ?
    `).all(threshold) as { id: string }[];

    for (const { id } of expiredSessions) {
      // 停止实例
      await instanceManager.stopInstance(id);

      // 可选：删除会话记录
      // this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

      // 或者：标记为已清理
      this.db.prepare(`
        UPDATE sessions
        SET claude_session_id = NULL, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), id);
    }
  }
}
```

## 总结

**三层ID关联的核心原则**：

1. **渠道会话ID** → **EvolClaw会话ID**：通过数据库 UNIQUE 约束保证1:1映射
2. **EvolClaw会话ID** → **Claude会话ID**：通过数据库字段存储，可能为空（首次查询前）
3. **查询流程**：渠道ID → 数据库查询 → 获得EvolClaw ID和Claude ID → 传递给实例

**关键实现**：
- 单表存储，复合索引优化
- EvolClaw ID包含来源信息，便于调试
- Claude ID由SDK管理，我们只负责存储和传递
- 支持缓存，提升性能
