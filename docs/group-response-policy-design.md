# 群聊响应策略体系设计（Group Response Policy）

> 草案 v1 — 讨论用。涵盖：三级规则合并机制、规则参数全集、成员影响力模型、规则文件格式、代码消费路径。
> 末尾「开放问题」列出需拍板项。

---

## 1. 背景与目标

### 现状（已核实）
- 群聊消息**逐条即时处理**：`message-bridge.ts:220` 走 `else` 分支直接入队，agent 空闲即 `processNext`。无攒批、无数量/字节/静默阈值。
- 唯一的群级行为开关是 **dispatchMode**（`mention`/`broadcast`），且已经是三层取值：
  agent `config.json` 默认 → `session.metadata.dispatchMode` 覆盖 → 服务器 `dispatch_mode` 兜底（`aun.ts:1241`）。
- 被 @ 只在 channel 层决定「是否响应」（`aun.ts:1280`），**不影响处理时机**。
- venue 层目录（`agents/<aid>/venues/`）存在但是空骨架；群级配置、成员影响力**均无存储与实现**。

### 目标
把"群里何时、对谁、以何种节奏响应"从写死的逻辑，改成**一份声明式规则**——由三级来源**字段级合并**而成，代码只消费合并后的最终规则。规则覆盖：队列机制、攒批触发、动态超时、成员打标与影响力加权。

设计原则：**复用现有 manifest 的 base+override 合并范式**，不另起一套；规则可 dump 到 `eck-debug` 便于调试（沿用现有模式）。

---

## 2. 概念与命名梳理

你最初的三级命名（1 agent本地群响应规则 / 2 群响应规则 / 3 本地全局群响应规则）语义对，但名字易混。正名如下：

| 级别 | 正式名 | 英文 key | 含义 | 谁来配 | 存储 |
|---|---|---|---|---|---|
| **L1** | **本群策略** | `agentVenuePolicy` | 这个 agent 针对**某个具体群**的响应策略 | agent 自己（本地）| `agents/<aid>/venues/<venueKey>/policy.json` |
| **L2** | **Agent 群默认策略** | `agentGroupDefault` | 这个 agent 对**所有群**的跨群默认（不分具体群）| agent 自己（本地）| `agents/<aid>/group-policy.json` |
| **L3** | **全局默认策略** | `globalDefaultPolicy` | 打包自带的兜底默认 | EvolClaw 内置 | `kits/policies/group-policy.default.json` |

**优先级：L1 > L2 > L3**（高级别字段覆盖低级别）。默认安装只有 L3。

> **三层全部本地、全部由 agent 自己掌控**——没有任何外部方（群、群主）能注入策略。这是刻意的：agent 的每次响应都消耗 token、产生成本，**响应策略必须是 agent 的自主决定**，不能被群驱使。群不持有对 agent 行为的配置权。
>
> 三层是同一套策略在「具体群 → 跨群默认 → 全局兜底」三个粒度上的覆盖：agent 想对某个群特殊对待就写 L1，想统一调整自己在所有群的风格就改 L2，都不动就吃 L3。

> **命名一致性**：venueKey 沿用 relations 的 peerKey 编码 `<channel>#<urlEncode(venueId)>`（如 `aun#grp_xxx`、`feishu#oc_xxx`），与 `04-relation.md`/`05-venue.md` 统一。

### 2.1 为什么不设「群公约」级

早期草案曾有一层「群公约」（群主设定、全员共享、经 `group.get` 下发）。**已移除**：群若能设置 agent 的响应策略，等于群能驱使 agent 持续消耗 token、产生费用——这违背 AUN 把 agent 当**自主主体**的定位。agent 在群里如何响应，只能由 agent 自己（及其 owner）在本地决定。

因此也**不需要 lock 机制**：lock 原本是为了让群公约锁住某些字段不被 agent 覆盖；既然没有外部来源，三层都是 agent 自己的配置，自上而下覆盖即可，无需任何锁定。

