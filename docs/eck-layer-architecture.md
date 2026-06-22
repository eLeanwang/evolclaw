# ECK 分层架构设计

本文档整理 ECK 的分层架构认知，作为 rules 文档设计的基础。

参考文档：`docs/evolclaw-directory-design.md`（目录结构与 ECK 分发设计的唯一事实源，涉及大量概念定义需到该文档查询）。

## ECK 的本质

ECK 不是一个扁平的知识包，而是一个**分层的上下文组装系统**。evolclaw 在收到消息后，根据当前场景，从各层提取信息、注入参数、组装上下文，最终交给 base agent。

## 核心概念关系

- **AUN** 是通信基础设施（网络），给予每个 AUN 主体身份标识（AID），让主体之间以 P2P、Group 方式通信
- **渠道（Channel）** 是能收发消息的通信方式。渠道两端是两个主体。一个主体给另一个主体发消息时可以选择不同的渠道，选择权在主体自身。同一环境下通常延用同一渠道，但不强制
- **Evol** 是 AUN 原生的 channel（与飞书/微信/钉钉同级）
- **飞书/微信/钉钉** 等渠道的对端也是主体，只是不是 AUN 网络上的主体。但他们可以通过 evolclaw 上的 agent 与 AUN 网络的其他主体完成通信
- **EvolClaw** 是 agent 网关——Evol 通过 AUN 接入 EvolClaw，其它 channel 通过各自的方式接入

## 四层架构

### 身份层 — "我是谁"

解决的问题：当前 agent 的一切自我认知。

包含信息：
- 我的 AID、名字
- 我的人格（persona.md）
- 我的风格（style.md）
- 我的记忆（memory/：episodic、semantic、working）
- 我的技能（skills/）
- 我的偏好（preferences.json）
- 我的目标（goals.md）
- 我的反思日志（journal.jsonl）

数据位置：`$SELF_DIR`（`$AGENT_DIR/personal/`）

引用的动态参数：`$SELF_AID`、`$SELF_NAME`

### 关系层 — "跟我聊天的是谁"

解决的问题：对端是谁，我跟他的关系如何。

包含信息：
- 单聊：对端的 profile.md（身份、关系评注、交互历史）
- 群聊：群的信息（自然包含群内相关人的信息）
- contacts/（已直接交互）vs _observed/（仅旁观）

数据位置：`$RELATIONS_DIR`（`$AGENT_DIR/relations/`）

引用的动态参数：`$PEER_AID`、`$GROUP_ID`、`$PEER_DIR`

### 环境层 — "我在什么场景下"

解决的问题：不同场景需要不同的信息。

场景类型：
- **编程场景（coding）**：不加载身份层和关系层，纯本地模式
- **单聊场景（private）**：加载身份层 + 关系层（对端）+ 环境层
- **群聊场景（group）**：加载身份层 + 关系层（群）+ 环境层

包含信息：
- venue 的 profile.md（定位、文化、policy）
- venue 的历史事件

数据位置：`$VENUES_DIR`（`$AGENT_DIR/venues/`）

引用的动态参数：`$SCENE`、`$VENUE_UID`

### 渠道层 — "我通过什么通信"

解决的问题：不同通信渠道有不同的通信方式、消息格式、能力限制。

渠道类型：
- **Evol**（AUN 原生 channel）
- **飞书**
- **微信**
- **钉钉**
- ...

不同渠道通过不同的命令行工具完成通信，每个渠道有各自的命令工具使用文档。

包含信息：
- 当前渠道的命令行工具使用方式
- 当前渠道的消息格式规则
- 当前渠道的能力限制
- 当前渠道特有的交互规范

引用的动态参数：`$CHANNEL_TYPE`

## ECK 体系的三部分

1. **自动载入** — rules 文件（全量加载到每个会话）
2. **按需载入** — docs 文件（通过索引定位，需要时才读取）
3. **动态注入** — evolclaw 代码在上下文组装时注入参数和文件

## 动态参数注入机制

动态注入是 evolclaw 上下文组装机制的一部分，**不属于 rules**。但 rules 文档中会引用这些动态注入的参数。

evolclaw 在上下文组装时，会将这些参数作为结构化信息注入到会话上下文中。

### 参数清单

| 参数名 | 所属层 | 含义 | 示例值 |
|--------|--------|------|--------|
| `$SELF_AID` | 身份层 | 当前 agent 的 AID | `alice.aid.pub` |
| `$SELF_NAME` | 身份层 | 当前 agent 的显示名 | `Alice` |
| `$PEER_AID` | 关系层 | 对端 AID（单聊） | `bob.aid.pub` |
| `$GROUP_ID` | 关系层 | 群组 ID（群聊） | `team-alpha.group.company.com` |
| `$PEER_DIR` | 关系层 | 当前对端的关系目录 | `$RELATIONS_DIR/contacts/bob.aid.pub/` |
| `$SCENE` | 环境层 | 当前场景类型 | `coding` / `private` / `group` |
| `$VENUE_UID` | 环境层 | venue 唯一标识 | `private:alice.aid.pub:bob.aid.pub` |
| `$CHANNEL_TYPE` | 渠道层 | 当前渠道类型 | `evol` / `feishu` / `wechat` / `dingtalk` |
| `$ECK_INJECTION` | 全局 | ECK 注入方式 | `evolclaw` / `standalone` |
| `$ECK_INJECTION_REASON` | 全局 | 注入原因说明 | 描述文本 |

