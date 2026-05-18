# ~/.evolclaw 目录结构设计

本文档描述 evolclaw 的用户数据目录（`~/.evolclaw`，即 `EVOLCLAW_HOME`）的完整设计体系。

设计参考：`docs/identity-layer-design.md` §3.1

## 核心概念

系统由**主体**和**渠道**两个基本要素构成。

**主体（Principal）**：分为人和 agent。主体之间通过渠道收发消息，主体与主体之间存在关系（身份层定义的事情）。所有主体的身份在 AUN 网络中通过 AID 标识。人可以接入 AUN（有 AID），也可以不接入（只通过飞书等渠道）。agent 天然有 AID，天然接入 AUN。

**渠道（Channel）**：能收发消息的通信方式——AUN、飞书、微信、钉钉等。一个主体给另一个主体发消息时可以选择不同的渠道，选择权在主体自身。考虑到交互的延续性以及环境属性天然包含渠道信息，同一环境下通常延用同一渠道，但不强制。

**环境（Venue）**：渠道 + 场景（单聊/群聊/广播）构成环境。例如"通过飞书群聊"和"通过 AUN 私聊"是两个不同的环境。同一对主体可以同时在不同环境交互（微信群聊 + AID 私聊并行）。

**关系**：
- 主体之间的关系由身份层管理（identities/）
- 环境由环境层管理（venues/）
- 两者正交：同一个人在不同环境里是同一个 Principal

**agent 的三个面**：
- `agent.md`（位于 `~/.aun/AIDs/<aid>/agent.md`）→ 对外名片，AUN 网络上别人看到的身份信息。本地 `.aun/` 目录由 AUN SDK 管理，evolclaw 通过 AUN SDK 间接读写
- `config.json`（位于 `$EVOLCLAW_HOME/agents/<aid>/config.json`）→ 对内配置，evolclaw 运行时使用
- `personal/`（位于 `$EVOLCLAW_HOME/agents/<aid>/personal/`）→ agent 的内在状态（人格、记忆、风格、偏好、技能），按需载入上下文，agent 自己可改

修改 agent 的名字和对外展示信息 → 改 `~/.aun/AIDs/<aid>/agent.md`，再通过 AUN SDK 的 `uploadAgentMd()` 上传到 AUN 网络（HTTP POST 到 `https://<aid>/agent.md`）。

## 根目录解析

根目录按以下优先级确定（见 `src/paths.ts`）：

1. 环境变量 `EVOLCLAW_HOME`（如果设置）
2. 当前工作目录（如果 `./agents/defaults.json` 存在）
3. 默认：`~/.evolclaw`

## 完整目录树

数据按"作用域"分层：**部署级共享资源**（kits + 全局运行时）+ **per-agent 数据**（agents/\<aid\>/）。

