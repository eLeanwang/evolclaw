# 跨会话沟通协作机制设计（Context Handoff）

> 状态：已过时，请勿作为当前实现依据
> 最后更新：2026-07-01
> 关联模块：`ec msg send`、AUN 入站消息、`messages.jsonl`、ResponseEngine 渲染层

> 当前实现依据：`docs/msg-send-cross-session-handoff-append-only-design.md`

## 1. 背景

EvolClaw 的一次 baseagent 会话可以通过 `ec msg send` 主动给另一个 AID 发消息。这个目标可能是另一个 EvolClaw、human，也可能是其它 agent。

现有事实：

- `ec msg send` 发出的消息会写入目标 chat 维度的 `messages.jsonl`，并可标记 `source: "msg"`。
- 对端后续回复时，会进入本端与该对端的 AUN 会话，而不一定进入发起 `ec msg send` 的原始 baseagent 会话。
- 目标 AUN 会话的 baseagent prompt 不会天然包含“此前另一个会话通过 `ec msg send` 发给该对端的内容”。
- 如果只按 `selfAID + targetPeerAID` 归档，当两个不同 peer 都要求本端 agent 去联系同一个目标 agent 时，会出现上下文串话风险。

因此需要一个跨会话协作机制：既能让目标会话在处理回复时补上必要上下文，又能让原会话按需查阅进展，同时避免不同请求者共享同一个目标对端时串线。

## 2. 设计目标

1. **跨会话可追踪**：原会话调用 `ec msg send` 后，能拿到一个稳定引用，用于之后查询这次跨会话沟通的上下文。
2. **不自动回流**：对端有回复时，不自动把回复塞回原会话；原会话根据需要主动读取。
3. **避免串话**：两个不同 requester 同时要求本端联系同一个 target，也必须能隔离。
4. **不依赖对端配合**：对端不是 EvolClaw、版本旧、或不会回传 thread/ref 时，机制仍能保守工作。
5. **能利用协议增强**：如果对端支持 AUN `thread_id`、`ref_message_id` 或 EvolClaw 私有 metadata，则用于精确匹配。
6. **一次性补上下文**：目标会话处理对端回复时，应能看到本端之前通过 `ec msg send` 发出的内容，但不能每轮重复注入。

## 3. 非目标

- 不把所有目标 peer 历史都塞进原会话 prompt。
- 不要求对端回复必须引用原消息。
- 不要求 human/其它 agent 理解 EvolClaw 私有字段。
- 不用“有回复就自动转发给原会话”的方式做回流。
- 第一阶段只覆盖 AUN P2P；群聊 handoff 后续单独设计。

## 4. 核心概念

### 4.1 Handoff

Handoff 是一次跨会话沟通任务的逻辑线程。

它不是 peer 会话，也不是 baseagent session，而是一次“某个原会话委托本端 agent 去联系某个目标对端”的协作单元。

一个 handoff 至少包含：

- `handoffId`：全局唯一 ID。
- `originSessionId`：发起 `ec msg send` 的 baseagent 会话。
- `requesterPeerKey`：原会话背后的请求者，例如 `aun#peerA` 或 `feishu#xxx`。
- `targetPeerKey`：被联系的目标，例如 `aun#botX.aid.pub`。
- `targetThreadId`：用于 AUN 侧相关性匹配的 thread，默认等于 `handoffId`。
- `outbound`：本端发给目标的消息。
- `inbound`：目标后续回复。
- `state`：`open | waiting | answered | ambiguous | closed`。

### 4.2 ContextRef

`ec msg send` 在托管会话中创建 handoff 后，工具返回里提供 `contextRef`，供原会话主动查阅。

示例：

```json
{
  "ok": true,
  "message_id": "msg_abc",
  "contextRef": {
    "handoffId": "handoff_20260701_abc123",
    "targetPeerKey": "aun#botX.agentid.pub",
    "threadId": "handoff_20260701_abc123",
    "read": "ec ctx read handoff_20260701_abc123",
    "list": "ec ctx list --origin current"
  }
}
```

原会话需要时调用 `ec ctx read <handoffId>`，不由系统自动打断原会话。

### 4.3 Target Chat

目标 chat 仍按现有规则存在：

```text
data/sessions/aun/<selfAID>/<targetAID>/messages.jsonl
```

`messages.jsonl` 是审计事实源；handoff 是跨会话协作索引和状态机。

## 5. 数据存储

建议新增 handoff 存储，避免只靠 `messages.jsonl` 扫描。

### 5.1 Canonical Record

```text
data/handoffs/<selfAID>/<handoffId>.json
```

示例：

