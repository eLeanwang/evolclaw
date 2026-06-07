# EvolAgent Mode 设计方案

## 1. 概述

### 1.1 背景

EvolClaw 当前有两种会话模式（interactive / proactive），但"一个 agent 是什么"这件事散落在多处配置中：

- `evolclaw.json` 管 channel 凭证、project 路径、baseagent 凭证
- `sessionMode` 写在 session 里
- `/agent` 命令切换后端
- `/bind /project` 绑定工作目录
- AUN `agent.md` 管网络身份
- `/aid /agentmd` 手动管理 AUN 身份
- `owners` / admin / guest 权限分散在 channel 层

这导致"创建一个新 bot"需要改多处配置、执行多条命令，且无法分发/复用。

### 1.2 目标

引入 **EvolAgent** 作为一等实体：

- **一个 JSON 文件 = 一个完整 agent**，自包含所有运行时配置
- 多 agent 并发运行，各自独占 channel 资源
- DefaultAgent 兜底处理未被领走的 channel
- 人格 prompt 由项目 CLAUDE.md 承载，全局能力由 SKILLS.md 提供
- AUN agent.md 自动派生，无需手动管理
- CLI 提供 agent 创建与查看（list / new / reload），删除通过直接删 json + restart 完成

### 1.3 设计原则

- **声明式优先**：agent.json 是 source of truth，运行时命令只是调试旁路
- **自包含**：拿到一个 agent.json 就能跑，不依赖 evolclaw.json 有对应配置
- **资源独占**：物理 channel 全局唯一，不允许多 agent 共用
- **冲突即报错**：不做优先级仲裁，配置冲突必须人工修复

---

## 2. 文件格式

### 2.1 文件位置

```
~/.evolclaw/agents/
├── review-bot.json
├── scrum-bot.json
└── doc-writer.json
```

单文件，不需要目录。

### 2.2 agent.json 完整格式

```json
{
  "name": "review-bot",
  "enabled": true,

  "agents": {
    "anthropic": {
      "model": "sonnet",
      "effort": "high",
      "useSettingSources": true
    }
  },

  "channels": {
    "feishu": [
      {
        "name": "feishu-review",
        "enabled": true,
        "appId": "cli_xxx",
        "appSecret": "xxx",
        "flushDelay": 4,
        "debounce": 2,
        "showActivities": "dm-only",
        "owner": "ou_xxx"
      }
    ],
    "aun": {
      "enabled": true,
      "aid": "review.agentid.pub",
      "owner": "molian.agentid.pub",
      "showActivities": "owner-dm-only"
    }
  },

  "projects": {
    "defaultPath": "/home/user/projects/review"
  },

  "chatmode": {
    "private": "interactive",
    "group": "proactive"
  }
}
```

### 2.3 字段说明

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | ✅ | string | 唯一标识，用于 CLI 和路由；同时用于 AUN agent.md 派生 |
| `enabled` | 否 | boolean | 默认 `true`，`false` 时 `evolclaw start` 跳过 |
| `channels` | ✅ | object | 格式与 evolclaw.json.channels 一致：`{<type>: instance | [instances]}`。无全局默认字段（flushDelay/debounce/showActivities 各实例自行配置） |
| `projects` | ✅ | object | `{ "defaultPath": "<绝对路径>" }`。无 list / autoCreate |
| `chatmode` | 否 | object | 按 chatType 分设：`{ "private": "interactive", "group": "proactive" }`。未填时继承 evolclaw.json 全局 chatmode |
| `agents` | ✅ | object | baseagent 配置，结构与 evolclaw.json.agents 一致但去掉 `defaultAgent`（只有一个 baseagent 配置块） |

### 2.4 channels 格式

严格遵循 evolclaw.json 的 channels 结构：

```json
"channels": {
  "feishu": [ { "name": "feishu-review", ... } ],     // 数组：多实例，每个必须有 name
  "aun": { "aid": "review.agentid.pub", ... },        // 对象：单实例，name 可省略（缺省用 channel 类型名 "aun"）
  "wechat": { "name": "wechat-review", ... }          // 对象：单实例，可显式给 name 覆盖默认
}
```

