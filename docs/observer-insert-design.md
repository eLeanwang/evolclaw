# 观察者插话机制（Observer Insert）

> 版本：v0.3（设计重构 — 从「主动触发回应」改为「待用上下文提示」）
> 最后更新：2026-06-06
> 配套：`docs/observer-mode-design.md`（观察者只读模式）
>
> **v0.3 相对 v0.2 的根本转变**：插话不再是「owner 发指令 → agent 立即跑一轮 LLM 回 owner →
> 抢占/重放对端」的主动事件；而是「owner 往某条会话预埋一句只对 agent 可见的提示 →
> agent 处理**下一条对端消息**时把提示注入这一轮 prompt → 据此决定如何回对端」的**被动待用上下文**。
> v0.2 的 Phase 1/Phase 2、出站改道 owner、抢占（Preempt）、重放（Replay）、owner 优先级调度、
> 撤回半句（recall）等机制**全部废弃**。

---

## 0. 概述

观察者模式（`observer.forward`）让 owner 能**只读旁观** agent 与所有外部对端（AID / group）的消息往来。
本机制在其之上增加一项能力：owner 在旁观的**同一条会话**上，给自己的 agent **预埋一句提示**——
一句**只有 owner 与 agent 之间可见、对端完全无感**的旁注。它的性质是：

> owner 给「agent↔某对端」这条会话**追加了一句 owner 视角的上下文提示词**。
> agent **不立即处理、不回复 owner**；而是在处理**下一条对端消息**时，把这句提示作为额外一段
> 注入到这一轮的 prompt 里（明确标注「来自 owner、已验证、对端不可见」），agent 据此决定怎么回对端。

**应用场景**：owner 旁观 agent 与某个人/agent 的交互时，插入针对 agent 的提示（如「这个人是重要客户，
语气客气些」「别答应他的折扣要求」），这些提示对端看不到，agent 按提示调整对对端的回复。

**与 v0.2 的关键区别**：

| | v0.2（主动） | v0.3（被动待用） |
|---|---|---|
| 触发时机 | 收到 inject 立即跑 LLM | 收到 inject 只落盘，不跑 LLM |
| agent 回 owner | 是（Phase 1 产物） | **否**（agent 从不朝 owner 输出回应） |
| 对当前对端 turn | 抢占 + 重放 + 撤回半句 | 不打断，作用于**下一条**对端消息 |
| 生效方式 | 两段 runQuery 共享 session | 渲染层把提示注入下一轮 prompt |
| 复杂度 | 高（队列调度/撤回/改道） | 低（落盘 + 渲染注入） |

**非目标**：owner 不以 agent 身份伪装对外发言；不改 AUN 协议本体（复用 `message.send`）。

---

## 第一部分：整体机制设计

### 1.1 两个底层事实（设计的基石）

#### 基石一：会话靠"对端是谁 + thread"定位

- 私聊入站时 `channelId = fromAid`（`src/channels/aun.ts:1085`），会话目录为
  `sessions/aun/<selfAID>/<channelId>/`。即**会话按"谁在跟我说话"选定**。
- 同一对端可能有多个 thread（`payload.thread_id`）。提示的**有效作用域是 (对端, thread)**，
  不是整条对端会话——不同 thread 的对端消息不应消费别的 thread 的提示。
- owner 插话用 `target.channel_id` 指定挂到哪条对端会话，用 `target.thread_id` 指定 thread。

#### 基石二：提示不触发处理，只在"下一轮"被渲染层取用

owner 插话**不进消息队列、不触发 runQuery**。它只是往该会话的 pending-hints 落一条记录。
真正生效是在**下一条对端真实消息**到达、message-processor 组装这一轮 prompt 时——
回放 pending-hints 算出有效提示集，作为 `SubMessage` 注入渲染管线。

### 1.2 统一设计原则（核心）

> **插话 = 给「agent↔(对端,thread)」会话追加一句待用提示；下一条对端消息到达时一次性消费、注入渲染层。**

三条核心保证：

