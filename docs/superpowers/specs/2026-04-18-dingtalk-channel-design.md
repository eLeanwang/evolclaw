# DingTalk Channel Integration Design

> Date: 2026-04-18
> Scope: DingTalk channel for EvolClaw, single/group chat, text + image/file

## Overview

Add a DingTalk channel to EvolClaw following the existing ChannelPlugin architecture. Uses the official `dingtalk-stream` TypeScript SDK for WebSocket-based message reception (Stream Mode). Text replies via `sessionWebhook` POST; image/file sending via DingTalk Open API (`/v1.0/robot/groupMessages/send` and `/v1.0/robot/oToMessages/batchSend`).

## Scope

- Single chat (robot DM) and group chat (@mention gated)
- Inbound: text, image, file (download via `downloadUrl` in callback)
- Outbound: Markdown text (sessionWebhook), image/file (Open API with `mediaId` upload)
- Passive text reply via sessionWebhook; proactive image/file via Open API
- Single-instance and multi-instance config support

### Out of Scope

- Voice/video send or receive
- AI Card streaming
- QQBot (separate future effort)

## SDK

**Package**: `dingtalk-stream` v2.1.6+
- Official DingTalk SDK, MIT license
- Native TypeScript `.d.ts`, ESM/CJS dual exports
- Outbound WebSocket (no public IP required)
- Built-in reconnection, heartbeat, ACK
- Dependencies: `axios`, `ws`

## Files Changed

| File | Change |
|------|--------|
| `src/channels/dingtalk.ts` | **New** — DingtalkChannel + DingtalkChannelPlugin |
| `src/types.ts` | Add DingtalkChannelConfig, extend Config.channels |
| `src/config.ts` | Add 'dingtalk' to channelTypes, add validation |
| `src/index.ts` | Import plugin, register, add message bridge wiring |
| `package.json` | Add `dingtalk-stream` dependency |

## Type Definitions (types.ts)

```typescript
export interface DingtalkChannelConfig {
  name?: string;
  enabled?: boolean;
  clientId: string;
  clientSecret: string;
  owner?: string;
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
  requireMention?: boolean;       // default true
  freeResponseChats?: string[];   // conversationId whitelist
}

export interface DingtalkChannelInstanceConfig extends DingtalkChannelConfig {
  name: string;
}
```

Config.channels extension:
```typescript
channels?: {
  // existing...
  dingtalk?: DingtalkChannelConfig | DingtalkChannelInstanceConfig[];
};
```

## DingtalkChannel Class

### Constructor

```typescript
interface DingtalkConfig {
  clientId: string;       // also used as robotCode for Open API
  clientSecret: string;
  requireMention?: boolean;
  freeResponseChats?: string[];
}
```

### Internal State

- `client: DWClient | null` — SDK client
- `webhookCache: Map<string, string>` — chatId → sessionWebhook URL
- `conversationIdCache: Map<string, string>` — chatId → openConversationId (for group sends)
- `senderStaffIdCache: Map<string, string>` — chatId → senderStaffId (for DM sends)
- `seenMessages: Map<string, number>` — msgId → timestamp (dedup)
- `messageHandler` — callback registered via `onMessage()`
- `cleanupInterval` — hourly cleanup of seenMessages older than 24h
- `projectPathProvider` — callback to resolve project path per channelId

### connect()

1. Validate `clientId` and `clientSecret` are present and not placeholder values
2. Construct `DWClient({ clientId, clientSecret })`
3. `registerCallbackListener(TOPIC_ROBOT, handler)` — register message callback
4. Call `client.connect()` — SDK manages WebSocket lifecycle
5. Start hourly cleanup interval
6. Set `connected = true`

### Message Reception (handleIncoming)

On each `DWClientDownStream` callback:

1. Parse `msg.data` as JSON → `RobotMessage`
2. **Dedup**: skip if `msgId` already in `seenMessages`, otherwise record it
3. **Cache sender info**: store `senderStaffId` and `conversationId` by chatId (needed for Open API sends)
4. **Group gate**: if `conversationType === "2"` and `requireMention !== false`:
   - Skip if `conversationId` not in `freeResponseChats` AND `isInAtList` is falsy