---

## 3. 三级规则体系

### 3.1 合并算法

借鉴 `manifest-engine.ts:94-100` 的字段级合并，扩展为三级、深度合并（嵌套对象逐字段覆盖，数组整体替换）。三层都是本地配置、无锁，纯自上而下覆盖：

```
effective = deepMerge( deepMerge(L3, L2), L1 )
```

步骤：
1. 以 L3（全局默认）为基底——保证每个字段都有值，代码永不读到 undefined。
2. L2 Agent 群默认策略深度覆盖 L3。
3. L1 本群策略深度覆盖结果。

产物 `EffectiveGroupPolicy` 是一个**所有字段齐全**的策略对象。

### 3.2 加载与缓存
- L3：随包发布于 `kits/policies/group-policy.default.json`，`fileCache` 缓存（policy 'on-reload'，group 'kits'，与 manifest 同组）。
- L2：读 `agents/<aid>/group-policy.json`，文件不存在视为空（纯靠 L3）。随 agent reload 失效。
- L1：读 `agents/<aid>/venues/<venueKey>/policy.json`，文件不存在视为空（纯靠 L2/L3）。
- 合并结果按 `<aid>+venueKey` + 三级文件 mtime 缓存；任一级变更即失效重算。
- **调试**：合并结果 dump 到 `$EVOLCLAW_HOME/data/eck-debug/group-policy-<venueKey>.json`（含三级来源与最终值），沿用 eck-debug 既有约定。

### 3.3 解析时机与挂载点
在 `message-processor.ts` 群会话解析处（现已加 `getGroupName` 的同一段，约 L1383 之后）调用 `PolicyResolver.resolve(venueKey)`，把 `EffectiveGroupPolicy` 交给 GroupBatcher。

---

## 4. 规则参数全集（Policy Schema）

合并后的 `EffectiveGroupPolicy` 草案字段（分组列出；每个字段三级都可声明、按优先级覆盖）：

### 4.1 队列与处理模式 `queue`
| 字段 | 类型 | 说明 |
|---|---|---|
| `order` | `fifo` \| `lifo` | 出队方向。默认 fifo |
| `mode` | `batch` \| `each` | 攒批处理 or 逐条处理。默认 batch |
| `mergeSamePeer` | bool | 同一发送人连续消息是否合并（现有 dequeueGreedy 行为）|

### 4.2 攒批触发 `batch`（任一命中即 flush）
| 字段 | L3 默认 | 说明 |
|---|---|---|
| `maxCount` | 50 | 队列达 N 条立即处理 |
| `maxBytes` | 16384 (16k) | 累计字节达 M 立即处理 |
| `idleMsDefault` | 180000 (3min) | 无新消息静默超时 |
| `idleMsActive` | 10000 (10s) | 存在「最近交互对象」时缩短的静默超时 |
| `flushOnMentionSelf` | true | 被 @self 立即 flush 打包全部未处理消息 |
| `flushOnMentionAll` | true | 被 @all 立即 flush（可单独关，防 @all 风暴）|

### 4.3 动态超时 `idle`
- **本期（Q6 简化）**：二档制——群里有「最近交互对象」在发言用 `idleMsActive`，否则用 `idleMsDefault`。不做连续插值。
- `activeWindowMs`：判定「最近交互对象」的有效期（如最近 10min 内交互过才算 active）。
- **P4 升级**：改为按当前最高影响力发言人插值 `idleMs = lerp(idleMsActive, idleMsDefault, 1 - influenceNorm)`。

