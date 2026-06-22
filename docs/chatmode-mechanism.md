# ChatMode 机制说明

## 背景

两个 agent 之间通信时，如果一方的大模型输出会无条件触发对方的大模型输入，就会形成无法终止的循环。chatmode 用来约束 agent 在某个会话上的输出方式，从而让 agent ↔ agent 的对话可以自然停止。

## 核心概念

### 1. ChatMode 是会话级状态

chatmode 是**某一个会话上**本地端的工作模式，不是 agent 的全局属性。

- 存储位置：`Session.sessionMode`（`src/types.ts`）
- 作用域：单个 `(channel, channelId, threadId)` 会话
- 同一个 agent 同时与多个对端通信时，每个会话各自持有独立的 sessionMode
- owner 通过 `/chatmode` 命令切换只影响当前会话

### 2. 两种模式

| 模式 | 含义 |
|------|------|
| `interactive` | 响应模式：大模型输出直接作为正式回复发送给对端 |
| `proactive` | 自主模式：大模型输出不直接发送，必须通过专用回复工具调用才会发出正式回复 |

`autonomous` 是预留模式，当前仅用于 silent trigger 触发的独立会话，不参与此制。

## 决定规则

会话的 sessionMode 由三个来源依次决定，后者覆盖前者：

### 来源 1：agent 配置默认值（新建会话时）

agent 配置里的 `chatmode` 段定义新建会话时的默认 sessionMode：

```jsonc
{
  "chatmode": {
    "private": "interactive",  // 与 human 单聊默认
    "group": "proactive",      // 群聊默认
    "nothuman": "proactive"    // 与 agent 单聊默认
  }
}
```

默认值（`src/cli/agent.ts` 中 `DEFAULT_CHATMODE`）：

| 字段 | 默认 |
|------|------|
| `private` | `interactive` |
| `group` | `proactive` |
| `nothuman` | `proactive` |

会话新建路径：`SessionManager.resolveDefaultSessionMode()` → `sessionModeResolver`（`src/index.ts`）。

### 来源 2：群聊强制 proactive

群聊会话必须是 proactive。无论已有 session 的历史状态如何，每次收到群聊消息时都应当强制为 proactive。

### 来源 3：非 human 对端强制 proactive

如果 `message.peerType` 不是 `'human'`（来自对端 agent.md 的 `type` 字段），本地会话强制为 proactive：

`src/core/message/message-processor.ts`：

```ts
if (message.peerType && message.peerType !== 'human' && session.sessionMode !== 'proactive') {
  session.sessionMode = 'proactive';
  await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
}
```

### 来源 4：owner 手动切换

owner 通过 `/chatmode <interactive|proactive>` 命令改写当前会话的 sessionMode。

- 单聊：任何角色可设置（但下一条 agent 消息进来时来源 3 会再次强制 proactive，所以 owner 切换"agent 对端 → interactive"只在下一条消息到来前有效）
- 群聊：仅 owner/admin 可切换

## 输出行为

本地 chatmode 决定大模型输出的发送方式。所有出站消息的 payload 顶层都带 `chatmode` 字段。

| 本地模式 | 输出来源 | 发送方式 | payload |
|---------|---------|---------|---------|
| proactive | 大模型流式文本 | `thought.put` | `type='thought'`, `chatmode='proactive'` |
| proactive | 专用回复工具（agent 主动调用） | `message.send` | `type='text'`, `chatmode='proactive'` |
| interactive | 大模型输出 | `message.send` | `type='text'`, `chatmode='interactive'` |

### proactive 模式下的额外行为

- 载入专用提示词，告知 agent "只通过工具调用才能向对端发声"
- `IMRenderer.addText()` 和 `flush()` 在 proactive 下直接 return，普通 result.text 路径被屏蔽（`src/core/message/im-renderer.ts`）
- 大模型事件通过 `IMRenderer.emit() → emitProactive()` 转成 `activity.batch`，AUN adapter 收到后走 `sendThought()`

### proactive 模式下的特殊兜底

SDK 本地"Unknown skill"错误（`/^Unknown skill:\s+\S+/`）会绕过 silent renderer，直接以 `result.text` 发送（`src/core/message/message-processor.ts`）。这是为了让用户在工具被禁用时仍能看到错误提示。这条兜底是设计保留行为。

## 入站消息处理

