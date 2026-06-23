# 任务边界事件落库（status.started / status.completed → activity）设计

**日期**：2026-06-13
**状态**：待实现

## 背景与问题

EvolClaw 出站有两条语义不同的通道：

| 通道 | RPC | 持久化 | 定位 |
|---|---|---|---|
| `status.*` | `event/app.task.status`（notify，ttl 60s，带 terminal 标记） | **不落 jsonl** | 在线实时挥发——客户端在线时秒级响应 |
| `activity`（ThoughtItem 载体） | proactive→`message/group.thought.put`；interactive→`message.send`/`group.send`（经 `sendReliableStructured`→`deliverPayloadEntry`→`sendAunPayload`） | **两种模式都落 jsonl** | 事后回放 / 可观测性 |

任务边界事件 `status.started` / `status.completed` 目前**只走 notify 通道**（`sendProcessingStatus` → notify），不落 `messages.jsonl`。因此回放（读 jsonl）时看不到「任务何时开始 / 何时结束」，回放任务边界缺失。

`status.completed` 的 metadata 还携带 token/cost/contextUsage/lastModelCall/session_total/queue 等统计细目，回放时也完全丢失。

## activity 的现状：两种模式都发网络、都落库（关键事实，已核验）

activity（ThoughtItem 载体）在两种模式下都会发到 AUN 网络，也都落 jsonl，只是 RPC 和 msgType 不同：

| 模式 | 网络 RPC | 落 jsonl | msgType | 落库点 |
|---|---|---|---|---|
| **proactive** | `message/group.thought.put` | ✅ | `'thought'` | `sendThought`（aun.ts:2767/2778） |
| **interactive** | `message.send` / `group.send`（payload `type:'activity'`） | ✅ | `'text'` | `recordDurableOutbound`（aun.ts:2365） |

proactive 的 thought 落库有**两个明确消费方**，是有意设计：

- `src/cli/watch-msg.ts:381` — 实时监控把 `msgType==='thought'` 渲染成 `thought` 方法（区别于 `send`）
- `src/utils/stats.ts:459` — 统计模块读 `msgType==='thought'` 算 thought 计数（`thoughtPutCount`）

且 `message-log.ts:14` 的 `msgType` 联合类型里 `'thought'` 是正式枚举成员。

**结论**：activity 两种模式都发网络、都落库，是既有稳定机制。lifecycle 跟随它即可，两模式都得到落库。

## 设计原则：零特异化

started/completed 就是普通 activity（ThoughtItem），**完全跟随 activity 在 interactive/proactive 下的既有机制**，不为它们开任何特殊路径。自然结果：

| 模式 | lifecycle 落库？ | 发给对端？ | 路径 |
|---|---|---|---|
| **proactive** | ✅ msgType='thought' | ✅ thought.put | 跟随 activity → sendThought |
| **interactive** | ✅ msgType='text' | ✅ message.send | 跟随 activity → deliverPayloadEntry |

这同时满足两种模式的回放完整性，且**零额外代码**——不改 `deliverPayloadEntry`、不写拦截放行逻辑。

**已确认的语义取舍**：interactive 下 lifecycle 会作为一条 `message.send`（payload `type:'activity'`）**真发给对端**，与现有 tool_call/tool_result activity 行为一致。用户已接受此语义。notify 通道两种模式均照旧不动，新增 activity 与 notify 双发同源。

## 设计

### 1. 新增 ThoughtItem kind

`src/types.ts`（ThoughtItem 联合类型，当前 859-866 行）新增两个 kind：

```typescript
| { kind: 'started'; text?: string; metadata?: Record<string, unknown> }
| { kind: 'completed'; text?: string; metadata?: Record<string, unknown> }
```

理由：

- **不复用 notice/summary**：语义独立，回放/监控一眼区分「任务边界」vs「思考内容」。
- **metadata 用 `Record<string, unknown>`**：`completed` 沿用 `status.completed` 已有的重型 metadata 结构（token/cost/contextUsage 等），不重新定义字段，避免两处类型漂移。`started` 一般为空或轻量。
- **text 可选**：回放/前端的人类可读摘要，缺省时可从 metadata 渲染。

### 2. started 的时序迁移

当前 `status.started` 在 `message-processor.ts:623` 发送，**早于 IMRenderer 创建**（renderer 在 639 行 `new`，675 行赋值 `this.currentRenderer`）。

新方案让 started 也走 renderer 投影，因此把 **started 的 activity 投影挪到 renderer 创建之后**（675 行之后）。notify 的 `status.started` 照常发（其语义不变），activity 额外补一条；两条通道解耦。

`completed` 无时序问题：1409 行发送时 renderer 仍存活，原地补一条 activity。

### 3. IMRenderer 新增入口

`src/core/message/im-renderer.ts` 新增方法：

