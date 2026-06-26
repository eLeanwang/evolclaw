# EvolClaw 目录结构与 ECK 分发设计

本文档是 evolclaw 所有目录结构（包代码 + 用户数据）和 ECK 分发机制的**唯一事实源**。

## 架构定位

### 系统全景

```
┌──────────────────────────────────────────────────────────────────┐
│                         AUN 网络                                  │
│              AUN Gateway（协议基础设施，路由/认证/投递）            │
└───────────┬──────────────────────────────────────────┬───────────┘
            │                                      │
       AUN SDK                                AUN SDK
            │                                      │
┌───────────┴───────────┐          ┌───────────────┴───────────────┐
│     Evol 前端          │          │          EvolClaw              │
│  (App / Web / Desktop) │          │                               │
│  或其它 AUN 客户端     │          │  ┌─────────────────────────┐  │
└────────────────────────┘          │  │     Channel 适配层       │  │
                                    │  │  AUN / 飞书 / 微信 / ... │  │
                                    │  └────────────┬────────────┘  │
                                    │               │               │
                                    │  ┌────────────┴────────────┐  │
                                    │  │  关系层 / 环境层 / 个人层 │  │
                                    │  │  会话管理 / 上下文组装    │  │
                                    │  └────────────┬────────────┘  │
                                    │               │               │
                                    │  ┌────────────┴────────────┐  │
                                    │  │      Base Agent          │  │
                                    │  │  (Claude Code / Codex)   │  │
                                    │  └─────────────────────────┘  │
                                    └───────────────────────────────┘
```

### EvolClaw 是什么

EvolClaw 在 base agent（裸智能）之上构建了完整的 **agent 身份与社会关系系统**：

| 职责 | 说明 |
|------|------|
| **通信接入** | 把 base agent 接入 AUN + 飞书 + 微信等多渠道 |
| **关系层**（relations/） | 以 AID 为锚点，构建"我认识谁"——跨渠道识别同一个人、记录关系、分级建档 |
| **环境层**（venues/） | 构建"我在什么场景下"——本端和对端之外的场所信息（群文化、规则、旁观信息等） |
| **个人数据层**（personal/） | 构建"我是谁"——人格、记忆、风格、技能 |
| **会话管理** | 消息路由、session 切换、历史 |
| **上下文组装** | 把以上所有信息按场景组装后注入 base agent |

Base agent 提供智能（推理、生成），EvolClaw 提供**身份、关系、环境感知、持久记忆**。

### EvolClaw Context Kit (ECK) 是什么

ECK 是 EvolClaw 注入给 base agent 的**知识包**——让 base agent 知道：

| 模块 | 让 base agent 知道 |
|------|-------------------|
| `$KITS_RULES/` | ECK 机制本身 + AUN 协议最小认知 + 角色/行为/命令入口 |
| `$KITS_DOCS/` | 各知识域的详细参考（AUN、evolclaw 命令、关系层、渠道规则）+ eck/ 初始化模板 |
| `$KITS_TEMPLATES/` | 不同场景下的 prompt 组装模板 |
| `$ECK/`（运行时） | 运行时配置 |

加上运行时动态注入的 per-agent 数据（persona.md、relations 数据、venues 数据）。

## 核心概念

系统由**主体**和**渠道**两个基本要素构成。

**主体（Principal）**：分为人和 agent。主体之间通过渠道收发消息，主体与主体之间存在关系（关系层定义的事情）。所有主体的身份在 AUN 网络中通过 AID 标识。人可以接入 AUN（有 AID），也可以不接入（只通过飞书等渠道）。agent 天然有 AID，天然接入 AUN。

**渠道（Channel）**：能收发消息的通信方式——AUN、飞书、微信、钉钉等。一个主体给另一个主体发消息时可以选择不同的渠道，选择权在主体自身。考虑到交互的延续性以及环境属性天然包含渠道信息，同一环境下通常延用同一渠道，但不强制。

**环境（Venue）**：本端和对端之外的场所信息。环境由多个参数维度决定（chatType、channelType、groupId、clientType 等），通过 manifest 参数驱动加载对应的环境文档。通用环境文档随包发布（`$KITS_DOCS/venues/`），具体群的特别内容按需存放在 `$VENUES_DIR/`。

**关系**：
- 主体之间的关系由关系层管理（relations/）
- 场所环境由环境层管理（venues/），通过参数驱动加载（详见 `docs/ECK上下文组装机制.md`）
- 两者正交：同一个人在不同环境里是同一个 Principal

**agent 的三个面**：
- `agent.md`（位于 `~/.aun/AIDs/<aid>/agent.md`）→ 对外名片，AUN 网络上别人看到的身份信息。本地 `.aun/` 目录由 AUN SDK 管理，evolclaw 通过 AUN SDK 间接读写
- `config.json`（位于 `$EVOLCLAW_HOME/agents/<aid>/config.json`）→ 对内配置，evolclaw 运行时使用
- `personal/`（位于 `$EVOLCLAW_HOME/agents/<aid>/personal/`）→ agent 的内在状态（人格、记忆、风格、偏好、技能），按需载入上下文，agent 自己可改

修改 agent 的名字和对外展示信息 → 改 `~/.aun/AIDs/<aid>/agent.md`，再通过 AUN SDK 的 `uploadAgentMd()` 上传到 AUN 网络（HTTP POST 到 `https://<aid>/agent.md`）。

## 路径体系

### 三个基础路径

所有其它路径都由这三个基础路径派生：

| 基础路径 | 含义 |
|----------|------|
| `$EVOLCLAW_HOME` | evolclaw 用户数据根 |
| `$PACKAGE_ROOT` | evolclaw 包根目录 |
| `$CURRENT_PROJECT` | 当前项目路径 |

### EVOLCLAW_HOME 根目录解析

根目录按以下优先级确定（见 `src/paths.ts`）：

1. 环境变量 `EVOLCLAW_HOME`（如果设置）
2. 当前工作目录（如果 `./agents/defaults.json` 存在）
3. 默认：`~/.evolclaw`

### 派生路径表

| 名称 | 派生规则 | 含义 |
|------|----------|------|
| `$KITS` | `$PACKAGE_ROOT/kits` | ECK 知识包根 |
| `$KITS_RULES` | `$KITS/rules` | 自动加载部分 |
| `$KITS_DOCS` | `$KITS/docs` | 按需加载 + 模板源 |
| `$KITS_TEMPLATES` | `$KITS/templates` | prompt 模板 |
| `$ECK` | `$EVOLCLAW_HOME/eck` | ECK 运行时配置 |
| `$AGENTS_DIR` | `$EVOLCLAW_HOME/agents` | per-agent 数据根 |
| `$AGENT_DIR` | `$AGENTS_DIR/<self-aid>` | 当前 agent 根目录 |
| `$PERSONAL_DIR` | `$AGENT_DIR/personal` | 当前 agent 的个人数据层根 |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` | 当前 agent 的关系层根 |
| `$VENUES_DIR` | `$AGENT_DIR/venues` | 当前 agent 的环境层根 |
| `$AGENT_INDEX` | `$AGENT_DIR/index` | 当前 agent 的文档索引目录 |

注：`<self-aid>` 在 evolclaw 运行时由当前 agent 决定；直接使用 base agent 时由 `$ECK/runtime.md` 中 `$SELF_AID` 决定。

### 会话级动态注入路径（$PEER_DIR）

以下路径在每次会话/消息处理时由 evolclaw 动态注入（直接使用 base agent 时不可用）：

| 名称 | 注入规则 | 含义 |
|------|----------|------|
| `$PEER_DIR` | `$RELATIONS_DIR/<channelType>#<urlEncode(channelId)>/` | 当前会话对端的关系目录 |

注入流程：
```
已知对端 channelType + channelId
  → 直接拼路径 $PEER_DIR = $RELATIONS_DIR/<channelType>#<urlEncode(channelId)>/
  （目录不存在时表示该对端尚未建档，会话首次交互时由 evolclaw 创建）
```

通过 name 查找：读 `$RELATIONS_DIR/_index/name_<urlEncode(name)>.json` 拿到 `{ name, channelType, channelId, peerKey }` 再拼路径。

**迁移说明**：旧 `$PEERS_DIR`（复数，指向所有对端的集合目录 `~/.evolclaw/aids/peers/`）废弃。新 `$PEER_DIR`（单数，会话级动态注入，指向当前对端的单个关系目录）取代。如有遍历所有已知对端的需求，应直接遍历 `$RELATIONS_DIR/` 下的所有 `<channelType>#<urlEncode(channelId)>/` 目录。旧路径 `~/.evolclaw/aids/self` 同样废弃，由 `$PERSONAL_DIR`（`$AGENT_DIR/personal`）取代。

### 路径注册表机制

路径注册表是 ECK 的核心机制之一，用于声明 `$名称` → 实际路径的映射，让 agent 能通过 `$名称` 引用任何需要感知的目录。

#### 三层结构