### 4.4 成员打标与影响力 `members`
| 字段 | 本期 | 说明 |
|---|---|---|
| `tags` | ✅ | 静态标签：`{ "<aid>": ["熟人","同事"] }`，可在 L1/L2 手配 |
| `roleWeights` | ✅ | 角色权重：`{ owner:1.0, admin:0.8, guest:0.3, anonymous:0.1 }` |
| `interactCount` 阈值 `familiarThreshold` | ✅ | 交互计数达阈值视为熟人加档（运行时计数存 members.json）|
| `influence`（加权/衰减/归一化）| ⏳ P4 | 完整影响力模型参数，见 §5 |
| `interactedBoost` | ⏳ P4 | 「最近交互对象」额外影响力加成 |

### 4.5 响应闸门 `gate`（决定「是否响应」，与 dispatchMode 统一）
| 字段 | 说明 |
|---|---|
| `dispatch` | `mention` \| `broadcast`（吸收现有 dispatchMode，使其成为本体系一字段）|
| `minInfluenceToRespond` | 影响力低于阈值的人，broadcast 模式下也不主动响应 |
| `quietHours` | 免打扰时段（cron/区间），期内仅被 @ 才响应 |
| `rateLimit` | 每群速率上限（如每 10min 最多主动响应 N 次，防刷屏耗 token）|
| `cooldownMs` | 刚响应完某群的冷却期，期内提高触发门槛 |

### 4.6 超长消息 `truncate`
| 字段 | 说明 |
|---|---|
| `perMessageMaxBytes` | 单条超长阈值，超出则截断保留头尾 + 占位 `[全文 id=msg_xxx 已截断 N 字]` |
| `fulltextTtlMs` | 全文留存时长；agent 经 `ec msg fulltext <id>` 展开 |
| `fulltextStore` | 全文存储位置（进程内 LRU / 磁盘）|

### 4.7 我补充的可选机制（机制库，按需启用）
- **连续追问检测** `pendingFollowup`：同一人短时间多条且末条疑问/含 @ → 视作在等回复，缩短窗口。
- **话题相关性** `topicAffinity`：消息命中 agent 技能/关注关键词 → 提升即时响应倾向（需关键词源）。
- **紧急信号** `urgencySignals`：正文含「急/帮忙/在吗/@」等 → 临时提权。
- **优先级抢占** `preempt`：被 owner/admin @ 可打断当前低优先级批处理（与现有 interrupt 语义对接）。
- **每日配额** `dailyQuota`：每群每天主动响应上限，防失控。
- **去抖合并** 已有的 same-peer 合并并入 `queue.mergeSamePeer`。

---

## 5. 成员影响力模型（Influence）

> **本期（Q6）只做静态 + 交互计数轻量版**：`roleWeights` + 手配 `tags` + `interactCount`（每群每人一个累加计数，`interactCount ≥ N` 视为熟人加档）。**不做** §5.2 加权合成、§5.3 时间衰减与归一化插值——那些是 **P4** 内容，下文完整模型供后续参考。
>
> 轻量版数据：`venues/<venueKey>/members.json` 存 `{ "<aid>": { interactCount, lastInteractAt, tags } }`；判定「熟人」与「最近交互对象」即足够驱动本期二档 idleMs。

目标（P4 完整版）：给每个发言人算一个 [0,1] 的**有效影响力** `influenceNorm`，影响力越高响应越快（窗口越短、越易越过响应闸门）。

### 5.1 两个维度
- **个人影响力 `peerInfluence`**（跨群，人对我）：基于与该 peer 的历史交互——累计交互次数、被我主动回复次数、是否 owner/admin、手工熟人标签。存 `relations/<peerKey>/influence.json`。
- **群影响力 `venueInfluence`**（群内，人在这个群的份量）：该成员在本群的发言频率、被我回应率、群角色（群主/管理）。存 `venues/<venueKey>/members.json`。

### 5.2 加权合成
```
raw = wPeer * peerInfluence
    + wVenue * venueInfluence
    + roleWeights[role]
    + (isInteractedRecently ? interactedBoost : 0)
    + topicAffinityBonus
influenceNorm = clamp01( (raw - floor) / (ceil - floor) )
```
权重 `wPeer/wVenue/floor/ceil` 都来自规则 `members.influence`，三级可调。

