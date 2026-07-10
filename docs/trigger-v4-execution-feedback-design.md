# Trigger V4 执行与反馈模型设计（确认版）

日期：2026-07-07

## 背景

当前 Trigger 的执行与反馈存在几类混淆：

- `execution.mode = agent | script` 无法清晰表达“本地会话执行”和“目标会话执行”的差异。
- slash/menu 的 `--session thread` 同时影响本地 prompt 执行会话和 feedback 投递目标，执行层与反馈层耦合。
- definition 内部使用 `isolated | thread`，slash/menu 外部又使用 `latest | thread`，命名不统一。
- feedback 的 `kind = forward | reply-origin | silent` 以及 `targets[]` 表达力过强，导致配置复杂；实际需求可以收敛为“原会话 / 指定会话 / 静默”。

本方案是 breaking cleanup：旧参数与旧 definition 结构不继续兼容，不提供 alias。旧配置需要显式迁移。

## 设计目标

1. 明确区分三种执行方式：本地脚本、本地会话、目标会话。
2. 取消执行会话与反馈目标之间的耦合。
3. 统一主会话/话题会话命名为 `main | thread`。
4. 删除 feedback 多 target 和分支 target 能力，仅保留单一反馈策略。
5. 增加一次性立即执行 source：`once`。
6. 权限边界清晰：非 admin 不能通过 trigger 跨渠道、跨会话或提权执行。

## Source

`source.type` 支持：

```ts
type TriggerSource =
  | { type: 'once' }
  | { type: 'delay'; afterMs: number }
  | { type: 'at'; at: string }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; everyMs: number }
  | { type: 'event'; eventPattern: string; filter?: TriggerEventFilter };
```

`once` 语义：

- 创建后立即执行一次。
- 执行结束后自动设置 `enabled=false`。
- 保留 definition 与 audit，便于历史查询。
- 不参与下一次调度计算。

示例：

```json
{
  "source": { "type": "once" }
}
```

## Execution

执行类型改为：

```ts
type TriggerExecutionType =
  | 'script'
  | 'trigger_session'
  | 'target_session';
```

通用字段：

```ts
interface TriggerExecution {
  type: TriggerExecutionType;
  prompt?: string;
  script?: TriggerScriptConfig;
  thread?: 'per_run' | 'by_trigger';
  model?: string;
  effort?: TriggerEffort;
  permissionMode?: TriggerPermissionMode;
  onError: 'fail' | 'retry';
  noopSentinel: string;
}
```

### script

本地脚本执行，等价于原脚本能力。

```json
{
  "execution": {
    "type": "script",
    "script": {
      "path": "scripts/check.js",
      "runtime": "node",
      "args": {},
      "timeoutMs": 30000
    }
  }
}
```

规则：

- 必须有 `execution.script`。
- 不使用 `execution.prompt`。
- 不使用 `execution.thread`。
- 执行结果有三类分支：reply / noop / failure。
- 只有 `script` 支持 `feedback.onReply/onNoop/onFailure` 模板。

### trigger_session

本地 daemon 会话执行，等价于原 prompt 能力。

```json
{
  "execution": {
    "type": "trigger_session",
    "prompt": "检查状态",
    "thread": "per_run",
    "model": "gpt-5.2-codex",
    "effort": "high",
    "permissionMode": "readonly"
  }
}
```

`execution.thread` 只用于 `trigger_session`：

| 值 | 行为 |
|---|---|
| `per_run` | 每次 trigger run 使用独立本地会话 |
| `by_trigger` | 同一个 trigger 复用同一个本地会话 |

默认值：`per_run`。

建议内部 threadId 生成规则：

- `per_run`：`trigger:<triggerId>:<runId>`
- `by_trigger`：`trigger:<triggerId>`

规则：

- 必须有 `execution.prompt`。
- 不支持 `feedback.onReply/onNoop/onFailure`。
- 执行结果仍用于 audit 状态判定：success / noop / failure。
- feedback 只决定是否把最终结果送回原会话、指定会话或静默。

### target_session

目标会话执行：不在本地 daemon 会话中处理 prompt，而是把 prompt 直接投递到原会话或指定会话。

```json
{
  "execution": {
    "type": "target_session",
    "prompt": "生成日报",
    "model": "gpt-5.2-codex",
    "effort": "high",
    "permissionMode": "bypass"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#<agentAid>#<channelName>",
      "channelId": "group.xxx",
      "session": "main"
    }
  }
}
```

规则：

