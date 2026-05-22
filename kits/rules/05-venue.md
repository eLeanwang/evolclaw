# 环境层：我在什么场景下

环境层决定当前会话加载哪些信息。动态注入的 `$SCENE` 标识当前场景类型，`$VENUE_UID` 标识当前环境。

## 场景判定

| 场景 | 条件 | 加载的层 | 你的行为 |
|------|------|----------|----------|
| coding | 无 AUN 通道（无 token） | 仅 rules | 本地模式，每条消息都响应 |
| private | AUN + 单聊 | rules + 身份层 + 关系层（对端）+ 环境层 + 渠道层 | 自主模式，通过 CLI 回复 |
| group | AUN + 群聊 | rules + 身份层 + 关系层（群）+ 环境层 + 渠道层 | 自主模式，被 @ 才默认响应 |

## 数据位置

| 位置 | 内容 |
|------|------|
| `$VENUES_DIR`（`$AGENT_DIR/venues/`） | 环境数据（可写） |
| `$KITS_DOCS/venues/` | 环境层详细规则（只读，按需加载） |

## 数据结构

```
venues/
├── _index/                    venue_id → 目录名反查
│   └── <channel>_<id>.json
├── <venue-name>/              已识别的 venue
│   ├── profile.md               定位、文化、policy
│   └── history.jsonl            venue 级事件
├── private_<peer-name>/       私聊 venue
│   ├── profile.md
│   └── history.jsonl
└── _trash/
```

## Venue 类型

| kind | 含义 |
|------|------|
| private | 一对一私聊 |
| group | 群聊 |
| broadcast | 广播频道 |

## 详细规则

环境层的详细规则（venue profile.md 完整格式、venue_uid 编码、session_key）：Read `$KITS_DOCS/venues/` 中的相关文档。