```json
{
  "schema": 1,
  "handoffId": "handoff_20260701_abc123",
  "selfAID": "agent.agentid.pub",
  "originSessionId": "meta_20260701_...",
  "originChannel": "feishu",
  "originChannelId": "oc_xxx",
  "requesterPeerKey": "feishu#ou_xxx",
  "targetPeerKey": "aun#botX.agentid.pub",
  "targetAID": "botX.agentid.pub",
  "targetThreadId": "handoff_20260701_abc123",
  "state": "waiting",
  "createdAt": 1782840000000,
  "updatedAt": 1782840000000,
  "outbound": [
    {
      "msgId": "msg_abc",
      "content": "请确认这个接口设计是否合理",
      "contentPreview": "请确认这个接口设计是否合理",
      "sentAt": 1782840000000,
      "source": "msg"
    }
  ],
  "inbound": [],
  "injection": {
    "pendingOutboundContext": true,
    "injectedAt": null
  },
  "match": {
    "strategy": null,
    "confidence": null
  }
}
```

### 5.2 Target Index

为了按目标对端快速查找 pending handoff，可维护一个目标索引：

```text
data/sessions/aun/<selfAID>/<targetAID>/pending-handoffs.jsonl
```

每行只放轻量指针：

```json
{
  "handoffId": "handoff_20260701_abc123",
  "targetThreadId": "handoff_20260701_abc123",
  "outboundMsgId": "msg_abc",
  "state": "waiting",
  "createdAt": 1782840000000
}
```

canonical record 是权威状态；target index 用于快速匹配和恢复。

## 6. 出站流程

### 6.1 创建条件

`ec msg send` 满足以下条件时自动创建 handoff：

- 当前进程有 `EVOLCLAW_SESSION_ID`，说明是 baseagent 托管会话内调用。
- 目标是 AUN P2P AID。
- 未显式传 `--no-handoff`。

手动终端调用默认不创建 handoff，但可以通过 `--handoff` 强制创建。

### 6.2 Payload 增强

发送到 AUN 的 payload 建议携带 EvolClaw 私有 metadata：

```json
{
  "type": "text",
  "text": "请确认这个接口设计是否合理",
  "thread_id": "handoff_20260701_abc123",
  "evolclaw": {
    "kind": "context_handoff",
    "handoff_id": "handoff_20260701_abc123",
    "origin_session_id": "meta_20260701_...",
    "origin_message_id": "msg_abc"
  }
}
```

说明：

- `thread_id` 用于 AUN 层相关性匹配。默认等于 `handoffId`。
- 如果用户显式提供 `--thread`，则 `targetThreadId = --thread`，`handoffId` 仍放在 `evolclaw.handoff_id`。
- 对端不理解 `evolclaw` 字段也没关系。

### 6.3 工具返回

`ec msg send` 返回结果必须包含 `contextRef`，让原会话知道如何主动查阅。

纯文本输出也应包含简短提示：

```text
✓ 已发送 msg_abc
ContextRef: handoff_20260701_abc123
查阅: ec ctx read handoff_20260701_abc123
```

## 7. 入站匹配流程

当目标对端回复本端时，AUN 入站处理在进入 ResponseEngine 前或渲染前执行 handoff 匹配。

匹配优先级：

1. **metadata 精确匹配**：`payload.evolclaw.handoff_id` 命中。
2. **thread 精确匹配**：`payload.thread_id == handoff.targetThreadId`。
3. **引用精确匹配**：`payload.ref_message_id` 命中某个 handoff 的 outbound `msgId`。
4. **唯一 pending 降级匹配**：同一 target 只有一个 `waiting` handoff，且回复在 TTL 时间窗内。
5. **无法判定**：同一 target 多个 pending，且无 thread/ref/metadata，标记为 `ambiguous`，不自动归属。

匹配成功后：

- 把 inbound 消息追加到 handoff canonical record。
- handoff 状态从 `waiting` 变为 `answered`。
- 记录匹配策略和置信度。
- 如果 `injection.pendingOutboundContext == true`，把 outbound context 注入目标会话本轮 prompt，并将其置为已消费。

## 8. 目标会话补上下文

目标会话收到对端回复时，需要补上此前本端通过 `ec msg send` 发出的内容。

渲染形式建议是一个特殊 SubMessage，排在对端当前回复之前：

```text
‹handoff·本端此前跨会话发给该对端·2026-07-01 00:10:00 +08:00›
请确认这个接口设计是否合理

‹对端当前回复›
我看了，整体可行，但需要注意...
```

关键规则：

- 只注入当前 handoff 的 outbound，不注入整个 target peer 历史。
- 同一 outbound context 只注入一次。
- 如果同一个 handoff 内有多条 outbound，按发送时间排序注入。
- 注入失败时要有兜底：至少把 outbound 作为纯文本前缀拼到 prompt，不能静默丢失。

## 9. 原会话主动查阅

新增命令集建议命名为 `ec ctx`。

### 9.1 `ec ctx read`

```bash
ec ctx read <handoffId>
ec ctx read <handoffId> --format json
```

返回这次 handoff 的上下文：

- outbound 消息
- inbound 回复
- state
- targetPeerKey
- match 策略
- 是否 ambiguous

### 9.2 `ec ctx list`

```bash
ec ctx list --origin current
ec ctx list --state waiting
ec ctx list --target botX.agentid.pub
```

托管会话内，`--origin current` 根据 `EVOLCLAW_SESSION_ID` 列出当前会话创建的 handoff。

