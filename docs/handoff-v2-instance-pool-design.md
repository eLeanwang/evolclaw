# Handoff v2：一期精简实施方案

> 状态：一期已实现（2026-07-12）
>
> 日期：2026-07-12
>
> 完整设计归档：`docs/_archive/handoff-v2-instance-pool-design-full-2026-07-12.md`

## 1. 目标

一期只解决一条可靠、可审计的一对一跨会话链路：

```text
来源会话 S1 中的 Agent A
  → ec msg send 联系另一个会话中的 B
  → daemon 持久化并原样发送
  → B 回复后精确关联一个 handoff
  → target 模型显式执行 ec handoff return
  → 回流结果持久进入 S1 的模型上下文
```

核心边界：

1. 模型决定消息内容以及何时确认 return；daemon 负责持久化、发送、关联和回源。
2. 每次跨会话 `msg send` 创建一个独立 handoff，不合并请求。
3. 一期只有 `return=required` 和 `exact` 消费，不实现多 handoff 合并。
4. handoff 完成表示回流结果已经进入来源模型上下文，不表示来源模型一定回复成功或渠道一定发送成功。
5. 正常链路必须可靠；无法确定的崩溃中间态 fail-closed，不猜测重放。

## 2. 一期范围

### 2.1 支持能力

- 跨会话 `ec msg send` 默认创建 required handoff。
- 显式支持 `--return required`。
- text、link、payload、file/image/video/voice、encrypt 和 thread 保持现有发送语义。
- daemon 按 target session 有序、逐 handoff 原样发送。
- target 回复使用固定 `exact` 规则关联至最多一个 handoff。
- `ec handoff return [handoff-id] <content>` 将结果交回来源会话。
- return 支持 session 鉴权、内容校验和内容 hash 幂等。
- 每个 handoff 单独持久化回源，不创建来源 delivery batch。
- 提供 `ec handoff status <handoff-id>`。
- daemon 启动时恢复确定安全的状态；不确定状态停止自动推进并在 status 中报告。

### 2.2 一期明确不做

- `return=none`。
- `merge` 消费及 `handoff.reply_consumption` 配置。
- outbound logical batch 和 origin delivery batch。
- 多 handoff 合并提示词、批量 return 和多结果合并回源。
- v1 数据迁移、兼容读取和兼容开关。
- 自动修复所有崩溃窗口、通用 WAL mutation replay。
- `ec handoff list/trace` 和修复命令。

`--return none` 在一期返回稳定错误 `HANDOFF_RETURN_POLICY_UNSUPPORTED`，不得静默降级为 required。

## 3. 二期范围

二期只包含从一期明确延后的增强：

1. `return=none` 及无内容确认。
2. agent 级 `exact|merge` 配置和 merge 消费。
3. immutable outbound logical batch 及 batch 成员顺序。
4. origin delivery batch、多结果合并回源。
5. 多 SubMessage 与多 handoff 的批量提示词和逐 ID return。
6. 通用 history mutations WAL、快照补写和完整启动重放。
7. 已落盘但未 binding、已 binding 但未入队等崩溃窗口的自动续跑。
8. 跨重启自动重试、退避、损坏隔离和版本冲突诊断。
9. `ec handoff list/trace` 和完整故障注入测试。

未列入本节的设想不自动视为二期需求，后续如有需要单独立项。

## 4. 存储模型

handoff store 按 self agent 隔离：

```text
$EVOLCLAW_HOME/data/handoff/<self-aid>/
├── handoffs/
│   └── <handoff-id>/handoff.json
└── history.jsonl
```

- 只有 daemon 可以写 store；CLI 通过 IPC 操作。
- `<self-aid>` 和 `<handoff-id>` 必须使用安全相对路径校验。
- `handoff.json` 是当前状态权威快照。
- `history.jsonl` 是追加式审计记录，一期不承担通用 WAL 自动重放职责。
- 单个 history 或 snapshot 冲突只阻塞对应 handoff，不得猜测状态。

### 4.1 `handoff.json`

```json
{
  "schema_version": 1,
  "handoff_id": "h-...",
  "origin_session_id": "meta_origin",
  "origin_message_id": "om_origin",
  "target_session_id": "meta_target",
  "request": {
    "payload": {
      "type": "text",
      "text": "查询当前记录数量"
    },
    "encrypt": false
  },
  "return_policy": "required",
  "state": "queued",
  "target_message_id": null,
  "response_message_id": null,
  "consumed_at": null,
  "consumed_target_session_id": null,
  "return_content": null,
  "return_content_hash": null,
  "origin_delivery_message_id": null,
  "version": 1,
  "created_at": 1783814400000,
  "updated_at": 1783814400000,
  "completed_at": null
}
```

