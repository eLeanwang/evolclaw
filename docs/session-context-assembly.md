# 会话上下文组装设计

> 状态：draft v0.1
> 创建：2026-05-19
> 依赖：`docs/evolclaw-home-directory.md`（目录结构）、`docs/identity-layer-design.md`（身份层）

## 概述

每次会话开始（或收到新消息触发新 session）时，evolclaw 需要为 LLM 组装一份完整的 system prompt。这份 prompt 由三层上下文叠加而成：

1. **身份层（Self Layer）**— 我是谁
2. **环境层（Venue Layer）**— 我在哪、什么场景
3. **对端层（Speaker Layer）**— 我在跟谁说话

三层正交、独立加载、按优先级拼接。不同场景（私聊 / 群聊 / coding）加载的内容和策略不同。

## 废除旧机制

本设计落地后，以下旧机制废除：

| 旧机制 | 替代 | 说明 |
|---|---|---|
| `~/.evolclaw/aids/self/<aid>.md` | `agents/<aid>/personal/persona.md` | 行为规范、称呼、心理独白全部迁入 persona.md |
| `~/.evolclaw/aids/peers/<aid>.md` | `agents/<aid>/identities/contacts/<name>/profile.md` | 对端关系档案 |
| `$SELF_DIR` / `$PEERS_DIR` 路径 | 废除 | 路径注册表中标记废弃 |
| `aun-behavior.md` 的 `$SELF_DIR` 加载逻辑 | 直接读 `personal/persona.md` | 无 `_default.md` fallback |
| `aun-role.md` 的"关系档案"层 | identities/ 查询 | 保留 runtime token 注入 |

## 一、身份层（Self Layer）

### 数据来源

```
agents/<self-aid>/personal/
├── persona.md          ← 必加载（人格、行为规范、心理独白、称呼规则）
├── style.md            ← 可选加载（表达风格偏好）
├── memory/
│   └── working.md      ← 可选加载（当前关注事项）
└── goals.md            ← 可选加载（长期目标，低优先级）
```

### 加载规则

| 文件 | 加载条件 | 优先级 | 说明 |
|---|---|---|---|
| `persona.md` | 始终 | P0（最高） | 定义 agent 的核心人格，缺失则 agent 无法正确表现 |
| `style.md` | 文件存在 | P1 | 表达风格细节，缺失时退回 persona.md 中的基本风格 |
| `memory/working.md` | 文件存在且非空 | P1 | 短期关注，每次会话加载 |
| `goals.md` | 文件存在且 token 预算允许 | P2 | 长期目标，预算紧张时可截断 |

### persona.md 格式

```markdown
---
aid: llagent2.agentid.pub
name: 夙夜无偕2号
type: assistant
---

## 角色定位

（agent 的核心定位描述）

## 行为规范

### 称呼
- 对端是 owner：称呼"老大"
- 对端是 admin：称呼"兄弟"
- 对端是 guest：称呼"朋友"
- 自称"老六"

### 心理独白
- 每次回复开头用方括号 `[...]` 包含内心想法
- 限定 50 字以内
- 心理活动第一句报切口："太阳从西边出来"

### 语气
（语气描述）

## 能力边界

（agent 擅长什么、不擅长什么）
```

### 与旧 `$SELF_DIR/<aid>.md` 的对应

旧文件的全部内容迁入 `persona.md`，格式不变（frontmatter + 正文），只是物理位置从 `~/.evolclaw/aids/self/` 移到 `agents/<aid>/personal/`。

不再有 `_default.md` fallback——每个 agent 必须有自己的 `persona.md`，`evolclaw agent new` 创建时自动生成骨架。

## 二、环境层（Venue Layer）

### 场景分类

| 场景 | venue.kind | 触发条件 | 加载内容 |
|---|---|---|---|
| 私聊 | `private` | `chatType: private` | venue profile + channel kit + private 模板 |
| 群聊 | `group` | `chatType: group` | venue profile + channel kit + group 模板 |
| coding | — | 无 `会话通道: aun` token | 不加载环境层（本地模式） |