发送侧已经根据自己的 chatmode 选择了正确的消息类型（thought.put 或 message.send），所以接收侧**不需要按远端模式过滤**。

- `thought.put` 走独立协议通道，不会触发对端的 `message.received` 事件，对端根本收不到这条消息——循环自然阻断
- `message.send` 触发对端的 `message.received` 事件，对端正常处理

接收侧只过滤纯信号类消息（status / event / action_card_reply / menu.query 等），与 chatmode 无关。

## A ↔ B 两 agent 通信流

```
Agent A (proactive)                              Agent B (proactive)
  │                                                │
  │  大模型流式输出                                  │
  │── thought.put ───────────────────────────→     │  不触发 message.received
  │   (type='thought', chatmode='proactive')       │  → B 不会被唤醒
  │                                                │
  │  agent 调用专用回复工具                          │
  │── message.send ──────────────────────────→     │  触发 message.received
  │   (type='text', chatmode='proactive')          │  → B 大模型处理
  │                                                │
  │                              B 大模型流式输出   │
  │     ←─── thought.put ──────────────────────    │
  │     不触发 message.received                     │
  │     → A 不会被唤醒                              │
  │                                                │
  │                          B 调用专用回复工具     │
  │     ←─── message.send ─────────────────────    │
  │     触发 message.received                       │
  │     → A 大模型处理                              │
```

**循环终止条件**：某一方的大模型不再调用回复工具 → 不产生 `message.send` → 对话停止。

## 当前实现状态与缺口

### 已实现

- `Session.sessionMode` 字段及 `/chatmode` 命令
- proactive 下 IMRenderer 屏蔽普通 result.text 路径
- proactive 下大模型事件转 `activity.batch` 并通过 `sendThought()` 发出
- 非 human 对端在 `MessageProcessor.resolveSession()` 中强制 proactive
- 出站 message.send 的 payload 顶层带 `chatmode` 字段
- "Unknown skill" 特殊兜底保留

### 缺口

| # | 描述 | 影响 |
|---|------|------|
| 1 | 群聊未在 `resolveSession()` 中硬强制 proactive | 已有群聊 session 历史状态可能是 interactive，配置变更不会自动修正 |
| 2 | `chatmode.nothuman` 字段已写入配置但 resolver 不读取 | 与 agent 对端的新建私聊 session 默认是 `interactive`，依赖运行时事后纠正，若 `peerType` 缺失则纠正失效 |
| 3 | `sessionModeResolver` 只接收 `(channel, chatType)`，不接收 peerType | 无法在新建会话时直接落到 `nothuman` 默认值 |
| 4 | thought.put 的 `chatmode` 字段放在 `client_context.chatmode` 嵌套位置，不在 payload 顶层 | 与 message.send 的 chatmode 位置不一致，跨服务侧观测/追踪不统一 |

### 建议修复方向

1. `MessageProcessor.resolveSession()` 增加：群聊（`chatType === 'group'`）强制 proactive
2. `SessionModeResolver` 签名扩展为 `(channel, chatType, peerType?) => mode`
3. resolver 实现：群聊读 `cm.group`，agent 对端读 `cm.nothuman`，human 对端读 `cm.private`
4. `getOrCreateSession()` 调用方传入 peerType
5. thought.put 的 payload 顶层也写入 `chatmode` 字段，与 message.send 对齐

## 相关代码位置

| 文件 | 关键位置 |
|------|----------|
| `src/types.ts` | `Session.sessionMode`、`ChatmodeBlock`（含 `nothuman`）、`OutboundEnvelope.chatmode` |
| `src/cli/agent.ts` | `DEFAULT_CHATMODE` |
| `src/index.ts` | `sessionManager.setSessionModeResolver(...)` |
| `src/core/session/session-manager.ts` | `resolveDefaultSessionMode()`、`getOrCreateSession()`、`updateSession()` |
| `src/core/message/message-processor.ts` | `resolveSession()` 非 human 强制 proactive、`_processMessageInternal()` chatmode 注入、Unknown skill 兜底 |
| `src/core/message/im-renderer.ts` | `addText()`/`flush()` proactive 屏蔽、`emitProactive()` |
| `src/channels/aun.ts` | `sendThought()`、`deliverTextEntry()` 写入顶层 `chatmode`、`activity.batch` 分支 |
| `src/core/command-handler.ts` | `/chatmode` 命令实现 |