### 5.3 动态更新与衰减
- 每次「我对某 peer 的交互」（见 §6 标记）→ 提升 peerInfluence + 该群 venueInfluence。
- **时间衰减**：`influence *= exp(-Δt / halfLife)`，久不互动自然回落（halfLife 规则可配）。
- 更新写回 influence.json / members.json，带 `updatedAt`。
- 冷启动：无数据时退回 `roleWeights` + tags，保证新群可用。

> 这套与「最近交互对象」是包含关系：interacted 是影响力的一个**强加成项**，而非独立机制。

---

## 6. 「最近交互对象」的标记机制（Q4：双路径，本期都做）

`idleMsActive` 是否生效取决于「群里是否有我最近交互过的人在说话」。交互对象由 **agent 标记**（它知道自己在回应谁，无论是否 @）：

- **主路径（自动登记）**：agent 调 `ec group send` 回复时，从正文 @ 或显式 `--reply-to <aid>` 抽取回应对象，自动写入会话级 `lastInteractedPeers: { <aid>: ts }` 并 `interactCount++`。
- **补充路径（显式）**：`ec ctl interacted <aid>` 供 agent 在不发消息时也能标记「我在关注谁」，写同一状态表。
- 过期：`ts` 超过 `activeWindowMs` 即失效。
- 两路径写入同一份会话级交互状态 + venue `members.json` 计数。

---

## 7. 规则文件格式（示例）

### L3 全局默认 `kits/policies/group-policy.default.json`
```json
{
  "$schema_version": 1,
  "queue":   { "order": "fifo", "mode": "batch", "mergeSamePeer": true },
  "batch":   { "maxCount": 50, "maxBytes": 16384,
               "idleMsDefault": 180000, "idleMsActive": 10000,
               "flushOnMentionSelf": true, "flushOnMentionAll": true },
  "idle":    { "activeWindowMs": 600000 },
  "members": { "roleWeights": { "owner": 1.0, "admin": 0.8, "guest": 0.3, "anonymous": 0.1 },
               "familiarThreshold": 5 },
  "gate":    { "dispatch": "mention", "rateLimit": { "windowMs": 600000, "maxResponses": 20 }, "cooldownMs": 0 },
  "truncate":{ "perMessageMaxBytes": 8192 }
}
```

### L2 Agent 群默认策略 `agents/<aid>/group-policy.json`（agent 对所有群的跨群默认）
```json
{
  "batch": { "idleMsActive": 8000 },
  "gate":  { "dispatch": "mention" }
}
```
> agent 想统一调整自己在所有群的节奏就改这里；不存在则纯吃 L3。本地文件，无外部来源、无 lock。

### L1 本群策略 `agents/<aid>/venues/<venueKey>/policy.json`
```json
{
  "batch": { "idleMsActive": 8000, "maxCount": 50 },
  "gate":  { "dispatch": "broadcast" },
  "members": { "tags": { "alice.aid.pub": ["熟人","同事"] } }
}
```

### 合并结果（L1 > L2 > L3，纯覆盖无锁）
设 L1 含 `gate.dispatch=broadcast`、`batch.idleMsActive=8000`、`batch.maxCount=50`、`members.tags`：
- `gate.dispatch` = **`broadcast`**（L1 覆盖 L2 的 mention——agent 对本群的决定优先于自己的跨群默认）。
- `batch.idleMsActive` = `8000`（L1）。
- `batch.maxCount` = `50`（L1 覆盖 L3 的 50，此处同值）。
- `members.tags` = L1 的标签。
- 其余继承 L2（如 L2 改过的字段）或 L3。

---

## 8. 代码消费路径

