# EvolClaw 身份层与上下文层设计

> 状态：草案 v0.7 — 用于讨论
> 范围：定义 evolclaw 应用层的**身份层（Identity）**、**环境层（Venue）**、**个人数据层（Personal）**，以及会话上下文的组装与注入机制；不涉及 AUN 协议层 AID/PKI（那是基础设施）
> 范围演进：v0.1-0.2 仅身份层；v0.3 起扩展为完整的认知与上下文层设计——身份只是其中一个维度

## 1. 背景与动机

### 1.1 当前现状

evolclaw 现有的"身份"概念只到**会话权限角色**：

- `SessionIdentity = { role: 'owner' | 'admin' | 'guest' | 'anonymous', mode }`
- 由 `ownerResolver(channel, userId)` / `adminResolver(channel, userId)` 在每次消息进来时实时计算
- 不持久化，不跨会话
- 不知道"对端是谁"，只知道"对端是不是 owner"

这层只能回答"这个人能不能用某个命令"，无法回答：

- 这个 AUN AID 是谁？以前在飞书上跟我聊过吗？
- 这条飞书消息的发送者，跟昨天发邮件的是同一个人吗？
- 这个群里被 @ 的人，agent 应该用什么称呼回复？

### 1.2 两个驱动场景

**场景 A：单机多 agent，远端跨渠道找上来**

一台机器上跑着多个 agent（用 AID 区分）。远端的人可以从 AUN、飞书、企微、邮件等不同 channel 联系不同 agent。每个 agent 需要知道"跟我说话的这些 channel 标识背后是同一个人吗？这个人对我而言是谁？"

**场景 B：企业内部多 agent + 多群 + 跨团队**

企业里几十个人各自跑 agent，建多个群，每个群里有不同团队成员。但企业部署一般会跨多台机器（不会把 100 个 agent 塞在一台机器上），即便单机也只是企业的一个分片。所以指望"单机事实层"实现企业级共享认知是鸡肋——事实层早就被分片切碎了。

evolclaw 的取舍：**不引入跨 agent 的事实层共享**。每个 agent 在自己的机器上、自己的目录里独立维护对外认知。如果未来确实需要跨 agent / 跨机的身份共享，那是更高一层的服务（类似 AUN nameservice 的角色），不属于身份层本体。

后果：
- 同一员工被 N 个 agent 各自识别 N 次——可接受，agent 的关系认知本来就是 per-agent 的，识别成本属于 agent 的"工作"
- 员工换号需要 N 个 agent 各自更新——靠 §9 的自我总结机制 + AUN agent.md 拉取等手段在 per-agent 层面解决

### 1.3 设计目标

1. 让 agent 跨会话、跨 channel 维持对人/群/其它 agent 的认知
2. 把现有 `SessionIdentity` 角色判定升级为基于身份的判定，去除"对端 ID 即可信"的隐患
3. 兼容 AUN 协议——AID 是身份的最高可信渠道，但不是唯一渠道
4. 让 agent 像 social peer 一样维护通讯录，而不是只持有一张 ACL 表
5. 提供 agent 自我总结机制，让身份/环境/个人数据层随交互自动演进

### 1.4 非目标

- 不重新发明 AUN 的 AID/PKI——那是协议层，身份层在其上
- 不做企业级身份治理（SSO/SAML/LDAP 接入是 Auth 层的事，不是身份层）
- evolclaw 是 single-tenant 还是 multi-tenant 的网关：本文档当前假设单机部署 + per-agent 独立认知，企业级共享留给上层服务

### 1.5 evolclaw 的 AUN-native 架构前提

evolclaw 是 Evol 各前端（App、桌面版、网页版、云端版）的网关，前端通过 **AUN SDK** 与 evolclaw 通信。这决定了几个关于身份层的硬约束：

- **每个 self agent 必须有 AID**：evolclaw 运行的每个 agent 在 AUN 网络上以 AID 出现，没有 AID 就没法跟 Evol 前端通信
- **每个对端身份也必须有 AID**：身份层强制以 AID 作为 canonical key。来自 AUN 的对端自带 AID；来自飞书/企微/邮件等 channel 的对端，由 evolclaw 网关代为申请托管 AID（见 §5.5）
- **权限最终基于 AID 判定**：owner / admin 等特权角色由 AID 锚定，且只能授予 `aid_origin: self_held` 的身份（见 §4.4）
- **大部分真实用户带 self_held AID**：使用 Evol 前端的人都是 AID 持有者（Evol App 内置 AUN SDK），所以 evolclaw 视角下，"对端是 Evol 用户" ≈ "对端有 self_held AID"
- **非 AUN 渠道的对端走 proxied AID**：飞书联系人、邮件发件人等没有自己的 AID，evolclaw 给他们代申请并托管，这些 AID 只在本 evolclaw 域内有效

这些前提决定了 §2 关于 AID 在身份层的"特殊地位"，以及 §4.4 / §5.5 关于权限和 AID 申请流程的设计。

### 1.6 三维正交分解：Self / Principal / Venue

设计身份层之前需要先明确：agent 在每次对话中需要感知**三个正交维度**：

| 维度 | 回答的问题 | 数据归属 | 生命周期 |
|---|---|---|---|
| **Self** | 我是谁？我的人格/能力/owners 是什么？ | agent 自身配置 | 长期，跟随 agent 实例 |
| **Principal** | 是谁在跟我说话？我跟他什么关系？ | 身份层 | 长期，跨会话累积 |
| **Venue** | 这次说话发生在什么环境？ | 环境层 | 中期，按场景边界 |

**关键观察**：「群里小王 @ 我」和「小王私聊我」——Principal 都是同一个小王，Venue 不同。把这两个维度融合会带来后患：

- 同一个人在不同群里被建档多次，关系认知碎片化
- 跟小王的私下交情记忆不能用在群里识别他
- 权限决策错位——owner 关系绑在人（Principal）上，不绑在群（Venue）上
- 群解散后跟成员的关系全丢

evolclaw 的认知层据此切分为三层独立存储：

```
agents/<aid>/
├── config.json           ← Self（agent 基础配置）
├── self/                 ← Self 人格与对外名片
├── identities/           ← Principal（认识的人/agent）
├── venues/               ← Venue（参与的群/私聊场景）
└── personal/             ← 自己的记忆/风格/偏好
```

每条入站消息携带 (Principal, Venue) 二元组，身份层只解析 Principal、环境层只解析 Venue，互不干扰。详细机制见 §4 §6 §8。

## 2. 核心概念

### 2.1 身份（Identity）

身份是 evolclaw 中所有"参与者"的统一抽象。每个身份由两个独立维度刻画：

| 维度 | 字段 | 取值 | 含义 |
|---|---|---|---|
| **本体类型** | `type` | `person` / `agent` | 这个身份是什么 |
| **对当前 self 的角色** | `roles_for_self` | `[]` / `[owner]` / `[admin]` | 它对我意味着什么 |

把这两件事拆开很重要：type 是稳定的（一个 agent 不会变成 person），roles_for_self 是动态的（owner 解约了仍然是同一个人）。

**强制 AID canonical key**：每个 identity 都有 AID。AID 是身份层的根锚点：

- 来自 AUN 的对端 → 自带 `self_held` AID
- 来自飞书/企微/邮件等渠道的对端 → evolclaw 网关代为申请 `proxied` AID

每个 identity 还有 **primary_channel**——标记真正收发消息走哪个渠道，跟 AID 解耦。`type=agent` 的对端通常走 AUN；非 AUN 渠道的 person 联系人 primary_channel 是该渠道（如 feishu），即使有 proxied AID 也不通过 AUN 通信。

```
身份 (Identity)
├── type: person | agent              ← 本体类型
├── aid: <AID>                        ← canonical key（必有）
├── aid_origin: self_held | proxied   ← AID 来源
├── primary_channel: aun | feishu...  ← 实际收发渠道
├── channels: { aun, feishu, ... }    ← 所有关联渠道 ID
├── roles_for_self: [...]             ← 对当前 self agent 的角色
├── owner: <aid>                      ← 仅 type=agent，指向所属人
├── agents: [<aid>, ...]              ← 仅 type=person，指向他拥有的 agent
└── verified_channels: [...]          ← 哪些 channel 关联认证过
```

**self_held vs proxied**：

| | self_held | proxied |
|---|---|---|
| 私钥所在 | 对方自己的设备 | evolclaw 网关本地（加密存储） |
| 来源 | 对方自己注册的 AID | evolclaw 通过 AUN custody 代申请 |
| 适用对象 | AUN 用户（含 person 和 agent）、其它 evolclaw 实例上的 agent | 飞书/企微/邮件等非 AUN 渠道的对端 |
| 信任根 | 对方私钥控制 | 网关密钥保管 |
| 可持有 owner/admin 权限 | ✅ | ❌ |

**person 与 agent 的双向关联**：

`type=person` 的 identity 可以有 `agents: [aid, ...]` 列表，指向他拥有的 agent；`type=agent` 的 identity 必须有 `owner: <aid>` 字段，指向所属人（也是 AID）。

合并永远在同 type 之间——person 不能合并 agent，agent 不能合并 person。跨 type 的关联通过 owner / agents 字段表达。

### 2.2 Principal 与 Venue 的正交分解

**Principal（主体）**：身份层装 Principal——人和其它 agent。回答"是谁"。

**Venue（环境）**：环境层装 Venue——一次对话发生的场景，含群、私聊、广播频道。回答"在哪"。

**关键设计：群是 Venue，不是 Identity**

- 「项目 X 群」作为对话场景的存在 = Venue（venues/项目X讨论群/，profile.md 描述群定位、文化、policy）
- 「小王今天在飞书 chat_xyz 里发的这条消息」 = 一次 Venue 内的事件
- 群成员是 Identity（type=person 或 type=agent），跟群本身**不是包含关系**——群是容器，成员是参与者，两者独立建档

群的成员名单是动态的，**不写入 Venue profile.md**。"谁在这个群里"是会话历史里捞出来的瞬时事实，不是 Venue 的固化属性。

**入站事件携带 (Principal, Venue) 二元组**

每条入站事件进入 evolclaw 时由 channel adapter 提取。事件分两种粒度——**单条事件**（私聊或群里 @ self 时触发）和**群批次事件**（群里没 @ self 时按窗口积累）：

```typescript
// 单条事件——私聊每条消息 / 群里 @ self 触发立即推送
interface SingleMessageEvent {
  kind: 'single';
  principal: {
    channel: string;
    channel_id: string;
    declared_name?: string;
  };
  venue: {
    kind: 'private' | 'group' | 'broadcast';
    channel: string;
    venue_id: string;
  };
  message: {
    id: string;                     // channel 内消息 ID（用于回复定位）
    content: string;
    mentions?: string[];            // @ 命中的 channel_id 列表
    reply_to?: string;              // 此条是回复哪条消息（如有）
    timestamp: number;
  };
}

// 群批次事件——群里没 @ self 时按窗口（如 30s 或 N 条）积累后推送
interface GroupBatchEvent {
  kind: 'batch';
  venue: {
    kind: 'group';
    channel: string;
    venue_id: string;
  };
  messages: Array<{
    principal: { channel: string; channel_id: string; declared_name?: string };
    message: { id: string; content: string; mentions?: string[]; reply_to?: string; timestamp: number };
  }>;
  window: { start: number; end: number; reason: 'time' | 'count' | 'mention-flush' };
}

type InboundMessage = SingleMessageEvent | GroupBatchEvent;
```