| 层 | 位置 | 性质 | 内容 |
|----|------|------|------|
| **机制描述** | `$KITS_RULES/02-registry.md` | 只读，自动加载（随 rules） | 路径注册表的语法、解析规则、派生规则、初始化流程、按需加载时机 |
| **路径定义** | `$KITS_DOCS/path-registry.md` | 只读，**按需加载** | 所有预定义路径的声明（含派生规则或寻找规则） |
| **路径实例** | `$ECK/path-registry.md` | 可变，**按需加载** | 已解析的真实路径值 + 用户自定义路径 |

#### 按需加载时机

路径定义文件和实例文件**不自动加载到上下文**，仅在以下场景按需 Read：

- agent 需要访问某个 `$名称` 对应的目录，但当前上下文中没有该路径的真实值
- agent 需要寻找某个外部依赖的位置（如 SDK、框架），避免不必要的搜索和猜测
- 用户要求注册新路径或查看已注册路径

具体的加载时机和触发词在 `$KITS_RULES/02-registry.md` 中定义。

#### 路径定义中的两类路径

**可直接派生的路径**：在三个基础根路径（或已定义路径）之下，直接写派生规则即可：

```markdown
| $KITS | $PACKAGE_ROOT/kits | ECK 知识包根 |
| $AGENT_DIR | $AGENTS_DIR/<self-aid> | 当前 agent 根目录 |
```

这类路径不需要初始化过程，规则确定性地算出真实值。

**不可直接派生的路径**：不在三大基础根路径（或已定义路径）之下，注册表中写明**寻找规则**而非固定值：

```markdown
| $AUN_SDK | 寻找规则：`npm list -g @fastaun/sdk --parseable`，或检查 node_modules/@fastaun/sdk | AUN SDK 路径 |
| $KITE | 寻找规则：`npm list -g @agentunion/kite --parseable`，或环境变量 KITE_PATH | Kite 框架路径 |
```

这类路径需要初始化过程。

#### 路径实例的初始化

evolclaw 启动时（或 ECK 初始化时）：

```
读取 $KITS_DOCS/path-registry.md 中所有路径定义
读取 $ECK/path-registry.md 中已有的路径实例

对每个路径定义：
  如果是可直接派生的：
    按派生规则计算真实值（无需写入实例文件，运行时直接算）
  如果是不可直接派生的：
    检查 $ECK/path-registry.md 中是否已有该路径的真实值
    如果没有（实例缺失）：
      按定义中的寻找规则搜索真实路径
      找到 → 写入 $ECK/path-registry.md（原子写入）
      未找到 → log warning，标记为未解析
```

#### 用户自定义路径

用户可以在 `$ECK/path-registry.md` 中手动添加自定义路径：

```markdown
## 用户自定义路径

| 名称 | 值 | 说明 |
|------|---|------|
| $MY_PROJECT | D:/work/my-app | 我的主项目 |
| $NOTES | ~/Documents/notes | 笔记库 |
```

这些路径不需要寻找规则（用户直接给出真实值），与系统自动解析的路径共存于同一个实例文件中。

### Bootstrap 协议

当 base agent 独立使用 ECK（无 evolclaw 动态注入）时，路径确定顺序：

1. `$EVOLCLAW_HOME`：环境变量 `EVOLCLAW_HOME` → 未设置则硬编码默认 `~/.evolclaw`
2. 确定 `$EVOLCLAW_HOME` 后，读取 `$EVOLCLAW_HOME/eck/runtime.md`
3. 从中获取所有基础路径和运行时参数
4. 按派生规则构造其余路径

不存在循环依赖：`$EVOLCLAW_HOME` 的确定不依赖任何文件。

#### 参数加载优先级

agent 会话中确定某个参数值时：

```
1. evolclaw 动态注入（如果通过 evolclaw 启动）
2. 环境变量（如 EVOLCLAW_HOME）
3. $ECK/runtime.md 中的配置
4. 硬编码默认值
```

## 目录结构：$PACKAGE_ROOT（evolclaw 包）

### kits/ 内部结构

```
evolclaw/                                        ← $PACKAGE_ROOT
├── kits/                                        ← ECK 唯一源，随 npm 包发布（$KITS）
│   │
│   ├── rules/                                   ← 自动加载部分（$KITS_RULES）
│   │   │                                          symlink 目标 / evolclaw systemPromptAppend 注入
│   │   ├── 01-entry.md                            ECK 入口、术语、核心机制概览
│   │   ├── 02-registry.md                         路径注册表机制（语法、派生规则、寻找规则、按需加载时机）
│   │   ├── 03-index.md                            索引机制（怎么建、怎么查、何时触发更新）
│   │   ├── 04-aun.md                              AUN 最小认知（协议、命名空间、自主模式）
│   │   ├── 05-role.md                             角色与场景机制（token 识别、场景判定）
│   │   ├── 06-behavior.md                         行为规范加载机制（身份档案 → 人格切换）
│   │   ├── 07-agent-cmd.md                        agent 命令集入口（触发词 → 加载 docs）
│   │   └── 08-msg-cmd.md                          消息命令集入口（单聊/群聊分流）
│   │
│   ├── docs/                                    ← 按需加载 + 模板源 + evolclaw 级索引（$KITS_DOCS）
│   │   │
│   │   ├── INDEX.md                               evolclaw 级文档索引（开发时维护，运行时只读）
│   │   ├── GUIDE.md                               evolclaw 级查阅指南（开发时维护，运行时只读）
│   │   ├── path-registry.md                       路径定义（所有预定义路径的声明：派生规则或寻找规则）
│   │   │
│   │   ├── eck_templates/                         初始化模板
│   │   │   ├── runtime.template.md                  运行时配置模板（基础路径 + 身份 + 行为 + 通信参数）→ $ECK/runtime.md
│   │   │   ├── path-registry.template.md            路径注册表实例模板 → $ECK/path-registry.md
│   │   │   ├── INDEX.template.md                    agent 级索引模板 → $AGENT_INDEX/INDEX.md
│   │   │   └── GUIDE.template.md                    agent 级查阅指南模板 → $AGENT_INDEX/GUIDE.md
│   │   │
│   │   ├── aun/                                   AUN 协议详细文档
│   │   │   ├── CHEATSHEET.md                        速查表
│   │   │   └── SYNC_PROTOCOL.md                     同步协议 SOP
│   │   │
│   │   ├── evolclaw/                              evolclaw 命令集详细参考（每命令集一份，ec 前缀）
│   │   │   ├── msg.md                                ec msg — 私聊收发消息
│   │   │   ├── group.md                              ec group — 群聊收发与群管理
│   │   │   ├── agent.md                              ec agent — EvolAgent 生命周期
│   │   │   ├── aid.md                                ec aid — AID 身份管理
│   │   │   ├── storage.md                            ec storage — 文件存储
│   │   │   ├── ctl.md                                ec ctl — 会话运行时自管理
│   │   │   └── rpc.md                                ec rpc — 底层 AUN RPC（逃生通道）
│   │   │
│   │   ├── identity/                              关系层详细规则
│   │   │   ├── ROLE_DETAIL.md                       角色与场景详细规则
│   │   │   ├── AID_PROFILE_SPEC.md                  AID 档案规范
│   │   │   └── PATH_OPS.md                          路径运维操作
│   │   │
│   │   └── channels/                              各渠道详细规则
│   │       ├── aun.md                               AUN 通信约定
│   │       ├── feishu.md                            飞书消息类型、文件协议、@ 语法
│   │       └── ...
│   │
│   └── templates/                               ← 运行时 prompt 组装（$KITS_TEMPLATES）
│       ├── private.md                               私聊场景模板
│       ├── group.md                                 群聊场景模板
│       └── system-fragments/                        可复用片段
│           ├── self-intro.md
│           ├── speaker-intro.md
│           ├── venue-intro.md
│           └── personal-context.md
│
│   注：模板中的占位符由 evolclaw 在注入时替换。若占位符未被替换（如 base agent
│   独立使用 ECK、无 evolclaw 动态注入），agent 应从 $ECK/runtime.md 读取对应参数值
│   自行完成替换。
│
├── docs/                                        ← evolclaw 设计文档（不随 kits，仅开发参考）
├── src/                                         ← 源码
├── dist/                                        ← 编译产物
└── package.json
```

### 伞目录（开发时 symlink）

```
$X/                                              ← 伞目录（开发工作区根）
├── .claude/
│   └── rules/
│       ├── eck/ → symlink → $KITS_RULES/          ECK 全权管理，勿手动修改
│       │   ├── 01-entry.md                        （symlink 内容，来自 kits/rules/）
│       │   ├── 02-path.md
│       │   └── ...
│       └── my-custom-rule.md                      用户自定义 rules（不受 ECK 影响）
│
└── ...（项目目录）
```

## 目录结构：$EVOLCLAW_HOME（用户数据）

### 完整目录树

数据按"作用域"分层：**进程级配置**（config.json）+ **ECK 运行时配置**（eck/）+ **per-agent 数据**（agents/\<aid\>/）+ **部署级运行时**（data/）+ **日志**（logs/）。

> **注意**：kits/（ECK 知识包）不在 `$EVOLCLAW_HOME` 内，属于 evolclaw 包代码（`$PACKAGE_ROOT/kits/`），随 npm 包发布。