- 所有 channel 类型均可配置单实例（对象）或多实例（数组），与 evolclaw.json 一致
- 实例字段与 evolclaw.json 对应 channel 类型完全一致（`enabled`、凭证字段、`flushDelay`、`debounce`、`showActivities`、`owner` 等）
- **name 字段规则**（与 evolclaw.json 行为一致）：
  - 数组形式：每个实例 `name` 必填，用于区分同类型多实例
  - 对象形式：`name` 可省略，缺省时以 channel 类型名作为隐式 name

### 2.5 agents 内部字段

结构与 evolclaw.json 的 `agents` 一致，但去掉 `defaultAgent` 字段（只允许一个 baseagent 配置块）：

```json
"agents": {
  "anthropic": {
    "model": "sonnet",
    "effort": "high",
    "useSettingSources": true
  }
}
```

启动时校验：若出现多个 baseagent 配置块，该 evolagent 标记 error。

### 2.6 和 evolclaw.json 的对比

| 维度 | evolclaw.json | agent.json | 差异 |
|---|---|---|---|
| **channels** | `defaultChannel` + 多类型多实例 | 无 `defaultChannel`，仅声明自己的实例 | agent 无全局 channel 概念 |
| **agents** | `defaultAgent` + 多 baseagent 配置块 | 无 `defaultAgent`，仅一个配置块 | agent 绑死单一 baseagent |
| **projects** | `defaultPath` + `list` + `autoCreate` | 仅 `defaultPath` | agent 单项目，无命名映射 |
| **全局默认** | `flushDelay` / `debounce` / `showActivities` | 无 | agent 各 channel 实例自行配置 |
| **idleMonitor** | ✅ | 无 | 继承进程级全局设置 |
| **debug** | ✅ | 无 | 继承进程级全局设置 |
| **chatmode** | 全局顶层 `{ private, group }`（不再支持 channel 实例内单独设置） | 顶层对象，可选（未填继承 evolclaw.json） | agent 可覆盖全局，channel 实例内不允许单独设置 |
| **互不依赖** | 不需要知道 agent.json 的存在 | 不需要引用 evolclaw.json 的内容 | 完全自包含 |

### 2.7 人格 prompt 来源

EvolAgent 不自带 prompt 文件。人格由以下来源组合：

```
项目 CLAUDE.md（项目级指令）
  + 全局 SKILLS.md（按 trigger 懒加载的能力库，所有 agent 共享）
  = 最终 system prompt
```

这和当前 default 模式的 prompt 组装逻辑完全一致，agent 不额外注入内容。

---

## 3. 运行时架构

### 3.1 核心类

```typescript
class EvolAgent {
  readonly name: string;
  readonly configPath: string;             // ~/.evolclaw/agents/review-bot.json
  readonly config: EvolAgentConfig;        // 解析后的 JSON

  // 绑定的资源（启动后填充）
  channels: Map<string, ChannelAdapter>;
  
  // 运行时状态
  activeSessions: number;
  lastActivity?: number;
  status: 'running' | 'error' | 'disabled';

  // 方法
  getContext(channelName: string, chatType: string): AgentContext;
  reload(): void;                          // 热重载
}

class AgentRegistry {
  private agents: Map<string, EvolAgent>;  // name → instance
  private channelIndex: Map<string, string>; // channelFingerprint → agentName
  private defaultAgent: EvolAgent;

  loadAll(globalConfig: Config): void;
  resolve(channelFingerprint: string): EvolAgent;
  reload(name: string): void;
  list(): AgentInfo[];
  get(name: string): EvolAgent | undefined;
}
```

### 3.2 AgentContext

新增的 per-channel-instance 运行时上下文，与现有 `ChannelOptions` 并存。ChannelOptions 负责 channel 自身（flushDelay/channelType/systemPromptAppend），AgentContext 负责 agent 层：

