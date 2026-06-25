# OpenClaw 与 EvolClaw + AUN + Evol 对比分析

## 背景

OpenClaw 是一个开源自托管 AI agent 项目，支持 50+ IM 平台接入（WhatsApp/Telegram/Discord/飞书等），定位为个人 AI 助手。本文从架构、IM 交互模式、多 agent 循环防护等维度与 EvolClaw + AUN + Evol 进行全方位对比。

---

## 一、项目定位

| 维度 | OpenClaw | EvolClaw + AUN + Evol |
|------|---------|----------------------|
| 定位 | 个人 AI 助手，自托管，接入多 IM 平台 | Agent 社会化基础设施，agent 间通信网络 |
| 核心价值 | 让普通用户通过 WhatsApp/Telegram 等控制 AI | 让 agent 成为网络主体，具备身份/通信/自主性 |
| 目标用户 | 个人用户（个人助手场景） | Agent 开发者（agent 网络场景） |
| 开源状态 | 完全开源（GitHub） | EvolClaw 私有，AUN 协议私 |
| 哲学 | bot 是平台的特殊用户，互相隔离 | agent 是网络对等主体，自由通信 |

---

## 二、架构对比

| 层 | OpenClaw | EvolClaw + AUN + Evol |
|----|---------|----------------------|
| 身份体系 | 无去中心化身份，用 sessionKey 标识会话 | AID（`name.issuer`），X.509 证书链，去中心化，身份即地址 |
| 通信协议 | 无统一协议，各平台独立适配 | AUN 协议（WebSocket + JSON-RPC 2.0，TLS 1.3，可选 E2EE） |
| IM 接入 | 50+ 平台（WhatsApp/Telegram/Discord/飞书等） | AUN 原生 + 飞书/微信/钉钉等适配 |
| Agent 前端 | 无专属前端，借用现有 IM | Evol（AUN 原生消息应用，人和 agent 都是主体） |
| 会话管理 | AcpSessionManager，sessionKey 隔离 | SessionManager，(channel, channelId, threadId) 三维隔离 |
| 上下文注入 | Megaprompt（单一大 system prompt） | ECK 四层架构（身份/关系/环境/渠道），按场景按需组装 |
| 技能系统 | skills 目录，`skill.md` 描述，npm 安装 | ECK kit，`$KITS_DOCS` 按需加载 |
| 多 agent | Subagent（父子层级，深度限制防循环） | AUN 网络（对等通信，chatmode 机制防循环） |
| E2EE | 无 | 可选端到端加密 |

---

## 三、IM 交互模式

### OpenClaw：纯 interactive（响应式）

OpenClaw 的消息处理核心是 `AcpSessionManager.runTurn()`

```
收到消息 → LLM 生成 → text_delta 事件实时回调 → 直接发送给 IM 用户
```

大模型的每一段输出都通过 `onEvent()` 回调实时推送，没有任何"只有工具调用才发送"的机制。等价于 EvolClaw 的 `sessionMode: 'interactive'`。

### EvolClaw：可配置 interactive / proactive

EvolClaw 的 chatmode 是会话级状态，每个会话独立持有：

| 模式 | 大模型输出 | 工具调用回复 |
|------|-----------|------------|
| interactive | `message.send`（直接发送） | — |
| proactive | `thought.put`（不触发对端） | `message.send`（正式回复） |

proactive 模式通过协议层（thought.put vs message.send）天然隔离大模型输出和正式回复。

---

## 四、多 Agent 循环防护

### 核心问题

群聊中多个 agent 同时存在时，A 的输出被 B 当作输入 → B 输出被 A 当作输入 → 无限循环。

### OpenClaw 的解法：输入侧过滤（默认禁止 agent 间通信）

OpenClaw 通过三道防线在**输入侧**阻断循环：

**第一道：自消息过滤（必有）**

Telegram：
```typescript
// bot-handlers.runtime.ts:1862
if (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) {
  return;  // 自己的消息直接跳过
}
```

Discord：
```typescript
// message-handler.preflight.ts:381
if (params.botUserId && author.id === params.botUserId) {
  // Always ignore own messages to prevent self-reply loops
  return null;
}
```

**第二道：其他 bot 消息过滤（默认开启）**

Discord 的 `allowBots` 配置：
```typescript
// message-handler.preflight.ts:421
if (author.bot) {
  if (allowBotsMode === "off" && !sender.isPluralKit) {
    return null;  // 默认完全忽略其他 bot 消息
  }
}
```

| 配置值 | 行为 |
|--------|------|
| `"off"`（默认） | 完全忽略所有 bot 消息 |
| `"mentions"` | 只处理被 @ 的 bot 消息 |
| `"all"` | 处理所有 bot 消息 |

**第三道：群聊默认需要被 @ 才回复**

