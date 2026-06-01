# ec ctl — 会话运行时自管理

对**当前会话**的运行时自管理：切模型、调推理强度、压缩上下文、切权限、重启服务。触发词：切模型/推理强度/压缩上下文/切权限/重启。

> ctl 命令通过 IPC 转发给 daemon，仅在 evolclaw 托管环境中可用（依赖 `EVOLCLAW_SESSION_ID`）。

## 查询

```bash
ec ctl status        # 查看会话状态
ec ctl check         # 检查渠道健康状态
ec ctl pwd           # 显示当前项目路径
ec ctl help          # 显示帮助
```

## 配置

```bash
ec ctl model [model-id]            # 查看/切换模型（如 opus, sonnet, haiku）
ec ctl effort [low|medium|high]    # 查看/切换推理强度
ec ctl compact                     # 压缩当前会话上下文
ec ctl perm [mode]                 # 查看/切换权限模式
```

## 消息（兜底用）

```bash
ec ctl send "<text>"      # 主动发送文本（proactive 模式）
ec ctl file [channel] <path>   # 发送项目内文件
```

> 发消息**首选 `ec msg send <self-aid> <peer-id> "<text>"`**（见 msg.md）。
> `ec ctl send` 只在拿不到自己的 AID 时兜底——它自动继承当前会话的 AID 和对端。

## 运维

```bash
ec ctl restart [channel]   # 重启服务，或重连指定渠道
```

## 相关命令集

- agent 全生命周期管理（创建/启停/配置）→ `ec agent`（见 agent.md）
- AID 身份与 agent.md 名片 → `ec aid`（见 aid.md）

ctl 内也转发了 `ec ctl agent <subcommand>`，但完整功能请直接用 `ec agent`。
