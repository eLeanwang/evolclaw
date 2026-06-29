# ec trigger — 定时与事件触发器

创建、查看、启停、删除和手动运行本机 daemon 管理的 trigger。触发词：触发器/定时任务/cron/提醒/定时检查/自动执行/巡检/禁用 trigger/删除 trigger。

> `ec trigger` 通过 daemon IPC 直接操作 TriggerRuntimeScheduler，不依赖当前会话。命令里的 `<aid>` 是 trigger 所属 agent AID。

## 什么时候用

- 用户要求“稍后/每天/每小时/定时/周期性”执行任务
- 需要无人值守巡检、升级检查、日报、仓库同步
- 需要让任务成功后自己停止后续调度
- 需要基于系统事件触发时，先读 `triggers/event-catalog.md`

不要用 trigger 代替当前会话内的即时动作；一次性马上执行直接处理当前请求。

## 查询

```bash
ec trigger list --agent <aid>
ec trigger list --agent <aid> --all
ec trigger show --agent <aid> <triggerId>
ec trigger show --agent <aid> <triggerId> --json
```

`list` 默认只显示 enabled trigger。排查历史、禁用项或已达到 limits 的 trigger 时加 `--all`。

## 创建

Flag 模式适合 agent 现场创建常规 trigger：

```bash
ec trigger create --agent <aid> \
  --cron '0 9 * * *' \
  --prompt '生成昨日摘要并发送给我' \
  --channel <channelKey> --channelid <channelId> \
  --name daily-summary \
  --enable
```

支持的时间来源：

```bash
--delay 30m
--at 2026-06-28T09:00:00+08:00
--cron '0 9 * * *'
--every 4h
```

`--cron` 表达式必须加引号，避免被 shell 拆成多个参数。`--every` 是固定间隔，`--cron` 是日历调度。

## 目标与会话

创建时必须指定反馈目标：

```bash
--channel <channelKey> --channelid <channelId>
```

会话策略：

```bash
--session latest   # 使用目标渠道最近会话
--session current  # 仅 slash 命令上下文可用；CLI flag 模式没有当前会话
--session thread   # 固定 thread，上下文可跨次累积
```

常规定时巡检优先用隔离会话；需要记住上次执行上下文时再用 thread。

## 权限

无人值守 trigger 不适合 `request`。需要写文件、git、安装升级、重启服务、管理 trigger 时应显式使用：

```bash
--permission bypass
```

owner/admin 通过 `/trigger set` 创建时默认使用 `bypass`；非 admin 默认 `readonly`，不能提权到 `bypass`。

## 执行边界

周期任务建议设置系统边界，避免无限运行：

```bash
--max-runs 10
--max-duration 3d
```

任一边界命中后，scheduler 会禁用后续调度，不中断当前 run。

## 反馈与模板

默认模板会输出 `reply.text`，再兜底 `result.text` 或 `error.message`。通常不要显式设置 template；如果写完整 JSON 定义，也不要把 template 写成 `null` 或空字符串。

可用占位符示例：

```text
{{reply.text}}
{{trigger.name}}
{{reply.meta.durationMs}}
{{error.message}}
{{date}} {{time}}
```

script trigger 返回 `[[NOOP]]` 或 `outcome: "noop"` 时走 noop 分支；默认 noop 静默。

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
| `delete` | 删除整个 trigger 目录 | 清理 | 不中断 | 不可恢复 |

`delete` 不需要先执行 `disable/cancel`；它内部会先清理 timer/event/schedule，再删除定义。

## 手动运行

```bash
ec trigger run --agent <aid> <triggerId>
ec trigger run --agent <aid> <triggerId> --dry-run
```

`--dry-run` 不写 active 状态、不写正式 audit、不执行真实副作用，适合验证 prompt/template。

## 从文件导入

复杂 trigger 使用 V3 JSON：

```bash
ec trigger create --file ./trigger.json --enable
ec trigger update --agent <aid> <triggerId> --file ./trigger.json
```

运行时只接受 `$schema_version: 3`。旧 V2 trigger 必须先离线迁移，不能依赖运行时兼容。

## 常用例子

一次性提醒：

```bash
ec trigger create --agent <aid> --delay 30m \
  --prompt '提醒用户检查部署状态' \
  --channel <channelKey> --channelid <channelId> \
  --name deploy-reminder --enable
```

每天巡检：

```bash
ec trigger create --agent <aid> --cron '30 9 * * *' \
  --prompt '检查服务状态并汇报异常；无异常输出 [[NOOP]]' \
  --channel <channelKey> --channelid <channelId> \
  --name daily-health-check --enable
```

定时尝试升级，最多 10 次或 3 天：

```bash
ec trigger create --agent <aid> --every 4h \
  --max-runs 10 --max-duration 3d \
  --permission bypass \
  --prompt '尝试执行升级检查；成功后调用 ec trigger disable --agent <aid> auto-updater；无变化输出 [[NOOP]]' \
  --channel <channelKey> --channelid <channelId> \
  --name auto-updater --enable
```

硬删除：

```bash
ec trigger delete --agent <aid> auto-updater
```

## 相关文档

- event source 可监听事件：`$KITS_DOCS/triggers/event-catalog.md`
- trigger V3 设计与 daemon 会话：`$PACKAGE_ROOT/docs/trigger-daemon-conversation.md`
- limits / disable / delete 语义：`$PACKAGE_ROOT/docs/trigger-limits-feature-v2.md`
