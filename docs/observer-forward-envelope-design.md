# Observer Forward 信封透传设计

## 背景

Observer（owner 观察者）机制：当 agent 配置 `observable=true` 且有 owner 时，
agent 收发的每条消息都会经 `observer.forward` 镜像一份给 owner，让 owner 能在
Evol 前端里旁观 agent 与对端（私聊/群）的完整对话。

相关代码：`src/channels/aun.ts`
- `forwardInbound(...)` — 入站（对端→agent）镜像
- `forwardOutbound(...)` — 出站（agent→对端）镜像
- `emitForward(direction, original, owners)` — 实际投递，构造 `observer.forward` payload

接收端（owner 侧）按 `original.from` / `original.to` 把这条观测消息落到对应的
channel slot（私聊落对端 slot，群聊落 `observe:.../<groupId>` slot）。

## 问题

当前 `emitForward` **重构信封**而非透传原始信封：

```ts
original: {
  from: original.from,
  to: original.to,
  ...(seq != null ? { seq } : {}),
  timestamp: Date.now(),
  payload: original.payload,
}
```

只挑了 `from`/`to`/`seq`/`payload` 四个字段重新拼装，带来三个问题：

1. **统计/观察用的信封字段全丢了**：`message_id`、服务端 `timestamp`/`created_at`、
   `delivery_mode`、`dispatch_mode`、`dispatch`、`encrypted` 等都没透传给 owner，
   owner 端无法做完整的消息级统计与展示。
2. **路由字段靠人为推断、易错**：`to` 在原始消息里并不存在（私聊靠 `from`+自己 AID
   推断，群聊靠 `group_id`），是重构时算出来的。群聊场景曾因 `groupId` 没传进
   `forwardInbound` 而把 `to` 误算成 agent 自己的 AID，导致群消息在 owner 端被
   当私聊路由（已临时修复：给 `forwardInbound` 加 `groupId?` 参数）。
3. **新增字段必漏**：SDK/服务端每加一个信封字段，重构逻辑都要手动跟进，漏了就是 bug。

根因：信封是 **AUN 客户端（SDK）带来的**，不是我们生成的。我们却在转发时把它
拆散重拼，等于把一份权威数据降级成了人工子集。正确做法是**透传原始信封 + 明文 payload**。

## SDK 现状（@agentunion/fastaun 0.4.12）

0.4.12 起 SDK 给应用层事件统一注入 `envelope` 字段（顶层别名字段在 0.4.x 兼容期保留，
0.5.* 移除，应尽快迁移到 `msg.envelope.*` 访问）。

### 入站 — ✅ 已能拿到「完整信封 + 明文 payload」

**私聊 `message.received`** 回调对象：
```json
{
  "envelope": { "message_id", "from", "to", "seq", "timestamp", "encrypted" },
  "payload": { "...明文业务 JSON..." },
  "delivery_mode": "queue"
}
```

**群聊 `group.message_created`** 回调对象：
```json
{
  "envelope": { "group_id", "seq", "message_id", "sender_aid", "message_type", "dispatch_mode" },
  "payload": { "...明文业务 JSON..." }
}
```

`payload` 是 SDK 已解密的明文（解不开的消息走 `message.undecryptable` / 群对应事件，
不会进入这两个回调），**没有密文残片**。所以入站可以直接透传整个回调对象。

### 出站 — ⚠️ 信封不完整，待 SDK 补齐

**私聊 `message.send` 响应**：只有 ack
```json
{ "message_id", "seq", "timestamp", "status", "delivery_mode" }
```
没有 `from`/`to`/完整信封，没有回传 payload。

**群聊 `group.send` 响应**：有 `result.message` 信封，但 **payload 是密文**
```json
{
  "message": {
    "group_id", "seq", "message_id", "sender_aid",
    "message_type": "e2ee.group_encrypted",
    "payload": { "type": "e2ee.group_encrypted", "...": "..." },
    "created_at"
  }
}
```

结论：**出站目前无法从 SDK 单独拿到「完整信封 + 明文 payload」**——私聊缺信封，
群聊的 payload 是密文。要么本地手动组合，要么等 SDK 改。

## 目标

`observer.forward` 转发给 owner 的内容 = **原始消息的信封 + 明文 payload**，
入站出站一致，不再人工重构信封。是否加密由 agent↔owner 之间的设定决定
（与被观测的对端↔agent 那条链路的加密无关）。

