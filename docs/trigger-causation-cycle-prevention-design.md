# 因果链与 Trigger 循环调用防护设计

> 状态：已实施
>
> 日期：2026-07-14
>
> 能力范围：跨消息、跨任务、跨会话、审批授权追踪，以及 Trigger 循环调用防护
>
> 渠道范围：内部消息链路与 AUN；飞书等其他渠道适配器首期不改
>
> 不包含：ECK 调试开关、RPM 限流、`limits.maxRuns` 的重复实现

## 1. 背景

当前系统已经存在多种局部关联 ID：

- 消息使用 `messageId`；
- 任务使用 `taskId` 和 `sessionId`；
- 跨会话沟通使用 `handoffId`；
- 审批使用 `requestId`、`challengeId` 和 `grantId`；
- Trigger 使用 `triggerId` 和 `runId`。

这些 ID 可以标识各自领域中的同一件事，但不能统一回答：一条跨会话消息由哪个原始请求产生、一次审批为何发起、批准结果被哪个任务消费，以及一次错误是否由某个 Trigger 自己的后代消息再次触发。

实际事故中的递归链为：

```text
task:error
  → Trigger A 执行诊断
  → A 通过 AUN 把反馈发给故障 Agent B
  → B 把反馈作为普通入站消息处理
  → B 处理失败并发布 task:error
  → A 再次执行
```

该循环持续约 5 小时 23 分钟，执行 18 次，平均约每 19 分钟一次。它不是高 RPM 风暴，`limits.maxRuns` 也只能限制生命周期累计次数，不能判断后一次执行是不是前一次执行的因果后代。

## 2. 设计结论

采用两层设计：

1. **通用因果上下文**：使用固定大小的父指针，追踪跨消息、跨任务、跨会话和审批流程；
2. **Trigger 判环扩展**：携带有界的 Trigger 执行路径，用于在执行前可靠判断 `A → A`、`A → B → A`。

```text
CausationContext
  ├─ traceId / spanId / parentSpanId：通用追踪
  └─ trigger.path：Trigger 专用实时判环
```

完整历史不复制进每条消息，而是作为独立 span 审计记录持久化，通过 `traceId` 和 `parentSpanId` 重建。

## 3. 目标与边界

### 3.1 目标

1. 从任意任务追溯到原始消息和直接原因；
2. 串联跨会话请求、目标任务、回复及原会话恢复；
3. 串联审批申请、审批决定、授权凭证和最终消费；
4. 精确阻断同一 Trigger 响应自己的后代事件；
5. 单条消息携带的通用因果信息保持固定大小；
6. 保持现有业务 ID 和权限校验语义不变。

### 3.2 首期传播边界

通用因果上下文在 EvolClaw 内部的 Message、Task、EventBus、handoff、permission 和 Trigger 之间传播。跨消息渠道传播首期只接入 AUN：

- AUN Agent-to-Agent 自动消息；
- AUN owner 跨会话审批；
- AUN handoff 请求和返回；
- daemon 与 target session 内部消息。

飞书、微信、钉钉、企业微信、QQ 等渠道适配器首期不携带因果 metadata。来自这些渠道的入站消息仍可在 EvolClaw 内部创建新的 trace，但 trace 不通过这些渠道继续传播。

### 3.3 非目标

- 不根据错误文本、时间间隔或 RPM 猜测因果关系；
- 不用因果链替代 `handoffId`、`requestId`、`grantId`、`taskId` 等业务 ID；
- 不把因果关系作为权限凭证；
- 不追踪模型 prompt、正文、错误全文等大字段；
- 不建立一次覆盖所有外部渠道的签名协议。

## 4. 两层数据模型

### 4.1 通用因果上下文

每个可追踪节点称为一个 span。消息和运行时只携带当前 span 的固定大小指针：

