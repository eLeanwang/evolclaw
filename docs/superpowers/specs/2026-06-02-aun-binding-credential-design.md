# AUN 绑定凭证消息 — 设计文档

**日期**：2026-06-02
**状态**：已确认，待转入实现计划

## 背景与目标

evolclaw 在 AUN 渠道上绑定 owner 后，需要主动给 owner AID 发送一条**结构化的绑定凭证消息**。owner AID 由我们自研的 Evol 前端 App 持有，App 内置 AUN SDK，收到这条消息后识别并保存到 App 本地台账（用于建立"我拥有哪些 agent"的视图），而不是当作普通聊天消息渲染。

因为接收端（Evol App）由我们自己控制，协议两端可改，所以采用最轻量的方案：复用现有 `message.send` 通道，靠 payload 里的 `type` 字段路由，不新增 RPC 方法或命名空间。

## 消息协议

通过现有的 AUN `message.send` RPC 发送，payload 为带类型标记的 JSON 对象：

```json
{
  "type": "binding",
  "aid": "llagent2.agentid.pub",
  "name": "张三的Evol助手 (llagent2)",
  "owner": "molian.agentid.pub",
  "baseagent": "claude"
}
```

字段说明：

| 字段 | 来源 | 说明 |
|---|---|---|
| `type` | 固定 `"binding"` | App 端按此字段识别消息种类 |
| `aid` | `this.config.aid` | 本 agent 的 AID |
| `name` | agent.md 的 display name（同 welcome 逻辑） | agent 显示名 |
| `owner` | 绑定的 owner AID | owner 标识 |
| `baseagent` | `EvolAgent.baseagent`（`active_baseagent \|\| 'claude'`） | 当前活跃 baseagent |

发送参数与 welcome message 一致：`encrypt: true`，建议 `persist_required: true`（保证 App 离线时可通过 pull 补收）。

**App 端约定**：收到普通消息时检查 `payload.type === 'binding'`，命中则按 `aid` 做 **upsert**（幂等写入本地台账），不渲染为聊天消息；否则照常显示。

## 触发时机

owner 在 AUN 渠道有三个绑定场景，现有代码已把它们收口到两个位置，凭证发送复用这两个位置即可，不新增触发点：

| 场景 | 现有代码路径 | 凭证发送位置 |
|---|---|---|
| 首次连接时 config.json 已配 owner | `sendWelcomeMessage()`（aun.ts:765） | 触发点 A |
| 首条消息时 auto-bind | `autoBindOwner()` → 发布 `channel:owner-bound` 事件 → aun.ts 订阅 handler（aun.ts:1700-1714） | 触发点 B |
| owner 变更 | 同上，`channel:owner-bound` 事件 | 触发点 B |

- **触发点 A**：`sendWelcomeMessage()` 内，发完欢迎语后调用 `sendBindingCredential(owner)`。
- **触发点 B**：`channel:owner-bound` 事件 handler 内，重试 welcome 之后调用 `sendBindingCredential(owner)`。

## 不做防重发

明确**不**引入 `lastBoundOwner` 之类的防重字段。理由：

1. 两个触发点天然近似只发一次：
   - 触发点 A 被 config.json 的 `initialized` 标志挡住，一个 agent 生命周期只进一次。
   - 触发点 B 的 `channel:owner-bound` 事件仅在 `autoBindOwner()` 中 `currentOwner === undefined` 时 publish（message-bridge.ts:417），owner 绑定后不再触发。
2. 凭证是幂等的：App 端按 `aid` upsert，重复收到覆盖的是同一条记录，无副作用。

防重职责下沉到 App 的 upsert，服务端保持简单。

## 改动面

- **src/channels/aun.ts**：
  - 新增方法 `sendBindingCredential(owner: string)`（约 20 行）：构造上述 payload，调 `callAndTrace('message.send', ...)` 发送。name 复用 `sendWelcomeMessage()` 中推导 display name 的逻辑（可抽小函数或就近复用）。baseagent 从对应 EvolAgent 实例读取。
  - 触发点 A：`sendWelcomeMessage()` 发完欢迎语后调用。
  - 触发点 B：`channel:owner-bound` 事件 handler 内调用。
- **Evol 前端 App**（独立仓库）：在 AUN 消息接收处增加 `payload.type === 'binding'` 分支，做本地台账 upsert。本设计文档只约定协议，App 实现不在本仓库范围内。

**不涉及**：消息队列、command-handler、session-manager、message-processor 均无改动。

## 错误处理

- 发送失败仅记 warn 日志，不阻塞连接/欢迎流程（与现有 `sendWelcomeMessage` 的 try/catch 风格一致）。
- 发送前检查 `this.client` 存在且已连接，断开则跳过（事件路径下次绑定/重连会再次进入）。

## 测试

- 单元测试：`sendBindingCredential` 构造的 payload 字段正确（type/aid/name/owner/baseagent）。
- 单元测试：两个触发点都会调用 `sendBindingCredential`（mock `message.send`，断言被调用且参数正确）。
- 边界：client 未连接时不抛错、跳过发送。
