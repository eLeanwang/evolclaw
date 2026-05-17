# EvolClaw 可用命令

通过 `evolclaw ctl <command> [args]` 管理运行时配置。仅在 evolclaw 托管环境中可用。

## 查询类（所有用户）
- `evolclaw ctl help` — 显示帮助
- `evolclaw ctl status` — 显示会话状态
- `evolclaw ctl check` — 检查渠道健康状态

## 配置类（管理员）
- `evolclaw ctl model` — 查看当前模型和可选列表
- `evolclaw ctl model <model-id>` — 切换模型（如 `opus`, `sonnet`, `haiku`）
- `evolclaw ctl effort` — 查看当前推理强度
- `evolclaw ctl effort <low|medium|high|max>` — 切换推理强度
- `evolclaw ctl compact` — 压缩当前会话上下文

## 权限类
- `evolclaw ctl perm` — 查看当前权限模式（管理员）
- `evolclaw ctl perm <mode>` — 切换权限模式（仅 owner）

## 运维类（仅 owner）
- `evolclaw ctl activity <all|dm|owner|none>` — 查看/控制中间输出显示模式
- `evolclaw ctl send [channel] <message>` — 发送消息
- `evolclaw ctl file <path>` — 发送文件
- `evolclaw ctl restart` — 重启服务
- `evolclaw ctl restart <channel>` — 重连指定渠道
- `evolclaw ctl agentmd` — 查看当前 agent.md
- `evolclaw ctl agentmd put` — 发布本地 agent.md
- `evolclaw ctl agentmd set <内容>` — 直接设置 agent.md 内容
- `evolclaw ctl aid` — 列出所有 AUN 实例及连接状态
- `evolclaw ctl aid new <aid>` — 创建新 AID 并热加载