```ts
export interface CausationContext {
  version: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  trigger?: TriggerCausationExtension;
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `traceId` | 一条完整业务因果链的稳定 ID |
| `spanId` | 当前消息、任务、审批或 Trigger 执行节点的 ID |
| `parentSpanId` | 当前节点的直接原因 |
| `trigger` | 仅存在于 Trigger 派生链路中的判环扩展 |

派生新动作时不修改父上下文，而是创建新的 `spanId`：

```ts
child.traceId = parent.traceId;
child.parentSpanId = parent.spanId;
child.spanId = createSpanId();
```

没有可信父上下文的独立入站消息创建新的 `traceId` 和根 `spanId`。定时任务、手工 Trigger run 等没有上游消息的动作也创建新 trace。

### 4.2 Trigger 判环扩展

通用父指针适合追踪，但实时判环若每次都回查完整审计链，会增加存储依赖和故障面。因此 Trigger 链路额外携带一个有界路径：

```ts
export interface TriggerCausationNode {
  triggerId: string;
  runId: string;
}

export interface TriggerCausationExtension {
  path: TriggerCausationNode[];
}
```

首次执行 A：

```json
{
  "path": [
    { "triggerId": "A", "runId": "run-a1" }
  ]
}
```

A 的后代事件触发 B：

```json
{
  "path": [
    { "triggerId": "A", "runId": "run-a1" },
    { "triggerId": "B", "runId": "run-b1" }
  ]
}
```

`path` 最多 16 个节点。追加第 17 个节点时以 `causation_depth_exceeded` 阻断并记录审计，避免 metadata 无界增长。该限制是系统安全边界，不是普通 Trigger 配置。

### 4.3 现有业务 ID 保留

通用因果 ID 只负责关联，现有 ID 继续承担领域语义：

| 领域 | 保留字段 | 用途 |
|---|---|---|
| 消息 | `messageId` | 投递、去重、回复引用 |
| 任务 | `taskId`、`sessionId` | 执行和会话生命周期 |
| Handoff | `handoffId` | 跨会话请求状态和返回绑定 |
| 审批 | `requestId`、`challengeId`、`grantId` | 防重放、决策和授权消费 |
| Trigger | `triggerId`、`runId` | 定义和单次执行 |

这些字段作为 span 审计记录的引用保存，不重复塞入 `CausationContext`。

## 5. Span 产生规则

| 动作 | span 类型 | 父节点 |
|---|---|---|
| 独立用户消息进入系统 | `message.inbound` | 无，创建新 trace |
| Agent 开始处理消息 | `task.run` | 入站消息 span |
| Agent 发起跨会话请求 | `handoff.request` | 当前 task span |
| 目标会话接收 handoff | `message.inbound` | handoff request 的出站消息 span |
| 目标 Agent 执行 | `task.run` | handoff message span |
| 目标回复原会话 | `handoff.response` | 目标 task span |
| 发起权限审批 | `permission.request` | 发起工具调用的 task span |
| owner 批准或拒绝 | `permission.decision` | permission request span |
| 授权被工具调用消费 | `permission.consume` | permission decision span |
| EventBus 派生 Trigger | `trigger.run` | 源事件当前 span |
| Trigger 产生任务或反馈 | `task.run` / `message.outbound` | trigger run span |

一个动作只选择一个主要父节点。需要表达合并输入时，额外关系以独立 link 审计记录逐条写入，不把父节点数组放进 carrier。

## 6. 审计与历史重建

每次创建 span 时写一条轻量审计记录：

```ts
export interface CausationSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  type:
    | 'message.inbound'
    | 'message.outbound'
    | 'task.run'
    | 'handoff.request'
    | 'handoff.response'
    | 'permission.request'
    | 'permission.decision'
    | 'permission.consume'
    | 'trigger.run';
  timestamp: number;
  status?: 'started' | 'completed' | 'failed' | 'skipped';
  refs?: {
    messageId?: string;
    taskId?: string;
    sessionId?: string;
    handoffId?: string;
    permissionRequestId?: string;
    grantId?: string;
    triggerId?: string;
    runId?: string;
  };
}
```

消息队列可能把同一会话的多条普通消息合并为一个任务。此时以最新消息 span 作为主要父节点，其他输入各写一条固定大小的 link 记录：

```ts
export interface CausationSpanLinkRecord {
  spanId: string;
  linkedTraceId: string;
  linkedSpanId: string;
  relation: 'batch_input';
  timestamp: number;
}
```

link 记录按输入逐条写入，不在一个字段内累积数组。查询链路时先沿 `parentSpanId` 重建主路径，需要查看合并输入时再读取 link 记录。

记录不包含正文、prompt、工具输入、审批详情或错误全文。完整链通过 `traceId` 查询同一 trace 的记录，再按 `parentSpanId` 重建。

因此即使一条 trace 经历一万个节点：

- 每条普通消息仍只携带 `traceId/spanId/parentSpanId`；
- Trigger 派生消息最多再携带 16 个 path 节点；
- 审计总量随节点数线性增长，但不会导致单条消息膨胀；
- 审计存储按现有日志策略每日归档并保留 7 天。

## 7. 传播规则

### 7.1 Message、Task 与 EventBus

`Message` 增加可选的 `causation?: CausationContext`，不放进 `triggerMeta`，因为它已是跨领域能力。

ResponseEngine 为没有可信上下文的入站消息创建根 span；处理任务创建子 span，并将上下文放入受控的任务运行时。任务发布的 `task:*`、`tool:*` 和由任务直接产生的内部事件继承或派生该上下文。

EventBus 事件增加可选 carrier，但业务事件类型和现有字段保持不变。

### 7.2 MessageQueue 与重启

现有 MessageQueue 会整体序列化 `Message`，新增字段会自然随消息持久化，不需要修改队列文件版本或另建队列协议。

恢复时校验 ID 格式、版本和 Trigger path 上限。因果字段损坏时丢弃该字段并记录告警，不丢弃业务消息。

队列合并遵循以下规则：

- 普通消息可以继续按现有规则合并；任务以最新消息作为主要父节点，其他输入写独立 `batch_input` link；
- 带 `trigger.path` 或 `triggerMeta` 的消息是合并屏障，不与前后消息合并；
- 现有 handoff 合并屏障继续保留；
- 不允许把不同 Trigger run 的 path 合并成一条路径。

Trigger 消息禁止合并不仅是追踪要求，也是正确性要求：合并后的单个 `triggerMeta` 无法同时代表多个 `runId`，并可能丢失用于判环的祖先路径。

### 7.3 Handoff

`TaskRuntimeContext` 增加当前因果上下文。`ec msg send` 创建 `handoff.request` 子 span，现有 `handoffId` 继续负责请求消费、返回绑定和状态机。

目标会话接收消息时恢复因果上下文，目标任务和返回消息继续派生新 span。无法恢复因果上下文时，handoff 功能仍按现有 `handoffId` 工作，只损失跨域追踪，不改变消息投递结果。

### 7.4 审批授权

权限请求创建 `permission.request` span，并将其与现有 `requestId/challengeId` 关联。owner 决策创建 `permission.decision` span；授权实际使用时创建 `permission.consume` span，并关联 `grantId` 和原工具任务。

审批回复不信任用户提交的因果 metadata。系统根据受控的 pending request、卡片 message ID 和 `requestId` 恢复父 span。

### 7.5 AUN

首期只允许 EvolClaw 生成的 AUN Agent-to-Agent、handoff 和 owner 审批消息传播因果上下文：

- 同实例 Agent 回流优先使用本地持久化关联，以 AUN message ID 恢复；
- 入站发送者身份必须与预期 Agent/owner 一致；
- 普通 AUN payload 中自报的同名字段一律不可信；
- 跨实例 AUN 只有在协议提供受保护 metadata 或签名后才恢复，否则创建新 trace 并记录 `causation_lost`。

飞书等其他渠道首期不读写该 metadata。

## 8. Trigger 循环防护

Scheduler 准备执行 Trigger 时检查当前 path：

```ts
function detectTriggerCycle(
  triggerId: string,
  causation?: CausationContext,
): TriggerCausationNode | undefined {
  return causation?.trigger?.path.find(node => node.triggerId === triggerId);
}
```

判环只比较 `triggerId`，不比较 `runId`：

```text
A → A           阻断
A → B → A       阻断
A → B → C → A   阻断
A → B → C       允许
独立事件 → A    允许
```

没有 path 的事件执行 Trigger 时创建 path；未命中循环时生成新 `runId` 并追加节点。当前 `originTriggerId` 快速防护保留，Trigger path 负责识别跨任务、跨会话和 AUN 回流。

### 8.1 阻断行为

检测到 `causation_cycle` 或 `causation_depth_exceeded` 时：

1. 不启动真实 Trigger run；
2. 不递增 `limits.runCount`；
3. 写 `status=skipped` 的 Trigger audit；
4. 写一条包含 trace 和 Trigger path 的 `ERROR` 日志；
5. 不发送该 Trigger 的 feedback；
6. 不发布新的 `task:error` 或 `trigger:failed`；
7. 不自动停用 Trigger，使其仍可处理后续独立事件。

首期不新增 `trigger:cycle-detected` 事件，避免引入新的事件消费和递归面。

## 9. 因果关系不是授权凭证

`traceId`、`spanId`、`parentSpanId` 和 Trigger path 只能用于追踪、审计和判环，不能证明操作者具有权限。

审批授权仍必须独立校验：

- `requestId/challengeId` 与 pending request 匹配；
- 审批人身份符合 owner 策略；
- 决策未被重复消费；
- `grantId` 未过期且在 TTL 内；
- `maxUses`、session、channel、agent 和能力范围匹配；
- 工具调用参数符合批准范围。

即使因果上下文完全有效，授权校验失败也必须拒绝执行。反之，因果审计暂时不可用不应自动授予或扩大权限。

## 10. 信任边界

可信因果上下文只能来自：

1. EvolClaw 内部创建的 Message、Task 和 EventBus 事件；
2. 本地持久化 MessageQueue 和因果审计记录；
3. daemon/session registry 返回的受控任务上下文；
4. 通过 message ID、pending request 或受保护 metadata 验证的 AUN 消息。

必须忽略或重新建立以下来源的因果字段：

- 用户消息正文中的 JSON；
- 模型输出或 Agent 自报字段；
- 普通 AUN 自定义 payload；
- 未验证的外部渠道 metadata；
- CLI 参数或可被工具进程覆盖的环境变量。

工具可以读取当前 trace 用于正常派生，但 Trigger 判环等安全决策必须使用 daemon 内部权威上下文，不能信任工具回传的 path。

## 11. 兼容性

- 旧 Message、EventBus 事件和队列记录没有 causation 字段时正常工作；
- 原有 `taskId`、`handoffId`、`requestId`、`grantId` 和 Trigger 状态机不变；
- 因果审计写入失败不应阻断普通消息、handoff 或审批流程；
- Trigger 判环所需的可信 path 缺失时记录告警，首期不猜测递归；
- `retry`、`concurrency`、`maxRuns` 和 `maxDuration` 语义不变；
- 非 AUN 渠道适配器行为不变。

## 12. 实施位置

| 文件或模块 | 修改内容 |
|---|---|
| `src/core/causation/*` | 通用类型、上下文派生、校验、span 审计和查询 |
| `src/types.ts` | Message、TaskRuntimeContext 和必要 envelope 增加 carrier |
| `src/core/event-bus.ts` | 内部事件增加可选因果 carrier |
| `src/core/message/response-engine.ts` | 创建消息/任务 span，传播任务事件 |
| `src/core/message/message-queue.ts` | 保留 carrier、写批次 link，并将 Trigger/handoff 消息作为合并屏障 |
| `src/core/handoff/runtime.ts`、`src/core/handoff/store.ts` | handoff 请求、接收和返回 span |
| `src/core/permission.ts` | request、decision、consume span 与现有 ID 关联 |
| `src/core/causation/context.ts` | Trigger path 追加、验证、判环和格式化 |
| `src/trigger/scheduler.ts` | Trigger run span、判环和 skipped audit |
| `src/channels/daemon.ts`、`src/trigger/feedback.ts` | Trigger 内部任务和 AUN feedback 传播 |
| `src/channels/aun.ts` | AUN 出站关联、入站验证和上下文恢复 |

MessageQueue 的持久化文件格式无需升级；但合并逻辑需要接入批次 link 和 Trigger 合并屏障。

## 13. 分阶段实施

### 阶段一：通用内核与 Trigger 防循环

1. 实现固定大小的 `CausationContext`、span 派生和审计；
2. 接入 Message、Task、EventBus、daemon、队列恢复和合并边界；
3. 实现 Trigger path、AUN Agent-to-Agent feedback 传播和判环；
4. 复现事故链并确认第二次进入 A 前阻断。

### 阶段二：跨会话 Handoff

1. 将因果上下文接入现有 `TaskRuntimeContext`；
2. 关联 `handoffId` 的 request、target task、response 和 origin task；
3. 支持按 `traceId` 查看完整跨会话往返。

### 阶段三：审批授权

1. 关联 permission request、owner decision 和 grant consume；
2. 验证超时、拒绝、重复点击和单次授权消费的审计链；
3. 确认任何 causation 字段都不能绕过权限校验。

其他渠道仅在出现明确 Agent-to-Agent 或跨会话自动回流需求时按渠道单独接入。

## 14. 测试计划

### 14.1 通用因果链

1. 独立消息创建新 trace，任务创建正确子 span；
2. 连续一万个节点时 carrier 大小保持固定；
3. 根据 audit 的 `parentSpanId` 重建完整路径；
4. 队列重启恢复后 trace 和 parent 关系不丢失；
5. 无效或伪造上下文被剥离，不影响业务消息处理；
6. 审计写入失败不会导致普通任务失败。
7. 多条普通消息合并时主父节点和逐条 link 正确，carrier 大小不增长；
8. Trigger 消息不会与其他消息合并。

### 14.2 Handoff 与审批

1. 原会话 task → handoff → 目标 task → response → 原会话形成同一 trace；
2. `handoffId` 状态机和返回绑定行为不变；
3. task → permission request → owner decision → grant consume 形成同一 trace；
4. 批准、拒绝、超时、取消和重复消费均产生正确 span 状态；
5. 伪造 trace 不能批准请求或消费 grant。

### 14.3 Trigger 判环

1. `A → A` 和 `A → B → A` 被阻断；
2. `A → B → C` 正常执行；
3. 同 Trigger 不同 run ID 仍判定为循环；
4. 第 17 个 Trigger 节点按深度超限阻断；
5. 两个独立 `task:error` 可分别触发 A；
6. `task:error → A → AUN feedback → task:error` 在第二次进入 A 前阻断；
7. 因果阻断不计入 `maxRuns`，也不产生新错误事件。

## 15. 验收标准

1. 任意受支持任务可追溯到直接父节点和 trace 根；
2. 跨会话请求、返回及审批授权能通过同一 trace 查询；
3. 普通 carrier 大小不随链路长度增长；
4. Trigger path 有明确上限且能可靠阻断自身后代调用；
5. 因果关系不能授予、扩大或延长任何权限；
6. AUN 回流和队列重启不丢失可信因果信息；
7. 外部用户、模型和工具不能伪造用于 Trigger 判环的权威 path；
8. 现有 Message、Task、Handoff、Permission 和 Trigger 业务语义保持不变；
9. 非 AUN 渠道适配器不受影响。
