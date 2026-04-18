# DingTalk Channel Integration Design

> Date: 2026-04-18
> Scope: DingTalk channel for EvolClaw, single/group chat, text-only

## Overview

Add a DingTalk channel to EvolClaw following the existing ChannelPlugin architecture. Uses the official `dingtalk-stream` TypeScript SDK for WebSocket-based message reception (Stream Mode) and replies via `sessionWebhook` POST.

## Scope

- Single chat (robot DM) and group chat (@mention gated)
- Text in, Markdown out (DingTalk renders Markdown natively)
- Passive reply only (sessionWebhook, no proactive push)
- Single-instance and multi-instance config support

### Out of Scope

- Image/file/voice send or receive
- Proactive messaging (`@alicloud/dingtalk` REST API)
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
  clientId: string;
  clientSecret: string;
  requireMention?: boolean;
  freeResponseChats?: string[];
}
```

### Internal State

- `client: DWClient | null` — SDK client
- `webhookCache: Map<string, string>` — chatId → sessionWebhook URL
- `seenMessages: Map<string, number>` — msgId → timestamp (dedup)
- `messageHandler` — callback registered via `onMessage()`
- `cleanupInterval` — hourly cleanup of seenMessages older than 24h

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
3. **Text extraction**: handle `text` as `string | { content: string }` (SDK version compat)
4. Skip empty text
5. **Group gate**: if `conversationType === "2"` and `requireMention !== false`:
   - Skip if `conversationId` not in `freeResponseChats` AND `isInAtList` is falsy
6. **Webhook cache**: validate URL against `^https://(api|oapi)\.dingtalk\.com/`, then cache by chatId
7. **ACK**: `client.socketCallBackResponse(msg.headers.messageId, ...)` to prevent 60s retry
8. **Dispatch**: call `messageHandler` with event object

### chatId Rules

- Group: `conversationId`
- DM: `senderId`

### sendMessage(chatId, content)

1. Look up `webhookCache[chatId]`; if absent, log warn and return (no error to caller)
2. `client.getAccessToken()` for auth header
3. POST to webhook: `{ msgtype: 'markdown', markdown: { title: 'Bot', text: content } }`
4. Header: `x-acs-dingtalk-access-token: <token>`
5. Timeout: 15s

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
  content: string;       // extracted text
  chatType: 'private' | 'group';
  peerId: string;        // senderId
  peerName?: string;     // senderNick
  messageId?: string;    // msgId
}
```

## DingtalkChannelPlugin

### isEnabled(config)

Returns true if `channels.dingtalk` exists with valid `clientId` + `clientSecret` (supports array form).

### createChannels(config)

1. `normalizeChannelInstances(config.channels?.dingtalk, 'dingtalk')`
2. For each enabled instance with valid credentials:
   - Create `DingtalkChannel`
   - Build `adapter`: `{ channelName, sendText }`
     - Only `sendText` (no sendFile/sendImage — DingTalk webhook doesn't support native file upload)
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
| Message duplication on network jitter | msgId-based dedup with Map + hourly cleanup |
| SDK runs callback in different context | DWClient handles this internally (unlike Python SDK threading) |

## Testing

- Unit test: DingtalkChannelPlugin.isEnabled with various config shapes
- Unit test: text extraction from both `string` and `{ content }` formats
- Unit test: group gate logic (requireMention / freeResponseChats / isInAtList)
- Unit test: webhook SSRF validation
- Unit test: message dedup
- Integration test: config validation in config.ts
