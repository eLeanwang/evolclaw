# AUN 通道文件接收设计

**日期**: 2026-04-23  
**范围**: `src/channels/aun.ts` 仅此一文件  
**改动量**: ~70 行新增代码

## 背景

用户通过 AUN CLI 发送文件附件时，`payload.attachments` 字段被完全忽略，Agent 无法感知文件存在。本设计补全下载→保存→通知流程，与 Feishu 通道行为对齐。

## AUN 文件协议

发送方（aun_cli.py）构造的 payload 结构：

```json
{
  "text": "📎 filename.py (227.6 KB)",
  "attachments": [
    {
      "owner_aid": "alice.agentid.pub",
      "object_key": "shared/{uuid}/{filename}",
      "filename": "aun_cli.py",
      "size": 227600,
      "sha256": "abcdef...",
      "content_type": "text/x-python"
    }
  ]
}
```

下载流程（来自 aun_cli.py `_handle_attachments`）：
1. `client.call('storage.create_download_ticket', { owner_aid, object_key })` → `{ download_url }`
2. `HTTP GET download_url` → Buffer
3. SHA256 完整性校验
4. 保存到本地

## 架构

仅修改 `src/channels/aun.ts`，无需改动其他文件。新增：

1. **`private projectPathProvider?`** — `(channelId: string) => Promise<string>` 类型，与 Feishu 通道对齐
2. **`onProjectPathRequest(provider)`** — 公开注册方法，供 `index.ts:232` 自动注入
3. **`private async downloadAttachment(att, channelId)`** — 封装单个附件下载；复用 `media-cache.ts` 的 `saveToUploads` + `sanitizeFileName`
4. **Plugin `ChannelInstance.onProjectPathRequest` 字段** — 在 `createChannels()` 返回值中补充，触发 `index.ts` 的自动注入逻辑

## 数据流

```
handleIncomingPrivateMessage / handleIncomingGroupMessage
  ↓
extractTextPayload(payload)      → text（现有逻辑不变）
payload.attachments              → att[]（新增检测）
  ↓
[有附件] for att of attachments:
  client.call('storage.create_download_ticket', { owner_aid, object_key })
    → download_url
  fetch(download_url) → Buffer
  SHA256 校验（失败 → warn + skip，继续处理下一个）
  saveToUploads(buffer, att.filename, projectPath)
    → filePath
  ↓
组合 content：
  parts = []
  if text: parts.push(text)
  for each saved file: parts.push(`[文件: {name} → {filePath}]`)
  if any file saved: parts.push('请使用 Read 工具读取文件内容。')
  content = parts.join('\n\n') || text
  ↓
dispatchMessage({ ..., text: content })   ← 路径不变
```

## 提示格式

**text + 附件**：
```
请看这个文件

[文件: aun_cli.py → /proj/.evolclaw/uploads/aun_cli.py]
请使用 Read 工具读取文件内容。
```

**纯附件（无 text）**：
```
[文件: aun_cli.py → /proj/.evolclaw/uploads/aun_cli.py]
请使用 Read 工具读取文件内容。
```

**多附件**：
```
[文件: a.py → /proj/.evolclaw/uploads/a.py]
[文件: b.md → /proj/.evolclaw/uploads/b.md]
请使用 Read 工具读取文件内容。
```

## 错误处理

| 场景 | 行为 |
|------|------|
| `create_download_ticket` 失败 | `warn` log，跳过此附件，其他继续 |
| HTTP 下载失败（非 2xx） | `warn` log，跳过此附件 |
| SHA256 不匹配 | `warn` log，跳过此附件 |
| 所有附件均失败 | dispatch 原始 text（或空字符串，保持现有行为） |
| `projectPathProvider` 未注入 | fallback `process.cwd()` |

## 不做的事

- **不做 SSRF 校验**：`download_url` 来自 gateway ticket API，非用户直接输入
- **不做 sendFile**：`[SEND_FILE:]` marker 已有支持，本需求仅处理接收
- **不做 inline 小文件优化**：统一走 `download_ticket`，与 CLI 行为一致
- **不改动 group mention 过滤**：附件处理在 mention 检测通过之后进行

## 验证方式

1. AUN CLI 发送单文件 → 确认保存到 `{project}/.evolclaw/uploads/`
2. Agent 收到提示，能用 `Read` 工具读取文件内容
3. 多附件消息 → 每个附件逐个下载，全部出现在提示中
4. SHA256 篡改场景 → warn log，跳过，不崩溃
5. 纯文本消息 → 行为不变（回归测试）

## 关键实现细节

### `downloadAttachment` 签名
```typescript
private async downloadAttachment(
  att: { owner_aid?: string; object_key: string; filename?: string; size?: number; sha256?: string },
  channelId: string
): Promise<string | null>  // 返回 filePath 或 null（失败时）
```

### group 消息中的时序
group 消息需先通过 mention 检测（`mentionedSelf || mentionedAll`），再执行 `stripTriggerMentions`，最后在 `dispatchMessage` 调用前处理附件。这样 mention-only 消息（`strippedText` 为空但有附件）也能正确处理。

**注意**：当 `strippedText` 为空且有附件时，现有代码会在 `if (!strippedText)` 处提前 return。需要将附件检测提前到此判断之前，或将判断改为 `if (!strippedText && !hasAttachments)`。
