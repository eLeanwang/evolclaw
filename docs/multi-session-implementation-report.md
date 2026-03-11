# 多会话管理实现报告

## 概述

完成了多会话管理功能的设计和实现，解决了项目切换时会话丢失的问题。现在每个聊天可以在多个项目之间切换，并自动保留和恢复每个项目的会话历史。

## 问题背景

### 原有架构的限制

**数据库约束**：`UNIQUE(channel, channel_id)`

这导致：
- 每个聊天只能有一个会话记录
- 切换项目时必须清除会话，导致上下文丢失
- 无法在项目间自由切换

### 用户需求

> "同一个渠道+项目也会同时存在多个有效会话的，，比如群聊 A、群聊 B、私聊 A、私聊 B。。需要支持。"

**需求拆解**：
1. 多聊天支持：群聊 A、群聊 B、私聊 A、私聊 B 是不同的 `channel_id`
2. 每个聊天可以工作在多个项目
3. 项目切换时保留会话
4. 每个聊天有当前活跃项目

## 新架构设计

### 数据模型

```
(channel, channel_id) → 一个聊天（群聊/私聊）
(channel, channel_id, project_path) → 该聊天在特定项目的会话
is_active → 标记该聊天当前活跃的项目会话
```

### 数据库 Schema

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

**关键变化**：
- 移除 `UNIQUE(channel, channel_id)` 约束
- 添加 `UNIQUE(channel, channel_id, project_path)` 约束
- 添加 `is_active` 字段标记活跃会话

## 实现内容

### 1. 数据库迁移

**文件**：`src/session-manager.ts:16-50`

```typescript
private initDatabase(): void {
  // 检查是否需要迁移
  const tableInfo = this.db.pragma('table_info(sessions)') as any[];
  const hasIsActive = tableInfo.some((col: any) => col.name === 'is_active');

  if (!hasIsActive && tableInfo.length > 0) {
    // 需要迁移：旧表存在但没有 is_active 字段
    console.log('Migrating database schema...');
    this.db.exec(`
      CREATE TABLE sessions_new (...);
      INSERT INTO sessions_new ... SELECT ... FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
    console.log('✓ Database migration completed');
  }
}
```

**特性**：
- 自动检测旧表结构
- 无损迁移现有数据
- 所有现有会话标记为活跃（is_active=1）

### 2. 会话切换逻辑

**文件**：`src/session-manager.ts:70-120`

```typescript
async switchProject(
  channel: 'feishu' | 'acp',
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
  const session = { ... };
  this.db.prepare(`INSERT INTO sessions ...`).run(...);
  return session;
}
```

**关键点**：
- 取消当前活跃会话（不删除）
- 查找目标项目的会话
- 如果存在则激活，否则创建新会话
- 返回的 Session 对象包含 `claudeSessionId`，用于判断是恢复还是新建

### 3. 会话获取逻辑

**文件**：`src/session-manager.ts:30-68`

```typescript
async getOrCreateSession(
  channel: 'feishu' | 'acp',
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
  const session = { ..., isActive: true };
  this.db.prepare(`INSERT INTO sessions ...`).run(...);
  return session;
}
```

**逻辑**：
1. 优先返回活跃会话
2. 如果没有活跃会话，查找默认项目的会话并激活
3. 如果都没有，创建新会话

### 4. 会话清除逻辑

**文件**：`src/session-manager.ts:122-135`

```typescript
async clearActiveSession(
  channel: 'feishu' | 'acp',
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

**关键点**：
- 只清除活跃会话的 Claude Session ID
- 不影响其他项目的会话
- 保持向后兼容（`clearClaudeSessionId` 别名）

### 5. 会话列表查询

**文件**：`src/session-manager.ts:150-170`

```typescript
async listSessions(
  channel: 'feishu' | 'acp',
  channelId: string
): Promise<Session[]> {
  const rows = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ?
    ORDER BY updated_at DESC
  `).all(channel, channelId);

  return rows.map(row => mapToSession(row));
}
```

**用途**：
- 调试和监控
- 未来的 `/sessions` 命令
- 会话管理功能

### 6. 命令处理更新

**文件**：`src/index.ts:82-145`

#### /switch 命令

```typescript
// 使用新的 switchProject 方法
const newSession = await sessionManager.switchProject(channel, channelId, projectPath);

// 关闭旧会话的 Agent Runner 实例
await agentRunner.closeSession(session.id);

// 提示信息
const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
return `✓ 已切换到项目: ${projectName}\n  路径: ${projectPath}\n  ${hasExistingSession}`;
```

**改进**：
- 使用 `switchProject()` 替代 `updateProjectPath()` + `clearClaudeSessionId()`
- 根据返回的 `claudeSessionId` 判断是恢复还是新建
- 友好的用户提示

#### /bind 命令

```typescript
const newSession = await sessionManager.switchProject(channel, channelId, projectPath);
await agentRunner.closeSession(session.id);