```
$EVOLCLAW_HOME/
│
├── kits/                                    ← 部署级：共享上下文资源（提示词、模板、手册）
│   │                                          所有 self agent 共享，加载机制见身份层文档 §8
│   │
│   ├── aun/                                   AUN Context Kit — AUN 协议使用知识
│   │   ├── role.md                              不同对端身份/场景下的行为规则
│   │   ├── meta.md                              AUN 最小认知包
│   │   ├── path.md                              路径注册表
│   │   └── ...
│   │
│   ├── channels/                              各 channel 接入知识（按 channel 名分文件）
│   │   ├── aun.md                               AUN 通信约定（必加）
│   │   ├── feishu.md                            飞书的消息类型、文件协议、@ 语法
│   │   ├── wechat.md                            微信的消息类型与限制
│   │   └── ...
│   │
│   ├── evolclaw/                              EvolClaw 网关使用知识
│   │   ├── commands.md                          可用命令清单
│   │   ├── tools.md                             可用工具清单
│   │   ├── self-summary.md                      自我总结流程指南
│   │   └── identity-tools.md                    身份/环境层的工具用法
│   │
│   └── templates/                             prompt 模板（上下文组装的输入）
│       ├── private.md                           私聊场景模板
│       ├── group.md                             群场景模板
│       ├── broadcast.md                         广播场景模板
│       ├── self-summary.md                      自我总结任务模板
│       └── system-fragments/                    可复用片段（用 partial 引用）
│           ├── self-intro.md
│           ├── speaker-intro.md
│           ├── venue-intro.md
│           └── personal-context.md
│
├── agents/                                  ← per-agent 数据根目录
│   │                                          每个 self agent 一个子目录，目录名是 agent 自己的 AID
│   │
│   ├── defaults.json                          全局默认配置（per-agent config.json 缺失字段的 fallback）
│   ├── schema-1.json                          配置文件 schema（版本化）
│   │
│   └── <self-aid>/                          ← 例如 secretary.agentid.pub/
│       │
│       ├── config.json                        agent 基础配置
│       │                                        - aid: 自己的 AID
│       │                                        - owners / admins: 关系
│       │                                        - channels: 额外渠道列表（非 AUN）
│       │                                        - active_baseagent + baseagents: 基座
│       │                                        - models: 模型配置
│       │                                        - chatmode: 行为模式
│       │
│       ├── identities/                        ← 身份层：Principal 认知
│       │   │                                    顶层档案 = 已直接交互；_observed = 仅旁观
│       │   │
│       │   ├── _index/                          AID → 目录名 反查
│       │   │   ├── aid_<aid>.json                 { identity: <name>, type, added_at }
│       │   │   └── ...
│       │   │
│       │   ├── contacts/                        已直接交互过的身份（"通讯录"）
│       │   │   └── <name>/                        目录名是人类可读名（如 "王老板"、"王秘书"）
│       │   │       ├── profile.md                   frontmatter（aid/type/owner/agents/...）+ 关系正文
│       │   │       └── history.jsonl                身份演化事件流
│       │   │
│       │   ├── _observed/                       旁观档案（只在群里见过，未直接交互）
│       │   │   │                                 极简档案，不维护关系评注
│       │   │   ├── _index/
│       │   │   │   └── aid_<aid>.json
│       │   │   └── aid_<aid>/                     目录名直接用 AID
│       │   │       ├── profile.md                   极简 frontmatter，正文留空
│       │   │       └── history.jsonl
│       │   │
│       │   └── _trash/                          merged / split 后的重定向占位
│       │       └── <timestamp>_<original>/         保留 history，profile.md 仅 { merged_to: <aid> }
│       │
│       ├── venues/                            ← 环境层：Venue 认知
│       │   │                                    群、私聊、广播频道
│       │   │
│       │   ├── _index/
│       │   │   ├── feishu_chat_xyz.json           venue_id → 目录名 反查
│       │   │   ├── aun_group_abc.json
│       │   │   └── ...
│       │   │
│       │   ├── <venue-name>/                    已识别的 venue（如 "项目X讨论群"）
│       │   │   ├── profile.md                     venue 定位、文化、policy
│       │   │   └── history.jsonl                  venue 级事件
│       │   │
│       │   ├── private_<peer-name>/             私聊 venue（命名约定：private_ 前缀）
│       │   │   ├── profile.md
│       │   │   └── history.jsonl
│       │   │
│       │   └── _trash/
│       │
│       ├── personal/                          ← 个人数据层：agent 内在状态
│       │   │
│       │   ├── persona.md                       内部自述（行为规范、心理独白、身份认知）
│       │   │                                    给 LLM 看，不对外暴露
│       │   ├── self_summary.json                自我总结策略配置
│       │   ├── self_summary_failures.jsonl      自我总结失败记录
│       │   │
│       │   ├── memory/                          长期记忆
│       │   │   ├── episodic.jsonl                 事件性记忆（按时间序，"我经历了什么"）
│       │   │   ├── semantic.md                    语义性记忆（习得的事实/规律/结论）
│       │   │   └── working.md                     当前关注（短期，每次会话开始加载）
│       │   │
│       │   ├── style.md                         表达风格（用词偏好、句式偏好）
│       │   ├── preferences.json                 工具/模型/操作偏好（结构化配置）
│       │   │
│       │   ├── skills/                          技能清单
│       │   │   ├── _index.json                    技能清单总览
│       │   │   └── *.md                           每技能一文件
│       │   │
│       │   ├── journal.jsonl                    反思日志（关键决策、自我修订）
│       │   └── goals.md                         长期目标
│       │
│       ├── sessions/                          ← 会话存储（per-agent）
│       │   └── <session-key>/
│       │       ├── messages.jsonl                 完整消息历史
│       │       └── meta.json
│       │
│       └── data/                              ← 其它运行时数据
│           ├── cache/                           临时缓存（agent.md 拉取缓存等）
│           └── ...
│
├── data/                                    ← 部署级：evolclaw 运行时数据（仅运行时，无业务配置）
│   │
│   ├── instance/                              进程实例注册 + 进程级运行时句柄
│   │   ├── main-{pid}.json                      主进程记录
│   │   ├── restart-monitor-{pid}.json           重启监控进程记录
│   │   ├── aid-{pid}.jsonl                      AID 事件日志（连接/断开/收发）
│   │   ├── ready.signal                         就绪信号文件
│   │   └── evolclaw.sock                        IPC 套接字（Linux/macOS）
│   │       或 \\.\pipe\evolclaw-{hash}            IPC 命名管道（Windows，hash 长度以代码为准）
│   │
│   ├── outbox/                                离线消息发件箱
│   │   └── {aid}.jsonl                          每个 AID 一个文件（上限 20 条，TTL 5min）
│   │
│   ├── restart-pending.json                   重启挂起状态
│   └── restart-confirm-*.json                 重启确认文件
│
└── logs/                                    ← 日志目录
    ├── evolclaw-{YYYYMMDD}-{HH}.log            主日志（按小时轮转，保留 12 小时）
    ├── aun-{YYYYMMDD}-{HH}.log                 AUN 通道日志
    ├── evolclaw.log                             → 当前主日志的 symlink
    ├── messages.log                             消息日志（MESSAGE_LOG=true 时启用）
    ├─ events.log                               事件日志（EVENT_LOG=true 时启用）
    ├── line-stats.log                           行统计
    └── self-heal.md                             自愈报告
```

### 关联目录：~/.aun/（AUN SDK 维护，非 evolclaw 拥有）

`~/.aun/` 由 AUN SDK 管理，evolclaw 不直接读写底层文件，但需要知道布局以便引用：

```
~/.aun/
└── AIDs/
    └── <aid>/
        ├── agent.md                            agent 对外名片（AUN 协议规定 https://<aid>/agent.md serve 此文件）
        ├── cert.pem                            证书
        └── ...                                 其它 SDK 内部文件（密钥、状态等）
```

evolclaw 通过 AUN SDK 提供的 API 读写（如 `uploadAgentMd()`），不直接操作磁盘文件。

## 各组件详解

### kits/ — 共享上下文资源

部署级共享资源，所有 self agent 共享。按用途分子目录：

