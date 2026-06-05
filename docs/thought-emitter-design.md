# ThoughtEmitter — Proactive 模式可观测性方案

## 背景

Proactive 模式下，Agent 的流式输出完全静默（`StreamFlusher silent=true`），用户只能看到 `ctl send` / `ctl file` 发出的最终结果。这导致 Agent 的工作过程不可观测。

本方案通过 AUN 协议的 thought 机制（群聊 `group.thought.put`、单聊 `message.thought.put`），将 Proactive 模式下的所有流式事件实时发送为 thought 内容，使对端可通过对应的 `thought.get` 主动查看 Agent 的思考/工作过程，而不污染正式消息流。

## 设计目标

1. Proactive 模式下所有流式事件实时透传为 thought
2. thought 锚定触发消息的 message_id，支持动态切换
3. 不做聚合/batching，逐事件发送，实时性优先
4. AUN 通道 Proactive 模式下群聊和单聊均生效
5. ThoughtEmitter 不感知 group vs P2P，通道差异由 adapter 内部处理
6. 不影响其他通道（Feishu / WeChat）和 Interactive 模式

## 协议映射

### reply_to.message_id 动态跟踪

- 正常消息：使用 `message.messageId`
- Merged 消息（快速连发合并）：使用合并前最后一条的 messageId
- 处理中新消息到达：`replyToMessageId` 立即切换到新消息的 ID

### AgentEvent → thought payload 映射

| AgentEvent type | 是否发送 | stage | payload 格式 |
|-----------------|:--------:|-------|-------------|
| `text` | 是 | `thinking` | `{type: "thought", text: event.text, stage: "thinking"}` |
| `tool_use` | 是 | `tool` | `{type: "thought", text: "🔧 {name}: {description}", stage: "tool", metadata: {tool: name, input: summarized}}` |
| `tool_result` (success) | 是 | `tool` | `{type: "thought", text: "✅ {name}: {truncated result}", stage: "tool", metadata: {tool: name, ok: true}}` |
| `tool_result` (error) | 是 | `tool` | `{type: "thought", text: "⚠️ {name}: {error}", stage: "tool", metadata: {tool: name, ok: false}}` |
| `compact` | 是 | `system` | `{type: "thought", text: "💡 会话压缩完成 (压缩前 tokens: {n})", stage: "system"}` |
| `task_progress` | 是 | `planning` | `{type: "thought", text: "⏳ 子任务: {summary} ({stats})", stage: "planning"}` |
| `error` | 是 | `error` | `{type: "thought", text: "❌ {error}", stage: "error"}` |
| `complete` (success) | 是 | `summary` | `{type: "thought", text: "{result}", stage: "summary"}` |
| `complete` (error) | 是 | `error` | `{type: "thought", text: "❌ {errors}", stage: "error"}` |
| `session_id` | 否 | — | 内部状态，不发送 |
| `state_changed` | 否 | — | 内部状态，不发送 |
| `status` | 否 | — | 内部状态，不发送 |

### tool_use description 提取

复用现有 `formatToolDescription()` 逻辑：

```typescript
input.description || input.file_path || input.pattern ||
input.command?.substring(0, 80) || input.prompt?.substring(0, 80) ||
input.query?.substring(0, 80) || ''
```

### tool_result 截断策略

- 成功结果：取前 200 字符，超出追加 `...`
- 错误结果：完整输出（通常较短）

## 架构设计

### 新增文件

```
src/core/message/thought-emitter.ts   — ThoughtEmitter 类
```

### 类设计