### 注入方式

- **通过 evolclaw 启动**：evolclaw 代码在组装上下文时，将这些参数作为结构化信息注入
- **独立使用 base agent**：参数从 `$ECK/runtime.md` 读取（Bootstrap 模式）

### rules 文档中的引用

rules 文档中引用这些参数时，使用 `$参数名` 格式（如 `$SELF_AID`）。agent 在阅读 rules 时，这些引用会被理解为"当前会话中 evolclaw 注入的对应参数值"。

每一层的信息分三类：

| 类型 | 说明 | 加载方式 |
|------|------|----------|
| 自动带上 | 每个会话都需要的基础信息 | rules 文件（全量加载） |
| 按需加载 | 需要时才读取的详细信息 | docs 文件（通过索引定位） |
| 动态注入 | 运行时才确定的参数和文件 | evolclaw 代码注入 |

## 上下文组装流程

```
evolclaw 收到消息
  → 确定渠道（哪个 channel 来的）
  → 确定场景（coding / private / group）
  → 确定身份（当前 self agent 的 AID）
  → 确定对端（单聊：对端 AID；群聊：group ID）
  → 按场景决定加载哪些层：
      coding：仅 rules（不加载身份层、关系层）
      private：rules + 身份层 + 关系层（对端）+ 环境层 + 渠道层
      group：rules + 身份层 + 关系层（群）+ 环境层 + 渠道层
  → 动态注入各层参数
  → 自动载入各层对应的文件
  → 组装完成，交给 base agent
```

## 对 rules 文档设计的影响

rules 文件是**自动载入部分**，它需要做到：

1. 让 agent 理解四层架构本身（每层是什么、解决什么问题）
2. 告诉 agent 每层的数据在哪（路径）、会引用哪些动态参数
3. 告诉 agent 如何按需加载（路径注册表、索引机制）
4. 告诉 agent 在各场景下怎么行动（行为规则）
5. 告诉 agent 怎么通信（CLI 命令入口）

rules 不需要做的：
- 不讲动态注入机制本身（那是 evolclaw 代码的事，在 docs 中论述）
- 不需要包含各层的详细规则（那是按需载入的 docs）
- 不需要包含配置体系的合并规则（那是 evolclaw 代码的事）
- 不需要包含目录结构的完整树（那是设计文档的事）

## rules 文档结构方案

```
rules2/
├── 01-overview.md        ← 总览：前置概念 + ECK 是什么
│     § Base Agent
│     § AUN 是什么（AID、agent.md、网关、核心服务、自主模式、架构图）
│     § EvolClaw 是什么（Evol、Channel）
│     § ECK 是什么
│       - 定义：分层的上下文组装系统
│       - 四层架构简述（每层一句话 + 解决什么问题）
│       - 上下文组装流程（coding / private / group 加载哪些层）
│     § 术语
│
├── 02-identity.md        ← 身份层：我是谁
│     § 引用的动态参数：$SELF_AID、$SELF_NAME
│     § 数据位置与结构（$SELF_DIR 及其子目录）
│     § 行为规范加载
│
├── 03-relation.md        ← 关系层：跟我聊天的是谁
│     § 引用的动态参数：$PEER_AID、$GROUP_ID、$PEER_DIR
│     § 数据位置与结构（$RELATIONS_DIR 及其子目录）
│     § 对端身份与权限
│
├── 04-venue.md           ← 环境层：我在什么场景下
│     § 引用的动态参数：$SCENE、$VENUE_UID
│     § 场景判定（coding / private / group）
│     § 数据位置与结构（$VENUES_DIR 及其子目录）
│
├── 05-channel.md         ← 渠道层：我通过什么通信
│     § 引用的动态参数：$CHANNEL_TYPE
│     § 通信规则
│     § 命令入口（agent 管理、消息命令、各渠道工具文档）
│
├── 06-navigation.md      ← 导航：我的数据在哪、怎么找
│     § 路径体系（三个基础路径、派生路径表）
│     § 路径注册表机制（三层结构、按需加载时机）
│     § 索引机制（两层索引、怎么查）
```

## 待讨论

1. rules 文件按什么维度拆分？按层拆（每层一个文件）还是按功能拆（认知/导航/命令）？
2. 动态注入参数的模板放在哪里？（`$KITS_TEMPLATES/` 已有设计）
3. 渠道层的信息具体有哪些？（各渠道的规则差异大，是否每个渠道一个 docs 文件？）
4. 编程场景（coding）下 rules 全量加载但身份层不加载——这个"不加载"是 evolclaw 不注入，还是 agent 自己忽略？
