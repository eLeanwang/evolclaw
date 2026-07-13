# ec trigger - 定时与事件触发器

创建、查看、启停、删除和手动运行本机 daemon 管理的 trigger。触发词：触发器/定时任务/cron/提醒/定时检查/自动执行/巡检/禁用 trigger/删除 trigger。

> `ec trigger` 通过 daemon IPC 直接操作 TriggerRuntimeScheduler，不依赖当前会话。命令里的 `<aid>` 是 trigger 所属 agent AID。

## 什么时候用

- 用户要求“稍后/每天/每小时/定时/周期性”执行任务
- 需要无人值守巡检、升级检查、日报、仓库同步
- 需要基于系统事件触发时，先读 `evolclaw/event.md`
- 需要一次性立即排队执行时，使用 `--once`

不要用 trigger 代替当前会话内的即时动作；一次性马上执行直接处理当前请求。

## 查询

```bash
ec trigger list --agent <aid>
ec trigger list --agent <aid> --all
ec trigger show --agent <aid> <triggerId>
ec trigger show --agent <aid> <triggerId> --json
ec trigger history --agent <aid> [triggerId]
ec trigger history --agent <aid> [triggerId] --limit 500 --json
```

`list` 默认只显示 enabled trigger。排查历史、禁用项或已达到 limits 的 trigger 时加 `--all`。

`history` 查询 `data/triggers/<aid>/history.jsonl` 中的长期审计事件，包括定义创建、完整更新快照、启停、删除 tombstone 和 run 终态。删除 trigger 目录后，历史仍保留。

## 创建

Flag 模式适合 agent 现场创建常规 trigger：

```bash
ec trigger create --agent <aid> \
  --cron '0 9 * * *' \
  --exec target-session \
  --prompt '生成昨日摘要并发送给我' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --model <model> --effort high \
  --name daily-summary \
  --enable
```

CLI flag 模式必须显式指定 `--target-channel` 和 `--target-channel-id`，并生成 `feedback.strategy=target`。需要 `origin` 或 `silent` feedback 时，用 `/trigger` 或 `--file` 导入 V4 JSON。

支持的触发来源：

```bash
--once
--delay 30m
--at 2026-06-28T09:00:00+08:00
--cron '0 9 * * *'
--every 4h
--event 'message:received'
```

这些来源互斥，只能指定一个。`--cron` 表达式必须加引号，避免被 shell 拆成多个参数。`--every` 是固定间隔，`--cron` 是日历调度。`--once` 创建后立即进入一次 run，完成后自动禁用。

`--event` 基于 EventBus 事件触发，事件模式支持精确事件名、命名空间前缀和全量：`message:received`、`message:*`、`*`。flag 模式只支持设置 `eventPattern`；需要按 payload 字段过滤时，使用 V4 JSON 的 `source.filter.match`，再通过 `--file` 导入。事件清单、payload 字段和过滤操作见 `$KITS_DOCS/evolclaw/event.md`。

## 执行类型

V4 用 `execution.type` 区分执行位置：

```bash
--exec script
--exec trigger-session
--exec target-session
```

`target-session` 是默认值：把 `--prompt` 当作一条 trigger 来源消息投递进目标会话队列，并等待该会话处理完成。

`trigger-session` 在 daemon 内部 trigger 会话执行 prompt，再把最终结果按 feedback 投递：

```bash
--exec trigger-session \
--prompt '检查服务状态并总结异常' \
--trigger-thread per-run
```

`--trigger-thread per-run` 每次 run 使用独立 trigger 会话；`--trigger-thread by-trigger` 同一个 trigger 复用同一条 trigger 会话。

`script` 执行随 trigger 一起保存的脚本：

```bash
--exec script \
--script-path scripts/check.js \
--script-runtime node \
--script-timeout 30s \
--script-args '{"scope":"daily"}'
```

`script` 不使用 `--prompt`。脚本路径必须在 trigger 目录内；通过 `--file` 导入目录时，脚本文件会随 definition 一起上传。

## 目标与反馈

目标会话字段：

```bash
--target-channel <channelKey>
--target-channel-id <channelId>
--target-session main
--target-session thread --target-thread-id <threadId>
```

V4 feedback 是单策略：

- `origin`：送回创建 trigger 的来源会话
- `target`：送到 `feedback.target`
- `silent`：不投递最终结果