5. **Webhook cache**: validate URL against `^https://(api|oapi)\.dingtalk\.com/`, then cache by chatId
6. **ACK**: `client.socketCallBackResponse(msg.headers.messageId, ...)` to prevent 60s retry
7. **Dispatch by msgtype**:

   **`text`**: Extract text (handle `string | { content: string }`), skip empty → dispatch with `content`

   **`picture` / `image`**: Extract `downloadUrl` from `content` field
   - Download image via `safeFetch(downloadUrl)` (SSRF-protected, DingTalk CDN whitelisted)
   - Validate with `validateImage(buffer)`
   - Convert to base64, dispatch with `images: [{ data, mimeType }]` and prompt "用户发送了一张图片，请分析这张图片的内容。"

   **`file`**: Extract `downloadUrl`, `fileName` from `content` field
   - Download via `safeFetch(downloadUrl)`
   - Save with `saveToUploads(buffer, sanitizeFileName(fileName), projectPath)`
   - Dispatch with prompt "用户发送了文件：{fileName}\n文件已保存到：{filePath}\n请使用 Read 工具读取并分析文件内容。"

   **`richText`**: Iterate `content.richText[]` array
   - `type: "text"` → accumulate text
   - `type: "picture"` → download image via `downloadUrl`, add to images array
   - Dispatch with combined text + images

   **Other types**: Dispatch with `[不支持的消息类型: {msgtype}]`

### chatId Rules

- Group: `conversationId`
- DM: `senderId`

### sendMessage(chatId, content)

1. Look up `webhookCache[chatId]`; if absent, log warn and return (no error to caller)
2. `client.getAccessToken()` for auth header
3. POST to webhook: `{ msgtype: 'markdown', markdown: { title: 'Bot', text: content } }`
4. Header: `x-acs-dingtalk-access-token: <token>`
5. Timeout: 15s

### sendImage(chatId, png: Buffer)

Sends image via DingTalk Open API (not sessionWebhook):

1. **Upload media**: POST `https://oapi.dingtalk.com/media/upload?access_token={token}`
   - `type: 'image'`, `media: <buffer>` (multipart/form-data)
   - Returns `media_id`
2. **Send message**: `client.getAccessToken()` for auth
   - **Group** (has `conversationIdCache[chatId]`):
     POST `https://api.dingtalk.com/v1.0/robot/groupMessages/send`
     ```json
     { "msgKey": "sampleImageMsg", "msgParam": "{\"photoURL\":\"@media_id\"}", "openConversationId": "...", "robotCode": "{clientId}" }
     ```
   - **DM** (has `senderStaffIdCache[chatId]`):
     POST `https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`
     ```json
     { "msgKey": "sampleImageMsg", "msgParam": "{\"photoURL\":\"@media_id\"}", "userIds": ["{staffId}"], "robotCode": "{clientId}" }
     ```
3. Header: `x-acs-dingtalk-access-token: <token>`

### sendFile(chatId, filePath)

Same pattern as `sendImage`, but:

1. **Upload media**: `type: 'file'`, `media: <fileStream>` → `media_id`
2. **Send message**: `msgKey: 'sampleFile'`, `msgParam: { mediaId, fileName, fileType }`
3. Also detects image files (via `image-type` check) and routes to `sendImage` instead (same as Feishu pattern)

### onMessage(handler)

Register callback. Signature: `(opts: DingtalkMessageEvent) => Promise<void>`

### disconnect()

1. Set `connected = false`
2. Clear cleanup interval
3. `client.disconnect()`
4. Null out client

### DingtalkMessageEvent

```typescript
{
  channelId: string;     // conversationId or senderId
  content: string;       // extracted text (or prompt for image/file)
  chatType: 'private' | 'group';
  peerId: string;        // senderId
  peerName?: string;     // senderNick
  messageId?: string;    // msgId
  images?: Array<{ data: string; mimeType: string }>;  // base64 image data
}
```

## DingtalkChannelPlugin

### isEnabled(config)

Returns true if `channels.dingtalk` exists with valid `clientId` + `clientSecret` (supports array form).

