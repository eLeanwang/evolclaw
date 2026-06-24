# Agent 命令集设计文档

## 一、Agent 目录结构

```
EVOLCLAW_HOME/                          # 默认 ~/.evolclaw
└── agents/
    ├── defaults.json                   # 全局默认配置（baseagents、models、projects 等）
    └── <aid>/                          # 每个 agent 独立目录，以 AID 命名
        ├── config.json                 # agent 主配置
        ├── personal/                   # 个人化数据（反思、总结、偏好）
        ├── identities/                 # 身份相关
        │   ├── _index
        │   ├── _observed
        │   ├── _trash
        │   └── contacts/
        ├── venues/                     # 渠道/场景数据
        │   ├── _index
        │   └── _trash
        ├── sessions/                   # 会话历史
        └── data/                       # 运行时数据
            └── cache/

~/.aun/AIDs/<aid>/                      # AID 密钥（由 aid 命令管理）
├── agent.md                            # 公开名片（name、description、tags 等）
├── public/cert.pem
└── private/key.pem
```

路径函数（`src/paths.ts`）：

| 函数 | 返回路径 |
|---|---|
| `agentDir(aid)` | `EVOLCLAW_HOME/agents/<aid>` |
| `agentConfig(aid)` | `EVOLCLAW_HOME/agents/<aid>/config.json` |
| `agentPersonalDir(aid)` | `EVOLCLAW_HOME/agents/<aid>/personal` |
| `agentIdentitiesDir(aid)` | `EVOLCLAW_HOME/agents/<aid>/identities` |
| `agentVenuesDir(aid)` | `EVOLCLAW_HOME/agents/<aid>/venues` |
| `agentSessionsDir(aid)` | `EVOLCLAW_HOME/agents/<aid>/sessions` |
| `agentDataDir(aid)` | `EVOLCLAW_HOME/agents/<aid>/data` |

所有 agent 命令只需注入 `aid`，通过上述函数构造具体路径，不硬编码。

---

## 通用选项

所有 agent 子命令均支持：

| 选项 | 说明 |
|---|---|
| `--format json` | 输出 JSON 格式（适合脚本/管道消费） |

JSON 输出约定：
- 成功：`{ "ok": true, ...data }`
- 失败：`{ "ok": false, "error": "<message>" }`
- list 类命令返回数组字段（如 `"agents": [...]`）
- show 类命令返回对象字段

---

## 二、Agent 命令集全貌

### 查询类

| 命令 | 操作文件 | 说明 | 状态 |
|---|---|---|---|
| `agent list` | `agents/*/config.json`（读） | 列出所有 agent 及运行状态 | ✅ 已有 |
| `agent show <aid>` | `config.json`（读）+ `~/.aun/AIDs/<aid>/agent.md`（读） | 查看 agent 详情（见下） | ✅ 已有（需扩展） |

`agent show` 输出结构：
```
<aid> (running|stopped|error)

  Identity
    Name:         <from agent.md>
    Description:  <from agent.md>

  Config
    Baseagent:    claude
    Chatmode:     private=interactive  group=proactive
    Owners:       <aid>
    Channels:     aun, feishu

  Connection (from AUN runtime, same as watch aid)
    Status:       connected
    Uptime:       2h35m12s
    Reconnects:   1
    Msgs recv:    42
    Msgs sent:    18
    Bytes in:     12.3 KB
    Bytes out:    8.7 KB
    Last recv:    3m ago
    Last sent:    1m ago
    Peers:        5

  Sessions
    Active:       2
    Last active:  3 minutes ago

  Paths
    Config:       ~/.evolclaw/agents/<aid>/config.json
    Agent.md:     ~/.aun/AIDs/<aid>/agent.md
    Project:      <projectPath>
    Data:         ~/.evolclaw/agents/<aid>/data/
```

`--format json` 输出示例：
```json
{
  "ok": true,
  "aid": "mybot.agentid.pub",
  "status": "running",
  "identity": { "name": "MyBot", "description": "..." },
  "config": { "baseagent": "claude", "chatmode": {...}, "owners": [...], "channels": [...] },
  "connection": {
    "status": "connected",
    "uptime_ms": 9312000,
    "reconnect_count": 1,
    "messages_received": 42,
    "messages_sent": 18,
    "bytes_received": 12595,
    "bytes_sent": 8908,
    "last_received_at": "2026-05-18T10:12:00Z",
    "last_sent_at": "2026-05-18T10:14:00Z",
    "unique_peer_count": 5
  },
  "sessions": { "active": 2, "last_activity": "2026-05-18T10:14:00Z" },
  "paths": {
    "config": "~/.evolclaw/agents/mybot.agentid.pub/config.json",
    "agent_md": "~/.aun/AIDs/mybot.agentid.pub/agent.md",
    "project": "/path/to/project",
    "data": "~/.evolclaw/agents/mybot.agentid.pub/data/"
  }
}
```

