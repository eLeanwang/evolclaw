# evolclaw CLI 参考手册

## 服务管理

```
evolclaw start          启动服务（默认命令）
evolclaw stop           停止服务
evolclaw restart        重启服务
evolclaw status         查看运行状态（进程、AID 连接、会话）
```

## 初始化

```
evolclaw init           初始化 ~/.evolclaw 目录结构
evolclaw init aun       AUN 网络配置
evolclaw init feishu    飞书扫码登录
evolclaw init wechat    微信扫码登录
evolclaw init dingtalk  钉钉扫码登录
evolclaw init qqbot     QQ 机器人绑定
evolclaw init wecom     企业微信配置
```

## Agent 管理

通用选项: `--format json` 输出 JSON 格式（所有子命令均支持）

```
evolclaw agent                        列出所有 agent
evolclaw agent list                   同上
evolclaw agent show <aid>             查看 agent 详情（身份 + 配置 + 连接 + 会话 + 路径）
evolclaw agent new [aid]              交互式创建 agent
evolclaw agent new <aid> --non-interactive --baseagent <claude|codex|gemini|hermes> --project <path> [channel flags] [behavior flags]
evolclaw agent sync-aids              从本地 AID 批量创建 agent（以最早 agent 为模板）
evolclaw agent enable <aid>           启用 agent
evolclaw agent disable <aid>          停用 agent
evolclaw agent get <aid> <key>        读取单个配置字段（支持点路径）
evolclaw agent set <aid> <key> <val>  修改单个配置字段（支持点路径）+ 热重载
evolclaw agent reload                 全量 resync（扫磁盘，新增上线、删除下线、修改热更新）
evolclaw agent reload <name>          热重载指定 agent 配置
evolclaw agent delete <aid>           删除 agent 配置（停止运行中的 agent）
evolclaw agent delete <aid> --purge   同上，并删除 agent 数据目录
```

观察者模式复用通用配置命令，无需专用子命令：

```bash
evolclaw agent get <aid> observable
evolclaw agent set <aid> observable true
evolclaw agent set <aid> observable false
```

非交互创建可选 channel flags:
- `--aun-aid <aid> --aun-owner <aid>`
- `--feishu-app-id <id> --feishu-app-secret <secret>`
- `--wechat-token <token>`
- `--wecom-bot-id <id> --wecom-secret <secret>`
- `--dingtalk-client-id <id> --dingtalk-client-secret <secret>`
- `--qqbot-app-id <id> --qqbot-client-secret <secret>`

可选行为 flags:
- `--chatmode-private <interactive|proactive>`（默认 interactive）
- `--chatmode-group <interactive|proactive>`（默认 proactive）

## AID 身份管理

```
evolclaw aid list             列出本地所有 AID
evolclaw aid show <aid>       查看详情（证书有效期、私钥状态）
evolclaw aid new <aid>        创建新 AID
evolclaw aid delete <aid>     删除本地 AID
evolclaw aid lookup <aid>     远程探测 AID（存在性 + 网关 + agent.md）
evolclaw aid agentmd put <aid>  签名并上传本地 agent.md
evolclaw aid agentmd get <aid>  下载并验签 agent.md
```

通用选项: `--format json` 输出 JSON

## RPC 调用

```
evolclaw rpc --as <aid> --params <json|jsonl|file>
```

`--params` 自动判断输入形式:
- 单行 JSON（以 `{` 开头）→ 单次调用
- 多行 JSONL → 逐行执行，失败即停
- 文件路径 → 读取文件内容作为 JSONL

每行格式: `{"method":"<namespace.method>","params":{...}}`

## 文件存储

```
evolclaw storage upload <aid> <local-file> <remote-path> [--public]
evolclaw storage download <aid> <url> [local-path]
evolclaw storage ls <aid> [prefix]
evolclaw storage rm <aid> <remote-path>
evolclaw storage quota <aid>
```

url 格式: `[https://]<owner-aid>/<path>`

## 日志与监控

```
evolclaw logs                 实时日志（tail -f，着色）
evolclaw logs --level error   只显示 error 及以上
evolclaw logs --module <name> 只显示指定模块
evolclaw logs --raw           原始输出不着色
evolclaw watch                监控面板选择菜单（↑↓ 选择 log/aid/msg）
evolclaw watch log            监控 logs/ 下所有 .log 文件
evolclaw watch aid            AID 连接状态实时监控
evolclaw watch msg            消息监控（三面板交互式 TUI）
```

## 运行时控制 (ctl)

在 evolclaw 托管环境中使用（需 EVOLCLAW_SESSION_ID）:

```
evolclaw ctl status                   查看会话状态
evolclaw ctl check                    检查渠道健康
evolclaw ctl model [model-id]         查看/切换模型
evolclaw ctl effort [low|medium|high] 查看/切换推理强度
evolclaw ctl compact                  压缩会话上下文
evolclaw ctl chatmode [mode]          查看/切换会话模式
evolclaw ctl activity [all|dm|owner|none]  控制中间输出显示
evolclaw ctl perm [mode]              查看/切换权限模式
evolclaw ctl bind <path>              注册项目目录
evolclaw ctl send <消息>              主动发送文本（proactive 模式）
evolclaw ctl file [channel] <path>    发送项目内文件
evolclaw ctl agentmd [put|set <内容>] 管理 agent.md
evolclaw ctl restart [channel]        重启/重连
```

## 开发模式

```
evolclaw dev              查看当前模式（dev/pkg）+ 切换提示
evolclaw dev <path>       进入开发模式：npm link 到指定开发仓路径，记录路径
evolclaw dev on           从已记录的路径快速切回开发模式
evolclaw dev off          退出开发模式：卸载 link，重新安装发布包
```

切换后需 `evolclaw restart` 生效。

## 工具命令

```
evolclaw diagnose             诊断启动环境（配置、数据库、进程）
evolclaw net check [<aid>]    网络链路诊断（10 步：DNS→Discovery→TCP→TLS→WSS→Auth→Ping→Echo）
evolclaw net check --format json  JSON 格式输出
evolclaw mv <old> <new>       迁移项目目录（保留所有会话数据）
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `EVOLCLAW_HOME` | 数据目录 | `~/.evolclaw` |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `MESSAGE_LOG` | 消息日志 | `true` |
| `EVENT_LOG` | 事件日志 | `true` |
