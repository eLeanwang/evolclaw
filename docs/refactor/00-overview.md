# 改造总览：命令体系原子化

## 核心问题

evolclaw 当前有 30+ slash 命令 + 13 个 CLI 子命令 + ctl 桥接，三层入口各自膨胀。带来两个根本问题：

1. **工具爆炸**：每个功能封装一个命令，agent 需要记住 30+ 工具的语义和参数。
2. **信息封装丢失**：功能被封装在代码里，agent 失去自审能力——不读源码就不知道命令背后做了什么、能做什么。且"运行环境有源码"这个前提不成立。

## 设计原则

**原子化**：agent 用最少的工具入口覆盖所有操作。最终工具集：

```
Agent 自带基础工具（6 个）：
  Read / Write / Edit / Glob / Grep / Bash

evolclaw 提供的原子工具（4 套）：
  evolclaw aid <verb>          — 身份层（涉及私钥，不能用文件操作替代）
  evolclaw rpc --as <aid> --params   — 网络层（AUN RPC，需要认证连接）
  evolclaw storage <verb>      — 存储层（多步文件操作封装）
  evolclaw ctl <verb>          — 运行时层（daemon 进程内状态，需要 IPC）
```

**自描述**：每套工具自带 introspection（`aid list --format json`、`aun introspect`、`ctl get help`），agent 不读源码就能发现能力边界。

**文件即状态**：能用文件表达的状态就用文件（配置、session 元数据、AID 本地数据），agent 用 Read/Glob 直接观测，不需要专属查询命令。

## 两个前置改造

改造完成后才能重新设计命令体系。两者可并行，无强依赖。

| # | 改造 | 文档 | 解决什么 |
|---|---|---|---|
| 1 | 数据库 → 文件系统 | `01-db-to-fs.md` | agent 能直接 Read 运行时状态，消灭大量 read 类命令（/slist /status /pwd /plist /check） |
| 2 | AID 操作 + AUN RPC + Storage 工具 | `02-aid-tool.md` | 身份管理脱离 daemon，通用 RPC 打开协议覆盖面，storage 多步流程封装 |

## 改造后的命令归宿（完整枚举）

下面是现有所有命令在新体系下的归宿。新体系四套工具：`Read/Write/Edit/Glob/Grep/Bash`（agent 自带）+ `aid` / `rpc` / `storage` / `ctl`（evolclaw 提供）。

### 一、CLI 顶级命令（14 个）

| 现有命令 | 新体系归宿 | 说明 |
|---|---|---|
| `evolclaw start` | **保留** | 进程级控制，给人用 |
| `evolclaw stop` | **保留** | 进程级控制 |
| `evolclaw restart` | **保留** | 进程级控制 |
| `evolclaw status` | **保留**（人用）+ `Glob + Read ~/.evolclaw/state/...`（agent 用） | 改造 1 后 agent 直接读文件 |
| `evolclaw logs` | **保留** | tail -f，给人用 |
| `evolclaw init` | **保留**（扫码交互必须 CLI） + `Edit evolclaw.json`（agent 用） | |
| `evolclaw ctl <cmd>` | **重构**为 `evolclaw ctl get/set/call/reload <path>`（4 动词） | 见下文 ctl 表 |
| `evolclaw agent` | **拆分**：`Glob + Read ~/.evolclaw/agents/*.json`（list/show） + `Write + ctl reload`（new） + `ctl call agent.reload <name>`（reload） | |
| `evolclaw aid` | **重构**为 `evolclaw aid <verb>`（7 动词） | 见 02-aid-tool.md |
| `evolclaw agentmd` | **合并**到 `evolclaw aid agentmd put/get` | |
| `evolclaw diagnose` | **保留** | 给人用 |
| `evolclaw mv <old> <new>` | **保留** | 项目目录迁移 |
| `evolclaw restart-monitor` | **保留** | 内部命令（self-heal） |
| `evolclaw --version` | **保留** | |

### 二、CLI 二级子命令（18 个）

