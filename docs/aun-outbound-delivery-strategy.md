# AUN 出站消息投递策略统一方案

**Status**: Proposed / 可行性已收口
**Date**: 2026-06-11
**Scope**: AUN channel 出站发送策略、outbox 可靠投递、结构化内容消息与过程事件分层

---

## 背景

当前 AUN 出站发送路径按实现形态分散：

- `sendMessage()` 只发送文本，并且会先写入 outbox，具备断线排队和重连补投能力。
- `sendFile()` 发送文件，也会写入 outbox。
- `sendStructured()` 发送任意结构化 payload，例如图片、thought、action card，但不进 outbox，失败只记录日志并返回 `null`。
- `sendProcessingStatus()` / `sendThought()` / `sendCustomPayload()` 直接发送，不参与可靠投递。

这导致可靠性边界由“是不是文本/文件”决定，而不是由“这条消息是否应该可靠送达”决定。图片、卡片等用户可见内容目前走 `sendStructured()`，不具备可靠补投；而 interaction 的 fallback 文本和卡片失败提示走 `sendMessage()`，反而具备可靠补投。这个边界不符合产品语义。

---

## 收口结论

优化方向可行，建议实施。

核心原则：AUN 出站消息按语义分为两类，而不是按 payload 是否结构化分流。

1. **内容消息**：用户需要看到、应进入消息历史、丢失会影响理解，走 durable / reliable。
2. **过程事件**：用于实时过程展示或状态同步，丢失不影响最终结果，走 ephemeral / best-effort。

---

## 消息分类

### 内容消息：durable / reliable

内容消息必须尽力可靠投递。

| Payload kind / 类型 | 示例 | 投递策略 |
|---|---|---|
| `result.text` | 最终回复、主动文本发送 | durable |
| `result.file` | SEND_FILE 生成文件、跨通道文件发送 | durable |
| `result.image` | 图片输出 | durable |
| `result.error` | 任务最终失败说明 | durable |
| `command.result` | 命令成功回显 | durable |
| `command.error` | 命令失败回显 | durable |
| `system.notice` | 欢迎、重启完成、健康通知 | durable |
| `system.error` | 权限、通道不可用、文件不存在、系统失败说明 | durable |
| `interaction` / `action_card` | 权限审批、确认卡片、命令卡片 | durable |
| interaction fallback text | 不支持卡片时的文本降级 | durable |
| 交互卡片失败提示 | 仅发起者可操作、卡片失效、处理器未就绪 | durable |
| 其他用户可见结构化内容 | 后续新增内容 payload | durable |

处理规则：

- 先写 outbox，再尝试立即发送。
- 未连接时只入队并触发重连。
- 发送失败时保留 outbox entry，后续 drain 重试。
- outbox drain 在连接恢复时立即执行，并按周期补投。
- `message_id` 缺失视为失败，不能删除 outbox。
- E2EE 失败允许明文 fallback；fallback 也失败则保留 outbox。
- 成功后统一写出站消息历史、stats、observer forward。

### 过程事件：ephemeral / best-effort

过程事件只做尽力投递。

| Payload kind / 类型 | 示例 | 投递策略 |
|---|---|---|
| `activity.batch` / `thought` | thinking、tool_call、tool_result、progress、notice、summary | ephemeral |
| `status.queued` | 任务排队状态 | ephemeral |
| `status.started` | 任务开始 | ephemeral |
| `status.progress` | 任务进度 | ephemeral |
| `status.completed` | 任务完成状态 | ephemeral |
| `status.interrupted` | 任务中断状态 | ephemeral |
| `status.error` | 任务状态机进入 error | ephemeral |
| `status.timeout` | 任务超时状态 | ephemeral |
| typing / heartbeat / runtime event | 临时状态 | ephemeral |

处理规则：

- 不进入 outbox。
- 失败只记录 debug/warn，不阻塞主流程。
- 可做 E2EE 明文 fallback，但不做长期重试。
- 重连后不补发旧状态，避免刷屏或状态倒灌。

### Error 边界

错误类消息按“是否给用户解释结果”区分：

- `result.error`：内容消息，durable。表示任务最终失败，需要让用户看到。
- `system.error`：内容消息，durable。表示系统/权限/通道/文件等用户必须感知的问题。
- `command.error`：内容消息，durable。表示命令执行失败。
- `status.error`：过程事件，ephemeral。只表达状态机进入错误状态，供 UI 或客户端状态同步。

---

## 接口收敛方案

新增统一底层发送入口：

```typescript
type DeliveryMode = 'durable' | 'ephemeral';

interface SendPayloadOptions {
  delivery: DeliveryMode;
  contentKind: 'text' | 'file' | 'image' | 'card' | 'thought' | 'status' | 'custom';
  context?: ReplyContext;
  postSend?: PostSendAction;
}

async function sendPayload(
  channelId: string,
  payload: Record<string, any>,
  options: SendPayloadOptions,
): Promise<{ messageId?: string; queued?: boolean }>;
```

现有方法收敛为薄封装：

- `sendMessage()` 改为 `sendText(..., { delivery: 'durable' })`，或保留名称但语义标注为文本 durable。
- `sendFile()` 改为构建 `type: 'file'` payload 后走 durable。
- `sendStructured()` 不再天然 best-effort，必须显式传入 `delivery`，或拆成 `sendContentPayload()` / `sendEphemeralPayload()`。
- `sendThought()`、`sendProcessingStatus()` 继续走 ephemeral。
- `result.image`、`interaction` 卡片改走 durable。

推荐最终结构：

