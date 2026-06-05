# Debounce 与 ACK 延迟机制

## 背景

用户连续发送多条消息时，每条都会立即入队并触发中断，导致前一条处理被打断。参考 OpenClaw 的 `collect` 模式和入站 debounce 策略，EvolClaw 引入了两个机制：

1. **Debounce（入站去抖）**：窗口内多条消息合并为一次 agent 调用
2. **ACK 延迟**：确认标记（飞书 ✓）从"收到即确认"改为"开始处理时确认"

## Debounce 机制

### 设计

`InboundDebouncer`（`src/utils/inbound-debouncer.ts`）是一个独立的去抖工具类，不依赖任何 channel 或 core 模块。

```
用户发消息 A → debounce 窗口开始 (默认 2s)
用户发消息 B → 追加，timer 重置
用户发消息 C → 追加，timer 重置
         ... 2s 无新消息 ...
         → 合并为一条消息 → enqueue
```

### 合并策略

| 字段 | 策略 |
|:-----|:-----|
| content | `\n` 连接 |
| images | 合并所有 |
| mentions | 合并所有 |
| messageId, replyContext, peerId, peerName | 取最后一条 |

### 配置

`evolclaw.json` 中配置，单位为秒：

```json
{
  "debounce": 2
}
```

设为 `0` 关闭去抖，恢复立即入队行为。

### 命令不受影响

`/` 命令在 `MsgBridge.register` step 2 处理后直接 return，不经过 debounce 路径。

## ACK 延迟机制

### 变更前

```
消息到达 → Channel 层立即 ack (✓) → MsgBridge → debounce → enqueue → 处理
```

用户看到 ✓ 但消息可能还在 debounce 窗口中等待，语义不一致。

### 变更后

```
消息到达 → MsgBridge → debounce 窗口
                          ↓ (窗口结束)
                     adapter.acknowledge?(messageId) → ✓
                     messageQueue.enqueue → 处理
```

✓ 的语义变为"你的消息开始处理了"。debounce 窗口内用户看不到 ✓，暗示还可以继续补充内容。

### 实现

在 `MsgBridge.register` 的 `doEnqueue` 回调中先调 ack 再入队：

```typescript
const doEnqueue = async (m: Message) => {
  if (m.messageId) adapter?.acknowledge?.(m.messageId).catch(() => {});
  return messageQueue.enqueue(session.id, m, session.projectPath);
};
```

### 三层分离分析

| 层 | 职责 | 改动 |
|:---|:-----|:-----|
| **Channel 层** | 实现 `acknowledge` 方法（飞书: ✓ reaction；微信: typing） | `addAckReaction` 从 private 改为 public；adapter 补上 `acknowledge` |
| **Core 层 (MsgBridge)** | 编排 debounce → ack → enqueue 的时序 | `doEnqueue` 中调 `adapter?.acknowledge?.()` |
| **Utils 层 (InboundDebouncer)** | 纯去抖工具，不知道 channel 和 ack 的存在 | 无改动 |

**不违反三层分离原则**：
- debouncer 不依赖 channel adapter
- channel 不知道 debounce 的存在
- MsgBridge 作为胶水层负责编排时序

### 渠道能力差异处理

`ChannelAdapter.acknowledge?` 是可选方法：

- 飞书实现了 → 打 ✓ reaction
- 微信可实现 → 发 typing 指示器
- 其他 channel 未实现 → `?.` 跳过，无副作用

与 `sendFile?`、`onChatDissolved?` 等可选方法是同一模式。

## 改动文件清单

| 文件 | 改动 |
|:-----|:-----|
| `src/types.ts` | Config 新增 `debounce?: number` |
| `src/utils/inbound-debouncer.ts` | 新增：InboundDebouncer 类 |
| `src/index.ts` | MsgBridge 中集成 debouncer + ack 延迟 |
| `src/channels/feishu.ts` | 移除立即 ack；`addAckReaction` 改为 public；adapter 补上 `acknowledge` |
| `tests/unit/inbound-debouncer.test.ts` | 新增：13 个测试用例 |

## 与出站架构方案的关系

本改动属于**入站侧**优化，与 `docs/event-driven-outbound-plan.md` 及其修订方案（per-channel flushDelay、replyContext 泛化）正交，无冲突。