```
$EVOLCLAW_HOME/
│
├── config.json                                  ← evolclaw 进程级配置（日志、AUN SDK 等）
│
├── eck/                                         ← ECK 全局运行时配置 + 路径实例（$ECK）
│   │                                              首次启动从 $KITS_DOCS/eck_templates/ 初始化
│   │                                              已存在则不覆盖
│   │
│   ├── runtime.md                                 运行时配置（基础路径 + 身份 + 行为 + 通信参数）
│   │                                                evolclaw 运行时不读此文件（自己能算）
│   │                                                仅供"直接使用 base agent 无 evolclaw"场景
│   │
│   └── path-registry.md                           路径注册表实例（按需加载）
│                                                    已解析的不可直接派生路径的真实值
│                                                    + 用户自定义路径
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
│       ├── index/                             ← agent 级索引（$AGENT_INDEX）
│       │   ├── INDEX.md                         该 agent 工作项目的文档索引
│       │   └── GUIDE.md                         该 agent 的查阅指南
│       │
│       ├── relations/                          ← 关系层：Principal 认知
│       │   │                                    每个对端/群一个目录，统一用 <channelType>#<urlEncode(channelId)> 命名
│       │   │                                    （即 peerKey，详见 docs/通信路由体系.md）
│       │   │
│       │   ├── _index/                          名字反查索引
│       │   │   ├── name_<urlEncode(name)>.json    { name, channelType, channelId, peerKey }
│       │   │   └── ...
│       │   │
│       │   ├── <channelType>#<urlEncode(channelId)>/   每个对端/群一个目录
│       │   │   ├── profile.md                     frontmatter（name/type/owner/agents/...）+ 关系正文
│       │   │   └── history.jsonl                  关系演化事件流
│       │   │
│       │   └── _trash/                          merged / split 后的重定向占位
│       │       └── <timestamp>_<original>/         保留 history，profile.md 仅 { merged_to: <peerKey> }
│       │
│       ├── venues/                            ← 环境层：agent 私有环境文档（按需创建）
│       │   │                                    仅当通用文档无法覆盖时才为具体群建文档
│       │   │
│       │   ├── <channelType>#<urlEncode(groupId)>/  具体群的环境文档
│       │   │   └── profile.md                     群的特别内容
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
│       ├── sessions/                          ← 会话存储（per-agent）【目标态，暂未实现】
│       │   └── <session-key>/                     当前 sessions 仍在 data/sessions/，
│       │       ├── messages.jsonl                 待迁入 per-agent 目录
│       │       └── meta.json
│       │
│       └── data/                              ← 其它运行时数据
│           ├── cache/                           临时缓存（agent.md 拉取缓存等）
│           └── ...
│
├── data/                                    ← 部署级：evolclaw 运行时数据（仅运行时，无业务配置）
│   │
│   ├── sessions/                              会话数据（当前实际位置，详见下方说明）
│   │   └── <channelType>/                       所有渠道统一三层：channelType/selfAID/channelId
│   │       └── <selfAID>/                         本端 agent 的 AID（不 encode，唯一标识 agent）
│   │           └── <urlEncode(channelId)>/          对话标识（私聊=对端ID，群聊=群ID）
│   │               ├── active.json                当前活跃 session 快照（热路径只读这个）
│   │               ├── task.lock                  运行时任务状态（JSONL，任务结束删除）
│   │               ├── health.jsonl               健康状态记录（append-only）
│   │               ├── meta_*.jsonl               session 元数据演化档案（每行完整快照）
│   │               ├── _threads/                  话题 session（thread-index.json + meta_*.jsonl）
│   │               ├── _index/                    反查索引（by-name/by-project/by-agent）
│   │               └── _trash/                    软删暂存（启动时清理 30 天前文件）
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

### config.json — evolclaw 进程级配置

`$EVOLCLAW_HOME/config.json` 是 evolclaw 进程本身的配置，与 agent 无关。

```jsonc
// $EVOLCLAW_HOME/config.json
{
  "$schema_version": 1,

  // === 日志 ===
  "log": {
    "level": "info",                           // debug | info | warn | error
    "retention_hours": 12,                     // 日志保留时长
    "message_log": false,                      // 是否启用消息日志
    "event_log": false                         // 是否启用事件日志
  },

  // === AUN SDK ===
  "aun": {
    "gateway": "wss://gateway.agentid.pub",    // AUN 网关地址
    "keystorePath": "~/.aun",                  // AUN 密钥库路径
    "encryptionSeed": "$ENV:AUN_ENCRYPTION_SEED"  // 🔑
  }
}
```

**与 `agents/defaults.json` 的边界**：`config.json` 存进程级配置（日志、AUN SDK 初始化参数），`defaults.json` 只做 per-agent `config.json` 的字段级 fallback（baseagents、models、chatmode 等 agent 行为配置）。

### eck/ — ECK 全局运行时配置

`$EVOLCLAW_HOME/eck/` 存放 ECK 的运行时配置实例，首次启动从 `$KITS_DOCS/eck_templates/` 初始化，已存在则不覆盖。

| 文件 | 用途 |
|------|------|
| `runtime.md` | 运行时配置（基础路径 + 身份 + 行为 + 通信参数）。evolclaw 运行时不读此文件（自己能算），仅供 base agent 独立使用 ECK 时加载 |
| `path-registry.md` | 路径注册表实例（已解析的不可直接派生路径的真实值 + 用户自定义路径），按需加载 |

#### runtime.md 文件内容

`$ECK/runtime.md` 是一个静态配置文件，evolclaw 首次启动时从模板生成（`$KITS_DOCS/eck_templates/runtime.template.md`），之后不再覆盖。用户可手动编辑。

```markdown
---
eck_schema: "1.0"
---

# ECK 运行时配置

当未通过 evolclaw 启动 base agent 时，ECK 从本文件加载运行时参数。
通过 evolclaw 启动时，evolclaw 动态注入这些值，本文件不被读取。

## 基础路径

| 名称 | 值 | 说明 |
|------|---|------|
| $EVOLCLAW_HOME | ~/.evolclaw | 环境变量 EVOLCLAW_HOME 优先 |
| $PACKAGE_ROOT | ~/npm/node_modules/evolclaw | evolclaw 包根目录 |
| $CURRENT_PROJECT | （使用当前工作目录） | 会话级，无固定默认值 |

## 身份参数

| 名称 | 值 | 说明 |
|------|---|------|
| $SELF_AID | toleiliang2.agentid.pub | 默认使用的 agent AID |
| $SELF_NAME | 夙夜无偕1号 | 默认显示名 |

## 行为参数

| 名称 | 值 | 说明 |
|------|---|------|
| eck_injection | false | 是否由 evolclaw 注入（直接使用 base agent 时为 false） |
| eck_injection_reason | — | 注入检测结果原因（symlink-active / baseagent-no-autoload / symlink-not-found） |
| base_agent | claude-code | 当前 base agent 类型 |
| proactive_mode | false | 是否主动发起对话 |

## 通信参数

