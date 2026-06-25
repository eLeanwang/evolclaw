# taskId 完整分析

## 概念定义

`taskId` 是 EvolClaw 中用于标识一次 **agent 处理任务** 的唯一标识符，与 `threadId`（线程标识符）是完全不同的概念。

| 概念 | AUN 字段 | 代码变量 | 用途 |
|------|----------|----------|------|
| 线程标识符 | `thread_id` | `threadId` | 标识会话线程，用于消息路由到特定 session |
| 任务标识符 | `task_id` | `taskId` | 标识 agent 处理任务，用于思考流、状态通知、日志关联 |

## 生命周期

### 1. 生成时机

**主要生成点**：`message-processor.ts:390`

```typescript
// 为本次任务处理生成唯一 task_id（客户端生成，格式 task-{10hex}）
const taskId = `task-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
```

**格式规范**：
- 正常任务：`task-{10位hex}` （如 `task-a1b2c3d4e5`）
- 命令回显：`cmd-{5位hex}` （如 `cmd-a1b2c`）
- 菜单交互：`menu-{4位hex}` （如 `menu-a1b2`）
- 系统通知：`system-online-{5位hex}` / `system-channel-down-{5位hex}` / `system-restart-{pid}`
- 兜底格式：`interaction-{timestamp}-{6位随机}`

### 2. 传递路径

```
MessageProcessor.processMessage()
  ↓ 生成 taskId
  ↓
buildEnvelope({ taskId, ... })
  ↓ 构造 OutboundEnvelope
  ↓
IMRenderer.send() → adapter.send(envelope, payload)
  ↓ 注入到 ReplyContext.metadata.taskId
  ↓
AUN Channel.deliverTextEntry()
  ↓ context.metadata.taskId → payload.task_id
  ↓
AUN 网络（message.send / thought.put / status）
```

### 3. 持久化方式

#### Session 级持久化

**位置**：`~/.evolclaw/sessions/<channel>/<channelId>/active.json`

**字段**：`activeTask: string`

**格式**：`{timestamp}:{taskId}` （如 `1716800000000:task-a1b2c3d4e5`）

**操作**：
- **写入**：`SessionManager.markProcessing(sessionId, taskId)` - 任务开始时
- **读取**：`SessionManager.getActiveTaskId(sessionId)` - 恢复上下文时
- **清除**：`SessionManager.clearProcessing(sessionId)` - 任务结束时

**代码**：
```typescript
// session-manager.ts:356-383
markProcessing(sessionId: string, taskId?: string): void {
  const now = Date.now();
  const state = taskId ? `${now}:${taskId}` : String(now);
  // ... 写入 active.json
}

