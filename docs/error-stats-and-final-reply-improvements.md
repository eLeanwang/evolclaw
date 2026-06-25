# 错误统计与最终回复改进

> 2026-04-10 工作记录

## 背景

EvolClaw 的消息处理流程中，Agent 任务执行的返回事件分类、错误统计和最终回复文本存在多处结构性问题。本轮改动系统性地修复了这些问题。

## 改动清单

### 1. `complete.isError` 传播到统计/健康/状态

**问题**：Agent SDK 流正常结束但 `complete.isError=true` 时（权限拒绝、max turns、工具链失败等），Gateway 仍走成功路径 —— `recordSuccess()`、`message:completed`、`sendProcessingStatus('done')`。

**修复**：
- `processEventStream` 返回值从 `Promise<void>` 改为结构化对象，携带 `isError`、`subtype`、`errors`
- `_processMessageInternal` 根据返回值分流：
  - `isError=false` → `recordSuccess()` + `message:completed` + status `'done'`
  - `isError=true` → `recordError()` + `message:error` + status `'error'`

**文件**：`src/core/message-processor.ts`

---

### 2. 错误类型命名空间分离

**问题**：`StatsCollector.errorsByType` 中，基础设施异常（`sdk_timeout`、`api_error`）和 Agent 任务失败（`max_turns`、`error_model`）混在同一字典，`/check` 输出无法区分来源。

**修复**：所有 errorType 添加来源前缀：

| 来源 | 前缀 | 示例 |
|------|------|------|
| 基础设施异常（catch 路径） | `infra:` | `infra:sdk_timeout`, `infra:api_error` |
| Agent 任务失败（complete.isError） | `agent:` | `agent:max_turns`, `agent:error_model` |

**文件**：`src/utils/error-utils.ts`（新增 `ERROR_PREFIX`、`prefixErrorType()`），`src/core/message-processor.ts`（三处 publish 点统一使用）

---

### 3. 非系统级错误不累计安全模式

**问题**：修复 #1 后，所有 `complete.isError` 都会调用 `recordError()` + `checkSafeMode()`。但用户拒绝权限、达到 max turns 等非系统级场景不应累计 `consecutiveErrors`，否则用户连续拒绝 3 次权限就会触发安全模式（丢失上下文记忆）。

**修复**：新增 `isInfraError(subtype)` 判断函数，定义非基础设施 subtype 白名单：

```typescript
const NON_INFRA_SUBTYPES = new Set([
  'end_turn',           // Agent 正常结束
  'max_turns',          // 达到轮次上限
  'permission_denied',  // 用户主动拒绝权限
  'stop',               // 用��主动停止
]);
```

仅 `isInfraError()=true` 时调用 `recordError()` + `checkSafeMode()`，其余仅发 `message:error` 事件（统计记录但不累计安全模式）。

**文件**：`src/utils/error-utils.ts`（新增 `isInfraError()`），`src/core/message-processor.ts`

---

### 4. `message:error` 事件 sessionId 不一致

**问题**：`_processMessageInternal` 的 catch 路径中，`message:error` 和 `logger.message` 使用 `message.channelId` 而非 `session.id`，导致 `StatsCollector` 按 sessionId 聚合时对不上。

**修复**：两处改为 `session.id`。

**文件**：`src/core/message-processor.ts`

---

### 5. 后台任务纳入统计

**问题**：后台任务的 complete 事件只写入 `messageCache`，不发 `message:completed` / `message:error` 到 EventBus，`StatsCollector` 对后台任务完全无感知。

**修复**：后台任务 complete 后，在写 `messageCache` 的同时也 publish `message:completed` / `message:error` 到 EventBus。

**文件**：`src/core/message-processor.ts`

---

### 6. 工具级失败纳入统计

**问题**：`tool_result.isError=true` 事件只在渠道上显示错误信息，`StatsCollector` 完全不跟踪。一个任务里多个工具失败但最终成功，整个过程被记为"成功"，工具失败率不可见。

**修复**：
- `StatsCollector` 新增订阅 `tool:result` 事件（`isError=true` 时记录）
- `StatsSnapshot` 新增 `toolErrors` 和 `toolErrorsByName` 字段
- `/check` 命令输出新增 `工具失败: 5 (Bash: 3, Read: 2)` 行

**文件**：`src/core/stats-collector.ts`，`src/core/command-handler.ts`

---

### 7. 最终回复文本提取（lastReplyText）

**问题**：SDK 的 `complete.result` 和流式 `text` 事件都是所有 assistant 轮次的文本聚合，包含中间思考内容（"让我看一下文件…"）。`message:completed` 事件类型定义中有 `finalText` 字段但从未填充。事件订阅者无法获取去除中间内容的纯最终回复。

**修复**：在 `processEventStream` 中追踪最后一轮 assistant 回复：

```
text 事件  → lastReplyText += event.text
tool_use   → lastReplyText = ''  （有工具调用 = 中间轮）
complete   → completeResult.lastReplyText = lastReplyText
```

- 前台和后台路径都追踪 `lastReplyText`
- `message:completed.finalText` 填入 `lastReplyText`
- `processEventStream` 返回值同时携带 `lastReplyText`（最后一轮）和 `fullText`（SDK 全文）

**文件**：`src/core/message-processor.ts`

---

