# 观察者模式（Observer Mode）

> 版本：v0.1  
> 面向：前端开发人员（Evol App）  
> 最后更新：2026-06-04

---

## 1. 概述

观察者模式允许 Agent 的 owner 以观察者视角查看其 Agent 与所有外部对端的消息往来，而无需切换登录为 Agent 身份。

### 1.1 目标

- Owner 可以在不切换身份的情况下，查看自己名下所有 Agent 的会话列表
- Owner 可以点进任意 Agent，看到该 Agent 与各对端的会话列表
- Owner 可以进一步点进任意会话，查看完整的消息记录

### 1.2 非目标

- 不允许 owner 以 Agent 身份回复消息（这是伪装，不是观察）
- 不引入新的通信协议或数据通道——所有消息走现有 AUN 网络

---

## 2. 前端交互流程

### 2.1 入口：会话列表页

在 Evol App 的会话列表页面，新增一个入口（例如「观察我的 Agent」按钮或底部 Tab icon）。

点击后进入「我的 Agent 列表」页面。

**触发逻辑**：前端无需主动拉取 Agent 列表——任何开启了观察者模式的 Agent，一旦收到/发出消息，就会转发给 owner。Owner 的会话列表中自然就会出现该 Agent 的条目。前端只需要根据收到的转发消息来构建 Agent 列表。

### 2.2 第一级：Agent 列表页

展示当前 owner 名下所有**已激活**（即已收到过转发消息）的 Agent 列表。

列表中每项显示 Agent 的基本信息：
- Agent 名称/AID
- 最近一条消息的时间
- 未读消息数

### 2.3 第二级：Agent 的对端会话列表

点击某个 Agent 后，展示该 Agent 与各对端的会话列表。

每项显示：
- 对端名称/ID
- 会话类型（私聊/群聊）
- 消息数量
- 消息类型分布（文本/图片/文件等）
- 最后活跃时间

### 2.4 第三级：消息详情页

点击某个对端会话后，展示该 Agent 与该对端的完整消息记录。

消息按时间线展示，每条显示：
- 时间戳
- 方向（in/out）
- 消息类型（text/image/file/command/thought）
- 消息内容
- 加密状态

---

## 3. 后端转发机制

### 3.1 Owner 识别

Owner 的来源是 Agent 的 `config.json` 中**顶层 `owners` 字段**（即 `agents/<aid>/config.json` 的 `owners` 数组），而非各 channel 内部的 owner 字段。

```json
{
  "$schema_version": 1,
  "aid": "my-agent.agentid.pub",
  "owners": [
    "toleiliang.agentid.pub"
  ],
  "admins": [],
  "channels": [...],
  ...
}
```

### 3.2 转发触发条件

当 Agent 的 `config.json` 中**开启了观察者模式开关**时，EvolClaw 对每条入站和出站消息都额外执行一次转发。

开关字段 `observable` 由 EvolClaw 后端读取。**不开启开关时，不发生任何转发**。

### 3.3 入站消息转发

Agent 收到消息 → 除了正常投递给 Agent 处理外 → **额外转发给 `owners` 列表中的每个 owner**。

```
入站:
  Peer → [AUN] → Agent
                    └─ 转发副本 → Owner₁
                    └─ 转发副本 → Owner₂
                    └─ ...
```

### 3.4 出站消息转发

Agent 发出消息 → 除了正常发给对端外 → **额外转发给 `owners` 列表中的每个 owner**。

```
出站:
  Agent → [AUN] → Peer
     └─ 转发副本 → Owner₁
     └─ 转发副本 → Owner₂
     └─ ...
```

### 3.5 转发消息的封装格式

转发消息采用**信封套信封**的封装方式：

- **外层信封**（新）：发给 owner，`from` = Agent AID，`to` = Owner AID
- **内层 Payload**：原始消息的「信封 + Payload」整体打包

