# Trigger 执行限制与取消语义

## 状态

- Status: Implemented
- Created: 2026-06-26
- Updated: 2026-06-27 00:20
- Version: 3.0

## 目标

为周期性 trigger 增加系统级执行边界：

1. 最多执行 N 次后自动禁用。
2. 最多运行一段时间后自动禁用。
3. `trigger cancel` 只取消后续调度，不中断当前正在运行的 run。

典型场景：每 4 小时尝试更新一个 git 仓库；更新成功后 agent 调用 `trigger cancel` 停止后续尝试；如果一直未成功，系统最多尝试 10 次或运行 3 天。

## 非目标

本方案不实现以下能力：

- 不新增 `autoDisable`。
- 不新增 `[[TRIGGER_STOP]]` 或其它停止哨兵。
- 不重命名现有 feedback 分支。
- 不实现延迟取消、`cancelRequested` 或 AsyncLocalStorage 自动判定。
- 不把 stats 写入 trigger definition。

## 数据结构

### TriggerLimits

```ts
export interface TriggerLimits {
  maxRuns?: number;
  maxDuration?: string; // "3d" | "72h" | "4320m"
}
```

`maxDuration` 支持单位：

| 单位 | 含义 | 示例 |
|------|------|------|
| `d` | 天 | `3d` |
| `h` | 小时 | `72h` |
| `m` | 分钟 | `4320m` |

### TriggerLimitState

强制限制不能依赖 audit 聚合，因为 audit 有保留期。运行期限制状态写入 `active.json`：

```ts
export interface TriggerLimitState {
  startedAt: number;
  runCount: number;
  disabledReason?: 'max_runs' | 'max_duration';
}

export interface TriggerActiveFile {
  runs: Record<string, TriggerActiveRun>;
  schedule?: TriggerScheduleState;
  limits?: TriggerLimitState;
}
```

说明：

- `startedAt` 是限制窗口开始时间，默认在 trigger 创建后第一次启用/调度时写入。
- `runCount` 在真实 run 开始前递增；dry-run 不计数。
- `disabledReason` 只作为 active 状态辅助信息；最终停止原因仍写 audit。

### TriggerDefinition

```ts
export interface TriggerDefinition {
  $schema_version: 3;
  id: string;
  agentAid: string;
  enabled: boolean;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  origin?: TriggerOrigin;
  source: TriggerSource;
  execution: TriggerExecution;
  feedback: TriggerFeedbackConfig;
  reliability: TriggerReliability;
  limits?: TriggerLimits;
}
```

`feedback` 保持现有 V3 结构：

```ts
export interface TriggerFeedbackConfig {
  onReply: FeedbackDisposition;
  onNoop: FeedbackDisposition;
  default: FeedbackDisposition;
}
```

## 执行流程

触发前检查限制：

```ts
private async handleScheduledFire(triggerId: string, scheduledAt: number): Promise<void> {
  const definition = this.manager.get(triggerId);
  if (!definition?.enabled) return;

  const firedAt = Date.now();

  if (this.shouldDisableForLimits(definition, firedAt)) {
    this.disableForLimit(definition, firedAt);
    return;
  }

  await this.startRun(definition, {
    scheduledAt,
    firedAt,
    payload: this.sourcePayload(definition.source),
  });
}
```

真实 run 开始前递增计数：

```ts
private async startRun(definition: TriggerDefinition, payload: TriggerRunPayload): Promise<TriggerRuntimeResult> {
  if (!payload.dryRun) {
    this.state.incrementLimitRunCount(definition.id);
  }
  // existing execution flow...
}
```

自动禁用时：

- `setEnabled(triggerId, false)`
- 清理后续 timer/event/schedule
- 写 audit：`status: 'skipped'`，`reason: 'max_runs_reached' | 'max_duration_reached'`
- 发布现有 trigger outcome 事件

## Disable / Cancel 语义

主语义使用 `trigger disable`：禁用后续调度，保留定义和历史，可再次 `enable`。

`trigger cancel` 保留为 `disable` 的兼容别名；不要把它理解成“取消当前 run”。二者语义固定为：

> 禁用 trigger 的后续调度，但不取消当前正在运行的 run。

当前实现已经符合这个语义：

```ts
cancel(triggerId: string): TriggerDefinition {
  return this.setEnabled(triggerId, false);
}

setEnabled(triggerId: string, enabled: boolean): TriggerDefinition {
  const definition = this.manager.setEnabled(triggerId, enabled);
  this.clearTimer(triggerId);
  this.unregisterEvent(triggerId);
  this.state.clearSchedule(triggerId);
  if (definition.enabled && this.initialized) this.schedule(definition);
  return definition;
}
```