- 必须有 `execution.prompt`。
- 不允许 `execution.target`。目标统一读取 `feedback.strategy` 与 `feedback.target`。
- 不支持 `execution.thread`。
- 不支持 `feedback.onReply/onNoop/onFailure`。
- 不做本地结果分类，没有 reply/noop/failure 分支。
- `feedback.strategy` 只能是 `origin` 或 `target`；`silent` 不合法，因为等于不投递执行。
- `model/effort/permissionMode` 通过 `message.triggerMeta` 传入目标会话的 agent run。

完成语义与当前 inbound feedback 保持一致：

- 目标消息入队并处理完成：`completed`
- 入队失败、处理失败、超时或中断：`failed`
- 不产生 `noop`

## Feedback

Feedback 收敛为单策略：

```ts
type TriggerFeedbackStrategy = 'origin' | 'target' | 'silent';

interface TriggerFeedbackConfig {
  strategy: TriggerFeedbackStrategy;
  target?: TriggerFeedbackTarget;
  onReply?: { template?: string };
  onNoop?: { template?: string };
  onFailure?: { template?: string };
}

interface TriggerFeedbackTarget {
  channelKey: string;
  channelId: string;
  session: 'main' | 'thread';
  threadId?: string;
}
```

### strategy

| strategy | 含义 |
|---|---|
| `origin` | 投递到 trigger 创建来源会话 |
| `target` | 投递到 `feedback.target` 指定会话 |
| `silent` | 不投递反馈 |

`origin` 需要 TriggerOrigin 能恢复原始会话路由。现有 `origin` 只包含 `channel/peerId/sessionKey`，实现时应扩展为可直接定位原会话：

```ts
interface TriggerOrigin {
  channelKey: string;
  channelId: string;
  session: 'main' | 'thread';
  threadId?: string;
  peerId?: string;
  sessionKey?: string;
}
```

### target

`strategy=target` 时必须提供 `feedback.target`。

主会话：

```json
{
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#<agentAid>#<channelName>",
      "channelId": "user.agentid.pub",
      "session": "main"
    }
  }
}
```

指定话题会话：

```json
{
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#<agentAid>#<channelName>",
      "channelId": "group.xxx",
      "session": "thread",
      "threadId": "thread-abc"
    }
  }
}
```

规则：

- `target.session = main` 时不允许 `threadId`。
- `target.session = thread` 时必须有 `threadId`。
- 不支持通过 `name` 指定 thread。
- `channelKey` 中的 `<channelName>` 是渠道实例名，不是主会话。比如 `aun#bot.agentid.pub#primary` 的 `primary` 只是 AUN channel instance name。
- `target.session = main` 才表示目标是主会话。

### onReply/onNoop/onFailure

仅 `execution.type = script` 支持：

```json
{
  "execution": {
    "type": "script",
    "script": {
      "path": "scripts/check.js",
      "runtime": "node"
    }
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#<agentAid>#<channelName>",
      "channelId": "user.agentid.pub",
      "session": "main"
    },
    "onReply": {
      "template": "{{reply.text}}"
    },
    "onNoop": {
      "template": ""
    },
    "onFailure": {
      "template": "触发器失败：{{error.message}}"
    }
  }
}
```

默认模板：

```json
{
  "onReply": { "template": "{{reply.text}}" },
  "onNoop": { "template": "" },
  "onFailure": { "template": "触发器失败：{{error.message}}" }
}
```

`trigger_session` 与 `target_session` 不支持这三个分支字段。

## 完成判定

### script

1. 执行脚本。
2. 按脚本 reply outcome 分类：
   - `success` -> reply
   - `noop` -> noop
   - `error | timeout | interrupted` -> failure
3. 按 `feedback.strategy` 投递对应模板。
4. 任一投递失败则 run 为 `failed`。
5. 投递成功后，按执行 outcome 判定最终状态：
   - `success` -> `completed`
   - `noop` -> `noop`
   - `error | timeout | interrupted` -> `failed`

### trigger_session

1. 本地 daemon 会话执行 prompt。
2. 执行 outcome 用于 audit：
   - `success` -> `completed`
   - `noop` -> `noop`
   - `error | timeout | interrupted` -> `failed`
3. `feedback.strategy` 只决定是否投递最终结果：
   - `origin`：送回来源会话
   - `target`：送到指定会话
   - `silent`：不投递
4. 不支持自定义分支模板。

默认投递文本：

- success：`reply.text`
- noop：空文本，不发送
- failure：系统标准失败文本

### target_session

1. 根据 `feedback.strategy` 解析目标：
   - `origin`：来源会话
   - `target`：`feedback.target`