```
转发消息 结构:

  from: <agent-aid>        // Agent 的 AID
  to:   <owner-aid>        // Owner 的 AID
  payload:
    type: "observer.forward"    // 标识这是观察者转发
    direction: "inbound"        // "inbound" | "outbound"
    agent_aid: <agent-aid>      // 归属 Agent 的 AID（所有方向恒为此 Agent，前端按此分组）
    original:                   // 原始消息（from/to/seq/timestamp/payload 平级）
      from: <peer-aid>          // 原始消息的发送者
      to:   <agent-aid>         // 原始消息的接收者
      seq: <seq>
      timestamp: <ms>
      payload: { ... }          // 原始消息的 Payload（原样保留）
```

结合现有 AUN 消息协议的 envelope 格式（`$AUN_PROTOCOL_DOCS`），最终发给 owner 的消息大致为：
```json
{
  "from": "my-agent.agentid.pub",
  "to": "owner-aid.agentid.pub",
  "payload": {
    "type": "observer.forward",
    "direction": "inbound",
    "agent_aid": "my-agent.agentid.pub",
    "original": {
      "from": "some-peer.agentid.pub",
      "to": "my-agent.agentid.pub",
      "seq": 12345,
      "timestamp": 1717500000000,
      "payload": {
        "type": "text",
        "text": "你好，帮我查一下..."
      }
    }
  }
}
```

> **前端解析指引**：前端收到 `payload.type === "observer.forward"` 的消息后，从 `payload.original` 中提取原始消息信息来构建会话列表和消息时间线。

### 3.6 加密策略

AUN 消息在传输过程中可能是 E2EE 密文，但 EvolClaw 在正常处理消息之前已经解密了——也就是说，Agent 本地拿到的始终是**明文内容**。

转发消息的加密遵循以下规则：

1. **Payload 内容是明文**：Agent 从本地明文拿到消息内容后，封装进 `observer.forward` Payload 中的 `original.payload` 字段——这部分是明文内容
2. **外层加密独立决定**：转发消息发给 owner 时是否加密，取决于 **Agent ↔ Owner 之间的通信加密设定**（即 owner 给该 Agent 设置的加密偏好），**与原始消息的加密状态无关**
3. 也就是说：
   - 原始消息可能是密文（Peer ↔ Agent），但 Agent 已经解密了，转发的是解密后的明文内容
   - 发给 owner 时，如果 Agent 和 owner 之间约定走密文，就重新加密后发出；约定走明文，就明文发出

**总结**：转发消息的加密和原始消息的加密是**完全独立的两层**——原始加密已被 Agent 解密，转发时按 Agent-Owner 自己的加密约定重新处理。

### 3.7 注意

- 转发消息中的 `original.payload` 是**解密后的明文内容**（Agent 解密后的），前端收到后自然可读
- 转发是纯附加行为，不影响原有消息路径

---

## 4. 开关控制

### 4.1 配置位置

Agent 的观察者模式开关存储在 `agents/<aid>/config.json` 中，作为顶层字段。

### 4.2 权限

只有 **owner** 有权开启/关闭观察者模式。前端应在 Agent 管理页面提供此开关，仅对 owner 可见和可操作。

### 4.3 操作方式

前端通过 **Menu Protocol** 或直接修改 `config.json`（通过 `ec agent set` 命令）来切换开关。

Menu Protocol 使用标准 `name: "observable"`；普通 Agent 通道自动作用于 owning Agent，ECWeb / 控制 AID 通道通过顶层 `agent: "<aid>"` 指定目标。

```jsonc
{ "type": "menu.query", "id": "q-observable", "name": "observable",
  "agent": "mybot.agentid.pub" }
{ "type": "menu.update", "id": "u-observable", "name": "observable",
  "agent": "mybot.agentid.pub", "value": "true" }
```

```bash
ec agent get <aid> observable        # 查询当前状态
ec agent set <aid> observable true   # 开启观察者模式
ec agent set <aid> observable false  # 关闭观察者模式
```

Slash 指令使用相同的布尔语义：`/observable` 查询，`/observable true` 开启，`/observable false` 关闭。

---

## 5. 前端数据组织

