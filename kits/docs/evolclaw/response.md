# ec response — 响应模式管理命令集

按作用域查看/切换/配置会话的响应模式。触发词：切换响应模式/列响应模式/看当前模式/改响应配置/响应模式详情。

> 响应模式决定「收到消息怎么处理 + 怎么回复」。不同模式适用不同场景（人机单聊、Agent 对话、繁忙群、任务群等）。
> 与 `ec model`（改模型）正交：response 改的是响应策略，model 改的是用哪个模型。

## 命令

```bash
# 列出所有响应模式（含适用场景）
ec response list [--scene private|group]

# 显示当前作用域生效的默认模式 + 配置
ec response current [--self <aid>] [--peer <X>]

# 查看单个模式详情（场景/配置参数）
ec response info <mode-id>

# 设置默认模式（--scene 指定 private/group）
ec response set <mode-id> --self <aid> [--peer <X>] [--scene private|group]

# 清除指定作用域的 response_modes 设置
ec response reset --self <aid> [--peer <X>]

# 查看模式配置参数
ec response config [<mode-id>] [--self <aid>] [--peer <X>]

# 修改模式配置参数
ec response config set <key> <value> --mode <mode-id> --self <aid> [--peer <X>]
```

## 内置模式（10 种）

| 模式 id | 显示名 | 场景 | 用途 |
|---------|--------|------|------|
| `interactive` | 交互模式 | 私聊 | 输出即回复，人机单聊默认 |
| `proactive` | 主动模式 | 私聊/群聊 | 工具调用才回复，Agent 对话默认 |
| `dual-session` | 双会话模式 | 群聊 | 辅助会话判断相关性，繁忙群过滤 |
| `thread-tracking` | 线索追踪 | 群聊 | 追踪对话线索，多话题群 |
| `workflow` | 工作流模式 | 群聊 | 顺序处理任务，任务群 |
| `context-enhanced` | 上下文增强 | 群聊 | 注入群规则文档，工作群 |
| `batch-processing` | 批量处理 | 群聊 | 攒批节省资源，低优先级群 |
| `selective-response` | 选择性响应 | 群聊 | 白名单/关键词过滤 |
| `rate-limited` | 速率限制 | 私聊/群聊 | 控制响应频率，防刷屏 |
| `autonomous` | 自主模式 | 私聊/群聊 | 触发器驱动，定时任务 |

## 作用域（越具体越优先：关系 > agent > 全局）

| 参数 | 作用域 | 落盘 |
|------|--------|------|
| `--self <aid>` | agent 级 | `config.json` 的 response_modes |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/config.json` 的 response_modes |

`--peer` 取 `channelType#channelId` 或裸 aid（裸 aid 视为 `aun#<aid>`）。

> **写操作必须 --self**：response_modes 是行为参数，从 agent 级起步，全局默认（defaults）不承载（与 `ec model` 一致）。
> 读操作（list/info/current/config 查看）无此限制。

## 解析优先级

```
1. overrides[peerKey]          （特定对端/群指定模式）
2. default_private/default_group （chatType 默认）
3. 系统兜底（private→interactive, group→proactive）
```

## 权限

| 操作 | 私聊 | 群聊 |
|------|------|------|
| list/current/info/config 查看 | 任何角色 | 任何角色 |
| set/reset/config set | 对端是「我的 agent」时 owner 可改 | owner 可改「我的在群 agent」 |

## 通用约定

- `--format json` 所有子命令通用
- 本命令操作本地配置，不连 AUN 网络
- 改某作用域后，对应范围所有会话的下一条消息即时生效
- 完整说明见 `docs/response-system/command-reference.md`