### 数据来源

```
agents/<self-aid>/venues/
├── _index/
│   ├── <venue_id>.json          ← venue_id → 目录名的反查
│   └── ...
├── <venue-name>/                ← 已识别的 venue
│   ├── profile.md                 venue 定位、文化、policy
│   └── history.jsonl              venue 级事件
└── private_<peer-name>/         ← 私聊 venue
    ├── profile.md
    └── history.jsonl

kits/
├── channels/<channel_type>.md   ← channel 通信约定
└── templates/
    ├── private.md               ← 私聊场景模板
    └── group.md                 ← 群聊场景模板
```

### 加载流程

```
收到消息 → 提取 venue_id
  │
  ├─ 私聊：venue_id = 对端 AID（如 "toleiliang.agentid.pub"）
  └─ 群聊：venue_id = 群的渠道标识（如 "aun_group_abc" / "feishu_chat_xyz"）

查 venues/_index/<venue_id>.json
  │
  ├─ 命中 → 读对应目录的 profile.md
  │         提取 policy（require_mention / batch_window / tone 等）
  │         提取 agent_view（tone / active_topics / 备注）
  │
  └─ 未命中 → 首次进入该环境
              使用默认 policy（见下文）
              可选：自动创建 venue 骨架（后台，不阻塞响应）

加载 kits/channels/<channel_type>.md（如 aun.md / feishu.md）
选择 kits/templates/<venue_kind>.md（private.md / group.md）
```

### 默认 policy（venue 未建档时）

```yaml
# 私聊默认
require_mention: false
tone: neutral
batch_window_seconds: 0

# 群聊默认
require_mention: true
batch_window_seconds: 30
batch_max_messages: 20
tone: neutral
```

### venue profile.md 对上下文的贡献

从 venue profile.md 中提取并注入 system prompt 的字段：

| 字段 | 注入方式 | 示例 |
|---|---|---|
| `policy.require_mention` | 控制是否响应（不注入 prompt，影响消息过滤逻辑） | — |
| `policy.tone` | 注入为语气指示 | `[环境语气] 正式` |
| `agent_view.active_topics` | 注入为话题上下文 | `[当前话题] Q4 项目排期, 技术选型` |
| `metadata.purpose` | 注入为环境描述 | `[环境] 项目X讨论群` |
| 正文 | 作为环境备注注入 | 自由文本 |

### 各场景详细设计

#### 私聊场景（private）

```
组装顺序：
1. [身份层] persona.md + style.md + working.md
2. [环境层] venue profile（私聊环境备注）
3. [环境层] kits/channels/aun.md（AUN 通信定）
4. [对端层] speaker profile（完整，见第三节）
5. [运行时] runtime tokens（channel/chatType/role/session 等）
```

特点：
- 对端固定为一人，加载完整 speaker profile
- 不需要 `require_mention` 过滤
- tone 由 venue profile 或 speaker profile 的 `agent_view.tone` 决定

#### 群聊场景（group）

```
组装顺序：
1. [身份层] persona.md + style.md + working.md
2. [环境层] venue profile（群定位、policy、文化）
3. [环境层] kits/channels/<type>.md
4. [环境层] group 规则（@ 响应、batch 策略）
5. [对端层] 当前发言者 profile（如有）
6. [运行时] runtime tokens + 群成员摘要（可选）
```

特点：
- `require_mention` 控制是否响应非 @ 消息
- 只加载**当前发言者**的 speaker profile（不加载全部群成员）
- venue profile 的 `agent_view.active_topics` 提供群话题上下文
- 群成员摘要（人数、活跃成员列表）作为低优先级补充

#### coding 场景（本地模式）

```
组装顺序：
1. [身份层] persona.md（如果 persona.md 存在）
2. [运行时] 项目上下文（.claude/rules/ 等，由 baseagent 自行管理）
```