| 名称 | 值 | 说明 |
|------|---|------|
| aun_gateway | wss://gateway.agentid.pub | AUN 网关地址（CLI 命令使用） |
| default_app | claude-code | msg pull/ack 的 --app 默认值 |
```

**注意**：evolclaw 运行时不读 `$ECK/runtime.md`（它能直接算出所有参数）。这个文件服务于 **base agent 独立使用 ECK 的场景**——即未通过 evolclaw 启动，但 base agent 需要自行完成 ECK 上下文加载时，从此文件获取运行时参数。

### agents/defaults.json — 全局默认配置

agent 根目录下的默认配置文件，为所有 agent 提供字段级 fallback。

**配置加载优先级**：per-agent `config.json` → `defaults.json` → 代码默认值。

**合并规则**：
- **深合并字段**：`models`、`chatmode`、`baseagents` — 递归 merge，per-agent 只需写要覆盖的子字段
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
      "claude-haiku-4-5-20251001",
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

每个 self agent 一个子目录，**目录名是 agent 自己的 AID**。所有 per-agent 数据（个人数据层、关系层、环境层、会话）都收纳到该目录下。

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
| `channels` | ✅ | — | — | 额外渠道列表（每项含 type、凭证、owners、admins）。**不进 defaults**——各 self-agent 的接入凭证差异大，无共享意义。channel 实例的 `owners`/`admins` 用该 channel 的原生 ID（飞书 user_id、钉钉 unionId 等），**不强制 AID** |
| `active_baseagent` | 可覆盖 | ✅ | 标量 | 当前活跃基座，运行时可命令切换 |
| `baseagents` | 可覆盖 | ✅ | 深合并 | 各基座配置字典 |
| `models` | 可覆盖 | ✅ | 深合并 | 默认模型 + 允许范围 + 按角色分配 |
| `projects` | 可覆盖 | ✅ | 浅覆盖 | 工作目录（defaultPath + list） |
| `chatmode` | 可覆盖 | ✅ | 深合并 | 交互模式 |
| `show_activities` | 可覆盖 | ✅ | 标量 | 中间输出可见性 |
| `flush_delay` | 可覆盖 | ✅ | 标量 | 出站消息批次间隔 |
| `debounce` | 可覆盖 | ✅ | 标量 | 入站消息去抖 |

**关于 AUN 渠道**：AUN 是 agent 的存在基础——`aid` = agent 身份 = AUN channel ID，三者是同一个东西，必须有且只有一个。AUN 的运行参数（gateway、keystorePath、encryptionSeed）在进程级 `$EVOLCLAW_HOME/config.json` 的 `aun` 字段配置。其他 channel 是 agent 选择接入的额外渠道（0 到多个），以列表形式配置在 per-agent `config.json` 的 `channels` 中，每项带 `type` 标识渠道类型。

**关于 owner**：顶层 `owners` 是 AUN 渠道（即 agent 本身）的 owner 列表，元素为 AID。每个 channel 实例可以有自己的 `owners` / `admins` 列表，元素为**该 channel 的原生标识**（飞书 user_id、钉钉 unionId 等），由该 channel 的身份系统决定，不要求有对应 AID。顶层 `owners` 允许为空——空表示"待指定"，第一个通信者自动成为 owner。

**关于基座切换**：`active_baseagent` 标记当前使用的基座。运行时可通过命令切换到 `baseagents` 字典中任何已配置的基座。切换即时生效，不需要重启。

**关于模型切换**：`models.default` 和 `models.by_role` 是启动时的默认值。运行时 agent 可通过命令行工具在 `models.allowed` 范围内自主切换，切换即时生效。

#### index/ — agent 级索引

ECK 的索引分为 **evolclaw 级**和 **agent 级**两层，解决多 agent 并发写问题：

**evolclaw 级索引（只读，随包发布）**：

| 内容 | 位置 | 说明 |
|------|------|------|
| evolclaw 项目文档索引 | `$KITS_DOCS/INDEX.md` | 随包发布，只读。索引 kits/docs/ 下所有文档 |
| 查阅指南 | `$KITS_DOCS/GUIDE.md` | 随包发布，只读 |

evolclaw 级索引在**开发阶段**产生和维护，安装运行时只使用、不修改。因此不需要拷贝到 `$EVOLCLAW_HOME/`，直接保留在 `$KITS_DOCS/` 内即可。

**触发时机**：`$KITS_DOCS/` 下有文档新增或较大幅度修改时，开发者手动重建索引（开发阶段行为，不涉及运行时）。发现索引过时时，不自动修改，按 `$KITS_DOCS/GUIDE.md` 的流程呈报用户。

**agent 级索引（per-agent，可写）**：

| 内容 | 位置 | 说明 |
|------|------|------|
| agent 工作项目文档索引 | `$AGENT_INDEX/INDEX.md` | 由该 agent 会话维护 |
| agent 查阅指南 | `$AGENT_INDEX/GUIDE.md` | 由该 agent 会话维护 |

每个 agent 只索引自己工作范围内的文档。agent 级索引的路径范围限定为：
- `$CURRENT_PROJECT`（当前工作目录及其子目录）
- `$AGENT_DIR`（自己的 agent 数据目录及其子目录）

**触发时机**：与 evolclaw 级相同——上述范围内有文档新增或较大幅度修改时，agent 主动重建索引（直接写入 `$AGENT_INDEX/INDEX.md`，无需呈报用户）。

**不需要路径注册表**：agent 级只有两个根路径（`$CURRENT_PROJECT` 和 `$AGENT_DIR`），内部子路径直接基于定义的路径名使用，不存在其它需要注册的路径。

**写入隔离**：
- `$KITS_DOCS/`（evolclaw 级）：只读，只在开发时维护，运行时不写入
- `$AGENT_INDEX/`（agent 级）：只有该 aid 对应的 agent 会话写入，其它 agent 不碰

天然无并发冲突。

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

#### relations/ — 关系层（Principal 认知）

**统一目录命名**：所有对端档案目录名为 `<channelType>#<urlEncode(channelId)>`，不区分"已交互/旁观"分类。

**peerKey 编码规则**：
- 格式：`<channelType>#<urlEncode(channelId)>`
- 例：`aun#alice.aid.pub`、`feishu#oc_xxx`、`wechat#wxid_xxx`
- `channelId` 总是 URL encode（即使不含特殊字符也 encode，保持一致）
- `#` 是 channelType 与 channelId 的分隔符，不会出现在 channelType 或 encoded channelId 中

**通过 name 反查**：`_index/name_<urlEncode(name)>.json` 存 `{ name, channelType, channelId, peerKey }`，用于"给王老板发消息"这类按名字定位的场景。

**profile.md 格式**（关系档案示例）：

```markdown
---
name: 王老板
type: person                    # person | agent
peerKey: feishu#ou_wang         # channelType#channelId
primary_channel: feishu
status: identified              # unidentified | identified | merged
channels:                       # 多渠道可关联的同一个 person 的所有 peerKey
  - "feishu#ou_wang"
  - "aun#wang.agentid.pub"
aid: wang.agentid.pub           # 可选：对端的 AUN AID（仅当对端有 AUN 身份）
agents:                         # type=person 时：他拥有的 agent
  - "wang-secretary.agentid.pub"
roles_for_self: [owner]
agent_view:
  preferred_address: "王老板"
  tone: "正式但不拘谨"
  last_topic: "Q4 项目排期"
---

王老板就是研发部那位王经理，平时说话挺直接。
上次聊 Q4 项目时对延期比较介意，后续沟通要先报进度再讲问题。
```

**关于 AID**：AID 仅 AUN 渠道存在。飞书/微信/邮件等非 AUN 渠道独有的对端不写 `aid` 字段，用 `peerKey` 作 canonical。owner / admin 等特权角色仍要求绑定一个 AID（详见 identity-layer-design.md §4.4）。

**history.jsonl 事件类型**：`created` / `identified` / `channel_added` / `channel_removed` / `merged` / `split` / `profile_updated` / `interaction`

#### venues/ — 环境层

环境层存放**本端和对端之外的场所信息**——通过参数驱动的上下文加载机制（详见 `docs/ECK上下文组装机制.md`）按需注入。

通用环境文档（按 chatType、channelType 等参数定位）随包发布在 `$KITS_DOCS/venues/`。agent 私有环境文档（具体群的特别内容）存放在此目录下，仅当通用文档+渠道文档无法覆盖时才创建。

**目录命名**：`<channelType>#<urlEncode(groupId)>/`（仅群聊场景）。

```
venues/
├── <channelType>#<urlEncode(groupId)>/    具体群的环境文档（按需创建）
│   └── profile.md                          群的特别内容（通用文档覆盖不到的）
└── ...
```

**profile.md 格式**（群，示例）：

```markdown
---
kind: group
venueKey: "feishu#chat_xyz"
channel: feishu
groupId: "chat_xyz"
name: "项目X讨论群"
policy:
  require_mention: true
  batch_window_seconds: 30
metadata:
  purpose: "Q4 项目讨论"
agent_view:
  tone: "正式"
  active_topics: ["Q4 项目排期", "技术选型"]
---

项目 X 讨论群是研发部为新项目搭建的协作群。
群里讨论需求决策时通常需要 @ 我才介入。
```

**创建时机**：agent 观察到某个群有通用文档无法覆盖的特别内容时主动创建。大多数群不需要单独建文档——通用场景文档（`$KITS_DOCS/venues/group.md`）和渠道场景文档（`$KITS_DOCS/venues/feishu-group.md`）已经提供了足够的行为指引。

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

### data/ — 部署级运行时

新设计中，agent / channel / 模型 / 项目等业务配置全部迁移到 `agents/defaults.json` + `agents/<aid>/config.json`。`data/` 目录只保留**部署级运行时数据**——进程管理、消息队列、重启状态、会话数据等。

| 子目录/文件 | 用途 |
|------|------|
| `sessions/` | 会话数据（当前实际位置，见下方详解） |
| `instance/` | 进程实例注册（见下） |
| `outbox/` | 离线消息发件箱（见下） |
| `restart-pending.json` | 重启挂起状态 |
| `restart-confirm-*.json` | 重启确认文件 |

#### sessions/ — 会话数据（当前态）

Sessions 当前存放在 `data/sessions/` 下。目标态是迁入 `agents/<aid>/sessions/`（per-agent 隔离）。当前结构详见 `docs/refactor/01-db-to-fs.md`。会话路由键（sessionKey）定义见 `docs/通信路由体系.md`。

目录层级（所有渠道统一）：
- `<channelType>/<selfAID>/<urlEncode(channelId)>/`

其中 `selfAID` 是本端 agent 的 AID（不 encode，唯一标识 agent），`channelId` 是对话标识（私聊=对端 ID，群聊=群 ID，需 urlEncode）。

每个 chat 目录下的文件：