`target-session` 执行类型只支持 `origin` 或 `target`，因为它本身就是投递到一个会话执行；`script` 和 `trigger-session` 可以使用 `silent`。

默认反馈文本：

- success：`reply.text`
- noop：空文本，不发送
- failure：标准失败文本

通常不要显式设置 template。只有 `script` 支持 `feedback.onReply/onNoop/onFailure` 分支模板；`trigger-session` 和 `target-session` 不支持自定义分支模板。

可用占位符示例：

```text
{{reply.text}}
{{trigger.name}}
{{reply.meta.durationMs}}
{{error.message}}
{{date}} {{time}}
```

script trigger 返回 `[[NOOP]]` 或 `outcome: "noop"` 时走 noop 分支；默认 noop 静默。

## 模型与权限

执行模型可按 trigger 单独覆盖：

```bash
--model <模型>
--effort <low|medium|high|xhigh|max>
```

`--model` / `--effort` 只覆盖本 trigger 执行时传给 base agent 的模型与推理强度。baseagent 不在 trigger 中指定，始终沿用该 trigger 所属 agent 当前 active baseagent；未设置时继承当前关系级 / agent 级 / 全局模型配置。

无人值守 trigger 不适合 `request`。需要写文件、git、安装升级、重启服务、管理 trigger 时应显式使用：

```bash
--permission bypass
```

owner/admin 通过 `/trigger set` 创建时默认使用 `bypass`；非 admin 默认 `readonly`，不能提权到 `bypass`，也不能跨渠道或跨会话指定 target。

## 执行边界

周期任务建议设置系统边界，避免无限运行：

```bash
--max-runs 10
--max-duration 3d
```

任一边界命中后，scheduler 会禁用后续调度，不中断当前 run。

## 管理

```bash
ec trigger enable --agent <aid> <triggerId>
ec trigger disable --agent <aid> <triggerId>
ec trigger cancel --agent <aid> <triggerId>   # disable 的兼容别名
ec trigger delete --agent <aid> <triggerId>
```

语义区别：

| 命令 | 定义文件 | 后续调度 | 当前 run | 可恢复 |
| --- | --- | --- | --- | --- |
| `disable` / `cancel` | 保留，写 `enabled: false` | 清理 | 不中断 | 可 `enable` |
| `delete` | 删除整个 trigger 运行态目录，保留 history tombstone | 清理 | 不中断 | 定义不可恢复，审计可复查 |

`delete` 不需要先执行 `disable/cancel`；它内部会先清理 timer/event/schedule，再删除定义。

## 手动运行

```bash
ec trigger run --agent <aid> <triggerId>
ec trigger run --agent <aid> <triggerId> --dry-run
```

`--dry-run` 不写 active 状态、不写正式 audit、不执行真实副作用，适合验证 prompt/template。

## 审计存储

```text
data/triggers/<aid>/<triggerId>/trigger.json
data/triggers/<aid>/<triggerId>/active.json
data/triggers/<aid>/history.jsonl
logs/trigger-runs.log
```

- `history.jsonl` 是长期 append-only 审计真相源，默认不自动清理。
- 旧版 done 归档行保持可读，不会在升级时重写。
- `trigger-runs.log` 是短期运维日志，按天轮转并保留 7 天。
- `show` 的 recent runs、运行统计和 `history` 命令读取长期历史。
- 启动时会把仍保留的旧 `trigger-runs*.log` 幂等补导入 `history.jsonl`。

## 从文件导入

复杂 trigger 使用 V4 JSON：

```bash
ec trigger create --file ./trigger.json --enable
ec trigger create --file ./trigger-dir --enable
ec trigger update --agent <aid> <triggerId> --file ./trigger.json
```

运行时只接受 `$schema_version: 4`。

### target-session 示例