### 9.3 `ec ctx close`

```bash
ec ctx close <handoffId>
```

关闭 handoff，后续不再自动匹配或注入。

### 9.4 可选：`ec ctx wait`

```bash
ec ctx wait <handoffId> --timeout 60s
```

用于原会话主动等待目标回复。它仍然是显式工具调用，不是系统自动回流。

## 10. 防串话设计

问题场景：

```text
peer A -> 本端 agent：去问 botX 问题 A
peer B -> 本端 agent：去问 botX 问题 B
```

如果只按 `botX` 建会话，两条任务会混在同一个 target peer 历史里。

解决原则：

1. 每次跨会话 `msg send` 生成独立 `handoffId`。
2. AUN `thread_id` 默认使用 `handoffId`。
3. 原会话查询必须按 `handoffId`，不能只按 target peer。
4. 多个 pending handoff 指向同一 target 时，没有 thread/ref 的入站消息不得自动归属。
5. ambiguous 状态必须显式暴露给查询者或 owner，不能静默猜测。

这样即使 A、B 都联系 `botX`，也会形成两个独立 handoff：

```text
handoff_A -> target botX -> thread handoff_A
handoff_B -> target botX -> thread handoff_B
```

## 11. 权限与可见性

`ec ctx read <handoffId>` 不能变成跨用户读取任意会话的后门。

建议规则：

- 托管会话内默认只能读取 `originSessionId == EVOLCLAW_SESSION_ID` 的 handoff。
- owner/admin 可以通过显式参数读取其它 handoff。
- handoff record 里保存 `requesterPeerKey`，用于审计和权限判断。
- 输出给 baseagent 的内容应只包含该 handoff 的消息，不默认暴露 target peer 全量历史。

## 12. 过期与清理

建议默认策略：

- `waiting` handoff 默认 TTL：24 小时或配置项。
- `answered` handoff 保留：7 天或按消息日志保留策略。
- `closed` handoff 可归档，只保留指针和摘要。
- cleanup 只清 handoff 状态文件，不删除 `messages.jsonl` 审计事实。

## 13. 与现有机制的关系

### 13.1 `messages.jsonl`

`messages.jsonl` 继续作为事实源和审计日志。handoff 不替代它，只增加跨会话索引和状态。

### 13.2 AUN quote/ref

AUN `quote` 入站目前会把引用正文渲染成 blockquote 插入输入正文。该能力可作为增强，但不作为 handoff 主路径。

主路径依赖本端 handoff store；远端是否配合引用不影响基本可用性。

### 13.3 observer pending-hints

`pending-hints` 是 owner 给目标会话预埋提示；handoff pending context 是系统给目标会话补充“本端此前跨会话发出的消息”。

两者都属于“下一条对端消息到来时注入”的模式，但权限、来源、生命周期不同，不建议复用同一个文件格式。

## 14. 实施计划

### Phase 1：Handoff Store 与 CLI

- 新增 handoff record 读写模块。
- 新增 `ec ctx read/list/close`。
- `ec msg send` 在托管会话内创建 handoff，并返回 `contextRef`。
- 写入 `pending-handoffs.jsonl` 目标索引。

### Phase 2：AUN 入站匹配

- AUN 入站解析 `payload.thread_id`、`payload.ref_message_id`、`payload.evolclaw.handoff_id`。
- 按匹配优先级更新 handoff record。
- 多 pending 且无法判断时标记 `ambiguous`。

### Phase 3：目标会话上下文注入

- ResponseEngine 在渲染前消费匹配 handoff 的 pending outbound context。
- 包装为特殊 SubMessage。
- 消费后标记 `injection.injectedAt`，避免重复注入。

### Phase 4：测试与防回归

测试场景至少覆盖：

- 单 handoff：`msg send` 后目标回复，目标会话 prompt 包含 outbound context。
- 两个 origin peer 同时联系同一 target，带不同 `thread_id`，不串。
- 两个 origin peer 同时联系同一 target，但目标回复无 thread/ref，标记 ambiguous。
- 原会话通过 `ec ctx read` 查到 outbound/inbound。
- `ec ctx read` 在非 origin session 下被拒绝，owner/admin 例外。
- handoff context 只注入一次。

## 15. 待确认的小决策

以下不是设计阻塞项，落地前确认即可：

1. 命令名使用 `ec ctx` 还是 `ec handoff`。
2. 托管会话内 `ec msg send` 是否默认启用 handoff，还是要求显式 `--handoff`。
3. `thread_id = handoffId` 是否对所有 AUN P2P 默认启用，还是仅对 agent target 默认启用。
4. handoff record 放 `data/handoffs/`，还是完全放在 `sessions/aun/<self>/<target>/handoffs/` 下。

当前推荐：

- 命令名：`ec ctx`。
- 托管会话内默认启用 handoff，提供 `--no-handoff` 关闭。
- AUN P2P 默认 `thread_id = handoffId`，用户显式传 `--thread` 时尊重用户线程。
- canonical record 放 `data/handoffs/<selfAID>/`，target chatDir 只放轻量索引。
