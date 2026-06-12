# Proactive Mode 设计方案 v2

**状态**: Implemented  
**实现日期**: 2026-05  
**最后更新**: 2026-05-24

## 1. 概述

### 1.1 背景

EvolClaw 当前使用 **interactive 模式**：MessageProcessor 自动发送 agent 的流式输出和最终回复。这种模式适合单聊场景，但在群聊中，agent 需要更精细的控制：
- 选择性回复（不是每条消息都回复）
- 多次发送（分多条消息回复）
- 精确控制消息格式和时机

### 1.2 目标

新增 **proactive 模式**，agent 通过 `evolclaw ctl send` 主动控制消息发送，MessageProcessor 完全静默。

### 1.3 适用范围

- **仅 AUN 通道**支持 proactive 模式切换
- Feishu/WeChat 保持 interactive 模式，不受影响

---

## 2. 核心设计

### 2.1 SessionMode 定义

复用现有 `Session.sessionMode` 字段，新增一个值：

```typescript
type SessionMode = 
  | 'interactive'  // 现有模式，MessageProcessor 自动发送
  | 'proactive'    // 新模式，agent 主动发送，MessageProcessor 静默
  | 'autonomous';  // 预留：agent 自执行会话模式
```

### 2.2 通道配置

`evolclaw.json` 中可按 channelName（实例级）配置固定 sessionMode：

```json
{
  "channels": {
    "aun": {
      "sessionMode": "proactive"
    },
    "aun-work": {
      "sessionMode": "interactive"
    }
  }
}
```

**配置锁定行为**：
- 配置存在时，该实例所有 session 强制使用配置的 sessionMode
- `/chatmode <模式>` → 只读，提示"当前模式：proactive（由通道配置锁定）"
- `/new <模式>` → 模式参数被忽略，提示"会话模式由通道配置锁定"
- `/activity <参数>` → 不可用，提示"proactive 模式下不支持 activity 配置"

### 2.3 默认值规则（无通道配置时）

新建 session 时根据通道和聊天类型自动选择：
- AUN 群聊 (`chatType === 'group'`) → `'proactive'`
- AUN 单聊 (`chatType === 'private'`) → `'interactive'`
- 其他通道 → `'interactive'`

可通过以下方式覆盖：
- `/new proactive` 或 `/new interactive` 手动指定
- `/chatmode proactive` 或 `/chatmode interactive` 切换

### 2.4 优先级链

```
channels.xxxx.sessionMode（通道配置，最高，锁定一切）
  → /new <模式>（手动指定，仅无通道配置时生效）
  → chatType 默认值（AUN 群聊 proactive / 其余 interactive）
```

> **chatType 来源**：AUN 协议数据本身不携带 chatType 字段。AUN 通道通过 channelId 格式推断（`grp_` 前缀或 `g-xxx.agentid.pub` 为群聊，其余为私聊），并存入 `sessions.chat_type`。此机制已存在，本方案直接复用。

### 2.5 模式切换

**命令**：`/chatmode [interactive|proactive]`

**行为**：
- 无参数：显示当前模式
- 有参数 + 无通道配置：切换并持久化到 session
- 有参数 + 有通道配置：拒绝，提示锁定

### 2.6 `/activity` 限制

proactive 模式下 `/activity` 参数不可用：
- 流式输出完全静默，activity 配置无意义
- 执行时提示"proactive 模式下不支持 activity 配置"

---

## 3. 命令重构

### 3.1 命令变更

| 旧命令 | 新命令 | 功能 |
|--------|--------|------|
| 无 | `/send <消息>` | 发送文本消息（新增） |
| 无 | `/chatmode <模式>` | 切换 sessionMode（新增） |

> 注：`/send <路径>` → `/file <路径>` 的重命名已在之前完成，本方案不再涉及。

### 3.2 `/send` — 发送文本消息

**用法**：`evolclaw ctl send <消息内容>`

**实现**：在 `handleCtl` 中直接处理（不走 `handle()`），从 session 恢复 ReplyContext 后调用 `adapter.sendText()`。