| 子目录 | 用途 | 加载时机 |
|--------|------|----------|
| `aun/` | AUN 协议使用知识 | 每次会话必加 |
| `channels/` | 各 channel 接入知识 | 按入站消息的 channel 决定加载哪份 |
| `evolclaw/` | 网关命令、工具、行为约定 | 每次会话必加 |
| `templates/` | prompt 模板 + 可复用片段 | 上下文组装时按 venue.kind 选模板 |

**升级策略**：`kits/` 是 evolclaw 包安装/升级时复制到 `EVOLCLAW_HOME` 的副本，跟随 evolclaw 版本。其中 `aun/` 是 AUN Context Kit 的副本，安装时一起带进来。

### agents/defaults.json — 全局默认配置

agent 根目录下的默认配置文件，为所有 agent 提供字段级 fallback。

**配置加载优先级**：per-agent `config.json` → `defaults.json` → 代码默认值。

**合并规则**：
- **深合并字段**：`models`、`chatmode`、`aun`、`baseagents` — 递归 merge，per-agent 只需写要覆盖的子字段
- **浅覆盖字段**：`projects` — per-agent 写了则整体替换，不与 defaults 混合
- **数组合并去重**：`admins` — defaults 提供全局基础，per-agent 补充
- **标量字段**：`active_baseagent`、`show_activities`、`flush_delay`、`debounce` — 直接覆盖
- **不进 defaults 的 per-agent only 字段**：`aid`、`enabled`、`owners`、`channels`

**敏感字段**：支持环境变量引用语法 `"$ENV:VAR_NAME"`，配置加载时展开。标记为 🔑 的字段建议使用环境变量而非明文。环境变量未设置时打印 warning 提示，字段值视为空，运行时真正用到该字段时才报错——这样能尽早暴露漏配，但不会因为某个无关字段缺凭证而阻止启动。

**Schema 版本**：`$EVOLCLAW_HOME/agents/schema-<version>.json` 定义各版本的配置 schema，配置文件通过 `$schema_version` 字段声明所用版本。

```jsonc
// $EVOLCLAW_HOME/agents/defaults.json
{
  "$schema_version": 1,

  // === AUN 网络运行参数（深合并）===
  "aun": {
    "keystorePath": "~/.aun",
    "encryptionSeed": "$ENV:AUN_ENCRYPTION_SEED"  // 🔑
  },

  // === 基座 agent ===
  "active_baseagent": "claude",                   // 默认活跃基座
  "baseagents": {                                 // 所有已配置的基座（深合并）
    "claude": {                                   // 切换时目标必须预先存在
      "apiKey": "$ENV:ANTHROPIC_API_KEY",         // 🔑
      "baseUrl": null,
      "pathToClaudeCodeExecutable": null,
      "effort": "high"
    },
    "codex": {
      "apiKey": "$ENV:OPENAI_API_KEY",            // 🔑
      "baseUrl": null,
      "model": "gpt-5.2-codex",
      "effort": "high"
    },
    "gemini": {
      "apiKey": "$ENV:GEMINI_API_KEY",            // 🔑
      "model": "gemini-2.5-flash",
      "cliPath": null,
      "mode": "cli"
    }
  },

  // === 模型（深合并）===
  "models": {
    "default": "claude-sonnet-4-6",
    "allowed": [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-7"
    ],
    "by_role": {
      "owner": "claude-opus-4-7",
      "admin": "claude-sonnet-4-6",
      "guest": "claude-sonnet-4-6"
    }
  },

  // === 项目（浅覆盖）===
  "projects": {
    "defaultPath": "C:/Users/agentcp/projects/default",
    "list": {},
    "autoCreate": false
  },

  // === 行为 ===
  "chatmode": {                                   // 深合并
    "private": "interactive",
    "group": "interactive"
  },
  "show_activities": "dm-only",                   // 标量
  "flush_delay": 4,                               // 标量（秒）
  "debounce": 2                                   // 标量（秒）
}
```

### agents/\<aid\>/ — per-agent 数据

每个 self agent 一个子目录，**目录名是 agent 自己的 AID**。所有 per-agent 数据（个人数据层、身份层、环境层、会话）都收纳到该目录下。

#### config.json — agent 基础配置

```jsonc
{
  "$schema_version": 1,

  // === 身份（必须 per-agent）===
  "aid": "secretary.agentid.pub",             // agent 的 AID（唯一标识）
  "enabled": true,                            // agent 开关（false 时启动期不加载该 agent，但保留所有数据）

  // === 关系（必须 per-agent）===
  "owners": ["zhang.agentid.pub"],            // owner AID 列表（必须是对端自己持有的 AID）
  "admins": ["li.agentid.pub"],               // admin AID 列表（必须是对端自己持有的 AID）

  // === AUN 网络参数（深合并，覆盖 defaults.aun）===
  "aun": {
    "encryptionSeed": "$ENV:MY_AUN_SEED"          // 仅覆盖需要改的字段
  },

  // === 渠道接入（浅覆盖，per-agent）===
  // AUN 是 agent 的存在基础：aid = agent 身份 = AUN channel ID，必须有且只有一个
  // 其他 channel 是额外接入的渠道（0 到多个），以列表形式配置
  // 每个 channel 是 agent 在该渠道上的一个 ID，能接收该渠道发给它的消息
  "channels": [
    {
      "type": "feishu",
      "name": "secretary-bot",
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "$ENV:FEISHU_SECRET_SECRETARY",  // 🔑
      "owners": ["ou_zhang"],                   // 飞书原生 user_id（不是 AID）
      "admins": ["ou_li"],
      "flushDelay": 4,
      "debounce": 2,
      "showActivities": "all"
    },
    {
      "type": "dingtalk",
      "name": "main",
      "enabled": true,
      "clientId": "xxx",
      "clientSecret": "$ENV:DINGTALK_SECRET",       // 🔑
      "owners": ["unionId_xxx"],                    // 钉钉原生 unionId
      "requireMention": true
    }
  ],

  // === 基座 agent（深合并）===
  "active_baseagent": "claude",               // 当前活跃基座（运行时可命令切换）
  "baseagents": {                             // 覆盖 defaults 中对应基座的字段
    "claude": {
      "apiKey": "$ENV:MY_ANTHROPIC_KEY",      // 🔑 此 agent 用独立 key
      "effort": "max"
    }
    // codex、gemini 未写 → 从 defaults.baseagents 继承
  },

  // === 模型（深合并）===
  "models": {
    "default": "claude-opus-4-7"              // 仅覆盖 default，其余从 defaults 继承
  },

  // === 项目（浅覆盖）===
  "projects": {
    "defaultPath": "C:/Users/agentcp/projects/secretary",
    "list": {
      "evolclaw": "C:/Users/agentcp/AppData/Roaming/Evol/default/workspace/evolclaw"
    }
  },

  // === 行为（深合并 chatmode，标量直接覆盖）===
  "chatmode": {
    "group": "proactive"                      // 仅覆盖 group，private 从 defaults 继承
  },
  "show_activities": "all"
}
```