| 现有命令 | 新体系归宿 |
|---|---|
| `evolclaw init feishu/wechat/dingtalk/qqbot/wecom` | **保留**（扫码交互） |
| `evolclaw init aun` | **保留**（交互式 wizard） |
| `evolclaw init --non-interactive` | **保留** + `Edit evolclaw.json`（agent 直接改） |
| `evolclaw agent` (list) | `Glob + Read ~/.evolclaw/agents/*.json` |
| `evolclaw agent <name>` (show) | `Read ~/.evolclaw/agents/<name>.json` |
| `evolclaw agent new <name>` | **保留**（交互式） + `aid new + Write + ctl call agent.reload`（agent 用） |
| `evolclaw agent reload <name>` | `evolclaw ctl call agent.reload <name>` |
| `evolclaw aid list` | `evolclaw aid list` 或 `Glob ~/.aun/AIDs/*/` |
| `evolclaw aid new <aid>` | `evolclaw aid new <aid>` |
| `evolclaw agentmd <aid>` (查看) | `evolclaw aid lookup <aid>`（探测）或 `evolclaw aid agentmd get <aid>`（持久化）|
| `evolclaw agentmd put <aid>` | `evolclaw aid agentmd put <aid>` |
| `evolclaw agentmd set <aid> <内容>` | **删除**——用 `Edit ~/.aun/AIDs/<aid>/agent.md` + `evolclaw aid agentmd put` 替代 |

### 三、Slash 命令（33 个 + 4 别名）

#### 项目/会话管理 → ctl call

| 现有 slash | 权限 | 新体系归宿 |
|---|---|---|
| `/pwd` | admin | `Read ~/.evolclaw/state/active/<channel>__<id>.json` |
| `/p` `/project` `/plist` | admin | `evolclaw ctl call session.switch-project <name>`（切换） / `Glob + Read ~/.evolclaw/state/projects/`（列表） |
| `/bind <path>` | owner | `Edit evolclaw.json` + `evolclaw ctl call config.reload` |
| `/new [名称]` | user | `evolclaw ctl call session.new [名称]` |
| `/s` `/session` `/slist` | user | `evolclaw ctl call session.switch <名称>`（切换） / `Glob + Read ~/.evolclaw/state/sessions/`（列表） |
| `/name` `/rename <新名称>` | user | `evolclaw ctl call session.rename <新名称>` |
| `/del <名称>` | user/admin | `evolclaw ctl call session.delete <名称>` |
| `/fork [名称]` | admin | `evolclaw ctl call session.fork [名称]` |
| `/rewind` `/rw [N] [type]` | user/admin | `evolclaw ctl call session.rewind [N] [type]` |
| `/compact` | admin | `evolclaw ctl call session.compact` |
| `/clear` | admin | `evolclaw ctl call session.clear` |
| `/repair` | admin | `evolclaw ctl call session.repair` |
| `/resume` | user | `Read ~/.evolclaw/state/sessions/<id>/history.jsonl` |

#### Agent 与模型 → ctl set / ctl call

| 现有 slash | 权限 | 新体系归宿 |
|---|---|---|
| `/agent [name]` | user/admin | `Read .../current.json`（查看） / `evolclaw ctl set session.current.agent <name>`（切换） |
| `/model [model] [effort]` | user/admin | `Read .../current.json` / `evolclaw ctl set session.current.model <model>` |
| `/setmodel` | admin | `evolclaw ctl get models` |
| `/effort [level]` | user/admin | `evolclaw ctl set session.current.effort <level>` |
| `/chatmode [mode]` | user/admin | `evolclaw ctl set session.current.chatmode <mode>` |

#### 权限管理 → ctl set / ctl call

| 现有 slash | 权限 | 新体系归宿 |
|---|---|---|
| `/perm` (查看) | admin | `Read ~/.evolclaw/state/active/<...>.json` |
| `/perm <mode>` | admin+ | `evolclaw ctl set session.current.perm <mode>` |
| `/perm allow/always/deny` | admin | `evolclaw ctl call permission.respond <verdict>` |

#### 运维 → ctl get / ctl call

| 现有 slash | 权限 | 新体系归宿 |
|---|---|---|
| `/status` | user/admin | `Read ~/.evolclaw/state/active/<...>.json`（agent） / 保留 slash（人聊天用）|
| `/stop` | user | `evolclaw ctl call session.interrupt` |
| `/check` | user/admin | `evolclaw ctl get channels` |
| `/activity [mode]` | admin/owner | `evolclaw ctl set session.current.activity <mode>` |
| `/restart` | daemon owner | `evolclaw ctl call service.restart` |
| `/reload [aid]` | daemon owner 跨 agent；agent owner/admin 仅自身 | `evolclaw ctl call agent.reload [aid]` |
| `/file <path>` | admin+ | inline `[SEND_FILE:路径]` 标记（保留）|
| `/file <channel> <path>` | owner | inline `[SEND_FILE:路径]` 标记（保留，跨渠道）|
| `/aid [list\|new]` | owner | `evolclaw aid list` / `evolclaw aid new <aid>` |
| `/agentmd [put\|set]` | owner | `evolclaw aid agentmd put <aid>` / `Edit + put` |

