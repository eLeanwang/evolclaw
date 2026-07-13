# Trigger 因果链与循环调用防护设计

> 状态：方案确认稿，待实施
>
> 日期：2026-07-12
>
> 首期范围：Trigger V4、内部 daemon/target session、AUN Agent-to-Agent 消息回流
>
> 不包含：飞书等其他消息渠道、ECK 调试开关、RPM 限流、`limits.maxRuns` 的重复实现

## 1. 问题

事件型 Trigger 当前只能利用 `originTriggerId` 阻止自己直接消费 `trigger:*` 生命周期事件，不能识别经过 AUN 消息回流形成的间接循环：

```text
task:error
  → Trigger A 执行诊断
  → A 通过 AUN 把反馈发给 Agent B
  → B 把反馈作为普通入站消息处理
  → B 处理失败并发布 task:error
  → A 再次执行
```

实际事故中，诊断反馈被发送给正在故障的 `evolai.agentid.pub`。目标 Agent 每次处理反馈都因模型协议不匹配而失败，再次产生 `task:error`。该循环持续约 5 小时 23 分钟，执行 18 次，平均约每 19 分钟一次。

这不是高 RPM 风暴。`limits.maxRuns` 只能限制生命周期累计执行次数，不能判断新的执行是否由同一 Trigger 的历史执行派生。

## 2. 设计结论

默认禁止同一个 Trigger 响应自己的后代事件：

```text
A → A       阻断
A → B → A   阻断
A → B → C   允许
独立事件 → A 允许
```

当前不提供允许递归的配置项：失败重试使用 `reliability.retry`，周期执行使用 `cron` 或 `interval`，生命周期次数使用 `limits.maxRuns`，工作流推进使用不同 Trigger 组成的无环链路。

## 3. 首期边界

因果链仅在以下自动执行链路传播：

```text
EventBus task/trigger event
  → Trigger Scheduler
  → daemon 或 target_session Message
  → ResponseEngine task event
  → Trigger direct feedback
  → AUN Agent-to-Agent 消息
  → 目标 Agent task event
  → Trigger Scheduler
```

首期不处理：

- 飞书、微信、钉钉、企业微信、QQ 等其他渠道；
- AUN 发给真人后由真人回复形成的新消息；
- 普通用户消息和不由 Trigger 派生的 Agent 消息；
- 任意 Agent 工具出站消息的全局追踪；
- 跨渠道统一签名协议。

发送给真人的 Trigger 反馈不需要携带可恢复的因果链，因为它不会自动启动另一个 Agent 任务。若未来其他渠道支持 Agent-to-Agent 自动回流，再按相同接口单独接入。

## 4. 因果数据

只保存判环必需的祖先列表，不保存可推导的根节点和深度：

```ts
export interface TriggerCausationNode {
  triggerId: string;
  runId: string;
}

export interface TriggerCausation {
  ancestors: TriggerCausationNode[];
}
```

首次执行 A：

```json
{
  "ancestors": [
    { "triggerId": "A", "runId": "run-a1" }
  ]
}
```

A 的后代事件触发 B：

```json
{
  "ancestors": [
    { "triggerId": "A", "runId": "run-a1" },
    { "triggerId": "B", "runId": "run-b1" }
  ]
}
```

该字段是系统控制元数据，不进入消息正文或模型 prompt。

## 5. 信任边界

可信来源只有：

1. Trigger Scheduler 创建或追加的因果链；
2. daemon/target session 创建的内部 `Message.triggerMeta`；
3. 本地 MessageQueue 保存的完整 `Message`；
4. EventBus 内部任务事件；
5. AUN 中由 EvolClaw Trigger feedback 发送、并由可信 Agent 身份接收的内部 metadata。

必须忽略用户正文、模型输出和普通 AUN payload 中自报的 `triggerCausation`。AUN 入站只在发送者身份和内部 metadata 均通过校验时恢复因果链；校验失败时按普通消息处理并记录告警。

首期优先覆盖同一 EvolClaw 实例托管 Agent 之间的 AUN 回流。跨实例 AUN 若现有协议不能证明 metadata 来源，则暂不信任，后续再增加签名或服务端受保护字段。

## 6. 传播与判环

### 6.1 Scheduler

Scheduler 收到事件时读取 `triggerCausation`：

1. 若当前 `triggerId` 已出现在 `ancestors`，阻断执行；
2. 否则生成当前 `runId`；
3. 没有因果链时创建根链；
4. 已有因果链时复制后追加 `{ triggerId, runId }`；
5. 将新链传给执行消息、反馈、审计和后续任务事件。

判环只比较 `triggerId`，不比较 `runId`：

```ts
function detectCausationCycle(
  triggerId: string,
  causation?: TriggerCausation,
): TriggerCausationNode | undefined {
  return causation?.ancestors.find(node => node.triggerId === triggerId);
}
```

