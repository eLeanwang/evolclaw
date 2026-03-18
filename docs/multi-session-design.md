# 多会话管理设计方案

## 问题分析

### 当前架构的限制

**现有约束**：`UNIQUE(channel, channel_id)`

这意味着：
- 每个聊天（群聊/私聊）只能有一个会话记录
- 切换项目时必须清除会话，导致上下文丢失
- 无法保留不同项目的独立会话历史

### 用户需求

> "同一个渠道+项目也会同时存在多个有效会话的，，比如群聊 A、群聊 B、私聊 A、私聊 B。。需要支持。"

**需求拆解**：
1. **多聊天支持**：群聊 A、群聊 B、私聊 A、私聊 B 是不同的 `channel_id`
2. **每个聊天可以工作在多个项目**：群聊 A 可以同时有 evolclaw 项目会话和 backend 项目会话
3. **项目切换时保留会话**：在群聊 A 中从 evolclaw 切换到 backend，再切回 evolclaw 时应恢复之前的会话
4. **每个聊天有当前活跃项目**：群聊 A 当前在 evolclaw，群聊 B 当前在 backend

## 新架构设计

### 数据模型

```
(channel, channel_id) → 一个聊天（群聊/私聊）
(channel, channel_id, project_path) → 该聊天在特定项目的会话
is_active → 标记该聊天当前活跃的项目会话
```

