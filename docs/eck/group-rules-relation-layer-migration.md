# 群规则/群实例数据归位：venues → relations 迁移方案

**状态**：方案定稿待实施（对应任务 a→c）
**创建**：2026-07-09
**结论先行**：群是关系层的**对端实例**，其本地数据（尤其群规则 `rules.md`）应落
`relations/<peerKey>/`，而非 `venues/<channel>#<venueId>/`。`venues/` 下"每个具体群/私聊一个目录"
的结构整个是错误的，本次一并清除；命名上 `venueKey/venueDir/group-venue-sync` 等编码了旧认知的名字一并纠正。

---

## 一、认定：问题是什么

### 1.1 核心认知（已与用户对齐）

- **群属于关系层**。AID 分四类：`group`（群服务）、`human`、`agent`、`service`。四类都有 AID、
  都能通过 AUN 向 agent 发消息，对 agent 而言**都是对端**。因此一个**具体群实例**（有 AID）的数据
  落关系层 `relations/<peerKey>/`，与 `profile.md`、`history.jsonl`、`peer-identity.json` 共存。
- **关系层路由键统一为 `peerKey = <channelType>#urlEncode(channelId)`**（`src/core/relation/peer-identity.ts:22-27`）。
  - 私聊：channelId = 对端 ID；群聊：channelId = **群 ID**，群内所有发言者共用同一 peerKey。
  - 用 `channelType#peerId` 而非直接用 AID，是为了统一覆盖**无 AID 的非 AUN 渠道对端**
    （飞书群 = `feishu#<chat_id>`，微信 = `wechat#<openid>`）。
- **环境层是比"单个群实例"更高一层的抽象**：如"组织"（一个组织下辖多个群），或"所有群共有的
  类型级共性"。`chatType`（private/group/coding）这种**类型**属于环境层范畴；但"张三所在的
  team-alpha 这个**具体群**"是关系层的对端实例。环境层不按 `<channel>#<venueId>` 给每个具体实例建目录。
  **本次不改环境层的正向定义**，只做一件事：把错放进环境层的群实例数据搬回关系层。

### 1.2 关键事实：`venueKey ≡ 群的 peerKey`

代码里群的两个键是**同一个字符串**：

| 键 | 定义 | 出处 |
|----|------|------|
| `peerKey` | `` `${channel}#${encodeURIComponent(channelId)}` `` | `peer-identity.ts:25` |
| `venueKey` | `` `${channel}#${encodeURIComponent(groupId)}` `` | `group-venue-sync.ts:354` |

群聊时 `channelId === groupId`，故 `venueKey === peerKey`。`venueKey` 是 `peerKey` 的**冗余复制**，
应予消除，而非重命名。

### 1.3 这不只是文档问题——代码已经把群规则物化进 venues

`src/eck/group-venue-sync.ts` 整个模块就是"群规则物化到环境层"的实现：
- `venuePaths()`（:353-357）产出 `dir = agentVenuesDir(selfAid)/venueKey` → **`venues/<channel>#<groupId>/`**，
  正是被判为"整个错误"的按实例建目录结构。
- `syncGroupVenueContext()`（:75-88）把远端 `/rules.md` 物化到 `venues/<venueKey>/rules.md`，
  并注入 `venueKey/venueDir/groupRulesPath` 三个 ECK 变量。
- `response-engine.ts:1474-1480` 在群聊时调用它，`:1519` 把这些变量拼进上下文。
- manifest（`kits/eck_manifest.json:118-141`）用 `$VENUES_DIR/{{channel}}#{{groupId}}/profile.md` 和
  `$VENUES_DIR/{{venueKey}}/rules.md` 注入群 profile 与群规则。

---

## 二、目标态

| 数据 | 现状（错） | 目标（对） |
|------|-----------|-----------|
| 群规则物化文件 | `venues/<channel>#<groupId>/rules.md` | `relations/<peerKey>/rules.md` |
| 群 profile | `venues/<channel>#<groupId>/profile.md` | `relations/<peerKey>/profile.md`（已是关系层既有文件） |
| 群 history | `venues/<channel>#<venueId>/history.jsonl` | `relations/<peerKey>/history.jsonl`（关系层既有） |
| 路由键 | `venueKey`（冗余） | 消除，统一用 `peerKey` |
| 本地目录变量 | `venueDir` | 消除或改为关系目录（见 §3.3） |
| 群规则路径变量 | `groupRulesPath`（指向 venues） | 保留名，指向 `relations/<peerKey>/rules.md` |

> `venues/` 目录本身**是否保留为空骨架**取决于环境层将来是否有真正的（组织/类型级）用途。
> 本次**不删除** `$VENUES_DIR` 路径定义与骨架创建，只停止往里写群实例数据；环境层的正向内容后续单独设计。

---

## 三、实施清单（任务 c）

### 3.1 代码：物化路径迁移

**`src/eck/group-venue-sync.ts`**（改动核心）
- `venuePaths()` → 改为基于关系目录：`dir = agentRelationsDir(selfAid)/peerKey`；
  移除 `venueKey` 产出，改用/复用 `formatPeerKey(channel, groupId)`。
- 模块级重命名：`group-venue-sync.ts` → `group-rules-sync.ts`；导出符号
  `syncGroupVenueContext` → `syncGroupRulesContext`，返回类型 `GroupVenueSyncVars` → `GroupRulesSyncVars`
  （去掉 `venueKey/venueDir`，保留 `groupRulesPath/groupRulesStatus/groupRulesError`）。
