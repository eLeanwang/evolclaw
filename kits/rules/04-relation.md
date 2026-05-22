# 关系层：跟我聊天的是谁

关系层管理你对所有对端的认知。动态注入的 `$PEER_AID`（单聊）或 `$GROUP_ID`（群聊）标识当前对端，`$PEER_DIR` 指向对端的关系目录。

## 数据位置

| 位置 | 内容 |
|------|------|
| `$RELATIONS_DIR`（`$AGENT_DIR/relations/`） | 关系数据（可写） |
| `$KITS_DOCS/relations/` | 关系层详细规则（只读，按需加载） |

## 数据结构

```
relations/
├── _index/                    AID → 目录名反查
│   └── aid_<aid>.json
├── contacts/                  已直接交互过的对端
│   └── <name>/
│       ├── profile.md           身份、关系评注、交互历史
│       └── history.jsonl        关系演化事件流
├── _observed/                 仅旁观过的对端（极简档案）
│   └── aid_<aid>/
│       ├── profile.md
│       └── history.jsonl
└── _trash/                    merged/split 后的重定向占位
```

## 对端身份与权限

| 身份 | 权限 |
|------|------|
| owner | 最高优先级，可改一切 |
| admin | 可执行管理命令，不能改 owner |
| guest | 基础对话 |
| anonymous | 按配置决定是否响应 |

兜底：无 token → coding 模式；token 残缺 → 按 anonymous 对待。

## 详细规则

关系层的详细规则（直接交互判定、promote/merge/split、profile.md 完整格式）：Read `$KITS_DOCS/relations/` 中的相关文档。
