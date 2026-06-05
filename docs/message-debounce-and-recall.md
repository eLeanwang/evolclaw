# 消息去抖合并与撤回

## 背景

EvolClaw 按 `chatType` 选择两种消息处理模式：

| 模式 | 适用场景 | 合并位置 | 新消息行为 |
|------|----------|----------|------------|
| **Interrupt**（单聊） | `chatType !== 'group'` | 入队前（StreamDebouncer） | 中断当前处理 |
| **FIFO**（群聊） | `chatType === 'group'` | 出队后（MessageQueue 贪心弹出） | 排队等待 |

用户在飞书客户端撤回消息后，EvolClaw 在消息尚未被 Agent 处理前精确取消该条消息。

## 消息流总览

```
Channel.onMessage
  ↓
MessageBridge.register()
  ├─ owner 绑定
  ├─ 命令快速路径
  ├─ session 解析
  ├─ 策略前缀
  ├─ 构造 fullMessage
  └─ ACK（每条消息到达时立即确认，不等合并）
       ↓
  ┌─── chatType !== 'group' ───┐    ┌─── chatType === 'group' ───┐
  │  Interrupt 模式              │    │  FIFO 模式                  │
  │                              │    │                             │
  │  StreamDebouncer.submit()    │    │  直接 doEnqueue()           │
  │    (2s 窗口合并同 peerId)    │    │    ↓                        │
  │    ↓                         │    │  MessageQueue.enqueue()     │
  │  doEnqueue()                 │    │    (interruptible: false)   │
  │    ↓                         │    │    ↓                        │
  │  MessageQueue.enqueue()      │    │  排队等待                    │
  │    (interruptible: true)     │    │    ↓                        │
  │    ↓                         │    │  processNext()              │
  │  interrupt 当前处理          │    │    dequeueGreedy() 贪心合并  │
  │    ↓                         │    │    ↓                        │
  │  processNext()               │    │  handler(merged)            │
  │    ↓                         │    └─────────────────────────────┘
  │  handler(merged)             │
  └──────────────────────────────┘
```

### 关键代码位置

- 路径分叉：`src/core/message-bridge.ts:100-119`
- Interrupt 判定：`const isInterrupt = chatType !== 'group'`

## Interrupt 模式（单聊）— 入队前合并

```
用户连发 3 条 → StreamDebouncer (2s 窗口)
  → entries 数组累积 → timer 到期 → flush → 合并为 1 条 → 入队
  → interrupt 当前处理 → Agent 处理合并消息
```

### 实现细节

**StreamDebouncer**（`src/utils/stream-debouncer.ts`）：

- **debounce key**：`${session.id}:${peerId}`，不同用户各自独立去抖
- **debounce 窗口**：每条新消息重置 timer（默认 2s）
- **maxWait**：`delayMs * 3`，防止用户持续发消息导致 flush 无限推迟
- **maxMessages**：默认 5 条，达到上限立即 flush
- **entries 结构**：每条消息独立存储，支持精确撤回

```typescript
interface DebouncedEntry {
  messageId?: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  replyContext?: Message['replyContext'];
  rest: Omit<Message, 'content' | 'images' | 'mentions' | 'messageId' | 'replyContext'>;
  resolve: () => void;
  reject: (e: Error) => void;
}

interface PendingWindow {
  entries: DebouncedEntry[];
  timer: ReturnType<typeof setTimeout>;   // debounce timer，每条新消息重置
  maxWaitTimer: ReturnType<typeof setTimeout>;  // 最大等待 timer，首条消息时启动
}
```

### 触发 flush 的条件

| 条件 | 说明 |
|------|------|
| debounce timer 到期 | 最后一条消息后 `delayMs` 无新消息 |
| maxWait timer 到期 | 首条消息后 `delayMs * 3` 强制 flush |
| maxMessages 达到 | 默认 5 条，立即 flush |

## FIFO 模式（群聊）— 出队后贪心合并

```
用户连发 3 条 → 各自独立入队 (3 条)
  → processNext 出队时 dequeueGreedy()
  → 弹出队首连续同 peerId 的消息 → mergeItems() → handler(merged)
```

### 实现细节

**dequeueGreedy**（`src/core/message-queue.ts:145-158`）：

- 弹出队首第一条消息
- 继续弹出后续与第一条 `peerId` 相同的消息
- 遇到不同 `peerId` 或队列为空时停止
- 单条消息时跳过合并，直接处理

**示例**：队列 `[u1-a, u1-b, u2-a, u1-c]`
→ 第一批：`[u1-a, u1-b]`（合并） → 第二批：`[u2-a]` → 第三批：`[u1-c]`

### 优势

- 无抖动等待延迟，消息到达即入队
- 每条消息可独立精确撤回（撤回时尚未合并）
- 不跨用户合并，保证消息归属正确

## 合并规则

Interrupt 和 FIFO 两种模式使用相同的合并逻辑：