- **对端无感** = 插话从不向对端 channelId 投递任何消息；agent 也从不因插话单独输出。
  提示只在 agent 处理对端消息那一轮，混进喂给 base agent 的 prompt 内部（对端永远看不到）。
- **带完整背景** = 提示注入的是「agent↔对端」会话这一轮的 prompt，agent 本就带着与对端对话的
  完整上下文（agentSessionId 的 transcript），提示自然叠加其上。
- **owner 权威** = 提示以独立标注块注入（带「owner·已验证·时间」信封头），模型明确知道
  这是主人的指令、优先级高于对端、且对端不可见。

### 1.3 一次性语义与文件生命周期

提示是**一次性**的（决定2）：下一条对端消息消费掉全部当前有效提示后即清除。消费后提示进入
该会话的 baseagent transcript（模型记忆自然留存），不再重复注入。

**pending-hints 文件生命周期**（消费按 (对端, thread) 维度）：

```
add    → 追加一行          （owner 加提示）
remove → 追加一行          （owner 撤销，按 id 或全清）
consume（对端消息到达触发）→ 读文件 → 回放算「该 thread」有效集 → 注入渲染
        → 清掉该 thread：其它 thread 仍有未消费提示则重写文件只留它们，否则删整个文件
```

- **append-only 只活在"两次消费之间"**：用于处理 owner「加了又撤」的竞态（add/remove 按时间序回放抵消）。
- 因为 consume 是「把**该 thread** 当前有效提示一次性全部用掉」，消费后该 thread 有效集**必然归零**，
  未来状态不依赖消费前历史——所以**消费即清该 thread 是安全的，不需要 consume 事件行**。
- **thread 隔离**：consume 只清传入 threadId 的提示；文件里其它 thread 的未消费提示通过重写保留，不被误删。
- **只有整文件再无任何有效提示时才删文件**：consume 后无残留即删；`remove` 把提示全撤光时也删。
- **残留文件只在「确有未消费提示」时存在**（这正是决定4 要的持久化语义）；一旦消费或撤光即消失，**不堆积死文件**。

### 1.4 thread 作用域

- 提示按 (对端, thread) 归属。owner 插话 `target.thread_id` 指定 thread。
- **owner 未带 thread_id** → 提示挂「主线程」（thread_id 为空那一支，决定3）；只有同样无 thread 的对端消息消费它。
- 下一条对端消息到达时，按它的 threadId 匹配，只消费**同 thread**（含同为"主线程/空"）的有效提示。

### 1.5 端到端流程

```
owner --observer.inject{action, target, text}--> agent.AID
  │
  ├─[A] aun.ts 入站快速路径识别 type（仿 MENU_REQUEST_TYPES，在白名单前拦截）
  │
  ├─[B] 鉴权：from ∈ getObserverConfig().owners ？
  │      否 → 不落盘 + ack(rejected, NOT_OWNER)
  │
  ├─[C] 校验：action=add 需 target.channel_id + text；action=remove 需 target.channel_id
  │      不合法 → ack(rejected, INVALID_TARGET)
  │
  ├─[D] 向 sessions/aun/<agent>/<对端>/pending-hints.jsonl 追加一行（add / remove）
  │      写盘成功 → ack(accepted)
  │      写盘失败 → ack(rejected, STORE_FAILED)
  │
  └─ 结束。不 dispatch、不跑 LLM、不抢占、不回 owner。

—— 时间流逝；agent 可能重启，pending-hints.jsonl 落盘故仍在 ——

下一条【对端真实消息】到达该会话（带它的 threadId）:
  │
  ├─[E] message-processor 回放该会话 pending-hints.jsonl，并**当即消费**（读取即清该 thread，
  │      见 [H]）→ 按 (对端, thread) 算出"已 add、未被 remove"的有效提示集（按发送先后排序）
  │
  ├─[F] 把每条有效提示包成一个 SubMessage（kind='owner-hint'，带 injectTime/ownerAid），
  │      排在对端真实消息 item 之前，一起交给 renderMessageBody
  │
  ├─[G] 渲染层：owner-hint item 命中 modeType=inject 的 manifest section
  │      → 用 inject 模板渲染"‹owner·已验证·{{injectTime}}›\n提示正文"
  │      对端真实 item → 走 private/group 类型模板
  │      → 两段拼成最终 body，模型一次看到
  │      （渲染若抛错走 raw 兜底：仍把已消费提示以纯文本前缀拼回，绝不静默丢提示）
  │
  ├─[H] 消费即清：清掉该 thread 的提示；其它 thread 仍有未消费提示则重写文件保留，否则删整个文件
  │      （消费在 [E] 读取时一次完成，[G] 渲染只是使用结果）
  │
  └─ agent 据提示回对端。对端全程无感。
```