说明：

- `request.payload` 是完成参数解析和文件上传后可直接发送的最终 payload。
- `origin_session_id`、`target_session_id` 是唯一权威路由键；channel、peer、thread 从 session 读取。
- `target_message_id` 用于 exact 引用匹配。
- target 回复正文保存在可靠写入的 `messages.jsonl`，不复制进快照。
- `return_content` 保留，用于来源队列恢复和重复 return 判定。
- `origin_delivery_message_id` 是本地确定性队列消息 ID，不是渠道外部消息 ID。

### 4.2 `history.jsonl`

一期记录以下核心事件：

```text
created
target_send_started
target_send_succeeded
target_send_failed
reply_bound
return_accepted
origin_enqueue_succeeded
origin_enqueue_failed
origin_context_consumed
```

每个事件包含：

```json
{
  "event_id": "ev-...",
  "event_type": "target_send_succeeded",
  "handoff_id": "h-...",
  "operation_key": "target-send:h-...",
  "created_at": 1783814400100
}
```

外部副作用使用确定性 operation key：

```text
target-send:<handoff_id>
reply-enqueue:<response_message_id>:<target_session_id>
origin-deliver:<handoff_id>:<origin_session_id>
```

history 正常写入使用 `appendJsonl()` 和 `fsync`。一期不通过通用 mutations 自动修补落后的 JSON；发现 history 与快照存在无法安全判断的差异时，将实例标记为需要处理并停止自动调度。

## 5. 状态机

一期只有 required：

```text
queued
  → target_sent
  → return_pending
  → origin_queued
  → origin_delivered
  → completed
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已持久化，等待或正在安全调度 target 发送 |
| `target_sent` | target 外部消息已成功，正在等待回复 |
| `return_pending` | target 回复已绑定，等待模型显式 return |
| `origin_queued` | return 内容已可靠保存，等待进入来源队列 |
| `origin_delivered` | 单 handoff 来源消息已持久化进入 MessageQueue |
| `completed` | 固定 handoff 内容已成功构造进来源模型上下文 |

不增加 batch、claimed、lease、canceled 或 abandoned 状态。

## 6. 来源创建与 target 发送

### 6.1 判断跨会话

`ec msg send` 在发送前：

1. 从 `TaskRuntimeContext` 获取 `origin_session_id` 和 self agent。
2. 解析或创建包含 thread 维度的 target session。
3. 仅当 `target_session_id !== origin_session_id` 时创建 handoff。
4. 跨会话默认 required；显式 `--return required` 与默认行为相同。
5. 同会话显式使用 `--return` 返回 `RETURN_POLICY_REQUIRES_CROSS_SESSION`。
6. `--return none` 返回 `HANDOFF_RETURN_POLICY_UNSUPPORTED`。

无活跃任务或无法确定 origin session 时保持现有普通 `msg send` 行为，不创建 handoff。

### 6.2 payload 准备

创建实例前完成所有不可恢复的输入处理：

- text 与 `--text-from-file` 转为最终 text payload；
- link 保留 URL、title 和 description；
- payload 校验为 JSON object 后深拷贝保存；
- 文件类内容先复用现有上传逻辑，保存稳定 attachment payload；
- 保存 `encrypt`；
- 使用 `thread` 解析 target session，并仅补充 payload 中缺失的 `thread_id`；
- 不覆盖用户显式提供的合法 `thread_id/ref_message_id`。

上传或 payload 构造失败时不创建 handoff。

### 6.3 有序发送与公平 mutex

每个 `(self_aid, target_session_id)` 使用公平 FIFO mutex，并只运行一个 dispatcher 循环：

1. 从该 target 的 `queued` 实例中按 `created_at, handoff_id` 选择队首。
2. 取得 mutex，写入 `target_send_started`。
3. 使用有界超时调用 target session adapter，逐 handoff 原样发送。
4. 成功后写入 `target_message_id`，推进 `target_sent` 并释放 mutex。
5. 明确失败时记录 `target_send_failed`，在进程内按有限次数和有界退避重试；重试耗尽后设置 `attention_required` 并停止该实例，后续队首不得越过它发送。
6. 当前队首未成功前不越过它发送后续 handoff，保持确定顺序。

dispatcher 每处理一个 handoff 都释放 mutex，再公平申请下一项。若 target 回复已经等待 mutex，它必须先于 dispatcher 的下一次申请得到处理机会。

```text
SEND(h1) → h1=target_sent → release
BIND(r1) → h1=return_pending → release
SEND(h2) → h2=target_sent → release
```

一期不创建 logical batch。

## 7. target 回复与 exact 消费

### 7.1 可靠落盘顺序

target 私聊回复进入 daemon 后，reply-router 申请同一个 per-target mutex。取得 mutex 后：

1. 若该 session 没有开放的 `target_sent` handoff，走普通消息流程。
2. 若存在开放 handoff，将完整回复可靠追加到 `messages.jsonl` 并 `fsync`。
3. 日志行携带 handoff-v2 reply-candidate trace，供检测未完成 binding 的崩溃窗口。
4. 正文落盘成功后才运行 exact 算法并追加 `reply_bound`。
5. 更新被消费实例为 `return_pending`。
6. 通过 `enqueuePersisted()` 将消息可靠放入模型队列，然后释放 mutex。

日志写入失败时不得创建 binding、不得推进实例、不得进入模型队列。

handoff candidate 的入站日志只能由 reply-router 可靠写入一次；MessageBridge 的通用 best-effort 日志路径必须跳过该消息，避免同一 `response_message_id` 产生重复日志行。没有开放 handoff 的普通回复仍沿用现有 MessageBridge 日志路径。

### 7.2 固定 exact 规则

一期不读取任何消费策略配置：

1. `ref_message_id` 精确等于某个开放实例的 `target_message_id`：消费该实例。
2. 有 ref 但未命中：消费空集合，不回退猜测。
3. 无 ref 且只有一个开放实例：消费该实例。
4. 无 ref 且有多个开放实例：消费空集合。

即使消费为空也保存 `reply_bound`，表示该回复已经完成关联判定。空 binding 按普通消息渲染，不出现 handoff 或 return 指令。

### 7.3 禁止 handoff 消息合并

一期为 handoff-bound target 回复设置非合并队列策略：

- 不参与 debounce 合并；
- 不与其它 pending 消息贪心合并；
- 一个已绑定回复对应一个 target 模型任务；
- 该任务最多包含一个 consumed handoff。

这使一期无需引入多 `SubMessage` binding、`consumedHandoffs[]` 和批量 prompt。普通非 handoff 消息继续使用现有队列行为。

## 8. target 提示词与 return

### 8.1 target 动态提示词

只有非空 binding 才加入动态片段：

```text
说明：
- 跨会话请求回复，仅本端可见。
- 请结合下方内容理解当前对端回复。
- 若当前回复足以处理请求，使用：`ec handoff return h-001 "<完整回流内容>"`
- 若回复不足，不要执行 return。

