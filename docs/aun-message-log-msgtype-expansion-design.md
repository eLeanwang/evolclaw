# AUN messages.jsonl msgType 语义修正与内容类型扩展方案

> 状态：已实现（2026-07-13）
> 日期：2026-07-10
> 范围：AUN 入站/出站消息日志、`ec msg send`、daemon 代发、handoff、watch/stats/prompt 消费方
>
> 实现落点：`src/core/message/message-log.ts`（`MessageLogType` union + `classifyAunPayloadForLog()`）、`src/aun/msg/p2p.ts`（`appendMsgSendOutboundLog` 接入分类）。测试：`tests/unit/aun-payload-log.test.ts`、`tests/unit/handoff-v2-message-log.test.ts` 通过。commit `68de544`。

## 1. 背景

当前 `messages.jsonl` 的 `msgType` 在多条 AUN 出站路径中被固定写成 `text`：

- `src/aun/msg/p2p.ts` 的 `appendMsgSendOutboundLog()`：`ec msg send` 成功后统一写 `msgType: "text"`。
- `src/channels/aun.ts` 的 `sendDaemonMsg()`：agent 任务内 `ec msg send` 通过 daemon 代发时统一写 `msgType: "text"`。
- `src/channels/aun.ts` 的 `appendOutboundJsonl()`：普通 payload / card / file 等出站日志调用方多数传入 `"text"`。

这与 AUN payload 协议不一致。AUN 业务负载类型放在 `payload.type` 中，已定义 `text`、`quote`、`image`、`video`、`voice`、`file`、`link`、`action_card`、`action_card_reply`、`merge`、`personal_card`、`status`、`event`、`json`、`tool_call`、`tool_result`、`custom` 等类型。

把所有出站日志都写成 `text` 是历史简化：当时 `content` 是面向 watch/stats/prompt 的文本摘要，`msgType` 被当成“可展示为文本摘要”的信号，而不是严格消息类型。现在 handoff、授权卡片、结构化 payload 都依赖准确的消息语义，继续写死会造成 replay、审计、统计和 UI 展示歧义。

## 2. 目标

1. 修正 `msgType` 语义：`msgType` 表示 `messages.jsonl` 记录的消息内容类型，而不是摘要格式。
2. 对 AUN 普通业务消息，`msgType` 默认对齐 `payload.type`。
3. 保持 `content` 为稳定文本摘要，供 watch、stats、prompt 和调试使用。
4. 支持 AUN 协议中更多内容类型，不再把 `link/file/action_card/json/custom` 等统一记为 `text`。
5. 保持 append-only 日志兼容：不重写历史 JSONL 行。
6. 不把完整大 payload、文件内容、密钥或敏感数据默认写入 `messages.jsonl`。

## 3. 非目标

- 不改 AUN 传输协议本身。
- 不要求历史 `messages.jsonl` 迁移重写。
- 不把 `messages.jsonl` 变成完整 payload store。
- 不把授权 grant 状态放入 `messages.jsonl`；授权状态仍由权限系统/Grant Service 管理。
- 不让 `msgType` 取代 `handoff.kind`、`handoff.event`、`source` 等链路元数据。

## 4. 语义定义

### 4.1 `msgType`

`msgType` 是日志记录的规范内容类型。

对 AUN 消息：

- 若有可信 `payload.type` 且属于已知类型，`msgType = payload.type`。
- 若 `payload.type` 未知，`msgType = "custom"`，并用 `payloadType` 保存原始类型字符串。
- 若 payload 缺失或不是对象，`msgType = "text"`，`content` 使用可读文本。

对 EvolClaw 内部事件：

- `command`：入站 slash 命令。
- `thought`：thought.put / thought structured log。
- `handoff_state`：handoff append-only 状态事件。
- `handoff_result`：handoff 回流结果。

### 4.2 `payloadType`

新增可选字段：

```ts
payloadType?: string;
```

含义：

- AUN 消息的原始 `payload.type`。
- 对已知类型，`payloadType` 通常等于 `msgType`，可选写入。
- 对未知类型，必须写入原始类型，避免 `custom` 抹掉业务语义。
- 对内部事件可省略。

### 4.3 `content`