- **agent 空闲时插话**：无对端消息在途 → 提示静静躺在 pending-hints.jsonl，
  影响**下一条**到来的对端消息。可长期留存（决定4）。
- **当前有对端 turn 在跑**：不打断（决定1a）；提示作用于该 turn 结束后的**再下一条**对端消息。
  代价：提示永远"慢一拍"，拦不住正在生成的那一句——已知取舍，可接受。

### 1.6 消息类型

#### `observer.inject`（owner → agent.AID，入站）

经 AUN `message.send` 发给 agent 自身 AID，payload 为对象（对齐 menu.* 的 JSON 约定）：

```json
{
  "type": "observer.inject",
  "id": "inj-001",
  "action": "add",
  "target": { "channel_id": "<对端AID/group_id>", "chat_type": "private", "thread_id": "<可选>" },
  "text": "<owner 的提示内容>"
}
```

| 字段 | 含义 |
|------|------|
| `action` | `add`（默认，加提示）/ `remove`（撤销）|
| `target.channel_id` | 定位 agent↔对端 会话（支点）|
| `target.chat_type` | `private` / `group` |
| `target.thread_id` | 可选；缺省挂主线程（空 thread）|
| `text` | owner 提示内容（add 必填；remove 可空）|
| `id` | 提示唯一 id；remove 时若带 `target_id` 则按 id 精确撤销，否则撤销该 (对端,thread) 全部 |
| `from`（信封层）| owner AID，用于**鉴权** |

#### `observer.inject.ack`（agent → owner，出站）

仅表示"提示是否被受理/已持久化/已撤销"，**不是** agent 对提示的回应（agent 永不回应 owner）：

```json
{ "type": "observer.inject.ack", "id": "inj-001",
  "data": { "status": "accepted", "action": "add" },
  "error": { "code": "NOT_OWNER | INVALID_TARGET | STORE_FAILED", "message": "..." } }
```

- `accepted` 在**成功写盘之后**发出 —— 它真正代表"已持久保存、保证下次会用上"，而非"刚收到"。
- ack 是**唯一**发给 owner 的东西。一条 ack 即达成"提示 owner 已收下"的目的。

### 1.7 持久化与可观测性（watch）

**持久化**（决定4）：pending-hints.jsonl 落盘在被观察会话目录
`sessions/aun/<agent>/<对端>/pending-hints.jsonl`（与 messages.jsonl 同级）。agent 重启后提示仍在，
直到被消费或撤销。

**可观测**：owner 的插话（add/remove）要能在 `watch msg` / `watch aid` 看到，与对端真实消息区分：

- 带 `source = 'owner-inject'` 标记，记录到被观察的 agent↔对端 会话流（`recordInjectWatch('in', …)`）。
- 同时写 appendAidEvent（带 `inject:true`）+ aidStatsCollector（标 `inject`）。
- `watch msg` 渲染打 `[插话]` 标签（黄色）；remove 记为 `[撤销提示]`。
- **注意**：v0.3 中插话**不产生 agent→owner 的回应消息**，watch 里只有"插话已添加 / 已撤销"这类入站事件
  （consume 不单独记 watch——它体现在该会话后续那条对端消息的正常处理里）；
  没有 v0.2 那种"出站回应改道"记录——`injectPeerChannelId` 透传等机制随之废弃。

