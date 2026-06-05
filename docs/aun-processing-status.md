# AUN Processing 状态通知方案

**状态**: Implemented  
**实现日期**: 2026-05  
**最后更新**: 2026-05-24

## 背景

AUN 测试客户端发送消息后，在 EvolClaw 处理期间没有任何反馈，直到最终回复到达（可能需要几秒到几分钟）。需要一种机制让客户端感知服务端的处理状态。

## 维度选型

| 维度 | 粒度 | 结论 |
|------|------|------|
| AID | 最粗 | 多用户共用 AID 时会误报，排除 |
| channelId | 中等 | 无法区分同一对话下的多个 session |
| projectPath | 中等 | 服务端内部概念，客户端不感知，排除 |
| **session** | **较细** | **采用** — 精确对应 Agent 调用单元，支持多会话并行 |
| 队列任务 | 最细 | 串行队列同时只处理一条，过细无收益，排除 |

## 状态定义

| status | 触发场景 | 客户端展示 |
|--------|---------|-----------|
| `start` | 开始处理消息 | ⏳ 处理中… |
| `progress` | 每次 activity（文本/工具调用/工具结果） | 进度指示器更新 |
| `done` | 正常完成 | ✅ 处理完成 |
| `interrupted` | 用户发新消息中断了当前处理 | ⚡ 已中断 |
| `error` | 处理失败（含 SDK 超时、API 错误等） | ❌ 处理失败 |

## status.progress 事件

`progress` 是处理过程中的细粒度进度通知，每次 Agent 产生一个 activity 时触发。

### 消息格式

```json
{
  "type": "processing",
  "status": "progress",
  "sessionId": "task-xxx",
  "timestamp": 1234567890,
  "metadata": {
    "activityType": "text",
    "turn": 3,
    "outputTokens": 156
  }
}
```

### metadata 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `activityType` | `"text" \| "tool_call" \| "tool_result"` | 当前 activity 类型 |
| `turn` | `number?` | 当前轮数（从 1 开始递增，仅 text/tool_call 携带） |
| `outputTokens` | `number?` | 本次文本输出的字符数（仅 activityType=text 时携带） |

### activityType 说明

| 值 | 含义 | 触发时机 |
|----|------|---------|
| `text` | 模型输出文本 | Agent 产生文本回复 |
| `tool_call` | 工具调用 | Agent 发起工具调用（Read/Edit/Bash 等） |
| `tool_result` | 工具结果 | 工具执行完毕返回结果 |

### turn 计数规则

- 每次 Agent 模型调用（assistant event）递增 1
- 与最终 `result` 事件的 `num_turns` 一致
- `tool_result` 不携带 turn（它属于上一轮的工具调用结果）

### outputTokens 说明

- 统计方式：`text.length`（文本字符数）
- 仅 `activityType: "text"` 时携带
- 用途：客户端可用于显示输出进度、估算处理量
- 注意：字符数 ≠ token 数（中文约 1:1~1:2，英文约 4:1）

### 客户端集成建议

```typescript
// 处理 progress 事件
function onProgress(metadata: { activityType: string; turn?: number; outputTokens?: number }) {
  switch (metadata.activityType) {
    case 'text':
      // 更新进度：显示"第 N 轮，已输出 X 字符"
      updateProgress(`Turn ${metadata.turn}, ${metadata.outputTokens} chars`);
      break;
    case 'tool_call':
      // 显示工具调用指示器
      showToolIndicator(metadata.turn);
      break;
    case 'tool_result':
      // 工具完成，可隐藏指示器
      hideToolIndicator();
      break;
  }
}
```

### 事件时序示例

```
start                                          ← 开始处理
progress  {activityType:"text", turn:1, outputTokens:45}   ← 第1轮文本
progress  {activityType:"tool_call", turn:2}               ← 第2轮工具调用
progress  {activityType:"tool_result"}                     ← 工具结果返回
progress  {activityType:"text", turn:3, outputTokens:128}  ← 第3轮文本
done                                           ← 处理完成
```

## 消息格式

通过 AUN `message.send`（`persist: false`, `encrypt: true`）发送结构化 JSON payload：

```json
{"type": "processing", "status": "start|progress|done|interrupted|error", "sessionId": "xxx", "timestamp": 1234567890, "metadata": {...}}
```

- `persist: false` — 不持久化，仅实时通知
- `sessionId` — EvolClaw 内部 session ID，客户端用于计数，无需展示具体值
- `metadata` — 仅 `progress` 状态携带（见上方 status.progress 事件章节）

## 处理流程

```
用户发消息
  │
  ▼
测试客户端 ──message.send──▶ AUN 网关 ──▶ aun_bridge.py (sidecar)
                                              │ stdout JSON event
                                              ▼
                                          aun.ts handleInboundMessage
                                              │
                                              ▼
                                          MessageQueue.enqueue
                                              │
                                              ▼
                                      MessageProcessor.processMessage
                                              │
                              ┌───────────────┤
                              ▼               │
                  sendProcessingStatus('start')
                      → aun.ts → bridge → 网关 → 客户端
                              │               │
                              ▼               │
                                    Agent 处理（工具调用、流式输出…）
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                          正常完成        用户中断          异常/超时
                              │               │               │
                  status='done'    status='interrupted'  status='error'
                      → aun.ts → bridge → 网关 → 客户端
```

## 状态判定逻辑（服务端 message-processor.ts）

- **start**: `eventBus.publish('message:processing')` 后立即发送
- **done**: `clearProcessing()` + `recordSuccess()` 后发送
- **interrupted**: catch 块中 `classifyError()` 返回 `STREAM_ERROR`（含 'aborted'/'interrupted'）
- **error**: catch 块中其他错误类型（`API_ERROR`、`SDK_TIMEOUT`、`UNKNOWN` 等）

## 多 session 并行场景

客户端维护 `_processing: set[str]`，支持多个 session 同时处理：

```
⏳ evolclaw-ai 处理中…          ← session A start
⏳ evolclaw-ai 处理中…          ← session B start
状态栏: ⏳ 2个会话处理中

⚡ evolclaw-ai 已中断            ← session B interrupted (用户发新消息)
状态栏: ⏳ 1个会话处理中

✅ evolclaw-ai 处理完成          ← session A done
状态栏: (清除)
```

## 涉及文件

### 服务端

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `ChannelAdapter` 接口新增 `sendProcessingStatus?` 可选方法 |
| `src/channels/aun_bridge.py` | 新增 `processing` JSON-RPC 处理器，通过 `message.send` 发送状态 |
| `src/channels/aun.ts` | `AUNChannel` 新增 `sendProcessingStatus` 方法，adapter 暴露 |
| `src/core/message-processor.ts` | 处理开始、完成、中断、异常四处调用 `adapter.sendProcessingStatus` |

### 客户端

| 文件 | 改动 |
|------|------|
| `aun_test_client.py` | `_on_message` 识别 processing payload；`_processing` set 计数；四种状态展示 |

## 可靠性保证

- `start` 必有对应的终态（`done` / `interrupted` / `error`）
- 异常路径（catch 块）根据错误类型发送 `interrupted` 或 `error`，避免永远卡在"处理中"
- `persist: false` 确保状态消息不污染消息历史
- 客户端用 `set.discard()`（而非 `remove()`），即使收到多余的终态也不会报错
