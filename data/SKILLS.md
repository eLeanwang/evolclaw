---
name: evolclaw-ctl
version: 1
description: EvolClaw 运行时自管理指令，仅在 evolclaw 托管环境中可用
trigger: 用户询问或需要切换模型、调整推理强度、查看运行状态、压缩上下文、检查通道健康、管理权限模式、发送文件、发送消息、切换会话模式、重启服务、重连渠道时
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
- `evolclaw ctl chatmode` — 查看当前会话模式（interactive | proactive）
- `evolclaw ctl chatmode <interactive|proactive>` — 切换会话模式（受通道配置锁定时只读）

### 权限类
- `evolclaw ctl perm` — 查看当前权限模式（管理员）
- `evolclaw ctl perm <mode>` — 切换权限模式（仅 owner）

### 输出类
- `evolclaw ctl send <消息内容>` — **proactive 模式专用**：主动发送文本消息给用户
- `evolclaw ctl file <path>` — 发送项目内文件（仅限项目目录内）
- `evolclaw ctl file <channel> <path>` — 跨通道发送文件（仅 owner）

### 运维类（仅 owner）
- `evolclaw ctl activity <all|dm|owner|none>` — 查看/控制中间输出显示模式（proactive 模式下不可用）
- `evolclaw ctl restart` — 重启服务（慎用：中断所有会话）
- `evolclaw ctl restart <channel>` — 重连指定渠道（管理员可用）
- `evolclaw ctl agentmd` — 查看当前 agent.md
- `evolclaw ctl agentmd put` — 发布本地 agent.md
- `evolclaw ctl agentmd set <内容>` — 直接设置 agent.md 内容

## 会话模式（sessionMode）

- **interactive**（默认）：你的流式输出由系统自动批量发送给用户，无需主动调用任何指令
- **proactive**：你的流式输出**完全静默**，必须通过 `evolclaw ctl send` 或 `evolclaw ctl file` 主动发送，否则用户看不到任何回复
  - 适用场景：群聊场景下需要选择性回复、多次发送、精确控制时机
  - 可多次调用 `ctl send`，每次发送一条消息
  - 当前会话处于 proactive 模式时，系统会在 system prompt 中提示

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

# proactive 模式下主动发送消息
evolclaw ctl send "已收到您的请求，正在处理…"
evolclaw ctl send "处理完成！结果如下：…"

# 发送项目文件
evolclaw ctl file ./report.md

# 切换当前会话为 proactive 模式
evolclaw ctl chatmode proactive
```

## 注意事项

- 仅在 evolclaw 托管环境中可用（EVOLCLAW_SESSION_ID 环境变量已设置时）
- 权限继承当前会话用户的角色（owner / admin / guest）
- `compact` 不能在当前会话处理消息期间执行
- `file` 只能发送项目目录下的文件
- `send` 仅在 proactive 模式下需要使用；interactive 模式直接输出文本即可
- `chatmode` 受通道配置锁定时无法切换（提示锁定原因）
- `restart` 会中断当前所有会话，谨慎使用
