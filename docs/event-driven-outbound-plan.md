# 出站事件订阅架构改造计划

> 状态：阶段 0-2 已完成，阶段 3-6 待实施

## 已完成

| 阶段 | 内容 |
|:-----|:-----|
| **0** | 类型定义：`InboundMessage.chatType`、`ChannelPolicy` 重命名 |
| **1** | 入站优化：chatType 前置到 Channel 层、消除 `isGroupChat` API 调用、`getOrCreateSession` 去重 |
| **2** | 入站清理：命令双重检查移除、`getOrCreateSession` 合并为单次调用（`processMessage` → `resolveSession`） |
| **补充** | `flushDelay=0` 修正（`\|\|` → `??`）；`muteIdleMonitor` → `showIdleMonitor`（语义翻转 + 统一配置）；话题回复 Bug 修复 |

## 整体架构目标

```
改造前:
  Agent ──> StreamFlusher(全局聚合) ──> adapter.sendText(策略判断在此)
                                            ↑ Gateway 层

改造后:
  Agent ──> EventBus.publish(细粒度事件)
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
    Feishu    WeChat    Web UI
   policy     policy    policy
   flush(4s)  flush(2s) flush(0)
   send()     send()    push()
                                  ↑ Channel 层
```

## 核心设计原则

- Gateway 只负责**产出内容事件**，不做策略判断
- Channel 自主决定**是否显示、如何聚合、何时发送**
- 安全模式（错误累积、触发、提示生成）**保留在 Gateway 层**
- 每个 Channel 持有独立的 `StreamFlusher` 实例，`flushDelay` 各自配置

---

## 阶段 3a：定义出站事件类型

**文件**：`src/types.ts`

| 事件类型 | 触发时机 | 载荷 |
|:---------|:---------|:-----|
| `output:text` | 每个 `text_delta` | `sessionId`, `channelId`, `chunk` |
| `output:activity` | 每个 `tool_use` | `sessionId`, `channelId`, `toolName`, `description` |
| `output:diagnostic` | 空闲超时/安全模式提示 | `sessionId`, `channelId`, `level`(notify/warn/kill/safe-mode), `message` |
| `output:file` | 文件标记匹配 | `sessionId`, `channelId`, `filePath` |
| `output:complete` | Agent 处理结束 | `sessionId`, `channelId`, `finalText`, `durationMs` |
| `output:error` | Agent 异常 | `sessionId`, `channelId`, `error`, `isTimeout` |

**改动量**：小（仅类型定义）

---

## 阶段 3b：Gateway 层发布事件

**文件**：`src/core/message-processor.ts`

### 改动内容

| 项目 | 当前实现 | 改造后 |
|:-----|:---------|:-------|
| 流式文本输出 | `flusher.addText()` → `adapter.sendText()` | `eventBus.publish({type:'output:text'})` |
| 工具活动输出 | `flusher.addActivity()` → `adapter.sendText()` | `eventBus.publish({type:'output:activity'})` |
| 诊断消息 | 直接 `adapter.sendText()` | `eventBus.publish({type:'output:diagnostic'})` |
| 文件发送 | `adapter.sendFile()` | `eventBus.publish({type:'output:file'})` |
| 完成通知 | `flusher.flush(final)` → `adapter.sendText()` | `eventBus.publish({type:'output:complete'})` |
| 错误处理 | `adapter.sendText()` | `eventBus.publish({type:'output:error'})` |

### 兼容过渡

```
阶段 3b:  同时走两条路径
          ├─ eventBus.publish(event)     ← 新路径
          └─ adapter.sendText(...)       ← 旧路径（保留）

阶段 4a:  Channel 订阅者就绪后
          ├─ eventBus.publish(event)     ← 新路径生效
          └─ adapter.sendText(...)       ← 删除

按渠道逐个迁移，而非一次性切换
```

### StreamFlusher 解耦

- MessageProcessor **不再创建和持有** StreamFlusher
- 移除 `currentFlusher` 字段
- StreamFlusher 生命周期改由 Channel 层管理

**改动量**：中

---

## 阶段 4a：Channel 订阅者框架

**文件**：`src/channels/*.ts`（新增订阅逻辑）

### Channel 订阅者内部结构

