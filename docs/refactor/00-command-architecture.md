# EvolClaw 命令体系架构

## 核心理念

EvolClaw 的命令分为三层，按**执行环境**和**依赖关系**划分：

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户/程序发起                             │
├───────────────────┬─────────────────────┬───────────────────────┤
│  CLI              │  CTL                │  Slash                 │
│  独立进程执行      │  需要 daemon 实例    │  前端路由层            │
│                   │                     │                       │
│  不依赖 daemon    │  复用连接/状态/会话   │  根据命令性质          │
│  谁都能调         │  必须 daemon 在      │  转发到 CLI 或 CTL     │
├───────────────────┼─────────────────────┼───────────────────────┤
│  evolclaw aid     │  evolclaw ctl model │  /aid → spawn CLI     │
│  evolclaw rpc     │  evolclaw ctl send  │  /model → 进程内 CTL  │
│  evolclaw storage │  evolclaw ctl stop  │  /storage → spawn CLI │
└───────────────────┴─────────────────────┴───────────────────────┘

另外存在一层：daemon 内部逻辑（不是命令，是业务行为）
  → 直接 import 模块调函数
  → 例：首次连接时自动发布 agent.md、收到消息时路由处理
```

---

## 三套命令体系详解

### CLI — 独立进程执行

**定位：** 不依赖 daemon 的独立工具。外部接口的唯一真相源。

**谁会用：**
- Agent 通过 Bash 调用
- 其他应用程序直接执行
- 终端用户手动执行
- Slash 转发（daemon spawn 子进程）

**特点：**
- daemon 不在也能用
- 每次行是独立进程（短生命周期）
- 自己建连接、自己认证、用完关闭
- 所有命令支持 `--format json`（agent 友好）

**入口：** `evolclaw <cmd> [args]`

### CTL — 需要 daemon 实例

**定位：** 必须依赖 daemon 运行时状态的操作。

**什么情况走 CTL：**
1. 需要用当前已建立的 AUN 连接（复用连接，省认证）
2. 需要用 daemon 当前的状态、数据、会话上下文
3. 需要操作运行中的 agent（中断、压缩、切换）

**执行链路：**
```
Agent/用户 → Bash("evolclaw ctl model sonnet")
  → CLI 进程读 EVOLCLAW_SESSION_ID（daemon 启动 agent 时注入）
  → 拼 slash 命令: "/model sonnet"
  → ipcQuery(socketPath, { type: "ctl", cmd, sessionId })
  → Unix socket / Named pipe 连接 daemon
  → daemon IPC Server 收到请求
  → commandExecutor(cmd, sessionId) → command-handler.handle()
  → 返回结果字符串
  → CLI 进程输出
```

**关键：** `EVOLCLAW_SESSION_ID` 是 daemon 启动 agent runner 时注入的环境变量，标识"当前是哪个会话"。没有这个变量，CTL 无法执行。

**智能路由（未来方向）：** 某些命令可以封装成 CLI，内部自动判断——daemon 在就走 IPC（快、省），daemon 不在就自己执行（慢但独立）。例如消息发送：有 daemon 可以复用接 + 填充默认值，没有 daemon 也能自己建短连接发。

### Slash — 前端路由层

**定位：** 前端用户或前端程序在聊天中发送的命令。Slash 是路由层，不是实现层。

**执行链路：**
```
前端用户发 "/aid list"
  → AUN 网络 → evolclaw daemon
  → command-handler 拦截（以 / 开头，在 commands 列表中）
  → 判断命令性质：
     ├─ CLI 类（/aid, /rpc, /storage）→ execFile("evolclaw", [...]) → 返回 stdout
     └─ CTL 类（/model, /send, /stop）→ 进程内直接执行 → 返回结果