const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
return `✓ 已绑定项目目录: ${projectPath}\n  ${hasExistingSession}`;
```

**改进**：
- 与 `/switch` 使用相同的逻辑
- 提示是恢复还是新建

#### /status 命令

```typescript
const lines = [
  '📊 会话状态：',
  `渠道: ${channel}`,
  `会话ID: ${session.id}`,
  `项目路径: ${session.projectPath}`,
  `活跃状态: ${session.isActive ? '✓ 活跃' : '休眠'}`,
  `Claude会话: ${session.claudeSessionId || '(未初始化)'}`,
  `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
  `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
];
```

**改进**：
- 显示活跃状态

### 7. 类型定义更新

**文件**：`src/types.ts:26-34`

```typescript
export interface Session {
  id: string;
  channel: 'feishu' | 'acp';
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
  isActive: boolean;  // 新增
  createdAt: number;
  updatedAt: number;
}
```

## 测试验证

### 测试文件

`tests/test-multi-session.ts` - 多会话管理功能测试

### 测试场景

1. ✅ 多聊天独立会话
   - 群聊 A、群聊 B、私聊 A 各自独立
   - 每个聊天的会话都是活跃状态

2. ✅ 单聊天多项目切换
   - 从 evolclaw 切换到 backend
   - 验证旧会话被保留但不活跃
   - 验证 Claude Session ID 被保留

3. ✅ 会话恢复
   - 切换回 evolclaw 项目
   - 验证 Claude Session ID 被恢复
   - 验证 backend 会话被保留

4. ✅ /new 命令只影响活跃会话
   - 清除活跃会话的 Claude Session ID
   - 验证其他会话不受影响

5. ✅ 数据库约束
   - 允许切换到同一项目
   - 不会创建重复的会话

6. ✅ 列出所有会话
   - 显示所有会话的状态
   - 按更新时间排序

### 测试结果

```
✓ 所有多会话管理测试通过！
```

## 使用场景

### 场景 1：在多个项目间切换工作

```
# 在 evolclaw 项目工作
用户: 帮我分析一下这个函数
Claude: [分析 evolclaw 项目的代码...]

# 临时切换到 backend 项目
用户: /switch backend
系统: ✓ 已切换到项目: backend（新建会话）

用户: 帮我看看 API 接口
Claude: [分析 backend 项目的代码...]

# 切换回 evolclaw 项目
用户: /switch evolclaw
系统: ✓ 已切换到项目: evolclaw（恢复已有会话）

用户: 继续刚才的分析
Claude: [继续之前的上下文...]
```

### 场景 2：多个聊天独立工作

```
群聊 A（产品团队）: evolclaw 项目
群聊 B（运维团队）: deployment 项目
私聊 A（与同事）: backend 项目
```

每个聊天独立工作，互不干扰。

### 场景 3：清除特定项目的会话

```
# 当前在 evolclaw 项目
用户: /new
系统: ✓ 已清除会话

# evolclaw 项目的会话被清除，但其他项目不受影响
用户: /switch backend
系统: ✓ 已切换到项目: backend（恢复已有会话）
```

## 技术亮点

### 1. 自动数据库迁移

- 检测旧表结构
- 无损迁移现有数据
- 用户无感知升级

### 2. 会话保留机制

- 项目切换时不删除会话
- 只改变活跃状态
- Claude Session ID 完整保留

### 3. 智能会话恢复

- 切换回之前的项目时自动恢复
- 上下文完整保留
- 用户体验流畅

### 4. 向后兼容

- 保留 `clearClaudeSessionId()` 别名
- 保留 `updateProjectPath()` 方法
- 旧代码仍然可以工作

### 5. 友好的用户提示

- 明确提示是恢复还是新建
- 显示活跃状态
- 清晰的错误信息

## 性能和可靠性

### 数据库性能

- 查询使用索引（UNIQUE 约束自动创建索引）
- 单次查询复杂度 O(1)
- 迁移操作一次性完成

### 数据一致性

- 每个聊天只有一个活跃会话（通过 UPDATE 保证）
- 不会出现多个活跃会话
- 数据库约束防止重复

### 错误处理

- 路径不存在 → 友好错误提示
- 项目不存在 → 提示使用 `/plist`
- 数据库错误 → 自动回滚

## 与设计文档的对应

### docs/multi-session-design.md

所有设计都已实现：
- ✅ 数据库 Schema 更新
- ✅ `switchProject()` 方法
- ✅ `clearActiveSession()` 方法
- ✅ `listSessions()` 方法
- ✅ 自动数据库迁移
- ✅ 命令处理更新
- ✅ 测试用例

## 文件清单

### 修改的文件

1. `src/types.ts` - 添加 `isActive` 字段
2. `src/session-manager.ts` - 实现多会话管理逻辑
3. `src/index.ts` - 更新命令处理逻辑

### 新增的文件

1. `tests/test-multi-session.ts` - 多会话管理测试
2. `docs/multi-session-design.md` - 设计文档
3. `docs/multi-session-implementation-report.md` - 本报告

### 更新的文档

1. `docs/multi-project-and-commands.md` - 更新为 v2.0

## 后续优化建议

### 1. /sessions 命令

```
/sessions
```

输出：
```
📋 当前聊天的所有会话：
  ✓ evolclaw (/home/user/evolclaw) - 活跃
    Claude Session: aaa-bbb-ccc
    更新时间: 2026-03-09 10:30:15

  backend (/home/user/backend)
    Claude Session: ddd-eee-fff
    更新时间: 2026-03-09 09:15:42
```

### 2. 会话自动清理

- 30 天未使用的会话自动删除
- 定期清理任务
- 保留活跃会话

### 3. /cleanup 命令

```
/cleanup
```

手动清理非活跃会话。

### 4. 会话统计

- 每个项目的使用频率
- 会话持续时间
- Token 使用量

## 总结

多会话管理功能已完整实现并通过测试，解决了项目切换时会话丢失的问题。用户现在可以：

1. ✅ 在多个项目之间自由切换
2. ✅ 自动保留和恢复每个项目的会话历史
3. ✅ 多个聊天独立工作，互不干扰
4. ✅ 清除特定项目的会话，不影响其他项目

系统架构更加灵活，用户体验显著提升。

---

**实现日期**：2026-03-09
**实现人员**：Claude Code
**测试状态**：✅ 全部通过
**生产就绪**：✅ 是
**功能完整度**：100%
