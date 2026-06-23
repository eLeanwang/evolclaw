# Multi-Instance Channel Support

Allow a single EvolClaw process to host multiple bot accounts per channel type (Feishu, WeChat, AUN), each with independent sessions.

## Problem

Current config supports one set of credentials per channel type. Users who need multiple bots (e.g., work bot + personal bot) must run separate EvolClaw processes.

## Design

### 1. Config Structure

Each channel type supports either a single object (backward compatible) or an array of instances:

```jsonc
"channels": {
  // Single instance (legacy, still works)
  "feishu": { "appId": "A", "appSecret": "S", "owner": "user_123" },

  // Multi-instance
  "feishu": [
    { "name": "feishu-work", "appId": "A1", "appSecret": "S1", "owner": "user_123" },
    { "name": "feishu-home", "appId": "A2", "appSecret": "S2", "owner": "user_123" }
  ],
  "wechat": [
    { "name": "wechat-main", "token": "T1", "owner": "user_123" },
    { "name": "wechat-test", "token": "T2", "owner": "user_456" }
  ],
  "aun": [
    { "name": "aun-prod", "aid": "bot1.agentid.pub", "owner": "..." },
    { "name": "aun-dev",  "aid": "bot2.agentid.pub", "owner": "..." }
  ]
}
```

**Backward compatibility**: Single object format is normalized to a one-element array at load time, with `name` defaulting to the channel type name (e.g., `"feishu"`).

### 2. Normalization

A single utility function normalizes all channel configs at startup:

```typescript
function normalizeInstances<T>(
  cfg: T | T[] | undefined,
  defaultName: string
): (T & { name: string })[] {
  if (!cfg) return [];
  if (Array.isArray(cfg)) return cfg as any;
  return [{ ...cfg, name: defaultName }];
}
```

After normalization, all downstream code works with arrays uniformly.

### 3. Instance Name Uniqueness

After normalizing all channel types, validate name uniqueness globally (across all channel types):

```typescript
const seen = new Set<string>();
for (const inst of allInstances) {
  if (seen.has(inst.name)) {
    throw new Error(`Duplicate channel instance name: "${inst.name}"`);
  }
  seen.add(inst.name);
}
```

This runs in `validateConfig()` at startup. Duplicate names cause immediate exit with a clear error message.

### 4. Initialization Loop (index.ts)

Replace per-channel-type single initialization with a loop:

```typescript
for (const inst of normalizeInstances(config.channels?.feishu, 'feishu')) {
  const ch = new FeishuChannel(inst.appId, inst.appSecret);
  const adapter: ChannelAdapter = {
    name: inst.name,
    sendText: (id, text, ctx) => ch.sendMessage(id, text, ctx),
    sendFile: (id, path, ctx) => ch.sendFile(id, path, ctx),
    // ...
  };
  processor.registerChannel(adapter, feishuOptions);
  cmdHandler.registerAdapter(adapter);
  cmdHandler.registerChannel(inst.name, ch);
  // Wire message queue...
  await ch.connect();
}
// Same pattern for wechat, aun
```

### 5. Session Isolation

**No changes needed.** Sessions are keyed by `(channel, channelId, ...)` where `channel` = instance name. Different instances produce different channel names, so sessions are naturally isolated.

### 6. Owner Management

`getOwner()`, `setOwner()`, `isOwner()` currently index by channel type name (e.g., `"feishu"`). They must be updated to index by instance name.

After normalization, owner lookup becomes:

```typescript
export function getOwner(config: Config, instanceName: string): string | undefined {
  // Search across all channel type arrays for the matching instance name
  for (const type of ['feishu', 'wechat', 'aun'] as const) {
    const instances = normalizeInstances(config.channels?.[type], type);
    const inst = instances.find(i => i.name === instanceName);
    if (inst) return inst.owner;
  }
  return undefined;
}
```

`autoBindOwner()` in `message-bridge.ts` writes the owner to the correct instance within the array.

### 7. Cross-Channel File Transfer

`/file` command works unchanged. The user specifies the instance name:

```
/file wechat-main report.md
/file feishu-home data.csv
```

Lookup chain:
1. `adapters.get('wechat-main')` → find adapter
2. `getOwner(config, 'wechat-main')` → find owner userId
3. `getOwnerChatId('wechat-main', ownerPeerId)` → query sessions table for owner's private chat channelId
4. `adapter.sendFile(channelId, filePath)` → send

Single-instance users continue using the type name: `/file feishu report.md` (works because default name = type name).

### 8. CLI Init

Command syntax unchanged:

```bash
evolclaw init feishu
evolclaw init wechat
evolclaw init aun
```

**Behavior when instances already exist:**

```
$ evolclaw init feishu

发现已有 Feishu 机器人：
  a. feishu
  b. feishu-2
  c. 添加新机器人

请选择: _
```

- **Select a/b** (existing instance): Second confirmation required before overwriting.
  ```
  ⚠️ 即将覆盖 "feishu" 的配置，确认？(y/N): _
  ```
  Then proceeds to login flow, replacing that instance's credentials.

- **Select c** (new instance): Prompts for instance name, then proceeds to login flow. Appends to array. If config was in single-object format, auto-upgrades to array format.

**No existing instances**: Skips selection, goes directly to login flow (identical to current behavior).

### 9. Restart-Monitor Notifications

`notifyChannel()` in `src/cli.ts` currently reads `pendingInfo.channel` (e.g., `"feishu"`) to route restart notifications. Must be updated to store and read the instance name instead of the channel type.

`restart-pending.json` already stores `channel` — just ensure it stores the instance name (e.g., `"feishu-work"` not `"feishu"`).

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Channel config types: `T \| T[]` for feishu/wechat/aun |
| `src/config.ts` | `normalizeInstances()`, update `getOwner()`/`setOwner()`/`isOwner()`, validation |
| `src/index.ts` | Initialization loops for all channel types |
| `src/cli.ts` | `notifyChannel()` adapts to array config; init subcommands add instance selection |
| `src/utils/init-feishu.ts` | Instance selection UI when existing instances found |
| `src/utils/init-wechat.ts` | Instance selection UI when existing instances found |

## Files NOT Changed

| File | Reason |
|------|--------|
| `src/channels/feishu.ts` | Already instantiable, no channel-name awareness |
| `src/channels/wechat.ts` | Already instantiable, no channel-name awareness |
| `src/core/session-manager.ts` | `channel` is already `string`, isolation is by `channelId` |
| `src/core/command-handler.ts` | No channel-type hardcoding |
| `src/core/message-processor.ts` | No channel-type hardcoding |
| `src/core/message-queue.ts` | Keyed by session.id |
| `src/core/message-bridge.ts` | Uses adapter.name, no change needed beyond autoBindOwner |

## Migration

- Existing single-object configs work without any modification
- Array format is only created when user explicitly adds a second instance via `init`
- No database migration needed — `session.channel` was already a free-form string
