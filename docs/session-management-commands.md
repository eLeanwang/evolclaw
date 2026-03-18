# 会话管理命令设计方案

## 概述

为 EvolClaw 添加会话查看和切换功能，让用户可以在同一个聊天中管理多个项目会话。

## 新增命令

### 1. `/sessions` - 列出会话

**功能**：显示当前聊天的所有会话列表

**实现位置**：`src/index.ts` 的 `handleProjectCommand()`

**数据库查询**：
```typescript
async listSessionsByChat(channel: string, channelId: string): Promise<Session[]> {
  return this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ?
    ORDER BY is_active DESC, updated_at DESC
  `).all(channel, channelId) as Session[];
}
```

**显示逻辑**：
```typescript
if (command === '/sessions' || command === '/slist') {
  const sessions = await sessionManager.listSessionsByChat(channel, channelId);

  if (sessions.length === 0) {
    return '当前聊天没有会话记录';
  }

  let response = '📋 当前聊天的会话列表：\n\n';

  sessions.forEach((session, index) => {
    const isActive = session.isActive ? '✓ [活跃] ' : '';
    const claudeSession = session.claudeSessionId || '(空 - 将创建新会话)';
    const timeAgo = formatTimeAgo(session.updatedAt);

    response += `${index + 1}. ${isActive}${session.projectPath}\n`;
    response += `   会话ID: ${session.id.substring(0, 30)}...\n`;
    response += `   Claude会话: ${claudeSession.substring(0, 20)}...\n`;
    response += `   最后活动: ${timeAgo}\n\n`;
  });

  response += '使用 /switch <编号|项目路径> 切换会话';
  return response;
}
```

### 2. 扩展 `/switch` 命令

**新增功能**：支持按编号或会话ID切换

**实现逻辑**：
```typescript
if (command === '/switch') {
  const arg = args.trim();

  // 1. 检查是否为编号（数字）
  if (/^\d+$/.test(arg)) {
    const index = parseInt(arg) - 1;
    const sessions = await sessionManager.listSessionsByChat(channel, channelId);

    if (index < 0 || index >= sessions.length) {
      return `❌ 无效的编号，请使用 /sessions 查看可用会话`;
    }

    const targetSession = sessions[index];
    await sessionManager.switchToSession(targetSession.id);

    return `✓ 已切换到会话 ${index + 1}: ${targetSession.projectPath}`;
  }

  // 2. 检查是否为会话ID
  if (arg.startsWith('feishu-') || arg.startsWith('aun-')) {
    const targetSession = await sessionManager.getSessionById(arg);

    if (!targetSession) {
      return `❌ 会话不存在: ${arg}`;
    }

    await sessionManager.switchToSession(arg);
    return `✓ 已切换到会话: ${targetSession.projectPath}`;
  }

  // 3. 按项目路径切换（现有逻辑）
  // ... 保持原有实现
}
```

### 3. `/session` - 当前会话详情

**功能**：显示当前活跃会话的详细信息

**实现**：
```typescript
if (command === '/session' || command === '/sinfo') {
  const session = await sessionManager.getActiveSession(channel, channelId);

  if (!session) {
    return '当前没有活跃会话';
  }

  const claudeSession = session.claudeSessionId || '(空)';
  const status = session.isActive ? '活跃' : '非活跃';
  const created = new Date(session.createdAt).toLocaleString('zh-CN');
  const updated = new Date(session.updatedAt).toLocaleString('zh-CN');

  // 检查会话文件是否存在
  const homeDir = os.homedir();
  const encodedPath = session.projectPath.replace(/\//g, '-').replace(/^-/, '');
  const sessionFile = path.join(homeDir, '.claude', 'projects', encodedPath,
    `${session.claudeSessionId}.jsonl`);
  const fileExists = session.claudeSessionId && fs.existsSync(sessionFile);

  return `📌 当前会话信息：

会话ID: ${session.id}
项目路径: ${session.projectPath}
Claude会话ID: ${claudeSession}
状态: ${status}
创建时间: ${created}
最后更新: ${updated}
会话文件: ${fileExists ? '存在' : '不存在（将自动创建）'}`;
}
```

## SessionManager 新增方法

### 1. `listSessionsByChat()`

```typescript
async listSessionsByChat(channel: string, channelId: string): Promise<Session[]> {
  const rows = this.db.prepare(`
    SELECT * FROM sessions
    WHERE channel = ? AND channel_id = ?
    ORDER BY is_active DESC, updated_at DESC
  `).all(channel, channelId) as any[];

  return rows.map(row => ({
    id: row.id,
    channel: row.channel,
    channelId: row.channel_id,
    projectPath: row.project_path,
    claudeSessionId: row.claude_session_id,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}
```

### 2. `getSessionById()`

```typescript
async getSessionById(sessionId: string): Promise<Session | null> {
  const row = this.db.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `).get(sessionId) as any;

  if (!row) return null;

  return {
    id: row.id,
    channel: row.channel,
    channelId: row.channel_id,
    projectPath: row.project_path,
    claudeSessionId: row.claude_session_id,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
```

### 3. `switchToSession()`

```typescript
async switchToSession(sessionId: string): Promise<void> {
  const session = await this.getSessionById(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // 清除当前聊天的所有活跃会话
  this.db.prepare(`
    UPDATE sessions
    SET is_active = 0
    WHERE channel = ? AND channel_id = ?
  `).run(session.channel, session.channelId);

  // 激活目标会话
  this.db.prepare(`
    UPDATE sessions
    SET is_active = 1, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), sessionId);
}
```

## 工具函数

### `formatTimeAgo()`

```typescript
function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;

  return new Date(timestamp).toLocaleDateString('zh-CN');
}
```

## 用户体验优化

### 1. 切换确认

切换会话时显示清晰的提示：
```
✓ 已切换到会话 2: /data/openclaw-root
  Claude会话: 951de321-xxx (将恢复历史对话)
  最后活动: 5小时前
```

### 2. 空会话提示

如果 Claude 会话为空：
```
✓ 已切换到会话 1: /home/evolclaw
  ⚠️ 此会话没有历史记录，将创建新会话
```

### 3. 会话文件丢失提示

如果会话文件不存在（已被自动处理）：
```
✓ 已切换到会话: /home/molbox
  ℹ️ 会话文件不存在，已自动创建新会话
```

## 实现优先级

1. **高优先级**：
   - `/sessions` 命令（核心功能）
   - 扩展 `/switch` 支持编号切换
   - `SessionManager.listSessionsByChat()`

2. **中优先级**：
   - `/session` 命令（详情查看）
   - 扩展 `/switch` 支持会话ID切换
   - `formatTimeAgo()` 工具函数

3. **低优先级**：
   - 会话文件存在性检查（已实现）
   - 更丰富的显示格式

## 测试场景

1. **基本流程**：
   - 用户发送 `/sessions` 查看会话列表
   - 用户发送 `/switch 2` 切换到第2个会话
   - 验证会话已切换，项目路径正确

2. **边界情况**：
   - 没有会话时显示提示
   - 切换到不存在的编号
   - 切换到不存在的会话ID

3. **会话恢复**：
   - 切换到有历史的会话，验证对话历史恢复
   - 切换到空会话，验证创建新会话

## 兼容性

- 保持现有 `/switch <项目名>` 功能不变
- 所有新命令都是可选的，不影响现有用户
- 数据库结构无需修改

## 后续扩展

1. **会话重命名**：`/session rename <新名称>`
2. **会话删除**：`/session delete <编号>`
3. **会话导出**：`/session export <编号>` 导出会话历史
4. **会话搜索**：`/sessions search <关键词>` 搜索会话内容
