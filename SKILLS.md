---
name: evolclaw-ctl
version: 1.1.0
description: 仅在 evolclaw 运行时可用
trigger: 用户询问或需要切换模型、调整推理强度、查看运行状态、压缩上下文、检查通道健康、管理权限模式、重启服务、重连渠道等
---

# EvolClaw Ctl

通过 `evolclaw ctl <command> [args]` 管理运行时配置。仅在 evolclaw 托管环境中可用（`EVOLCLAW_SESSION_ID` 已设置）。

## 可用指令

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

### 权限类
- `evolclaw ctl perm` — 查看当前权限模式（管理员）
- `evolclaw ctl perm <mode>` — 切换权限模式（仅 owner）

### 运维类（仅 owner）
- `evolclaw ctl activity <all|dm|owner|none>` — 查看/控制中间输出显示模式
- `evolclaw ctl send [channel] <path>` — 发送项目内文件（仅限项目目录内）
- `evolclaw ctl restart` — 重启服务（慎用：中断所有会话）
- `evolclaw ctl restart <channel>` — 重连指定渠道（管理员可用）
- `evolclaw ctl agentmd` — 查看当前 agent.md
- `evolclaw ctl agentmd put` — 发布本地 agent.md
- `evolclaw ctl agentmd set <内容>` — 直接设置 agent.md 内容
- `evolclaw ctl aid` — 列出所有 AUN 实例及连接状态
- `evolclaw ctl aid new <aid>` — 创建新 AID 并热加载（仅 AUN 通道）

## 使用示例

```bash
# 查看当前模型
evolclaw ctl model

# 切换到 opus
evolclaw ctl model opus

# 降低推理强度以加快响应
evolclaw ctl effort low

# 压缩上下文
evolclaw ctl compact

# 查看服务状态
evolclaw ctl status
```

## 注意事项

- 仅在 evolclaw 托管环境中可用（EVOLCLAW_SESSION_ID 环境变量已设置时）
- 权限继承当前会话用户的角色（owner / admin / guest）
- `compact` 不能在当前会话处理消息期间执行
- `send` 只能发送项目目录下的文件
- `restart` 会中断当前所有会话，谨慎使用