```typescript
interface AgentContext {
  name: string;                            // evolagent name
  isOwned: boolean;                        // true = agent-owned, false = default
  baseagent: string;                       // runner name: 'claude' | 'codex' | 'gemini'
  model?: string;
  effort?: string;
  chatMode: 'interactive' | 'proactive';   // 根据当前 chatType 从 chatmode 对象取值
  projectPath: string;                     // projects.defaultPath
}
```

MessageProcessor 通过 `channelName → AgentRegistry.resolve()` 获取 AgentContext，用于：
1. 决定 session 创建时的默认 agentId / projectPath / chatMode
2. CommandHandler 判断 `isOwned` 拦截锁定类命令

### 3.3 DefaultAgent

evolclaw.json 中声明的 channels 归 DefaultAgent。它是一个 EvolAgent 实例，配置从 evolclaw.json 构造：

- channels：evolclaw.json 中所有 channel 实例
- projectPath：`projects.defaultPath`
- baseagent：`agents.defaultAgent` 对应的 runner name（如 `"claude"`）
- chatMode：从 evolclaw.json 顶层 `chatmode` 对象按 chatType 取值（private/group）

代码路径和普通 agent 完全一致，无特殊分支。

> 注：channel 实例要么由 evolclaw.json 声明（归 DefaultAgent），要么由某个 agent.json 声明（归该 agent）。不存在"未被任何配置声明"的 channel。

### 3.4 消息路由

```
Channel.onMessage(channelId, message)
  → MessageQueue.enqueue(channelId, message)
  → MessageProcessor.processMessage(message)
     → 从 message.channel（实例名）查 AgentRegistry.resolve(channelName)
     → agent.getContext(channelName, chatType) → AgentContext
     → 用 AgentContext 决定 session 默认值（agentId / projectPath / chatMode）
     → 用 AgentContext.isOwned 控制命令拦截
```

注：MessageProcessor.processMessage 签名不变（仍只接收 Message），AgentContext 在内部通过 channelName 查询获得。

### 3.5 优先级链（运行时覆盖）

**agent-owned channel：**
```
运行时命令（/model /effort）→ session 级覆盖
  ↓ 未设置时 fallback
agent.json 中的值（终点，不再向上查找）
```

**default channel：**
```
运行时命令（/model /chatmode /effort /agent）→ session 级覆盖
  ↓ 未设置时 fallback
evolclaw.json 全局默认
```

agent-owned channel 不依赖 evolclaw.json，完全自包含。

---

## 4. 冲突检测

### 4.1 检测时机

`evolclaw start` 时，`AgentRegistry.loadAll()` 执行全局扫描。

### 4.2 Channel Fingerprint

统一字符串形式 `{type}:{primaryKey}`，便于扩展新 channel 类型：

| Channel 类型 | Fingerprint | 来源字段 |
|---|---|---|
| feishu | `feishu:{appId}` | `appId` |
| aun | `aun:{aid}` | `aid` |
| wechat | `wechat:{token}` | `token` |
| wecom | `wecom:{botId}` | `botId` |
| dingtalk | `dingtalk:{clientId}` | `clientId` |
| qqbot | `qqbot:{appId}` | `appId` |

### 4.3 检测逻辑

```
对所有 agent.json + evolclaw.json(default) 中的 channel：
  提取 fingerprint
  如果同一 fingerprint 出现两次：
    → 两边都不启动该 channel
    → 涉及的 agent 标记 status: error
    → 日志 + 启动时报错提示
```

### 4.4 报错格式

```
❌ Channel conflict detected:
   Feishu app [cli_xxx] is claimed by both:
     - agent "review-bot" (channels.feishu-review)
     - agent "scrum-bot" (channels.feishu-scrum)
   
   Each physical channel can only belong to one agent.
   Fix: remove it from one of the configs.
```

### 4.5 Project 不冲突

多个 agent 可绑定同一项目目录。会话按 channelId 隔离，不会互相干扰。

---

## 5. 启动流程