此前发给当前对端的内容：
查询当前记录数量。

当前对端回复内容：
目前共有 128 条记录。
```

这版格式沿用 v1 fragment，只增加持久化 `handoff_id` 和明确的 return 判断，不展示一期固定或模型不需要的 `return_policy`、reply message ID、来源 channel/thread/身份及内部状态。

`<完整回流内容>` 是模板占位符，模型必须替换为根据当前回复整理出的真实、完整结果，不得字面传给 CLI。

非文本 payload 在“此前发给当前对端的内容”处使用自然摘要，不展开二进制或无界 JSON，例如：

```text
此前发给当前对端的内容：
[文件] 竞猜统计.csv（text/csv，18432 bytes）
附带说明：请汇总总记录数和最高积分用户。
```

### 8.2 CLI 语法

```bash
ec handoff return "结果"
ec handoff return <handoff-id> "结果"
ec handoff return [<handoff-id>] --text-from-file <path>
ec handoff return -- "以 h- 开头的结果"
```

handoff ID 格式：

```text
h-<id-body>
```

`id-body` 仅允许 ASCII 字母、数字、`.`、`_`、`-`，且不能为空。

### 8.3 选择与鉴权

- 显式 ID：读取持久实例和 `reply_bound`，不依赖任务内存状态。
- 省略 ID：仅当当前任务恰有一个 `return_pending` handoff 时自动选择。
- 无候选返回 `HANDOFF_ID_REQUIRED`。
- 多候选理论上不会由一期 handoff 队列产生；仍返回 `AMBIGUOUS_HANDOFF`，不得猜测。
- 当前调用 session 必须等于实例的 `target_session_id/consumed_target_session_id`。
- 其他 self agent 下的同名 ID按 `HANDOFF_NOT_FOUND` 处理，避免泄漏归属。

### 8.4 required 与幂等

- content 经语义空值检查，required 必须非空。
- 规范化换行为 `\n`，移除文件末尾单个换行，不 trim 其它有意空白。
- 首次 return 保存规范化 content 及 hash，推进 `origin_queued`。
- 相同 ID、相同 hash 的重复调用返回幂等成功。
- 已 return 后内容 hash 不同，返回 `HANDOFF_RETURN_CONFLICT`，不覆盖原内容。

核心响应码：

```text
HANDOFF_RETURN_ACCEPTED
HANDOFF_RETURN_ALREADY_APPLIED
INVALID_HANDOFF_ID
HANDOFF_ID_REQUIRED
AMBIGUOUS_HANDOFF
HANDOFF_NOT_FOUND
HANDOFF_TARGET_SESSION_MISMATCH
HANDOFF_NOT_RETURNABLE
HANDOFF_RETURN_CONTENT_REQUIRED
HANDOFF_RETURN_CONFLICT
HANDOFF_STORE_WRITE_FAILED
```

IPC 保留 `code`、`handoff_id`、`previous_state/state` 和 `idempotent` 等结构化字段；CLI 只渲染模型纠正调用所需的简短文本，不输出内部来源队列消息 ID。

首次成功：

```text
✓ handoff h-001 回流结果已接收
```

相同内容的幂等重复：

```text
✓ handoff h-001 已接收过相同结果，未重复处理
```

错误示例：

```text
✗ handoff h-001 必须提供非空回流内容
✗ handoff h-001 当前不可 return
✗ 当前任务没有可自动选择的 handoff，请指定 ID
```

“已接收”表示 return content 和 `origin_queued` 状态已可靠持久化，不表示来源模型已经处理或渠道已经发送。

## 9. 单实例来源回流

一期一个 handoff 对应一个来源队列消息，不创建 delivery batch。

### 9.1 durable enqueue

origin-router 对 `origin_queued` 实例构造：

```text
Message.messageId = origin-deliver:<handoff_id>:<origin_session_id>
Message.handoffDelivery.handoffId = <handoff_id>
```

MessageQueue 增加不改变原 `enqueue()` Promise 语义的持久入队接口：

```ts
enqueuePersisted(...): Promise<void>
```

该 Promise 在队列内容可靠落盘后完成，不等待模型任务结束。MessageQueue 必须按 `session + messageId` 检查 pending 和 active 持久项，重复提交同一 operation key 不得创建第二个任务。

落盘成功后 handoff 推进到 `origin_delivered`。

### 9.2 禁止来源消息合并和抢占

handoff 来源消息：

- 按来源 session FIFO；
- 不中断当前任务；
- 不与其它 handoff 或普通消息合并；
- 一个来源任务只携带一个固定 handoff ID。

### 9.3 来源提示词与完成点

来源任务按消息携带的固定 handoff ID 构造：

```text
说明：
- 跨会话结果回流，仅本端可见。
- 这是此前本会话请求的返回结果，请结合当前上下文回复当前对端。
- 不要提及 handoff 或内部路由机制。