- import 改：`agentVenuesDir` → `agentRelationsDir`（`src/paths.ts` 已有 `agentRelationsDir`，需确认）。

**`src/core/message/response-engine.ts`**
- `:1474-1480` 调用点改名 `syncGroupVenueContext` → `syncGroupRulesContext`。
- `:1519 ...groupVenueVars` 展开的变量集合相应收敛（不再有 venueKey/venueDir）。
- `VENUES_DIR` 变量注入（:1501）保留（环境层路径仍存在），但不再承载群规则。

**`src/eck/kit-renderer.ts`**
- `:236-237` 删除 `venueKey`、`venueDir` 变量说明；`:238` `groupRulesPath` 说明改为
  "群规则本地物化文件（`relations/<peerKey>/rules.md`）"。

**`src/eck/manifest-engine.ts`**：`$VENUES_DIR` 映射（:546）保留（路径仍在），无需改。

**`_archived/_message-processor.ts`**：已归档，不动（仅确认不被引用）。

### 3.2 Manifest 与 fragment

**`kits/eck_manifest.json`**
- `venue-group-profile`（:118-129）：`$VENUES_DIR/{{channel}}#{{groupId}}/profile.md`
  → `$RELATIONS_DIR/{{peerKey}}/profile.md`。
- `venue-group-rules`（:130-141）：`$VENUES_DIR/{{venueKey}}/rules.md`
  → `$RELATIONS_DIR/{{peerKey}}/rules.md`。
- 段 id 是否改名（`venue-group-*` → `relation-group-*`）：建议改，保持语义一致；
  注意这是**覆盖文件**语义，改 id 等于新增段+废弃旧段，需确认基础 manifest 无同 id 依赖。

**`kits/templates/system-fragments/venue.md`**
- 删除 `{{?venueKey}} venueKey: ...`（:23-25）块。
- `groupRulesStatus/groupRulesError`（:26-31）保留（仍是群规则同步状态，属关系层信息）；
  其在 venue fragment 还是迁到 relation fragment，取决于 fragment 分层——见 §四待确认。

### 3.3 文档

**`kits/rules/05-venue.md`**（重灾区）
- §数据结构（:20-34）：删除 `venues/<channel>#<venueId>/{profile,rules,history}` 整套 + 三个"例子"
  （AUN 群/飞书群/私聊各建目录）。改写为：环境层承载更高抽象（组织/类型级共性），**不为具体群/私聊实例建目录**。
- §Venue 类型（:36-42）：`private/group/broadcast` 这类是**类型抽象**的说明可保留，但要澄清
  "具体实例数据不落 venues"。
- 群规则段（:48-53）：`$VENUES_DIR/<venueKey>/rules.md` → `$RELATIONS_DIR/<peerKey>/rules.md`；
  措辞由"venue 层"改为"关系层"。
- 场景判定表（:11）"关系层（群）"表述本就正确，保留。

**`kits/docs/context-assembly.md`**
- :298 段表 `venue-group-profile` 路径与 :251 变量清单相应更新。

**`kits/docs/identity/AID_PROFILE_SPEC.md`**
- :11 `场所档案 $VENUES_DIR/<venue-id>.md` 群/场所策略 → 归入关系层 `relations/<peerKey>/profile.md`。

**`docs/response-system/config-reference.md`**
- :184 环境级配置 `$VENUES_DIR/<venueKey>/config.json`：本次群规则迁移不直接动 config 分层，
  但 `venueKey` 命名已随本次消除——需与用户确认环境级 config 是否也一并调整（见 §四）。

**`kits/docs/path-registry.md` / `eck_templates/path-registry.template.md`**
- `$VENUES_DIR` 定义保留（路径仍存在），措辞"场所档案"可保留或标注"环境层，非群实例"。

### 3.4 骨架创建

**`src/config-store.ts:457-459`**：`venues/`、`venues/_index`、`venues/_trash` 骨架——
保留（环境层目录仍存在），无需改。

---

## 四、边界决策（已确认，2026-07-09）

1. ✅ **manifest 段 id 改名**：`venue-group-profile` → `relation-group-profile`，`venue-group-rules` → `relation-group-rules`。
2. ✅ **`groupRulesStatus/error` 迁移**：从 `venue.md` fragment 迁到 relation fragment（群规则=关系层信息）。
3. ✅ **环境级 config 的 `venueKey` 命名一起消除**（`config-reference.md:184` 等处）。
4. ✅ **旧数据不写迁移**：已物化的 `venues/.../rules.md` 靠下次 sync 在新位置（relations）自动重新下载；旧文件留作孤儿后续清理。

---

## 五、影响面速览

| 面 | 文件数 | 风险 |
|----|--------|------|
| 代码 | `group-venue-sync.ts`（改名+改路径）、`response-engine.ts`、`kit-renderer.ts` | 中：群规则注入路径变更，需重启 daemon 验证群聊注入生效 |
| manifest/fragment | `eck_manifest.json`、`system-fragments/venue.md` | 中：路径模板变量 venueKey→peerKey |
| 文档 | `05-venue.md`、`context-assembly.md`、`AID_PROFILE_SPEC.md`、`config-reference.md`、`path-registry*` | 低：表述纠正 |

验证要点：群聊消息进来后，`relations/<peerKey>/rules.md` 被物化、manifest 注入命中、
`groupRulesPath` 指向新路径；私聊与 coding 不受影响。