`content` 继续是文本摘要，不等同于完整 payload。

规则：

- `text/quote/action_card_reply` 等有正文的类型，优先取可展示正文。
- `file/image/video/voice` 等附件类型，写稳定摘要和关键展示字段，不写文件内容。
- `action_card` 写卡片标题和正文摘要，不写全部按钮状态作为自由文本；按钮可在必要时进入结构化 metadata。
- `json/custom` 写短摘要，避免把大 JSON 或敏感字段完整落盘。

## 5. 类型集合

`MessageLogEntry.msgType` 建议扩展为：

```ts
export type MessageLogType =
  | 'text'
  | 'quote'
  | 'command'
  | 'thought'
  | 'voice'
  | 'image'
  | 'video'
  | 'file'
  | 'location'
  | 'link'
  | 'action_card'
  | 'action_card_reply'
  | 'merge'
  | 'personal_card'
  | 'status'
  | 'event'
  | 'json'
  | 'tool_call'
  | 'tool_result'
  | 'custom'
  | 'handoff_state'
  | 'handoff_result';
```

如果希望进一步区分“未知 payload 对象”和协议内 `custom`，可以加 `payload` 类型。但优先建议用 `custom + payloadType`，减少消费者分支。

## 6. AUN payload 到 msgType 映射

| AUN `payload.type` | `msgType` | `content` 摘要建议 |
|--------------------|-----------|--------------------|
| `text` | `text` | `payload.text` |
| `quote` | `quote` | `payload.text`，可拼接引用摘要 |
| `thought` | `thought` | `payload.text` / 摘要 |
| `voice` | `voice` | `[voice] ${transcript 或 filename}` |
| `image` | `image` | `[image] ${alt/title/filename}` |
| `video` | `video` | `[video] ${title/filename}` |
| `file` | `file` | `[file] ${filename}` |
| `location` | `location` | `[location] ${name/address/lat,lng}` |
| `link` | `link` | `[link] ${title 或 url}` |
| `action_card` | `action_card` | `[card] ${title}`，正文可追加短摘要 |
| `action_card_reply` | `action_card_reply` | `text/action_value/action_label` |
| `merge` | `merge` | `[merge] ${title}`，可含 items 数量 |
| `personal_card` | `personal_card` | `[personal_card] ${name/aid}` |
| `status` | `status` | `[status] ${status/text}` |
| `event` | `event` | `[event] ${kind/name}` |
| `json` | `json` | `[json] ${kind/title}` 或短 JSON 摘要 |
| `tool_call` | `tool_call` | `[tool_call] ${name}` |
| `tool_result` | `tool_result` | `[tool_result] ${name/status}` |
| `custom` | `custom` | `fallback_text/text/[custom]` |
| 未知字符串 | `custom` | `fallback_text/text/[payload:<type>]`，并写 `payloadType` |

## 7. 结构化元数据

为避免 `content` 承担过多职责，建议新增轻量 metadata 字段：

```ts
payloadType?: string;
payloadSummary?: {
  title?: string;
  text?: string;
  filename?: string;
  url?: string;
  kind?: string;
  actionCount?: number;
  attachmentCount?: number;
};
```

约束：

- `payloadSummary` 只放展示和调试摘要。
- 不放完整附件 data、base64、secret、token。
- 大字段必须截断。
- 授权卡片的业务结构不塞进 `payloadSummary`，应放在专用 `auth` 或 `handoff.auth` metadata。

## 8. 代码改造建议

### 8.1 新增统一 helper

新增模块建议：

```text
src/core/message/aun-payload-log.ts
```

职责：

```ts
export function classifyAunPayloadForLog(payload: unknown): {
  msgType: MessageLogType;
  payloadType?: string;
  content: string;
  payloadSummary?: MessageLogPayloadSummary;
};
```

所有 AUN 入站、普通出站、`ec msg send`、daemon 代发、结构化 payload、file payload 都走这个 helper。

### 8.2 扩展 MessageLogEntry

修改：

```text
src/core/message/message-log.ts
```

内容：

- 扩展 `msgType` union。
- 增加 `payloadType?: string`。
- 增加 `payloadSummary?: ...`。
- `buildInboundEntry()` / `buildOutboundEntry()` 支持显式传入 `msgType/payloadType/payloadSummary`。
- 默认行为保持兼容：未传时仍按旧逻辑生成 `command/text`。