2. 把 `execution.prompt` 构造成 trigger 来源消息，带上：
   - `triggerMeta.triggerId`
   - `triggerMeta.runId`
   - `triggerMeta.modelOverride`
   - `triggerMeta.effortOverride`
   - `triggerMeta.permissionModeOverride`
3. 投递到目标会话队列，并等待目标消息处理完成。
4. 处理完成为 `completed`，失败为 `failed`。

## Slash/Menu 参数

### Source 参数

```bash
--once
--delay <30s|15m|2h|1d>
--at <ISO时间>
--cron "<表达式>"
--every <30s|15m|2h|1d>
--event <事件模式>
```

这些参数互斥。

### Execution 参数

```bash
--exec script|trigger-session|target-session
--prompt "..."
```

`script`：

```bash
--script-path ./scripts/check.js
--script-runtime node|python|bash
--script-args '{"k":"v"}'
--script-timeout 30s
```

`trigger_session`：

```bash
--trigger-thread per-run|by-trigger
```

`target_session` 不提供 execution target 参数。

### Feedback/Target 参数

```bash
--feedback origin|target|silent
--target-channel <channelKey>
--target-channel-id <chatId>
--target-session main|thread
--target-thread-id <threadId>
```

映射：

- `--feedback` -> `feedback.strategy`
- `--target-channel` -> `feedback.target.channelKey`
- `--target-channel-id` -> `feedback.target.channelId`
- `--target-session` -> `feedback.target.session`
- `--target-thread-id` -> `feedback.target.threadId`

### 废弃参数

以下旧参数不再支持，遇到直接报错：

```text
--mode
--session
--thread
--script
--runtime
--channel
--channelid
```

错误提示应明确指向新参数：

- `--session 已废弃，请使用 --feedback/--target-session 或 --trigger-thread`
- `--script 已废弃，请使用 --exec script --script-path`
- `--channel/--channelid 已废弃，请使用 --target-channel/--target-channel-id`

## 权限规则

基础规则：

- 非 admin 不允许创建或修改 `permissionMode=bypass`。
- 非 admin 不允许跨渠道投递 target。
- 非 admin 不允许指定非来源会话为 target。
- owner/admin 可以指定目标渠道、目标主会话或目标话题。
- 群话题创建继续遵守现有群 owner/admin 规则。

`target_session` 额外规则：

- 非 admin 只能使用 `feedback.strategy=origin`，或使用与 origin 完全一致的 `target`。
- `feedback.strategy=target` 且 target 跨 channel/channelId/thread 时，需要 owner/admin。
- `target.session=thread` 且目标 thread 不存在时，创建权限按目标群/渠道规则校验。

## Definition 示例

### once + target_session + 主会话

```json
{
  "$schema_version": 4,
  "id": "trig_daily_report",
  "agentAid": "bot.agentid.pub",
  "enabled": true,
  "name": "daily-report-once",
  "source": {
    "type": "once"
  },
  "execution": {
    "type": "target_session",
    "prompt": "生成日报",
    "model": "gpt-5.2-codex",
    "effort": "high",
    "permissionMode": "bypass",
    "onError": "fail",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#bot.agentid.pub#primary",
      "channelId": "group.xxx",
      "session": "main"
    }
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "run_once",
    "retry": {
      "maxAttempts": 0,
      "backoffMs": 30000
    }
  }
}
```

执行完成后：

```json
{
  "enabled": false
}
```

### target_session + 指定话题

```json
{
  "$schema_version": 4,
  "id": "trig_topic_followup",
  "agentAid": "bot.agentid.pub",
  "enabled": true,
  "name": "topic-followup",
  "source": {
    "type": "at",
    "at": "2026-07-08T09:00:00+08:00"
  },
  "execution": {
    "type": "target_session",
    "prompt": "继续检查这个话题里的待办事项",
    "permissionMode": "readonly",
    "onError": "fail",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#bot.agentid.pub#primary",
      "channelId": "group.xxx",
      "session": "thread",
      "threadId": "thread-abc"
    }
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "run_once",
    "retry": {
      "maxAttempts": 0,
      "backoffMs": 30000
    }
  }
}
```

### trigger_session + 来源会话反馈

```json
{
  "$schema_version": 4,
  "id": "trig_local_check",
  "agentAid": "bot.agentid.pub",
  "enabled": true,
  "name": "local-check",
  "source": {
    "type": "interval",
    "everyMs": 3600000
  },
  "execution": {
    "type": "trigger_session",
    "prompt": "检查项目健康状态并总结",
    "thread": "per_run",
    "permissionMode": "readonly",
    "onError": "retry",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "origin"
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "run_once",
    "retry": {
      "maxAttempts": 1,
      "backoffMs": 30000
    }
  }
}
```

