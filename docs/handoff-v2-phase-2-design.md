# Handoff v2：二期精简方案

> 状态：实施稿
>
> 日期：2026-07-13
>
> 一期实现基线：`docs/handoff-v2-instance-pool-design.md`
>
> 历史完整设计归档：`docs/_archive/handoff-v2-instance-pool-design-full-2026-07-12.md`

## 1. 目标

二期只补充两类高频、可确定处理的能力：

1. 提供只读的 `ec handoff list/trace`，便于定位 handoff 当前状态和状态变化过程。
2. 验证 daemon 常规重启恢复，并在 agent 热重载时协调 Handoff dispatcher，避免渠道断开期间继续发送。

一期状态机、发送语义、reply binding 和回流完成语义均保持不变。

## 2. 范围

### 2.1 必须实现

- `ec handoff list`：按 agent 查询实例，可按状态或来源/目标 session 过滤，结果有上限。
- `ec handoff trace`：按 agent 和 handoff ID 查询对应 history 事件，结果有上限。
- daemon 常规重启恢复测试：确认安全的 `queued` 和 `origin_queued` 继续推进，不确定发送保持 fail-closed。
- 已有 agent 热重载协调：暂停该 agent 的新 Handoff 发送，等待当前发送结束，渠道恢复后执行已有 `recover([aid])`，再恢复发送。
- agent 被禁用或热重载失败时保持暂停，不向不可用渠道继续发送。

### 2.2 明确不做

- `ec msg send --return none`。
- `exact|merge` 配置、多 handoff reply binding 和多 ID target 提示词。
- reply candidate 或 binding 的自动重建、`reply_enqueue_succeeded`。
- outbound logical batch、origin delivery batch、通用 WAL。
- repair/retry/cancel 等改变状态的命令。
- 网络发送结果未知时的跨重启自动重试。
- 未 return 模型回复的重新注入。
- v1 数据迁移、兼容读取或灰度开关。

## 3. `ec handoff list`

```bash
ec handoff list [--state <state>] [--session <session-id>] [--limit <n>] [--agent <aid>]
```

规则：

- `--state` 只接受现有 `HandoffState`。
- `--session` 同时匹配 `origin_session_id` 或 `target_session_id`。
- `--limit` 默认 100，范围 1-500。
- 按 `updated_at` 倒序输出；时间相同按 `handoff_id` 排序。
- 每项输出 ID、state、origin/target session、更新时间和 attention reason。

## 4. `ec handoff trace`

```bash
ec handoff trace <handoff-id> [--limit <n>] [--agent <aid>]
```

规则：

- 先确认 handoff 属于所选 agent；不存在时统一返回 `HANDOFF_NOT_FOUND`。
- 从该 agent 的 `history.jsonl` 读取 `handoff_id` 相同的事件。
- 按落盘顺序输出最近 `limit` 条，默认 100，范围 1-500。
- 输出时间、事件类型、版本变化、operation key 和 details。

数据量按当前实现直接扫描快照目录和 history；本期不增加索引或派生数据库。

## 5. 查询作用域

- 任务上下文内从 `EVOLCLAW_SESSION_ID` 对应的 runtime/session 推导 self agent。
- 任务上下文内如显式 `--agent` 与当前 self agent 不同，拒绝查询。
- 任务上下文外必须显式提供 `--agent`。
- IPC 只接受 agent 作用域已经解析的查询，不提供跨 agent 聚合。

该规则与 handoff store 的 per-agent 目录隔离一致，不增加新的权限模型。

## 6. daemon 重启恢复

沿用一期已有顺序：

1. `MessageQueue.restorePersisted(false)` 只恢复持久队列，不立即消费。
2. 渠道连接完成后执行 `handoffRuntime.recover(allAids)`。
3. 再执行 `messageQueue.startRestored()`。

`recover()` 保持现有确定性规则：

- 未开始发送的 `queued` 重新通知 dispatcher。
- 最后一条发送事件为 `target_send_started` 的 `queued` 标记 `TARGET_SEND_OUTCOME_UNKNOWN`，不自动重发。
- `origin_queued` 使用确定性消息 ID 重新 durable enqueue。
- history 与 snapshot 版本不一致时标记 `STORE_CONFLICT`。
- 其它状态不猜测推进。

二期只补齐回归测试，不扩展恢复状态机。

## 7. agent 热重载协调

### 7.1 dispatcher 接口

Handoff dispatcher 增加 agent 级控制：

```ts
pauseAgent(aid: string): void
drainAgent(aid: string, timeoutMs?: number): Promise<void>
resumeAgent(aid: string): void
```

- `pauseAgent` 后不再选择该 agent 的下一条 `queued` 实例。
- 已进入 transport sender 的一次发送不强制取消，避免制造未知发送结果。
- `drainAgent` 只等待当前运行中的发送循环退出，不等待积压队列全部发送。
- `resumeAgent` 重新扫描该 agent 的 `queued` target session 并通知 dispatcher。
- 默认 drain 超时 30 秒；超时抛错并保持暂停。

### 7.2 reload 顺序

已有 agent reload：

```text
校验新配置
  → pauseAgent(aid)
  → drainAgent(aid)
  → drain/disconnect/recreate channels
  → recover([aid])
  → resumeAgent(aid)
```

- drain 超时发生在渠道断开前，reload 中止，原渠道保持连接，dispatcher 保持暂停。
- 渠道重建或 recovery 失败时 agent 保持 error，dispatcher 保持暂停。
- reload 成功后才 resume。
- agent 被禁用时只执行 pause/drain 和断开，保持暂停。
- 被重新启用或新 agent hot-load 成功连接后，执行 `recover([aid])` 再 resume。

热重载不新增 handoff 状态或事件。正在发送且明确成功的实例照常进入 `target_sent`；无法确定结果仍使用一期 fail-closed 规则。

## 8. 主要改动

- `src/core/handoff/types.ts`：list/trace 请求与响应类型。
- `src/core/handoff/store.ts`：有界过滤 list 和按 ID 过滤 trace。
- `src/core/handoff/runtime.ts`：查询包装及 agent dispatcher 控制。
- `src/core/handoff/dispatcher.ts`：agent pause/drain/resume。
- `src/cli/handoff-command.ts`：list/trace 参数解析和输出。
- `src/ipc.ts`、`src/index.ts`：查询 IPC、self-agent 解析和作用域校验。
- `src/core/evolagent-registry.ts`、`src/core/channel-loader.ts`、`src/index.ts`：reload 生命周期协调。
- Handoff 定向单元测试和启动/重载顺序测试。

## 9. 验收标准

1. `list` 可按 state/session 过滤，按更新时间倒序返回，limit 被限制在 1-500。
2. `trace` 只返回指定 handoff 的事件，并保留 history 落盘顺序。
3. 任务上下文只能查询当前 self agent；无任务上下文未指定 agent 时拒绝。
4. 查询不存在或其它 agent 的 ID 不泄露实例内容。
5. 常规重启后安全的 `queued` 与 `origin_queued` 自动续跑。
6. 常规重启后未知 target 发送不重试，并标记 `TARGET_SEND_OUTCOME_UNKNOWN`。
7. 热重载 pause 后不开始下一条 Handoff 发送。
8. 热重载等待当前 sender 完成后才断开渠道，不等待整个 queued backlog。
9. drain 超时中止 reload，且不执行渠道断开。
10. reload 成功时先 `recover([aid])` 后 resume；积压 `queued` 随后继续发送。
11. reload 失败或 agent disabled 时 dispatcher 保持暂停。
12. 不新增状态、WAL、batch、repair 命令、`none` 或 `merge` 路径。