```json
{
  "$schema_version": 4,
  "agentAid": "<aid>",
  "enabled": true,
  "name": "daily-summary",
  "source": {
    "type": "cron",
    "expression": "0 9 * * *",
    "timezone": "Asia/Shanghai"
  },
  "execution": {
    "type": "target_session",
    "prompt": "生成昨日摘要并发送给我",
    "model": "<model>",
    "effort": "high",
    "permissionMode": "bypass",
    "onError": "fail",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "<channelKey>",
      "channelId": "<channelId>",
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

### trigger-session 示例

```json
{
  "$schema_version": 4,
  "agentAid": "<aid>",
  "enabled": true,
  "name": "hourly-health-check",
  "origin": {
    "channelKey": "<channelKey>",
    "channelId": "<channelId>",
    "session": "main"
  },
  "source": {
    "type": "interval",
    "everyMs": 3600000
  },
  "execution": {
    "type": "trigger_session",
    "prompt": "检查服务状态并总结异常；无异常输出 [[NOOP]]",
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

### script 示例

```json
{
  "$schema_version": 4,
  "agentAid": "<aid>",
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
      "channelKey": "<channelKey>",
      "channelId": "<channelId>",
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

## 事件触发

简单事件触发可直接用 flag 模式：

```bash
ec trigger create --agent <aid> --event 'message:received' \
  --exec target-session \
  --prompt '检查收到的消息是否需要自动跟进；无动作输出 [[NOOP]]' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name on-message-received --enable
```

监听某个命名空间下的所有事件：

```bash
ec trigger create --agent <aid> --event 'task:*' \
  --exec target-session \
  --prompt '任务完成或失败后生成简短诊断；无动作输出 [[NOOP]]' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name on-task-events --enable
```

flag 模式不能配置过滤条件。需要根据事件 payload 过滤时，写完整 V4 JSON：

```json
{
  "$schema_version": 4,
  "agentAid": "<aid>",
  "enabled": true,
  "name": "on-important-message",
  "source": {
    "type": "event",
    "eventPattern": "message:received",
    "filter": {
      "match": {
        "channel": "<channelKey>",
        "channelId": "<channelId>",
        "content": { "$regex": "日报|告警|失败" }
      }
    }
  },
  "execution": {
    "type": "target_session",
    "prompt": "根据事件内容判断是否需要处理；无动作输出 [[NOOP]]",
    "permissionMode": "readonly",
    "onError": "retry",
    "noopSentinel": "[[NOOP]]"
  },
  "feedback": {
    "strategy": "target",
    "target": {
      "channelKey": "<channelKey>",
      "channelId": "<channelId>",
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

`source.filter.match` 的 key 是 payload 字段路径，支持等值、`$in`、`$regex`、数值比较和 `$exists`。例如 `message:received` 可过滤 `channel`、`channelId`、`content`、`userId`、`sessionId`；完整字段以事件目录为准。

## 常用例子

一次性提醒：

```bash
ec trigger create --agent <aid> --delay 30m \
  --exec target-session \
  --prompt '提醒用户检查部署状态' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name deploy-reminder --enable
```

创建后立即执行一次：

```bash
ec trigger create --agent <aid> --once \
  --exec target-session \
  --prompt '生成一次当前状态摘要' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name one-shot-summary --enable
```

每天巡检：

```bash
ec trigger create --agent <aid> --cron '30 9 * * *' \
  --exec target-session \
  --prompt '检查服务状态并汇报异常；无异常输出 [[NOOP]]' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name daily-health-check --enable
```

复用 trigger 会话做周期跟踪：

```bash
ec trigger create --agent <aid> --every 4h \
  --exec trigger-session \
  --trigger-thread by-trigger \
  --prompt '继续跟踪升级状态并输出最新结论；无变化输出 [[NOOP]]' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name upgrade-watch --enable
```

定时尝试升级，最多 10 次或 3 天：

```bash
ec trigger create --agent <aid> --every 4h \
  --max-runs 10 --max-duration 3d \
  --permission bypass \
  --model <model> --effort high \
  --exec target-session \
  --prompt '尝试执行升级检查；成功后调用 ec trigger disable --agent <aid> auto-updater；无变化输出 [[NOOP]]' \
  --target-channel <channelKey> --target-channel-id <channelId> \
  --target-session main \
  --name auto-updater --enable
```

硬删除：

```bash
ec trigger delete --agent <aid> auto-updater
```

## 相关文档

- event source 可监听事件：`$KITS_DOCS/evolclaw/event.md`
- trigger V4 执行与反馈设计：`$PACKAGE_ROOT/docs/trigger-v4-execution-feedback-design.md`
- limits / disable / delete 语义：`$PACKAGE_ROOT/docs/trigger-limits-feature-v2.md`