```typescript
if (cmd.startsWith('/send ')) {
  const text = cmd.slice(6).trim();
  if (!text) return { ok: false, error: '消息内容不能为空' };
  
  const adapter = this.adapters.get(session.channel);
  if (!adapter) return { ok: false, error: `adapter 未找到: ${session.channel}` };
  
  // 从 session.metadata 恢复 ReplyContext
  const replyContext = this.buildCtlReplyContext(session);
  
  await adapter.sendText(session.channelId, text, replyContext);
  return { ok: true, result: '已发送' };
}
```

### 3.3 `/chatmode` — 切换会话模式

**用法**：
- `evolclaw ctl chatmode` — 显示当前模式
- `evolclaw ctl chatmode <interactive|proactive>` — 切换模式

**行为**：
- 无参数：返回 `当前模式：<模式>`（如有通道配置，追加"由通道配置锁定"）
- 有参数 + 无通道配置：更新 `session.sessionMode` 并持久化
- 有参数 + 有通道配置：拒绝并提示锁定
- 无效模式值：拒绝并提示支持的选项

### 3.4 CTL_COMMANDS 白名单更新

```typescript
private static readonly CTL_COMMANDS = [
  '/help', '/status', '/check',
  '/model', '/effort', '/perm',
  '/compact', '/activity', '/file', '/send', '/chatmode', '/restart', '/agentmd',
];
```

---

## 4. ReplyContext 恢复

### 4.1 问题

`ctl send` 通过 IPC 调用，没有原始 `Message` 对象，无法获取 `getReplyContext(message)`。

AUN 的 `sendMessage` 依赖 ReplyContext 中的：
- **`threadId`** — 话题线程路由（payload 中的 `thread_id`）
- **`peerId`** — 群聊自动补 `@peerId`
- **`title`** — 多轮后加"最终回复"前缀（proactive 模式不需要）

### 4.2 解决方案

从 `session.metadata` 恢复 ReplyContext：

```typescript
private buildCtlReplyContext(session: Session): ReplyContext | undefined {
  const ctx: ReplyContext = {};
  
  // 话题会话：session.metadata.replyContext 在创建时写入
  if (session.metadata?.replyContext?.threadId) {
    ctx.threadId = session.metadata.replyContext.threadId;
  }
  // 群聊 peerId：session.metadata.replyContext.peerId
  if (session.metadata?.replyContext?.peerId) {
    ctx.peerId = session.metadata.replyContext.peerId;
  }
  // 单聊 peerId：session.metadata.peerId
  if (!ctx.peerId && session.metadata?.peerId) {
    ctx.peerId = session.metadata.peerId;
  }
  
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}
```

### 4.3 遗漏检查

| ReplyContext 字段 | 来源 | ctl send 中是否可恢复 |
|---|---|---|
| `threadId` | `session.metadata.replyContext.threadId` | ✅ 可恢复 |
| `peerId` | `session.metadata.replyContext.peerId` 或 `session.metadata.peerId` | ✅ 可恢复 |
| `title` | MessageProcessor 运行时生成 | ❌ 不需要（proactive 无"最终回复"概念） |
| `replyToMessageId` | Feishu 特有 | ❌ 不涉及（仅 AUN 通道） |
| `sessionId` | `session.id` | ✅ 可恢复 |

---

## 5. 消息处理流程

### 5.1 Interactive 模式（现有，不变）

```
用户消息
  → MessageQueue.enqueue
  → MessageProcessor._processMessageInternal
  → 构建 contextParts（环境信息、通道能力、ctl 提示）
  → effectiveSystemPrompt = [systemPromptAppend, ...contextParts]
  → 创建 StreamFlusher
  → agent.runQuery(systemPromptAppend)
  → processEventStream → flusher 累积并定时发送
  → 处理文件标记 [SEND_FILE:]
  → flusher.flush(true) → adapter.sendText() 最终回复
  → sendProcessingStatus('done')
```

### 5.2 Proactive 模式（新）