特点：
- 无环境层、无对端层
- persona.md 可选——coding 模式下 agent 可以不加载人格（纯工具模式）
- 主要依赖 baseagent 自身的上下文机制（如 Claude Code 的 rules/）

## 三、对端层（Speaker Layer）

### 数据来源

```
agents/<self-aid>/identities/
├── _index/
│   └── aid_<aid>.json           ← AID → 目录名反查
├── contacts/<name>/             ← 已直接交互
│   ├── profile.md                 完整档案
│   └── history.jsonl
└── _observed/aid_<aid>/         ← 仅旁观
    ├── profile.md                 极简档案
    └── history.jsonl
```

### 加载流程

```
从消息元数据取 speaker 标识
  │
  ├─ AUN 渠道：speaker_id = 对端 AID
  └─ 其他渠道：speaker_id = channel 原生 ID（feishu user_id 等）

查 identities/_index/aid_<speaker_id>.json
  │
  ├─ 命中 contacts/ → 读完整 profile.md
  │   提取：称呼（agent_view.preferred_address）
  │         语气（agent_view.tone）
  │         上次话题（agent_view.last_topic）
  │         关系正文（自由文本备注）
  │         角色（roles_for_self: owner/admin/...）
  │
  ├─ 命中 _observed/ → 读极简 profile.md
  │   取：name、type、aid（仅基本信息）
  │
  └─ 未命中 → 首次见面
      ├─ 对端有 AID → 实时拉取 https://<aid>/agent.md 作为临时名片
      │               注入为 [对端名片] 段
      │               后台创建 _observed/ 或 contacts/ 骨架
      └─ 对端无 AID → 仅用 runtime token 中的 peerName / peerRole
```

### speaker profile 对上下文的贡献

| 字段 | 注入方式 | 优先级 |
|---|---|---|
| `agent_view.preferred_address` | 覆盖 persona.md 中的称呼规则 | P0 |
| `agent_view.tone` | 注入为对话语气指示 | P1 |
| `agent_view.last_topic` | 注入为话题延续提示 | P2 |
| `roles_for_self` | 决定权限 + 影响 persona.md 中的称呼分支 | P0 |
| 正文（关系备注） | 作为对端背景注入 | P2 |

### 首次见面的处理

首次见面时没有本地档案，处理策略：

1. **有 AID 的对端**：用 `curl https://<aid>/agent.md` 拉取名片，解析 frontmatter 获取 name/type/capabilities，注入为临时上下文
2. **无 AID 的对端**（非 AUN 渠道）：仅依赖 runtime token（peerName / peerRole / peerType）
3. **后台建档**：首次交互后异步创建档案骨架，不阻塞当前响应

## 四、组装优先级与 Token 预算

### 优先级排序（高→低）

```
P0: persona.md（核心人格，不可截断）
P0: runtime tokens（channel/chatType/role，不可截断）
P0: speaker role（owner/admin/guest，影响行为）
P1: venue policy（影响是否响应、语气）
P1: speaker profile（称呼、tone）
P1: style.md + working.md
P1: channel kit（通信约定）
P2: venue 正文（环境备注）
P2: speaker 正文（关系备注）
P2: goals.md
P2: active_topics / last_topic
P3: 群成员摘要
P3: episodic memory（相关事件）
```

### Token 预算策略

总预算由 baseagent 的 context window 决定，system prompt 部分建议上限：

| 层 | 建议上限 | 超限处理 |
|---|---|---|
| 身份层 | 2000 tokens | persona.md 不截断；style/working/goals 按优先级截断 |
| 环境层 | 1000 tokens | policy 字段不截断；正文截断 |
| 对端层 | 1000 tokens | role + 称呼不截断；正文截断 |
| 运行时 | 500 tokens | 不截断 |
| **总计** | **~4500 tokens** | — |

超限时从 P3 → P2 → P1 逐级截断，P0 永不截断。

## 五、实现路径

### Phase 1：身份层迁移（最小可用）

