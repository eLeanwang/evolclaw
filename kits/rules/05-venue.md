# 环境层：当前对话场景

环境层决定当前会话加载哪些信息。动态注入的 `chatType` 标识当前聊天类型（private/group/null），`venueUid` 是场所唯一标识（预留）。

## 场景判定

| 场景 | 条件 | 加载的层 | 你的行为 |
|------|------|----------|----------|
| coding | 无 channel（无 token） | 仅 rules | 本地模式，每条消息都响应 |
| private | 单聊 | rules + 身份层 + 关系层（对端）+ 环境层 + 渠道层 | 自主模式，通过 CLI 回复 |
| group | 群聊 | rules + 身份层 + 关系层（群）+ 环境层 + 渠道层 | 自主模式，mentionMode 决定响应策略 |

## 数据位置

| 位置 | 内容 |
|------|------|
| `$VENUES_DIR`（`$AGENT_DIR/venues/`） | 环境数据（可写，预留） |
| `$KITS_DOCS/venues/` | 环境层详细规则（只读，按需加载） |

> **重要**：环境层承载比"单个群/私聊实例"更高的抽象（如组织、类型级共性），**不为具体群/私聊实例建目录**。
> 具体群实例的数据（如群规则 `rules.md`、群 profile）落**关系层** `$RELATIONS_DIR/<peerKey>/`。

## Venue 类型抽象

环境层关注的是**类型**，而非具体实例：

| 类型 | 含义 |
|------|------|
| private | 一对一私聊（类型抽象） |
| group | 群聊（类型抽象） |
| broadcast | 广播频道（类型抽象） |

`chatType`（private/group/coding）是类型级参数，属于环境层范畴。但"张三所在的 team-alpha 这个**具体群**"是关系层的对端实例，其数据落 `relations/<peerKey>/`。

## 群规则（关系层数据）

AUN 群规则文件固定来自 `<group-aid>:/rules.md`。EvolClaw 先读取 signed `rules.content`
元信息并用远端 stat 的 `size + mtimeMs` 校验 `/rules.md`，一致后把远端字节原样物化到
**`$RELATIONS_DIR/<peerKey>/rules.md`**（群的 peerKey = `aun#<group-aid>`）并通过 manifest 注入。
群规则可定义本群特有的工作流程、职责分工、交付格式、禁区和升级路径；当群规则与通用规则冲突时，
优先遵守群规则，但不能越过系统安全、权限和用户明确指令。

其它群资源不预先注入，需要时用 `ec fs ls/find/stat/cat <group-aid>:/...` 查询。
不要把本地残留的 `rules.md` 当作权威源；只有本轮校验通过并暴露 `groupRulesPath` 时才使用。