```

**原则：** Slash 只负责路由和权限检查，不实现业务逻辑。

---

## Daemon 内部逻辑（非命令层）

daemon 自身的业务行为不走命令体系，直接 import 模块调函数：

| 行为 | 触发时机 | 实现方式 |
|---|---|---|
| 首次初始化 agent.md | 连接成功 + `initialized: false` | 直接调 `client.auth.uploadAgentMd()` |
| 收到消息路由 | AUN 消息到达 | 内部 handler 链 |
| 重连管理 | 连接断开 | SDK 自动重连 |
| Outbox 排空 | 重连成功 | 内部 drainOutbox |

**区分标准：**
- **用户/前端发起的操作** → 命令（CLI / CTL / Slash）
- **daemon 自身的自动行为** → 内部逻辑（直接调模块函数）

**示例：首次连接自动发布 agent.md**
```
daemon 连接成功 → sendWelcomeMessage()
  → 读本地 agent.md → 检查 initialized: false?
  → YES → 获取 owner 名片 → 生成正式 agent.md → 写本地 → uploadAgentMd → 给 owner 发欢迎消息
  → NO（已初始化）→ 跳过
```
这是 daemon 的内部初始化逻辑，不是命令。

---

## CLI 命令清单

| 命令 | 功能 | 依赖 daemon |
|---|---|:---:|
| `evolclaw init [channel]` | 创建配置文件（交互/非交互） | ❌ |
| `evolclaw start` | 启动 daemon | ❌ |
| `evolclaw stop` | 停止 daemon | ✅ IPC |
| `evolclaw restart` | 重启 daemon | ✅ IPC |
| `evolclaw status` | 查看 daemon 状态 | ✅ IPC |
| `evolclaw logs [--level --module --raw]` | 查看日志 | ❌（读文件） |
| `evolclaw watch` | 监控所有日志文件 | ❌（读文件） |
| `evolclaw diagnose` | 运行诊断 | ❌ |
| `evolclaw mv <from> <to>` | 迁移项目目录 | ❌ |
| `evolclaw ctl <cmd>` | 运行时管理（IPC 转发） | ✅ IPC |
| `evolclaw agent [list\|show\|new\|reload]` | Agent 管理 | 部分（reload 需 IPC） |
| `evolclaw aid [list\|show\|new\|delete\|lookup\|agentmd]` | AID 身份管理 | ❌ |
| `evolclaw rpc --as <aid> --params <json>` | AUN RPC 调用 | ❌ |
| `evolclaw storage [upload\|download\|ls\|rm\|quota]` | 文件存储 | ❌ |

---

## CTL 命令清单（通过 IPC 操作 daemon）

| 命令 | 功能 | 类别 |
|---|---|---|
| `ctl status` | 查看 session 状态 | 查询 |
| `ctl check` | 检查渠道健康 | 查询 |
| `ctl model [model-id]` | 查看/切换模型 | 配置 |
| `ctl effort [low\|medium\|high]` | 查看/切换推理强度 | 配置 |
| `ctl compact` | 压缩 session 上下文 | 操作 |
| `ctl chatmode [mode]` | 查看/切换会话模式 | 配置 |
| `ctl activity [all\|dm\|owner\|none]` | 控制中间输出 | 配置 |
| `ctl perm [mode]` | 查看/切换权限模式 | 配置 |
| `ctl send <text>` | 主动发消息 | 消息 |
| `ctl file [channel] <path>` | 发送项目文件 | 消息 |
| `ctl bind <path>` | 绑定项目目录 | 项目 |
| `ctl restart [channel]` | 重启/重连 | 运维 |

---

## Slash 命令清单

### 会话管理（进程内执行）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/new [名称]` | 创建新会话 | guest+ |
| `/s [cli\|名称\|序号]` | 列出/切换会话 | guest+ |
| `/session` | 同 /s | guest+ |
| `/slist` | 列出所有会话 | guest+ |
| `/rename <名称>` `/name` | 重命名会话 | guest+ |
| `/del <名称>` | 删除会话 | guest+ |
| `/fork [名称]` | 分支会话 | admin+ |
| `/rewind [N]` | 撤销轮次 | admin+ |
| `/compact` | 压缩上下文 | admin+ |
| `/repair` | 修复会话 | admin+ |

### 项目管理（进程内执行）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/pwd` | 显示当前项目路径 | admin+ |
| `/p [name\|path]` `/project` | 列出/切换项目 | admin+ |
| `/plist` | 列出所有项目 | admin+ |
| `/bind <path>` | 绑定新项目 | owner |