### 8.3 修正 ec msg send 日志

修改：

```text
src/aun/msg/p2p.ts
```

当前问题：

- `appendMsgSendOutboundLog()` 固定 `msgType: "text"`。
- `messageLogContent()` 只按 body mode 生成粗摘要，无法表达 `payload.type`。

建议：

- `appendMsgSendOutboundLog()` 接收最终发送的 `payload`。
- 用 `classifyAunPayloadForLog(payload)` 得到 `msgType/content/payloadType/payloadSummary`。
- `MsgSendBody.mode === "payload"` 时根据 payload 内部 `type` 记录真实类型。
- `MsgSendBody.mode === "link"` 记录为 `link`。
- `MsgSendBody.mode === "file"` 记录为 `file/image/video/voice`，取决于 `uploadFileAndBuildPayload()` 生成的 payload type。

### 8.4 修正 daemon sendDaemonMsg

修改：

```text
src/channels/aun.ts
```

当前问题：

- `sendDaemonMsg()` 收到任意 `args.payload`，但日志固定 `msgType: "text"`。

建议：

- `AunDaemonMsgSendArgs.log` 允许调用方传入 `msgType/payloadType/payloadSummary`，但不是必须。
- daemon 端以实际 `finalPayload` 重新 classify，调用方传入的类型只能作为 fallback，不能覆盖真实 payload。
- 写日志时使用 classify 结果。

### 8.5 修正 channel 普通出站

当前问题：

- `recordSentPayload()` 已知道 `payload.type`，但调用 `appendOutboundJsonl(..., 'text')`。
- `sendFile()` 写 file payload 后也传 `'text'`。

建议：

- `appendOutboundJsonl()` 不再只接收 `text/msgType`，改为接收完整 log descriptor：

```ts
appendOutboundJsonl(channelId, {
  content,
  msgType,
  payloadType,
  payloadSummary,
  msgId,
  encrypt,
  context,
  isGroup,
  source,
});
```

- `recordSentPayload()` 和 `sendFile()` 都用统一 helper。

### 8.6 修正 AUN 入站

当前入站路径先 `extractTextPayload()`，再 `buildInboundEntry()`；这会把多数 payload 也记成 `text/command`。

建议：

- 在 `handleIncomingPrivateMessage()` / group 入站处理时保留原始 `payload`。
- 用 `classifyAunPayloadForLog(payload)` 生成日志类型。
- 如果 `content` 以 slash 开头且 payload 类型是 `text/quote/action_card_reply`，可继续标为 `command`，同时写 `payloadType` 保存原始类型。
- `action_card_reply` 当前被 channel 层消费，不分发给 agent；仍应按需要写入审计日志，或至少为授权审批路径写结构化 decision 事件。

## 9. 与 handoff 的关系

handoff replay 不能只依赖 `msgType`。继续以以下字段作为主判断：

- `source`
- `handoff.kind`
- `handoff.event`
- `replyTo`
- `msgId`

但 `msgType` 修正后可以增强可读性和过滤能力：

- `request_to_target` 可以是 `text`、`action_card`、`json` 等任意业务消息。
- `handoff_state` 仍是状态事件，必须被 watch/stats/prompt 默认过滤。
- `handoff_result` 仍是回流事件，可用专门 fragment 渲染。

授权卡片建议：

- AUN payload 使用 `type: "action_card"`。
- `messages.jsonl.msgType = "action_card"`。
- 授权业务结构放在 `auth` 或 `handoff.auth` metadata，不放在 `content`。
- owner 点击后的 `action_card_reply` 不直接进模型；系统处理后追加审批 decision / result 事件。

## 10. 兼容策略

历史日志不迁移，消费者按以下规则兼容：

1. 没有 `payloadType` 的旧记录按旧逻辑处理。
2. 旧 `msgType: "text"` 但 `content` 形如 `[file]`、`[link]`、`[card]` 的记录只作为历史展示，不反推类型参与关键逻辑。
3. 新消费者必须把未知 `msgType` 当 `custom` 降级展示。
4. stats 继续排除 `handoff_state`，并可按新 `msgType` 细分统计。
5. prompt 只把允许进入 prompt 的类型转成文本；`action_card`、`status`、`event` 默认不作为普通对话内容进入模型，除非对应 fragment 明确处理。