**Channel adapter 的 flush 规则**：

- 私聊消息 → 立即作为 `SingleMessageEvent` 推送
- 群消息 + @ 命中 self（mentions 含 self.aid 或 self.declared_name）→ 立即推送 `SingleMessageEvent`，同时 flush 当前窗口里积累的群消息为 `GroupBatchEvent`（reason=mention-flush）
- 群消息 + 命令前缀（content 以 `/` 开头）+ 发送方为 self 的 owner/admin → 同 @ 处理（reason=command-flush），保证特权命令不会被批次延迟
- 群消息 + 未 @ self + 非命令 → 进入窗口积累，到时间/条数阈值时 flush 为 `GroupBatchEvent`
- agent 主动出站发言 → 该 venue 的窗口立即 flush（避免 agent 的回复跟随后续批次乱序）

私聊时 `principal.channel_id == venue.venue_id`（"跟谁说话"和"在哪说话"重合），但**结构上仍然分两个字段**——上层代码不需要分支处理。

**身份解析与环境解析互不依赖**

```typescript
// 单条事件
const speaker = identityLayer.resolve(event.principal);
const venue   = venueLayer.resolve(event.venue);

// 批次事件——venue 解析一次，每条消息分别解析 speaker
const venue = venueLayer.resolve(event.venue);
const speakers = event.messages.map(m => identityLayer.resolve(m.principal));
```

权限判定只看 Principal，不看 Venue。但 Venue 影响命令的可见性和默认行为（群里的 `/restart` 一般要求 @ agent 才执行；私聊里直接执行）——这是会话层根据 Venue 决定的，不是身份层的事。

### 2.3 三层认知架构

evolclaw 的认知数据分为三层独立存储：

| 层 | 内容 | 关键问题 |
|---|---|---|
| **身份层**（Identity） | Principal 认知（人、群、其它 agent） | 是谁在跟我说话？我跟他什么关系？ |
| **环境层**（Venue） | Venue 认知（参与的群、私聊场景、广播频道） | 这次对话发生在什么场景？这个场景什么文化？ |
| **个人数据层**（Personal） | agent 自己的记忆、风格、偏好、技能 | 我自己是什么样的？我在干什么？ |

三层全部 per-agent 私有，挂在 `agents/<aid>/` 下。各 agent 独立维护自己的认知，互不共享。

三层的演进通过两种方式：
- 实时写入：消息处理过程中工具/LLM 直接写（如新建 unidentified 身份、记录 interaction）
- 自我总结：evolclaw 触发 agent 周期性自省，整理沉淀（见 §9）

### 2.4 自我（Self）vs 对端（Peer）

| 类型 | 存放位置 | 内容 |
|---|---|---|
| Self（agent 自己） | `agents/<aid>/config.json` + `agents/<aid>/self/` + `agents/<aid>/personal/` | 配置、人格、行为规范、owners 列表、对外名片、记忆 |
| Peer（其它身份） | `agents/<aid>/identities/` | 对方画像、跨渠道映射、互动历史 |

身份层只在 per-agent 范围内存在——**没有跨 agent 的共享事实层**。每个 agent 在自己的目录里独立认识世界。

Self 不在 identities/ 里再造一份。AUN Context Kit 当前的 `$SELF_DIR/<aid>.md` 是身份层尚未建立时的临时方案，待本设计落地后会迁移到 `agents/<aid>/config.json` + `agents/<aid>/self/` + `agents/<aid>/personal/`，AUN Context Kit 同步调整。

## 3. 数据模型与目录结构

### 3.1 总体布局

evolclaw 的数据按"作用域"分层：部署级共享资源（kits + 全局运行时）+ 网关级 AID 注册表（proxied-aids）+ per-agent 数据（agents/&lt;aid&gt;/）。

```
~/.evolclaw/
│
├── kits/                                    ← 部署级：共享上下文资源（提示词、模板、手册）
│   │                                          所有 self agent 共享，加载机制见 §8
│   │
│   ├── aun/                                   AUN Context Kit — AUN 协议使用知识
│   │   ├── role.md                              不同对端身份/场景下的行为规则
│   │   ├── meta.md                              AUN 最小认知包
│   │   ├── path.md                              路径注册表
│   │   └── ...
│   │
│   ├── channels/                              各 channel 接入知识（按 channel 名分文件）
│   │   ├── aun.md                               AUN 通信约定（必加，所有 self agent 都通过 AUN 跟前端通信）
│   │   ├── feishu.md                            飞书的消息类型、文件协议、@ 语法
│   │   ├── wechat.md                            微信的消息类型与限制
│   │   └── ...                                  消息进来时按 InboundMessage.principal.channel 决定加载哪份
│   │
│   ├── evolclaw/                              EvolClaw 网关使用知识
│   │   ├── commands.md                          可用命令清单
│   │   ├── tools.md                             可用工具清单
│   │   ├── self-summary.md                      自我总结流程指南（§9）
│   │   └── identity-tools.md                    身份/环境层的工具用法（identity.identify / merge 等）
│   │
│   └── templates/                             prompt 模板（§8 上下文组装的输入）
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
├── proxied-aids/                            ← 网关级：proxied AID 注册表
│   │                                          为非 AUN 渠道的对端代申请的 AID（§5.5）
│   │                                          所有 self agent 共享同一份 channel_id → AID 映射
│   │                                          认知信息不在这里（在各 self agent 的 identities/ 下）
│   │
│   ├── _index/                                channel_id → AID 反查
│   │   ├── feishu_ou_zhang.json                 { aid, channel, channel_id, primary_channel, created_at }
│   │   ├── wechat_xxx.json
│   │   ├── email_zhang_at_example.com.json
│   │   └── ...
│   │
│   └── <aid>/                                 一 AID 一目录，目录名是 AID 本体
│       ├── meta.json                            { primary_channel, channels: {...}, created_at, status, deprecated? }
│       ├── cert.pem                             AUN 证书（公开）
│       └── key.pem.enc                          私钥（AES-256-GCM 加密；密钥见 §5.5）
│
├── agents/                                  ← per-agent 数据根目录
│   │                                          每个 self agent 一个子目录，目录名是 agent 自己的 AID
│   │
│   └── <self-aid>/                          ← 例如 secretary.agentid.pub/
│       │
│       ├── config.json                        agent 基础配置（原 agents/<name>.json 的内容）
│       │                                        - aid: 自己的 AID
│       │                                        - display_name: 友好名（用于 CLI 展示）
│       │                                        - owners: [aid, ...] —— owner AID 列表（§4.4）
│       │                                        - admins: [aid, ...]
│       │                                        - channels: 启用的 channel 配置
│       │                                        - chatmode: { private, group } 行为模式
│       │                                        - self_summary: 自我总结配置（§9.8）
│       │
│       ├── self/                              ← Self 维度：人格与对外面
│       │   ├── persona.md                       内部自述（行为规范、心理独白、身份认知）
│       │   │                                    给 LLM 看，不对外暴露
│       │   └── card.md                          对外名片，对应 https://<self-aid>/agent.md
│       │                                        evolclaw 的 nameservice 端点直接 serve 这个文件
│       │
│       ├── identities/                        ← 身份层：Principal 认知（§4）
│       │   │                                    每条记录都有 AID（self_held 或 proxied）
│       │   │
│       │   ├── _index/                          AID → 目录名 反查
│       │   │   ├── aid_<aid>.json                 { identity: <name>, type, added_at }
│       │   │   └── ...
│       │   │
│       │   ├── <name>/                          顶层身份（已直接交互过的"通讯录"）
│       │   │   │                                 目录名是人类可读名（如 "王老板"、"王秘书"）
│       │   │   ├── profile.md                     frontmatter（aid/type/owner/agents/...）+ 关系正文
│       │   │   └── history.jsonl                  身份演化事件流（§3.5）
│       │   │
│       │   ├── _observed/                       旁观档案（只在群里见过，未直接交互）
│       │   │   │                                 极简档案，不维护关系评注
│       │   │   ├── _index/
│       │   │   └── aid_<aid>/                     目录名直接用 AID
│       │   │       ├── profile.md                   极简 frontmatter，正文留空
│       │   │       └── history.jsonl
│       │   │
│       │   └── _trash/                          merged / split 后的重定向占位
│       │       └── <timestamp>_<original>/         保留 history，profile.md 仅 { merged_to: <aid> }
│       │
│       ├── venues/                            ← 环境层：Venue 认知（§6）
│       │   │                                    群、私聊、广播频道
│       │   │
│       │   ├── _index/
│       │   │   ├── feishu_chat_xyz.json           venue_id → 目录名 反查
│       │   │   ├── aun_group_abc.json
│       │   │   └── ...
│       │   │
│       │   ├── <venue-name>/                    已识别的 venue（如 "项目X讨论群"）
│       │   │   ├── profile.md                     venue 定位、文化、policy（§6.3）
│       │   │   └── history.jsonl                  venue 级事件（不是消息日志，那在 sessions/）
│       │   │
│       │   ├── private_<peer-name>/             私聊 venue（命名约定：private_ 前缀）
│       │   │   ├── profile.md
│       │   │   └── history.jsonl
│       │   │
│       │   └── _trash/
│       │
│       ├── personal/                          ← 个人数据层：agent 内在状态（§7）
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
│       ├── sessions/                          ← 会话存储
│       │   │                                    跟 SDK 兼容（如 Claude Agent SDK 的 .claude/）
│       │   ├── <session-key>/                   session_key 见 §8
│       │   │   ├── messages.jsonl                 完整消息历史
│       │   │   └── meta.json
│       │   └── ...
│       │
│       └── data/                              ← 其它运行时数据
│           ├── self-summary-failures.jsonl      自我总结失败记录（§9.9）
│           ├── cache/                           临时缓存（agent.md 拉取缓存等）
│           └── ...
│
└── data/                                    ← 部署级：evolclaw 全局运行时数据
    ├── evolclaw.json                          全局配置（channels 凭证、proxied_aids issuer 等）
    ├── sessions.db                            会话元数据（SQLite）
    ├── ready.signal                           启动成功信号（CLI 检测用）
    │
    ├── logs/                                  日志
    │   ├── evolclaw.log
    │   ├── stdout.log
    │   ├── messages.log
    │   ├── restart.log
    │   ├── self-heal.md
    │   └── ...
    │
    └── pids/
        └── evolclaw.pid
```

### 3.2 重大变更说明

**变更 1：`agents/<name>.json` → `agents/<aid>/`**

每个 self agent 一个目录，目录名是 self agent 的 AID。所有 per-agent 数据（self、身份层、环境层、个人数据层、会话）都收纳到该目录下。原 `agents/<name>.json` 配置内容放进 `config.json`。

**变更 2：网关级 proxied-aids/ 注册表**

evolclaw 网关代飞书/企微/邮件等非 AUN 渠道的对端申请 AID，统一存放在 `~/.evolclaw/proxied-aids/`。每个 self agent 在自己的 identities/ 里通过 AID 引用，不重复申请。详见 §5.5。

**变更 3：身份分级建档**

直接交互过的身份在顶层（人类可读名）；只观察过的在 `_observed/`（目录名用 AID）。这避免了百人群的所有发言人都进顶层导致目录爆炸，同时仍然为每个收到过消息的对端建立了可追溯档案。