### Agent 与模型（进程内执行）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/agent [name]` | 查看/切换 Agent | admin+ |
| `/model [model]` | 查看/切换模型 | admin+ |
| `/setmodel [model]` | 设置模型 | admin+ |
| `/effort [level]` | 查看/切换推理强度 | admin+ |
| `/chatmode [mode]` | 查看/切换会话模式 | admin+ |

### 权限与控制（进程内执行）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/perm [mode]` | 权限模式管理 | admin+ |
| `/activity [mode]` | 控制中间输出 | admin+ |
| `/stop` | 中断当前任务 | admin+ |
| `/safe` | 全模式 | admin+ |

### 运维（进程内执行）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/status` | 显示会话状态 | guest+ |
| `/check` | 检查渠道健康 | guest+ |
| `/restart [channel]` | 重启/重连 | admin+/owner |
| `/file [channel] <path>` | 发送项目文件 | owner |
| `/send <text>` | 主动发消息 | owner |

### AID / RPC / Storage（CLI 转发）
| 命令 | 功能 | 权限 |
|---|---|---|
| `/aid [subcommand]` | AID 管理 → spawn CLI | owner |
| `/rpc --as <aid> --params <json>` | RPC 调用 → spawn CLI | owner |
| `/storage [subcommand]` | 存储管理 → spawn CLI | owner |

### 其他
| 命令 | 功能 | 权限 |
|---|---|---|
| `/help` | 帮助（人类可读） | guest+ |
| `/evolhelp` | 帮助（JSON，供程序解析） | guest+ |
| `/ask` | 提问 | admin+ |
| `/resume` | 恢复会话 | admin+ |

---

## IPC 协议

- 传输：Unix socket / Windows named pipe
- 格式：换行分隔的 JSON（请求 + 响应各一行）
- 超时：默认 10s，长操作（compact/restart）60s
- 权限：socket 文件 chmod 600（仅当前用户）

| IPC 类型 | 功能 |
|---|---|
| `ping` | 心跳 |
| `status` | daemon 状态（pid, uptime, channels, queue） |
| `aun-aids` | AUN AID 连接状态 |
| `ctl` | 执行 slash 命令（需 EVOLCLAW_SESSION_ID） |
| `evolagent.list` | 列出 agents |
| `evolagent.show` | 查看 agent 详情 |
| `evolagent.reload` | 重载 agent |

**CTL 的 IPC 链路：**
```
CLI 进程:
  1. 读 EVOLCLAW_SESSION_ID
  2. 拼 slash: "/" + args.join(" ")
  3. net.connect(socketPath)
  4. write({ type: "ctl", cmd: "/model sonnet", sessionId })

Daemon IPC Server:
  5. handleCommand → case "ctl"
  6. commandExecutor(cmd, sessionId) → command-handler.handle()
  7. 返回 { ok: true, result: "✓ 模型已切换: sonnet" }

CLI 进程:
  8. console.log(result)
```

---

## 功能域分析

### 1. Agent 管理

| 命令 | 体系 | 依赖 daemon | 说明 |
|---|---|:---:|---|
| `evolclaw agent` (list) | CLI | ❌ | 读配置文件 |
| `evolclaw agent <name>` (show) | CLI | ❌ | 读配置文件 |
| `evolclaw agent new <name>` | CLI | ❌ | 写配置文件 |
| `evolclaw agent reload <name>` | CLI→IPC | ✅ | 通知 daemon 重载 |
| `/agent [name]` (切换) | Slash→进程内 | ✅ | 需要 session 上下文 |

**典型场景：**
```bash
# 创建 agent
evolclaw agent new reviewer --non-interactive --runner claude --model sonnet

# 查
evolclaw agent reviewer

# 重载（改配置后）
evolclaw agent reload reviewer

# 聊天内切换
/agent reviewer
```

### 2. 消息通信

| 命令 | 体系 | 依赖 daemon | 场景 |
|---|---|:---:|---|
| `evolclaw rpc --as <aid> --params '{"method":"message.send",...}'` | CLI | ❌ | 独立发消息（指定收件人） |
| `evolclaw ctl send <text>` | CTL→IPC | ✅ | 在当前 session 上下文里说话 |
| `/send <text>` | Slash→进程内 | ✅ | 聊天内主动发消息 |