### 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,  -- 0=inactive, 1=active
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, channel_id, project_path)  -- 每个聊天+项目组合唯一
)
```

**约束说明**：
- `UNIQUE(channel, channel_id, project_path)`：防止同一聊天的同一项目有多个会话
- `is_active`：每个 (channel, channel_id) 只有一个 is_active=1 的记录

### 核心逻辑

#### 1. 获取或创建会话

```typescript
async getOrCreateSession(
  channel: 'feishu' | 'aun',
  channelId: string,
  defaultProjectPath: string
): Promise<Session> {
  // 1. 查找该聊天的活跃会话
  const active = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ? AND is_active = 1
  `).get(channel, channelId);

  if (active) {
    return mapToSession(active);
  }

  // 2. 没有活跃会话，查找该聊天在默认项目的会话
  const existing = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ? AND project_path = ?
  `).get(channel, channelId, defaultProjectPath);

  if (existing) {
    // 激活该会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), existing.id);
    return mapToSession(existing);
  }

  // 3. 创建新会话（默认为活跃）
  const session = {
    id: `${channel}-${channelId}-${Date.now()}`,
    channel,
    channelId,
    projectPath: defaultProjectPath,
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  this.db.prepare(`
    INSERT INTO sessions
    (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id, session.channel, session.channelId,
    session.projectPath, null, 1, session.createdAt, session.updatedAt
  );

  return session;
}
```

#### 2. 切换项目

```typescript
async switchProject(
  channel: 'feishu' | 'aun',
  channelId: string,
  newProjectPath: string
): Promise<Session> {
  // 1. 取消当前活跃会话
  this.db.prepare(`
    UPDATE sessions SET is_active = 0, updated_at = ?
    WHERE channel = ? AND channel_id = ? AND is_active = 1
  `).run(Date.now(), channel, channelId);

  // 2. 查找目标项目的会话
  const target = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ? AND project_path = ?
  `).get(channel, channelId, newProjectPath);

  if (target) {
    // 激活已有会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), target.id);
    return mapToSession(target);
  }

  // 3. 创建新会话
  const session = {
    id: `${channel}-${channelId}-${Date.now()}`,
    channel,
    channelId,
    projectPath: newProjectPath,
    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  this.db.prepare(`
    INSERT INTO sessions
    (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id, session.channel, session.channelId,
    session.projectPath, null, 1, session.createdAt, session.updatedAt
  );

  return session;
}
```

#### 3. 更新 Claude Session ID

```typescript
async updateClaudeSessionId(
  channel: 'feishu' | 'aun',
  channelId: string,
  claudeSessionId: string
): Promise<void> {
  // 只更新当前活跃会话的 Claude Session ID
  this.db.prepare(`
    UPDATE sessions
    SET claude_session_id = ?, updated_at = ?
    WHERE channel = ? AND channel_id = ? AND is_active = 1
  `).run(claudeSessionId, Date.now(), channel, channelId);
}
```

#### 4. 清除会话（/new 命令）

```typescript
async clearActiveSession(
  channel: 'feishu' | 'aun',
  channelId: string
): Promise<void> {
  // 清除当前活跃会话的 Claude Session ID
  this.db.prepare(`
    UPDATE sessions
    SET claude_session_id = NULL, updated_at = ?
    WHERE channel = ? AND channel_id = ? AND is_active = 1
  `).run(Date.now(), channel, channelId);
}
```

## 使用场景示例

### 场景 1：多聊天独立工作

```
群聊 A:
  - evolclaw 项目 (active, claude_session_id: xxx)

群聊 B:
  - backend 项目 (active, claude_session_id: yyy)

私聊 A:
  - frontend 项目 (active, claude_session_id: zzz)
```

每个聊天独立工作，互不干扰。

### 场景 2：单个聊天切换项目

**初始状态**（群聊 A）：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 1, claude_session_id: aaa
```

**执行 `/switch backend`**：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 0, claude_session_id: aaa  (保留)
  - id: feishu-groupA-5678, project: backend, is_active: 1, claude_session_id: null  (新建)
```

**在 backend 工作一段时间后**：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 0, claude_session_id: aaa
  - id: feishu-groupA-5678, project: backend, is_active: 1, claude_session_id: bbb  (已有会话)
```

**执行 `/switch evolclaw`**：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 1, claude_session_id: aaa  (恢复)
  - id: feishu-groupA-5678, project: backend, is_active: 0, claude_session_id: bbb  (保留)
```

**关键点**：
- evolclaw 的会话 ID `aaa` 被保留并恢复
- backend 的会话 ID `bbb` 被保留
- 可以在两个项目之间自由切换，不丢失上下文

### 场景 3：/new 命令

**当前状态**（群聊 A，evolclaw 项目）：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 1, claude_session_id: aaa
  - id: feishu-groupA-5678, project: backend, is_active: 0, claude_session_id: bbb
```

**执行 `/new`**：
```
sessions:
  - id: feishu-groupA-1234, project: evolclaw, is_active: 1, claude_session_id: null  (清除)
  - id: feishu-groupA-5678, project: backend, is_active: 0, claude_session_id: bbb  (不影响)
```

**关键点**：
- 只清除当前活跃项目的会话
- 其他项目的会话不受影响

## 数据库迁移

### 迁移步骤

```sql
-- 1. 创建新表
CREATE TABLE sessions_new (
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

-- 2. 迁移数据（所有现有会话标记为活跃）
INSERT INTO sessions_new
  (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
SELECT
  id, channel, channel_id, project_path, claude_session_id, 1, created_at, updated_at
FROM sessions;

-- 3. 替换表
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
```

### 兼容性

- 现有会话自动标记为活跃（is_active=1）
- 不影响现有功能
- 向后兼容

## 实现清单

### 修改文件

1. **src/session-manager.ts**
   - [ ] 修改 `initDatabase()` - 更新 schema
   - [ ] 修改 `getOrCreateSession()` - 支持活跃会话查找
   - [ ] 添加 `switchProject()` - 项目切换逻辑
   - [ ] 修改 `updateClaudeSessionId()` - 只更新活跃会话
   - [ ] 修改 `clearClaudeSessionId()` - 重命名为 `clearActiveSession()`
   - [ ] 删除 `updateProjectPath()` - 用 `switchProject()` 替代
   - [ ] 添加 `getActiveSession()` - 获取活跃会话
   - [ ] 添加 `listSessions()` - 列出所有会话（用于调试）

2. **src/index.ts**
   - [ ] 修改 `/switch` 命令 - 调用 `switchProject()`
   - [ ] 修改 `/bind` 命令 - 调用 `switchProject()`
   - [ ] 修改 `/new` 命令 - 调用 `clearActiveSession()`
   - [ ] 修改 `/status` 命令 - 显示活跃状态
   - [ ] 可选：添加 `/sessions` 命令 - 列出所有会话

3. **src/types.ts**
   - [ ] 添加 `isActive` 字段到 `Session` 类型

### 测试文件

1. **tests/test-multi-session.ts**
   - [ ] 测试多聊天独立会话
   - [ ] 测试单聊天多项目切换
   - [ ] 测试会话恢复
   - [ ] 测试 /new 命令只影响活跃会话
   - [ ] 测试数据库约束

### 文档更新

1. **docs/multi-project-and-commands.md**
   - [ ] 更新架构说明
   - [ ] 添加多会话管理章节
   - [ ] 更新使用示例

2. **CLAUDE.md**
   - [ ] 更新会话管理说明

## 优势分析

### 相比当前方案

| 特性 | 当前方案 | 新方案 |
|------|---------|--------|
| 项目切换 | 清除会话 | 保留会话 |
| 上下文保留 | ❌ 丢失 | ✅ 保留 |
| 多项目支持 | ⚠️ 有限 | ✅ 完整 |
| 会话恢复 | ❌ 不支持 | ✅ 支持 |
| 数据库复杂度 | 简单 | 中等 |

### 用户体验提升

1. **无缝切换**：在项目间切换不丢失上下文
2. **独立工作**：不同聊天可以同时工作在不同项目
3. **会话保留**：长期项目的会话历史得以保留
4. **灵活管理**：可以查看和管理所有会话

## 风险和注意事项

### 1. 数据库大小

**风险**：每个聊天可能积累多个项目会话，数据库增长

**缓解**：
- 添加会话清理机制（如 30 天未使用自动删除）
- 提供 `/cleanup` 命令手动清理

### 2. 活跃状态一致性

**风险**：同一聊天可能出现多个 is_active=1 的记录

**缓解**：
- 使用事务确保原子性
- 添加数据库检查约束
- 定期验证数据一致性

### 3. 迁移风险

**风险**：现有用户数据迁移可能失败

**缓解**：
- 备份现有数据库
- 提供回滚方案
- 充分测试迁移脚本

## 下一步

1. 实现 SessionManager 的新方法
2. 更新命令处理逻辑
3. 编写测试用例
4. 执行数据库迁移
5. 更新文档

---

**文档创建时间**：2026-03-09
**版本**：v1.0 - 多会话管理设计