### 5.1 Agent 列表构建

前端根据收到的转发消息自动构建 Agent 列表：

```
消息来源：所有 payload.type === "observer.forward" 的消息
按 payload.agent_aid（归属 Agent 的 AID）分组 → Agent 列表
```

> `agent_aid` 对入站/出站、私聊/群聊**所有方向恒为该 Agent 的 AID**，前端直接按它分组，无需区分方向或场景（不要用 `original.to`——出站时它是对端/群 ID，不指向 Agent）。

不需要额外的 API 调用来获取 Agent 列表。

### 5.2 对端会话列表构建

选中某个 Agent 后，按转发消息中的 `original` 信封信息分组：

- 出站消息的对端取 `original.to`，入站消息的对端取 `original.from`
- 按 `original.payload.thread_id`（如果存在）区分话题
- 私聊按对端 AID 分组，群聊按群 ID 分组（群 ID 出现在出站的 `original.to` / 入站的群上下文中）
- 聚合统计：消息数、类型分布、时间范围等

### 5.3 完整消息记录

前端已持有所有转发的消息副本，直接按时间线渲染即可。无需再从 EvolClaw 拉取。

---

## 6. 变更清单（供后端参考）

以下为 EvolClaw 后端需要变更的内容，不在此文档详细展开，仅列清单：

| 变更点 | 状态 | 代码位置 | 说明 |
|--------|------|----------|------|
| `config.json` 新增字段 | ✅ 已实现 | — | 顶层 `observable: boolean`（默认 false / 缺失视为 false） |
| `AgentConfig` TypeScript 类型 | ✅ 已实现 | `src/types.ts` → `AgentConfig.observable?: boolean` | 类型定义 |
| 转发核心方法 | ✅ 已实现 | `src/channels/aun.ts` → `AUNChannel.forwardToOwners(direction, original)` | `loadAgent` 读 `observable`，false/缺失或 `owners[]` 为空时静默跳过；封装 `observer.forward`（含 `agent_aid`）；按 `shouldEncrypt(ownerAid)` 独立加密；`callAndTrace('message.send')` 发送，失败仅 debug log，不影响主流程 |
| 入站消息处理 | ✅ 已实现 | `src/channels/aun.ts` → `dispatchMessage()` 末尾 | `forwardToOwners('inbound', { from: peerId, to: agentAid, seq, payload })` |
| 出站消息处理 | ✅ 已实现 | `src/channels/aun.ts` → `deliverTextEntry()` 内 `group.send` 成功后（群聊）+ `message.send` 成功后（私聊） | `forwardToOwners('outbound', { from: agentAid, to: channelId/targetAid, payload })` |
| `agent_aid` 归属字段 | ✅ 已实现 | `src/channels/aun.ts` → `forwardToOwners()` 内 `forwardPayload` | 所有方向恒为本 agent AID，供前端分组（详见 §5.1） |
| `ec agent set/get` | ✅ 已实现（复用） | `src/cli/agent.ts` → `agentSet()` / `agentGet()` | 原有实现已接受任意 key，`ec agent set <aid> observable true` 直接可用，无需改动 |
| Menu Protocol | ✅ 已实现 | `src/core/command/menu-handler.ts` / `src/core/message/message-bridge.ts` | 标准 `name=observable` 支持 query/update；普通通道绑定 owning Agent，ECWeb/Control 用顶层 `agent` 路由；兼容 `cmd=/observable` |
| Slash / menu.list | ✅ 已实现 | `src/core/command/slash-handler.ts` / `src/core/command/menu-handler.ts` | `/observable [true\|false]`；仅普通 Agent 通道 owner 菜单可见 |

> **实现版本**：v3.1.7 开发分支（2026-06-04）。构建通过零 TS 错误。

---

## 7. 后续扩展（非本期）

- 观察者模式下支持 owner 查看 Agent 的 processing（处理中）状态
- 支持 owner 以只读方式查看 Agent 的 CC 会话 transcript
- 观察者权限分级（admin vs owner 的观察范围差异）
