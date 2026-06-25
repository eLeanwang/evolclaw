# 会话持久化机制说明

## 问题

**服务重启会导致所有会话都被关闭吗？**

**答案：不会！会话已经持久化，服务重启后会自动恢复。**

## 持久化机制

### 1. 数据库持久化（SQLite）

**位置**：`./data/sessions.db`

**存储内容**：
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,           -- Claude SDK 会话 ID
  is_active INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, channel_id, project_path)
);
```

**关键字段**：
- `claude_session_id` - Claude SDK 返回的会话 ID，用于恢复会话
- `project_path` - 项目路径，决定 `.claude/` 目录位置

### 2. Claude SDK 会话文件（JSONL）

**位置**：`{projectPath}/.claude/*.jsonl`

**存储内容**：
- 完整的对话历史
- 工具调用记录
- 上下文信息

**管理方式**：
- 由 Claude Agent SDK 自动管理
- 自动持久化到磁盘
- 通过 `resume` 参数恢复

### 3. 内存状态（不持久化）

**AgentRunner 内存状态**：
```typescript
private activeSessions: Map<string, string> = new Map();
private activeStreams = new Map<string, AsyncIterable<any>>();
```

**特点**：
- 服务重启后清空
- 不影响会话恢复（从数据库读取）

## 恢复流程

### 服务重启前

```
用户消息 → AgentRunner.runQuery()
    ↓
query({
  options: {
    cwd: '/data/openclaw-root',
    resume: '03d246cf-5d12-4bfd-b...'  // 使用已有会话
  }
})
    ↓
SDK 返回 session_id
    ↓
存储到数据库: sessions.claude_session_id = '03d246cf-...'
```

### 服务重启后

```
用户发送新消息
    ↓
SessionManager.getOrCreateSession()
    ↓
从数据库读取: session.claudeSessionId = '03d246cf-...'
    ↓
AgentRunner.runQuery(sessionId, ..., claudeSessionId)
    ↓
query({
  options: {
    cwd: '/data/openclaw-root',
    resume: '03d246cf-5d12-4bfd-b...'  // 从数据库恢复
  }
})
    ↓
SDK 从 .claude/*.jsonl 恢复会话历史 ✓
    ↓
会话继续，就像没有重启过一样
```

## 代码实现

### 1. 数据库读取（SessionManager）

```typescript
async getOrCreateSession(channel, channelId, defaultProjectPath): Promise<Session> {
  // 查找活跃会话
  const active = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ? AND is_active = 1
  `).get(channel, channelId);

  if (active) {
    return {
      claudeSessionId: active.claude_session_id,  // 从数据库恢复
      // ...
    };
  }
  // ...
}
```

### 2. 会话恢复（AgentRunner）

```typescript
async runQuery(sessionId, prompt, projectPath, initialClaudeSessionId, ...): Promise<...> {
  // 优先使用数据库中的 claudeSessionId
  const claudeSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

  return query({
    prompt: prompt,
    options: {
      cwd: projectPath,
      ...(claudeSessionId ? { resume: claudeSessionId } : {}),  // 恢复会话
      // ...
    }
  });
}
```

### 3. 会话 ID 持久化（MessageProcessor）

```typescript
for await (const event of stream) {
  // 提取 session_id
  if (event.session_id) {
    agentRunner.updateSessionId(session.id, event.session_id);
    // ↓ 触发回调
    // ↓ sessionManager.updateClaudeSessionId()
    // ↓ 存储到数据库
  }
}
```

## 验证方法

### 1. 检查数据库

```bash
sqlite3 data/sessions.db "SELECT channel, channel_id, claude_session_id FROM sessions;"
```

### 2. 检查会话文件

```bash
ls -lh /data/openclaw-root/.claude/*.jsonl
```

### 3. 测试重启恢复

```bash
# 1. 发送消息，建立会话
# 2. 重启服务
bash evolclaw.sh restart
# 3. 再次发送消息
# 4. 检查是否能继续之前的对话
```

## 优势

1. **自动持久化**：无需手动保存，每次对话自动存储
2. **透明恢复**：用户无感知，服务重启后自动恢复
3. **多项目支持**：每个项目独立的 `.claude/` 目录
4. **数据安全**：SQLite + JSONL 双重保障

## 注意事项

1. **不要删除 `.claude/` 目录**：包含完整会话历史
2. **不要删除 `sessions.db`**：包含会话 ID 映射
3. **项目路径不要改变**：会导致找不到会话文件
4. **定期备份**：
   ```bash
   cp -r /data/openclaw-root/.claude /backup/
   cp data/sessions.db /backup/
   ```

## 结论

**会话已完全持久化，服务重启不会丢失任何对话历史。**

当前实现已经满足持久化需求，无需额外改进。
