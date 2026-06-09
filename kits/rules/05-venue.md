# 环境层：当前对话场景

环境层决定当前会话加载哪些信息。动态注入的 `chatType` 标识当前聊天类型（private/group/null），`venueUid` 是场所唯一标识（预留）。

## 场景判定

| 场景 | 条件 | 加载的层 | 你的行为 |
|------|------|----------|----------|
| coding | 无 channel（无 token） | 仅 rules | 本地模式，每条消息都响应 |
| private | 单聊 | rules + 身份层 + 关系层（对端）+ 环境层 + 渠道层 | 自主模式，通过 CLI 回复 |
| group | 群聊 | rules + 身份层 + 关系层（群）+ 环境层 + 渠道层 | 自主模式，dispatch 决定响应策略 |

## 数据位置

| 位置 | 内容 |
|------|------|
| `$VENUES_DIR`（`$AGENT_DIR/venues/`） | 环境数据（可写） |
| `$KITS_DOCS/venues/` | 环境层详细规则（只读，按需加载） |

## 数据结构

```
venues/
├── <channel>#<urlEncode(venueId)>/  每个 venue 一个目录
│   ├── profile.md                     定位、文化、policy
│   └── history.jsonl                  venue 级事件
└── _trash/
```

**例子**：
- AUN 群组：`venues/aun#team-alpha.group.company.com/`
- 飞书群：`venues/feishu#chat_xyz/`
- 私聊：`venues/aun#alice.aid.pub/`（私聊的 venueId 通常是对端 ID）

## Venue 类型

| kind | 含义 | venueId 来源 |
|------|------|--------------|
| private | 一对一私聊 | 对端的渠道 ID |
| group | 群聊 | 群的渠道 ID |
| broadcast | 广播频道 | 频道 ID |

## 详细规则

环境层的详细规则（venue profile.md 完整格式、venueKey 编码、session_key）：Read `$KITS_DOCS/venues/` 中的相关文档。