| 文件 | 用途 |
|------|------|
| `active.json` | 当前活跃 session 的完整快照（热路径只读这个） |
| `task.lock` | 运行时任务状态（JSONL，任务开始写入，结束删除） |
| `health.jsonl` | 健康状态记录（append-only，每条消息处理完追加） |
| `meta_*.jsonl` | session 元数据演化档案（每行一份完整快照，文件名=session id） |
| `_threads/` | 话题 session（`thread-index.json` + `meta_*.jsonl`） |
| `_index/` | 反查索引（by-name / by-project / by-agent） |
| `_trash/` | 软删暂存（启动时清理 30 天前文件） |

#### instance/ — 进程实例注册

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

#### outbox/ — 离线消息发件箱

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

### 项目级 .evolclaw/

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

## ECK 分发机制

当前 ECK 的 rules 部分（7 个 md）手动维护在伞目录 `$X/.claude/rules/`，docs 部分（10 个 md）手动维护在 `$X/.claude/aun-docs/`。问题是两处维护、生命周期不统一。目标：**唯一源在 `$KITS/`**，随 npm 包发布。开发时通过 symlink 让 Claude Code 自动加载；运行时 evolclaw 直接从包内读取注入上下文。kits 与 `$EVOLCLAW_HOME` 无关。

### 唯一源原则

`$KITS/`（即 `$PACKAGE_ROOT/kits/`）是 ECK 的唯一维护位置，随 npm 包发布。

### 两种使用场景

| 场景 | 加载方式 | 文档来源 | 去重 |
|------|----------|----------|------|
| 直接使用（Claude Code 本地开发） | `$X/.claude/rules/eck/` 自动加载机制 | symlink → `$KITS_RULES/` | — |
| 通过 evolclaw 使用（daemon 运行时） | evolclaw 代码注入 systemPromptAppend | `$KITS_RULES/` | 注入前基于 baseagent 能力表 + symlink 检测决定是否跳过（详见"重复加载检测"） |

### symlink 绑定

```bash
# 绑定：在伞目录下执行
evolclaw link-rules [--umbrella <path>]
# 效果：创建 <umbrella>/.claude/rules/eck/ → $KITS_RULES/ 的 symlink/junction

# 解绑
evolclaw unlink-rules [--umbrella <path>]
```

**幂等性与错误处理**：
- 目标路径 `.claude/rules/eck/` 已存在（无论是 symlink 还是普通目录）→ 报错退出，不覆盖，提示用户先手动删除或运行 `unlink-rules`
- `unlink-rules` 目标不存在 → 静默成功（幂等）
- `unlink-rules` 目标存在但不是 symlink/junction（用户手动创建的普通目录）→ 报错退出，不删除

**重要声明**：`.claude/rules/eck/` 由 ECK 全权管理（symlink/junction 指向包内 kits/rules/）。此目录下的内容随包版本更新，请勿手动修改。用户自定义 rules 请直接放在 `.claude/rules/` 根目录。

跨平台兼容：
- macOS/Linux：`fs.symlinkSync(target, path, 'dir')`，无需特殊权限
- Windows：`fs.symlinkSync(target, path, 'junction')`，无需管理员权限

### 文档来源：始终从包内读取

evolclaw 已有 `getPackageRoot()` 函数（`src/paths.ts:135`），返回 `import.meta.dirname` 的上级目录。

- **从代码仓启动**（`npm link` / 直接 `node dist/cli.js`）：`getPackageRoot()` 返回代码仓根目录 → `$PACKAGE_ROOT` = 代码仓
- **从全局安装启动**（`npm install -g evolclaw`）：`getPackageRoot()` 返回全局安装路径 → `$PACKAGE_ROOT` = 安装路径

**kits 只存在于 `$PACKAGE_ROOT/` 内，不复制到 `$EVOLCLAW_HOME/`**。原有的 `syncKitsFromPackage()` 废弃删除。

### 索引机制：两层分离

ECK 的骨架是两个机制：

1. **路径注册表**（机制描述在 `$KITS_RULES/02-registry.md`，路径定义在 `$KITS_DOCS/path-registry.md`，路径实例在 `$ECK/path-registry.md`）：用 `$名称` 声明路径，运行时展开为实际路径。可直接派生的路径从三个基础路径按固定规则算出；不可直接派生的路径按定义中的寻找规则搜索后写入实例文件
2. **索引机制**（机制描述在 `$KITS_RULES/03-index.md`，evolclaw 级实例在 `$KITS_DOCS/INDEX.md`，agent 级实例在 `$AGENT_INDEX/INDEX.md`）：agent 对工作范围内的文档自动建立索引；需要时按索引精确加载（行区间级别）

补充：`$ECK/runtime.md` 不属于上述两个核心机制，而是 **base agent 独立使用 ECK 时的运行时参数加载源**（提供基础路径值 + 身份/行为/通信参数）。通过 evolclaw 启动时这些参数由 evolclaw 动态注入，runtime.md 不被读取。

**机制 vs 实例**的分离：
- `$KITS_RULES/` 描述**机制**（路径怎么声明和派生、索引怎么建和查）——随包发布，只读
- `$KITS_DOCS/` 提供**模板**（初始结构）+ 各知识域的详细参考文档 + evolclaw 级索引——随包发布，只读
- `$ECK/runtime.md` 存放**独立使用时的运行时参数**——用户配置，可变
- `$ECK/path-registry.md` 存放**路径实例**（已解析的真实路径值 + 用户自定义路径）——按需加载，可变
- `$AGENT_INDEX/` 存放**agent 级索引实例**——per-agent 运行时数据，可变

**目录组织原则：按加载方式分**：

| 目录 | 位置 | 加载方式 | 内容 |
|------|------|----------|------|
| `$KITS_RULES/` | `$PACKAGE_ROOT` 内 | **自动加载**（symlink 或 evolclaw 注入） | ECK 机制描述 + 各知识域最小认知 |
| `$KITS_DOCS/` | `$PACKAGE_ROOT` 内 | **按需加载** + **模板源** + **evolclaw 级索引** + **路径定义** | 详细参考文档 + 初始化模板 + INDEX.md + GUIDE.md + path-registry.md |
| `$KITS_TEMPLATES/` | `$PACKAGE_ROOT` 内 | **运行时组装**（evolclaw 代码按场景选取） | prompt 模板 + 可复用片段 |
| `$ECK/` | `$EVOLCLAW_HOME` 内 | **运行时配置 + 路径实例**（用户/evolclaw 写入，按需加载） | runtime.md、path-registry.md |
| `$AGENT_INDEX/` | `$AGENT_DIR` 内 | **agent 级索引**（agent 读写） | INDEX.md、GUIDE.md |

### eck/ 初始化逻辑

evolclaw 启动时：

```
对 $ECK/runtime.md：
  如果文件不存在：
    从 $KITS_DOCS/eck_templates/runtime.template.md 复制
    展开模板中的占位符（填入实际路径值）
  如果文件已存在：
    不覆盖（保留用户的修改）

对 $ECK/path-registry.md：
  如果文件不存在：
    从 $KITS_DOCS/eck_templates/path-registry.template.md 复制
  如果文件已存在：
    不覆盖
  然后：读取 $KITS_DOCS/path-registry.md 中的路径定义
    对每个不可直接派生的路径，检查实例中是否已有真实值
    缺失的 → 按寻找规则搜索 → 找到则写入实例（原子写入）

对 $AGENT_INDEX/ 下每个预期文件（INDEX.md、GUIDE.md）：
  如果文件不存在：
    从 $KITS_DOCS/eck_templates/ 复制对应 .template.md
  如果文件已存在：
    不覆盖
```

**单实例前提**：evolclaw 在同一 `$EVOLCLAW_HOME` 下保证单实例运行（见 `data/instance/` 互斥机制），因此 `$ECK/` 写入不存在多进程竞争。

**文件写入安全**：所有对 `$ECK/` 和 `$AGENT_INDEX/` 的写入操作必须使用**原子写入**——先写入临时文件（同目录下 `.tmp` 后缀），再 `rename` 到目标路径。这从代码层面避免进程中断导致的文件半截损坏。

**升级行为**：包升级后模板可能有新内容，但不会覆盖已有实例。具体的 schema 版本迁移机制暂不实现，留作后续设计（见"待设计"章节）。

### 重复加载检测

**问题**：ECK 在两种场景下使用：

1. **直接使用**（Claude Code 本地开发）：通过 `.claude/rules/eck/` 自动加载机制
2. **通过 evolclaw 使用**（daemon 运行时）：通过 systemPromptAppend 注入

如果 evolclaw 的 projectPath 在伞目录下，Claude Code 会自动加载 `.claude/rules/eck/`（symlink 到 kits/rules/），同时 evolclaw 又注入同样内容 → 重复。

**决策：baseagent 能力硬编码表 + symlink 检测**

#### baseagent 能力表

```typescript
interface BaseAgentCaps {
  autoLoadsRules: boolean;       // 是否有 .claude/rules/ 自动加载机制
  supportsSystemPrompt: boolean; // 是否支持 systemPromptAppend
}

const BASEAGENT_CAPS: Record<string, BaseAgentCaps> = {
  'claude-code': {
    autoLoadsRules: true,
    supportsSystemPrompt: true,
  },
  'codex': {
    autoLoadsRules: false,
    supportsSystemPrompt: true,
  },
  'gemini-cli': {
    autoLoadsRules: false,
    supportsSystemPrompt: true,
  },
};
```