```
evolclaw start
  │
  ├─ 1. 加载 evolclaw.json（全局配置）
  │
  ├─ 2. AgentRegistry.loadAll()
  │     ├─ 扫描 ~/.evolclaw/agents/*.json
  │     ├─ 对每个文件：解析 JSON，校验 schema
  │     ├─ 冲突检测（channel fingerprint 全局唯一）
  │     ├─ 创建 EvolAgent 实例（enabled 且无冲突的）
  │     └─ 创建 DefaultAgent（从 evolclaw.json 构造）
  │
  ├─ 3. Channel 创建与连接
  │     ├─ ChannelLoader.createAll(evolclaw.json config) → DefaultAgent 的 instances
  │     ├─ 对每个 EvolAgent：ChannelLoader.createAll(agent partial config) → agent 的 instances
  │     ├─ ChannelLoader.connectAll(所有 instances)
  │     └─ 按 fingerprint 分配 adapter → 对应 EvolAgent.channels 或 DefaultAgent.channels
  │
  ├─ 4. 注册 MessageQueue 路由 + CommandHandler（共享实例，通过 AgentContext 区分行为）
  │
  └─ 5. 写 ready.signal
```

---

## 6. 热重载

### 6.1 触发方式

```bash
evolclaw agent reload <name>    # CLI 命令，通过 IPC 发给运行中进程
```

或未来：file watcher 监听 `~/.evolclaw/agents/*.json` 变更。

### 6.2 重载流程

```
AgentRegistry.reload(name)
  → 重新读取 agent.json
  → 校验配置合法性
  → 如果 channels 绑定变了：
     - fingerprint 冲突检测（有冲突则拒绝 reload，报错）
     - drain 当前活跃消息（等正在处理的消息完成）
     - 断开旧 channel 连接
     - 启动新 channel 连接
     - 更新路由表
  → 更新 EvolAgent 实例其他字段（chatmode/project/agents）
  → 已有 session 不中断（下次消息时用新配置）
```

### 6.3 不重载的内容

- 已有 session 的 baseagent/model 不强制切换（用户可能已手动 `/model` 过）
- channel 连接如果凭证没变，不断开重连

### 6.4 约束

- **channel 实例名禁止变更**：实例名是 session.channel 的外键改名会导致历史 session 孤儿。要换名只能删旧建新

---

## 7. CLI 命令

### 7.1 Agent 管理

```bash
evolclaw agent                    # 列出所有 agent 及状态
evolclaw agent <name>             # 查看详情
evolclaw agent new <name>         # 创建（交互式 init，一步到位）
evolclaw agent reload <name>      # 热重载（IPC 发给运行中进程）
```

**删除 agent**：直接删 `~/.evolclaw/agents/<name>.json` + `evolclaw restart`（不提供 CLI 包装，避免误操作）。

### 7.2 `evolclaw agent`（列表输出）

```
NAME          STATUS    CHANNELS              PROJECT              BASEAGENT  LAST ACTIVE
review-bot    running   feishu-review, aun    /home/.../review     claude     2分钟前
scrum-bot     running   aun-scrum             /home/.../scrum      claude     15分钟前
doc-writer    disabled  —                     —                    —          —
[default]     running   feishu-main, wechat   /home/.../default    claude     刚刚
```

### 7.3 `evolclaw agent new <name>`（交互式创建）

```bash
$ evolclaw agent new review-bot

Creating agent: review-bot

Project path: /home/user/projects/review
Baseagent (claude/codex/gemini) [claude]: 
Model (sonnet/opus/haiku) [sonnet]: 
Effort (low/medium/high/max) [high]: 
ChatMode private (interactive/proactive) [interactive]: 

Add channel? (y/n): y
Channel type (feishu/aun/wechat/wecom/dingtalk/qqbot): aun
  → [生成 AID 密钥对到 ~/.aun/AIDs/<aid>/]
  → AID: review.agentid.pub
  → Owner AID: molian.agentid.pub

Add another channel? (y/n): y
Channel type (feishu/aun/wechat/wecom/dingtalk/qqbot): feishu
  → [进入 feishu init 流程：QR 扫码 / 填 appId]
  → Channel name: feishu-review

Add another channel? (y/n): n

Created: ~/.evolclaw/agents/review-bot.json
Run `evolclaw restart` to activate.
```