**两种发消息的区别：**
- `rpc message.send` — 我指定发给谁，独立于 session，不需要 daemon。自己建连接、认证、发送。
- `ctl send` — 在当前会话上下文里说话。复用 daemon 已有连接，自动填充 from/to/加密等默认值。

**典型场景：**
```bash
# Agent 给某人发消息（不依赖 daemon）
evolclaw rpc --as myaid.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"text","text":"hello"}}}'

# Daemon 内主动推送到当前会话
evolclaw ctl send "任务完成，请查看"

# 聊天内
/send 通知大家任务完成了
```

### 3. 文件管理

**两种"文件"操作：**

| | `storage`（云存储） | `/file`（聊天发附件） |
|---|---|---|
| 存储位置 | AUN 云存储 | 本地项目目录 → 聊天 |
| 操作 | 上传/下载/管理 | 发送给聊天对方 |
| 依赖 | 独立（CLI） | 需要消息通道（daemon） |
| 类比 | 网盘 | 微信发文件 |

**典型场景：**
```bash
# 上传文件到云存储
evolclaw storage upload myaid.agentid.pub ./report.pdf docs/report.pdf --public

# 下载别人的文件
evolclaw storage download myaid.agentid.pub bob.agentid.pub/docs/spec.pdf ./spec.pdf

# 发文件给聊天对方（需要 daemon）
/file src/main.ts
evolclaw ctl file src/main.ts

# 新机制：上传到云存储 + 通过消息发引用
evolclaw storage upload myaid.agentid.pub ./file.pdf shared/file.pdf --public
evolclaw rpc --as myaid.agentid.pub --params '{"method":"message.send","params":{"to":"bob.agentid.pub","payload":{"type":"file","url":"myaid.agentid.pub/shared/file.pdf"}}}'
```

---

## 迁移路线图

### 已完成

| 功能 | 旧入口 | 新入口 |
|---|---|---|
| AID 管理 | `aun-ops.ts` + slash 原生实现 | `evolclaw aid` + slash CLI 转发 |
| Agent.md | `evolclaw agentmd` + slash `/agentmd` | `evolclaw aid agentmd` |
| RPC | 无 | `evolclaw rpc` |
| Storage | 无 | `evolclaw storage` |

### 下一步可迁移（纯文件操作，不需要 IPC）

| 新 CLI 命令 | 替代 | 说明 |
|---|---|---|
| `evolclaw project list` | `/plist` | 读 config 列出项目 |
| `evolclaw project bind <path>` | `/bind` | 写 config |
| `evolclaw session list [--channel]` | `/slist` | 读 data/sessions/ |
| `evolclaw session delete <name>` | `/del` | 删 session 文件 |
| `evolclaw config show` | — | 查看当前配置 |
| `evolclaw config set <key> <value>` | — | 修改配置 |

### 需要 IPC 的（保持 CTL）

| 命令 | 原因 |
|---|---|
| `ctl model/effort/perm/activity/chatmode` | 需要通知 daemon 运行时切换 |
| `ctl compact` | 操作运行中的 agent 上下文 |
| `ctl send` / `ctl file` | 需要消息发送通道 |
| `ctl restart` | 控制 daemon 进程 |
| `ctl stop` | 中断运行中的任务 |

### 智能路由候选（CLI 封装，内部自动判断）

| 命令 | daemon 在 | daemon 不在 |
|---|---|---|
| `evolclaw send <aid> <text>` | IPC 复用连接（快） | 自建短连接发送（慢但可用） |
| `evolclaw model [model]` | IPC 切换运行时 | 写 config（下次生效） |

---

## 设计原则

1. **CLI 是外部接口的唯一真相源** — 外部有的工具，内部统一用 CLI（spawn），不在内部再实现一套
2. **CTL 用于必须依赖实例的操作** — 需要当前连接、状态、会话的操作走 IPC
3. **Slash 是路由层不是实现层** — 根据命令性质转发到 CLI（spawn）或进程内执行（CTL 类）
4. **Daemon 内部逻辑不是命令** — 自动行为（初始化、重连、消息路由）直接调模块函数
5. **Agent 友好** — 所有 CLI 命令支持 `--format json`，agent 用 Bash 即可驱动
6. **独立性** — CLI 命令在 daemon 不在时也能用，这是 CLI 存在的核心价值

---

*最后更新：2026-05-17*