### 创建类

| 命令 | 操作文件 | 说明 | 状态 |
|---|---|---|---|
| `agent new [aid]` | `config.json`（写）+ agent 目录骨架（创建）+ `agent.md`（创建+上传） | 交互式创建 | ✅ 已有（需补 agentmd 步骤） |
| `agent new <aid> --non-interactive ...` | 同上 | 非交互式创建 | ✅ 已有（需补 agentmd 步骤） |
| `agent sync-aids` | `config.json`（批量写）+ agent 目录骨架（批量创建） | 从本地已有 AID 批量创建 | ✅ 已有 |

`agent new` 完整创建流程（补全后）：
1. 验证 AID 格式
2. `aidCreate(aid)` — 注册 AID + 生成密钥
3. 交互式填写 name、description（非交互式通过 `--name`、`--description` 传入）
4. `buildInitialAgentMd()` + `agentmdPut()` — 生成并上传 agent.md
5. `saveAgent()` — 写 config.json
6. `ensureAgentDirSkeleton()` — 创建目录骨架

### 修改类

| 命令 | 操作文件 | 说明 | 状态 |
|---|---|---|---|
| `agent enable <aid>` | `config.json`（写 `enabled: true`）+ IPC reload | 启用 agent | ❌ 缺 |
| `agent disable <aid>` | `config.json`（写 `enabled: false`）+ IPC reload | 停用 agent | ❌ 缺 |
| `agent get <aid> <key>` | `config.json`（读单字段） | 读取单个配置字段 | ❌ 缺 |
| `agent set <aid> <key> <value>` | `config.json`（写单字段）+ IPC reload | 修改单个配置字段 | ❌ 缺 |

`agent get/set` 支持点路径，例如：
```
evolclaw agent get mybot.agentid.pub active_baseagent
evolclaw agent set mybot.agentid.pub active_baseagent codex
evolclaw agent set mybot.agentid.pub chatmode.private proactive
```

### 生命周期类

| 命令 | 操作文件 | 说明 | 状态 |
|---|---|---|---|
| `agent reload [aid]` | IPC（`evolagent.reload` / `evolagent.resync`） | 热重载配置 | ✅ 已有 |
| `agent delete <aid> [--purge]` | `config.json`（删）+ IPC 下线；`--purge` 同时删 `agents/<aid>/` 整个目录 | 删除 agent | ❌ 缺 |

---

## 三、代码目录结构

### 现状

```
src/
├── aid/index.ts          # AID 管理逻辑（独立模块）
├── storage/index.ts      # 存储逻辑（独立模块）
├── aun-rpc/index.ts      # RPC 逻辑（独立模块）
├── config-store.ts       # agent 配置读写（saveAgent、loadAllAgents 等）
└── cli.ts                # 所有命令实现混在一起（126KB）
```

agent 相关逻辑（`cmdAgentNew`、`cmdAgentList`、`cmdAgentShow` 等）全部在 `cli.ts` 里，没有独立模块。

### 目标结构

```
src/
├── aid/index.ts
├── storage/index.ts
├── aun-rpc/index.ts
├── agent/
│   └── index.ts          # agent 命令集全部实现（list、show、create、manage、sync、delete）
├── config-store.ts
└── cli.ts                # cmdAgent() 薄壳：解析参数 + --format json 判断 + 调用 agent/index.ts
```

`agent/index.ts` 导出各命令函数，每个函数接收结构化参数、返回数据对象。`cli.ts` 负责参数解析和输出格式化。

---

## 四、与 aid/storage/rpc 对齐的机制约定

agent 模块必须与现有 aid、storage、rpc 模块保持一致的模式：

### 模块层（`src/agent/index.ts`）

| 约定 | 说明 |
|---|---|
| 纯业务逻辑 | 不做 `console.log`、不调 `process.exit` |
| 结构化入参 | 函数接收具名参数（对象或独立参数），不接收 raw `args: string[]` |
| 结构化返回 | 返回 typed 数据对象（`AgentResult<T>`），成功 `{ ok: true, ...data }`，失败 `{ ok: false, error }` |
| 类型导出 | 在同文件顶部定义并 export 所有返回类型接口 |
| 动态导入依赖 | 需要 aid 模块时用 `await import('../aid/index.js')` |

