# EvolClaw 会话关联设计

## 问题分析

渠道端会话和 Claude Code 会话的关联关系是 EvolClaw 架构的核心问题，涉及：
- 会话如何映射？
- 会话如何隔离？
- 会话如何复用？
- 会话如何持久化？

## 设计方案

### 三层映射架构

```
┌─────────────────────────────────────────────────────────┐
│                    渠道层 (Channel)                       │
│  飞书群组A    飞书群组B    ACP会话C    飞书私聊D          │
│  ou_xxx      ou_yyy      acp_zzz     ou_aaa             │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              EvolClaw 会话层 (Session)                    │
│  session-1   session-2   session-3   session-4          │
│  (独立ID)    (独立ID)    (独立ID)    (独立ID)            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                  项目层 (Project)                         │
│  project-a   project-a   project-b   project-a          │
│  (可共享)    (可共享)    (独立)      (可共享)            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              Claude 会话层 (Claude Session)               │
│  claude-abc  claude-def  claude-ghi  claude-jkl         │
│  (独立上下文)(独立上下文)(独立上下文)(独立上下文)         │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              实例层 (Claude Code Instance)                │
│  Instance 1  Instance 2  Instance 3  Instance 4         │
│  (独立进程)  (独立进程)  (独立进程)  (独立进程)          │
└─────────────────────────────────────────────────────────┘
```

### 映射关系表

| 渠道ID | EvolClaw会话ID | 项目路径 | Claude会话ID | 实例ID |
|--------|---------------|---------|-------------|--------|
| `feishu:ou_xxx` | `session-1` | `/projects/team-a` | `claude-abc` | `instance-1` |
| `feishu:ou_yyy` | `session-2` | `/projects/team-a` | `claude-def` | `instance-2` |
| `acp:acp_zzz` | `session-3` | `/projects/personal` | `claude-ghi` | `instance-3` |
| `feishu:ou_aaa` | `session-4` | `/projects/team-a` | `claude-jkl` | `instance-4` |

**关键特性**：
- ✅ 每个渠道会话有独立的 EvolClaw 会话ID
- ✅ 多个会话可以共享同一个项目目录
- ✅ 即使共享项目，Claude 会话ID 也是独立的
- ✅ 每个会话有独立的 Claude Code 实例

## 设计原则

### 1. 会话独立性

**原则**：每个渠道会话都应该有独立的对话上下文

**实现**：
- 飞书群组A 和 飞书群组B 即使讨论同一个项目，也不应该看到对方的对话历史
- 每个会话有独立的 Claude 会话ID
- 每个会话启动独立的 Claude Code 实例

**好处**：
- 隐私保护：不同群组的对话互不可见
- 上下文清晰：每个会话有自己的上下文
- 故障隔离：一个会话崩溃不影响其他会话

### 2. 项目共享性

**原则**：多个会话可以操作同一个项目的文件

**实现**：
- 多个 EvolClaw 会话可以绑定到同一个项目路径
- 文件系统层面共享（可以看到彼此的文件修改）
- 但对话历史层面隔离（看不到彼此的对话）

**场景**：
```
团队协作场景：
- 飞书群组A（前端团队）→ project-webapp
- 飞书群组B（后端团队）→ project-webapp
- 两个团队操作同一个项目，但对话历史独立
```

### 3. 会话持久化

**原则**：会话关系应该持久化，重启后可恢复

**实现**：
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- EvolClaw 会话ID
  channel TEXT NOT NULL,            -- 'feishu' | 'acp'
  channel_id TEXT NOT NULL,         -- 渠道端会话ID
  project_path TEXT NOT NULL,       -- 项目路径
  claude_session_id TEXT,           -- Claude 会话ID（可选）
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(channel, channel_id)       -- 渠道会话唯一
);
```

**Claude 会话ID 的管理**：
- 首次查询时，Claude SDK 返回 `newSessionId`
- 保存到数据库的 `claude_session_id` 字段
- 后续查询时传入此 `sessionId`，Claude SDK 会复用会话
- Claude SDK 内部将会话数据存储在 `.claude/` 目录

## 会话生命周期

### 创建流程

```
1. 渠道消息到达
   ↓
2. SessionManager.getOrCreateSession(channel, channelId)
   ↓
3. 查询数据库：SELECT * WHERE channel=? AND channel_id=?
   ↓
4. 如果不存在：
   - 生成新的 EvolClaw 会话ID
   - 分配项目路径（默认或用户指定）
   - 插入数据库（claude_session_id 为空）
   ↓
5. 返回 Session 对象
   ↓
6. InstanceManager.getOrCreateInstance(sessionId, projectPath)
   ↓
7. 启动 Claude Code 实例
   - cwd: projectPath
   - sessionId: claude_session_id（如果有）
   ↓
8. 执行查询，获得 newSessionId
   ↓
