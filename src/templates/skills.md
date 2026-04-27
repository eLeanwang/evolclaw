---
name: evolclaw-ctl
version: 1
description: EvolClaw 运行时自管理指令，仅在 evolclaw 托管环境中可用
trigger: Agent 自主判断需要时（切换模型、调整配置、查看状态等）
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