```
用户消息
  → MessageQueue.enqueue
  → MessageProcessor._processMessageInternal
  → sendProcessingStatus('start')    ← 与 interactive 一致
  → 构建 contextParts（环境信息 + proactive 模式提示词）
  → effectiveSystemPrompt = [systemPromptAppend, ...contextParts, PROACTIVE_PROMPT]
  → 创建 StreamFlusher(silent: true)（累积但不发送）   ← 关键差异点
  → agent.runQuery(systemPromptAppend)
  → processEventStream → flusher 累积但静默（session_id 提取等元逻辑正常运行）
  │
  │  Agent 在运行中通过 Bash 工具调用:
  │  └─ evolclaw ctl send "消息内容"
  │     → IPC → handleCtl('/send ...')
  │     → buildCtlReplyContext(session) 恢复上下文
  │     → adapter.sendText(channelId, text, replyContext)
  │  （可多次调用）
  │
  → 跳过文件标记处理
  → 跳过 flusher.flush(true)（silent 模式下 flush 本身也是空操作）
  → agent.cleanupStream(streamKey)
  → sendProcessingStatus('done' | 'error' | 'timeout')    ← 与 interactive 一致
```

### 5.3 处理状态通知（start / done / error / timeout）

**proactive 模式不对 `sendProcessingStatus(...)` 做任何特殊处理**，与 interactive 模式行为完全一致：

| 状态 | Interactive | Proactive |
|------|-------------|-----------|
| `start` | 发送 | 发送 |
| `done` | 发送 | 发送 |
| `error` | 发送 | 发送 |
| `timeout` | 发送 | 发送 |

**理由**：
- 这些是系统级状态通知（AUN 通道自行决定渲染方式），不属于 agent 的"回复内容"
- error/timeout 是兜底通知，proactive 模式下 agent 若崩溃或超时而没调用 `ctl send`，用户仍需要感知
- start/done 在 AUN 通道可能表现为客户端的处理中/完成指示，保持一致行为避免引入分支

### 5.4 关键差异

| 维度 | Interactive | Proactive |
|------|-------------|-----------|
| **谁控制发送** | MessageProcessor 自动 | Agent 主动调用 `ctl send` |
| **StreamFlusher** | 正常创建，累积并发送 | `silent: true`，累积但不发送 |
| **流式输出** | 发送 | 静默 |
| **最终 flush** | 自动发送 | 跳过（silent 模式下为空操作） |
| **发送次数** | 1 次 | 多次（agent 决定） |
| **文件标记** | 处理 `[SEND_FILE:]` | 跳过（用 `ctl file` 代替） |
| **事件流处理** | 正常 | 正常（session_id、error 等仍需处理） |
| **系统提示词** | 正常 | 追加 proactive 模式说明 |
| **处理状态通知** | start/done/error/timeout | 与 interactive 完全一致 |

---

## 6. 系统提示词注入

### 6.1 注入位置

在 `MessageProcessor._processMessageInternal` 的 `contextParts` 构建阶段，根据 `session.sessionMode` 动态追加。

**理由**：
- `contextParts` 本身就是动态内容（环境信息、通道能力等），是注入的正确位置
- 不需要修改 `ChannelOptions.systemPromptAppend` 的类型
- 不需要修改 `src/index.ts` 的 channel 注册逻辑

### 6.2 实现

```typescript
// src/core/message/message-processor.ts - contextParts 构建阶段

// 6. Proactive 模式提示词
if (session.sessionMode === 'proactive') {
  contextParts.push(PROACTIVE_MODE_PROMPT);
}
```

### 6.3 提示词内容

```typescript
const PROACTIVE_MODE_PROMPT = `[Proactive 模式] 你的输出不会自动发送给用户。必须通过以下命令主动发送：
- 发送文本：evolclaw ctl send "<消息内容>"
- 发送文件：evolclaw ctl file <路径>
可多次调用。如不调用，用户将看不到任何回复。`;
```

---

## 7. StreamFlusher silent 模式

### 7.1 设计思路

proactive 模式下不需要 StreamFlusher 的发送功能，但 `processEventStream` 中有大量 `flusher.addActivity()` / `flusher.addText()` 调用。