### cli 薄壳层（`cli.ts` 中的 `cmdAgent`）

| 约定 | 说明 |
|---|---|
| 单入口函数 | `async function cmdAgent(args: string[]): Promise<void>` |
| 通用选项解析 | 开头统一解析 `--format json` |
| help 子命令 | `sub === 'help'` 打印完整用法（与 aid/storage 一致） |
| 动态导入模块 | `const { agentList, agentShow, ... } = await import('./agent/index.js')` |
| 参数校验 | cli 层做基本校验（缺参数、无效 AID），校验失败 `process.exit(1)` |
| 输出分支 | `if (formatJson) { console.log(JSON.stringify(result)) } else { 人类友好格式 }` |
| 错误处理 | 捕获模块返回的 `{ ok: false, error }` → formatJson 输出 JSON / 否则 `console.error` + `process.exit(1)` |

### 对比参照

```
// aid 模块模式（已有）
const { aidList } = await import('./aid/index.js');
const aids = aidList(aunPath);
if (formatJson) { console.log(JSON.stringify(aids, null, 2)); return; }
// ... 人类友好输出

// agent 模块模式（目标，完全一致）
const { agentList } = await import('./agent/index.js');
const result = await agentList({ socketPath: p.socket });
if (formatJson) { console.log(JSON.stringify(result)); return; }
// ... 人类友好输出
```

---

## 五、实现路线图

### Phase 1：抽 `src/agent/index.ts` + 迁移现有命令（含新增命令）

将 `cli.ts` 中现有 agent 命令逻辑迁移到 `src/agent/index.ts`：

1. 创建 `src/agent/index.ts`，把 `cmdAgentList`、`cmdAgentShow`、`cmdAgentNew`、`cmdAgentNewNonInteractive`、`cmdAgentSyncAids`、`cmdAgentReload` 的业务逻辑搬过去
2. `cli.ts` 中 `cmdAgent` 路由改为薄壳：解析参数 → 调用模块 → 根据 `--format json` 输出
3. 所有命令加入 `--format json` 支持

不改任何对外行为，只做内部重构。

### Phase 2：补全 `agent new` 的 agentmd 步骤

- 在交互式和非交互式创建流程中加入 name、description 输入
- 调用 `buildInitialAgentMd()` + `agentmdPut()` 上传
- 非交互式新增 `--name`、`--description` 可选 flags

### Phase 3：新增缺失命令

在 `src/agent/index.ts` 中实现，按依赖顺序：

1. `agent enable / disable` — 改一个字段 + reload
2. `agent get / set` — 支持点路径读写
3. `agent delete` — IPC 下线 + 文件删除

### Phase 4：扩展 `agent show` 输出

- 加 Connection 段（从 IPC `aun-aids` + `aun-aid-stats` 获取，与 watch aid 同源）
  - status、uptime、reconnects、msgs recv/sent、bytes in/out、last recv/sent、peers
- 加 Identity 段（从 agent.md 读 name、description）
- 加 Paths 段（config、agent.md、project、data 路径）
- daemon 离线时 Connection 段显示 `(daemon offline)` 或 JSON 中为 `null`

---

## 六、cli-reference.md 更新内容

将 `## Agent 管理` 章节替换为：

```
## Agent 管理

通用选项: `--format json` 输出 JSON 格式（所有子命令均支持）

### 查询
evolclaw agent                        列出所有 agent
evolclaw agent list                   同上
evolclaw agent show <aid>             查看 agent 详情（身份 + 配置 + 连接 + 会话 + 路径）

### 创建
evolclaw agent new [aid]              交互式创建（含 AID 注册 + agent.md 上传）
evolclaw agent new <aid> --non-interactive \
  --baseagent <claude|codex|gemini|hermes> \
  --project <path> \
  [--name <name>] [--description <desc>] \
  [channel flags] [behavior flags]
evolclaw agent sync-aids              从本地 AID 批量创建 agent

### 修改
evolclaw agent enable <aid>           启用 agent
evolclaw agent disable <aid>          停用 agent
evolclaw agent get <aid> <key>        读取单个配置字段（支持点路径）
evolclaw agent set <aid> <key> <val>  修改单个配置字段（支持点路径）

### 生命周期
evolclaw agent reload                 全量 resync
evolclaw agent reload <aid>           热重载指定 agent 配置
evolclaw agent delete <aid>           删除 agent 配置（停止运行中的 agent）
evolclaw agent delete <aid> --purge   同上，并删除 agent 数据目录
```