9. 更新数据库：UPDATE sessions SET claude_session_id=?
```

### 复用流程

```
1. 渠道消息到达（同一个渠道会话）
   ↓
2. SessionManager.getOrCreateSession(channel, channelId)
   ↓
3. 查询数据库：找到已存在的 session
   ↓
4. InstanceManager.getOrCreateInstance(sessionId, projectPath)
   ↓
5. 检查实例是否存在且运行中
   - 存在 → 复用
   - 不存在 → 启动新实例
   ↓
6. 执行查询，传入 claude_session_id
   ↓
7. Claude SDK 自动加载历史上下文
```

### 销毁流程

```
1. 实例空闲超时（30分钟）
   ↓
2. InstanceManager 停止实例
   ↓
3. 进程退出，释放资源
   ↓
4. 数据库中的 session 记录保留
   ↓
5. .claude/ 目录中的会话数据保留
   ↓
6. 下次消息到达时，重新启动实例并恢复会话
```

## 数据存储

### EvolClaw 层

**数据库**：`data/sessions.db`
```sql
sessions 表：
- id: session-1
- channel: feishu
- channel_id: ou_xxx
- project_path: /projects/team-a
- claude_session_id: claude-abc
```

### Claude 层

**文件系统**：`/projects/team-a/.claude/`
```
.claude/
├── sessions/
│   ├── claude-abc.jsonl    # session-1 的对话历史
│   ├── claude-def.jsonl    # session-2 的对话历史
│   └── claude-jkl.jsonl    # session-4 的对话历史
└── config.json
```

**关键点**：
- 同一个项目目录下可以有多个 Claude 会话文件
- 每个会话文件对应一个独立的对话历史
- 文件名就是 Claude 会话ID

## 高级场景

### 场景1：团队协作

```
需求：前端团队和后端团队在同一个项目上工作

设计：
- 飞书群组A（前端）→ session-1 → project-webapp → claude-abc
- 飞书群组B（后端）→ session-2 → project-webapp → claude-def

效果：
- 两个团队可以看到彼此的代码修改
- 但看不到彼此的对话历史
- 各自的 Agent 有独立的上下文
```

### 场景2：个人多项目

```
需求：一个用户在多个项目间切换

设计：
- 飞书私聊 → session-1 → project-a → claude-abc
- 用户发送 "/switch project-b"
- 系统更新：session-1 → project-b → claude-abc

问题：切换项目后，Claude 会话ID 不变，上下文会混乱

更好的设计：
- 飞书私聊 + project-a → session-1 → project-a → claude-abc
- 飞书私聊 + project-b → session-2 → project-b → claude-def
- 通过命令切换时，实际上是切换到不同的 session
```

### 场景3：临时会话

```
需求：用户想要一个临时的、不保存历史的会话

设计：
- 创建 session 时标记 temporary=true
- 实例销毁时，删除 .claude/ 中的会话文件
- 数据库中的 session 记录也删除
```

## 最佳实践

### 1. 会话命名

```typescript
// 生成 EvolClaw 会话ID
function generateSessionId(channel: string, channelId: string): string {
  return `${channel}-${channelId}-${Date.now()}`;
}

// 示例
generateSessionId('feishu', 'ou_xxx')
// → 'feishu-ou_xxx-1234567890'
```

### 2. 项目路径管理

```typescript
interface ProjectBinding {
  sessionId: string;
  projectPath: string;
  isDefault: boolean;
}

// 允许用户自定义项目绑定
async function bindProject(sessionId: string, projectPath: string) {
  await sessionManager.updateSession(sessionId, { projectPath });
}
```

### 3. 会话元数据

```typescript
interface SessionMetadata {
  displayName?: string;      // 会话显示名称
  description?: string;       // 会话描述
  tags?: string[];            // 标签
  createdBy?: string;         // 创建者
  lastActiveAt?: number;      // 最后活跃时间
}
```

## 配置示例

```json
{
  "sessions": {
    "defaultProject": "./projects/default",
    "allowProjectSharing": true,
    "sessionTimeout": 1800000,
    "maxSessionsPerChannel": 10
  }
}
```

## 总结

**推荐设计**：

1. **三层映射**：渠道ID → EvolClaw会话ID → 项目路径 + Claude会话ID
2. **会话独立**：每个渠道会话有独立的对话上下文
3. **项目共享**：多个会话可以操作同一个项目文件
4. **持久化**：会话关系存储在数据库，Claude 会话存储在 .claude/ 目录
5. **生命周期**：实例可以销毁和重建，但会话关系和历史数据保留

**核心优势**：
- ✅ 隐私保护：对话历史隔离
- ✅ 灵活协作：文件系统共享
- ✅ 可恢复性：重启后自动恢复
- ✅ 可扩展性：支持多种高级场景