```text
adapter.send(envelope, payload)
  -> classifyDelivery(payload.kind)
  -> buildAunPayload(payload, envelope)
  -> sendPayload(channelId, aunPayload, { delivery, contentKind, context, postSend })
```

---

## Outbox 调整

当前 outbox entry 只支持 `text` / `file` 两类。需要扩展为通用 payload entry。

建议结构：

```typescript
interface OutboxEntry {
  id: string;
  ts: number;
  aid: string;
  channelId: string;
  delivery: 'durable';
  contentKind: 'text' | 'file' | 'image' | 'card' | 'custom';
  payload: Record<string, any>;
  context?: ReplyContext;
  ttl: number;
  attempts?: number;
  lastError?: string;
  postSend?: PostSendAction;
}
```

保留现有能力：

- 每 AID 上限 20 条。
- 默认 TTL 5 分钟。
- 连接恢复和 30 秒定时器 drain。

建议增强：

- 记录 `attempts` 和 `lastError`，便于排查。
- 未来可增加指数退避和错误分类。
- 对永久失败错误可直接丢弃并写日志，避免无意义重试。

---

## 卡片处理

卡片是唯一需要额外设计的 durable 内容消息，因为交互回调依赖发送成功后的 `message_id`：

- 当前立即发送成功后，用 `message_id` 注册 `cardMessageIdMap`。
- 如果断线时卡片进入 outbox，则当下没有 `message_id`，不能立即注册映射。

可行方案：outbox entry 携带 `postSend` 元数据，在立即发送或 drain 成功后执行。

```typescript
type PostSendAction =
  | {
      type: 'register_interaction_card';
      requestId: string;
      isCommandCard: boolean;
      initiatorAid?: string;
      expiresAt: number;
    };
```

发送成功后：

```typescript
if (entry.postSend?.type === 'register_interaction_card' && messageId) {
  cardMessageIdMap.set(messageId, {
    requestId: entry.postSend.requestId,
    isCommandCard: entry.postSend.isCommandCard,
    initiatorAid: entry.postSend.initiatorAid,
  });
}
```

第二阶段可选增强：持久化 card callback map，解决 daemon 重启后“卡片已发出但映射丢失”的问题。该增强不阻塞本轮发送策略统一。

---

## 成功判定

durable 内容消息必须严格判定发送成功：

- 私聊 `message.send` 必须返回 `message_id`。
- 群聊 `group.send` 必须返回 `message.message_id` 或 `message_id`；若返回 `message_dispatch.status` 为 `debounced` / `dispatched`，需明确服务端语义后再决定是否视为成功。
- 缺少 `message_id` 时不能删除 outbox。
- RPC 成功但没有可追踪消息 ID，应记录 warn 并视为失败或 pending。

当前“返回无 `message_id` 仍视为成功”的行为需要修复。

---

## 非目标

本方案不要求：

- 过程事件可靠补投。
- 重连后补发历史 thought/status。
- 立即实现全量幂等协议。
- 立即持久化 interaction callback map。
- 改变非 AUN 渠道的发送模型。

---

## 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| 重复发送 | RPC 超时但服务端已落库，outbox 后续补投可能重复 | 后续增加 client message id / idempotency key |
| 卡片映射丢失 | 卡片发送成功后 daemon 重启，callback map 丢失 | 第二阶段持久化 card map |
| 旧状态刷屏 | thought/status 若进入 outbox，重连后会补发过期状态 | 明确归为 ephemeral，不进 outbox |
| outbox 膨胀 | 图片 base64 直接入队可能较大 | 控制大小；必要时图片先走 storage attachment，再入队引用 |
| 永久失败反复重试 | 权限/参数错误不会靠重试恢复 | 后续按错误码分类，永久失败直接落日志并移除 |

---

## 实施步骤

1. 扩展 outbox entry，支持通用 `payload`、`contentKind`、`postSend`。
2. 抽出 `sendPayload()` / `deliverPayloadEntry()`，统一私聊/群聊、E2EE fallback、成功判定。
3. 将 `sendMessage()` 和 `sendFile()` 迁移为 durable wrapper。
4. 将 `result.image` 改为 durable 内容消息。
5. 将 `interaction` action card 改为 durable 内容消息，并通过 `postSend` 注册 `cardMessageIdMap`。
6. 保持 `activity.batch`、`thought.put`、`status.*` 为 ephemeral。
7. 修复 `message_id` 缺失仍删除 outbox 的问题。
8. 补充日志：入队、立即发送、drain 成功、drain 失败、过期丢弃、postSend 执行。

---

## 测试清单

- durable 文本：断线时入队，重连后补投并删除。
- durable 文件：断线时入队，重连后补投并删除。
- durable 图片：断线时入队，重连后补投并删除。
- durable 卡片：断线时入队，重连后发送成功并注册 `cardMessageIdMap`。
- `result.error` / `system.error` / `command.error` 入 durable outbox。
- `status.error` 不入 outbox。
- `activity.batch` / `thought` 不入 outbox。
- E2EE 失败时明文 fallback；fallback 失败时保留 outbox。
- `message.send` 返回缺少 `message_id` 时保留 outbox。
- outbox TTL 过期后丢弃并记录日志。

---

## 最终判断

方案可行，且边界已经明确：

- 内容消息走 durable：文本、文件、图片、卡片、用户可见错误和通知。
- 过程事件走 ephemeral：thought、status、typing、临时 runtime event。
- `result.error`、`system.error`、`command.error` 是内容消息。
- `status.error` 是过程事件。

这能消除当前“文本/文件可靠、结构化消息不可靠”的实现偶然性，让可靠性由消息语义决定。
