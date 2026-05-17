# EvolClaw CLI 命令参考

## 如何重建本文档

当 CLI 命令有增删改时，按以下步骤重新生成：

1. 读取 `src/cli.ts`，找到所有顶级命令（`case 'xxx':` 分支，位于文件末尾约 2865 行起）
2. 对每个命令，找到对应的 `cmdXxx()` 函数，读取其 help 字符串（`console.error(...)` 或 `console.log(...)`）
3. 按本文档现有结构重写各命令的用法、选项、示例
4. 环境变量来源：搜索 `process.env.` 获取所有用到的环境变量

**关键文件**：`src/cli.ts`（单文件，所有命令定义都在这里）

---

## 全局选项

```
evolclaw --version / -v / -V    查看版本号
```

---

## 服务生命周期

### `start`
启动服务（默认命令）。
```
evolclaw start
```

### `stop`
停止服务。
```
evolclaw stop
```

### `restart`
重启服务（含自动升级检查）。
```
evolclaw restart
```

### `status`
查看运行状态、进程信息、会话统计、渠道连接状态。
```
evolclaw status
```

### `restart-monitor`
启动重启监控守护进程。
```
evolclaw restart-monitor
```

---

## 日志与诊断

### `logs`
实时查看日志（着色渲染）。
```
evolclaw logs [选项]

选项:
  --level error|warn    只显示指定级别及以上
  --module <name>       只显示指定模块
  --raw                 原始输出，不着色
  --no-color            禁用颜色输出
```

### `watch`
汇总监控 logs/ 下所有 .log 文件的实时输出。
```
evolclaw watch
```

### `diagnose`
诊断启动环境（配置、进程、渠道连接）。
```
evolclaw diagnose
```

---

## 初始化

### `init`
创建配置文件，支持多渠道交互式或非交互式初始化。
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
  --non-interactive           启用非交互模式
  --default-path <path>       项目目录
  --channel <name>            渠道类型（默认: aun）
  --aun-aid <aid>             AUN Agent ID
  --aun-owner <aid>           Owner AID

示例:
  evolclaw init
  evolclaw init aun
  evolclaw init --non-interactive --channel aun --aun-aid mybot.agentid.pub --aun-owner me.agentid.pub --default-path ~/projects/default
```

---

## Agent 管理

### `agent`
管理 EvolAgent 实例。
```
evolclaw agent                  列出所有 agent
evolclaw agent <name>           查看指定 agent 详情
evolclaw agent reload <name>    热重载 agent 配置

evolclaw agent new <name> [选项]
  --baseagent <claude|codex|gemini|hermes>   必填，AI 后端
  --project <absolute-path>                  必填，项目目录

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

  --non-interactive    非交互模式

示例:
  evolclaw agent new mybot --baseagent claude --project ~/projects/mybot --aun-aid mybot.agentid.pub --aun-owner me.agentid.pub
```

---

## AID 身份管理

### `aid`
管理 AUN Agent 身份（AID）。
```
evolclaw aid list                       列出本地所有 AID
evolclaw aid show <aid>                 查看 AID 详情
evolclaw aid new <aid>                  创建新 AID 身份
evolclaw aid delete <aid>               删除 AID
evolclaw aid lookup <aid>               查询 AUN 网络上的 AID 信息
evolclaw aid agentmd put <aid>          上传本地 agent.md 到 AUN 网络
evolclaw aid agentmd get <aid>          从 AUN 网络获取 agent.md

示例:
  evolclaw aid list
  evolclaw aid show mybot.agentid.pub
  evolclaw aid new reviewer.agentid.pub
  evolclaw aid agentmd put mybot.agentid.pub
  evolclaw aid agentmd get someone.agentid.pub
```

---

## 运行时控制

### `ctl`
向运行中的 evolclaw 发送控制指令（需在 evolclaw 托管环境中，即 `EVOLCLAW_SESSION_ID` 已设置）。
```
查询:
  evolclaw ctl status                           查看会话状态
  evolclaw ctl check                            检查渠道健康状态
  evolclaw ctl help                             显示帮助

配置:
  evolclaw ctl model [opus|sonnet|haiku]        查看/切换模型
  evolclaw ctl effort [low|medium|high]         查看/切换推理强度
  evolclaw ctl compact                          压缩当前会话上下文
  evolclaw ctl chatmode [interactive|proactive] 查看/切换会话模式
  evolclaw ctl activity [all|dm|owner|none]     查看/控制中间输出显示模式
  evolclaw ctl perm [mode]                      查看/切换权限模式

项目:
  evolclaw ctl bind <path>                      注册项目目录（不切换当前会话）

消息:
  evolclaw ctl send <消息内容>                  主动发送文本消息（proactive 模式）
  evolclaw ctl file [channel] <path>            发送项目内文件

运维:
  evolclaw ctl agentmd [put|set <内容>]         查看/管理 agent.md（仅 AUN 通道）
  evolclaw ctl restart [channel]                重启服务或重连指定渠道

示例:
  evolclaw ctl model sonnet
  evolclaw ctl effort high
  evolclaw ctl compact
  evolclaw ctl chatmode proactive
  evolclaw ctl send "你好"
```

---

## RPC 调用

### `rpc`
以指定 AID 身份向 AUN 网络发送 RPC 请求。
```
evolclaw rpc --as <aid> --params <json|jsonl-file>

选项:
  --as <aid>          发送方 AID（必填）
  --params <value>    JSON 字符串或 .jsonl 文件路径（必填）

示例:
  evolclaw rpc --as alice.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'
  evolclaw rpc --as alice.agentid.pub --params calls.jsonl
```

---

## 存储管理

### `storage`
管理 AUN 存储空间。
```
evolclaw storage upload <aid> <local-path> [remote-path]    上传文件
evolclaw storage download <aid> <remote-path> [local-path]  下载文件
evolclaw storage ls <aid> [prefix]                          列出文件
evolclaw storage rm <aid> <remote-path>                     删除文件
evolclaw storage quota <aid>                                查询配额
```

---

## 项目管理

### `mv`
迁移项目目录（保留会话数据）。
```
evolclaw mv <old-path> <new-path>
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOLCLAW_HOME` | `~/.evolclaw` | 数据目录 |
| `LOG_LEVEL` | `INFO` | 日志级别 |
| `MESSAGE_LOG` | `true` | 是否记录消息日志 |
| `EVENT_LOG` | `true` | 是否记录事件日志 |