#### 检测流程

**调用时机**：agent 启动时针对其 `projectPath` 计算一次，结果以 `projectPath` 为 key 缓存于 agent 运行时上下文（`eck_injection` / `eck_injection_reason`）。不同 agent 的 `projectPath` 不同，缓存结果互不影响；后续消息处理不重复计算。

```typescript
function resolveEckInjection(
  agentConfig: { baseAgent: string },
  projectPath: string,
  kitsRulesPath: string
): { shouldInject: boolean; reason: string } {
  const caps = BASEAGENT_CAPS[agentConfig.baseAgent]
    ?? { autoLoadsRules: false, supportsSystemPrompt: true };

  // 1. baseagent 不支持自动加载 → 必须注入
  if (!caps.autoLoadsRules) {
    return { shouldInject: true, reason: 'baseagent-no-autoload' };
  }

  // 2. baseagent 支持自动加载 → 检测 symlink 是否存在
  const symlinkActive = detectEckSymlink(projectPath, kitsRulesPath);
  if (symlinkActive) {
    return { shouldInject: false, reason: 'symlink-active' };
  }

  // 3. symlink 不存在（可能不在伞目录下）→ 注入
  return { shouldInject: true, reason: 'symlink-not-found' };
}

function detectEckSymlink(projectPath: string, kitsRulesPath: string): boolean {
  const MAX_DEPTH = 5;
  let dir = projectPath;
  let depth = 0;
  while (depth < MAX_DEPTH) {
    const eckDir = path.join(dir, '.claude', 'rules', 'eck');
    if (fs.existsSync(eckDir)) {
      try {
        const realPath = fs.realpathSync(eckDir);
        // 实现注意：Windows junction 解析为绝对路径，kitsRulesPath 若为相对路径会导致比较失败；
        // 调用前须确保 kitsRulesPath 已经过 path.resolve()
        const kitsRulesReal = fs.realpathSync(kitsRulesPath);
        if (pathEquals(realPath, kitsRulesReal)) {
          return true;
        }
      } catch {
        // 检测失败 → 保守认为未加载
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }
  return false;
}

function pathEquals(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
  return path.resolve(a) === path.resolve(b);
}
```

#### 检测结果作为运行时参数注入

检测结果通过 `eck_injection` 和 `eck_injection_reason` 注入到 agent 上下文中：

```typescript
// 注入到 systemPrompt 的运行时参数段
const runtimeParams = {
  eck_injection: result.shouldInject,
  eck_injection_reason: result.reason,
  // ...其它运行时参数
};
```

agent 可以通过这两个参数了解 ECK 的加载状态，用于调试和行为判断。

#### 重复场景分析

| 场景 | base agent 加载 rules/eck/? | evolclaw 注入? | 重复? |
|------|:-:|:-:|:-:|
| 直接使用（无 evolclaw） | 是（symlink） | 否 | 否 |
| evolclaw，projectPath 在伞目录下 | 是（向上遍历找到 symlink） | 检测到 → 跳过 | **否** |
| evolclaw，projectPath 不在伞目录下 | 否 | 是 | 否 |
| evolclaw，非 Claude baseagent（Codex/Gemini） | 否（无 rules 机制） | 是 | 否 |

**要点**：
- 基于 `BASEAGENT_CAPS` 硬编码表判断 baseagent 是否有自动加载能力，避免对不支持的 baseagent 做无意义检测
- 未知 baseagent（不在硬编码表中）退回保守默认值（`autoLoadsRules: false`），走注入路径
- 向上遍历最多 5 层（`MAX_DEPTH = 5`），防御极端深层路径
- 检测基于 `fs.realpathSync()` 解析 symlink 真实路径，与 kits/rules/ 的真实路径比较
- Windows 上路径比较需要 case-insensitive（`path.resolve().toLowerCase()` 对比）
- 检测失败（权限问题等）→ 保守注入（宁可重复不可遗漏）
- 跨平台兼容：`fs.realpathSync()` 能正确解析 symlink（Unix）和 junction（Windows）

## 原子写入

### 业务关键 JSON：双 rename

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

**适用范围**：所有"业务关键 JSON"——`agents/defaults.json`、`agents/<aid>/config.json`、relations/venues 的 `profile.md` 与 `_index/*.json`。JSONL 类追加写文件不走此流程（追加本身就有较好的崩溃语义）。

**与现有 `evolclaw.json` 自动备份的衔接**：当前 `config.ts` 已实现的 timestamped backup（`evolclaw-YYYYMMDD-HHMMSS.json`）作为更长期的回退池保留——双 rename 是热备（最近一次），timestamped 是冷备（人工恢复用）。

### ECK 文件：write-tmp-then-rename

所有对 `$ECK/` 和 `$AGENT_INDEX/` 的写入操作使用 write-tmp-then-rename 模式：

```typescript
function atomicWriteSync(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  // 实现注意：renameSync 失败时 tmp 文件不会自动清理；
  // 启动时应清理同目录下 .tmp.* 残留文件
}
```

## 迁移

### 现状速览

```
当前 ~/.evolclaw/                       目标
├── agents/
│   ├── evolclaw.json               →  agents/defaults.json
│   ├── <name>.json                 →  agents/<aid>/config.json
│   └── <旧式名字目录>/              →  清理或迁入 agents/<aid>/
├── aids/
│   ├── self/<aid>.md               →  agents/<aid>/personal/persona.md
│   └── peers/<aid>.md              →  agents/<aid>/relations/aun#<aid>/profile.md
│                                       （所有对端统一用 <channelType>#<urlEncode(channelId)> 命名）
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

- 按 `defaults.json` 的字段定义重新构造（`baseagents`、`models`、`chatmode`、`projects`、`admins` 等顶层段）
- 旧 `evolclaw.json.agents`（基座配置）→ `defaults.json.baseagents`
- 旧 `evolclaw.json.channels` 字典中的具体 channel 配置要**拆分到对应 self-agent 的 `config.json.channels[]`**（见步骤 2），defaults.json 不持有 channels 字段
- 完成后删除旧 `data/evolclaw.json`

**2. `agents/<name>.json` → `agents/<aid>/config.json`**

每个旧的 `<name>.json` 对应一个 self agent。迁移步骤：
- 从 `<name>.json` 中读 `channels.aun.aid` 作为 self agent 的 AID
- 创建目录 `agents/<aid>/`
- 把原文件内容作为 `config.json` 写入，同时把 `channels` 块整理成新的 `channels[]` 列表形态（每个渠道实例带 `type` + `name`）
- 删除原 `<name>.json`

**3. `aids/{self,peers}/` → `agents/<aid>/{personal,relations}/`**

旧 `aids/` 目录之前主要停留在纸面 + 少量代码，没有大规模数据沉淀，可按新结构重建：
- `aids/self/<aid>.md` 中的内容并入对应 self agent 的 `agents/<aid>/personal/persona.md`
- `aids/peers/<aid>.md` 落到 `relations/aun#<aid>/profile.md`（所有对端统一用 `<channelType>#<urlEncode(channelId)>` 命名）
- 旧 `aids/` 目录删除

**4. 代码侧同步**

文档结构变更必须配套代码改动，主要涉及：

- `src/paths.ts`：
  - `readySignal`：`logs/ready.signal` → `data/instance/ready.signal`
  - `socket`（Unix）：`logs/evolclaw.sock` → `data/instance/evolclaw.sock`
  - 新增 `defaultsConfig` / `agentDir(aid)` / `agentConfig(aid)` / `agentPersonal(aid)` / `agentRelations(aid)` / `agentVenues(aid)` 等辅助路径
  - 移除已废弃的 `db`（sessions.db）、`config`（data/evolclaw.json）等条目
- `src/config.ts`：从单文件 `data/evolclaw.json` 加载切换为 `agents/defaults.json` + per-agent `config.json` 两层合并；timestamped backup 与新的双 rename 原子写并存
- `src/agents/`：扫描 `agents/<aid>/` 目录加载 self-agent 列表，按 AID 而非友好名定位
- `src/aid/`：废弃旧 `aids/` 读写逻辑，相关接口骨架等关系层实现时填充

### 暂不迁移

- **`data/sessions/`**：sessions 保留在 `data/sessions/<channelType>/...`。当前正在进行 SQLite → 文件系统的改造（详见 `docs/refactor/01-db-to-fs.md`），文件化完成后再考虑迁入 `agents/<aid>/sessions/`。目录结构统一为三层 `<channelType>/<selfAID>/<urlEncode(channelId)>/`，每个 chat 目录含 `active.json` + `meta_*.jsonl` + `task.lock` + `health.jsonl` + `_threads/` + `_index/` + `_trash/`。会话路由键定义见 `docs/通信路由体系.md`。

### 迁移工具

设想引入 `evolclaw migrate` CLI 命令完成上述迁移，迁移过程：
- pre-check：要求 evolclaw 进程未运行
- 备份：把 `~/.evolclaw/` 整体打包到 `~/.evolclaw.bak-{ts}.tar`
- 迁移：按上述步骤改名/搬运
- post-check：跑 `evolclaw status` 验证新结构能加载
- 失败回滚：恢复备份

