# EvolClaw Ctl - Agent 自主管理指令

通过 `evolclaw ctl <command> [args]` 管理运行时配置。仅在 evolclaw 托管环境中可用（`EVOLCLAW_SESSION_ID` 已设置）。

## 架构

```
Agent (Bash 工具) → evolclaw ctl <cmd> → IPC → CommandHandler → 结果返回 stdout
```

## 可用指令

### 查询类（所有用户）

| 指令 | 说明 |
|------|------|
| `evolclaw ctl help` | 显示帮助 |
| `evolclaw ctl status` | 显示会话状态 |
| `evolclaw ctl check` | 检查渠道健康状态 |

### 配置类（管理员）

| 指令 | 说明 |
|------|------|
| `evolclaw ctl model` | 查看当前模型和可选列表 |
| `evolclaw ctl model <model-id>` | 切换模型（opus / sonnet / haiku） |
| `evolclaw ctl effort` | 查看当前推理强度 |
| `evolclaw ctl effort <level>` | 切换推理强度（low / medium / high / max） |
| `evolclaw ctl compact` | 压缩当前会话上下文 |

### 权限类

| 指令 | 所需角色 | 说明 |
|------|---------|------|
| `evolclaw ctl perm` | admin | 查看当前权限模式 |
| `evolclaw ctl perm <mode>` | owner | 切换权限模式 |

### 运维类（仅 owner）

| 指令 | 说明 |
|------|------|
| `evolclaw ctl activity <mode>` | 控制输出显示模式（all / dm / owner / none） |
| `evolclaw ctl send "<消息>"` | 发送消息到当前通道 |
| `evolclaw ctl file <路径>` | 发送项目内文件（仅限项目目录内） |
| `evolclaw ctl restart` | 重启服务（中断所有会话，慎用） |

## 使用场景

- Agent 自主判断需要切换模型、调整配置
- 用户自然语言指示（如"切到 opus"、"压缩上下文"）
- Proactive 模式下发送消息给用户（文本输出被静默丢弃，必须用 ctl send）

## 注意事项

- 权限继承当前会话用户角色（owner / admin / guest）
- `compact` 不能在活跃流期间执行
- `file` 只能发送项目目录下的文件（路径越界会被拒绝）
- `restart` 会中断所有会话
