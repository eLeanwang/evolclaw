# 命令参考：ec response

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | ec response 命令参考 |
| 版本 | v1.0 |
| 状态 | Draft |
| 适用读者 | 终端用户、前端开发者 |

---

## 概述

`ec response` 是响应模式管理命令集，用于查看、切换、配置会话的响应模式。

触发词：切换响应模式/列出响应模式/查看当前模式/改响应配置/响应模式详情。

> **与 `ec ctl` 的区别**：`ec response` 改的是**持久化作用域配置**，影响对应范围所有会话；
> 后续在会话内即时切换（如有）走 `ec ctl`，只作用于当前运行中的会话。

> **命名说明**：选用 `response` 而非 `mode`，因为 `mode` 过于通用，容易与 chatmode/permissionMode 等冲突。

---

## 命令

```bash
# 列出所有已注册的响应模式（内置 + 扩展）
ec response list [--scene <private|group>]

# 显示当前会话/作用域实际生效的响应模式 + 来源
ec response current [--self <aid>] [--peer <X>]

# 查看单个响应模式详情（描述/适用场景/配置 schema）
ec response info <mode-id>

# 设置响应模式（作用域由 --self/--peer 决定）
ec response set <mode-id> [--self <aid>] [--peer <X>]

# 清除指定作用域的模式设置，回落上一级
ec response reset [--self <aid>] [--peer <X>]

# 查看指定模式的配置参数（当前作用域生效值）
ec response config [<mode-id>] [--self <aid>] [--peer <X>]

# 修改指定模式的配置参数
ec response config set <key> <value> [--mode <mode-id>] [--self <aid>] [--peer <X>]

# 注册扩展响应模式（指定模块路径）
ec response register <module-path>

# 注销扩展响应模式
ec response unregister <mode-id>
```

---

## 子命令详解

### list — 列出响应模式

```bash
ec response list [--scene <private|group>]
```

列出所有已注册的响应模式。

**选项**：
- `--scene <private|group>`：仅显示适用于指定场景的模式

**输出示例**：

```
内置模式（builtin）:
  interactive        交互模式          [private]
  proactive          主动模式          [private, group]
  dual-session       双会话模式        [group]
  thread-tracking    线索追踪模式      [group]
  workflow           工作流模式        [group]
  context-enhanced   上下文增强模式    [group]
  batch-processing   批量处理模式      [group]
  selective-response 选择性响应模式    [group]
  rate-limited       速率限制模式      [private, group]
  autonomous         自主模式          [private, group]

扩展模式（extension）:
  echo               回声模式          [private, group]
```

### current — 查看当前模式

```bash
ec response current [--self <aid>] [--peer <X>]
```

显示按优先级解析后实际生效的响应模式及其来源。

**输出示例**：

```
当前响应模式: dual-session（双会话模式）
来源: relation override (aun#alice.aid.pub)
配置:
  auxiliary_model: haiku
  relevance_threshold: 0.7
```

**`--format json` 输出**：

```json
{
  "mode": "dual-session",
  "displayName": "双会话模式",
  "source": "relation",
  "peerKey": "aun#alice.aid.pub",
  "config": {
    "auxiliary_model": "haiku",
    "relevance_threshold": 0.7
  }
}
```

### info — 查看模式详情

```bash
ec response info <mode-id>
```

查看单个响应模式的详细信息。

**输出示例**：

```
模式: dual-session
显示名: 双会话模式
类型: builtin
描述: 辅助会话判断消息相关性，主会话处理
适用场景: group

配置参数:
  auxiliary_model    (string)  辅助会话使用的模型      默认: haiku
  relevance_threshold (number) 相关性阈值（0-1）       默认: 0.7
```

### set — 设置响应模式

```bash
ec response set <mode-id> [--self <aid>] [--peer <X>]
```

设置响应模式。作用域由 `--self`/`--peer` 决定。

**示例**：

```bash
# 设置 agent 级群聊默认模式
ec response set dual-session --self mybot.aid.pub --scene group

# 设置特定对端的模式
ec response set workflow --self mybot.aid.pub --peer aun#team.group.com
```

**校验**：
- 模式必须已注册
- 模式必须适用于目标场景（applicableScenes）

### reset — 重置模式

```bash
ec response reset [--self <aid>] [--peer <X>]
```

清除指定作用域的模式设置，回落到上一级。

### config — 查看/修改配置

```bash
# 查看当前模式的配置
ec response config [--self <aid>] [--peer <X>]

# 查看指定模式的配置
ec response config <mode-id> [--self <aid>] [--peer <X>]

# 修改配置参数
ec response config set <key> <value> [--mode <mode-id>] [--self <aid>] [--peer <X>]
```

**示例**：