> 插话**不写入 owner↔agent 会话历史**（它是对"agent↔对端"会话的旁路控制）；
> 也**不被 observer.forward 镜像**。
> 消费时提示进入该会话的 baseagent transcript（模型记忆），这正是"带背景"所需，只影响模型记忆，不泄漏对端。

### 1.8 会话/模式状态不被插话改写

插话**不改 `session.sessionMode`**，**不切 interactive/proactive**——v0.3 里 agent 处理对端消息
始终走对端**原生模式**，提示只是这一轮 prompt 多一段内容。v0.2 的 forceInteractive / 出站改道 **全部废弃**。

---

## 第二部分：消息渲染模式（类型 + 名称）

插话提示的注入**复用消息渲染层**（`eck_message_manifest.json` + `message-renderer.ts`），
不在 message-processor 里硬拼字符串。为此把渲染层从「单一 `msg-item`」扩成**可切换的渲染模式**。

### 2.1 两个维度：类型（modeType）+ 名称（modeName）

每个渲染模式是 manifest 里的一个 section，带两个新约定字段：

| 字段 | 含义 | 取值 |
|------|------|------|
| `modeType` | 渲染**类型**（大类） | `private` / `group` / `inject` |
| `modeName` | 该类型下的**模式名称**（变体） | 自定义，如 `default` / `concise` / `verbose` |
| `isDefault` | 该类型的缺省模式（config 未配时用） | `true` / 省略 |

- **private / group**：对端真实消息的渲染，由消息 `chatType` 决定走哪类。
- **inject**：owner 提示的渲染（owner-hint item 命中），信封头标注「owner·已验证·时间」。
- 每个类型可有**多个 modeName**，但**同一时刻只激活一个**。

### 2.2 激活哪个模式：config.json 配置 + isDefault 回退

当前各类型激活哪个 modeName，写在 **agent 的 `config.json`**（不从前端实时传递）：

```json
{
  "render": { "private": "concise", "group": "default", "inject": "default" }
}
```

- 某类型在 `render` 里**配了 modeName** → 用它。
- **未配** → 回退到该类型 `isDefault:true` 的 section。
- 三个类型相互独立，可分别设。

> **读取来源（实现要点）**：`config.json` **不走 fileCache**，其内存缓存是 `EvolAgent.rawAgent`。
> 热消息路径用 `agentRegistry.resolveByChannel(channelKey)?.config`（内存中的 `MergedAgentConfig`）读 `render`，
> **不要直调 `loadAgent()` 重读磁盘**。message-processor 在调 `renderMessageBody` 的同一 scope 即可拿到。

### 2.3 渲染层如何选中唯一模式

各类型当前激活的 modeName 来自 agent config（内存）：message-processor 把 `config.render`
原样作为 `renderModes` 注入 `sessionVars`；**渲染层（message-renderer，逐 item）** 再据此算出命中变量
（这样 default 回退与 owner-hint 标记都按"每条 item"求值，更干净）：

```
// message-renderer.renderOneItem 内，每条 item 求值：
renderMode_private = renderModes.private ?? <private 类型 isDefault 的 modeName>
renderMode_group   = renderModes.group   ?? <group   类型 isDefault 的 modeName>
renderMode_inject  = renderModes.inject  ?? <inject  类型 isDefault 的 modeName>
isOwnerHint        = (item.kind === 'owner-hint')
injectTime/ownerAid = owner-hint item 的字段（仅 owner-hint 时有值）
```

> isDefault 回退由 `manifest-engine.defaultModeNames(sections)` 提供。

每个 section 的 `when` 用**复合 `and` + 等值/不等值**命中唯一模式。为支持"item 类型 + 激活模式"
多维匹配，`evaluateWhen` **新增了 `and`/`or` 复合算子**（仍是声明式，无副作用）。实际 manifest：