## 11. 实施步骤

### Phase 1：类型和 helper

1. 扩展 `MessageLogEntry.msgType`。
2. 增加 `payloadType/payloadSummary`。
3. 新增 `classifyAunPayloadForLog()`。
4. 为 helper 增加单元测试，覆盖所有 AUN 已知 payload type 和未知 type。

### Phase 2：出站修正

1. 修正 `src/aun/msg/p2p.ts`：
   - `ec msg send --link` 记录 `link`。
   - `ec msg send --file` 记录实际附件类型。
   - `ec msg send --payload '{"type":"action_card"...}'` 记录 `action_card`。
2. 修正 `src/channels/aun.ts`：
   - `sendDaemonMsg()` 按 payload classify。
   - `recordSentPayload()` 按 payload classify。
   - `sendFile()` 按 file payload classify。

### Phase 3：入站修正

1. AUN P2P 入站日志按 payload classify。
2. AUN group 入站日志按 payload classify。
3. 保留 slash command 特判：`msgType: "command"`，`payloadType` 写原始 payload type。

### Phase 4：消费者校准

1. watch：支持新类型图标/摘要，默认隐藏 `handoff_state`。
2. stats：按新类型统计，继续排除状态事件。
3. prompt renderer：只渲染允许进入模型的类型。
4. handoff replay：不因 `msgType` 扩展改变主判断逻辑。

## 12. 测试清单

必须覆盖：

- `ec msg send from to "hello"` 写 `msgType: "text"`。
- `ec msg send --link` 写 `msgType: "link"`。
- `ec msg send --file image.png` 写 `msgType: "image"` 或 `file`，取决于实际 payload。
- `ec msg send --payload '{"type":"action_card"...}'` 写 `msgType: "action_card"`。
- agent 任务内 `ec msg send` daemon 代发 action_card，日志不是 `text`。
- 普通 AUN `sendContentPayload()` card 出站写 `action_card`。
- 普通 `sendFile()` 写 `file/image/video/voice`。
- AUN 入站 `action_card_reply` 可审计，且不误分发给 agent。
- 旧日志没有 `payloadType` 时 watch/stats/prompt 不崩溃。
- `handoff_state` 仍被 stats/prompt 过滤。

## 13. 风险与决策

### 13.1 是否存完整 payload

不建议默认存完整 payload。原因：

- 大文件/图片可能包含 base64 或对象引用细节。
- payload 可能含敏感业务字段。
- `messages.jsonl` 是会话日志和审计索引，不是对象存储。

需要结构化 replay 的业务应写专用 metadata，例如 `handoff`、`auth`、`payloadSummary`。

### 13.2 `command` 与 payload type 冲突

入站文本 `/xxx` 目前会记为 `command`。这个语义应保留，因为 command 是 EvolClaw 内部处理类型。

如果原始 payload 是 `text`，记录：

```json
{
  "msgType": "command",
  "payloadType": "text",
  "cmdParsed": "/perm"
}
```

### 13.3 未知类型如何处理

未知 payload 类型不能丢失。记录：

```json
{
  "msgType": "custom",
  "payloadType": "vendor.special_card",
  "content": "[payload:vendor.special_card]"
}
```

### 13.4 对现有 handoff 文档的修正

`docs/msg-send-cross-session-handoff-append-only-design.md` 中示例 `request_to_target.msgType: "text"` 只适用于文本请求。后续应补充说明：`request_to_target` 可以承载任意普通业务 `msgType`，handoff 判断不得假设其为 `text`。

## 14. 结论

`msgType` 写死为 `text` 是历史实现债，应该修正。正确模型是：

- `payload.type` 决定 AUN 业务消息的 `msgType`。
- `content` 只是文本摘要。
- `payloadType` 保留原始 payload 类型，特别是未知类型。
- 内部状态事件继续使用 `handoff_state/handoff_result`。
- 授权卡片、handoff、watch/stats/prompt 都基于这个更准确的日志语义继续演进。