```
┌─ FeishuChannelSubscriber ──────────────────┐
│                                            │
│  eventQueue: AsyncQueue (串行处理)          │
│    ├─ enqueue(event)  ← 订阅回调           │
│    └─ process() ── 按序消费                │
│                                            │
│  handleEvent(event):                       │
│    ├─ output:text      → policy → flusher  │
│    ├─ output:activity  → policy → flusher  │
│    ├─ output:diagnostic→ policy → flusher  │
│    ├─ output:file      → sendFile()        │
│    ├─ output:complete  → flusher.flush()   │
│    └─ output:error     → 错误消息发送       │
│                                            │
│  flusher: StreamFlusher (flushDelay=4s)    │
│  policy: ChannelPolicy                     │
└────────────────────────────────────────────┘
```

### AsyncQueue 关键特性（参考 openclaw）

| 特性 | 说明 |
|:-----|:-----|
| 串行处理 | 同一 session 的事件按序处理，避免乱序 |
| 背压控制 | 队列满时阻塞发布者，防止内存溢出 |
| 错误隔离 | 单个事件处理失败不影响后续事件 |
| 优雅关闭 | 会话结束时等待队列清空再销毁 |

### StreamFlusher 生命周期（改由 Channel 管理）

```
output:text (首个) ──> Channel 创建 flusher
      │
      │  期间接收事件，缓冲聚合
      │  定时器触发 flush → sendMessage()
      ▼
output:complete  ──> flusher.flush(final=true) → 销毁
```

### flushDelay 配置

| 渠道 | 默认值 | 配置路径 | 回退 |
|:-----|:-------|:---------|:-----|
| Feishu | 4s | `channels.feishu.flushDelay` | `config.flushDelay` → 4 |
| WeChat | 2s | `channels.wechat.flushDelay` | `config.flushDelay` → 4 |
| Web UI (未来) | 0s | `channels.webui.flushDelay` | `config.flushDelay` → 4 |

配置读取：`channelConfig.flushDelay ?? globalConfig.flushDelay ?? 4`

**改动量**：中

---

## 阶段 4b：策略判断迁移

**文件**：`src/channels/*.ts`, `src/core/message-processor.ts`

### 迁移清单

| 策略 | 当前位置 | 目标位置 | 说明 |
|:-----|:---------|:---------|:-----|
| `showMiddleResult` | Gateway (processMessage) | Channel (onEvent) | 控制 `output:text` 和 `output:activity` 是否发送 |
| `showIdleMonitor` | Gateway (processMessage) | Channel (onEvent) | 控制 `output:diagnostic` 是否发送 |
| `isBackgroundSession` | Gateway (processMessage) | Channel (onEvent) | 后台会话完全静默（仅发完成通知） |
| 话题回复参数 | Gateway → Adapter 透传 | Channel 内部闭环 | Channel 从 session.metadata 读取 replyOpts |

**改动量**：中

---

## 阶段 5：移除 Gateway 层策略残留

**文件**：`src/core/message-processor.ts`

### 清理清单

| 项目 | 说明 |
|:-----|:-----|
| `shouldSuppress` 变量 | 移除（策略已在 Channel 层） |
| `shouldSuppressActivities` 字段 | 移除 |
| `showIdleMonitor` 变量 | 移除（策略已在 Channel 层） |
| `isBackgroundSession` 方法 | 移除（逻辑已在 Channel 层） |
| `currentFlusher` 字段 | 移除（StreamFlusher 已在 Channel 层） |
| `getThreadSendOpts` 方法 | 移除（话题回复已在 Channel 层闭环） |
| `ChannelAdapter.sendText` | 评估是否仍需保留（命令响应等场景可能仍需直接发送） |

**改动量**：低（验证性工作）

---

## 阶段 6：清理与文档

| 项目 | 说明 |
|:-----|:-----|
| 异步队列可靠性验证 | 背压控制、优雅关闭测试 |
| 废弃代码清理 | `ChannelOptions` 中不再需要的字段 |
| 配置结构更新 | `Config` 类型新增 `channels.*.flushDelay` |
| 文档更新 | `CLAUDE.md`、`docs/architecture.md` 更新事件订阅架构说明 |
| 全量测试 | 补充事件订阅相关的单元测试和集成测试 |

**改动量**：低

---

## 各层最终职责

| 职责 | Gateway (MessageProcessor) | Channel (Subscriber) |
|:-----|:---------------------------|:---------------------|
| 流式事件迭代 | ✓ | |
| 事件发布 | ✓ | |
| 安全模式管理 | ✓ | |
| 策略判断 | | ✓ |
| 消息聚合 (StreamFlusher) | | ✓ |
| 话题回复参数 | | ✓ |
| API 调用 (sendText/sendFile) | | ✓ |
| 异步队列保护 | | ✓ |
