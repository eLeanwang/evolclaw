# 观察者转发（observer.forward）格式变更

> 版本：v0.2
> 面向：前端开发人员（Evol App）、owner 侧消费方
> 最后更新：2026-06-10
> 相关代码：`src/channels/aun.ts` → `forwardInbound` / `forwardOutbound` / `emitForward`

---

## 1. 变更摘要

观察者转发（`observer.forward`）的 `original` 字段由「**手工拆解 + 重组**」改为「**SDK 原始对象原样透传**」。

核心原则：**SDK 给到应用层什么对象，就原样转发什么**，不挑字段、不改字段、不重新拼装。这样 AUN SDK 升级（例如往信封里增删字段）时，转发逻辑零改动，owner 侧自动拿到 SDK 的全部字段。

| | 旧（v0.1） | 新（v0.2） |
|---|---|---|
| `original` 来源 | 手工组装的扁平对象 | SDK 原始对象原样透传 |
| 路由字段位置 | `original.from` / `original.to`（扁平） | `original.envelope.from` / `original.envelope.to`（信封内） |
| `timestamp` | `Date.now()`（转发时刻） | SDK 原始消息时间戳（`original.envelope.timestamp`） |
| `message_id` | ❌ 不带 | ✅ 入站带 `original.message_id` |
| `encrypted` | ❌ 不带 | ✅ `original.envelope.encrypted` |
| `type` / `kind` / `version` | ❌ 不带 | ✅ `original.envelope.*` |
| `protected_headers` / `context` | ❌ 不带 | ✅ `original.envelope.*`（若 SDK 提供） |
| SDK 新增字段 | 需改转发代码 | 自动透传，无需改代码 |

---

## 2. 转发消息整体结构

外层信封不变：`from` = Agent AID，`to` = Owner AID，`payload.type = "observer.forward"`。

```jsonc
{
  "from": "my-agent.agentid.pub",   // Agent AID
  "to":   "owner-aid.agentid.pub",  // Owner AID
  "payload": {
    "type": "observer.forward",
    "direction": "inbound",          // "inbound" | "outbound"
    "agent_aid": "my-agent.agentid.pub",  // 归属 Agent，所有方向恒为此 Agent，前端按此分组
    "original": { /* SDK 原始对象，见下文 */ }
  }
}
```

> `agent_aid` 对入站/出站、私聊/群聊**所有方向恒为该 Agent 的 AID**，前端直接按它分组，不要用 `original.envelope.to`（出站时它是对端/群 ID）。

---

## 3. `original` 字段（按方向）

`original` 现在是 SDK 原始对象，路由元数据集中在 `original.envelope.*`，业务正文在 `original.payload`。

### 3.1 入站（direction = "inbound"）

`original` = SDK `message.received` / `group.message_created` 回调的整个对象。

```jsonc
{
  "original": {
    "message_id": "msg_abc123",        // 原始消息 ID（顶层）
    "seq": 12345,                       // 序号（顶层）
    "same_device": false,               // 网络邻近性（顶层，可能不存在）
    "same_network": false,
    "same_egress_ip": false,
    "envelope": {                       // ← SDK 信封，路由元数据在此
      "from": "some-peer.agentid.pub",  // 原始发送者
      "to":   "my-agent.agentid.pub",   // 原始接收者（私聊）
      "group_id": "group.xxx/yyy",      // 群聊时存在
      "type": "text",
      "kind": "...",                    // 可能不存在
      "version": "...",                 // 可能不存在
      "timestamp": 1717500000000,       // 原始消息时间戳
      "encrypted": false,               // 原始消息是否 E2EE
      "context": { /* ... */ },         // 可能不存在
      "protected_headers": { /* ... */ }, // 可能不存在
      "payload_type": "..."             // 可能不存在
    },
    "payload": {                        // 业务正文（已解密明文）
      "type": "text",
      "text": "你好，帮我查一下..."
    }
  }
}
```

### 3.2 出站（direction = "outbound"）

`original` = SDK `message.send` / `group.send` / `message.thought.put` / `group.thought.put` 的 `SendResult`（SDK 已 attach `envelope` + `payload`）。

```jsonc
{
  "original": {
    "ok": true,
    "message_id": "msg_def456",
    "seq": 12346,
    "timestamp": 1717500001000,
    "envelope": {                       // ← SDK 出站信封
      "from": "my-agent.agentid.pub",   // = 本 Agent
      "to":   "some-peer.agentid.pub",  // 对端（私聊）
      "group_id": "group.xxx/yyy",      // 群聊时存在
      "type": "text",
      "timestamp": 1717500001000,
      "encrypted": false
    },
    "payload": {                        // 实际发出的正文
      "type": "text",
      "text": "好的，结果是..."
    }
  }
}
```

> 出站信封字段（`sendResultEnvelope`）通常少于入站，无 `protected_headers` / `context` 等。以 SDK 实际返回为准——前端按字段存在性读取，不要假设字段一定存在。

---

## 4. 前端解析指引

收到 `payload.type === "observer.forward"` 后：

1. **按 Agent 分组**：用 `payload.agent_aid`（恒为归属 Agent）。
2. **判方向**：用 `payload.direction`（`inbound` / `outbound`）。
3. **取对端**：
   - 入站对端 = `original.envelope.from`
   - 出站对端 = `original.envelope.to`
   - 群聊 = `original.envelope.group_id`（存在即群聊；私聊看 `to`）
4. **取正文**：`original.payload`（已是明文）。
5. **取时间戳**：`original.envelope.timestamp`（原始消息时间，非转发时刻）。
6. **取消息 ID**：`original.message_id`。
7. **话题区分**：`original.payload.thread_id`（若存在）。

### 字段迁移对照（v0.1 → v0.2）

| v0.1 读取路径 | v0.2 读取路径 |
|---|---|
| `original.from` | `original.envelope.from` |
| `original.to` | `original.envelope.to` / `original.envelope.group_id` |
| `original.seq` | `original.seq`（入站）/ `original.envelope` 或顶层（出站，以 SDK 为准） |
| `original.timestamp` | `original.envelope.timestamp` |
| `original.payload` | `original.payload`（不变） |
| —（无） | `original.message_id`、`original.envelope.encrypted`、`original.envelope.type` 等新增可用 |

> **健壮性建议**：前端读取 `original.envelope.*` 时按字段可选处理（`?.`），因为 SDK 仅在源消息含该字段时才写入信封。这正是新格式的设计目的——SDK 加减字段，前端与转发逻辑都无需同步改动。

---

## 5. 加密策略（不变）

- `original.payload` 始终是**明文**（Agent 本地已解密）。
- `original.envelope.encrypted` 表示**原始消息**在 AUN 传输时是否 E2EE，仅供展示/审计，不影响 `payload` 可读性。
- 转发消息发给 owner 时的外层加密，由 **Agent ↔ Owner 的加密设定**独立决定，与原始消息加密状态无关。

---

## 6. owner 排除规则（不变）

- 入站：来源 owner 不回转给自己（`original.envelope.from === ownerAid` 时跳过该 owner），仍转给其他 owner。
- 出站：对端是 owner 时不转给该 owner（`original.envelope.to === ownerAid` 时跳过），仍转给其他 owner。
