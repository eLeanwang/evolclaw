# Menu 协议修改话题会话名称验证

## 结论

❌ **`menu.update` 不支持 `/topic` 重命名**  
✅ **`menu.action` 支持 `/topic` 重命名**

## Menu 协议设计

### 1. menu.update（值更新）

**用途**：修改配置型字段的值（模型、权限、模式等）

**支持的命令**：
- `/baseagent` - 切换 baseagent
- `/model` - 切换模型
- `/effort` - 切换推理强度
- `/chatmode` - 切换会话模式（interactive/proactive）
- `/dispatch` - 切换群聊分发模式（mention/broadcast）
- `/perm` - 切换权限模式
- `/activity` - 切换中间输出模式
- `/observable` - 切换观察者模式
- `/gateway` - 更新网关配置（进程级）
- `/trigger` - 更新触发器参数（关系级）

**不支持**：`/topic`（兜底返回 `不支持 update: /topic`）

**协议格式**：
```json
{
  "type": "menu.update",
  "id": "req-123",
  "name": "model",
  "cmd": "/model",
  "value": "sonnet"
}
```

### 2. menu.action（动作执行）

**用途**：执行操作型命令（创建、删除、重命名等）

**支持的命令**：
- `/topic` - 话题操作（rename / delete）
- `/session` - 会话操作（new / stop / rename / delete）
- `/trigger` - 触发器操作（create / execute / enable / disable / delete）
- `/file` - 文件操作（list / upload / download / delete）
- `/system` - 系统操作（restart / reload / flush-cache / health-check）
- `/agent` - Agent 操作（reload / bootstrap / set-status）

**协议格式**：
```json
{
  "type": "menu.action",
  "id": "req-123",
  "name": "topic",
  "cmd": "/topic",
  "action": "rename",
  "args": {
    "target": "thread-abc",
    "name": "新名称"
  }
}
```

## 话题重命名的正确方式

### ✅ 使用 menu.action

```json
{
  "type": "menu.action",
  "id": "req-123",
  "name": "topic",
  "cmd": "/topic",
  "action": "rename",
  "args": {
    "target": "thread-abc",
    "name": "新话题名称"
  }
}
```

**响应**（成功）：
```json
{
  "type": "menu.response",
  "id": "req-123",
  "name": "topic",
  "data": {
    "action": "rename",
    "success": true,
    "topic": {
      "id": "sess-456",
      "name": "新话题名称",
      "threadId": "thread-abc",
      "createdAt": 1719300000000,
      "updatedAt": 1719300060000
    }
  }
}
```

**响应**（失败）：
```json
{
  "type": "menu.response",
  "id": "req-123",
  "name": "topic",
  "error": {
    "code": "CONFLICT",
    "message": "名称 \"新话题名称\" 已存在"
  }
}
```

### ❌ 错误：使用 menu.update

```json
{
  "type": "menu.update",
  "id": "req-123",
  "name": "topic",
  "cmd": "/topic",
  "value": "新话题名称"
}
```

**响应**（错误）：
```json
{
  "type": "menu.response",
  "id": "req-123",
  "name": "topic",
  "error": {
    "code": "NOT_SUPPORTED",
    "message": "不支持 update: /topic"
  }
}
```

## execMenuAction 中的话题重命名逻辑

**代码路径**：`src/core/command/menu-handler.ts:1436-1480`