**两种方案**：

**A. StreamFlusher 增加 silent 模式**（采用）：
- 构造时传入 `silent: true`
- `addActivity()` / `addText()` 正常累积（用于日志/诊断）
- `flush()` 为空操作（不调用 adapter.sendText）
- 改动最小，复用现有代码

**B. 创建 NullFlusher 类**（不采用）：
- 实现相同接口，所有方法为空操作
- 需要抽取 Flusher 接口
- 更干净但改动更大

### 7.2 实现

```typescript
// src/core/message/stream-flusher.ts
class StreamFlusher {
  constructor(
    private sendFn: (text: string, opts?: any) => Promise<void>,
    private options: { flushDelay?: number; silent?: boolean } = {}
  ) {}
  
  async flush(isFinal?: boolean): Promise<void> {
    if (this.options.silent) return;  // 静默模式：不发送
    // ... 现有逻辑
  }
}
```

```typescript
// message-processor.ts 中创建 flusher 时
const flusher = new StreamFlusher(sendFn, {
  flushDelay,
  silent: session.sessionMode === 'proactive'
});
```

---

## 8. 实现步骤

### 8.1 配置读取

**文件**：`src/types.ts`、`src/config.ts`

- `ChannelOptions` 新增 `sessionMode?: string` 字段
- channel 初始化时从 `config.channels[channelName].sessionMode` 读取
- 传递给 MessageProcessor 的 `ChannelOptions`

### 8.2 StreamFlusher silent 模式

**文件**：`src/core/message/stream-flusher.ts`
- 构造函数新增 `silent?: boolean` 选项
- `flush()` 方法开头检查 `if (this.options.silent) return`

### 8.3 命令重构

**文件**：`src/core/command-handler.ts`

1. 新增 `/send` 命令（handleCtl 中直接处理，恢复 ReplyContext）
2. 新增 `/chatmode` 命令（无通道配置时可切换，有配置时只读 + 锁定提示）
3. `/activity` 在 proactive 模式下拒绝并提示
4. 新增 `buildCtlReplyContext()` 方法
5. 更新 CTL_COMMANDS 白名单（追加 `/send`、`/chatmode`）

### 8.4 MessageProcessor proactive 分流

**文件**：`src/core/message/message-processor.ts`

1. contextParts 中追加 proactive 提示词
2. 创建 flusher 时传入 `silent: session.sessionMode === 'proactive'`
3. 流结束后检查 proactive 模式，跳过文件标记处理（最终 flush 在 silent 模式下自动空操作，无需额外分支）
4. `sendProcessingStatus(...)` 调用保持不变（start/done/error/timeout 与 interactive 一致）

### 8.5 新建 session 默认值

**文件**：`src/core/session/session-manager.ts`

所有创建 session 的地方：
1. 优先使用 `channelOptions.sessionMode`（通道配置锁定）
2. 否则按 chatType 默认（AUN 群聊 → proactive，其余 → interactive）
3. `/new <模式>` 仅在无通道配置时生效

### 8.6 CLI 和文档更新

**文件**：
- `src/cli.ts` — 帮助文本
- `data/SKILLS.md` — 命令文档和 proactive 模式说明

---

## 9. 配置

### 9.1 evolclaw.json 示例

```json
{
  "channels": {
    "aun": {
      "domain": "gateway.agentid.pub",
      "agentName": "evolclaw-ai",
      "sessionMode": "proactive"
    },
    "aun-work": {
      "domain": "gateway.agentid.pub",
      "agentName": "work-bot",
      "sessionMode": "interactive"
    },
    "feishu": {
      "appId": "xxx"
    }
  }
}
```

**说明**：
- `channels.aun.sessionMode` → 该实例所有 session 锁定为 proactive
- `channels.aun-work.sessionMode` → 该实例锁定为 interactive
- `channels.feishu` 无 sessionMode → 默认 interactive（chatType 规则生效）
- 配置粒度为 channelName（实例级），多 AUN 实例可独立配置

---