### 8. shouldSuppress 和后台缓存使用 lastReplyText

**问题**：
- `shouldSuppress()=true` 时，complete 事件把 `event.result`（全文）推给用户，包含中间思考内容，与 suppress 语义矛盾
- 后台任务缓存用 `event.result`（全文），用户切回后看到所有中间内容

**修复**：
- suppress 模式下 complete 事件推 `lastReplyText || event.result`（最后一轮，回退到全文）
- 后台缓存用 `lastReplyText || event.result`

**文件**：`src/core/message-processor.ts`

---

### 9. SEND_FILE 标记扫描兼容 suppress 模式

**问题**：修复 #8 后，`shouldSuppress()=true` 时 flusher 只包含 `lastReplyText`，但 `[SEND_FILE:]` 标记可能出现在中间轮。文件标记扫描用 `flusher.getFinalText()` 会漏掉中间轮的标记。

**修复**：`processEventStream` 返回值新增 `fullText`（= `event.result`，SDK 全文）。文件标记扫描取 `flusherText` 和 `streamResult.fullText` 中更完整的那个。

**文件**：`src/core/message-processor.ts`

---

### 10. 多 complete 事件导致重复"最终回复"

**问题**：`processEventStream` 内部在每个 `complete` 事件时调用 `flusher.flush(true)`，发送带 "✓ 最终回复:" 标题的消息。但 SDK 在 subagent 完成、auto-compact 触发二次查询等场景下，一轮对话会产生多个 `result`（即 `complete`）事件，导致用户看到多个"最终回复"。

**日志证据**：
```
03:39:10  type=text
03:39:10  type=complete    ← 第一个 complete
03:39:29  type=text         ← complete 后又有新文本
03:39:30  type=complete    ← 第二个 complete
```

**根因**：原设计假设"一轮对话只有一个 `complete` 事件"，每个 `complete` 代表整个对话轮次结束。实际上每个 `result` 代表 SDK 内部一次 turn 的结束，`for await` 循环彻底退出才是真正结束。

**修复**：
- `processEventStream` 中 `complete` 事件不再调用 `flusher.flush(true)`，改为仅记录 `completeResult`（后续覆盖前序）+ `flushActivitiesOnly()`（及时显示错误提示等 activities）
- 最终文本添加和唯一的 `flush(true)` 移到外层 `_processMessageInternal`，在整个事件流结束后统一执行
- `processEventStream` 返回值新增 `hasReceivedText`，供外层判断是否需要添加最终文本（避免与流式 text_delta 重复）

**文件**：`src/core/message-processor.ts`，`tests/integration/event-stream-output.test.ts`

---

## 涉及文件总览

| 文件 | 改动类型 |
|------|---------|
| `src/core/message-processor.ts` | 主要改动：错误分流、lastReplyText 追踪、后台统计、SEND_FILE 修复 |
| `src/utils/error-utils.ts` | 新增：`ERROR_PREFIX`、`isInfraError()`、`prefixErrorType()` |
| `src/core/stats-collector.ts` | 新增：`tool:result` 订阅、`toolErrors`/`toolErrorsByName` |
| `src/core/command-handler.ts` | `/check` 输出新增工具失败统计行 |

## processEventStream 返回值结构

```typescript
{
  isError: boolean;        // complete.isError
  subtype?: string;        // SDK result subtype
  errors?: string[];       // 错误信息列表
  terminalReason?: string; // SDK terminal_reason（用于友好错误提示和 isInfraError 判断）
  lastReplyText: string;   // 最后一轮 assistant 回复（去除中间轮）
  fullText: string;        // SDK event.result（全文聚合）
  hasReceivedText: boolean; // 是否收到过流式 text_delta
}
```

## 事件流与统计全景（改动后）

```
用户消息 → message:received
  │
  ├─ 前台任务
  │   ├─ 执行中事件流（processEventStream）
  │   │   ├─ text          → flusher + message:text + lastReplyText 追踪
  │   │   ├─ tool_use      → flusher + tool:use + lastReplyText 重置
  │   │   ├─ tool_result   → tool:result（isError → StatsCollector.toolErrors）
  │   │   ├─ compact       → flusher 活动
  │   │   ├─ task_progress  → flusher 活动
  │   │   ├─ error         → flusher 活动
  │   │   └─ complete      → 记录 completeResult（后续覆盖前序）+ flushActivitiesOnly
  │   │                      ⚠️ SDK 可能产生多个 complete（subagent / auto-compact）
  │   │
  │   └─ 流结束后（_processMessageInternal）
  │       ├─ 添加最终文本到 flusher（suppress 或无流式文本时）
  │       ├─ flusher.flush(true) ← 唯一的"✓ 最终回复"发送点
  │       ├─ isError = false
  │       │   → recordSuccess + message:completed(finalText) + status:'done'
  │       └─ isError = true
  │           → message:error(agent:*) + status:'error'
  │           → isInfraError? → recordError + checkSafeMode
  │
  ├─ 后台任务
  │   ├─ text/tool_use → lastReplyText 追踪（不发送）
  │   └─ complete
  │       ├─ success → messageCache(lastReplyText) + message:completed(finalText)
  │       └─ error   → messageCache(error) + message:error(agent:*)
  │
  └─ 异常（catch 路径）
      → message:error(infra:*) + recordError + checkSafeMode
```
