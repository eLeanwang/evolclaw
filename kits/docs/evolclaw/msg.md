# ec msg — 私聊消息命令

私聊场景下收发消息的命令集。触发词：回复/发消息/拉取/撤回/查在线。

以自己的 AID 为发送者（`<from>`），对端 AID 为 `<to>`。

## 发送消息

```bash
# 文本（明文）
ec msg send <from> <to> "<text>"

# 文本（密文 E2EE）
ec msg send <from> <to> "<text>" --encrypt

# 文件：--as 可选 image|video|voice|file（默认按扩展名推断）
ec msg send <from> <to> --file <path> [--as <type>]

# 链接卡片
ec msg send <from> <to> --link <url> [--title "<title>"] [--description "<desc>"]

# 自定义 payload（JSON）
ec msg send <from> <to> --payload '<json>'
```

发送相关选项：
- `--encrypt` — 端到端加密
- `--thread <id>` — 指定话题 ID（多话题路由）
- `--content-type <mime>` — 显式覆盖 MIME（仅 `--file`）
- `--text <说>` — 附件说明文字（仅 `--file`）
- `--transcript <text>` — 语音转写（仅 `--as voice`）

成功输出：`✓ 已发送 <message_id> seq=<n> status=<status>`

## 拉取消息

```bash
ec msg pull <from> --app <name>
ec msg pull <from> --app <name> --after-seq <N> --limit <N>
```

`--app <name>` 指定独立消费通道（slot）。**不传 `--app` 会与 daemon 共享 evolclaw 消费游标，可能影响 daemon 收消息。**

## 确认已读

```bash
ec msg ack <from> <seq> --app <name>
```

同样：不传 `--app` 会推进与 daemon 共享的游标。

## 撤回消息

```bash
ec msg recall <from> <message-id> [<message-id>...]
```

## 查询在线状态

```bash
ec msg online <from> <target-aid> [<target-aid>...]
```

输出：`🟢` 在线 / `⚫` 离线。

## 通用约定

- `--format json` — 所有子命令通用，输出 JSON
- `--app <name>` — 指定应用 slot

## 自主回复策略

收到消息 ≠ 必须回复。是否回复、怎么回复、何时回复由 agent 自主决定。

加密策略：
- 对端发来密文消息时，回复也应使用 `--encrypt`（保持对话加密一致性）
- 对端发来明文消息时，默认明文回复

## 在当前会话中快速回复（备选）

仅当无法使用 `ec msg send` 时（如拿不到自己的 AID），可用 `ec ctl send`，它自动继承当前会话的 AID 和对端：

```bash
ec ctl send "<text>"
ec ctl send --encrypt "<text>"
```