#### 交互与帮助 → 保留 / ctl get

| 现有 slash | 权限 | 新体系归宿 |
|---|---|---|
| `/ask <选项>` | user | **保留**（交互式问答）+ `evolclaw ctl call ask.respond <选项>`（程序化）|
| `/safe` | user | **删除**（已禁用） |
| `/help` | user | **保留**（聊天 UX）+ `evolclaw ctl get help`（agent 用）|
| `/evolhelp` | user | `evolclaw ctl get help --format json` |

### 四、ctl 命令（14 个 → 4 动词）

现有 ctl 是 slash 的 IPC 代理（一对一封装），新体系改成 **4 动词 + 路径**结构：

| 4 动词 | 用途 | 例子 |
|---|---|---|
| `ctl get <path>` | 读 daemon 内运行时状态 | `ctl get session.current` / `ctl get channels` / `ctl get models` |
| `ctl set <path> <value>` | 改 session 级配置 | `ctl set session.current.model sonnet` / `ctl set session.current.perm bypass` |
| `ctl call <verb> [args]` | 触发 daemon 内动作 | `ctl call session.new` / `ctl call session.interrupt` / `ctl call service.restart` |
| `ctl reload [target]` | 重载配置/agent | `ctl reload config` / `ctl reload agent <name>` |

现有 14 个 ctl 命令的迁移：

| 现有 ctl 命令 | 新形式 |
|---|---|
| `ctl status` | `ctl get session.current` |
| `ctl check` | `ctl get channels` |
| `ctl help` | `ctl get help` |
| `ctl model [id]` | `ctl get session.current.model` / `ctl set session.current.model <id>` |
| `ctl effort [level]` | `ctl get session.current.effort` / `ctl set session.current.effort <level>` |
| `ctl compact` | `ctl call session.compact` |
| `ctl chatmode [mode]` | `ctl get session.current.chatmode` / `ctl set session.current.chatmode <mode>` |
| `ctl activity [mode]` | `ctl set session.current.activity <mode>` |
| `ctl perm [mode]` | `ctl set session.current.perm <mode>` |
| `ctl bind <path>` | `Edit evolclaw.json` + `ctl reload config`（不再走 ctl）|
| `ctl send <消息>` | `ctl call message.send <text>` |
| `ctl file [channel] <path>` | `ctl call message.send-file <path> [--channel <channel>]` |
| `ctl agentmd [...]` | `evolclaw aid agentmd ...`（不再走 ctl，daemon 不必参与）|
| `ctl restart [channel]` | `ctl call service.restart` / `ctl call channel.reconnect <type>` |

### 五、保留不动

| 命令 | 原因 |
|---|---|
| `evolclaw start / stop / restart / status / logs / diagnose / mv` | 进程级控制，给人用 |
| `evolclaw init feishu / wechat / dingtalk / qqbot / wecom / aun` | 扫码/交互 wizard，必须 CLI |
| `[SEND_FILE:路径]` inline 标记 | 已经是最原子的形态 |
| 高频 slash 命令（/new /s /p /status /stop /help 等 ~8 个） | 聊天 UX 糖，保留人类入口；底层走 ctl |

## 改造后重新设计命令体系的方向

三个改造完成后，slash 命令不是"删掉"而是**降级为 UX 糖**——底层全部走 ctl/aid/rpc/storage，slash 只是聊天里的快捷入口。

新命令体系的设计原则：

1. **ctl 4 动词是真相源**（get/set/call/reload），slash 是它的 alias
2. **slash 只保留高频 8 个**（/new /s /p /status /stop /help + 2 个待定），其余下沉到 namespace
3. **命令注册表**：一张表派生 dispatch / ctl 白名单 / menu / help，新增命令只改一处
4. **agent 提示词极简**：4 条决策规则（L0 查/L1 自调/L2 问用户/L3 不碰）+ 4 个工具入口

## 节奏

```
Phase 1（当前）：写方案文档 ← 你在这里
Phase 2：两个改造并行实施（各自独立会话推进）
Phase 3：改造验收通过后，设计新命令体系（基于本文档的归宿表）
Phase 4：实施新命令体系 + deprecation 过渡
```

## 文件索引

```
docs/refactor/
├── 00-overview.md          ← 本文件（上位逻辑 + 全局蓝图）
├── 01-db-to-fs.md          ← 数据库 → 文件系统
└── 02-aid-tool.md          ← AID 操作 + AUN RPC + Storage 工具
```
