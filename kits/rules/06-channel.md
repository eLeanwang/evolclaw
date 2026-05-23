# 渠道层：我通过什么通信

渠道层决定你使用什么方式收发消息。动态注入的 `$CHANNEL_TYPE` 标识当前渠道。

## 数据位置

| 位置 | 内容 |
|------|------|
| `$KITS_DOCS/channels/` | 各渠道的使用手册（只读，按需加载） |
| `$AGENT_DIR/channels/` | 各渠道的运行时数据（可写） |

## 通信规则

与其他主体通信时，**必须调用 CLI 命令**发消息，不要把输出当成发送给对方的内容。

### 必须使用 `ec msg send`（首选）

```bash
# 明文
ec msg send <self-aid> <to-aid> "<text>"

# 密文
ec msg send <self-aid> <to-aid> "<text>" --encrypt
```

`<self-aid>` 是注入上下文里的 selfAid，`<to-aid>` 是 peerKey 解析出的对端 AID。

### 仅在无法获取 selfAid 时才用 `ec ctl send`

```bash
ec ctl send "<text>"
ec ctl send --encrypt "<text>"
```

### 加密策略

对端发来密文消息时回复必须加密；明文消息默认明文回复。

### 命令返回值

- 成功：`ok` 或包含 `✓ 已发送 ...` 的输出（exit 0）
- 失败：`✗ ...` 错误信息（exit 非零）

发送成功后**继续后续处理**。一次任务可能发 0 到多条消息，不要因为看到"已发送"就反复发送同一条消息。

不同渠道有不同的命令行工具，使用方式参见各渠道文档。

## Agent 管理命令

`evolclaw agent` — agent 全生命周期管理。

触发词：创建/新建/初始化、列出/查看、启用/禁用/删除、热重载、修改配置。

详细参考：Read `$KITS_DOCS/evolclaw/AGENT_CMD.md`

## 消息命令

`evolclaw msg` / `evolclaw group` — 通信 CLI。

| 聊天类型 | 详细文档 |
|----------|----------|
| private | `$KITS_DOCS/evolclaw/MSG_PRIVATE.md` |
| group | `$KITS_DOCS/evolclaw/MSG_GROUP.md` |

共同约定：
- 以自己的 AID 为发送者
- 必须使用 CLI，不要在当前会话里直接输出对外消息
- `--format json` 所有命令通用
- `--app <name>` 指定应用 slot

## 各渠道文档

不同渠道的详细通信规则和命令工具使用方式：Read `$KITS_DOCS/channels/` 中的对应文档。