```typescript
import type { AgentEvent } from '../../agents/claude-runner.js';
import type { ChannelAdapter } from '../../types.js';

export class ThoughtEmitter {
  private adapter: ChannelAdapter;
  private channelId: string;
  private replyToMessageId: string;

  constructor(adapter: ChannelAdapter, channelId: string, replyToMessageId: string) {
    this.adapter = adapter;
    this.channelId = channelId;
    this.replyToMessageId = replyToMessageId;
  }

  /**
   * 动态更新锚定的消息 ID（新消息到达时调用）
   */
  updateReplyTo(messageId: string): void {
    this.replyToMessageId = messageId;
  }

  /**
   * 将 AgentEvent 转换为 thought payload 并发送
   * 不做聚合，逐事件调用 adapter.putThought()
   */
  async emit(event: AgentEvent): Promise<void> {
    const payload = this.mapEventToPayload(event);
    if (!payload) return; // session_id / state_changed / status → skip

    await this.adapter.putThought?.(
      this.channelId,
      this.replyToMessageId,
      payload
    );
  }

  private mapEventToPayload(event: AgentEvent): ThoughtPayload | null {
    switch (event.type) {
      case 'text':
        return { type: 'thought', text: event.text, stage: 'thinking' };

      case 'tool_use':
        return {
          type: 'thought',
          text: `🔧 ${event.name}: ${this.summarizeInput(event.input)}`,
          stage: 'tool',
          metadata: { tool: event.name, input: this.summarizeInput(event.input) },
        };

      case 'tool_result':
        if (event.isError) {
          return {
            type: 'thought',
            text: `⚠️ ${event.name}: ${event.error || '执行失败'}`,
            stage: 'tool',
            metadata: { tool: event.name, ok: false },
          };
        }
        return {
          type: 'thought',
          text: `✅ ${event.name}: ${this.truncate(String(event.result), 200)}`,
          stage: 'tool',
          metadata: { tool: event.name, ok: true },
        };

      case 'compact':
        return {
          type: 'thought',
          text: `💡 会话压缩完成 (压缩前 tokens: ${event.preTokens})`,
          stage: 'system',
        };

      case 'task_progress': {
        const stats = this.formatTaskStats(event);
        const text = event.summary
          ? `⏳ 子任务: ${event.summary}${stats ? ` (${stats})` : ''}`
          : `⏳ 子任务进行中${stats ? `: ${stats}` : ''}`;
        return { type: 'thought', text, stage: 'planning' };
      }

      case 'error':
        return { type: 'thought', text: `❌ ${event.error}`, stage: 'error' };

      case 'complete':
        if (event.isError) {
          const errText = event.errors?.join('; ') || event.result || '任务失败';
          return { type: 'thought', text: `❌ ${errText}`, stage: 'error' };
        }
        if (event.result) {
          return { type: 'thought', text: event.result, stage: 'summary' };
        }
        return null;

      // 内部状态事件，不发送
      case 'session_id':
      case 'state_changed':
      case 'status':
        return null;

      default:
        return null;
    }
  }

  private summarizeInput(input: any): string {
    if (!input) return '';
    return (
      input.description ||
      input.file_path ||
      input.pattern ||
      input.command?.substring(0, 80) ||
      input.prompt?.substring(0, 80) ||
      input.query?.substring(0, 80) ||
      ''
    );
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  private formatTaskStats(event: { toolUses?: number; durationMs?: number }): string {
    const parts: string[] = [];
    if (event.toolUses) parts.push(`${event.toolUses} tools`);
    if (event.durationMs) parts.push(`${Math.round(event.durationMs / 1000)}s`);
    return parts.join(', ');
  }
}

interface ThoughtPayload {
  type: 'thought';
  text: string;
  stage: string;
  format?: string;
  metadata?: Record<string, any>;
}
```

### ChannelAdapter 扩展

```typescript
// src/types.ts — ChannelAdapter interface 新增可选方法
export interface ChannelAdapter {
  // ... 现有方法 ...

  /**
   * 发送 thought 内容
   * channelId 在群聊时为 groupId，私聊时为对方 AID
   * adapter 内部按 chatType 决定调用 group.thought.put 或 message.thought.put
   */
  putThought?(channelId: string, replyToMessageId: string, payload: object): Promise<void>;
}
```

### AUN Adapter 实现

```typescript
// src/channels/aun.ts 或 index.ts 中 AUN adapter 定义处
const adapter: ChannelAdapter = {
  // ... 现有方法 ...

  async putThought(channelId, replyToMessageId, payload) {
    if (isGroupId(channelId)) {
      // 群聊 thought
      await aunClient.call('group.thought.put', {
        group_id: channelId,
        reply_to: { message_id: replyToMessageId },
        payload,
      });
    } else {
      // 单聊 thought（P2P）
      await aunClient.call('message.thought.put', {
        to: channelId,
        reply_to: { message_id: replyToMessageId },
        payload,
      });
    }
  },
};
```

