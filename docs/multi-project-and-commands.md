# 多项目支持与斜杠命令

## 功能概述

EvolClaw 支持将多个 Claude Code 项目映射到飞书/ACP 会话，每个会话可以在多个项目之间切换，并保留每个项目的独立会话历史。

## 核心设计

### 多会话管理（v2.0）

**新架构特性**：
- 每个聊天（群聊/私聊）可以同时拥有多个项目的会话
- 项目切换时自动保留和恢复会话历史
- 每个 (channel, channel_id, project_path) 组合有独立的 Claude 会话
- 支持会话列表查看和管理

**数据模型**：
```
(channel, channel_id) → 一个聊天（群聊/私聊）
(channel, channel_id, project_path) → 该聊天在特定项目的会话
is_active → 标记该聊天当前活跃的项目会话
```

**数据库 Schema**：
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
)
```

### 配置结构

```json
{
  "projects": {
    "defaultPath": "./projects/default",
    "autoCreate": true,
    "list": {
      "default": "./projects/default",
      "evolclaw": "/home/happyclaw/data/groups/main/evolclaw",
      "my-app": "/path/to/my-app"
    }
  }
}
```

## 已实现功能

### 数据库支持
- ✅ `sessions` 表包含 `project_path` 字段
- ✅ `sessions` 表包含 `claude_session_id` 字段（持久化）
- ✅ `sessions` 表包含 `is_active` 字段（标记活跃会话）
- ✅ `UNIQUE(channel, channel_id, project_path)` 约束
- ✅ `SessionManager.switchProject()` - 项目切换逻辑（保留会话）
- ✅ `SessionManager.updateClaudeSessionId()` - 更新 Claude session ID
- ✅ `SessionManager.clearActiveSession()` - 清除活跃会话
- ✅ `SessionManager.getSession()` - 获取活跃会话
- ✅ `SessionManager.listSessions()` - 列出所有会话

### 命令处理框架
- ✅ `handleProjectCommand()` - 命令解析和处理函数
- ✅ 飞书消息处理集成命令检查
- ✅ ACP 消息处理集成命令检查
- ✅ 支持简化命令和完整命令两种格式

### 已实现的命令

#### 项目管理命令
- ✅ `/pwd` 或 `/project current` - 显示当前项目路径
- ✅ `/plist` 或 `/project list` - 列出所有配置的项目
- ✅ `/switch <name|path>` 或 `/project switch <name>` - 切换项目
  - 支持项目名称（从配置中查找）
  - 支持绝对路径（直接使用）
  - 自动验证路径存在性
  - **自动保留和恢复会话**（如果该项目之前有会话则恢复）
  - 提示是恢复已有会话还是新建会话
- ✅ `/bind <path>` 或 `/project bind <path>` - 绑定新项目目录
  - 必须是绝对路径
  - 自动验证路径存在性
  - **自动保留和恢复会话**（如果该项目之前有会话则恢复）

#### 会话管理命令
- ✅ `/new` - 清除当前活跃项目的会话，开始新对话（不影响其他项目的会话）
- ✅ `/status` - 显示会话状态（渠道、会话ID、项目路径、活跃状态、Claude会话ID、时间戳）

#### 帮助命令
- ✅ `/help` - 显示所有可用命令和使用说明

### Session ID 持久化
- ✅ 自动提取 SDK 事件流中的 session ID
- ✅ 通过回调机制持久化到数据库
- ✅ 从数据库恢复 session ID（支持跨重启）
- ✅ **项目切换时保留会话**（不再清除）
- ✅ **会话恢复机制**（切换回之前的项目时自动恢复）
- ✅ 字段名映射（snake_case ↔ camelCase）

### Compact 事件监听
- ✅ 监听 SDK 的 `compact_boundary` 事件
- ✅ 自动通知用户会话已压缩
- ✅ 显示压缩触发方式和压缩前 token 数量

## 待实现功能

目前所有计划的核心功能都已实现！🎉

### 可选的未来增强

1. **命令别名扩展**
   - 可以添加更多命令别名，如 `/ls` → `/plist`
   - 可以添加 `/cd` → `/switch`

2. **会话列表命令**
   - `/sessions` - 列出当前聊天的所有项目会话
   - 显示每个会话的项目路径、活跃状态、Claude Session ID

3. **会话清理**
   - 自动清理 30 天未使用的会话
   - `/cleanup` 命令手动清理旧会话

4. **项目模板**
   - 支持从模板创建新项目
   - 预配置常用项目结构

5. **会话导出**
   - 导出会话历史为 Markdown
   - 导出会话统计信息

## 使用示例

### 配置多个项目

编辑 `data/config.json`：

```json
{
  "projects": {
    "defaultPath": "./projects/default",
    "autoCreate": true,
    "list": {
      "evolclaw": "/home/user/evolclaw",
      "backend": "/home/user/my-backend",
      "frontend": "/home/user/my-frontend"
    }
  }
}
```

### 查看帮助

```
/help
```

输出：
```
可用命令：
📁 项目管理：
  /pwd 或 /project current - 显示当前项目路径
  /plist 或 /project list - 列出所有配置的项目
  /switch <name|path> 或 /project switch <name> - 切换项目
  /bind <path> 或 /project bind <path> - 绑定新项目目录

🔄 会话管理：
  /new - 清除会话，开始新对话
  /status - 显示会话状态

❓ 帮助：
  /help - 显示此帮助信息
```

### 查看会话状态

```
/status
```

输出：
```
📊 会话状态：
渠道: feishu
会话ID: feishu-chat123-1772985527026
项目路径: /home/user/evolclaw
Claude会话: 334ad03b-5e60-4687-b846-c1e88b2e25a3
创建时间: 2026-03-08 23:45:27
更新时间: 2026-03-08 23:50:15
```

### 切换项目

#### 使用项目名称

```
/plist
/switch backend
```

输出：
```
✓ 已切换到项目: backend
  路径: /home/user/my-backend
  （新建会话）