### script + 分支模板 + 指定会话反馈

```json
{
  "$schema_version": 4,
  "id": "trig_script_health",
  "agentAid": "bot.agentid.pub",
  "enabled": true,
  "name": "script-health",
  "source": {
    "type": "cron",
    "expression": "0 */4 * * *",
    "timezone": "Asia/Shanghai"
  },
  "execution": {
    "type": "script",
    "script": {
      "path": "scripts/health.js",
      "runtime": "node",
      "timeoutMs": 30000
    },
    "onError": "retry",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "aun#bot.agentid.pub#primary",
      "channelId": "user.agentid.pub",
      "session": "main"
    },
    "onReply": {
      "template": "{{reply.text}}"
    },
    "onNoop": {
      "template": ""
    },
    "onFailure": {
      "template": "健康检查失败：{{error.message}}"
    }
  },
  "reliability": {
    "concurrency": "forbid",
    "missedPolicy": "run_once",
    "retry": {
      "maxAttempts": 2,
      "backoffMs": 30000
    }
  }
}
```

## Validation 摘要

通用：

- `source.type=once` 不允许调度值。
- `feedback.strategy=target` 必须有 `feedback.target`。
- `feedback.strategy!=target` 不允许 `feedback.target`。
- `feedback.target.session=main` 不允许 `threadId`。
- `feedback.target.session=thread` 必须有 `threadId`。

`script`：

- 必须有 `execution.script`。
- 不允许 `execution.prompt`。
- 不允许 `execution.thread`。
- 允许 `feedback.onReply/onNoop/onFailure`。

`trigger_session`：

- 必须有 `execution.prompt`。
- 允许 `execution.thread=per_run|by_trigger`。
- 不允许 `feedback.onReply/onNoop/onFailure`。

`target_session`：

- 必须有 `execution.prompt`。
- 不允许 `execution.thread`。
- 不允许 `execution.target`。
- 不允许 `feedback.onReply/onNoop/onFailure`。
- `feedback.strategy` 只允许 `origin|target`，不允许 `silent`。

## 迁移策略

不保留运行时兼容 alias。旧 definition 需要一次性迁移，否则按 schema validation error 处理。

建议迁移映射：

| 旧结构 | 新结构 |
|---|---|
| `execution.mode=script` | `execution.type=script` |
| `execution.mode=agent` + `session.strategy=isolated` | `execution.type=trigger_session` + `execution.thread=per_run` |
| `execution.mode=agent` + `session.strategy=thread` | `execution.type=trigger_session` + `execution.thread=by_trigger` |
| `feedback.kind=reply-origin` | `feedback.strategy=origin` |
| `feedback.kind=forward` + 单 target | `feedback.strategy=target` + `feedback.target` |
| `feedback.kind=silent` | `feedback.strategy=silent` |

无法无损迁移的旧能力：

- 多个 `targets[]`。
- 不同分支投递到不同 target。
- `trigger_session` 的自定义 `onReply/onNoop/onFailure` 模板。
- 通过 name 指定 thread。

这些旧配置应迁移时报错，要求手工拆分为多个 trigger 或改为新单策略结构。

## 实现落点

主要改动模块：

- `src/trigger/types.ts`：新增 V4 types，加入 `once`、三种 execution type、单策略 feedback。
- `src/trigger/validation.ts`：实现 V4 normalize/validate，拒绝旧参数与旧 schema。
- `src/trigger/parser.ts`：重做 `/trigger set/update` 参数解析。
- `src/trigger/scheduler.ts`：增加 `once` 调度、`target_session` 执行分支、完成后自动 disable。
- `src/trigger/feedback.ts`：删除 `kind/targets[]` 运行时模型，改为 strategy dispatch。
- `src/core/command/command-handler.ts`：更新 slash trigger 注册、更新、展示字段。
- `src/core/command/menu-handler.ts`：更新 menu action/update args。
- `docs` 与 `kits/docs/evolclaw/trigger.md`：同步用户文档。

建议测试：

- `once` 创建后立即执行，完成后 `enabled=false`。
- `trigger_session thread=per_run` 每次 run 使用不同 daemon thread。
- `trigger_session thread=by_trigger` 同一 trigger 复用 daemon thread。
- `target_session strategy=target session=main` 投递到主会话并等待处理完成。
- `target_session strategy=target session=thread` 投递到指定话题。
- `target_session strategy=silent` validation error。
- `trigger_session` 携带 `onReply/onNoop/onFailure` validation error。
- `script` 分支模板渲染正确。
- 非 admin 跨 target 被拒绝。
- 非 admin `permissionMode=bypass` 被拒绝。