```
群消息到达
  → message-bridge: 群聊分支不再直接 doEnqueue
  → PolicyResolver.resolve(venueKey) 取 EffectiveGroupPolicy（缓存）
  → GroupBatcher（新组件，per-venue 累积窗口）
        持有 entries[]/bytes/firstTs/lastTs/timer
        按 policy.batch + 影响力动态 idleMs 判定 flush
        flushOnMentionSelf/All → 立即 flush
  → flush 后照常 messageQueue.enqueue（FIFO/中断语义不变）
  → 影响力更新（agent 回复时经 §6 标记回写）
```

关键新增模块：
- `src/core/group/policy-resolver.ts` — 三级（L3/L2/L1）加载 + 深度合并 + 缓存 + eck-debug dump。
- `src/core/group/group-batcher.ts` — 攒批窗口与触发。
- `src/core/group/members.ts` — 成员交互计数 / 标签读写（`venues/<venueKey>/members.json`）；P4 再扩为完整影响力。
- 规则类型集中在 `types.ts` 的 `GroupResponsePolicy` 等接口。

复用：`messageQueue` / interrupt / eck-debug / fileCache 均沿用；三层策略文件读取沿用 agent 配置的读法（`agents/<aid>/...`）。

---

## 9. 渐进实施路线（建议分期）

1. **P1 规则骨架**：L3 文件 + `GroupResponsePolicy` 类型 + PolicyResolver（三层 L1/L2/L3 加载与深度合并）+ eck-debug dump。不改行为，仅产出规则。
2. **P2 GroupBatcher**：接管群聊入队，实现 count/bytes/idle/mention 四触发；idleMs 用静态 default/active 二档。
3. **P3 交互标记**：`ec group send` 自动登记 + `ec ctl interacted` 显式 + 会话级 lastInteractedPeers + members.json 计数，打通 idleMsActive 与熟人加档。
4. **P4 完整影响力**：peer/venue 影响力存储、exp 衰减、加权合成、归一化插值，连续动态 idleMs。
5. **P5 闸门与机制库**：rateLimit/quietHours/cooldown/超长截断展开等按需开。

---

## 10. 已拍板决策（v1 定稿）

| # | 问题 | 决策 |
|---|---|---|
| **Q1** | L3 默认阈值 | **maxCount=50 / maxBytes=16384(16k) / idleMsDefault=180000(3min) / idleMsActive=10000(10s)**；均可被 L1/L2 覆盖 |
| **Q2** | 队列方向 | **默认 FIFO，`queue.order` 可配**（L1/L2 可改 lifo）|
| **Q3** | ~~lock 机制~~ | **取消**。三层皆 agent 本地配置、无外部来源，纯自上而下覆盖，无需锁定（见 §2.1）|
| **Q4** | 交互标记 | **自动 + 显式双路径**。主：`ec group send` 时从正文 @ / `--reply-to` 自动抽取登记；补：`ec ctl interacted <aid>` 显式标记。两路径写同一会话级交互状态表 |
| **Q5** | 三层定义 | **去掉群公约级**。三层重定义为 L1 本群策略 / L2 Agent 群默认策略 / L3 全局默认，**全部 agent 本地掌控**。群无配置权（避免群驱使 agent 烧 token）。本期三层都做（L2 也只是个本地文件，成本低） |
| **Q6** | 影响力 | **静态 + 交互计数轻量版**。本期 = `roleWeights` + 手配 `tags` + 简单 `interactCount`（不衰减、不加权合成、不插值）；`interactCount ≥ familiarThreshold` 视为熟人加档。idleMs 用 default/active **二档**（有/无最近交互对象），不做连续插值。完整影响力模型留 P4 |
| **Q7** | 全文展开 | **复用现有消息日志**。不新增存储，`ec msg fulltext <id>` 从 chatDir 的 message-log 按 messageId 回查全文。截断只发生在投喂模型的渲染层，落盘日志始终是完整原文 |

> 上述决策已并入正文（§2 三层模型、§3 合并、§4 schema、§5 影响力简化、§6 双路径）。「群公约」级与完整影响力模型已分别移除/延后。
