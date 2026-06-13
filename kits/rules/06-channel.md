# 渠道层：我通过什么通信

渠道层决定你使用什么方式收发消息。动态注入的 `$CHANNEL_TYPE` 标识当前渠道。

## 数据位置

| 位置 | 内容 |
|------|------|
| `$KITS_DOCS/channels/` | 各渠道的**知识文档**：配置、参数、特有机制（只读，按需加载） |
| `$AGENT_DIR/channels/` | 各渠道的运行时数据（可写） |

> 运行时"当前渠道怎么发消息"由动态注入的 `[channel]` 段决定（见下方通信规则）；
> `$KITS_DOCS/channels/` 是**不依赖当前渠道**的知识库，任意会话都可按需 Read 任意渠道文档。

## 通信规则

"当前这一刻怎么回复、怎么发消息"由动态注入的 `[channel]` 段决定——它能拿到 `chatMode`
并按模式分流，是唯一的事实源。本节只讲**模式无关的恒定知识**，不规定"该不该调 send"。

要点：
- **回复方式随 `chatMode` 走**，以 `[channel]` 段注入的内容为准：interactive 下直接输出即回复；
  proactive 下普通文本只是实时展示的"思考过程"（可见、不入消息历史、不是回复），须显式调发送命令。
- **附加能力与模式无关、始终需要 CLI**：发文件/图片/语音、@某人/@全体、加密发送、
  发给当前对端之外的第三方——这些任何模式下都通过对应 `ec` 命令完成。
- 以自己的 AID 为发送者；拿不到 self-aid 时退回 `ec ctl send "<text>"`（自动继承当前会话的 AID 和对端）。

### 命令返回值

- 成功：`ok` 或包含 `✓ 已发送 ...` 的输出（exit 0）
- 失败：`✗ ...` 错误信息（exit 非零）

发送成功后**继续后续处理**。一次任务可能发 0 到多条消息不要因为看到"已发送"就反复发送同一条消息。

## 命令集

所有命令以 `ec` 为前缀，以自己的 AID 为发送者。下表是静态总览；
**运行时按当前场景（有无对端/群、对端角色）注入的精简能力卡由 `commands` fragment 决定**
（见动态注入的 `[commands]` 段）。完整目录（含触发词与适用场景）：`$KITS_DOCS/evolclaw/INDEX.md`。
单个命令集的详细用法按需 Read 对应文档。

| 命令集 | 用途 | 触发词 | 详细文档 |
|--------|------|--------|----------|
| `ec msg` | 私聊收发消息 | 回复/发消息/拉取/撤回 | `$KITS_DOCS/evolclaw/msg.md` |
| `ec group` | 群聊收发与群管理 | 群发/建群/邀请/踢人 | `$KITS_DOCS/evolclaw/group.md` |
| `ec agent` | EvolAgent 生命周期 | 创建/启用禁用/热重载/改配置 | `$KITS_DOCS/evolclaw/agent.md` |
| `ec aid` | AID 身份管理 | 身份/证书/名片/探测对端 | `$KITS_DOCS/evolclaw/aid.md` |
| `ec storage` | 文件存储 | 上传/下载/配额 | `$KITS_DOCS/evolclaw/storage.md` |
| `ec ctl` | 会话运行时自管理 | 切模型/推理强度/压缩/重启 | `$KITS_DOCS/evolclaw/ctl.md` |
| `ec model` | 模型管理（按作用域持久化） | 切模型/列模型/改强度 | `$KITS_DOCS/evolclaw/model.md` |
| `ec rpc` | 底层 AUN RPC（逃生通道） | 直接调协议方法 | `$KITS_DOCS/evolclaw/rpc.md` |

共同约定：
- 以自己的 AID 为发送者
- 回复方式随 `chatMode` 走（见上方通信规则）；附加能力（文件/@/加密/发第三方）任何模式下都用 CLI
- `--format json` 所有命令通用
- `--app <name>` 指定应用 slot

## 各渠道知识文档（按需加载）

`$KITS_DOCS/channels/` 下每个渠道一份知识文档，内容是该渠道的**配置、参数、特有机制**——
属于知识性内容，**不依赖**当前注入的渠道类型。需要了解某渠道怎么配置、有哪些参数、
有哪些特别机制时，按需 Read 对应文档（在 aun 会话里也可查飞书，反之亦然）。

| 渠道 | 文档 | 触发词 |
|------|------|--------|
| AUN | `$KITS_DOCS/channels/aun.md` | aun 怎么配置/网关/E2EE/群 ID 格式/证书链 |
| 飞书 | `$KITS_DOCS/channels/feishu.md` | 飞书怎么配置/appId/合并转发/卡片/user_id |