**AUN channel 创建**：`agent new` 内部调用现有 AID 创建逻辑（生成密钥对到 `~/.aun/AIDs/<aid>/`），用户无需单独 `evolclaw init aun`。

---

## 8. 命令体系重组

### 8.1 三个命令面

| 面 | 受众 | 职责 |
|---|---|---|
| **CLI** (`evolclaw <cmd>`) | 运维/owner 在终端 | 进程生命周期 + agent CRUD |
| **ctl** (`evolclaw ctl <cmd>`) | AI 模型通过 Bash | 运行时自管理（当前 session 范围） |
| **斜杠** (`/<cmd>`) | 用户在 channel 里 | 会话管理 + 运行时调整 |

### 8.2 CLI 命令（终端）

```bash
# 进程管理（不变）
evolclaw start | stop | restart | status | logs

# Agent CRUD（新增）
evolclaw agent
evolclaw agent <name>
evolclaw agent new <name>
evolclaw agent reload <name>   # 通过 IPC 通知运行中进程热重载

# 初始化（保留，仅用于 default 模式）
evolclaw init [feishu|wechat|aun|wecom|dingtalk|qqbot]
```

### 8.3 ctl 命令（模型自调用）

```bash
# 保留（全部保留，不移除）
evolclaw ctl status
evolclaw ctl model [<id>]
evolclaw ctl effort [<level>]
evolclaw ctl compact
evolclaw ctl send <text>
evolclaw ctl file <path>
evolclaw ctl check
evolclaw ctl perm [<mode>]
evolclaw ctl activity [<mode>]
evolclaw ctl restart [<channel>]
evolclaw ctl chatmode [<mode>]
evolclaw ctl aid
evolclaw ctl agentmd

# 新增
evolclaw ctl evolagent                  # 查看当前 evolagent 身份
evolclaw ctl evolagent reload [<name>]  # 热重载
```

### 8.4 斜杠命令（channel 内）

| 命令 | default channel | agent-owned channel | 说明 |
|---|---|---|---|
| `/help` | ✅ | ✅ | agent-owned 隐藏不可用命令 |
| `/status` | ✅ | ✅ | agent-owned 显示 agent name |
| `/agent` | ✅ | ⚠️ 只读 | 无参查看可用；带 name 切换时 agent-owned 下拒绝（绑死单一 baseagent） |
| `/model <id>` | ✅ | ✅ | session 级覆盖 |
| `/effort <level>` | ✅ | ✅ | session 级覆盖 |
| `/new` | ✅ | ✅ | 新建 session |
| `/slist /session` | ✅ | ✅ | 会话管理 |
| `/rename /del` | ✅ | ✅ | 会话管理 |
| `/compact /clear /fork /rewind` | ✅ | ✅ | 会话操作 |
| `/activity` | ✅ | ✅ | interactive 模式下有效 |
| `/check` | ✅ | ✅ | 健康检查 |
| `/chatmode` | ✅ | ✅ | 保持原行为，不限制 |
| `/aid /agentmd` | ✅ | ✅ | 保持原行为，不限制 |
| `/project /bind /plist` | ✅ | ❌ 禁用 | agent 项目已锁定 |

### 8.5 agent-owned channel 命令禁用

禁用的命令返回提示而非静默忽略：

```
> /project review
❌ 当前通道由 agent [review-bot] 管理，项目已锁定为 /home/.../review
```

实现：`CommandHandler` 执行前检查 `AgentContext.isOwned`，对锁定类命令拦截。

### 8.6 Breaking Changes

本方案不对现有命令做重命名或移除。新增的 `evolclaw agent` CLI 和 `evolclaw ctl evolagent` 是纯新增。唯一的行为变化：

| 变化 | 说明 |
|---|---|
| `/project /bind /plist` | agent-owned channel 上禁用（项目锁定） |
| `/agent <name>` | agent-owned channel 上拒绝切换（baseagent 锁定），无参查看仍可用 |

---

## 10. 错误处理与运行时行为