### createChannels(config)

1. `normalizeChannelInstances(config.channels?.dingtalk, 'dingtalk')`
2. For each enabled instance with valid credentials:
   - Create `DingtalkChannel`
   - Build `adapter`: `{ channelName, sendText, sendFile, sendImage }`
     - `sendText`: via `channel.sendMessage()` (sessionWebhook)
     - `sendFile`: via `channel.sendFile()` (Open API upload + send)
     - `sendImage`: via `channel.sendImage()` (Open API upload + send)
   - Build `policy`: aligned with Feishu
     - `canSwitchProject`/`canListProjects`/`canImportCliSession`: owner only
     - `canCreateSession`/`canDeleteSession`: all
     - `messagePrefix`: group chat adds `[peerName]` prefix
     - `showMiddleResult`/`showIdleMonitor`: respects `showActivities` config
     - `accumulateErrors`: true
   - Build `options`: `{ flushDelay: inst.flushDelay ?? 3 }`
   - Return `ChannelInstance` with `channelType: 'dingtalk'`

## index.ts Integration

### Import & Register

```typescript
import { DingtalkChannelPlugin } from './channels/dingtalk.js';
channelLoader.register(new DingtalkChannelPlugin());
```

### Message Bridge Wiring

```typescript
if (channelType === 'dingtalk') {
  msgBridge.register(inst.adapter.channelName,
    (handler) => inst.channel.onMessage(async (opts: any) => {
      handler({
        channel: channelType,
        channelId: opts.channelId,
        content: opts.content,
        chatType: opts.chatType || 'private',
        peerId: opts.peerId || '',
        peerName: opts.peerName,
        messageId: opts.messageId,
        images: opts.images,
      });
    }),
    (channelId, text) => inst.channel.sendMessage(channelId, text),
    inst.adapter,
    channelType
  );
}
```

## config.ts Changes

1. Add `'dingtalk'` to `channelTypes` array
2. Add validation in `validateConfig`:
   - If `channels.dingtalk` exists and has `clientId` but not `clientSecret` (or vice versa): log warn

## Configuration (evolclaw.json)

Single instance:
```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "your-app-key",
      "clientSecret": "your-app-secret",
      "owner": "staffId-of-admin",
      "flushDelay": 3,
      "requireMention": true,
      "freeResponseChats": ["cidABC=="]
    }
  }
}
```

Multi-instance:
```json
{
  "channels": {
    "dingtalk": [
      { "name": "dt-prod", "clientId": "...", "clientSecret": "...", "owner": "..." },
      { "name": "dt-dev",  "clientId": "...", "clientSecret": "...", "owner": "..." }
    ]
  }
}
```

## Key Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| sessionWebhook expires (~1h) | Cache refreshed on every inbound message; passive reply only |
| SDK text field format varies | Multi-path extraction: `string \| { content }` |
| SSRF via webhook URL | Regex validation before caching |
| SSRF via downloadUrl | Use `safeFetch()` with DingTalk CDN domain added to whitelist |
| Message duplication on network jitter | msgId-based dedup with Map + hourly cleanup |
| SDK runs callback in different context | DWClient handles this internally (unlike Python SDK threading) |
| Open API send needs chatType context | Cache `conversationId` + `senderStaffId` from inbound messages |
| media_id upload may fail | Log error, skip file send, text reply still works via webhook |

### SSRF Whitelist Addition

Add DingTalk download domains to `media-cache.ts` SSRF whitelist:
- `*.dingtalk.com` (covers `oapi.dingtalk.com`, `api.dingtalk.com`)
- Or specific: `download.dingtalk.com` (if CDN domain is known)

## Testing

- Unit test: DingtalkChannelPlugin.isEnabled with various config shapes
- Unit test: text extraction from both `string` and `{ content }` formats
- Unit test: group gate logic (requireMention / freeResponseChats / isInAtList)
- Unit test: webhook SSRF validation
- Unit test: message dedup
- Unit test: inbound image/file download and dispatch
- Unit test: sendImage/sendFile media upload + API call (mocked)
- Unit test: image file detection routing in sendFile
- Integration test: config validation in config.ts