```typescript
addLifecycle(phase: 'started' | 'completed', metadata?: Record<string, unknown>, text?: string): void
```

行为——**完全复用现有 activity 投影路径**：

- 构造 `{ kind: phase, text, metadata }` 的 ThoughtItem。
- **proactive**：走 `emitProactiveItem`（单 item activity.batch，fire-and-forget）。`emitProactive` 的拦截只针对 `progress` kind（im-renderer.ts:515），lifecycle 经 `emitProactiveItem` 投影天然不被拦截——**无需任何放行特殊代码**。
- **interactive**：push 进 `itemsQueue`，flush 时打包成 activity.batch（与 tool_call/tool_result 同路）。

调用点：`message-processor.ts` 在发 `status.started` / `status.completed` 的同处，额外调 `renderer.addLifecycle(...)`，completed 把现有那坨 metadata 透传进去。

### 4. aun.ts 落库与防回转

**防回转**（`aun.ts:3428` activity.batch 分支）：当前只有 `progress` kind 被反转回 `sendProcessingStatus`。新 kind **不进 progress 分支**，自然落到 `buildActivityPayload → sendThought（proactive）/ sendReliableStructured（interactive）`。无需额外代码，只要不误加分支。

**activityLogText**（`aun.ts:2395`）补两个分支，产出 jsonl 的 logText 文案（**纯文本，无 emoji**）：

```typescript
if (item?.kind === 'started') return '任务开始';
if (item?.kind === 'completed') {
  const ms = (item.metadata as any)?.durationMs;
  return ms ? `任务完成 (${ms}ms)` : '任务完成';
}
```

**不改 `deliverPayloadEntry`**：interactive 的 lifecycle 跟随现有 activity 路径——`deliverPayloadEntry → sendAunPayload`（message.send）发网络，`recordDurableOutbound` 已自带落库（msgType='text'，aun.ts:2365）。proactive 的 `sendThought` 已自带落库（msgType='thought'）。两边都无需改动落库逻辑。

## 数据流

```
proactive:
  message-processor: addLifecycle(started/completed)
    → ThoughtItem{kind} → emitProactiveItem → activity.batch[1]
    → renderer.send() → aun activity.batch 分支
    → buildActivityPayload → sendThought → thought.put + appendOutboundJsonl('thought') ✅
    （watch/stats 可消费）

interactive:
  message-processor: addLifecycle(started/completed)
    → itemsQueue → flush → activity.batch
    → aun activity.batch 分支 → buildActivityPayload
    → sendReliableStructured → deliverPayloadEntry → sendAunPayload（message.send，payload type='activity'）
    → recordDurableOutbound → appendOutboundJsonl('text') ✅（同时发给对端）

notify（两种模式均不变）:
  message-processor: status.started / status.completed
    → sendProcessingStatus → event/app.task.status notify
```

## 错误处理

- 新增 activity 是**附加副作用**，失败必须**静默吞**，绝不影响 notify 主通道或任务流。
  - proactive `sendThought` 失败已 debug 吞（aun.ts:2756），`appendOutboundJsonl` 已 try/catch（aun.ts:2681）。
- started 时序迁移后，notify 的 started 仍独立发出——两条通道解耦，互不阻塞。

## 测试

- **IMRenderer.addLifecycle 单测**：
  - proactive 下生成 `activity.batch`（items 长度 1），kind 为 started/completed，且不被 progress 拦截吞掉。
  - interactive 下进 itemsQueue，flush 时打包进 activity.batch。
  - completed 的 metadata 透传到 item。
- **activityLogText**：started/completed 返回纯文本（无 emoji），completed 带 durationMs 时拼时长。
- **防回转**：lifecycle kind 不被 aun.ts activity.batch 的 progress 分支拦截。
- **落库验证**：proactive lifecycle 落 jsonl（msgType='thought'）；interactive lifecycle 落 jsonl（msgType='text'）且经 message.send 发给对端。
- **回归**：notify 的 `status.started` / `status.completed` 仍正常发出（时序迁移不破坏 notify）。

## 影响文件

- `src/types.ts` — ThoughtItem 新增 started/completed kind
- `src/core/message/im-renderer.ts` — 新增 addLifecycle 方法
- `src/core/message/message-processor.ts` — started 时序迁移 + 两处调用 addLifecycle
- `src/channels/aun.ts` — activityLogText 补两个分支
- 对应单元测试

（不改 `deliverPayloadEntry`——零特异化。）

## 非目标（YAGNI）

- 不改 notify 通道的实时语义。
- 不改 activity 的现有发送/落库机制——lifecycle 完全跟随，零特异化。
- 不让 interactive 的中间过程额外做什么——tool_call/tool_result 怎么走，lifecycle 就怎么走。
- 不改前端渲染逻辑（前端如何展示新 kind 由前端独立决定；本设计只保证两种模式的 jsonl 都有数据、且对端都收到）。
