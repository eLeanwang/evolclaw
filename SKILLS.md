---
name: evolclaw
version: 1.2.0
description: EvolClaw 完整使用手册 — CLI 命令参考 + 运行时控制 (ctl) + 定时触发器 (trigger)
trigger: 用户询问或需要使用 evolclaw CLI、切换模型、调整推理强度、查看运行状态、压缩上下文、检查通道健康、管理权限模式、重启服务、重连渠道、注册定时触发器等
---

# EvolClaw

EvolClaw 是连接 Claude Agent SDK 和消息渠道（飞书 / 微信 / AUN / 钉钉 / QQ / 企业微信）的 AI Agent 网关，支持多项目会话管理。

本文档分三部分：

1. [CLI 命令](#cli-命令) — 终端命令参考
2. [Ctl 运行时控制](#ctl-运行时控制) — Agent 自主管理指令（仅在 evolclaw 托管环境中可用）
3. [Trigger 定时触发器](#trigger-定时触发器) — 设置延迟或定时任务

---

## CLI 命令

### 全局选项

```
evolclaw --version / -v / -V    查看版本号
```

### 服务生命周期

```
evolclaw start              启动服务（默认命令）
evolclaw stop               停止服务
evolclaw restart            重启服务（含自动升级检查）
evolclaw status             查看运行状态、进程信息、会话统计、渠道连接状态
evolclaw restart-monitor    启动重启监控守护进程
```

### 日志与诊断

```
evolclaw logs [选项]
  --level error|warn    只显示指定级别及以上
  --module <name>       只显示指定模块
  --raw                 原始输出，不着色
  --no-color            禁用颜色输出

evolclaw watch          汇总监控 logs/ 下所有 .log 文件
evolclaw diagnose       诊断启动环境
```

### 初始化

```
evolclaw init [渠道]

渠道:
  aun         AUN 交互式配置（默认）
  feishu      飞书扫码登录
  wechat      微信扫码登录
  dingtalk    钉钉扫码登录
  qqbot       QQ 机器人扫码绑定
  wecom       企业微信 AI Bot 配置

非交互式选项:
  --non-interactive
  --default-path <path>
  --channel <name>
  --aun-aid <aid>
  --aun-owner <aid>

示例:
  evolclaw init
  evolclaw init aun
  evolclaw init --non-interactive --channel aun \
    --aun-aid mybot.agentid.pub --aun-owner me.agentid.pub \
    --default-path ~/projects/default
```

### Agent 管理

```
evolclaw agent                      列出所有 agent
evolclaw agent <name>               查看指定 agent 详情
evolclaw agent reload <name>        热重载 agent 配置

evolclaw agent new <name> [选项]
  --baseagent <claude|codex|gemini|hermes>     必填
  --project <absolute-path>                    必填

  渠道选项（至少一个）:
    --aun-aid <aid> --aun-owner <aid>
    --feishu-app-id <id> --feishu-app-secret <secret>
    --wechat-token <token>
    --wecom-bot-id <id> --wecom-secret <secret>
    --dingtalk-client-id <id> --dingtalk-client-secret <secret>
    --qqbot-app-id <id> --qqbot-client-secret <secret>

  行为选项:
    --chatmode-private <interactive|proactive>   默认: interactive
    --chatmode-group <interactive|proactive>     默认: proactive

  --non-interactive

示例:
  evolclaw agent new mybot --baseagent claude \
    --project ~/projects/mybot \
    --aun-aid mybot.agentid.pub --aun-owner me.agentid.pub
```

### AID 身份管理

```
evolclaw aid list                       列出本地所有 AID
evolclaw aid show <aid>                 查看 AID 详情
evolclaw aid new <aid>                  创建新 AID 身份
evolclaw aid delete <aid>               删除 AID
evolclaw aid lookup <aid>               查询 AUN 网络上的 AID 信息
evolclaw aid agentmd put <aid>          上传本地 agent.md 到 AUN 网络
evolclaw aid agentmd get <aid>          从 AUN 网络获取 agent.md
```

### RPC 调用

```
evolclaw rpc --as <aid> --params <json|jsonl-file>

选项:
  --as <aid>          发送方 AID（必填）
  --params <value>    JSON 字符串或 .jsonl 文件路径（必填）

示例:
  evolclaw rpc --as alice.agentid.pub \
    --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'
```

### 存储管理

```
evolclaw storage upload <aid> <local-path> [remote-path]
evolclaw storage download <aid> <remote-path> [local-path]
evolclaw storage ls <aid> [prefix]
evolclaw storage rm <aid> <remote-path>
evolclaw storage quota <aid>
```

### 项目管理

```
evolclaw mv <old-path> <new-path>        迁移项目目录（保留会话数据）
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOLCLAW_HOME` | `~/.evolclaw` | 数据目录 |
| `LOG_LEVEL` | `INFO` | 日志级别 |
| `MESSAGE_LOG` | `true` | 是否记录消息日志 |
| `EVENT_LOG` | `true` | 是否记录事件日志 |

---

## Ctl 运行时控制

通过 `evolclaw ctl <command> [args]` 管理运行时配置。仅在 evolclaw 托管环境中可用（`EVOLCLAW_SESSION_ID` 已设置）。

### 查询类（所有用户）

- `evolclaw ctl help` — 显示帮助
- `evolclaw ctl status` — 显示会话状态
- `evolclaw ctl check` — 检查渠道健康状态

### 配置类（管理员）

- `evolclaw ctl model` — 查看当前模型和可选列表
- `evolclaw ctl model <model-id>` — 切换模型（如 `opus`, `sonnet`, `haiku`）
- `evolclaw ctl effort` — 查看当前推理强度
- `evolclaw ctl effort <low|medium|high|max>` — 切换推理强度
- `evolclaw ctl compact` — 压缩当前会话上下文
- `evolclaw ctl chatmode [interactive|proactive]` — 查看/切换会话模式

### 权限类

- `evolclaw ctl perm` — 查看当前权限模式（管理员）
- `evolclaw ctl perm <mode>` — 切换权限模式（仅 owner）

### 项目

- `evolclaw ctl bind <path>` — 注册项目目录（不切换当前会话）

### 消息（仅 owner）

- `evolclaw ctl send "<消息>"` — 主动发送文本消息（proactive 模式）
- `evolclaw ctl file [channel] <路径>` — 发送项目内文件（仅限项目目录内）
- `evolclaw ctl activity <all|dm|owner|none>` — 查看/控制中间输出显示模式

### 运维（仅 owner）

- `evolclaw ctl agentmd` — 查看当前 agent.md
- `evolclaw ctl agentmd put` — 发布本地 agent.md
- `evolclaw ctl agentmd set <内容>` — 直接设置 agent.md 内容
- `evolclaw ctl aid` — 列出所有 AUN 实例及连接状态
- `evolclaw ctl aid new <aid>` — 创建新 AID 并热加载（仅 AUN 通道）
- `evolclaw ctl restart` — 重启服务（中断所有会话，慎用）
- `evolclaw ctl restart <channel>` — 重连指定渠道（管理员可用）

### 使用场景

- Agent 自主判断需要切换模型、调整配置
- 用户自然语言指示（如"切到 opus"、"压缩上下文"）
- Proactive 模式下发送消息给用户（文本输出被静默丢弃，必须用 `ctl send`）

### 注意事项

- 仅在 evolclaw 托管环境中可用（`EVOLCLAW_SESSION_ID` 已设置）
- 权限继承当前会话用户角色（owner / admin / guest）
- `compact` 不能在活跃流期间执行
- `file` 只能发送项目目录下的文件（路径越界会被拒绝）
- `restart` 会中断所有会话

### 使用示例

```bash
evolclaw ctl model opus           # 切换到 opus
evolclaw ctl effort low           # 降低推理强度
evolclaw ctl compact              # 压缩上下文
evolclaw ctl status               # 查看服务状态
evolclaw ctl chatmode proactive   # 切换为主动模式
evolclaw ctl send "你好"          # proactive 模式发送消息
```

---

## Trigger 定时触发器

通过 `/trigger` 命令设置延迟或定时任务，系统在指定时间重新激活 Agent 执行。

### 注册

```
/trigger set --delay <时长> --prompt "<任务内容>"
/trigger set --at <ISO时间> --prompt "<任务内容>"
/trigger set --cron <表达式> --prompt "<任务内容>"
```

**时间格式：**
- `--delay`：`30m`、`2h`、`1d`、`2h30m`
- `--at`：ISO 格式，如 `2026-05-15T09:00`
- `--cron`：标准 cron 表达式，如 `0 9 * * *`（每天 9 点）

### 可选参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--channel <实例名>` | 目标通道实例 | 当前通道 |
| `--channelid <id>` | 目标对话 ID | 当前对话 |
| `--thread <id>` | 目标 thread（与 --session 互斥） | 无 |
| `--session latest` | 续接最后活跃会话（用户可见输出） | 默认 |
| `--session silent` | 新建独立会话静默执行 | - |
| `--name <标识>` | 触发器名称 | 自动生成 |
| `--agent <名称>` | 目标 agent | 当前 agent |

### 管理

```
/trigger              查看活跃触发器
/trigger list         查看所有触发器（含历史）
/trigger update <名称|ID> <参数>   修改触发器
/trigger cancel <名称|ID>          取消触发器
```

### 修改触发器

```
/trigger update <名称|ID> [--delay <时长>] [--at <ISO时间>] [--cron <表达式>]
                          [--prompt "<任务内容>"] [--name <新名称>]
                          [--session latest|silent] [--agent <名称>]
                          [--channel <实例名> --channelid <id>]
```

至少指定一个修改参数。未指定的字段保持不变。

### 会话策略

- **latest**：续接已有会话，输出对用户可见。适合提醒、跟进对话。
- **silent**：新建独立 autonomous 会话，不打扰用户。适合后台清理、扫描、生成文件。

### 权限

- 所有用户可注册触发器
- cancel 自己的触发器：按名称或 ID
- cancel 他人的触发器：需 owner/admin 权限

### 示例

```
/trigger set --delay 30m --prompt "检查构建状态并汇报"
/trigger set --at 2026-05-16T09:00 --prompt "生成日报" --session silent
/trigger set --cron "0 */6 * * *" --prompt "检查服务健康" --session silent --name health-check
/trigger update health-check --cron "0 */4 * * *"
/trigger update health-check --prompt "检查服务健康并清理过期日志" --name health-check-cleanup
/trigger cancel health-check-cleanup
```

### 注意事项

- `--thread` 与 `--session` 互斥
- `--channel` 与 `--channelid` 必须同时指定或同时省略
- delay/at 类型触发一次后自动归档；cron 类型持续触发直到 cancel
- 修改触发器时，未指定的字段保持不变
- 修改 cron 触发器的时间表达式会立即重新计算下次触发时间