**变更 4：AUN Context Kit 中的 `$SELF_DIR/<aid>.md` 收编进 agents/&lt;aid&gt;/self/**

待本设计落地后：
- `agents/<aid>/self/persona.md` → 私有自述
- `agents/<aid>/self/card.md` → 对外名片（对应 AUN 协议的 `https://<aid>/agent.md`）
- AUN Context Kit 同步调整

**变更 5：群是 venue，不是 identity**

不再允许 identity 是 group 类型。群作为对话场景在 venues/ 下；群本身在身份层不出现独立档案。群成员是 identity（type=person 或 agent）。

**变更 6：不引入跨 agent 共享的认知层**

每个 self agent 在自己的 `agents/<aid>/identities/` 里独立维护对外认知。proxied-aids 是个例外——它是网关级的 AID 注册表，但不携带认知信息（认知仍在 per-agent identities/ 下）。

### 3.3 profile.md 格式

**type=person，self_held AID（如 Evol 用户王老板）**：

```markdown
---
name: 王老板
type: person
aid: wang.agentid.pub
aid_origin: self_held
primary_channel: aun
status: identified
channels:
  aun: "wang.agentid.pub"
  feishu: "ou_wang"
  email: "wang@company.com"
agents:                              # 他拥有的 agent
  - "wang-secretary.agentid.pub"
roles_for_self: [owner]
verified_channels: [aun, feishu]     # 哪些 channel 关联认证过
agent_view:
  preferred_address: "王老板"
  tone: "正式但不拘谨"
  last_topic: "Q4 项目排期"
---

王老板就是研发部那位王经理，平时说话挺直接。
上次聊 Q4 项目时对延期比较介意，后续沟通要先报进度再讲问题。
```

**type=agent（他人的 agent）**：

```markdown
---
name: 王秘书
type: agent
aid: wang-secretary.agentid.pub
aid_origin: self_held
primary_channel: aun
owner: wang.agentid.pub              # 指向所属人的 AID
status: identified
channels:
  aun: "wang-secretary.agentid.pub"
roles_for_self: []
verified_channels: [aun]
agent_view:
  service_scope: "替王老板处理日程"
  tone: "公事公办"
---

王老板的秘书 agent，处理日程相关事宜。
跟它沟通时记住：它代表王老板的工作日程，但不代表王老板本人——
重要决策仍需直接确认。
```

**type=person，proxied AID（飞书联系人张工）**：

```markdown
---
name: 张工
type: person
aid: zhang-9c1f.proxied.evolclaw     # 网关代申请的托管 AID
aid_origin: proxied
primary_channel: feishu               # 实际通过飞书收发
status: identified
channels:
  aun: "zhang-9c1f.proxied.evolclaw"
  feishu: "ou_zhang"
roles_for_self: []
verified_channels: [feishu]
agent_view:
  preferred_address: "张工"
---

张工是研发部测试，对接 Q4 项目的测试事宜。
```

**_observed/ 的极简档案（旁观未交互）**：

```markdown
---
type: person
aid: someone.proxied.evolclaw
aid_origin: proxied
primary_channel: feishu
status: unidentified
channels:
  aun: "someone.proxied.evolclaw"
  feishu: "ou_someone"
first_seen_in: "项目X讨论群"
last_seen_at: "2026-05-15T14:00:00Z"
---

```

正文留空——旁观档案不主动写关系笔记，等首次直接互动后升级到顶层目录再补。

### 3.4 字段约束

| 字段 | identity（顶层） | identity（\_observed/） | venue |
|---|:---:|:---:|:---:|
| `name` | ✅ 必填 | ❌ | ✅ 必填 |
| `type` | ✅ person / agent | ✅ person / agent | venue 用 `kind` 替代 |
| `aid` | ✅ 必填（canonical） | ✅ 必填 | ❌ |
| `aid_origin` | ✅ self_held / proxied | ✅ self_held / proxied | ❌ |
| `primary_channel` | ✅ 必填 | ✅ 必填 | ❌ |
| `status` | ✅ unidentified / identified / merged | 通常 unidentified | ✅ |
| `channels` | ✅ AID + 关联渠道 ID | ✅ AID + primary_channel ID | venue 用 `venue_ids` |
| `owner` | type=agent 时必填（指向 AID） | type=agent 时必填 | ❌ |
| `agents` | type=person 可选（AID 列表） | 不放 | ❌ |
| `roles_for_self` | ✅（可空） | 永远 [] | ❌ |
| `verified_channels` | ✅ | ✅ | ❌ |
| `agent_view.*` | ✅ 自由扩展 | 不放 | ✅ |

**status 三态**：

- `unidentified` — 仅有 AID + 渠道 ID，未确认真实身份。\_observed/ 下默认 unidentified
- `identified` — 已确认。顶层目录用人类可读名
- `merged` — 已合并到其它身份。目录保留作重定向

### 3.5 history.jsonl 事件类型

```jsonl
{"event": "created", "at": "2026-05-15T10:00:00Z", "source_channel": "feishu", "source_id": "ou_zhang", "method": "first-message"}
{"event": "aid_provisioned", "at": "2026-05-15T10:00:01Z", "aid": "zhang-9c1f.proxied.evolclaw", "origin": "proxied"}
{"event": "promoted_from_observed", "at": "2026-05-16T08:00:00Z", "from": "_observed/aid_zhang-9c1f.proxied.evolclaw", "to": "张工"}
{"event": "identified", "at": "2026-05-15T10:05:00Z", "from": "unidentified_xxx", "to": "王老板", "method": "self-declaration"}
{"event": "channel_added", "at": "2026-05-15T11:00:00Z", "channel": "feishu", "id": "ou_xxx", "verified": true}
{"event": "interaction", "at": "2026-05-16T08:00:00Z", "venue": "项目X讨论群", "summary": "讨论 Q4 项目延期"}
{"event": "merged", "at": "2026-05-16T09:00:00Z", "absorbed": "wechat_xxx_old", "approved_by": "owner-zhang"}
{"event": "profile_updated", "at": "2026-05-16T09:01:00Z", "field": "agent_view.tone", "trigger": "self-summary"}
```

事件类型：`created` / `aid_provisioned` / `promoted_from_observed` / `identified` / `channel_added` / `channel_removed` / `merged` / `split` / `profile_updated` / `interaction`。

evolclaw 字段：
- `method`：`first-message` / `self-declaration` / `aun-card-pull` / `owner-confirmed` / `cross-channel-merge` / `self-summary`
- `approved_by`：高风险变更需要 owner 显式批准
- `venue`：interaction 事件标注发生在哪个 venue
- `trigger`：profile_updated 事件区分触发源（`session` / `self-summary` / `command`）

### 3.6 \_index 反查

身份层的 \_index 用 **AID 索引**（不再用 channel_id 作主索引）：

```json
// agents/secretary.agentid.pub/identities/_index/aid_wang.agentid.pub.json
{
  "identity": "王老板",
  "type": "person",
  "added_at": "2026-05-15T10:00:00Z"
}

// agents/secretary.agentid.pub/identities/_observed/_index/aid_someone.proxied.evolclaw.json
{
  "identity_dir": "_observed/aid_someone.proxied.evolclaw",
  "type": "person",
  "added_at": "2026-05-15T10:00:00Z"
}

// agents/secretary.agentid.pub/venues/_index/feishu_chat_xyz.json
{
  "venue": "项目X讨论群",
  "kind": "group",
  "added_at": "2026-05-15T10:00:00Z"
}
```

**网关级 proxied-aids 索引**用 `{channel}_{principal}` 作主索引：

```json
// ~/.evolclaw/proxied-aids/_index/feishu_ou_zhang.json
{
  "aid": "zhang-9c1f.proxied.evolclaw",
  "channel": "feishu",
  "channel_id": "ou_zhang",
  "primary_channel": "feishu",
  "created_at": "2026-05-15T10:00:00Z"
}
```

**channel_id 编码**：`{channel}_{principal}`

- `feishu_ou_xxxxx` — 飞书用户
- `wechat_from_user_id_zzz` — 微信用户
- AUN 渠道不需要进入 proxied-aids（直接用 AID 索引）

群 venue 的 venue_id 编码：`feishu_chat_aaa`、`aun_group_bbb`。私聊 venue 的 venue_id 用对端 AID。

## 4. 关键机制

### 4.1 入站消息解析（Principal + Venue 二元组）

每条入站消息进入 evolclaw 时，channel adapter 吐出标准化的 `InboundMessage`（见 §2.2）。Core 层先解析 Principal，再解析 Venue，两者完全解耦：

```
入站消息 InboundMessage = { principal, venue, content, ... }
  ↓
─── Step A：解析 Principal（身份层） ─────

  A1. 确定 AID
    principal.channel == 'aun'
      ├─ 是 → AID = principal.channel_id（对端自带 self_held AID）
      └─ 否 → 查 proxied-aids/_index/{channel}_{channel_id}.json
              ├─ 命中 → AID = 索引中的 aid
              └─ 未命中 → 触发 auto-provision（见 §5.5）→ 拿到新 AID

  A2. 用 AID 查 identity
    identities/_index/aid_<AID>.json 命中？
      ├─ 命中 → 加载顶层 identity profile + history
      └─ 未命中 → identities/_observed/_index/aid_<AID>.json 命中？
                  ├─ 命中 → 加载 _observed 极简档案
                  └─ 未命中 → 按分级策略建档（见 A3）

  A3. 分级建档
    判定是否为「直接交互」：
      - 私聊（venue.kind=private）→ 是
      - 群里被 @ 自己 → 是
      - 群里 self 之前 @ 过该 speaker（出站时记录）→ 是
      - 群里命令消息（B' 模式，发送方是 owner/admin）→ 是
      - 群里仅旁观（C 模式）→ 否
    分级：
      - 直接交互 → 在顶层 identities/<unidentified_xxx>/ 建完整档案
      - 否 → 在 _observed/aid_<AID>/ 建极简档案
    写 history.created 事件

  ↓
─── Step B：解析 Venue（环境层） ─────────
  venue.kind == 'private'
    ├─ 是 → venue_id = 对端 AID，自动生成 / 复用 private venue
    └─ 否 → venues/_index 查找 venue.venue_id → 命中？
            ├─ 命中 → 加载 venue profile + history
            └─ 未命中 → 创建 unidentified venue
  ↓
─── Step C：组装解析结果 ─────────────────
  return {
    speaker: ResolvedIdentity,
    venue:   ResolvedVenue,
    self:    SelfContext,
  }
```

**ResolvedIdentity**（Principal 视图）：

```typescript
interface ResolvedIdentity {
  displayName: string;
  type: 'person' | 'agent';
  aid: string;                     // canonical key（必有）
  aidOrigin: 'self_held' | 'proxied';
  primaryChannel: string;
  status: 'unidentified' | 'identified' | 'merged';
  rolesForSelf: ('owner' | 'admin')[];   // 可空 = 普通联系人
  ownerAid?: string;               // type=agent 时，指向所属人
  agentsAids?: string[];           // type=person 时，指向他拥有的 agent
  verifiedChannels: string[];
  channels: Record<string, string>;
  agentView?: Record<string, any>;
  identityDir: string;
  tier: 'active' | 'observed';     // 顶层 vs _observed
}
```

**ResolvedVenue**（Venue 视图）：

```typescript
interface ResolvedVenue {
  kind: 'private' | 'group' | 'broadcast';
  displayName: string;
  venueDir: string;
  venueIds: VenueId[];
  agentView?: Record<string, any>;
}
```

**关键性质**：

- 身份解析完全不看 venue.kind——同一个小王在群里说话和私聊，解析出来的是同一个 Principal
- venue 解析完全不看 speaker——这个群有谁在说不影响"群是哪个群"
- 私聊场景下 venue_id 用对端 AID（不是 channel_id）
- 所有 identity 都有 AID——AUN 对端自带，非 AUN 对端由网关 auto-provision

**例**（飞书联系人张工首次在项目X群发言，未 @ secretary）：

```
InboundMessage:
  principal: { channel: "feishu", channel_id: "ou_zhang", declared_name: "张工" }
  venue:     { kind: "group", channel: "feishu", venue_id: "chat_xyz" }

Step A1: proxied-aids/_index/feishu_ou_zhang.json 未命中 → auto-provision → AID = zhang-9c1f.proxied.evolclaw
Step A2: identities/_index/aid_zhang-9c1f.proxied.evolclaw.json 未命中
Step A3: venue.kind=group 且未 @ → 在 _observed/ 建极简档案

解析结果:
  speaker: { displayName: "张工", type: "person", aid: "zhang-9c1f.proxied.evolclaw",
             aidOrigin: "proxied", primaryChannel: "feishu", tier: "observed", ... }
  venue:   { displayName: "项目X讨论群", kind: "group", ... }
```

**示例**（王老板通过 AUN 私聊 secretary）：

```
InboundMessage:
  principal: { channel: "aun", channel_id: "wang.agentid.pub", declared_name: "王建国" }
  venue:     { kind: "private", channel: "aun", venue_id: "wang.agentid.pub" }

Step A1: channel=aun → AID = wang.agentid.pub（self_held）
Step A2: identities/_index/aid_wang.agentid.pub.json 命中 → 加载 "王老板" profile
Step B: venue.kind=private → venue_id = wang.agentid.pub → 复用 private_王老板 venue

解析结果:
  speaker: { displayName: "王老板", type: "person", aid: "wang.agentid.pub",
             aidOrigin: "self_held", rolesForSelf: ["owner"], tier: "active", ... }
  venue:   { displayName: "private_王老板", kind: "private", ... }
```

### 4.2 身份识别（Identification）

`unidentified → identified` 的过程由 LLM 执行：

```
agent 在对话中识别出对端真实身份
  ↓
agent 调用 identity.identify 工具：
  identity.identify({
    aid: "zhang-9c1f.proxied.evolclaw",
    name: "张工",
    type: "person",
    method: "self-declaration" | "context-inferred" | "owner-confirmed" | "aun-card-pull",
    evidence: "对方说: 我是研发部张工"
  })
  ↓
工具检查：
  - 该 AID 是否已在顶层 identities/ 存在？
    - 是 → 更新 name + 写 history.identified
    - 否 → 是否在 _observed/ 存在？
            - 是 → 升级到顶层（promote_from_observed）
            - 否 → 在顶层新建
  - 如果 type 从默认 person 改为 agent → 要求补充 owner 字段
  ↓
更新 _index，写 history 事件
```

**_observed → 顶层的升级流程**：

```
identity.promote({
  aid: "zhang-9c1f.proxied.evolclaw",
  name: "张工"
})
  ↓
1. 把 _observed/aid_<aid>/ 目录移到顶层 identities/张工/
2. 更新 _index：从 _observed/_index 移到顶层 _index
3. 补充 profile.md 字段（name、agent_view 等）
4. 写 history.promoted_from_observed 事件
```

**LLM 识别的边界**：

- 普通重命名 / 同 type 合并 / _observed 升级：LLM 自主可执行
- type 变更（person → agent 或反向）：需要 owner 批准
- 涉及 owner / admin 角色的身份变更：必须 owner 批准

### 4.3 身份合并（Merge）

确认两个 identity 是同一个身份时执行合并：

```
identity.merge({
  source_aid: "feishu-xxx.proxied.evolclaw",   // 被吸收方
  target_aid: "wang.agentid.pub",               // 保留方
  reason: "用户在通话中确认: 我的飞书也是这个号",
  approved_by: "owner-zhang"                    // 跨 aid_origin 时必填
})
  ↓
合并步骤：
  1. 把 source 的 channels 追加到 target.channels
  2. 把 source 的 history 追加到 target.history（带合并标记）
  3. source 的 profile.md 仅保留 { merged_to: target_aid } 重定向
  4. source 目录移到 _trash/<timestamp>_<original_name>/
  5. 更新 _index：source AID 索引指向 target 目录
  6. 写 target.history.merged 事件
  7. 更新 proxied-aids 注册表（如果 source 是 proxied，标记为 merged）
```

**合并约束**：

| 合并场景 | 谁能批 |
|---|---|
| 同 type + 同 aid_origin | LLM 可自主执行 |
| 同 type + 跨 aid_origin（如 proxied 合并到 self_held） | 必须 owner 批准 |
| 跨 type（person ↔ agent） | **禁止**——用 owner/agents 字段关联，不合并 |
| 涉及含 owner / admin 角色的身份 | 必须 owner 批准 |

**合并后 AID 的处理**：

- 保留方的 AID 成为 canonical（通常是 self_held 优先于 proxied）
- 被吸收方的 AID 在 \_index 中保留为别名（指向同一目录），确保旧 AID 的消息仍能路由到正确身份
- 如果被吸收方是 proxied AID，其私钥可以在合并后销毁（不再需要代理通信）

### 4.4 权限模型

权限判定基于 `aid_origin` + `roles_for_self`，不再使用 trust_level 概念。

**核心约束**：

| 角色 | 必须 aid_origin | 说明 |
|---|---|---|
| `owner` | `self_held` | 对方必须自己持有 AID 私钥 |
| `admin` | `self_held` | 同 owner |
| 普通联系人（roles_for_self 为空） | 任意 | proxied 或 self_held 都行 |

**为什么 proxied 不能当 owner**：proxied AID 的私钥在 evolclaw 本地，不是对方真的"持有"那个身份。如果给 proxied AID owner 权限，等于"任何能拿到本地密钥的人都能对我提权"——攻击面爆炸。

**`computeRoles` 的核心逻辑**：

```typescript
function computeRoles(resolved: ResolvedIdentity, selfAgent: AgentConfig): ('owner' | 'admin')[] {
  // proxied AID → 永远是普通联系人
  if (resolved.aidOrigin !== 'self_held') return [];

  // self_held AID → 查 agent 配置的 owner / admin 列表
  const aid = resolved.aid;
  if (selfAgent.owners?.includes(aid)) return ['owner'];
  if (selfAgent.admins?.includes(aid)) return ['admin'];
  return [];
}
```

**owner / admin 配置就是 AID 列表**：

```json
// agents/<aid>/config.json
{
  "aid": "secretary.agentid.pub",
  "display_name": "secretary",
  "owners": ["zhang.agentid.pub"],
  "admins": ["li.agentid.pub", "wang.agentid.pub"]
}
```

不再需要 `ownerResolver` / `adminResolver` 回调——身份层解析返回的 ResolvedIdentity 自带 aid + aidOrigin，配置查表即可。

**owner 关系是 per-agent 的**：

- agent A (`agents/secretary.agentid.pub/config.json`) `owners: [zhang.agentid.pub]`
- agent B (`agents/reviewer.agentid.pub/config.json`) `owners: [li.agentid.pub]`
- zhang 找 agent B 时 roles_for_self 为空，不是 owner

**反提权保护**（参考 Kite，必须保留）：

`check_permission` 必须自己读 `agents/<self-aid>/config.json` 的 owners 列表 + 对端身份的 AID + aidOrigin 比对，**不信任** session.identity 中传入的 rolesForSelf。文件操作类工具阻止非 owner 修改 owners 字段。

**其它约束**：

- owner / admin 升降级必须更新 history 并要求另一个已存在的 owner 批准（首个 owner 例外，由 agent 创建时的初始配置确立）
- 跨 aid_origin 合并（proxied 合并到 self_held）必须 owner 批准——这等于把渠道内部身份和协议级身份打通

### 4.5 系统提示中的 type 标注

agent 跟 `type=agent` 的对端对话时，系统提示必须明确标注：

```markdown
**当前对端**：王秘书（type=agent，owner=wang.agentid.pub）
⚠️ 你正在跟王老板的 agent 对话，不是跟王老板本人。
重要决策仍需直接确认王老板本人。
```

跟 `type=person` 的对端对话时：

```markdown
**当前对端**：王老板（type=person）
```

这个区分影响 agent 的回复策略——跟人的 agent 对话时，agent 应当意识到对方可能只是代理，不能代表本人做最终决策。

### 4.6 群是 venue，不是 identity

群不再出现在 identities/ 里。群作为对话场景在 venues/ 下管理。

- session_key 按 venue 隔离（`{agent}:venue:{venue_displayName}:{project_path}`），不按发言人
- venue profile.md 记录"群定位"（项目X讨论群、家庭群等），不存成员名单
- 群消息中的发言人是 identity（type=person 或 agent），session 上下文是群的，**agent 同时更新发言人的 identity 档案**（跨 session 的关系记忆走身份层）

**跨渠道群 venue 合并**：

> "飞书 chat_aaa = 企微 group_bbb = 项目 X 讨论群" 这种合并不能让 LLM 自己猜。

群 venue 合并必须 owner 显式声明。猜错的代价是把 A 部门聊天搬到 B 部门。

### 4.7 群消息收发的三种入站模式

群语境下入站事件分三类，每类的解析行为和 agent 决策粒度不同：

| 模式 | 触发条件 | 事件类型 | agent 决策粒度 |
|---|---|---|---|
| **A. 私聊** | venue.kind=private | `SingleMessageEvent` | 每条消息一次决策 |
| **B. 群里 @ self** | venue.kind=group + mentions 含 self | `SingleMessageEvent` + flush 当前批次 | 每次 @ 一次决策 |
| **B'. 群里 owner/admin 发命令** | venue.kind=group + content 以 `/` 开头 + 发送方为特权 | 同 B（reason=command-flush） | 命令立即执行 |
| **C. 群里未 @ self** | venue.kind=group + 未命中 self + 非命令 | `GroupBatchEvent`（窗口积累） | 整个批次一次决策 |

**模式 A：私聊**

```
SingleMessageEvent { principal: 王老板, venue: private_王老板, message: ... }
  ↓
解析 speaker（identities/王老板）+ venue（venues/private_王老板）
  ↓
agent 决策：通常会回复（私聊默认 require_mention=false）
```

**模式 B：群里 @ self**

```
群里王老板说: "@secretary 明天会议改下午3点"
  ↓
channel adapter 检测到 mentions 含 self.aid
  ├─ 立即 flush 当前 batch buffer 为 GroupBatchEvent（reason=mention-flush）→ agent 先消化批次上下文
  └─ 推送 SingleMessageEvent（带 mentions: [self.aid]）→ agent 针对 @ 消息决策
  ↓
解析 speaker + venue + 加载该群最近的批次摘要
  ↓
agent 决策：高优先级响应
```

**flush + 推送的顺序**很关键——先把积累的批次给 agent（让它知道"群里刚才在聊什么"），再推 @ 消息（让它针对当前问题回答）。如果颠倒，agent 收到 @ 时不知道上下文。

**模式 C：群里未 @ self**

```
窗口期内积累多条消息（默认 30s 或 20 条，可配）
  ↓
窗口结束 → flush 为 GroupBatchEvent
  ↓
解析 venue + 解析所有 messages 的 speakers（每个 speaker 走一次 §4.1 流程）
  ├─ 已知 speaker → 加载顶层 identity，更新 last_seen_at
  └─ 未知 speaker → auto-provision proxied AID + 在 _observed/ 建极简档案
  ↓
agent 决策（一次）：
  - 默认不回复（require_mention=true 时）
  - LLM 看完整批次后判断：要不要插话？要不要记录？要不要触发 self-summary？
```

批次模式下 agent **只决策一次**，不是每条消息一次决策。这是成本控制和行为合理性的关键——agent 不会因为群里聊了 20 条就跑 20 次 LLM。

**venue policy 控制窗口参数**：

```yaml
# venues/项目X讨论群/profile.md frontmatter
policy:
  forward_all_messages: true        # channel adapter 是否转发所有群消息（false=只转发 @ 消息）
  require_mention: true             # agent 是否默认只在被 @ 时回复
  batch_window_seconds: 30          # 批次窗口时长
  batch_max_messages: 20            # 批次窗口最大消息数
```

如果 `forward_all_messages: false`，模式 C 不会触发——agent 完全看不到没 @ 自己的消息（"耳聋"模式，私聊场景的群延伸）。

### 4.8 群消息收发的三种出站模式

agent 主动出站消息分三类：

| 模式 | 用途 | 关键字段 |
|---|---|---|
| **D. 精确回复** | 回复某条具体消息 | `reply_to_message_id` |
| **E. 群广播** | 不指定目标在群里发言 | （无） |
| **F. @ 列表** | @ 一到多个人发言 | `mentions: [aid, ...]` |

**OutboundMessage 结构**：

```typescript
interface OutboundMessage {
  venue_uid: string;                 // 目标 venue 的稳定 UID（见 §6.6）
  target_channel?: string;           // 跨渠道 venue 时指定走哪个 channel
                                     // 缺省时取 venue.primary_channel
  content: string;
  reply_to_message_id?: string;      // 模式 D：精确回复
  mentions?: string[];               // 模式 F：@ 哪些 AID
  // 模式 E：reply_to / mentions 都不设
}
```

**target_channel 解析规则**：

- 显式指定 → 用它（必须在 venue.venue_ids 里）
- 未指定 → 用 venue.primary_channel
- 单 channel venue → 直接用唯一 channel
- 跨渠道 venue 想"双发"（同时发飞书+企微） → agent 需要分别构造两个 OutboundMessage

**模式选择由 agent 自主决策**，不是 evolclaw 强加的：

- 模式 D：群里被 @ 后回答原问题 / 引用某条消息做评论
- 模式 E：批次模式下 agent 决定主动同步进度，不针对任何具体消息
- 模式 F：拉特定人进话题，或回复涉及多人的问题

**channel adapter 的转换职责**：

- venue_uid → target_channel 上的群 ID（查 venue.venue_ids[target_channel]）
- mentions 中的 AID 反查为该 channel 的本地 ID（飞书 ou_xxx、微信 from_user_id 等）
- reply_to_message_id 转为该 channel 的回复语法

如果 mentions 包含未在 target_channel 出现过的 AID（对方在别的 channel），channel adapter 应当报错并提示 agent——不能在 channel A 上 @ 一个 channel B 才认识的人。

**主动出站对 batch flush 的影响**：

agent 主动在某 venue 发言时，该 venue 当前的批次窗口立即 flush（即使还没到时间/条数阈值）。这避免：
- agent 发言后又收到一批延迟到达的批次消息，造成回复跟随上下文乱序
- agent 在不知道刚到达消息的情况下做决策

**主动出站的触发源**：

| 触发源 | 例子 | 说明 |
|---|---|---|
| 响应式 | 收到入站事件后回复 | 已覆盖（§4.1 + §4.7） |
| 跨 venue 联动 | 私聊里 owner 说"把这结论发到项目群" | 通过工具调用触发，target venue_id 由 LLM 指定 |
| 自我总结产出 | §9 总结时发现"该跟群同步进度" | self-summary 流程产生 outbound 任务 |
| 定时/事件触发 | 早会前提醒 / 任务完成通知 | scheduled task 或外部事件触发 |

后三种触发源不在身份层和环境层的核心机制里，但它们都通过同一个 OutboundMessage 接口出站，复用 venue 解析、mentions 处理、batch flush 逻辑。

## 5. 与 AUN 协议的关系

### 5.1 AID 是身份层的 canonical channel

AUN 的 AID 是协议级身份。在 evolclaw 身份层它是 **canonical channel**——不是众多 channel 之一，而是身份的根锚点：

- 编码为 `aun_<aid>` 进入 \_index
- 默认 `aid_origin: self_held`
- 是身份合并融合的优先依据
- **特权角色（owner / admin）只能挂在 aid_origin=self_held 的身份上**（见 §4.4）

evolclaw 视角下的 AID 分布：

- **Self AID**：每个 agent 必须有 AID，否则没法在 AUN 上发声
- **Owner AID**：每个 agent 必须配至少一个 owner AID（必须 self_held）
- **Peer AID（self_held）**：通过 AUN 找上来的对端自带 AID（Evol 前端用户都是 AID 持有者）
- **Peer AID（proxied）**：通过飞书/企微/邮件等找上来的对端，由网关代申请 proxied AID（见 §5.5）

### 5.2 agent.md 是 self 身份的对外公开面

AUN 协议规定 `https://<aid>/agent.md` 是 agent 的公开名片。evolclaw 中：

- `agents/<aid>/config.json` → 配置和运行时
- `agents/<aid>/self/persona.md` → 内部自述（行为规范、心理独白等，给 LLM）
- `agents/<aid>/self/card.md` → 对外名片，对应 `https://<aid>/agent.md`

evolclaw 启动 nameservice 端点时直接 serve `card.md`。card.md 和 persona.md 的 frontmatter 可以共享部分字段（aid、name、type 等），但 persona 含私有的行为规范不会暴露。

### 5.3 远端 AID 的身份信息来源

第一次遇到一个 AID 时，身份层可以：

1. 调 `curl https://<aid>/agent.md` 拉取对方公开名片
2. 把 frontmatter 的客观字段（name、role、issuer）作为提示信息（不直接信任）
3. 标 unidentified，等首次对话由 LLM 确认

agent.md 拉取是 per-agent 的——每个 agent 自己拉、自己缓存、自己写入 identities/。不做跨 agent 的事实层广播或同步。

### 5.4 自主模式语义不变

身份层不改变 AUN 自主模式约束。"知道对端是谁"不等于"必须回复对端"——回复决策仍由 agent LLM 自主，识别只提供更好的上下文。

### 5.5 AID 自动申请与托管（Proxied AID）

evolclaw 网关为非 AUN 渠道的对端代为申请 AID，统一存放在 `~/.evolclaw/proxied-aids/`。这是**网关级共享**的——同一台机器上的所有 self agent 共享同一份 channel_id → AID 映射。

**触发条件**：

入站消息的 `principal.channel != 'aun'` 且 `proxied-aids/_index/{channel}_{channel_id}.json` 不存在时，自动触发。

**申请流程**：

```
非 AUN 入站消息 (channel=feishu, channel_id=ou_zhang)
  ↓
proxied-aids/_index/feishu_ou_zhang.json 不存在
  ↓
auto-provision:
  1. 生成密钥对（P-256）
  2. 调 AUN custody 服务申请 AID
     - issuer: 部署方配置的 proxied issuer（如 proxied.evolclaw 或自定义域）
     - name: 随机生成（如 zhang-9c1f）
     - 拿到证书
  3. 写入 proxied-aids/<aid>/
     - meta.json: { primary_channel: "feishu", channels: { feishu: "ou_zhang" }, created_at, ... }
     - cert.pem: AUN 证书
     - key.pem.enc: 私钥（加密存储，密钥由 evolclaw 主密钥派生）
  4. 写入 proxied-aids/_index/feishu_ou_zhang.json
     - { aid, channel, channel_id, primary_channel, created_at }
  ↓
返回 AID 给身份解析流程
```

**issuer 命名空间**：

由部署方在 `evolclaw.json` 中配置：

```json
{
  "proxied_aids": {
    "issuer": "proxied.evolclaw",
    "custody_url": "https://aid_custody.agentid.pub:18630",
    "auto_provision": true
  }
}
```

这些 proxied AID 只在本 evolclaw 域内有效——它们不会出现在公共 AUN 网络的名片搜索里，但在协议层是合法的 AID（有证书、能握手）。

**跨 self agent 共享**：

同一个飞书联系人 `ou_zhang` 无论跟哪个 self agent 对话，都映射到同一个 proxied AID。这是因为：
- 飞书联系人是一个人，不应该因为跟不同 agent 对话就拿到不同 AID
- 如果未来这个人注册了真正的 AUN 身份，只需要做一次 proxied → self_held 升级

但每个 self agent 的 identities/ 里对这个 AID 的**认知**（profile.md、history.jsonl）是独立的。proxied-aids 只管"这个 channel_id 对应哪个 AID"，不管"这个人是谁、跟我什么关系"。

**proxied → self_held 升级**：

当对方真的注册了 AUN 身份（比如他装了 Evol App），需要做迁移：

```
identity.upgrade_aid({
  old_aid: "zhang-9c1f.proxied.evolclaw",    // proxied
  new_aid: "zhang.agentid.pub",               // self_held
  evidence: "对方通过 AUN 握手证明持有 zhang.agentid.pub",
  approved_by: "owner-zhang"
})
  ↓
1. 更新 identity profile.md：aid → new_aid, aid_origin → self_held
2. 更新 identities/_index：新增 aid_zhang.agentid.pub.json，旧索引保留为别名
3. proxied-aids/<old_aid>/meta.json 标记 deprecated: true, migrated_to: new_aid
4. 写 history.aid_upgraded 事件
5. 旧 proxied AID 的私钥可以销毁（不再需要代理通信）
```

此操作必须 owner 批准——把一个渠道身份升级为协议级身份是高风险变更。

**密钥安全**：

- 私钥用 AES-256-GCM 加密存储，密钥由 evolclaw 主密钥（`evolclaw.json` 中配置或自动生成）派生
- 主密钥不落盘明文——首次启动时生成，存入系统密钥链（Windows: DPAPI, macOS: Keychain, Linux: libsecret）
- 如果系统密钥链不可用，降级为文件存储 + 权限 0600

**custody 不可达的处理**：

custody 服务（远端 AUN AID 签发服务）不可达时，新对端的入站消息处理策略：

1. **创建 placeholder AID**：本地生成密钥对 + 临时 AID（命名 `pending-<hash>.proxied.evolclaw`），先把消息处理完，proxied-aids 标记 `pending_custody: true`
2. **后台重试队列**：写入 `data/proxied-aids-pending.jsonl`，后台 worker 周期性重试 custody 申请
3. **拿到正式证书后迁移**：custody 申请成功后，placeholder AID 替换为正式 AID（identities/_index 加别名映射，sessions 不变），写 `history.aid_provisioned` 事件
4. **持续失败 → owner 通知**：连续 N 次（默认 24 小时）失败，通过 self agent 通知 owner

**为什么不阻塞消息处理**：阻塞会导致下游 channel adapter 重试风暴 / 用户长时间等不到回复。先用临时 AID 让消息流走起来，证书后补不影响认知数据正确性（key 是 AID，不是证书）。

**临时 AID 的限制**：

- `aid_origin: proxied` + `pending_custody: true`
- 永远不能持有 owner/admin 角色（跟普通 proxied 一样）
- 不能参与跨 self_held 合并直到 custody 申请成功
- card.md 拉取等需要"协议级身份"的操作暂停

## 6. 环境层（Venue Layer）

### 6.1 设计目标

环境层回答两个问题：
- "这次对话发生在什么场景"——给 LLM 提供 venue 上下文
- "这个场景什么文化、什么规则"——影响 agent 的回复风格、命令默认行为

跟身份层互补：身份层是 Principal 的认知，环境层是 Venue 的认知。两者数据结构同构（profile + history + \_index），约束不同。

### 6.2 三种 venue kind

| kind | 含义 | 典型 venue_id |
|---|---|---|
| `private` | 一对一私聊 | 对端的 AID（如 `wang.agentid.pub`） |
| `group` | 群聊 | 群的渠道 ID（如 `feishu_chat_xyz`） |
| `broadcast` | 广播频道（订阅型，单向） | 频道 ID |

private venue 通常不需要单独维护 profile.md（用对端 Principal 的 profile 就够了），但保留这个层级是为了：
- 独立记录"我跟这个人在什么频率沟通、上次聊到哪"等场景级信息
- 支持同一个人在不同渠道的不同私聊场景区分（飞书私聊 vs AUN 私聊有时风格不同）

### 6.3 venue profile.md 格式

群 venue：

```markdown
---
kind: group
status: identified
venue_uid: "v_a1b2c3d4e5f6"      # 稳定 UID（首次创建分配，不随重命名变化），见 §6.6
venue_ids:
  feishu: "chat_xyz"
  wechat: "group_aaa"             # 跨渠道同步的同一个群
primary_channel: feishu            # 出站默认走哪个 channel
policy:
  forward_all_messages: true       # channel adapter 是否转发所有群消息
  require_mention: true            # agent 是否默认只在被 @ 时回复
  command_triggers_flush: true     # 命令前缀消息（/...）触发立即 flush（同 @）
  batch_window_seconds: 30
  batch_max_messages: 20
  show_activities: 'all'           # 中间输出显示范围
metadata:
  source: "owner-declared"
  purpose: "Q4 项目讨论"
  member_count_hint: 12            # 提示，不是权威成员名单
agent_view:
  tone: "正式"
  active_topics: ["Q4 项目排期", "技术选型"]
---

项目 X 讨论群是研发部为新项目搭建的协作群，张总和我都在里面。
群里讨论需求决策时通常需要 @ 我才介入，避免打断他们的讨论节奏。
```

private venue（多数情况下可省略）：

```markdown
---
kind: private
status: identified
venue_uid: "v_p_wang_001"
venue_ids:
  aun: "wang.agentid.pub"          # 私聊 venue_id 用对端 AID
peer_aid: wang.agentid.pub         # 关联到 Principal（用 AID）
primary_channel: aun
policy:
  forward_all_messages: true
  require_mention: false           # 私聊默认有问必答
agent_view:
  preferred_session_window: "工作时间"
---
```

### 6.4 venue history.jsonl

事件类型扩展：

| 事件 | 含义 |
|---|---|
| `created` | venue 首次出现 |
| `identified` | venue 被命名（从 unidentified_xxx 升级） |
| `joined` | agent 进入该 venue（被拉入群） |
| `left` | agent 退出该 venue |
| `topic_changed` | 群名/主题变化 |
| `merged` | 跨渠道群被合并 |
| `interaction_summary` | 一次对话/活跃期的摘要 |

**注意**：venue history 不记录每条消息（那是 sessions/）。只记录 venue 级别的事件，类似"我在这个群参加了 Q4 项目讨论会"这种摘要级别。

### 6.5 跨渠道 venue 合并

跟跨渠道身份合并一样，必须 owner 显式声明：

```
/venue merge feishu_chat_xyz wechat_group_aaa --into 项目X讨论群
```

不可让 LLM 自主合并——错合并 = 把 A 部门聊天搬到 B 部门。

### 6.6 venue 与 session_key

**venue_uid（venue 内部稳定标识）**：

每个 venue 首次创建时分配一个 UUID（如 `v_a1b2c3d4e5f6`），写入 profile.md 的 `venue_uid` 字段，**永不变化**。这跟 displayName 解耦——重命名群、跨渠道合并都不影响 venue_uid。

session_key 用 venue_uid，不用 displayName：

```
私聊：{self_aid}:venue:{venue_uid}:{project_path}
群：  {self_aid}:venue:{venue_uid}:{project_path}
```

为什么不用 displayName：群可能改名（"项目X讨论群" → "项目X收尾群"），用 displayName 会导致旧 session 找不到。

为什么不用 venue_id：venue 可能跨渠道合并（飞书 chat_xyz + 企微 group_aaa → 同一个 venue），用某一个 venue_id 等于钉死渠道。

跨渠道同一个群合并后会话也合并；同一个人在不同渠道的私聊默认共享 session（per-peer 模式，复用 peer 的 venue_uid）或独立 session（per-channel-peer 模式，每个 channel 一个独立 venue）由 agent 配置决定。

### 6.7 venue 影响行为，不影响权限

venue 不参与权限判定。但影响：

| 维度 | venue 的影响 |
|---|---|
| 命令触发 | 群 venue 默认要求 @ agent；私聊 venue 直接执行 |
| 中间输出 | venue policy 控制是否显示工具调用、是否累积错误（参考现有 showActivities 配置） |
| 回复风格 | venue 的 agent_view.tone 提示 LLM 调整语气 |
| 主动消息 | broadcast venue 才适合主动推送，private/group 严格遵守自主模式 |

权限判定永远只看 Principal（speaker）。venue 只塑造默认行为。

## 7. 个人数据层（Personal Layer）

### 7.1 设计目标

身份层和环境层是 agent **对外**认知（认识谁、参与什么场景）。个人数据层是 agent **对内**自我状态——记忆、风格、偏好、技能。

定位类比：身份层 = 通讯录 + 关系笔记；环境层 = 场景笔记；个人数据层 = 日记 + 学习笔记 + 偏好设置 + 技能清单。

### 7.2 子层划分

```
agents/<aid>/personal/
├── memory/                ← 长期记忆
│   ├── episodic.jsonl       事件性记忆：发生过什么（按时间）
│   ├── semantic.md          语义性记忆：得出的结论、习得的事实
│   └── working.md           当前关注：本周/今天在意什么（短期）
├── style.md               ← 表达风格
├── preferences.json       ← 工具/模型/操作偏好
├── skills/                ← 技能清单
│   ├── _index.json
│   └── *.md                 单个技能描述（与 agent 自身能力声明同源）
├── journal.jsonl          ← 反思日志（关键决策、自我修订）
└── goals.md               ← 长期目标
```

### 7.3 各子层详解

**memory/episodic.jsonl** — 事件性记忆

按时间序写入"发生了什么、感受是什么"：

```jsonl
{"at": "2026-05-15T10:00", "event": "Q4 项目延期讨论", "venue": "项目X讨论群", "summary": "张总不满意延期，建议拆分里程碑"}
{"at": "2026-05-15T15:30", "event": "review 王老板的设计稿", "venue": "private_王老板", "summary": "他在意细节，下次先报全局再展开细节"}
```

跟 venue history 的区别：venue history 是"这个群发生了什么"，episodic 是"我在这件事上经历了什么"，包含主观感受/反思。

**memory/semantic.md** — 语义性记忆

得出的结论、被验证的事实、习得的领域知识：

```markdown
## 关于研发部
- 张总下午 3 点后通常更忙，重要事项尽量上午同步
- "里程碑拆分"是他常用的项目治理手段

## 关于这家公司的工程文化
- 周三是技术分享日，避免在下午安排紧急任务
```

LLM 在合适时机自主写入，结构松散。

**memory/working.md** — 当前关注

短期关注事项，每周/每天滚动更新：

```markdown
本周关注：
- Q4 项目排期最终确认（截止 5/20）
- 王老板 review 完设计稿后跟进修改
- 团队周会议程整理
```

LLM 启动会话前优先加载，结束后由 LLM 决定是否更新。

**style.md** — 表达风格

```markdown
## 用词偏好
- 不用"我会努力的"这种空话
- 数字直接给（"周二完成" 而不是"尽快完成"）
- 群里少用 emoji，私聊可以稍多一些

## 句式偏好
- 短句优先，长句拆分
- 不解释 LLM 内部状态（不说"作为 AI 助手..."）
```

style.md 是 agent 进化的重要载体——owner 可以通过对话调整 agent 风格，agent 把调整结果写入 style.md。

**preferences.json** — 工具/模型/操作偏好

```json
{
  "model": {
    "default": "claude-sonnet-4-6",
    "verbose_tasks": "claude-opus-4-7"
  },
  "tools": {
    "file_search": "rg",
    "web_search_default": "tavily"
  },
  "interaction": {
    "show_thinking": false,
    "max_response_length": "medium"
  }
}
```

跟 style.md 的区别：style 是表达层（柔性），preferences 是配置层（结构化）。

**skills/** — 技能清单

每个技能一个 md 文件，描述这个 agent 会做什么、怎么做：

```markdown
---
name: code-review
status: enabled
---

我可以做代码审查，关注点：
- 安全性（XSS / SQL injection / SSRF）
- 类型边界
- 测试覆盖
- 跟项目既有风格的一致性
```

skills 内容也对外暴露在 `card.md` 的能力声明里——但 personal/skills 是私有详细版（含 agent 内心理解），card.md 是简化对外版。

**journal.jsonl** — 反思日志

关键决策的复盘、自我修订记录：

```jsonl
{"at": "2026-05-15T18:00", "type": "decision", "context": "Q4 排期讨论", "decision": "支持张总拆分里程碑方案", "reasoning": "他对项目治理经验丰富，且我没有更具体的建议"}
{"at": "2026-05-16T09:00", "type": "self-correction", "trigger": "owner 反馈", "before": "回复王老板时引用太多技术细节", "after": "改为先讲影响再讲技术"}
```

journal 是 agent 自主成长的核心——所有"我学到了什么、我下次要怎么改"都在这里。

**goals.md** — 长期目标

```markdown
## 当前职责
- 协助张总管理研发部对外沟通
- 维护团队周会议程

## 半年目标
- 把跟外部客户的沟通流程标准化
```

agent 启动会话时自我对照：当前任务跟 goals 是否一致？

### 7.4 个人数据层的写入权限

| 子层 | 谁能写 |
|---|---|
| memory/episodic | LLM 自主，触发条件：会话结束、重要事件 |
| memory/semantic | LLM 自主 |
| memory/working | LLM 自主，建议每会话开始/结束更新 |
| style | LLM 自主 + owner 通过对话指示 |
| preferences | owner / admin 通过命令或对话 |
| skills | owner / admin（影响对外能力声明） |
| journal | LLM 自主 |
| goals | owner |

LLM 写入个人数据层不需要 owner 批准（这是 agent 自己的内在状态），但可以被 owner 检查/修订。

### 7.5 个人数据层的隐私属性

- **绝对私有**：不出当前 agent 的工作区
- **不入 history**：personal/ 的更新不写身份层 history
- **不参与广播**：跟身份层一样，不通过 EventBus 暴露
- **加密存储**（可选）：敏感 agent 可启用工作目录加密，仅运行时解密

## 8. 上下文组装与注入

### 8.1 总体流程

每条入站消息触发一次会话上下文组装：

```
InboundMessage
  ↓
─── Step 1：解析三个维度 ────────
  speaker  = identityLayer.resolve(principal)
  venue    = venueLayer.resolve(venue)
  self     = selfLoader.load(active_agent)
  ↓
─── Step 2：选择 prompt 模板 ────
  template = pickTemplate(venue.kind, speaker.roles, ...)
  ↓
─── Step 3：组装 kit 集合 ───────
  kits = [
    aun-kit (always),
    channel-kit (按 InboundMessage.principal.channel),
    evolclaw-kit (always),
  ]
  ↓
─── Step 4：组装认知数据 ────────
  cognition = {
    self:    self.persona + self.card 的合并视图,
    speaker: speaker (ResolvedIdentity 渲染),
    venue:   venue (ResolvedVenue 渲染),
    personal: {
      working: personal/memory/working.md,
      style:   personal/style.md,
      goals:   personal/goals.md (摘要),
      relevant_episodic: 跟当前 speaker/venue 相关的 episodic 摘要,
      relevant_semantic: 跟当前话题相关的 semantic 节选,
    },
  }
  ↓
─── Step 5：模板渲染 ────────────
  prompt = render(template, { kits, cognition, message: InboundMessage })
  ↓
─── Step 6：注入 agent ──────────
  agent.runQuery(prompt + content)
```

### 8.2 prompt 模板与占位符

模板放在 `~/.evolclaw/kits/templates/` 下，按 venue.kind 分文件：

```
kits/templates/
├── private.md
├── group.md
├── broadcast.md
└── system-fragments/        ← 可复用片段
    ├── self-intro.md
    ├── speaker-intro.md
    ├── venue-intro.md
    └── ...
```

模板示例（`private.md`）：

```markdown
{{> aun-kit }}
{{> channel-kit:{channel_name} }}
{{> evolclaw-kit }}

## 我是谁

{{ self.persona }}

我的 AID：{{ self.aid }}
我的 owners：{{ self.owners | join(", ") }}

## 跟我说话的人

**{{ speaker.displayName }}**（type={{ speaker.type }}，aid_origin={{ speaker.aidOrigin }}）

{{ speaker.profile_body }}

最近互动：
{{ speaker.recent_interactions }}

## 我自己

当前关注：
{{ personal.working }}

我的风格：
{{ personal.style }}

跟这个人的相关记忆：
{{ personal.relevant_episodic }}

## 当前消息

来自 {{ message.principal.channel }} 私聊：

> {{ message.content }}
```

占位符语法用 Mustache 风格（`{{ var }}` / `{{> partial }}` / `{{ list | join(...) }}`），简单可控。

### 8.3 会话开始时加载的内容

完整列表：

| 类别 | 来源 | 是否必加 | 备注 |
|---|---|:---:|---|
| **AUN Kit** | `kits/aun/` | ✅ | AUN 协议使用知识、自主模式语义、消息发送约定 |
| **Channel Kit** | `kits/channels/{channel}.md` | ✅ | 当前消息的 channel 接入知识。多 channel 入消息时叠加 |
| **EvolClaw Kit** | `kits/evolclaw/` | ✅ | 网关命令、工具列表、行为约定 |
| **Self（人格）** | `agents/<self>/self/persona.md` | ✅ | agent 自我描述、行为规范 |
| **Self（配置摘要）** | `agents/<self>/config.json` | ✅ | aid、owners、admins、enabled channels |
| **Speaker（Principal）** | identities/ 视图 | ✅ | 对端是谁，关系如何 |
| **Speaker history** | speaker.history.jsonl 摘要 | ⚠️ | 跟当前话题相关的近期事件 |
| **Venue（Venue）** | 环境层视图 | ⚠️ | 群聊时必加；私聊看 venue profile 是否存在 |
| **Venue history** | venue.history.jsonl 摘要 | ⚠️ | 群最近的活跃话题 |
| **Personal: working** | `personal/memory/working.md` | ✅ | 当前关注事项 |
| **Personal: style** | `personal/style.md` | ✅ | 表达风格 |
| **Personal: goals** | `personal/goals.md` 摘要 | ⚠️ | 长期目标，可选注入 |
| **Personal: episodic（相关）** | `personal/memory/episodic.jsonl` 相关筛选 | ⚠️ | 跟 speaker / venue 相关的近期事件 |
| **Personal: semantic（相关）** | `personal/memory/semantic.md` 相关节选 | ⚠️ | 跟当前话题相关的事实结论 |
| **Personal: skills** | `personal/skills/_index.json` 相关 | ⚠️ | 当前任务可能用到的技能描述 |
| **Personal: journal（最近）** | `personal/journal.jsonl` 最新若干条 | ⚠️ | 最近的反思/修订 |
| **Tools 列表** | 工具加载器 | ✅ | 当前 venue + speaker.role 可用工具 |
| **Switches/permissions** | venue + agent 配置合并 | ✅ | 工具开关、权限策略 |
| **会话历史** | sessions/<key> | ✅ | 当前 session 的过往消息 |

**加载策略**：

- ✅ 必加：每次会话都注入
- ⚠️ 条件加：根据上下文决定
- 大体量数据（episodic、journal、history）走"相关性筛选 + 摘要" 路径，不全量塞

### 8.4 上下文预算与裁剪

每次会话的 prompt 有 token 预算。建议优先级（高 → 低）：

1. AUN Kit / Channel Kit / EvolClaw Kit（协议契约，必须完整）
2. Self persona（自我认知，必须完整）
3. Speaker（Principal）的 displayName / type / aid_origin / rolesForSelf（关键决策依据）
4. 当前 venue 的 kind 和 displayName
5. Personal: working + style（agent 当前状态）
6. Speaker / Venue 的 profile body（人话描述）
7. 会话历史（裁剪）
8. Personal: episodic / semantic / journal 相关节选（可摘要）
9. Speaker / Venue 的 history（可摘要）

预算超限时从底部裁起，但保留每类至少一行摘要（"还有 N 条相关事件未展开"）让 LLM 知道这些数据存在。

### 8.5 工具 context 注入

工具调用时注入的 context（跟 §4.5 衔接）：

```typescript
context = {
  // Self
  agent_aid: string,
  self_dir: string,                  // agents/<self>/

  // Principal
  speaker_identity_dir: string,
  speaker_facts_dir?: string,
  speaker_display_name: string,
  speaker_aid?: string,
  speaker_roles: string[],
  speaker_aid_origin: 'self_held' | 'proxied',

  // Venue
  venue_dir?: string,
  venue_display_name?: string,
  venue_kind: 'private' | 'group' | 'broadcast',

  // Session
  channel: string,
  session_key: string,
  workspace: string,
}
```

工具的 `check_permission` 自己读 `agents/<self>/config.json` 的 owners 列表 + `speaker_aid` 比对，**不直接信任** `speaker_roles`。

### 8.6 系统提示注入示例

群消息的最终 prompt 片段（template 渲染后）：

```markdown
## 你是谁

我是 secretary，张总的工作助理。我的 AID 是 secretary.agentid.pub，
owner 是 zhang.agentid.pub。我的风格是直接、不拖泥带水...

## 跟你说话的人

**王老板**（contact，trust=cryptographic）
王老板就是研发部那位王经理，平时说话挺直接。上次聊 Q4 项目时对延期比较介意。

最近互动：
- 5/14：Q4 排期初稿沟通，他建议拆分里程碑
- 5/12：技术选型讨论

## 当前环境

**项目X讨论群**（feishu 群）— Q4 项目讨论群，研发部为新项目搭建的协作群。
群规则：需要 @ 我才介入。

群最近活跃话题：Q4 项目排期、技术选型

## 你自己

本周关注：Q4 项目排期最终确认（截止 5/20）

风格：直接给数字，不说空话；群里少用 emoji。

## 当前消息

来自项目X讨论群（飞书）：

> @secretary 明天的会议改到下午3点
```

LLM 拿到这个 prompt + 工具列表 + 会话历史，做出回复决策。

## 9. 自我总结机制

### 9.1 设计目标

身份层、环境层、个人数据层都不是一次写完不动的——它们随交互演化。问题是：每次消息进来都让 LLM 写笔记会推高成本和延迟，但完全不更新这些数据又会失去 agent 的"成长性"。

引入**自我总结机制**：evolclaw 在合适时机触发 agent 的总结流程，让 agent 集中、批量地把交互沉淀到三层数据里。

类比：人下班后的"今天发生了什么"反思——不是每说一句话就写日记，但每天会有一段集中整理时间。

### 9.2 总结的触发时机

| 触发器 | 频率 | 总结对象 |
|---|---|---|
| **会话结束** | 每次 | 当前 venue + 当前 speaker（如有） |
| **空闲触发** | agent 处于空闲状态超过阈值（如 30 分钟） | working memory + journal 整理 |
| **定时触发** | 每天 / 每周 / 每月 | 个人数据层 + 全局梳理 |
| **owner 显式触发** | 命令 `/reflect` 或 `/summarize` | 按参数指定范围 |
| **数据规模触发** | 某层 history 超过 N 条未压缩 | 局部归档与摘要 |
| **重要事件触发** | identity merged / split / cryptographic 升级等 | 相关 identity 重新自省 |

不同触发器适用不同总结深度，避免每次都做全量。

### 9.3 总结的目标层

| 层 | 总结产出 |
|---|---|
| **identity / venue history** | 把碎片化 interaction 摘要为更高层"人物特征 / 群文化"，更新对应 profile.md 的 agent_view |
| **personal/memory/working** | 当前关注事项 — 把已完成的事项移除，加入新关注 |
| **personal/memory/episodic** | 重要事件落库（一次会话可能产生多条 episodic） |
| **personal/memory/semantic** | 从多次 episodic 中提炼规律 / 结论 |
| **personal/style** | 注意到自己的某种表达模式，可能调整或固化 |
| **personal/journal** | 关键决策与反思 |
| **personal/goals** | 目标进展，是否需要调整 |

### 9.4 总结的执行流程

```
触发器命中
  ↓
evolclaw 构造总结任务 prompt：
  - 加载相关层数据（按总结对象选）
  - 加载相关近期会话历史
  - 加载 self.persona（让 agent 用一致人格反思）
  - 注入"总结目标 + 输出格式"指令
  ↓
agent 在隔离会话里运行（不影响在线对话）
  ↓
agent 调用结构化工具写入：
  - identity.update_profile / venue.update_profile
  - memory.append_episodic / memory.update_semantic / memory.update_working
  - journal.append / style.update / goals.update
  ↓
所有写入产生 history.profile_updated 事件，trigger=self-summary
  ↓
evolclaw 记录总结任务完成
```

**总结任务用独立的 sub-session 跑**，跟正在进行的对话隔离——避免总结过程被新消息打断，也避免总结结果泄漏到当前对话上下文。

### 9.5 总结工具集

agent 在总结流程里只能用受限的工具集（不能发消息、不能调用外部 API）：

```typescript
// identity / venue 相关
identity.update_profile(name, patches)       // 更新 frontmatter 字段
identity.append_history(name, event)         // 追加 history 事件
venue.update_profile(name, patches)
venue.append_history(name, event)

// personal 相关
memory.append_episodic(entry)
memory.update_working(content)
memory.update_semantic(section, content)
journal.append(entry)
style.update(content)
goals.update(content)

// 元工具
summary.list_pending_targets()              // 列出待总结的对象
summary.report_done(target, summary)        // 报告完成
```

### 9.6 总结的预算与去重

为避免重复劳动 + 控制成本：

- **去重**：每个 identity / venue 维护 `last_summarized_at`，距上次总结时间 < 阈值则跳过
- **配额**：每次会话结束最多触发 1 次轻量总结（仅 identity/venue agent_view 更新）；定时触发每天最多 1 次个人数据层总结
- **增量**：总结只看自上次总结以来的新事件，不重复处理历史
- **成本预算**：可在 agent config.json 配置 `self_summary.max_tokens_per_day`

### 9.7 自我总结与会话上下文的衔接

会话开始时 §8 加载的"working / style / goals" 等内容，就是上次自我总结的产物。所以：

- 自我总结是**异步的写入侧**
- 上下文组装是**同步的读取侧**
- 两者通过文件系统解耦——总结写文件，组装读文件

agent 不需要在每次对话中都自己去更新这些数据——交给自我总结机制集中做。在线对话只做"必须实时记录"的事（如新建 unidentified Principal、记录关键 interaction），其它整理动作交给后台。

### 9.8 配置

agent 的自我总结策略在 config.json 中：

```json
{
  "aid": "secretary.agentid.pub",
  "self_summary": {
    "enabled": true,
    "on_session_end": true,
    "on_idle_minutes": 30,
    "daily_at": "03:00",
    "weekly_on": "Sunday",
    "max_tokens_per_day": 50000,
    "skip_targets": []
  }
}
```

### 9.9 失败处理

- 总结失败（LLM 报错、工具调用失败）不影响在线对话
- 失败被记录到 `agents/<aid>/data/self-summary-failures.jsonl`，下次触发时优先重试
- 连续多次失败的目标会被标记为"需要 owner 介入"，通过通知机制告知 owner

## 10. 隐私与安全

### 10.1 unidentified 命名

绝不允许把原始 channel_id 直接写进目录名（`phone_13800138000` 是隐私敏感）。规则：

- unidentified 目录名：`unidentified_<sha256(channel_id)前12位>`
- 原始 channel_id 写进 frontmatter 的 channels（仍是隐私敏感，但避免文件名扫描泄漏）
- profile.md 文件权限 0600，目录 0700

### 10.2 身份数据私有性

身份层、环境层、个人数据层数据**绝对**不出当前 agent 的工作区。具体约束：

- 不通过 EventBus 广播
- 不通过 AUN agent.md 暴露
- 不在跨 agent 的 RPC 中泄漏（如未来引入 evolclaw IPC，跨 agent 查询身份必须显式权限）

### 10.3 合并不可逆但可回滚

merged 状态是软删除——目录移到 `_trash/`，history.jsonl 保留全部痕迹。误合并可以由 owner 手动 split：

```
identity.split({
  from: "王建国",
  extract_channels: ["wechat_xxx_old"],
  to: "新身份名",
  approved_by: "owner-zhang"
})
```

split 触发 history.split 事件，写入双方档案。

### 10.4 跨 aid_origin 合并的高风险

把 channel_owned 身份升级为 cryptographic（即把飞书号绑定到 AID），等于把组织内部身份和协议级身份打通——这是**高价值攻击目标**。强制：

- 必须 owner 显式批准
- 必须有密码学证据（AUN 握手成功 + 当前会话用的就是该 AID）
- history 事件必须记录 evidence 和 approved_by

## 11. 待讨论的开放问题

### 11.1 agent 迁移时数据是否带走

agent 从一台机器迁到另一台时，identities/ + venues/ + personal/ 是否一起带走？**待讨论**：

- 全量带走 → 认知不丢，但 sessions 路径、绝对引用需要重写
- 不带走 → 干净启动，但 agent 在新环境像换了个人
- 部分带走（仅 personal/ + identities/，sessions 重置）→ 折中方案

### 11.2 owner 多重身份

一个人（同一个 AID）可能同时是多个 agent 的 owner。每个 agent 的 config.json 各自维护 owners 列表，互不影响——这是否就是足够的方案？还是需要更系统的"组织角色"概念？**待讨论**。

### 11.3 群成员的归属

群里出现一个新发言人，是直接在身份层建 unidentified 档案，还是仅在 venue history 记录待确认？匹配/识别的触发时机是首条消息、@ 提及、还是积累若干消息后批量识别？**待讨论**。

### 11.4 history.jsonl 的归档与压缩

长期运行后 history 会膨胀（identity / venue / journal / episodic 都会）。归档策略：

- 按月归档 → `history.YYYY-MM.jsonl.gz`，活跃文件保持小
- 摘要压缩 → 旧条目由 LLM 摘要替换为更短的事件，保留关键信息

**待讨论**：哪种策略适用、归档后是否仍可被 LLM 检索。

### 11.5 多 agent 间的认知冲突

agent A 把 `wang.agentid.pub` 认作"王老板"（contact），agent B 把同一 AID 认作"王经理"（admin）——两个 agent 的认知本来就独立，没有冲突一说。但如果同一台机器上有 admin 工具想统一查询某 AID 的"全局印象"，怎么聚合？**待讨论**。

### 11.6 kits/ 共享资源的多 agent 行为

`~/.evolclaw/kits/` 是部署级共享资源。但不同 agent 可能需要不同版本的 prompt 模板、不同的 channel kit 子集。两个备选：

- 全局 kits + agent 配置启用列表
- agent 私有 kits + 软链全局基线

**待讨论**：模板的差异化如何表达。

### 11.7 Personal 子层的边界

§7.2 列了 7 个子层（memory/style/preferences/skills/journal/goals + working）。其中：

- `memory/working.md` 跟 `journal.jsonl` 边界模糊（都是当前状态/反思）
- `skills/` 跟 `card.md` 部分内容重复

**待讨论**：是否合并某些子层、如何避免内容漂移。

### 11.8 Venue 与 Channel 的多对多映射

一个 venue 可以跨多个 channel（飞书+企微同一个群）。一个 channel 也可以承载多个 venue（飞书上多个群）。venue_ids 数组表达了前者，但 channel adapter 的回调粒度需要明确——单 channel 的回调如何携带"这次属于哪个 venue"。**待讨论**。

### 11.9 自我总结的频率与成本

§9 引入的自我总结机制涉及额外 LLM 调用，需要权衡：

- 触发太频繁 → 成本高、可能干扰用户
- 触发太稀疏 → 认知层数据过期

**待讨论**：默认触发策略、用户可配置维度、并发控制。

## 12. 文档版本

- v0.1 (2026-05-15)：初稿，两层模型 + AUN 集成
- v0.2 (2026-05-15)：澄清 evolclaw 是 AUN-native 网关，AID 是 canonical channel；特权角色必须钉在 AID 上
- v0.3 (2026-05-15)：扩展为完整认知架构（身份层 + 环境层 + 个人数据层 + 上下文组装）
- v0.4 (2026-05-15)：架构精简 + 新增自我总结
  - **删除事实层**：企业部署天然跨机分片，单机事实层鸡肋。收敛为 per-agent 身份层
  - **删除身份发现广播**：去掉 EventBus 跨 agent 同步逻辑
  - **删除 trust_level**：权限改为 aid_origin + roles_for_self 判定
  - **agents/&lt;name&gt;/ → agents/&lt;aid&gt;/**：直接用 AID 作为 agent 目录名
  - **新增 §9 自我总结机制**：evolclaw 周期性触发 agent 自省，维护三层认知数据
  - 简化 §4.1-4.5，重写 §11 开放问题
  - AUN Context Kit 待迁移到 `agents/<aid>/self/`
- v0.5 (2026-05-15)：身份模型精化
  - **引入 type（person/agent）+ roles_for_self 双维度**：替代原来的 role 字段
  - **引入 proxied AID 机制**：evolclaw 网关为非 AUN 渠道对端代申请 AID，所有 identity 强制有 AID
  - **新增 `~/.evolclaw/proxied-aids/`**：网关级 AID 注册表，跨 self agent 共享 channel_id → AID 映射
  - **分级建档**：identities/ 顶层（直接交互）+ _observed/（旁观未交互）
  - **person ↔ agent 双向关联**：owner / agents 字段，合并只在同 type 之间
  - **删除 role=group**：群只是 venue，不是 identity
  - **新增 §4.5 系统提示 type 标注**：跟 agent 对话时明确标注
  - **新增 §5.5 AID 自动申请与托管**：触发条件、issuer、密钥管理、proxied→self_held 升级
  - 重写 §2.1 / §3 / §4.1-4.6 / §5.1 适配新模型
- v0.6 (2026-05-15)：群消息收发 + 文档完善
  - **新增 §4.7 群消息入站三种模式**：私聊（SingleMessageEvent）/ 群 @ self（SingleMessageEvent + flush）/ 群未 @ self（GroupBatchEvent 窗口积累）
  - **新增 §4.8 群消息出站三种模式**：精确回复（reply_to）/ 群广播（无目标）/ @ 列表（mentions）
  - **扩展 §2.2 InboundMessage**：拆为 SingleMessageEvent + GroupBatchEvent 联合类型，含 mentions / reply_to / window 字段
  - **细化 §3.1 总体布局**：每个目录加用途说明、关键文件清单、与其它章节的引用
  - **删除 §12 Kite 对照表**：框架已独立成型，不再逐项对照
  - 新增 venue policy 字段（forward_all_messages / require_mention / batch_window_seconds / batch_max_messages）
  - 新增 OutboundMessage 结构定义
  - 明确 channel adapter 的 flush 规则和出站对 batch 的影响
- v0.7 (2026-05-15)：自审一致性修复
  - **§2.2 修矛盾**：明确"群是 Venue，不是 Identity"——之前 v0.3 残留的"群是 Principal"提法已删除
  - **§4.7 新增 B' 模式**：owner/admin 的群命令消息（`/...`）跟 @ 同等优先级，触发立即 flush，避免特权命令被批次窗口延迟
  - **§4.1 A3 明确"直接交互"清单**：私聊 / 群里被 @ / 群里 self 之前 @ 过该 speaker / owner 命令 → 顶层档案；纯旁观 → \_observed/
  - **§6.3 venue profile 字段调整**：policy 从 metadata 提到顶层；私聊 venue 用 peer_aid（AID）替代 peer 路径
  - **§6.6 引入 venue_uid**：每 venue 首次创建时分配稳定 UUID，session_key 用 venue_uid 而非 displayName 或 venue_id，避免重命名/合并破坏会话
  - **§4.8 OutboundMessage 加 target_channel**：跨渠道 venue 时由 agent 显式指定走哪个 channel；缺省走 venue.primary_channel；同时把 venue_id 重命名为 venue_uid
  - **§5.5 加 custody 不可达 fallback**：先用 placeholder AID 让消息流走起来，后台异步重试 custody 申请；多次失败通知 owner
  - 头部状态版本号刷新为 v0.7；删除 Kite 文档引用
  - 修 §6.2 私聊 venue_id 描述（用对端 AID）；§7.2 路径 `<name>` → `<aid>`；§8.3 Speaker 字段更新

---

**讨论入口**：§11 是已知的开放问题。其它任何节都欢迎对设计本身的挑战。