```

或者如果之前在该项目工作过：
```
✓ 已切换到项目: backend
  路径: /home/user/my-backend
  （恢复已有会话）
```

#### 使用绝对路径

```
/switch /home/user/new-project
```

输出：
```
✓ 已切换到项目: new-project
  路径: /home/user/new-project
  （新建会话）
```

### 绑定新项目

```
/bind /home/user/another-project
```

输出：
```
✓ 已绑定项目目录: /home/user/another-project
  （新建会话）
```

### 清除会话

```
/new
```

输出：
```
✓ 已清除会话，下次对话将开始新会话
```

**注意**：`/new` 命令只清除当前活跃项目的会话，不影响其他项目的会话。

### Compact 通知

当会话自动压缩时，系统会自动发送通知：

```
💡 会话已自动压缩（触发方式: auto, 压缩前 tokens: 45230）
```

## 多会话管理场景

### 场景 1：在多个项目间切换工作

```
# 初始状态：在 evolclaw 项目工作
用户: 帮我分析一下这个函数
Claude: [分析 evolclaw 项目的代码...]

# 临时切换到 backend 项目
用户: /switch backend
系统: ✓ 已切换到项目: backend
      路径: /home/user/backend
      （新建会话）

用户: 帮我看看 API 接口
Claude: [分析 backend 项目的代码...]

# 切换回 evolclaw 项目
用户: /switch evolclaw
系统: ✓ 已切换到项目: evolclaw
      路径: /home/user/evolclaw
      （恢复已有会话）

用户: 继续刚才的分析
Claude: [继续之前的上下文，记得之前分析的函数...]
```

**关键点**：
- evolclaw 项目的会话历史被完整保留
- 切换回来时自动恢复上下文
- backend 项目的会话也被保留，下次切换回去时可以继续

### 场景 2：多个聊天独立工作

```
群聊 A（产品团队）:
  当前项目: evolclaw
  会话历史: 讨论架构设计、功能实现

群聊 B（运维团队）:
  当前项目: deployment
  会话历史: 讨论部署脚本、监控配置

私聊 A（与同事）:
  当前项目: backend
  会话历史: Code Review、Bug 修复
```

每个聊天独立工作，互不干扰。

### 场景 3：清除特定项目的会话

```
# 当前在 evolclaw 项目
用户: /new
系统: ✓ 已清除会话，下次对话将开始新会话

# evolclaw 项目的会话被清除，但其他项目不受影响
用户: /switch backend
系统: ✓ 已切换到项目: backend
      路径: /home/user/backend
      （恢复已有会话）

# backend 项目的会话历史仍然存在
```

## 技术实现要点

### 命令处理流程

```
用户消息 → handleProjectCommand()
  ├─ 是命令 → 执行命令 → 返回结果
  └─ 非命令 → 传递给 Agent Runner
```

### 多会话管理架构

```typescript
// 数据模型
(channel, channel_id) → 一个聊天（群聊/私聊）
(channel, channel_id, project_path) → 该聊天在特定项目的会话
is_active → 标记该聊天当前活跃的项目会话

// 切换项目逻辑
async switchProject(channel, channelId, newProjectPath) {
  // 1. 取消当前活跃会话
  UPDATE sessions SET is_active = 0 WHERE ... AND is_active = 1

  // 2. 查找目标项目的会话
  SELECT * FROM sessions WHERE ... AND project_path = ?

  // 3. 如果存在则激活，否则创建新会话
  if (target) {
    UPDATE sessions SET is_active = 1 WHERE id = target.id
  } else {
    INSERT INTO sessions (..., is_active = 1)
  }
}
```

### 会话恢复机制

```typescript
// 获取或创建会话
async getOrCreateSession(channel, channelId, defaultProjectPath) {
  // 1. 查找活跃会话
  const active = SELECT * WHERE ... AND is_active = 1

  // 2. 如果没有活跃会话，查找默认项目的会话
  if (!active) {
    const existing = SELECT * WHERE ... AND project_path = defaultProjectPath
    if (existing) {
      // 激活该会话
      UPDATE sessions SET is_active = 1 WHERE id = existing.id
    }
  }

  // 3. 如果都没有，创建新会话
}
```

## 文件清单

### 已修改文件
- `src/types.ts` - 添加 `isActive` 字段到 `Session` 类型
- `src/session-manager.ts` - 实现多会话管理逻辑
  - 更新数据库 schema（添加 `is_active` 字段和新约束）
  - 实现 `switchProject()` 方法
  - 实现 `clearActiveSession()` 方法
  - 实现 `listSessions()` 方法
  - 自动数据库迁移逻辑
- `src/index.ts` - 更新命令处理逻辑
  - `/switch` 命令使用 `switchProject()`
  - `/bind` 命令使用 `switchProject()`
  - `/status` 命令显示活跃状态
  - 提示恢复已有会话或新建会话
- `data/config.json` - 添加项目列表配置

### 新增文件
- `tests/test-multi-session.ts` - 多会话管理测试
- `docs/multi-session-design.md` - 多会话管理设计文档

## 下一步计划

所有核心功能已完成！可选的未来增强：

1. 添加 `/sessions` 命令 - 列出当前聊天的所有项目会话
2. 实现会话自动清理机制（30 天未使用）
3. 添加 `/cleanup` 命令 - 手动清理旧会话
4. 会话导出功能

---

*文档创建时间：2026-03-08*
*最后更新：2026-03-09*
*版本：v2.0 - 多会话管理*