迁移过程中遇到不在已知模式内的脏数据（无关文件、半残目录等）一律忽略，不阻断流程，也不主动清理——靠备份兜底。

### ECK 迁移步骤

1. 把现有 `$X/.claude/rules/01-07*.md` 内容迁移到 `$KITS_RULES/01-08*.md`（去掉 `aun-` 前缀，拆分索引机制为独立文件，重新编号）
2. 把现有 `$X/.claude/aun-docs/*.md` 迁移到 `$KITS_DOCS/` 对应子目录
3. 新建 `$KITS_RULES/02-registry.md`（路径注册表机制：语法、派生规则、寻找规则、按需加载时机）
4. 新建 `$KITS_RULES/03-index.md`（索引机制：怎么建、怎么查、何时触发更新，从原 01-entry.md 中拆出）
5. 更新 `$PERSONAL_DIR` 定义为 `$AGENT_DIR/personal`，`$PEER_DIR`（单数）定义为会话级动态注入；旧路径 `~/.evolclaw/aids/self` 和 `~/.evolclaw/aids/peers` 标记 deprecated
6. 将 `$X/.claude/rules/` 下的 ECK 文件（01-07*.md）和整个 `$X/.claude/aun-docs/` 移至 `$X/.claude/rules/_deprecated/`（暂不删除）
7. 创建 symlink：`$X/.claude/rules/eck/` → `$KITS_RULES/`
8. 验证 symlink 工作正常（base agent 能正确加载 rules/eck/ 下的文件）
9. 确认无误后删除 `$X/.claude/rules/_deprecated/`
10. 实现 `evolclaw link-rules` / `unlink-rules` CLI 命令
11. 删除 `syncKitsFromPackage()` 和 `$EVOLCLAW_HOME/kits/` 相关代码
12. 实现 `resolveEckInjection()`（baseagent 能力表 + symlink 检测）
13. 更新 `message-processor.ts` 的上下文注入逻辑（从 `$KITS_RULES/` 读取，含注入检测 + 运行时参数注入）
14. 实现 `atomicWriteSync()` 并替换所有 ECK 相关文件写入
15. 创建 `$KITS_DOCS/eck_templates/runtime.template.md` 和 `path-registry.template.md`
16. 创建 `$KITS_DOCS/path-registry.md`（路径定义文件，含所有预定义路径的派生规则或寻找规则）
17. 更新 `$PACKAGE_ROOT/docs/evolclaw-home-directory.md`（移除 kits/ 相关描述，加入 eck/ 和 agent index/ 描述）

## 待设计

以下机制已识别需要但暂不实现，留作后续设计：

### Schema Version 迁移机制

**问题**：`$ECK/runtime.md` 等实例文件在包升级后可能需要结构性变更（不只是 append-only）。当前设计只有"不覆盖"策略，无法处理 breaking change。

**方向**：
- 每个实例文件 frontmatter 带 `eck_schema` 版本号
- evolclaw 启动时比对包内模板声明的版本与实例版本
- minor 升级 → append-only 自动追加
- major 升级 → 执行迁移脚本链
- 迁移前自动备份

### 备份与恢复机制

**问题**：`$ECK/` 和 `$AGENT_INDEX/` 的文件可能因误操作或迁移失败需要恢复。

**方向**：
- `$EVOLCLAW_HOME/backups/` 目录
- schema 迁移前自动备份
- `evolclaw eck backup` / `evolclaw eck backup restore` CLI 命令
- 保留策略（FIFO，最多 N 个）
- `evolclaw eck reset` 重置为模板初始状态

## 附录：关键决策与澄清

本节记录设计讨论中澄清的关键决策点，避免后续重复讨论。

### EvolClaw 定位相关

| # | 澄清点 | 结论 |
|---|--------|------|
| 1 | **EvolClaw 不是 Agent Runtime** | 没有 evolclaw 之前 base agent 自己就是 runtime（Claude Code 跑在终端、Codex 跑在 IDE）。evolclaw 不替代 runtime，而是在 base agent 之上叠加通信和社会性 |
| 2 | **EvolClaw 的核心职责** | 把各个 base agent 接入 AUN（以及飞书等其它渠道），并以 AID 为锚点构建关系层和环境层 |
| 3 | **AUN Gateway 是唯一的网关** | AUN Gateway 是协议基础设施（路由/认证/投递）。EvolClaw 不是网关，是 channel/bridge + 身份与社会关系系统 |
| 4 | **前端不限于 Evol** | 前端可以是 Evol（App/Web/Desktop）也可以是其它 AUN 客户端，evolclaw 不绑定特定前端 |

### ECK 设计相关

| # | 澄清点 | 结论 |
|---|--------|------|
| 1 | **kits 不复制到 EVOLCLAW_HOME** | `$KITS/` 只存在于 `$PACKAGE_ROOT/` 内（代码仓或 npm 安装路径），运行时直接读取。不存在复制动作，`$EVOLCLAW_HOME/` 跟 kits 无关 |
| 2 | **唯一维护原则** | 只有一个维护的地方。`$KITS/` 是唯一源，`$ECK/` 是运行时配置实例 |
| 3 | **生命周期从本地变为随包发布** | ECK 的生命周期管理从"手动维护在 `$X/.claude/`"变成"随 npm 包发布和升级" |
| 4 | **symlink 到 rules/eck/ 子目录** | 开发时用 symlink/junction 把 `$X/.claude/rules/eck/` 指向 `$KITS_RULES/`。`rules/eck/` 由 ECK 全权管理，用户自定义 rules 放 `rules/` 根目录 |
| 5 | **重复加载用 baseagent 能力表 + symlink 检测** | 先查硬编码能力表判断 baseagent 是否有自动加载，再检测 symlink。检测结果作为运行时参数注入 |
| 6 | **rules 里的内容不全是 AUN** | 8 个 rules 文件是 ECK 的骨架，不只是 AUN 协议知识。所以 symlink 指向 `$KITS_RULES/` 而非某个 `aun/` 子目录 |
| 7 | **按加载方式分目录，不按知识域** | `$KITS/` 下分 rules/（自动加载）、docs/（按需加载 + 模板源 + evolclaw 级索引）、templates/（运行时组装） |
| 8 | **索引两层分离** | evolclaw 级索引在 `$KITS_DOCS/`（只读，开发时维护）；agent 级索引在 `$AGENT_INDEX/`（per-agent，可写）。天然无并发冲突 |
| 9 | **agent 级不需要路径注册表** | agent 只有两个根路径（`$CURRENT_PROJECT` 和 `$AGENT_DIR`），内部子路径直接使用，无需注册机制。evolclaw 级的路径注册表（定义在 `$KITS_DOCS/path-registry.md`，实例在 `$ECK/path-registry.md`）负责全局路径声明 |
| 10 | **运行时配置统一为 runtime.md** | 原 `base-paths.md` 扩展为 `runtime.md`，包含基础路径 + 身份参数 + 行为参数 + 通信参数。用户配置一次即可 |
| 11 | **Bootstrap 不循环** | `$EVOLCLAW_HOME` 由环境变量或硬编码默认值 `~/.evolclaw` 确定，不依赖任何文件 |
| 12 | **原子写入** | 所有 ECK 相关文件写入使用 write-tmp-then-rename 模式，避免进程中断导致文件损坏 |
| 13 | **ECK 命名确认** | 整套上下文机制叫 EvolClaw Context Kit，简称 ECK |
| 14 | **路径注册表三层结构** | 机制描述（`$KITS_RULES/02-registry.md`）+ 路径定义（`$KITS_DOCS/path-registry.md`，含派生规则或寻找规则）+ 路径实例（`$ECK/path-registry.md`，已解析真实值 + 用户自定义）。定义文件和实例文件均按需加载 |
| 15 | **不可直接派生路径的初始化** | 启动时检查实例中缺失的路径，按定义中的寻找规则搜索，找到后写入实例。典型场景：`@fastaun`（AUN SDK）、`@agentunion/kite`（Kite 框架）等外部依赖路径 |
| 16 | **`eck_injection_reason` 只有三个值** | `symlink-active` / `baseagent-no-autoload` / `symlink-not-found`，覆盖 `resolveEckInjection` 所有分支。不使用含糊的 `fallback`；未来如需新分支（如检测异常时保守注入），应使用具体名称如 `detection-error` |
| 17 | **`$ECK/path-registry.md` 按需加载** | 路径实例文件不自动加载到上下文，仅在 agent 需要解析某个 `$名称` 时按需 Read |
| 18 | **`$PEER_DIR` 单数语义** | 会话级动态注入，指向当前对端的单个关系目录（非集合）。路径为 `$RELATIONS_DIR/<channelType>#<urlEncode(channelId)>/`。遍历所有已知对端应直接遍历 `$RELATIONS_DIR/` 下的所有 `<channelType>#<urlEncode(channelId)>/` 目录 |
| 19 | **`resolveEckInjection` 调用时机** | agent 启动时针对其 `projectPath` 计算一次，以 `projectPath` 为 key 缓存于 agent 运行时上下文，后续消息处理不重复计算。不同 agent 的 `projectPath` 不同，缓存结果互不影响 |
| 20 | **单实例约束消除并发写** | evolclaw 在同一 `$EVOLCLAW_HOME` 下保证单实例运行（`data/instance/` 互斥机制），`$ECK/` 写入不存在多进程竞争，无需 lockfile |
| 21 | **symlink 检测遍历深度上限** | `detectEckSymlink` 向上遍历最多 5 层（`MAX_DEPTH = 5`），防御极端深层路径下的无意义遍历 |
| 22 | **模板占位符解析策略** | evolclaw 运行时在注入前完成占位符替换。若占位符未被替换（base agent 独立使用 ECK、无 evolclaw 动态注入），agent 应从 `$ECK/runtime.md` 读取对应参数值自行完成替换。不绑定具体 baseagent 类型 |
| 23 | **迁移安全策略** | 旧文件先 rename 到 `_deprecated/`，验证 symlink 工作正常后再删除，避免不可逆操作 |
| 24 | **迁移不需要设计回滚方案** | 迁移前由用户自行备份，文档无需描述回滚路径 |
| 25 | **templates/ 机制暂不展开** | 当前文档是新架构骨架，templates/ 的占位符语法和组合规则留待后续专项设计 |
| 26 | **runtime.md 与 path-registry.md 边界清晰** | 两者时机完全不同：runtime.md 是独立使用 ECK 时的 bootstrap 参数源（直接加载，一次性）；path-registry.md 是"需要某个路径但不知道真实值时"的按需查询。不存在边界模糊问题 |
| 27 | **单实例假设不需要额外防御** | 多实例是 bug，必须在 `data/instance/` 互斥机制层面修复，不在 ECK 写入层面做防御性设计 |
| 28 | **detectEckSymlink 遍历深度 MAX_DEPTH=5 是设计值** | 5 层足够覆盖实际项目结构，无需动态调整或额外说明 |