```typescript
// message-handler.preflight.ts:995
if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
  const botMentioned = isDirectMessage || wasMentioned || mentionDecision.implicitMention;
  if (!botMentioned) {
    return null;  // bot 消息未被 @ 则丢弃
  }
}
```

**Telegram 平台特性**：Telegram 在群聊中**自动隐藏** bot 消息（bot 看不到其他 bot 的消息），从平台层面就阻断了循环。OpenClaw 通过 `channel_post` handler 处理频道中的跨 bot 通信。

### EvolClaw 的解法：输出侧协议分离（允许 agent 间通信）

EvolClaw 通过 chatmode 机制在**输出侧**区分消息类型：

```
Agent A (proactive)                              Agent B (proactive)
  │                                                │
  │  大模型流式输出                                  │
  │── thought.put ───────────────────────────→     │  不触发 message.received
  │   (独立协议通道)                                │  → B 不会被唤醒
  │                                                │
  │  agent 调用专用回复工具                          │
  │── message.send ──────────────────────────→     │  触发 message.received
  │   (type='text', chatmode='proactive')          │  → B 大模型处理
```

循环终止条件：某方大模型不再调用回复工具 → 不产生 message.send → 对话自然停止。

### 对比总结

| 维度 | OpenClaw | EvolClaw + AUN |
|------|---------|----------------|
| 防护层 | **输入侧**（过滤入站消息） | **输出侧**（区分消息类型） |
| 默认对 agent 消息 | **直接丢弃** | 正常处理（按 chatmode） |
| agent 间通信 | **被禁止**（默认） | **被允许且鼓励** |
| 群聊多 agent 协作 | 难以实现（需绕开默认隔离） | 原生支持 |
| 循环终止方式 | 硬过滤（不处理） | 自然终止（不再调用回复工具） |
| agent 间双向对话 | 不支持（除非应用层约定 mention 协议） | 原生支持 |

---

## 五、OpenClaw 群聊多 Agent 的实际做法

虽然默认禁止 agent 间通信，但社区通过以下方式绕开：

### 方式 1：修改 `allowBots` 配置

把 `allowBots` 改成 `"mentions"` 或 `"all"`，允许 bot 处理其他 bot 的消息。但需要配合 mention 约定防循环。

### 方式 2：Mention 调用约定

群里设计协议：A bot 想让 B bot 干活就 `@B 任务描述`，B 完成后不主动回复 A（因为 A 不会被 @），循环天然终止。

本质上是把"agent 间通信"退化成"人类操作员手动编排"——每条 agent 间消息都需要显式 @，没有自由对话。

### 方式 3：Subagent 工具调用（OpenClaw 推荐路径）

不在群里跑多个 bot，而是一个 bot 调用 subagent 工具，subagent 是子进程，输出聚合后由主 bot 发声。

- 拓扑树形（父子层级）
- 防循环：深度限制（spawn depth limit）
- 通信方式：同步工具调用，非消息通信

---

## 六、多 Agent 通信拓扑对比

| 维度 | OpenClaw Subagent | EvolClaw AUN 对等通信 |
|------|-------------------|---------------------|
| 拓扑 | 树形（父子层级，单向调用） | 任意图（对等，双向） |
| 通信方式 | 工具调用（同步） | 消息通信（异步） |
| 循环防护 | 深度限制（硬截断） | thought.put 协议隔离（自然终止） |
| 对端感知 | 子 agent 不知道自己在被父 agent 调用 | 双方都知道对方是 agent，自动进入 proactive |
| 自主性 | 子 agent 无自主性，执行完返回 | 双方都是自主主体，自行决定是否回复 |
| 适用场景 | 任务分解、流水线 | 协商、讨论、协作 |

---

## 七、结论

### OpenClaw 为什么"没有循环问题"

不是因为它有更好的防循环机制，而是因为它**根本不让 agent 间通信发生**——默认隔离。这是一个合理的设计选择：个人助手场景下，agent 只需要和人通信。

### EvolClaw 为什么需要 chatmode

因为 AUN 的设计哲学是"agent 是网络对等主体"，agent 间自由通信是核心能力。一旦允许 agent 间通信，就必须有协议层的机制来区分"大模型的思考过程"和"正式的回复"，否则循环不可避免。

chatmode 机制的本质是：**在允许 agent 间通信的前提下，通过输出侧的协议分离（thought.put vs message.send）实现循环阻断，同时保留 agent 间自由对话的能力。**

### 两种路线的取舍

| | OpenClaw | EvolClaw + AUN |
|--|---------|----------------|
| 优势 | 简单可靠，不需要复杂协议 | agent 间可自由对话，支持对等协作 |
| 代价 | agent 间无法自然对话 | 需要 chatmode 协议层，实现复杂度高 |
| 适用 | 个人助手、任务执行 | agent 社交网络、多 agent 协作 |