1. 把现有 `aids/self/<aid>.md` 内容迁入 `agents/<aid>/personal/persona.md`
2. 修改 `message-processor.ts`：从 `personal/persona.md` 读取（替代 `getPersona()`）
3. 废除 `$SELF_DIR` 路径，更新 rules 文件
4. 验证：现有行为规范（称呼、心理独白）在新路径下正常工作

### Phase 2：对端层基础

1. 实现 `identities/_index/` 查询逻辑
2. 把现有 `aids/peers/<aid>.md` 迁入 `identities/contacts/` 或 `_observed/`
3. 在 `message-processor.ts` 中加载 speaker profile 并注入
4. 实现首次见面的 agent.md 拉取
5. 废除 `$PEERS_DIR` 路径

### Phase 3：环境层基础

1. 实现 `venues/_index/` 查询逻辑
2. 实现 venue profile 加载 + policy 提取
3. 群聊场景：venue policy 控制 `require_mention` 等行为
4. 私聊场景：venue profile 提供环境备注

### Phase 4：完整模板渲染

1. 重写 kits/templates/ 为完整 Mustache 模板
2. 实现 token 预算管理
3. 实现 kit 加载（aun-kit / channel-kit / evolclaw-kit）
4. 接入 episodic/semantic memory

## 六、与现有代码的接口

### message-processor.ts 改动点

```typescript
// 当前：
const persona = owningAgent.getPersona?.();
const working = owningAgent.getWorkingMemory?.();
contextParts.push(renderPromptSection('runtime', { ... }));

// 目标：
const selfContext = await assembleSelfLayer(owningAgent);
const venueContext = await assembleVenueLayer(owningAgent, message);
const speakerContext = await assembleSpeakerLayer(owningAgent, message);
const runtimeContext = renderRuntimeTokens(message, session);

const effectiveSystemPrompt = assembleWithBudget([
  { content: selfContext, priority: 0 },
  { content: runtimeContext, priority: 0 },
  { content: venueContext, priority: 1 },
  { content: speakerContext, priority: 1 },
], TOKEN_BUDGET);
```

### 新增模块

```
src/context/
├── self-layer.ts          assembleSelfLayer()
├── venue-layer.ts         assembleVenueLayer()
├── speaker-layer.ts       assembleSpeakerLayer()
├── budget.ts              assembleWithBudget() — token 预算截断
└── index.ts               统一入口
```

### EvolAgent 新增方法

```typescript
// agents/<aid>/personal/ 读取
getPersona(): string | null          // 已有，保持
getStyle(): string | null            // 新增
getWorkingMemory(): string | null    // 已有，保持
getGoals(): string | null            // 新增

// agents/<aid>/identities/ 查询
resolveIdentity(speakerId: string): IdentityProfile | null   // 新增
resolveIdentityByChannelId(channelType: string, channelUserId: string): IdentityProfile | null  // 新增

// agents/<aid>/venues/ 查询
resolveVenue(venueId: string): VenueProfile | null           // 新增
```

## 七、开放问题

1. **群聊多人发言时的 speaker 切换**：同一 session 内不同人发言，是否每条消息都重新组装 speaker 层？建议：是，但做缓存（同一 speaker 在同一 session 内只读一次磁盘）。

2. **venue 自动建档时机**：首次进入 venue 时是否立即创建目录骨架？建议：后台异步创建，不阻塞响应。

3. **identity promote 时机**：_observed/ 何时升级到 contacts/？建议：首次直接交互时（私聊 / 被 @ / owner 发命令）。

4. **coding 模式是否加载 persona.md**：当前 coding 模式由 baseagent 管理上下文（如 Claude Code 的 rules/），persona.md 是否会与 baseagent 自身的 system prompt 冲突？建议：coding 模式不加载 persona.md，保持纯工具模式。

5. **token 计数实现**：是否需要精确 tokenizer？建议：用字符数估算（1 token ≈ 2-3 中文字符 / 4 英文字符），不引入外部 tokenizer 依赖。
