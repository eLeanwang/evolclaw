# threadId 命名统一重构

## 问题

在 AUN Channel 的消息处理链路中，`thread_id` 在不同层级使用了不一致的变量名：

```
AUN payload.thread_id → taskId → replyContext.threadId → event.taskId → handler threadId
```

这种命名不一致容易造成混淆，特别是 `taskId` 这个名字会让人误以为是任务标识符（实际上 AUN 协议中确实有独立的 `task_id` 字段用于任务管理）。

## 解决方案

将整个链路统一使用 `threadId` 命名：

```
AUN payload.thread_id → threadId → replyContext.threadId → event.threadId → handler threadId
```

## 修改内容

### src/channels/aun.ts

1. **L985**: P2P 消息提取
   ```typescript
   // 修改前
   const taskId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
   
   // 修改后
   const threadId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
   ```

2. **L1069, L1077**: P2P 消息分发
   ```typescript
   // 修改前
   if (taskId) replyContext.threadId = taskId;
   this.dispatchMessage({ ..., taskId, ... });
   
   // 修改后
   if (threadId) replyContext.threadId = threadId;
   this.dispatchMessage({ ..., threadId, ... });
   ```

3. **L1093**: 群组消息提取
   ```typescript
   // 修改前
   const taskId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
   
   // 修改后
   const threadId = typeof payload === 'object' && payload !== null ? (payload as any).thread_id : undefined;
   ```

4. **L1295, L1297**: 群组消息分发
   ```typescript
   // 修改前
   threadId,
   replyContext: this.buildGroupReplyContext(taskId, ...),
   
   // 修改后
   threadId,
   replyContext: this.buildGroupReplyContext(threadId, ...),
   ```

5. **L446**: buildGroupReplyContext 方法签名
   ```typescript
   // 修改前
   private buildGroupReplyContext(taskId: string | undefined, ...)
   
   // 修改后
   private buildGroupReplyContext(threadId: string | undefined, ...)
   ```

6. **L1305**: dispatchMessage 接口定义
   ```typescript
   // 修改前
   private dispatchMessage(event: { ..., taskId?: string, ... })
   
   // 修改后
   private dispatchMessage(event: { ..., threadId?: string, ... })
   ```

7. **L1359-1360, L1374**: dispatchMessage 内部使用
   ```typescript
   // 修改前
   if (!replyContext && event.taskId) {
     replyContext = { threadId: event.taskId };
   }
   this.messageHandler({ ..., threadId: event.taskId, ... });
   
   // 修改后
   if (!replyContext && event.threadId) {
     replyContext = { threadId: event.threadId };
   }
   this.messageHandler({ ..., threadId: event.threadId, ... });
   ```

## 未修改的 taskId

以下位置的 `taskId` **不应修改**，因为它们指的是 AUN 协议中的任务标识符（`task_id`），与线程标识符（`thread_id`）是不同的概念：

- L129-130: `payload.task_id` 提取
- L1851, L2154: `context.metadata.taskId` → `payload.task_id` 映射
- L1968-2006: `sendThought()` 方法的任务参数
- L2267-2335: `sendProcessingStatus()` 方法的任务参数
- L2594-2623: 事件总线中的任务处理

## 概念区分

| 概念 | AUN 字段 | 代码变量 | 用途 |
|------|----------|----------|------|
| 线程标识符 | `thread_id` | `threadId` | 标识会话线程，用于消息路由到特定 session |
| 任务标识符 | `task_id` | `taskId` | 标识 agent 处理任务，用于思考流、状态通知等 |

## 验证

修改后的代码通过 TypeScript 编译（现有的编译错误与本次修改无关）。

## 影响范围

- ✅ P2P 消息接收和分发
- ✅ 群组消息接收和分发
- ✅ ReplyContext 构造
- ✅ MessageHandler 调用
- ✅ 类型定义

## 日期

2026-05-24