| 场景 | 行为 |
|---|---|
| agent.json 解析失败 | 该 agent 标记 `status: error`，不影响其他 agent |
| agent.json schema 校验失败 | 同上，报错指出具体字段 |
| channel 凭证无效（连接失败） | 该 channel 标记 error，agent 其余 channel 正常 |
| 两个 agent 抢同一 channel | 两边都不启动该 channel，都标记 error |
| project 路径不存在 | warn 日志，启动时自动创建目录 |
| agent `enabled: false` | 不启动该 agent 的 channel，已有 session 自然冻结（数据保留，重新 enable 后恢复） |
| 多个 baseagent 配置块 | 该 agent 标记 error |
| channel 实例名重复（跨 agent） | 等同于 fingerprint 冲突，报错 |

### 10.1 Owner 自动绑定

agent-owned channel 的 owner 绑定行为与 default channel 完全一致：

- 首次交互时自动绑定用户 ID 为 owner
- **写入位置**：agent.json 对应 channel 实例的 `owner` 字段（运行时写回文件）
- 权限体系（owner/admin/guest）不变

---

## 11. 和现有模块的接口变化

| 模块 | 当前接口 | 改造后 |
|---|---|---|
| `MessageProcessor` | 通过 channelName 查 ChannelOptions | 不变。新增通过 channelName 查 AgentRegistry 获取 AgentContext |
| `CommandHandler` | 从 session.agentId 选择 runner | 不变。新增 `AgentContext.isOwned` 判断拦截锁定类命令 |
| `SessionManager` | `sessionModeResolver(channel, chatType)` | 不变接口。闭包实现改为：先查 AgentRegistry 的 chatmode，未填 fallback 到 config.chatmode |
| `index.ts` | 一次 `channelLoader.createAll(config)` | 多次调用：先 default config，再逐个 agent partial config |
| `ChannelLoader` | `createAll(config: Config)` | 不变。被多次调用，每次传不同 config 形状对象 |

---

## 12. 关键文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/core/evolagent.ts` | 新增 | EvolAgent 类 (~150 行) |
| `src/core/agent-registry.ts` | 新增 | AgentRegistry 类 (~200 行) |
| `src/types.ts` | 修改 | 新增 AgentContext, EvolAgentConfig 类型 |
| `src/index.ts` | 修改 | 多次调用 createAll()，AgentRegistry 路由绑定 |
| `src/core/message/message-processor.ts` | 修改 | 新增 AgentRegistry 依赖，通过 channelName 查 AgentContext |
| `src/core/command-handler.ts` | 修改 | 新增 isOwned 拦截 `/project /bind /plist` 和 `/agent <name>` 切换，其余命令不变 |
| `src/core/channel-loader.ts` | 不变 | 被多次调用 createAll()，零接口变更 |
| `src/cli.ts` | 修改 | 新增 `agent` 子命令（list/new/rm/fork/reload） |
| `src/ipc.ts` | 修改 | 新增 `evolagent` / `evolagent reload` ctl 命令 |

预估新增代码 ~400 行，重构 ~200 行。

---

## 13. 迁移策略

### 13.1 向后兼容

- evolclaw.json 中现有的 channel 配置继续作为 default 模式运行
- 不存在 `~/.evolclaw/agents/` 目录时，行为和当前完全一致
- `/agent` 命令保留不变（切换 baseagent），在 agent-owned channel 上禁用

### 13.2 迁移路径

用户将现有 channel 迁移到 agent：

1. `evolclaw agent new review-bot`（交互式创建，配置 channel）
2. 从 evolclaw.json 中删除对应 channel 配置
3. `evolclaw restart`

### 13.3 chatmode 过渡

- 全局 `config.chatmode: { private, group }` 已在 v2.7 实现（`getDefaultSessionMode`），本方案直接复用
- agent.json 的 `chatmode` 整对象未填时，继承 evolclaw.json 顶层 `chatmode`；填了则完全覆盖
- 现有 session 中已持久化的 `sessionMode` 值继续生效，不强制迁移
- `/chatmode` 在所有 channel 上行为不变（保持原样，仅作 session 级覆盖）