**字段归属总结**：

| 字段 | 必须 per-agent | 可继承 defaults | 合并方式 | 说明 |
|------|:-:|:-:|:---:|------|
| `$schema_version` | ✅ | ✅ | — | 配置 schema 版本 |
| `aid` | ✅ | — | — | 身份唯一标识，即目录名 |
| `enabled` | ✅ | — | 标量 | agent 开关：false 时启动期不加载该 agent，**不清理任何数据** |
| `owners` | ✅ | — | — | owner 关系（AUN 顶层 owners 是 AID 列表）。**允许为空**——空表示尚未指定主人，第一个跟该 agent 通信的对端自动成为 owner |
| `admins` | 可覆盖 | ✅ | 数组合并去重 | admin 关系。defaults.admins 提供全局基础（如运维 AID），per-agent 补充 |
| `aun` | 可覆盖 | ✅ | 深合并 | AUN 网络运行参数 |
| `channels` | ✅ | — | — | 额外渠道列表（每项含 type、凭证、owners、admins）。**不进 defaults**——各 self-agent 的接入凭证差异大，无共享意义。channel 实例的 `owners`/`admins` 用该 channel 的原生 ID（飞书 user_id、钉钉 unionId 等），**不强制 AID** |
| `active_baseagent` | 可覆盖 | ✅ | 标量 | 当前活跃基座，运行时可命令切换 |
| `baseagents` | 可覆盖 | ✅ | 深合并 | 各基座配置字典 |
| `models` | 可覆盖 | ✅ | 深合并 | 默认模型 + 允许范围 + 按角色分配 |
| `projects` | 可覆盖 | ✅ | 浅覆盖 | 工作目录（defaultPath + list） |
| `chatmode` | 可覆盖 | ✅ | 深合并 | 交互模式 |
| `show_activities` | 可覆盖 | ✅ | 标量 | 中间输出可见性 |
| `flush_delay` | 可覆盖 | ✅ | 标量 | 出站消息批次间隔 |
| `debounce` | 可覆盖 | ✅ | 标量 | 入站消息去抖 |

**关于 AUN 渠道**：AUN 是 agent 的存在基础——`aid` = agent 身份 = AUN channel ID，三者是同一个东西，必须有且只有一个。AUN 的运行参数（keystorePath、encryptionSeed）通过顶层 `aun` 字段配置。其他 channel 是 agent 选择接入的额外渠道（0 到多个），以列表形式配置在 `channels` 中，每项带 `type` 标识渠道类型。

**关于 owner**：顶层 `owners` 是 AUN 渠道（即 agent 本身）的 owner 列表，元素为 AID。每个 channel 实例可以有自己的 `owners` / `admins` 列表，元素为**该 channel 的原生标识**（飞书 user_id、钉钉 unionId 等），由该 channel 的身份系统决定，不要求有对应 AID。顶层 `owners` 允许为空——空表示"待指定"，第一个通信者自动成为 owner。

**关于基座切换**：`active_baseagent` 标记当前使用的基座。运行时可通过命令切换到 `baseagents` 字典中任何已配置的基座。切换即时生效，不需要重启。

**关于模型切换**：`models.default` 和 `models.by_role` 是启动时的默认值。运行时 agent 可通过命令行工具在 `models.allowed` 范围内自主切换，切换即时生效。

#### personal/ — 个人数据层

agent 的内在状态——人格、记忆、风格、偏好、技能。绝对私有，不出当前 agent 工作区。

| 子层 | 用途 | 写入权限 |
|------|------|----------|
| `persona.md` | 内部自述（行为规范、心理独白、身份认知） | owner / LLM 自主 |
| `self_summary.json` | 自我总结策略配置 | owner / agent 自调 |
| `self_summary_failures.jsonl` | 自我总结失败记录 | 系统写入 |
| `memory/episodic.jsonl` | 事件性记忆（"我经历了什么"） | LLM 自主 |
| `memory/semantic.md` | 语义性记忆（习得的事实/规律） | LLM 自主 |
| `memory/working.md` | 当前关注（短期，每会话加载） | LLM 自主 |
| `style.md` | 表达风格 | LLM + owner 指示 |
| `preferences.json` | 工具/模型/操作偏好 | owner / admin |
| `skills/` | 技能清单 | owner / admin |
| `journal.jsonl` | 反思日志（决策复盘） | LLM 自主 |
| `goals.md` | 长期目标 | owner |