### 6.2 Message 与队列

在 `Message.triggerMeta` 增加可选的 `triggerCausation`。现有 MessageQueue 已整体序列化 `Message`，因此该字段会随消息自动持久化，无需修改队列文件版本或另建持久化协议。

恢复时仅校验：

- `ancestors` 是数组；
- 每个节点具有非空 `triggerId` 和 `runId`；
- 数组不超过内部安全上限。

校验失败时丢弃因果字段并记录告警，不丢弃业务消息。

### 6.3 ResponseEngine

由 Trigger 派生的任务从 `message.triggerMeta.triggerCausation` 读取因果链，并附加到其发布的 `task:completed`、`task:error`、`task:interrupted` 及对应 `trigger:*` 事件。

不需要建立全局 `TaskRuntimeContext`，也不追踪普通任务的所有工具调用。

### 6.4 Feedback 与 AUN

`target_session` 和 daemon 创建的内部消息直接携带因果链。

Trigger direct feedback 仅在目标渠道为 AUN 且目标是 Agent 时携带内部因果 metadata。AUN 入站验证后将其恢复到 `Message.triggerMeta.triggerCausation`，使目标任务产生的后续事件仍保留来源。

发给真人的 AUN feedback 正常发送正文，但不要求接收侧恢复因果链。

## 7. 阻断行为

检测到因果环时：

1. 不启动 Trigger 真实 run；
2. 不递增 `limits.runCount`；
3. 写 `status=skipped`、`reason=causation_cycle` 的 Trigger audit；
4. 写一条包含祖先链的 `ERROR` 日志；
5. 不发送该 Trigger 的 feedback；
6. 不发布新的 `task:error` 或 `trigger:failed`；
7. 不自动停用 Trigger，使其仍能处理后续独立事件。

首期不新增 `trigger:cycle-detected` 事件。审计和错误日志已经满足观测需求，也避免引入新的事件消费面。

## 8. 兼容性

- 没有因果字段的既有事件和普通消息视为新的独立来源，行为不变；
- 旧持久化队列没有该字段，正常恢复；
- 当前 `originTriggerId` 防护保留，因果链负责识别跨任务和 AUN 回流；
- `retry`、`concurrency`、`maxRuns` 和 `maxDuration` 语义不变；
- cron、interval、once、delay 和 at Trigger 不受影响。

## 9. 实施位置

| 文件或模块 | 修改内容 |
|---|---|
| `src/trigger/types.ts`、`src/trigger/causation.ts` | 因果类型、校验、追加、判环和格式化 |
| `src/core/event-bus.ts` | 相关 task/trigger 事件增加可选 carrier |
| `src/trigger/scheduler.ts` | 创建、追加、判环及 skipped audit |
| `src/channels/daemon.ts`、`src/trigger/feedback.ts` | 内部执行消息及 AUN feedback 传播 |
| `src/types.ts` | 扩展 `Message.triggerMeta` |
| `src/core/message/response-engine.ts` | 任务结果事件继承因果链 |
| `src/channels/aun.ts` | AUN Agent-to-Agent 出站携带、入站验证和恢复 |

MessageQueue 无需专项修改；其现有序列化会保留新增字段，只需回归验证。

## 10. 测试

### 单元测试

1. 无因果链时创建 A 根链；
2. `A → B` 正确追加；
3. `A → A` 和 `A → B → A` 被阻断；
4. `A → B → C` 正常执行；
5. 同 Trigger 不同 run ID 仍判定为循环；
6. 无效、空节点或超长祖先列表被拒绝；
7. 用户正文中的同名 JSON 不会成为可信因果链。

### 集成测试

1. `task:error → A → AUN feedback 到 Agent → task:error` 在第二次进入 A 前阻断；
2. `A → B → A` 经 AUN 回流后阻断；
3. 两个独立 `task:error` 均可分别触发 A；
4. AUN feedback 到真人不改变原有消息行为；
5. 消息在队列中等待并重启后仍可恢复因果链；
6. 因果阻断不计入 `maxRuns`，也不产生新错误事件；
7. 非 AUN 渠道行为完全不变。

## 11. 验收标准

1. 同一 Trigger 不能由其 AUN Agent-to-Agent 后代消息再次触发；
2. 不同 Trigger 的无环级联正常执行；
3. 独立事件不会被历史执行误判；
4. 判环不依赖 RPM、时间、错误文本或累计次数；
5. AUN 回流和本地队列恢复不丢失因果链；
6. 外部用户不能通过正文伪造因果链；
7. 阻断在 audit 和 ERROR 日志中可追踪；
8. 其他消息渠道和现有 Trigger 限制语义保持不变。