`setEnabled(false)` 不应调用：

- `AbortController.abort()`
- `finishRun()`
- `state.remove(runId)`
- `state.clear()`

## Delete 语义

`trigger delete` 的语义固定为：

> 彻底删除 trigger 定义，并清理后续调度状态；不取消当前正在运行的 run。

`delete` 是单步命令，不要求用户先执行 `disable/cancel`。实现内部先清理 timer/event/schedule，再删除定义目录。

与 `disable/cancel` 的区别：

| 命令 | 定义文件 | 后续调度 | 当前 run | 可恢复 |
| --- | --- | --- | --- | --- |
| `trigger disable` / `trigger cancel` | 保留，写 `enabled: false` | 清理 | 不中断 | 可重新 enable |
| `trigger delete` | 删除整个 trigger 目录 | 清理 | 不中断 | 不可恢复 |

实现路径：

```ts
delete(triggerId: string): TriggerDefinition {
  const definition = this.manager.require(triggerId);
  this.clearTimer(triggerId);
  this.unregisterEvent(triggerId);
  this.state.clearSchedule(triggerId);
  this.state.clearLimitState(triggerId);
  return this.manager.delete(triggerId);
}
```

边界说明：

- 如果 `reliability.concurrency === 'replace'`，下一次触发可能按 replace 语义中断旧 run；这不是 `trigger cancel` 导致的。
- 如果 daemon 重启，未完成 run 仍按现有 `recoverOpenRuns()` 逻辑处理。

## CLI

创建 trigger 时新增参数：

```bash
ec trigger create \
  --cron '0 */4 * * *' \
  --max-runs 10 \
  --max-duration 3d \
  --permission bypass \
  --prompt '尝试更新；成功后调用 ec trigger cancel auto-updater；无更新输出 [[NOOP]]' \
  --name auto-updater
```

需要执行 git 写操作、安装/升级、重启、或让 agent 调用 `ec trigger cancel` 自我停止的 trigger，应使用 `--permission bypass`。owner/admin 通过 `/trigger set` 创建时默认使用 `bypass`；非 admin 创建时默认 `readonly` 且不能提权到 `bypass`。

取消 trigger：

```bash
ec trigger cancel auto-updater
```

展示状态：

```bash
ec trigger show auto-updater
```

展示应包含：

- 当前状态：enabled / disabled
- limits 配置：`maxRuns`、`maxDuration`
- limits 状态：`runCount`、`startedAt`、预计过期时间
- audit 聚合统计：成功、noop、失败、最近运行

## Stats 展示

stats 用于展示，不用于强制限制。

可从 audit 聚合：

```ts
export interface TriggerStats {
  totalRuns: number;
  successCount: number;
  noopCount: number;
  errorCount: number;
  lastRunAt?: number;
  lastStatus?: TriggerRunStatus;
  lastOutcome?: TriggerReply['outcome'];
}
```

注意：audit 聚合受日志保留期影响，只能作为展示数据；`maxRuns` 必须使用 `active.json.limits.runCount`。

## 校验规则

- `limits.maxRuns` 必须是正整数。
- `limits.maxDuration` 必须匹配 `^[1-9]\d*(m|h|d)$`。
- `limits` 为空时不启用限制。
- dry-run 不递增 `runCount`，也不触发自动禁用。

## 实施清单

1. `types.ts`
   - 增加 `TriggerLimits`
   - 增加 `TriggerLimitState`
   - `TriggerDefinition` 增加 `limits?: TriggerLimits`
   - `TriggerActiveFile` 增加 `limits?: TriggerLimitState`

2. `validation.ts`
   - 解析并校验 `limits`
   - 增加 `parseDurationMs()` 工具函数

3. `state.ts`
   - 保留空 runs + 空 schedule 但存在 limits 时的 `active.json`
   - 增加 `readLimitState()` / `ensureLimitState()` / `incrementLimitRunCount()` / `clearLimitState()`

4. `scheduler.ts`
   - 触发前检查 `maxRuns` / `maxDuration`
   - run 开始前递增 `runCount`
   - 自动禁用时写 audit
   - 确认 `cancel()` 不中断当前 run

5. CLI / command handler
   - 支持 `--max-runs`
   - 支持 `--max-duration`
   - `show` 输出 limits 状态

6. 测试
   - duration 解析
   - `maxRuns` 达限自动禁用
   - `maxDuration` 达限自动禁用
   - dry-run 不计数
   - cancel 不 abort 当前 run
