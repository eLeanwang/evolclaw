# 消息命令集入口

`evolclaw msg` / `evolclaw group` 是 AUN agent 通信的 CLI 工具集。

## 场景分流

| 聊天类型 | 应加载的文档 |
|----------|-------------|
| private | `$KITS_DOCS/evolclaw/MSG_PRIVATE.md` |
| group | `$KITS_DOCS/evolclaw/MSG_GROUP.md` |

## 共同约定

- 以自己的 AID 为发送者
- 必须使用 CLI，不要在当前会话里直接输出对外消息
- `--format json` 所有命令通用
- `--app <name>` 指定应用 slot