```bash
# 查看 dual-session 的配置
ec response config dual-session --self mybot.aid.pub

# 修改辅助模型
ec response config set auxiliary_model sonnet --mode dual-session --self mybot.aid.pub

# 修改相关性阈值
ec response config set relevance_threshold 0.8 --mode dual-session --self mybot.aid.pub
```

**校验**：根据模式的 `configSchema` 校验参数名和类型。

### register — 注册扩展模式

```bash
ec response register <module-path>
```

注册扩展响应模式。模块必须导出实现 `ResponseMode` 接口的类。

**示例**：

```bash
ec response register ./my-custom-mode.js
```

### unregister — 注销扩展模式

```bash
ec response unregister <mode-id>
```

注销扩展响应模式。仅能注销 `extension` 类型，内置模式不可注销。

---

## 作用域（越具体越优先：关系 > agent > 全局）

| 参数 | 作用域 | 落盘 |
|------|--------|------|
| （无） | 全局默认 | `defaults.json` |
| `--self <aid>` | agent 级 | `config.json` 的 `response_modes` |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/config.json` 的 `response_modes` |

`--peer` 取 `channelType#channelId` 或裸 aid（裸 aid 视为 `aun#<aid>`）。

### 模式解析优先级

```
1. relation override（overrides[peerKey].mode）
   ↓ 未命中
2. chatType 默认（default_private / default_group）
   ↓ 未命中
3. 全局兜底（private→interactive, group→proactive）
```

---

## 权限控制

| 操作 | 私聊 | 群聊 |
|------|------|------|
| `list` / `current` / `info` | 任何角色 | 任何角色 |
| `set` / `reset` / `config set` | 仅对端是「我的 agent」时 owner 可改 | 仅 owner 可改「我的在群 agent」 |
| `register` / `unregister` | 仅 owner | 仅 owner |

**说明**：
- **私聊**：只有当对端是「我拥有的 agent」时，我才能修改其响应模式
- **群聊**：我可以修改「我拥有的在群 agent」的响应模式
- 不能修改他人 agent 的响应模式（响应策略是 agent 的自主决定）

---

## 通用约定

- `--format json` — 所有子命令通用，输出结构化 JSON
- 本命令操作本地配置，不连 AUN 网络
- 改某作用域后，对应范围所有会话的下一条消息即时生效
- 与对话内 slash 命令（如有 `/response`）互不影响

---

## Menu Protocol 集成

前端通过 Menu Protocol 操作响应模式。

### 列举可选模式

```json
{
  "type": "menu.options",
  "name": "response_mode",
  "cmd": "ec response list --format json"
}
```

### 查询当前模式

```json
{
  "type": "menu.query",
  "name": "response_mode",
  "cmd": "ec response current --format json"
}
```

### 切换模式

```json
{
  "type": "menu.update",
  "name": "response_mode",
  "value": "dual-session",
  "cmd": "ec response set"
}
```

### 查询模式配置

```json
{
  "type": "menu.query",
  "name": "response_mode_config",
  "args": { "mode": "dual-session" },
  "cmd": "ec response config --format json"
}
```

### 修改模式配置

```json
{
  "type": "menu.update",
  "name": "response_mode_config",
  "value": "0.8",
  "args": { "mode": "dual-session", "key": "relevance_threshold" },
  "cmd": "ec response config set"
}
```

---

## 使用场景示例

### 场景 1：为繁忙群聊启用双会话模式

```bash
# 查看可用的群聊模式
ec response list --scene group

# 为特定群启用双会话模式
ec response set dual-session --self mybot.aid.pub --peer aun#busy-group.com

# 调整相关性阈值
ec response config set relevance_threshold 0.8 \
  --mode dual-session --self mybot.aid.pub --peer aun#busy-group.com
```

### 场景 2：为任务群启用工作流模式

```bash
ec response set workflow --self mybot.aid.pub --peer aun#task-group.com
ec response config set workflow_file ./task-flow.json \
  --mode workflow --self mybot.aid.pub --peer aun#task-group.com
```

### 场景 3：切回默认模式

```bash
ec response reset --self mybot.aid.pub --peer aun#busy-group.com
```

---

## 与其他命令集的关系

| 命令集 | 关系 |
|--------|------|
| `ec model` | 响应模式可能在 instructions 中切换模型，与 `ec model` 的作用域配置正交 |
| `ec ctl` | `ec ctl` 作用于当前运行会话；`ec response` 作用于持久化配置 |
| `ec group` | 群聊响应模式与群管理正交 |

---

## 附录：相关文档

- [架构设计](./architecture.md)
- [插件开发指南](./plugin-guide.md)
- [配置参考](./config-reference.md)
- [内置模式文档](./builtin-modes.md)