| 字段 | 合并方式 | 说明 |
|------|----------|------|
| `content` | `\n` 连接 | `'aaa\nbbb\nccc'` |
| `images` | 扁平合并 | `[img1, img2, img3]`，无图片时 `undefined` |
| `mentions` | 扁平合并 | `[m1, m2]`，无 mention 时 `undefined` |
| `messageId` | 置空 | 合并后不代表某一条具体消息，不引用回复；ACK 在合并前逐条完成 |
| `replyContext` | 取最后一条 | Agent 不关心 replyContext，仅用于出站路由 |
| `peerName` | 取最后一条 | 同一用户的消息，peerName 不变 |
| 其余字段 | 取最后一条 | `channel`、`channelId`、`chatType`、`timestamp` 等 |

## 撤回链路

```
飞书 im.message.recalled_v1 事件
  → FeishuChannel.recallHandler(messageId)      — src/channels/feishu.ts:290-296
    → MessageBridge.cancel(messageId)            — src/core/message-bridge.ts:157-164
      → 阶段 1: StreamDebouncer.cancel(messageId)  — 遍历所有 debouncer 的 pending 窗口
      → 阶段 2: MessageQueue.cancel(messageId)     — 遍历所有队列查找精确匹配
      → 未找到: 返回 false（消息正在处理或已处理完毕）
```

### 连线代码

```typescript
// src/index.ts:234-236
inst.channel.onRecall?.((messageId: string) => {
  msgBridge.cancel(messageId);
});
```

### 各阶段撤回行为

| 消息状态 | 所在位置 | 撤回结果 |
|----------|----------|----------|
| debounce 窗口中（Interrupt 模式） | StreamDebouncer.pending | 精确移除该条，其余消息不受影响；窗口空了则整个取消 |
| 队列中排队（FIFO 模式） | MessageQueue.queues | 精确移除，resolve 对应 promise |
| 正在 Agent 处理中 | 已出队 | 两阶段均未找到，返回 false，忽略 |
| 已处理完毕 | 无 | 同上 |

### 撤回处理细节

**StreamDebouncer.cancel**（`src/utils/stream-debouncer.ts:87-106`）：
- 遍历所有 pending 窗口，按 `messageId` 查找
- 找到后 `splice` 移除并 `resolve()`（静默完成，不报错）
- 窗口为空时清除 timer + maxWaitTimer，删除窗口

**MessageQueue.cancel**（`src/core/message-queue.ts:220-231`）：
- 遍历所有队列，按 `messageId` 精确匹配
- 找到后 `splice` 移除并 `resolve()`
- 不支持部分撤回已合并的消息（合并后 messageId 为逗号分隔的多 ID）

## 渠道撤回能力

| 渠道 | 撤回事件 | 实现状态 | 说明 |
|------|----------|----------|------|
| Feishu | `im.message.recalled_v1` | 已实现 | 推送 `message_id`、`chat_id`、`recall_type` |
| WeChat | 无 | 不支持 | ilink `getupdates` 不提供撤回事件 |
| AUN | 无 | 不支持 | 仅 `message.received` / `group.message_created` |

飞书开放平台需订阅 `im.message.recalled_v1` 事件，需要 `im:message` 或 `im:message:readonly` 权限。

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/utils/stream-debouncer.ts` | entries 数组结构，`cancel()` 精确撤回，maxWait timer |
| `src/core/message-bridge.ts` | 按 chatType 分叉路径；`cancel()` 穿透 debouncer + queue；debounce key 含 peerId |
| `src/core/message-queue.ts` | `cancel()` 精确撤回；`dequeueGreedy()` + `mergeItems()` FIFO 贪心合并 |
| `src/channels/feishu.ts` | 注册 `im.message.recalled_v1` 事件，`onRecall()` 回调 |
| `src/index.ts` | 连线 `onRecall → msgBridge.cancel` |

## 测试覆盖

### 单元测试

**StreamDebouncer**（`tests/unit/stream-debouncer.test.ts` — 21 个 case）：
- 单条 / 多条消息合并、images / mentions / messageId 合并
- timer 重置、session 隔离、maxMessages 强制 flush、maxWait 强制 flush
- cancel 精确撤回、cancel 清空窗口、cancel 保留 images
- dispose 清理、enqueue 失败 reject

**MessageQueue**（`tests/unit/message-queue.test.ts` — 11 个 case）：
- 基本入队处理、不同 session 并行、错误处理
- cancel 撤回排队消息、cancel 不存在的消息、cancel resolve 不 reject
- FIFO 贪心合并同 peerId、不同 peerId 停止合并、images/mentions 合并、peerName/replyContext 取最后一条

### 集成测试

**撤回 + 合并**（`tests/integration/recall-and-merge.test.ts` — 9 个 case）：
- 完整撤回链路：debouncer 阶段撤回、queue 阶段撤回、处理中不可撤回、全部撤回不入队
- Interrupt 模式：debouncer 合并后入队、不同 peerId 独立 debounce
- FIFO 模式：出队时贪心合并、排队中精确撤回、不跨用户合并