## 方案

### emitForward

- `original` 不再人工挑字段重拼，直接承载「完整信封 + 明文 payload」的对象。
- 定义明确的转发信封类型（不要用 `unknown`），列出要暴露给 owner 的字段，
  编译期兜底，避免漏字段。
- 投递给 owner 时 `encrypt` 取 agent↔owner 设定（observer 链路自己的加密策略），
  **不要**硬编码 `encrypt: false`。

### 入站（已可落地，不依赖 SDK 改动）

`message.received` / `group.message_created` 回调对象已含 `envelope` + 明文 `payload`。
`forwardInbound` 改为接收整个回调对象并透传：

```ts
// 调用点
this.forwardInbound(fromAid, msg);     // 私聊
this.forwardInbound(senderAid, msg);   // 群聊（groupId 已在 msg.envelope 里，无需单独传）

// forwardInbound 只做 self-echo / from-owner 过滤，然后整体透传 msg
```

注意：`from` 仍需单独传入用于过滤（self-echo、排除来源 owner），但**不再用它重构信封**。

### 出站（需 SDK 配合，见下）

理想：`message.send` / `group.send` 的响应返回**完整信封 + 明文 payload**，
agent 直接把它透传给 owner，与入站对称。

在 SDK 补齐前的**临时本地组合**（如需先落地出站）：
- 私聊：`{ envelope: { from: self, to, message_id: result.message_id, seq: result.seq, timestamp: result.timestamp }, payload }`（payload 是发送时的明文）
- 群聊：`{ envelope: { ...result.message 去掉 payload }, payload }`（用发送时的明文 payload 替换 `result.message` 里的密文 payload）

临时方案的缺点：信封字段靠手工拼、私聊缺服务端权威字段、群聊要剥离密文 payload，
仍有「新增字段会漏」的老问题。因此**首选等 SDK 改完再做出站透传**。

## 需要 SDK 的改动

> 已向 SDK 侧提出：**出站发送也必须返回信封**。

具体诉求：

1. **`message.send`（私聊出站）响应补全信封**
   当前只返回 ack（`message_id`/`seq`/`timestamp`/`status`/`delivery_mode`）。
   需要补齐与入站 `message.received` 对称的 `envelope`（`from`/`to`/`message_id`/`seq`/`timestamp`/`encrypted`），
   让出站能拿到「完整信封」。

2. **`group.send`（群聊出站）响应回传明文 payload**
   当前 `result.message.payload` 是密文（`e2ee.group_encrypted`）。
   需要在响应里附带本端发送时的**明文 payload**（信封字段 `result.message` 已具备），
   让出站能拿到「明文 payload」而无需本地剥离/替换。

3. **信封形态与入站对齐**
   出站响应的 `envelope` 字段结构尽量与入站事件的 `envelope` 一致，
   这样 `emitForward` 入站出站可共用同一套透传逻辑和类型。

SDK 改完后：出站直接 `forwardOutbound(to, <SDK 返回的 信封+明文payload 对象>)` 透传，
删除本地手工组合逻辑。

## 0.5.* 迁移提醒

0.4.x 顶层别名字段（`msg.from`/`msg.seq`/`msg.group_id` 等）将在 0.5.* 移除。
evolclaw 现有大量直接访问 `msg.from`/`msg.seq`/`msg.created_at` 的代码需迁移到
`msg.envelope.*`。这是独立任务，但与本设计同向——透传整个对象时天然带上 `envelope`，
迁移成本主要在「读取信封字段做业务判断」的那些点。

## 当前代码状态

- `forwardInbound` 已临时加 `groupId?` 参数修复群聊 `to` 误算问题（commit `7b55cf8` 一带）。
- 本设计的「入站透传」改动**尚未落地**（上一轮尝试已撤销，因为出站方案还依赖 SDK）。
- 待 SDK 出站返回信封后，入站+出站一起按本设计实现，并删除临时的信封重构与 `groupId?` 透传。

## 参考

- SDK 文档：`node_modules/@agentunion/fastaun/_packed_docs/sdk/09-message-rpc-manual.md`、`09-group-rpc-manual.md`
- SDK CHANGELOG 0.4.12 节（envelope 注入）
- 相关设计：`observer-mode-design.md`、`observer-insert-design.md`