```jsonc
// 插话·default 模式（owner-hint item 才命中）
{ "id": "msg-inject-default", "modeType": "inject", "modeName": "default", "isDefault": true,
  "when": { "and": [ { "var": "isOwnerHint", "eq": true }, { "var": "renderMode_inject", "eq": "default" } ] },
  "file": "$KITS_MESSAGE_FRAGMENTS/inject-default.md", "needsInjection": true, "order": 5 }

// 对端私聊·default 模式（非 owner-hint、非 group；含 coding/null 兜底）
{ "id": "msg-private-default", "modeType": "private", "modeName": "default", "isDefault": true,
  "when": { "and": [ { "var": "isOwnerHint", "neq": true }, { "var": "chatType", "neq": "group" }, { "var": "renderMode_private", "eq": "default" } ] },
  "file": "$KITS_MESSAGE_FRAGMENTS/item.md", "needsInjection": true, "order": 10 }

// 群聊·default 模式
{ "id": "msg-group-default", "modeType": "group", "modeName": "default", "isDefault": true,
  "when": { "and": [ { "var": "isOwnerHint", "neq": true }, { "var": "chatType", "eq": "group" }, { "var": "renderMode_group", "eq": "default" } ] },
  "file": "$KITS_MESSAGE_FRAGMENTS/item.md", "needsInjection": true, "order": 10 }
```

> - owner-hint item（`isOwnerHint=true`）只命中 inject section；普通 item（`isOwnerHint!=true`）按 `chatType`
>   走 private/group——「提示 item」与「对端 item」各走各的模板，互不串。
> - private section 用 `chatType neq group` 兜住 private 与 coding/null（chatType 为空）两种情形，
>   保持旧 `when:always` 时代"任何消息都有信封"的行为。
> - 渲染引擎忽略 `modeType`/`modeName`/`isDefault`（仅 renderer 用来算 default 回退）；命中判定只靠 `when`。

### 2.4 inject 模板（提示信封头）

owner-hint item 的 `SubMessage` 带 `injectTime`（提示发出时间）、`ownerAid`。inject 模板渲染成
独立标注块，让模型明确「这是已验证的 owner 指令、对端不可见」：

```
‹owner 提示 · 已验证 · {{injectTime}}›
{{content}}
```

具体措辞可在 fragment 模板里调（`$KITS_MESSAGE_FRAGMENTS/inject-default.md`），机制与现有 `item.md`
信封头同源。

### 2.5 evolclaw 侧改动清单（v0.3）

| # | 改动点 | 文件 | 说明 |
|---|--------|------|------|
| 1 | `observer.inject` 接收：仅落盘，不 dispatch | `src/channels/aun.ts` | 鉴权 + 校验后写 pending-hints.jsonl（add/remove），不再 `dispatchMessage`、不构造 injectMeta 触发处理 |
| 2 | ack 时机挪到写盘后 + 新增 `STORE_FAILED` | `src/channels/aun.ts` | `emitInjectAck` accepted 在成功写盘之后；写盘失败回 rejected |
| 3 | pending-hints 读写（append-only + 回放 + 消费按 thread 清/删文件） | `src/core/message/pending-hints.ts`（新增） | `appendHintAdd`/`appendHintRemove`/`consumeHints(对端,thread)`/`peekHints`：回放算该 thread 有效集→返回→清该 thread（其它 thread 残留则重写保留，否则删文件） |
| 4 | 渲染前消费 pending、包装 owner-hint SubMessage | `src/core/message/message-processor.ts` | `consumeOwnerHints` 在 `renderMessageBody` 前消费 (对端,thread) 提示、排对端 item 前；消费在 try 外，渲染抛错时 `composeHintFallback` 把已消费提示拼回 raw 兜底 |
| 5 | 渲染模式命中变量 | `src/core/message/message-processor.ts`（注入 `renderModes`）+ `src/eck/message-renderer.ts`（逐 item 算 `renderMode_*`/`isOwnerHint`/`injectTime`/`ownerAid`） | processor 从内存 config 读 `render` 透传；renderer 据 `defaultModeNames` 回退并标记 owner-hint |
| 6 | manifest schema 扩展 + `evaluateWhen` 加 `and`/`or` | `src/eck/manifest-engine.ts` + `kits/eck_message_manifest.json` + `kits/templates/message-fragments/inject-default.md` | section 加 modeType/modeName/isDefault（引擎忽略）；新增 `and`/`or` 复合算子；3 个 section（inject/private/group default） |
| 7 | SubMessage 加 kind/injectTime/ownerAid | `src/types.ts` | 标记 owner-hint item |
| 8 | watch 记录 add/remove/consume（owner-inject 标记） | `src/channels/aun.ts` + `src/cli/watch-msg.ts` | 复用 `recordInjectWatch`，语义改为"已添加/已撤销/已消费" |
| 9 | **删除 v0.2 残留** | aun.ts / message-bridge.ts / message-queue.ts / index.ts / types.ts | 拆除 replyOverride/forceInteractive/injectMeta/injectPeerChannelId/pendingReplay/owner优先级/recall 等全部主动链路 |