agent 的对外展示信息（名称、能力声明等）统一由 AUN 的 `agent.md`（在 `.aun` 目录下）管理，evolclaw 不维护副本。需要展示名的地方（CLI、nameservice）直接从 `.aun` 读取。

**self_summary.json**：自我总结是 agent 的自省行为，更新频率高、字段多，与产出（memory、journal 等）放在一起。

```jsonc
// agents/<aid>/personal/self_summary.json
{
  "enabled": true,
  "on_session_end": true,
  "on_idle_minutes": 30,
  "daily_at": "03:00",
  "weekly_on": "Sunday",
  "max_tokens_per_day": 50000,
  "skip_targets": []
}
```

#### identities/ — 身份层（Principal 认知）

**分级建档**：
- **contacts/**（`identities/contacts/<name>/`）：已直接交互过的身份，目录名是人类可读名
- **\_observed/**（`identities/_observed/aid_<aid>/`）：只在群里旁观过，未直接交互，极简档案

**直接交互的判定**（决定进 contacts/ 还是 \_observed/）：
- 私聊（venue.kind=private）
- 群里被 @ 自己
- 群里 self 之前 @ 过该 speaker
- 群里 owner/admin 发命令

**profile.md 格式**（顶层身份示例）：

```markdown
---
name: 王老板
type: person                    # person | agent
aid: wang.agentid.pub           # 对端有 AUN 身份时填入；非 AUN 渠道独有的对端可省略
primary_channel: aun
status: identified              # unidentified | identified | merged
channels:
  aun: "wang.agentid.pub"
  feishu: "ou_wang"
agents:                         # type=person 时：他拥有的 agent
  - "wang-secretary.agentid.pub"
roles_for_self: [owner]
verified_channels: [aun, feishu]
agent_view:
  preferred_address: "王老板"
  tone: "正式但不拘谨"
  last_topic: "Q4 项目排期"
---

王老板就是研发部那位王经理，平时说话挺直接。
上次聊 Q4 项目时对延期比较介意，后续沟通要先报进度再讲问题。
```

**关于 AID**：channel 不要求必须有 AID。来自 AUN 的对端自带 AID；只在飞书/微信/邮件等非 AUN 渠道出现的对端可省略 `aid` 字段，用 `channels` 中的渠道 ID 作 canonical。owner / admin 等特权角色仍要求绑定一个 AID（详见 identity-layer-design.md §4.4）。

**history.jsonl 事件类型**：`created` / `promoted_from_observed` / `identified` / `channel_added` / `channel_removed` / `merged` / `split` / `profile_updated` / `interaction`

#### venues/ — 环境层（Venue 认知）

三种 venue kind：

| kind | 含义 | venue_id |
|------|------|----------|
| `private` | 一对一私聊 | 对端的 AID |
| `group` | 群聊 | 群的渠道 ID（如 `feishu_chat_xyz`） |
| `broadcast` | 广播频道 | 频道 ID |

**venue profile.md 格式**（群）：

```markdown
---
kind: group
status: identified
venue_uid: "v_a1b2c3d4e5f6"       # 稳定 UID（首次创建分配，不随重命名变化）
venue_ids:
  feishu: "chat_xyz"
primary_channel: feishu
policy:
  forward_all_messages: true
  require_mention: true
  batch_window_seconds: 30
  batch_max_messages: 20
metadata:
  purpose: "Q4 项目讨论"
agent_view:
  tone: "正式"
  active_topics: ["Q4 项目排期", "技术选型"]
---

项目 X 讨论群是研发部为新项目搭建的协作群。
群里讨论需求决策时通常需要 @ 我才介入。
```

**session_key 用 venue_uid**：`{self_aid}:venue:{venue_uid}:{project_path}`，避免重命名/合并破坏会话。

#### personal/ — 个人数据层

见上文 [personal/ — 个人数据层](#personal-个人数据层) 章节。

#### sessions/ — 会话存储

per-agent 的会话数据，按 session_key 分目录：

```
sessions/
└── <session-key>/
    ├── messages.jsonl              完整消息历史
    └── meta.json                   session 元数据
```

#### data/ — 运行时数据

| 文件 | 用途 |
|------|------|
| `cache/` | 缓存（对端 agent.md、自己 agent.md 本地副本等）。权威位置在 `~/.aun/AIDs/<aid>/`，cache 仅供 agent 快速查阅，可随时清理 |

### data/ — 部署级全局运行时

新设计中，agent / channel / 模型 / 项目等业务配置全部迁移到 `agents/defaults.json` + `agents/<aid>/config.json`。`data/` 目录只保留**部署级运行时数据**——进程管理、消息队列、重启状态等。

| 子目录/文件 | 用途 |
|------|------|
| `instance/` | 进程实例注册（见下） |
| `outbox/` | 离线消息发件箱（见下） |
| `restart-pending.json` | 重启挂起状态 |
| `restart-confirm-*.json` | 重启确认文件 |

#### data/instance/ — 进程实例注册

用于单进程实例保护，替代传统的 PID 文件方案。该目录还托管运行时进程级句柄（就绪信号、IPC 端点）——它们都跟"当前主进程"绑定，跟 instance 一起出生一起消亡，所以放在一起。

| 文件 | 内容 |
|------|------|
| `main-{pid}.json` | `{ pid, startedAt, startedAtIso, launchedBy }` |
| `restart-monitor-{pid}.json` | `{ pid, startedAt, startedAtIso, launchedBy: "restart-monitor" }` |
| `aid-{pid}.jsonl` | 每行一个事件：`{ ts, iso, event, aid, ... }` |
| `ready.signal` | 主进程就绪信号（CLI 启动检测用） |
| `evolclaw.sock` / `\\.\pipe\evolclaw-{hash}` | IPC 端点（具体长度/格式以代码为准） |

**竞争仲裁**：多实例同时启动时，按 `(startedAt, pid)` 选赢家。损坏的 JSON 文件在扫描时自动删除。

**launchedBy 枚举**：`start` | `restart-cli` | `restart-network` | `self-heal` | `restart-monitor`

#### data/outbox/ — 离线消息发件箱

断网期间消息写前持久化，重连后自动 drain。

| 约束 | 值 |
|------|---|
| 每 AID 上限 | 20 条（FIFO 淘汰） |
| TTL | 5 分钟（过期自动清理） |
| 消息 ID 格式 | `out-{timestamp}-{random}` |

### logs/ — 日志系统

**轮转策略**：按小时轮转（`YYYYMMDD-HH` 后缀），保留最近 12 小时。

**IPC 通信**：通过 Unix socket（macOS/Linux）或 Windows 命名管道进行进程间通信，端点文件位于 `data/instance/`（见上）。协议为换行分隔的 JSON。

IPC 命令：
- `status` → 进程状态（pid、uptime、channels、queue、stats）
- `ping` → `{ pong: true, pid }`
- `aun-aids` → AID 连接状态列表
- `ctl` → 执行斜杠命令
- `evolagent.list` / `evolagent.show` / `evolagent.reload` → Agent 管理

## 补充：项目级 .evolclaw 目录

除了用户级 `EVOLCLAW_HOME`，每个项目目录下也可能有 `.evolclaw/` 子目录：

```
{projectPath}/.evolclaw/
└── uploads/                              媒体缓存目录
    └── {sanitized_filename}                下载的文件（去重 by MD5）
```

**uploads 约束**：
- 图片上限：10MB
- 文件上限：100MB
- 允许 MIME：PNG, JPEG, GIF, WebP
- 去重：MD5 哈希
- 安全：SSRF 防护（私有 IP 拦截 + CDN 白名单）
- 文件名冲突：追加 `_{timestamp}` 后缀

## 迁移路径

新结构与目前磁盘实情的差异较大，需要一次性迁移 + 部分项延后处理。

### 现状速览

```
当前 ~/.evolclaw/                       目标
├── agents/
│   ├── evolclaw.json               →  agents/defaults.json
│   ├── <name>.json                 →  agents/<aid>/config.json
│   └── <旧式名字目录>/              →  清理或迁入 agents/<aid>/
├── aids/
│   ├── self/<aid>.md               →  agents/<aid>/personal/persona.md
│   └── peers/<aid>.md              →  agents/<aid>/identities/contacts/<name>/profile.md
│                                       或 identities/_observed/aid_<aid>/profile.md
├── data/
│   ├── evolclaw.json               →  废弃；按字段重构 agents/defaults.json（不直接搬迁）
│   ├── sessions/                   →  暂不迁移（保留原位置，后续设计）
│   ├── instance/                   →  data/instance/（保持，新增 ready.signal + socket）
│   ├── outbox/                     →  data/outbox/（保持）
│   └── SKILLS.md                   →  保持不动
└── logs/
    ├── ready.signal                →  data/instance/ready.signal
    └── evolclaw.sock / pipe        →  data/instance/evolclaw.sock / pipe
```

### 必须迁移的项

**1. `data/evolclaw.json` 废弃 → 重新构造 `agents/defaults.json`**

旧 `data/evolclaw.json` 已废弃，`agents/defaults.json` 是重新定义的结构，**不是字段级搬迁**。迁移做法：

- 按 `defaults.json` 的字段定义重新构造（`baseagents`、`models`、`chatmode`、`aun`、`projects`、`admins` 等顶层段）
- 旧 `evolclaw.json.agents`（基座配置）→ `defaults.json.baseagents`
- 旧 `evolclaw.json.channels` 字典中的具体 channel 配置要**拆分到对应 self-agent 的 `config.json.channels[]`**（见步骤 2），defaults.json 不持有 channels 字段
- 完成后删除旧 `data/evolclaw.json`

**2. `agents/<name>.json` → `agents/<aid>/config.json`**

每个旧的 `<name>.json` 对应一个 self agent。迁移步骤：
- 从 `<name>.json` 中读 `channels.aun.aid` 作为 self agent 的 AID
- 创建目录 `agents/<aid>/`
- 把原文件内容作为 `config.json` 写入，同时把 `channels` 块整理成新的 `channels[]` 列表形态（每个渠道实例带 `type` + `name`）
- 删除原 `<name>.json`

**3. `aids/{self,peers}/` → `agents/<aid>/identities/{contacts,_observed}/`**

旧 `aids/` 目录之前主要停留在纸面 + 少量代码，没有大规模数据沉淀，可按新结构重建：
- `aids/self/<aid>.md` 中的内容并入对应 self agent 的 `agents/<aid>/personal/persona.md`
- `aids/peers/<aid>.md` 视交互情况落到 `identities/contacts/<name>/`（已直接交互）或 `identities/_observed/aid_<aid>/`（旁观）
- 旧 `aids/` 目录删除

**4. 代码侧同步**

文档结构变更必须配套代码改动，主要涉及：

- `src/paths.ts`：
  - `readySignal`：`logs/ready.signal` → `data/instance/ready.signal`
  - `socket`（Unix）：`logs/evolclaw.sock` → `data/instance/evolclaw.sock`
  - 新增 `defaultsConfig` / `agentDir(aid)` / `agentConfig(aid)` / `agentPersonal(aid)` / `agentIdentities(aid)` / `agentVenues(aid)` 等辅助路径
  - 移除已废弃的 `db`（sessions.db）、`config`（data/evolclaw.json）等条目
- `src/config.ts`：从单文件 `data/evolclaw.json` 加载切换为 `agents/defaults.json` + per-agent `config.json` 两层合并；timestamped backup 与新的双 rename 原子写并存
- `src/agents/`：扫描 `agents/<aid>/` 目录加载 self-agent 列表，按 AID 而非友好名定位
- `src/aid/`：废弃旧 `aids/` 读写逻辑，相关接口骨架等身份层实现时填充

### 暂不迁移（保留原位置）

- **`data/sessions/`**：sessions 暂时留在 `data/sessions/<channelType>/...`，后续随 venue_uid 设计落地一起重映射。新结构图中的 `agents/<aid>/sessions/` 是目标态，当前先留空或软链。

### 一次性迁移工具（待实现）

设想引入 `evolclaw migrate` CLI 命令完成上述迁移，迁移过程：
- pre-check：要求 evolclaw 进程未运行
- 备份：把 `~/.evolclaw/` 整体打包到 `~/.evolclaw.bak-{ts}.tar`
- 迁移：按上述步骤改名/搬运
- post-check：跑 `evolclaw status` 验证新结构能加载
- 失败回滚：恢复备份

迁移过程中遇到不在已知模式内的脏数据（无关文件、半残目录等）一律忽略，不阻断流程，也不主动清理——靠备份兜底。


写入易损坏的 JSON 配置文件（`agents/defaults.json`、`agents/<aid>/config.json` 等）时遵循统一的"双 rename 原子写"流程：

```
写入流程（写 foo.json）：
  1. 把当前 foo.json 改名为 foo.json_         （保留旧版作为热备）
  2. 把新内容写到 foo.json__                  （写入完成才有完整内容）
  3. 把 foo.json__ rename 为 foo.json         （原子切换）
  （步骤 1 中的 foo.json_ 保留到下次写入时被覆盖）
```

任意时刻磁盘上至多存在三种状态：

| 文件存在情况 | 说明 | 恢复策略 |
|---|---|---|
| 只有 `foo.json` | 上次写入完整完成 | 直接读 |
| `foo.json` + `foo.json_` | 正常情况（最近一次写已完成，旧版作为热备） | 直接读 `foo.json` |
| `foo.json__` 存在 | 上次写入中途崩溃 | 丢弃 `foo.json__`，回退读 `foo.json_` 或 `foo.json` |
| 只有 `foo.json_` | rename 步骤崩溃 | 把 `foo.json_` rename 回 `foo.json` |

**适用范围**：所有"业务关键 JSON"——`agents/defaults.json`、`agents/<aid>/config.json`、identities/venues 的 `profile.md` 与 `_index/*.json`。JSONL 类追加写文件不走此流程（追加本身就有较好的崩溃语义）。

**与现有 `evolclaw.json` 自动备份的衔接**：当前 `config.ts` 已实现的 timestamped backup（`evolclaw-YYYYMMDD-HHMMSS.json`）作为更长期的回退池保留——双 rename 是热备（最近一次），timestamped 是冷备（人工恢复用）。


1. **两层作用域**：部署级（kits/ + data/）→ per-agent（agents/\<aid\>/），职责清晰
2. **AID 为目录名**：agent 目录用 AID 而非友好名，避免重命名导致路径断裂
3. **三维正交**：Self / Principal / Venue 独立存储，互不干扰
4. **分级建档**：直接交互 → 顶层完整档案；旁观 → \_observed/ 极简档案，避免目录爆炸
5. **文件系统即数据库**：目录层级 + JSONL 替代 SQLite，便于调试和备份
6. **原子写入**：JSON 文件先写 `.tmp` 再 rename，防止断电损坏
7. **追加日志**：JSONL 格式天然支持并发追加和增量读取
8. **PID 自描述**：实例文件名含 PID，无需额外锁机制
9. **TTL 自清理**：outbox 和日志都有自动过期清理，无需外部 cron
10. **per-agent 隔离**：每个 agent 独立维护认知，不引入跨 agent 共享事实层

## 附录：关键决策与澄清

本附录记录文档演进过程中已确认的决策，避免后续评审反复讨论已经拍板的事。条目按主题分组，新决策只追加不删除。

### 与 `identity-layer-design.md` 的关系

`identity-layer-design.md` 是更早的祖文档，本文档是基于它演化后的最新方案。**两份文档不一致时一律以本文档为准**——差异是演进，不是冲突。下面这些点是相对祖文档的明确演进：

- **proxied-aids 注册表已删除**：channel 不要求必须有 AID，AUN 渠道的对端自带 AID，非 AUN 渠道的对端可省略 `aid` 字段。祖文档 §5.5 的 `~/.evolclaw/proxied-aids/` 整个目录及其密钥托管设计不再适用。
- **`self/` 子层不存在**：`personal/` 已涵盖人格、记忆等内在状态。对外名片由 AUN 维护的 `~/.aun/AIDs/<aid>/agent.md` 唯一持有，evolclaw 不维护 `card.md` 副本。祖文档中 `agents/<aid>/self/persona.md` + `self/card.md` 的两文件结构作废。
- **`personal/self_summary.json` 与祖文档 §9.8 的 `config.json.self_summary` 含义不同**：前者是**策略配置**（频率、预算、skip_targets），后者是别的概念，**不是冲突**。
- **群是 venue 不是 identity**：祖文档已表达，本文档延续。
- **不引入跨 agent 共享认知层**：祖文档已表达，本文档延续。

### `agent.md` 的对外服务由 AUN 提供

`https://<aid>/agent.md` 的 HTTP serve 是 **AUN 网络的服务**，不是 evolclaw 实现。evolclaw 不实现 nameservice 端点，也不维护本地副本——它只通过 AUN SDK 读写 `~/.aun/AIDs/<aid>/agent.md`，其它由 AUN 网络保障。

### `personal/` 边界

人格、记忆、风格、偏好、技能、self_summary 配置都属于个人数据层：

- 都是需要按需载入上下文的内容
- 都是 agent 自己可改的内容
- 因此不再讨论"是否应该按数据性质拆分到不同目录"——保留单层 `personal/` 设计

### `enabled: false` 语义

启动时**不加载该 agent**，**不清理任何数据**。data/outbox 中的离线消息按既有 TTL 规则自然过期，不做特殊处理；该 agent 的 AID 不上 AUN 网络，所以也不存在 AID 占用问题。

### `kits/` 升级策略

`kits/` 是 evolclaw 包安装/升级时复制到 `EVOLCLAW_HOME` 的副本。升级时跟随包重新复制，**不做用户改动 vs 新版本的 merge**。需要定制的内容应放在 per-agent 目录或独立配置，不要直接改 `kits/` 内文件——改了也会被下次升级覆盖。

`kits/aun/` = AUN Context Kit 的副本，安装 evolclaw 时一起带进来。

### 多进程并发

- `data/instance/` 已通过 `(startedAt, pid)` 仲裁选赢家
- `data/outbox/`、`data/sessions/` 由赢家独占写，不存在并发写入风险
- 因此不需要额外的"多进程共享语义"设计

### 文档范围

**本文档只描述目录结构和文件用途**。详细列表见下文 [不在本文档范围](#不在本文档范围) 节。

### 迁移工具对脏数据

`evolclaw migrate` 遇到不在已知模式内的脏数据（`新建 文本文档.txt`、半残目录等）一律**忽略**，不阻断流程也不主动清理。备份是 `~/.evolclaw.bak-{ts}.tar` 整体打包，靠备份兜底回滚。

### 环境变量解析

`"$ENV:VAR_NAME"` 在配置加载时展开。未设置环境变量时：

- 打印 warning 提示
- 字段值视为空
- 运行时真正用到该字段时才报错

这样既能尽早暴露漏配，又不会因为某个无关字段缺凭证而阻止启动。

### 暂不处理的项

下列问题已知存在，但当前不处理：

- **`schema-1.json` 的生成与校验流程**：等设计稳定后再说
- **顶级 `data/` 命名退化**：sessions 暂留 `data/sessions/<channelType>/...`，后续随 venue_uid 设计落地一起重映射
- **session_key 的 venue_uid 编码**：先用 `{self_aid}:venue:{venue_uid}:{project_path}` 占位，实际编码以后再定义
- **跨平台 socket / pipe hash 长度**：以代码为准，文档不追求精确
- **`config.json` 字段表的进一步扩展**：当前字段集冻结，新增需走单独提案

### 配置字段归属（再澄清）

- **`channels` 不进 `defaults.json`**：各 self-agent 的接入凭证差异大，无共享意义。`defaults.json` 不持有 `channels` 字段；旧 `data/evolclaw.json.channels` 字典中的具体 channel 配置在迁移时拆分到对应 self-agent 的 `config.json.channels[]`。
- **`admins` 可以进 `defaults.json`**：合并方式为"数组合并去重"，defaults 提供全局基础（如运维 AID），per-agent 补充。
- **`owners` 不进 `defaults.json`**：必须 per-agent。**允许为空**——空列表表示尚未指定主人，第一个跟该 agent 通信的对端自动成为 owner。
- **channel 实例的 `owners` / `admins` 用该 channel 的原生 ID**：飞书 user_id、钉钉 unionId 等，**不强制 AID**。channel 内的权限语义由该 channel 的身份系统决定。
- **顶层 `owners` 元素仍是 AID**：AUN 渠道的 owner 必须是 AID 对端。

### 缓存语义

`agents/<aid>/data/cache/` 用于本地副本：

- **对端 agent.md** 的拉取缓存（identities/contacts 里展示对方时不用每次走网络）
- **自己 agent.md** 的本地副本（agent 自己查看时用，权威值在 `~/.aun/AIDs/<aid>/agent.md`）

权威位置永远在 `~/.aun/AIDs/<aid>/`——修改和提交只通过 AUN SDK 走该路径，cache 是只读副本，可随时清理重建。

### 身份层目录形态本轮只定布局

`identities/_index/` vs `_observed/_index/` 的边界、`private_<peer-name>` 与 peer 重命名/合并的关系、`_trash/` 的恢复语义等——这些都是**身份层实现时**才需要敲定的运行时规则。本文档只确定**目录结构存在**，运行时语义不在本轮范围。

### 不在本文档范围

- 系统详细设计（IPC 协议细节、消息格式、状态机）
- 运行时清理时机（restart-pending 谁删、log 怎么轮转的实现细节）
- 跨平台启动竞争行为
- log 拆分策略（per-agent vs 全局）、`logs/` 下各日志文件的启用开关与写入方
- 身份层的运行时规则（promote / merge / split / \_trash 的具体行为）

这些细节以代码为准，或在专门的设计文档中描述。