getActiveTaskId(sessionId: string): string | undefined {
  // ... 读取 active.json
  const colonIdx = active.activeTask.indexOf(':');
  return colonIdx > 0 ? active.activeTask.slice(colonIdx + 1) : undefined;
}
```

#### 日志持久化

**位置**：
- `~/.evolclaw/logs/channel-out.log` - 出站消息日志
- `~/.evolclaw/logs/events.log` - 事件日志
- `~/.evolclaw/logs/aun-trace.jsonl` - AUN 协议追踪（可选）

**用途**：
- 关联同一任务的所有出站消息
- 追踪任务生命周期事件
- 调试和审计

## 使用场景

### 1. 思考流（Thought Stream）

**AUN 协议**：`message.thought.put` / `group.thought.put`

**参数**：
```typescript
{
  context: { type: 'task', id: taskId },
  payload: { /* 思考内容 */ },
  encrypt: boolean
}
```

**存储键**：`{group_id/peer_aid} + {sender_aid} + context.type + context.id`

**代码位置**：`aun.ts:1968-2008`

### 2. 状态通知（Processing Status）

**AUN 协议**：`message.status` / `group.status`

**状态类型**：
- `start` - 任务开始
- `queued` - 任务排队
- `done` - 任务完成
- `interrupted` - 任务中断
- `error` - 任务错误
- `timeout` - 任务超时

**Payload 字段**：
```typescript
{
  status: 'start' | 'done' | ...,
  session_id: string,
  task_id: string,  // ← taskId 在这里
  thread_id?: string,
  initiator?: string,
  ref_message_id?: string,
  severity?: 'info' | 'warning' | 'error'
}
```

**代码位置**：`aun.ts:2267-2335`

### 3. 消息发送

**AUN 协议**：`message.send` / `group.send`

**Payload 字段**：
```typescript
{
  type: 'text',
  text: string,
  task_id?: string,     // ← taskId 在这里
  thread_id?: string,   // threadId（不同概念）
  chatmode?: 'interactive' | 'proactive',
  mentions?: string[]
}
```

**代码位置**：`aun.ts:1851`

### 4. 文件发送

**AUN 协议**：`message.send` / `group.send`

**Payload 字段**：
```typescript
{
  type: 'file',
  attachments: [...],
  task_id?: string,     // ← taskId 在这里
  thread_id?: string,
  chatmode?: string
}
```

**代码位置**：`aun.ts:2154`

### 5. 权限审批上下文

**用途**：权限提示时告知用户当前任务上下文

**代码位置**：`command-handler.ts:3714-3723`

```typescript
const taskId = this.sessionManager.getActiveTaskId(session.id);
// ...
if (taskId) ctx.metadata.taskId = taskId;
```

### 6. 日志关联

**channel-out.log**：
```typescript
logger.channelOut({ 
  channel, 
  channelId, 
  taskId: envelope.taskId,  // ← 关联所有出站消息
  payload 
});
```

**events.log**：
```typescript
eventBus.publish({ 
  type: 'task:started', 
  sessionId, 
  agentName, 
  encrypt, 
  chatmode 
});
```

## 与 threadId 的区别

| 维度 | taskId | threadId |
|------|--------|----------|
| **概念** | 任务标识符 | 线程标识符 |
| **粒度** | 一次处理任务 | 一个会话线程 |
| **生命周期** | 任务开始到结束 | 线程创建到销毁 |
| **来源** | 本地生成 | 对端指定或本地生成 |
| **AUN 字段** | `task_id` | `thread_id` |
| **用途** | 思考流、状态通知、日志关联 | 消息路由、会话隔离 |
| **持久化** | session.activeTask | session.threadId |
| **可选性** | 可选（系统通知可能没有） | 可选（主会话没有） |

## 典型流程示例

### 场景：用户发送消息 "帮我写个函数"

```
1. AUN Gateway 收到消息
   payload.thread_id = "topic-123"  // 对端指定的线程 ID
   
2. AUN Channel 提取
   threadId = payload.thread_id  // "topic-123"
   
3. MessageBridge 路由
   根据 threadId 路由到对应的 thread session
   
4. MessageProcessor 生成任务
   taskId = "task-a1b2c3d4e5"  // 新生成
   
5. SessionManager 持久化
   active.json: { activeTask: "1716800000000:task-a1b2c3d4e5" }
   
6. Agent 处理
   - 思考流：thought.put({ context: { type: 'task', id: 'task-a1b2c3d4e5' } })
   - 状态通知：status({ task_id: 'task-a1b2c3d4e5', status: 'start' })
   
7. Agent 回复
   payload = {
     type: 'text',
     text: '这是函数代码...',
     task_id: 'task-a1b2c3d4e5',    // 任务标识
     thread_id: 'topic-123',         // 线程标识
     chatmode: 'interactive'
   }
   
8. 任务完成
   SessionManager.clearProcessing(sessionId)
   active.json: { activeTask: null }
```

## 调试技巧

### 1. 追踪任务的所有消息

```bash
# 查看某个任务的所有出站消息
jq 'select(.taskId == "task-a1b2c3d4e5")' ~/.evolclaw/logs/channel-out.log
```

### 2. 追踪 AUN 协议中的 task_id

```bash
# 查看某个任务的 AUN 协议交互
jq 'select(.task_id == "task-a1b2c3d4e5")' ~/.evolclaw/logs/aun-trace.jsonl
```

### 3. 查看当前活跃任务

```bash
# 查看所有 session 的活跃任务
find ~/.evolclaw/sessions -name active.json -exec jq '{id, activeTask}' {} \;
```

### 4. 区分 task_id 和 thread_id

```bash
# 同时显示两者
jq '{task_id, thread_id, text: .payload.text}' ~/.evolclaw/logs/aun-trace.jsonl
```

## 设计原则

1. **唯一性**：每次任务处理生成新的 taskId，即使在同一个 thread 中
2. **可追踪**：通过 taskId 可以关联任务的所有输出（思考流、状态、消息）
3. **可恢复**：持久化到 session，重启后可恢复任务上下文
4. **可调试**：格式化的前缀便于日志过滤和问题定位
5. **协议透明**：通过 AUN 协议的 `task_id` 字段传递给对端

## 未来扩展

可能的扩展方向：
- 任务级别的重试机制
- 任务级别的超时控制
- 任务级别的资源限制
- 任务间的依赖关系
- 任务的暂停/恢复
- 任务的优先级调度

## 日期

2026-05-24