**v0.2 → v0.3 删除项**（合并丢弃的 processor 改道逻辑正属于此，无需恢复，反而一并清掉）：
`Message.replyOverride`、`InjectMeta` 接口、`forceInteractive`、`outboundChannelId` 改道、`injectMeta` 触发处理、
`injectPeerChannelId` 透传、`pendingReplay` 抢占/重放、owner 优先级调度、`recallRecentOutbound`/
`trackOutboundMid`/`setInjectRecallHook`、`Message.source` 的 `peer-replay`。`source:'owner-inject'`
仅在 `MessageLogEntry` 与 watch-msg 保留（用于 watch 标记 `[插话]`）；`Message`/`InboundMessage` 的
`source` 已不含 `owner-inject`（v0.3 插话不再进消息流）。

---

## 第三部分：前端如何对接

### 3.1 连接模型

owner 的 Evol 客户端（AUN 原生主体）直接经 AUN `message.send` 把 `observer.inject` 发给 agent 自身 AID
（与发普通消息同一通道），不经 ecweb。`target.channel_id` 取自正在旁观的那条 `observer.forward`
流的 `original.from` / `original.to`（见 `observer-mode-design.md §7`）。

### 3.2 添加提示（add）

```js
message.send({
  to: agentAid,
  payload: {
    type: 'observer.inject',
    id: 'inj-001',                 // 前端生成的唯一 id，撤销时要用
    action: 'add',
    target: { channel_id: '<对端AID/group_id>', chat_type: 'private', thread_id: undefined },
    text: '<提示内容>'
  },
  encrypt: false
})
```

- owner 可在**任意时间**、对同一会话发**任意条数**提示（决定6）；它们按发送先后累积，
  在对端下条消息到来时一并注入。

### 3.3 撤销提示（remove）—— 重点

撤销和添加**同样是往 pending-hints 追加一行**（append-only），不是物理删除。两种粒度：

```js
// (a) 按 id 精确撤销某一条
message.send({ to: agentAid, payload: {
  type: 'observer.inject', action: 'remove',
  target: { channel_id: '<对端>', thread_id: undefined },
  target_id: 'inj-001'            // 指定要撤的提示 id
}, encrypt: false })

// (b) 撤销该 (对端,thread) 下全部未消费提示（不带 target_id）
message.send({ to: agentAid, payload: {
  type: 'observer.inject', action: 'remove',
  target: { channel_id: '<对端>', thread_id: undefined }
}, encrypt: false })
```

**撤销的生效边界（前端须知）**：

- 撤销只对**尚未被消费**的提示有效。提示一旦被某条对端消息消费（注入并进入模型记忆），
  就**无法再撤**——它已经在 agent 这一轮的上下文里了。
- 因为「不打断当前 turn」（决定1a）且纯异步，存在**轻微竞态**：若撤销与对端消息几乎同时到达，
  可能出现「提示刚被这一轮消费、撤销扑空」。后果很轻（顶多一句提示早一轮/晚一轮生效），可接受。
