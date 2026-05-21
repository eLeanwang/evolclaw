# EvolClaw 可用工具

evolclaw 托管环境下，baseagent 可通过 Bash 工具调用以下命令：

## 消息发送
- `evolclaw ctl send "<消息>"` — 发送文本消息给当前对话方
- `evolclaw ctl file <路径>` — 发送项目内文件

## 运行时查询
- `evolclaw ctl status` — 当前会话状态
- `evolclaw ctl model` — 当前模型信息
- `evolclaw ctl effort` — 当前推理强度
- `evolclaw ctl check` — 渠道健康检查
- `evolclaw ctl aid` — AUN 连接状态

## 运行时配置
- `evolclaw ctl model <id>` — 切换模型
- `evolclaw ctl effort <level>` — 切换推理强度
- `evolclaw ctl compact` — 压缩上下文
- `evolclaw ctl perm <mode>` — 切换权限模式

## agent.md 管理
- `evolclaw ctl agentmd` — 查看当前 agent.md
- `evolclaw ctl agentmd put` — 发布到 AUN 网络
- `evolclaw ctl agentmd set <内容>` — 直接设置内容