## 10. 关键文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/types.ts` | `ChannelOptions` 新增 `sessionMode` 字段 |
| `src/core/message/stream-flusher.ts` | 新增 silent 模式 |
| `src/core/command-handler.ts` | 新增 `/send` `/chatmode`，`/activity` 限制，`buildCtlReplyContext()` |
| `src/core/message/message-processor.ts` | proactive 提示词注入，silent flusher，跳过文件标记和 flush |
| `src/core/session/session-manager.ts` | 新建 session 默认 sessionMode（通道配置 > chatType 默认） |
| `src/cli.ts` | 帮助文本更新 |
| `data/SKILLS.md` | 命令文档 + proactive 模式说明 |

---

## 11. Agent-to-Agent 回复校验机制

### 11.1 背景

Proactive 模式下 Agent 与 Agent 对话时，LLM 容易用普通文本输出而非调用 `evolclaw ctl send`，导致消息实际未发出。

### 11.2 适用范围

仅在以下条件**同时满足**时激活，其他场景零侵入：
- `chatmode === 'proactive'`
- `peerType === 'ai' | 'assistant'`

Interactive 模式不适用（Agent 输出直接呈现给用户，注入标志位会污染对话内容）。

### 11.3 标志位

通过系统提示词要求 Agent 在回复中包含以下两个标志位之一（无位置限制）：

| 标志位 | 含义 |
|--------|------|
| `[PROACTIVE:REPLY_CONFIRMED_SENT]` | 本轮已调用工具发送消息 |
| `[PROACTIVE:REPLY_CONFIRMED_NONE]` | 本轮确认无需回复 |

`PROACTIVE:` 前缀为项目专属，极低误命中概率。

### 11.4 Channel 后置校验逻辑

`complete` 事件触发后执行：

```
有 [PROACTIVE:REPLY_CONFIRMED_NONE] → 正常结束
有 [PROACTIVE:REPLY_CONFIRMED_SENT] → 验证本轮是否有成功的 ctl send tool_result
    ├─ 有 → 正常结束
    └─ 无 → 触发纠错重试（最多 2 次）
无标志位
    ├─ 本轮有成功 ctl send tool_result → 视为正常（Agent 发了但忘写标志位）
    └─ 本轮无 ctl send → 记录警告日志，不重试（保守处理，避免误触发）
```

### 11.5 纠错重试

- 最大重试次数：**2 次**，超出后记录日志放弃
- 重试注入 prompt：`"上一轮消息未实际发出，请重新调用工具发送"`
- 重试轮次的输出**不转发给对端**，仅用于 Channel 内部纠错

### 11.6 风险控制

| 风险 | 控制措施 |
|------|----------|
| 重复发送 | 只有"有 `REPLY_CONFIRMED_SENT` 但无成功 tool_result"才重试，条件严格 |
| 无限循环 | 最大 2 次硬限制 |
| 上下文污染 | 仅 Proactive + AI 对端时激活；Interactive 模式完全不触发 |
| 误命中标志位 | `PROACTIVE:` 专属前缀双重保护 |

---

## 12. 验证步骤

1. `npm run build` 构建通过
2. Interactive 模式回归：AUN 单聊行为不变
3. Proactive 模式：AUN 群聊中 agent 调用 `ctl send` 发送消息，验证用户收到
4. 多次发送：agent 连续调用多次 `ctl send`，验证都能送达
5. ReplyContext 恢复：群聊中 `ctl send` 消息包含 `@peerId` 和 `thread_id`
6. 模式切换（无通道配置）：`/chatmode proactive` → `/chatmode interactive` 来回切换
7. 模式锁定（有通道配置）：`/chatmode interactive` 被拒绝并提示锁定
8. `/new proactive`（有通道配置）：模式参数被忽略并提示锁定
9. `/activity`（proactive 模式）：被拒绝并提示不支持
10. 文件发送：`ctl file ./test.txt` 功能正常
11. 错误处理：空消息、无效模式、无效 session
12. 处理状态通知：proactive 模式下 start/done/error/timeout 均与 interactive 一致发送