```typescript
if (cmdBase === '/topic') {
  if (action !== 'delete' && action !== 'rename') {
    return { error: `不支持的 topic action: ${action}`, code: 'NOT_SUPPORTED' };
  }
  
  // 1. 提取参数
  const target = (args?.target ?? '').toString().trim();
  if (!target) return { error: '缺少 args.target', code: 'MISSING_VALUE' };
  const renameName = action === 'rename' ? getRenameName(args) : '';
  if (action === 'rename' && !renameName) return { error: '缺少 args.name', code: 'MISSING_VALUE' };
  
  // 2. 查询话题会话
  const topic = await this.sessionManager.getThreadSession(channel, channelId, target);
  if (!topic) return { error: '话题不存在', code: 'NOT_FOUND' };
  
  // 3. 权限检查
  const chatType = topic.chatType === 'group' ? 'group' : 'private';
  if (!this.canDeleteTopic(identity.role, chatType, topic, userId)) {
    return { error: '无权限重命名话题', code: 'FORBIDDEN' };
  }
  
  // 4. rename 分支
  if (action === 'rename') {
    const newName = renameName;
    
    // 名称冲突检查
    const existing = await this.sessionManager.getSessionByName?.(channel, channelId, newName);
    if (existing && existing.id !== topic.id) {
      return { error: `名称 "${newName}" 已存在`, code: 'CONFLICT' };
    }
    
    // 执行重命名
    const oldName = displaySessionTitle(topic.name, topic.threadId || '(未命名)');
    const success = await this.sessionManager.renameSession(topic.id, newName);
    if (!success) return { error: '重命名失败', code: 'EXEC_FAILED' };
    
    // 同步到 Agent SDK
    if (topic.agentSessionId) {
      try {
        const targetAgent = this.getAgent(channel, topic.baseagent);
        await targetAgent.setSessionName?.(topic.agentSessionId, newName);
      } catch {}
    }
    
    // 发布事件
    this.eventBus.publish({ type: 'session:renamed', sessionId: topic.id, oldName, newName });
    
    // 返回成功
    return {
      data: {
        action: 'rename',
        success: true,
        topic: {
          ...buildSessionPayload(topic, newName),
          threadId: topic.threadId,
        },
      },
    };
  }
  
  // delete 分支...
}
```

## 验证点

### ✅ 协议路由正确
- `menu.action` + `action: "rename"` → `execMenuAction`
- `menu.update` → `execMenuUpdate` → 返回 `NOT_SUPPORTED`

### ✅ 权限检查正确
- 调用 `canDeleteTopic(identity.role, chatType, topic, userId)`
- 创建者或 admin/owner 可重命名

### ✅ 名称冲突检查正确
- 调用 `getSessionByName` 检查重名
- 同一 session 允许重命名为相同名称（`existing.id !== topic.id` 判断）

### ✅ 持久化正确
- 调用 `SessionManager.renameSession(topic.id, newName)`
- 内部通过 `persistSession(session, 'sync')` 写入 `.jsonl`

### ✅ SDK 同步正确
- 如果有 `agentSessionId`，调用 `targetAgent.setSessionName`

### ✅ 事件发布正确
- 发布 `session:renamed` 事件

## 常见错误

### 错误 1：使用 menu.update 重命名话题
**现象**：收到 `NOT_SUPPORTED` 错误

**原因**：`/topic` 不支持 `menu.update`

**解决**：改用 `menu.action` + `action: "rename"`

### 错误 2：args 参数缺失
**现象**：收到 `MISSING_VALUE` 错误

**原因**：未提供 `args.target` 或 `args.name`

**解决**：
```json
{
  "type": "menu.action",
  "action": "rename",
  "args": {
    "target": "thread-abc",  // ← 必填：threadId
    "name": "新名称"          // ← 必填：新名称
  }
}
```

### 错误 3：名称冲突
**现象**：收到 `CONFLICT` 错误

**原因**：新名称已被同一 chat 下的其他 session 使用

**解决**：换一个名称，或先删除/重命名冲突的 session

## 总结

通过 Menu 协议修改话题会话名称**完全正常**，但必须使用 **`menu.action`** 而不是 `menu.update`：

```json
{
  "type": "menu.action",
  "name": "topic",
  "action": "rename",
  "args": {
    "target": "<threadId>",
    "name": "<新名称>"
  }
}
```

底层实现与直接调用 `SessionManager.renameSession` 一致，包含完整的权限检查、冲突检查、持久化和 SDK 同步。