> 协议签名已通过 [ModelUnion/aun-sdk-core](https://github.com/ModelUnion/aun-sdk-core) 的 `docs/sdk/09-payload-reference.md` 确认：`message.thought.put` 和 `group.thought.put` 使用同一套业务 payload 约定；P2P 用 `to`，群组用 `group_id`，`reply_to.message_id` 都是顶层必填键。

### MessageProcessor 集成

在 `processEventStream()` 中：

```typescript
// 创建 ThoughtEmitter（条件：proactive + adapter 支持 thought + 有 messageId）
let thoughtEmitter: ThoughtEmitter | null = null;

if (isProactive && adapter.putThought && message.messageId) {
  thoughtEmitter = new ThoughtEmitter(
    adapter,
    message.channelId,  // 群聊时为 groupId，私聊时为对方 AID
    message.messageId
  );
}

// 事件循环中
for await (const event of stream) {
  // 现有处理逻辑...

  // thought 发送（fire-and-forget，不阻塞主流程）
  thoughtEmitter?.emit(event).catch(err => {
    logger.debug('thought.put failed:', err.message);
  });
}
```

### messageId 动态更新 — merged message 处理

当前 MessageQueue 的 merge 逻辑将 `messageId` 置为 `undefined`。需要修改：

```typescript
// src/core/message/message-queue.ts — merge 逻辑
// 现有: messageId: undefined
// 改为: messageId: newMessage.messageId || existingMessage.messageId
// 即保留最新一条的 messageId
```

### messageId 动态更新 — 新消息到达时

当处理中有新消息到达触发 interrupt 时，ThoughtEmitter 需要切换 replyTo。

方案：`MessageProcessor.processEventStream()` 接收一个 `onNewMessage` 回调或通过 EventBus 监听：

```typescript
// 在 processMessage 中注册监听
const onNewInbound = (newMsg: Message) => {
  if (newMsg.messageId) {
    thoughtEmitter?.updateReplyTo(newMsg.messageId);
  }
};

eventBus.on('message:new-inbound', onNewInbound);

// 处理结束后移除
eventBus.off('message:new-inbound', onNewInbound);
```

`MessageQueue.enqueue()` 或 `MessageBridge` 在收到新消息时 emit 此事件。

## 数据流

```
AUN 群消息到达 (message_id: "gm-001")
  │
  ├─ MessageQueue.enqueue()
  │    └─ merged? → 保留最新 messageId
  │
  ├─ MessageProcessor.processMessage()
  │    ├─ 创建 ThoughtEmitter(adapter, groupId, "gm-001")
  │    ├─ 创建 StreamFlusher(silent=true)  ← 现有，不变
  │    │
  │    └─ processEventStream()
  │         │
  │         ├─ event: {type: "text", text: "让我分析..."}
  │         │    ├─ flusher.addText(...)  ← 静默累积
  │         │    └─ thoughtEmitter.emit() → group.thought.put
  │         │         payload: {type:"thought", text:"让我分析...", stage:"thinking"}
  │         │
  │         ├─ event: {type: "tool_use", name: "Grep", input: {pattern: "foo"}}
  │         │    ├─ flusher.addActivity(...)  ← 静默累积
  │         │    └─ thoughtEmitter.emit() → group.thought.put
  │         │         payload: {type:"thought", text:"🔧 Grep: foo", stage:"tool"}
  │         │
  │         ├─ [新消息到达 message_id: "gm-002"]
  │         │    └─ thoughtEmitter.updateReplyTo("gm-002")
  │         │
  │         ├─ event: {type: "text", text: "结果如下..."}
  │         │    └─ thoughtEmitter.emit() → group.thought.put
  │         │         reply_to: "gm-002"  ← 已切换
  │         │
  │         └─ event: {type: "complete", result: "..."}
  │              └─ thoughtEmitter.emit() → group.thought.put
  │                   payload: {type:"thought", text:"...", stage:"summary"}
  │
  └─ Agent 调用 ctl send "最终结果"
       └─ adapter.sendText() → group.send  ← 正式群消息
```

## 错误处理

- `putThought` 失败不阻塞主流程（fire-and-forget + catch log）
- 网络抖动导致 thought 丢失可接受（thought 本身是非持久化的）
- AUN SDK 连接断开时 putThought 会抛异常，被 catch 静默处理

## 边界情况

| 场景 | 处理 |
|------|------|
| merged message 无 messageId | 不会发生 — 改为保留最新 messageId |
| 处理中 interrupt + 新消息 | updateReplyTo 切换到新 messageId |
| 非 AUN 通道 | `adapter.putThought` 不存在，不创建 ThoughtEmitter |
| interactive 模式 | `isProactive=false`，不创建 ThoughtEmitter |
| 私聊 proactive | adapter.putThought 内部调用 `message.thought.put`（P2P 分支） |
| complete 无 result | 不发送 thought（返回 null） |
| text chunk 为空字符串 | 仍然发送（保持逐事件透传语义） |

## 影响范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/core/message/thought-emitter.ts` | 新增 | ThoughtEmitter 类 |
| `src/types.ts` | 修改 | ChannelAdapter 新增 `putThought?` |
| `src/core/message/message-processor.ts` | 修改 | 创建 ThoughtEmitter + 事件循环中调用 emit |
| `src/core/message/message-queue.ts` | 修改 | merge 时保留最新 messageId |
| `src/index.ts` (AUN adapter) | 修改 | 实现 `putThought` 方法 |
| `src/core/event-bus.ts` | 修改 | 新增 `message:new-inbound` 事件类型 |
| `src/core/message/message-bridge.ts` | 修改 | 入队时 emit `message:new-inbound` |

## 后续扩展

- thought 内容过滤：可在 ThoughtEmitter 中加入 stage 白名单配置
- thought 频率限制：如果逐事件发送对服务端压力过大，可后续加入 debounce（当前不做）
- 非 AUN 通道支持：Feishu / WeChat 如需类似的"思考过程可观测"能力，可实现各自的 putThought（例如 Feishu 用卡片折叠区域承载）