### EVOLCLAW_HOME 与运行时相关

| # | 澄清点 | 结论 |
|---|--------|------|
| 1 | **sessions 暂留 `$EVOLCLAW_HOME/data/sessions/`** | 当前正在做 SQLite → 文件系统改造，文件化完成后再考虑迁入 `$AGENTS_DIR/<aid>/sessions/`。会话路由键定义见 `docs/通信路由体系.md` |
| 2 | **`$EVOLCLAW_HOME/` 不含 kits/** | kits 属于包（代码），不属于用户数据。`$EVOLCLAW_HOME/` 只存 `agents/`、`data/`、`logs/`、`eck/` |
| 3 | **`$ECK/` 存全局运行时配置** | runtime.md + path-registry.md，首次启动从模板初始化，后续用户可自由修改 |
| 4 | **`$AGENT_INDEX/` 存 agent 级索引** | 每个 agent 在 `$AGENT_DIR/index/` 下维护自己的 INDEX.md 和 GUIDE.md |
| 5 | **`$PERSONAL_DIR` / `$PEER_DIR` 迁移** | 旧路径 `~/.evolclaw/aids/self` 和 `~/.evolclaw/aids/peers` 在迁移完成后废弃。`$PERSONAL_DIR` 由 `$AGENT_DIR/personal` 取代；`$PEER_DIR`（单数，会话级动态注入，指向当前对端单个关系目录 `$RELATIONS_DIR/<channelType>#<urlEncode(channelId)>/`）取代旧 `$PEERS_DIR`（复数集合目录）。遍历所有已知对端应直接遍历 `$RELATIONS_DIR/` 下的所有 `<channelType>#<urlEncode(channelId)>/` 目录 |
| 6 | **`agent.md` 的对外服务由 AUN 提供** | `https://<aid>/agent.md` 的 HTTP serve 是 AUN 网络的服务，不是 evolclaw 实现。evolclaw 不实现 nameservice 端点，也不维护本地副本——它只通过 AUN SDK 读写 `~/.aun/AIDs/<aid>/agent.md`，其它由 AUN 网络保障 |
| 7 | **`personal/` 边界** | 人格、记忆、风格、偏好、技能、self_summary 配置都属于个人数据层：都是需要按需载入上下文的内容，都是 agent 自己可改的内容。因此不再讨论"是否应该按数据性质拆分到不同目录"——保留单层 `personal/` 设计 |
| 8 | **`enabled: false` 语义** | 启动时不加载该 agent，不清理任何数据。data/outbox 中的离线消息按既有 TTL 规则自然过期，不做特殊处理；该 agent 的 AID 不上 AUN 网络，所以也不存在 AID 占用问题 |
| 9 | **`kits/` 生命周期** | `kits/` 不在 `$EVOLCLAW_HOME` 内，属于 evolclaw 包代码（`$PACKAGE_ROOT/kits/`）。包升级即 kits 升级，不存在复制动作 |
| 10 | **多进程并发** | `data/instance/` 已通过 `(startedAt, pid)` 仲裁选赢家。`data/outbox/`、`data/sessions/` 由赢家独占写，不存在并发写入风险。因此不需要额外的"多进程共享语义"设计 |
| 11 | **文档范围** | 本文档只描述目录结构和文件用途。详细列表见下文"不在本文档范围"节 |
| 12 | **迁移工具对脏数据** | `evolclaw migrate` 遇到不在已知模式内的脏数据（`新建 文本文档.txt`、半残目录等）一律忽略，不阻断流程也不主动清理。备份是 `~/.evolclaw.bak-{ts}.tar` 整体打包，靠备份兜底回滚 |
| 13 | **环境变量解析** | `"$ENV:VAR_NAME"` 在配置加载时展开。未设置环境变量时：打印 warning 提示，字段值视为空，运行时真正用到该字段时才报错。这样既能尽早暴露漏配，又不会因为某个无关字段缺凭证而阻止启动 |
| 14 | **暂不处理的项** | `schema-1.json` 的生成与校验流程（等设计稳定后再说）；顶级 `data/` 命名退化（sessions 暂留，后续迁入 per-agent 目录）；跨平台 socket / pipe hash 长度（以代码为准）；`config.json` 字段表的进一步扩展（当前字段集冻结，新增需走单独提案） |
| 15 | **配置字段归属** | `channels` 不进 `defaults.json`（各 self-agent 的接入凭证差异大，无共享意义）；`admins` 可以进 `defaults.json`（数组合并去重）；`owners` 不进 `defaults.json`（必须 per-agent，允许为空）；channel 实例的 `owners`/`admins` 用该 channel 的原生 ID（飞书 user_id、钉钉 unionId 等，不强制 AID）；顶层 `owners` 元素仍是 AID |
| 16 | **缓存语义** | `agents/<aid>/data/cache/` 用于本地副本（对端 agent.md 的拉取缓存、自己 agent.md 的本地副本）。权威位置永远在 `~/.aun/AIDs/<aid>/`——修改和提交只通过 AUN SDK 走该路径，cache 是只读副本，可随时清理重建 |
| 17 | **关系层目录形态本轮只定布局** | 所有对端档案统一使用 `<channelType>#<urlEncode(channelId)>/` 命名（不再分 contacts/_observed）。`_index/name_*.json` 提供 name 反查；`_trash/` 的恢复语义、merge/split 等运行时规则在关系层实现时再敲定 |

### 与 `identity-layer-design.md` 的关系

`identity-layer-design.md` 是更早的祖文档，本文档是基于它演化后的最新方案。**两份文档不一致时一律以本文档为准**——差异是演进，不是冲突。下面这些点是相对祖文档的明确演进：

- **proxied-aids 注册表已删除**：channel 不要求必须有 AID，AUN 渠道的对端自带 AID，非 AUN 渠道的对端可省略 `aid` 字段。祖文档 §5.5 的 `~/.evolclaw/proxied-aids/` 整个目录及其密钥托管设计不再适用。
- **`self/` 子层不存在**：`personal/` 已涵盖人格、记忆等内在状态。对外名片由 AUN 维护的 `~/.aun/AIDs/<aid>/agent.md` 唯一持有，evolclaw 不维护 `card.md` 副本。祖文档中 `agents/<aid>/self/persona.md` + `self/card.md` 的两文件结构作废。
- **`personal/self_summary.json` 与祖文档 §9.8 的 `config.json.self_summary` 含义不同**：前者是**策略配置**（频率、预算、skip_targets），后者是别的概念，**不是冲突**。
- **群是 venue 不是 identity**：祖文档已表达，本文档延续。
- **不引入跨 agent 共享认知层**：祖文档已表达，本文档延续。

### 不在本文档范围

- 系统详细设计（IPC 协议细节、消息格式、状态机）
- 运行时清理时机（restart-pending 谁删、log 怎么轮转的实现细节）
- 跨平台启动竞争行为
- log 拆分策略（per-agent vs 全局）、`logs/` 下各日志文件的启用开关与写入方
- 关系层的运行时规则（promote / merge / split / \_trash 的具体行为）

这些细节以代码为准，或在专门的设计文档中描述。