- 撤销也会收到 `ack`（accepted/rejected），前端据此反馈。

### 3.4 消费回应

| 收到的消息 | 含义 | 前端处理 |
|-----------|------|----------|
| `observer.inject.ack` | 提示是否被受理/持久化/撤销 | UI 反馈；rejected 时按 code 提示（NOT_OWNER/INVALID_TARGET/STORE_FAILED）|
| `observer.forward` | 对端会话正常往来（含 agent 据提示对对端的回复）| 维持只读旁观渲染 |

> **重要**：v0.3 中 agent **从不就插话向 owner 发回应消息**。owner 唯一能收到的就是 `ack`
> （"提示已收下/已撤销/被拒"）。不要期待 v0.2 那种"agent 对插话的回复"。

### 3.5 渲染模式（前端无需关心）

插话/私聊/群聊各类型当前激活哪个渲染模式，**完全由后端 agent `config.json` 的 `render` 字段决定**
（缺省回退到声明文件里标 `isDefault` 的模式）。这是后端配置，**前端不感知、不提供管理页面、不传递模式**。
前端只负责发插话（add）和撤销（remove），提示长什么样由后端渲染层处理。

### 3.6 UI 建议

- 在旁观的对端会话面板里提供"插话"输入框；owner 提示作为该面板内的**旁支标注**展示
  （区别于对端真实消息气泡），让 owner 一眼分清"只有我和 agent 看得到"。
- 列出该会话**未消费的待用提示**（owner 加了还没生效的），每条带撤销按钮（发 remove）。
- 前端不做 owner 鉴权（后端强校验），但要处理 `rejected` 反馈。

---

## 第四部分：验证方式（end-to-end）

1. **落盘不触发**：owner 发 add → 断言写了 pending-hints.jsonl、**未**跑 LLM、**未**向对端投递、owner 只收到 ack(accepted)。
2. **下一条消费 + 注入**：落了提示后，对端来一条消息 → 断言这一轮 prompt 含 inject 信封头 + 提示正文；对端**未**收到提示。
3. **一次性 + 删文件**：消费后 → 断言 pending-hints.jsonl 已删；再来一条对端消息 → 断言不再注入该提示。
4. **add/remove 回放**：add 两条 + remove 第一条 → 对端来消息 → 断言只注入第二条。
5. **remove 全清删文件**：add 后 remove（不带 target_id）→ 断言有效集归零、文件删除。
6. **thread 作用域**：对端 thread-A 挂提示 → 对端 thread-B 来消息 → 断言**不**消费（A 的提示仍在）；thread-A 来消息才消费。
7. **无 thread 挂主线程**：add 不带 thread_id → 只有无 thread 的对端消息消费它。
8. **持久化**：add 后重启 agent → pending-hints.jsonl 仍在 → 对端来消息仍能消费。
9. **鉴权**：非 owner 发 inject → 断言不落盘 + ack(rejected, NOT_OWNER)。
10. **渲染模式**：config 设 `render.inject=verbose` → 断言命中 inject-verbose 模板；未设 → 命中 isDefault。
11. **群聊**：群会话挂提示 → 群内对端消息消费、注入；群内其他成员**未**收到提示。
12. **watch**：add/remove/consume 在 `watch msg` 显示 `[插话]` 标签，与对端真实消息区分。

---

## 第五部分：实现状态

- **v0.2**：已实现「主动触发回应」全链路（Phase1/2、抢占、重放、撤回、owner 优先级）。
- **v0.3（本文档）**：设计重构为「待用上下文提示」。v0.2 的主动链路全部废弃、待删（见 §2.5 改动清单 #9）。
  > 注：一次 git 合并曾丢弃 message-processor.ts 中 v0.2 的出站改道逻辑，造成 bridge 设 replyOverride、
  > processor 不读它的「半接线」断裂。v0.3 既然整体废弃主动链路，该断裂**无需恢复**，按 §2.5 #9 一并清除即可。