此前跨会话请求内容：
查询当前记录数量。

回流内容：
目前共有 128 条记录。
```

来源提示词同样沿用 v1 fragment，不展示 handoff ID、target session 或本地队列消息 ID。

prompt builder 成功把原请求和 return content 放入模型上下文后、调用模型前，将实例推进到 `completed`。

完成后：

- 不追踪模型是否输出文本；
- 不追踪渠道发送回执或外部消息 ID；
- 模型失败、空回复、中断或渠道失败不回滚 handoff；
- 已持久化队列任务即使对应 handoff 已 completed，恢复时仍可使用固定 binding 构造上下文。

## 10. 一期恢复边界

一期启动时只自动处理可确定安全的情况：

- 干净的 `queued` 且没有未闭合 `target_send_started`：可重新调度。
- `target_sent`：继续等待回复，不重复发送。
- `return_pending`：允许在正确 target session 显式 return，不自动重新注入。
- `origin_queued`：可使用确定性来源 message ID 幂等调用 `enqueuePersisted()`。
- `origin_delivered`：由 MessageQueue 恢复已持久化任务。
- `completed`：handoff 不再调度，但已持久化来源任务仍可继续处理。

以下情况一期 fail-closed：

- `target_send_started` 没有明确 succeeded/failed；
- reply candidate 正文已落盘但没有 `reply_bound`；
- history 与 snapshot 版本或内容冲突；
- binding 引用的消息正文缺失；
- JSON 损坏或无法解析。

fail-closed 表示：停止该 handoff 或 target session 的自动推进、记录错误，并通过 `ec handoff status` 显示 `attention_required` 及稳定原因码。不得自动重发、重新消费或猜测修复。自动续跑和修复工具属于二期。

## 11. `messages.jsonl` 职责

`messages.jsonl` 继续记录：

- 每个 handoff 成功发送到 target 的独立 out 消息；
- target 入站回复；
- 来源模型最终产生的普通 out 消息。

它不是 handoff 状态权威源，但 target reply binding 所引用的正文必须可靠写入并 `fsync`。handoff candidate 可带非权威 trace：

```json
{
  "handoff_trace": {
    "version": 2,
    "reply_candidate": true
  }
}
```

一期不扫描聊天历史推断 pending、consumed 或 completed。

## 12. 查询

一期只提供：

```bash
ec handoff status <handoff-id>
```

至少返回：

```json
{
  "ok": true,
  "handoff_id": "h-001",
  "state": "return_pending",
  "origin_session_id": "meta_origin",
  "target_session_id": "meta_target",
  "return_policy": "required",
  "created_at": 1783814400000,
  "updated_at": 1783814401000,
  "attention_required": false,
  "attention_reason": null
}
```

错误输出不得暴露其他 self agent 的实例或 return content/hash。

## 13. 模块与现有改造点

建议新增：

```text
src/core/handoff/types.ts
src/core/handoff/store.ts
src/core/handoff/dispatcher.ts
src/core/handoff/reply-router.ts
src/core/handoff/origin-router.ts
src/core/handoff/prompt.ts
```

现有主要改造点：

```text
src/aun/msg/p2p.ts
src/core/message/message-bridge.ts
src/core/message/message-queue.ts
src/core/message/response-engine.ts
src/core/message/message-log.ts
src/cli/aun-commands.ts
src/cli/handoff-command.ts
src/ipc.ts
src/index.ts
src/types.ts
```

一期不新增 handoff 配置 schema，也不新增 recovery 模块。

## 14. 一期验收

必须覆盖：

1. 跨会话默认 required，显式 required 成功，none 返回 unsupported。
2. 同会话不创建 handoff，显式 `--return` 返回错误。
3. text、link、payload、文件类、encrypt 和 thread 原样发送。
4. 文件上传成功后删除本地原文件，dispatcher 仍可发送稳定 payload。
5. 同 target 的 h1/h2 按顺序逐条发送，不创建 batch。
6. h1 发送后回复已等待 mutex 时，reply binding 先于 h2 发送。
7. exact 的 ref 命中、ref 未命中、无 ref 唯一候选和无 ref 多候选全部符合规则。
8. target 正文写入失败时不 binding、不推进、不入队。
9. handoff-bound target 回复不与其它消息合并。
10. required 显式 ID、当前任务省略 ID及 `--text-from-file/--` 解析正确。
11. return 的 session 鉴权、相同 hash 幂等和不同 hash 冲突正确。
12. return content 持久化后创建唯一来源队列消息，重复 enqueue 不产生第二个任务。
13. 来源 handoff 消息 FIFO、非抢占、非合并。
14. 固定回流内容进入来源上下文后完成，不等待模型输出或 adapter 回执。
15. 模型未 return 时保持 `return_pending`；任务结束后可在正确 target session 显式 ID return。
16. 确定状态启动恢复正确；不确定 send、candidate、版本冲突全部 fail-closed。
17. 不同 self agent 的 store 严格隔离，跨 agent ID 返回 not found。
18. `ec handoff status` 正确显示状态和 attention reason，不泄漏敏感内容。

## 15. 实施顺序

1. 实现类型、原子快照、审计 history 和 status。
2. 接入 `msg send` payload 准备、handoff 创建和单实例 dispatcher。
3. 接入公平 mutex、可靠入站日志和 exact binding。
4. 接入单实例 target prompt 与 `ec handoff return`。
5. 增加 `enqueuePersisted()`、单实例来源 prompt 和完成检查点。
6. 增加最小启动恢复、fail-closed 检查和端到端测试。

## 16. 工作量预估

一期预计：

| 类别 | 文件数 | 代码量 |
| --- | ---: | ---: |
| 新增 handoff 模块 | 6–8 | 1,300–1,900 行 |
| 修改现有链路、CLI 与 IPC | 10–14 | 900–1,400 行 |
| 测试 | 8–12 | 1,000–1,600 行 |
| 合计 | 24–34 | 3,200–4,900 行 |

不确定性主要来自 MessageQueue 的持久入队 ack、非合并队列策略和 ResponseEngine 的两个提示词接入点。
