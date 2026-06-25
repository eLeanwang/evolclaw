# Multi-Instance Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a single EvolClaw process to host multiple bot accounts per channel type (Feishu, WeChat, AUN), each with independent sessions.

**Architecture:** Channel config types gain `T | T[]` support. A `normalizeChannelInstances()` utility normalizes single-object configs into arrays at load time. Each array element has a mandatory `name` field used as the channel instance identifier throughout the system (session.channel, adapter name, owner lookup). The ChannelPlugin interface gains a `createChannels()` method that returns multiple instances from an array config. Init commands detect existing instances and present a selection menu.

**Tech Stack:** TypeScript, Vitest, readline (CLI interaction)

---

### File Structure

| File | Role |
|------|------|
| `src/types.ts` | Add `ChannelInstanceConfig` type, update channel config types to `T \| T[]` |
| `src/config.ts` | Add `normalizeChannelInstances()`, update `getOwner()`/`setOwner()`/`isOwner()` |
| `src/core/channel-loader.ts` | Update `ChannelPlugin` to support multi-instance via `createChannels()` |
| `src/channels/feishu.ts` | Update `FeishuChannelPlugin` to implement `createChannels()` |
| `src/channels/wechat.ts` | Update `WechatChannelPlugin` to implement `createChannels()` |
| `src/channels/aun.ts` | Update `AUNChannelPlugin` to implement `createChannels()` |
| `src/index.ts` | Update `channel:health` cross-notify to use `getOwner()` instead of direct config access |
| `src/core/message-bridge.ts` | Update `autoBindOwner()` to use `setOwner()` with instance name |
| `src/cli.ts` | Update `notifyChannel()` to resolve instance config from name |
| `src/utils/init-feishu.ts` | Add instance selection UI for existing instances |
| `src/utils/init-wechat.ts` | Add instance selection UI for existing instances |
| `tests/unit/multi-instance-channels.test.ts` | Tests for normalize, owner, validation |
| `tests/unit/registry.test.ts` | Add multi-instance ChannelLoader tests |

---

### Task 1: Config Types and Normalization

**Files:**
- Modify: `src/types.ts:27-61` (channel config types)
- Modify: `src/config.ts` (add normalizeChannelInstances, update owner functions)
- Create: `tests/unit/multi-instance-channels.test.ts`

- [ ] **Step 1: Write failing tests for normalizeChannelInstances**

```typescript
// tests/unit/multi-instance-channels.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeChannelInstances, getOwner, setOwner, isOwner } from '../../src/config.js';
import { Config } from '../../src/types.js';

function makeConfig(channels?: Config['channels']): Config {
  return {
    channels,
    projects: { defaultPath: '/tmp', autoCreate: false },
  };
}

describe('normalizeChannelInstances', () => {
  it('should return empty array for undefined config', () => {
    expect(normalizeChannelInstances(undefined, 'feishu')).toEqual([]);
  });

  it('should normalize single object to array with default name', () => {
    const single = { appId: 'A', appSecret: 'S', owner: 'u1' };
    const result = normalizeChannelInstances(single, 'feishu');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('feishu');
    expect(result[0].appId).toBe('A');
  });

  it('should pass through array unchanged', () => {
    const arr = [
      { name: 'feishu-work', appId: 'A1', appSecret: 'S1' },
      { name: 'feishu-home', appId: 'A2', appSecret: 'S2' },
    ];
    const result = normalizeChannelInstances(arr, 'feishu');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('feishu-work');
    expect(result[1].name).toBe('feishu-home');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/multi-instance-channels.test.ts`
Expected: FAIL — `normalizeChannelInstances` is not exported

- [ ] **Step 3: Update types.ts — add name field to channel configs**

In `src/types.ts`, add optional `name` field to each channel config type:

```typescript
// Add to the feishu config object type (inside Config.channels.feishu):
    feishu?: {
      name?: string;  // Instance name, defaults to 'feishu'
      enabled?: boolean;
      appId: string;
      appSecret: string;
      owner?: string;
      flushDelay?: number;
      debounce?: number;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
      enableRichContent?: boolean;
    } | Array<{
      name: string;   // Required in array form
      enabled?: boolean;
      appId: string;
      appSecret: string;
      owner?: string;
      flushDelay?: number;
      debounce?: number;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
      enableRichContent?: boolean;
    }>;

// Same pattern for wechat:
    wechat?: {
      name?: string;
      enabled?: boolean;
      baseUrl?: string;
      token?: string;
      owner?: string;
      flushDelay?: number;
      debounce?: number;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
    } | Array<{
      name: string;
      enabled?: boolean;
      baseUrl?: string;
      token?: string;
      owner?: string;
      flushDelay?: number;
      debounce?: number;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
    }>;

// Same pattern for aun:
    aun?: {
      name?: string;
      enabled?: boolean;
      aid: string;
      keystorePath?: string;
      gatewayPort?: number;
      gatewayUrl?: string;
      accessToken?: string;
      owner?: string;
      flushDelay?: number;
      pythonBin?: string;
      encryptionSeed?: string;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
    } | Array<{
      name: string;
      enabled?: boolean;
      aid: string;
      keystorePath?: string;
      gatewayPort?: number;
      gatewayUrl?: string;
      accessToken?: string;
      owner?: string;
      flushDelay?: number;
      pythonBin?: string;
      encryptionSeed?: string;
      showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
    }>;
```

- [ ] **Step 4: Implement normalizeChannelInstances in config.ts**

Add to `src/config.ts`:

```typescript
/**
 * Normalize channel config: single object → array with default name.
 * Array format passes through unchanged.
 */
export function normalizeChannelInstances<T extends Record<string, any>>(
  cfg: T | T[] | undefined,
  defaultName: string
): (T & { name: string })[] {
  if (!cfg) return [];
  if (Array.isArray(cfg)) return cfg as (T & { name: string })[];
  return [{ ...cfg, name: (cfg as any).name || defaultName }];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/multi-instance-channels.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing tests for owner functions with instance names**

Append to `tests/unit/multi-instance-channels.test.ts`:

```typescript
describe('getOwner with multi-instance', () => {
  it('should find owner by instance name in single-object config', () => {
    const config = makeConfig({
      feishu: { appId: 'A', appSecret: 'S', owner: 'user_123' },
    });
    expect(getOwner(config, 'feishu')).toBe('user_123');
  });

  it('should find owner by instance name in array config', () => {
    const config = makeConfig({
      feishu: [
        { name: 'feishu-work', appId: 'A1', appSecret: 'S1', owner: 'user_a' },
        { name: 'feishu-home', appId: 'A2', appSecret: 'S2', owner: 'user_b' },
      ] as any,
    });
    expect(getOwner(config, 'feishu-work')).toBe('user_a');
    expect(getOwner(config, 'feishu-home')).toBe('user_b');
  });

  it('should return undefined for unknown instance name', () => {
    const config = makeConfig({
      feishu: { appId: 'A', appSecret: 'S', owner: 'user_123' },
    });
    expect(getOwner(config, 'nonexistent')).toBeUndefined();
  });
});

describe('isOwner with multi-instance', () => {
  it('should check owner on specific instance', () => {
    const config = makeConfig({
      feishu: [
        { name: 'feishu-work', appId: 'A1', appSecret: 'S1', owner: 'user_a' },
        { name: 'feishu-home', appId: 'A2', appSecret: 'S2', owner: 'user_b' },
      ] as any,
    });
    expect(isOwner(config, 'feishu-work', 'user_a')).toBe(true);
    expect(isOwner(config, 'feishu-work', 'user_b')).toBe(false);
    expect(isOwner(config, 'feishu-home', 'user_b')).toBe(true);
  });
});

describe('validateChannelInstanceNames', () => {
  it('should throw on duplicate names across channel types', () => {
    const config = makeConfig({
      feishu: [{ name: 'bot-a', appId: 'A', appSecret: 'S' }] as any,
      wechat: [{ name: 'bot-a', token: 'T', enabled: true }] as any,
    });
    expect(() => validateChannelInstanceNames(config)).toThrow('Duplicate channel instance name');
  });

  it('should pass with unique names', () => {
    const config = makeConfig({
      feishu: [{ name: 'feishu-a', appId: 'A', appSecret: 'S' }] as any,
      wechat: [{ name: 'wechat-a', token: 'T', enabled: true }] as any,
    });
    expect(() => validateChannelInstanceNames(config)).not.toThrow();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/unit/multi-instance-channels.test.ts`
Expected: FAIL — owner functions don't handle array configs yet

- [ ] **Step 8: Update getOwner, setOwner, isOwner in config.ts**

Replace the existing `getOwner`, `setOwner`, `isOwner` functions in `src/config.ts`:

```typescript
const channelTypes = ['feishu', 'wechat', 'aun'] as const;

export function getOwner(config: Config, instanceName: string): string | undefined {
  for (const type of channelTypes) {
    const instances = normalizeChannelInstances((config.channels as any)?.[type], type);
    const inst = instances.find(i => i.name === instanceName);
    if (inst) return inst.owner;
  }
  return undefined;
}

export function setOwner(config: Config, instanceName: string, userId: string, configPath: string = resolvePaths().config): void {
  if (!config.channels) config.channels = {};
  const channels = config.channels as any;

  for (const type of channelTypes) {
    const raw = channels[type];
    if (!raw) continue;

    if (Array.isArray(raw)) {
      const inst = raw.find((i: any) => i.name === instanceName);
      if (inst) {
        inst.owner = userId;
        saveConfig(config, configPath);
        return;
      }
    } else {
      // Single object — check if instanceName matches the type name (default name)
      const name = raw.name || type;
      if (name === instanceName) {
        raw.owner = userId;
        saveConfig(config, configPath);
        return;
      }
    }
  }

  // Fallback: create channel entry (shouldn't normally happen)
  channels[instanceName] = { owner: userId };
  saveConfig(config, configPath);
}

export function isOwner(config: Config, instanceName: string, userId: string): boolean {
  return getOwner(config, instanceName) === userId;
}
```

- [ ] **Step 9: Add validateChannelInstanceNames to config.ts**

```typescript
/**
 * Validate that all channel instance names are globally unique.
 * Called during config loading.
 */
export function validateChannelInstanceNames(config: Config): void {
  const seen = new Set<string>();
  for (const type of channelTypes) {
    const instances = normalizeChannelInstances((config.channels as any)?.[type], type);
    for (const inst of instances) {
      if (seen.has(inst.name)) {
        throw new Error(`Duplicate channel instance name: "${inst.name}"`);
      }
      seen.add(inst.name);
    }
  }
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run tests/unit/multi-instance-channels.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/config.ts tests/unit/multi-instance-channels.test.ts
git commit -m "feat: add normalizeChannelInstances and multi-instance owner functions"
```

---

### Task 2: ChannelLoader Multi-Instance Support

**Files:**
- Modify: `src/core/channel-loader.ts`
- Modify: `src/channels/feishu.ts` (FeishuChannelPlugin)
- Modify: `src/channels/wechat.ts` (WechatChannelPlugin)
- Modify: `src/channels/aun.ts` (AUNChannelPlugin)
- Modify: `tests/unit/registry.test.ts`

- [ ] **Step 1: Write failing test for multi-instance channel loader**

Append to `tests/unit/registry.test.ts`:

```typescript
it('should support plugins that create multiple instances', async () => {
  const loader = new ChannelLoader();
  const mockPlugin: ChannelPlugin = {
    name: 'test',
    isEnabled: () => true,
    createChannel: async () => ({
      adapter: { name: 'test', sendText: async () => {} },
      channel: {},
      connect: async () => {},
      disconnect: async () => {},
    }),
    createChannels: async () => [
      {
        adapter: { name: 'test-a', sendText: async () => {} },
        channel: {},
        connect: async () => {},
        disconnect: async () => {},
      },
      {
        adapter: { name: 'test-b', sendText: async () => {} },
        channel: {},
        connect: async () => {},
        disconnect: async () => {},
      },
    ],
  };

  loader.register(mockPlugin);
  const instances = await loader.createAll({} as any);

  expect(instances).toHaveLength(2);
  expect(instances[0].adapter.name).toBe('test-a');
  expect(instances[1].adapter.name).toBe('test-b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: FAIL — `createChannels` is not on the type

- [ ] **Step 3: Update ChannelPlugin interface and ChannelLoader.createAll**

In `src/core/channel-loader.ts`:

```typescript
export interface ChannelPlugin {
  readonly name: string;
  isEnabled(config: Config): boolean;
  createChannel(config: Config): Promise<ChannelInstance>;
  /** Optional: create multiple instances from array config */
  createChannels?(config: Config): Promise<ChannelInstance[]>;
}
```

Update `createAll` in `ChannelLoader`:

```typescript
async createAll(config: Config): Promise<ChannelInstance[]> {
  const instances: ChannelInstance[] = [];

  for (const [name, plugin] of this.plugins) {
    if (!plugin.isEnabled(config)) {
      logger.info(`Channel '${name}' is disabled, skipping`);
      continue;
    }

    try {
      if (plugin.createChannels) {
        const channelInstances = await plugin.createChannels(config);
        instances.push(...channelInstances);
        logger.info(`✓ Channel '${name}' created ${channelInstances.length} instance(s)`);
      } else {
        const instance = await plugin.createChannel(config);
        instances.push(instance);
        logger.info(`✓ Channel '${name}' instance created`);
      }
    } catch (error) {
      logger.error(`✗ Failed to create channel '${name}':`, error);
    }
  }

  return instances;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Update FeishuChannelPlugin to implement createChannels**

In `src/channels/feishu.ts`, update `FeishuChannelPlugin`:

```typescript
export class FeishuChannelPlugin implements ChannelPlugin {
  readonly name = 'feishu';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.feishu;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && inst.appId && inst.appSecret);
    }
    if (raw.enabled === false) return false;
    return !!(raw.appId && raw.appSecret);
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    // Kept for backward compat — delegates to createChannels()[0]
    const instances = await this.createChannels(config);
    if (instances.length === 0) throw new Error('Feishu config missing');
    return instances[0];
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const { normalizeChannelInstances } = await import('../config.js');
    const rawInstances = normalizeChannelInstances(config.channels?.feishu, 'feishu');
    const instances: ChannelInstance[] = [];

    for (const feishuConfig of rawInstances) {
      if (feishuConfig.enabled === false) continue;
      if (!feishuConfig.appId || !feishuConfig.appSecret) continue;

      const channel = new FeishuChannel({
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        enableRichContent: feishuConfig.enableRichContent,
      });

      const instanceName = feishuConfig.name;

      const adapter = {
        name: instanceName,
        sendText: (id: string, text: string, context?: any) => channel.sendMessage(id, text, context),
        sendFile: (id: string, filePath: string, context?: any) => channel.sendFile(id, filePath, context),
        sendImage: (id: string, png: Buffer, context?: any) => channel.sendImage(id, png, context),
        acknowledge: (messageId: string) => { channel.addAckReaction(messageId); return Promise.resolve(); },
      };

      const policy = {
        canSwitchProject: (chatType: string, identity: string) => identity === 'owner',
        canListProjects: (chatType: string, identity: string) => identity === 'owner',
        canCreateSession: (chatType: string, identity: string) => true,
        canDeleteSession: (chatType: string, identity: string) => true,
        canImportCliSession: (chatType: string, identity: string) => identity === 'owner',
        messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
        showMiddleResult: (chatType: string, identity: string) => {
          const mode = feishuConfig.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        showIdleMonitor: (chatType: string, identity: string) => {
          const mode = feishuConfig.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        accumulateErrors: (chatType: string, identity: string) => true,
      };

      const options = {
        fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
        supportsImages: true,
        flushDelay: feishuConfig.flushDelay,
      };

      instances.push({
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: () => Promise.resolve(''),
      });
    }

    return instances;
  }
}
```

- [ ] **Step 6: Update WechatChannelPlugin to implement createChannels**

Same pattern as Feishu. In `src/channels/wechat.ts`, update `WechatChannelPlugin`:

```typescript
export class WechatChannelPlugin implements ChannelPlugin {
  readonly name = 'wechat';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.wechat;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && inst.token);
    }
    return raw.enabled === true && !!raw.token;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const instances = await this.createChannels(config);
    if (instances.length === 0) throw new Error('WeChat config missing');
    return instances[0];
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const { normalizeChannelInstances } = await import('../config.js');
    const rawInstances = normalizeChannelInstances(config.channels?.wechat, 'wechat');
    const instances: ChannelInstance[] = [];

    for (const wechatConfig of rawInstances) {
      if (wechatConfig.enabled === false) continue;
      if (!wechatConfig.token) continue;

      const channel = new WechatChannel({
        baseUrl: wechatConfig.baseUrl || 'https://ilinkai.weixin.qq.com',
        token: wechatConfig.token,
      });

      const instanceName = wechatConfig.name;

      const adapter = {
        name: instanceName,
        sendText: (id: string, text: string) => channel.sendMessage(id, text),
        sendFile: (id: string, filePath: string) => channel.sendFile(id, filePath),
      };

      // ... policy and options same as current, using wechatConfig and instanceName
      // (Full code omitted here — identical structure to current plugin, just using
      //  wechatConfig from the loop variable instead of config.channels.wechat)

      instances.push({
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: () => Promise.resolve(''),
      });
    }

    return instances;
  }
}
```

- [ ] **Step 7: Update AUNChannelPlugin to implement createChannels**

Same pattern. In `src/channels/aun.ts`, update `AUNChannelPlugin`.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: PASS (all existing + new tests)

- [ ] **Step 9: Commit**

```bash
git add src/core/channel-loader.ts src/channels/feishu.ts src/channels/wechat.ts src/channels/aun.ts tests/unit/registry.test.ts
git commit -m "feat: ChannelPlugin multi-instance support (createChannels)"
```

---

### Task 3: MessageBridge and index.ts Adaptations

**Files:**
- Modify: `src/index.ts:237-298` (message bridge registration)
- Modify: `src/index.ts:336-352` (channel:health cross-notify)
- Modify: `src/core/message-bridge.ts:160-169` (autoBindOwner)

- [ ] **Step 1: Update autoBindOwner in message-bridge.ts**

The current code accesses `config.channels[channel]` directly. With multi-instance, the channel name is an instance name (e.g., `feishu-work`), not a type name. Update to use `getOwner`/`setOwner`:

```typescript
/** 首次交互自动绑定 owner */
private async autoBindOwner(channel: string, userId: string): Promise<void> {
  const { getOwner, setOwner } = await import('../config.js');
  const currentOwner = getOwner(this.config, channel);
  if (currentOwner === undefined) {
    // No owner yet — but we need to verify the instance exists in config
    // getOwner returns undefined for both "no owner" and "instance not found"
    // setOwner handles finding the right instance
    setOwner(this.config, channel, userId);
    logger.info(`[Owner] Auto-bound ${channel} owner: ${userId}`);
    this.eventBus.publish({ type: 'channel:owner-bound', channel, userId });
  }
}
```

- [ ] **Step 2: Update message bridge registration in index.ts**

The current code checks `inst.adapter.name === 'feishu'` to decide which registration style to use. With multi-instance, instance names may be `feishu-work`, `feishu-home`, etc.

Instead of string equality, add a `channelType` field to `ChannelInstance` so the bridge knows which registration pattern to use:

In `src/core/channel-loader.ts`, add to `ChannelInstance`:
```typescript
export interface ChannelInstance {
  /** Channel type (e.g., 'feishu', 'wechat', 'aun') — used for message bridge wiring */
  channelType?: string;
  // ... existing fields
}
```

In each plugin's `createChannels`, set `channelType`:
```typescript
instances.push({
  channelType: 'feishu',  // or 'wechat', 'aun'
  adapter,
  // ...
});
```

Update `index.ts` message bridge registration from `inst.adapter.name === 'feishu'` to `inst.channelType === 'feishu'`:

```typescript
for (const inst of channelInstances) {
  const channelType = inst.channelType || inst.adapter.name;

  if (channelType === 'feishu') {
    msgBridge.register(inst.adapter.name, /* ... same handler code ... */);
    // ...
  }

  if (channelType === 'wechat') {
    // ...
  }

  if (channelType === 'aun') {
    // ...
  }
}
```

- [ ] **Step 3: Update channel:health cross-notify in index.ts**

Replace direct `config.channels` access with `getOwner()`:

```typescript
// Line 344-351 in index.ts
eventBus.subscribe('channel:health', (event) => {
  if (event.type !== 'channel:health' || event.status !== 'auth_error') return;
  const sourceChannel = event.channel;
  const msg = event.message;
  logger.error(`[ChannelHealth] ${sourceChannel} auth_error: ${msg}`);

  for (const other of channelInstances) {
    if (other.adapter.name === sourceChannel) continue;
    const ownerId = getOwner(config, other.adapter.name);
    if (ownerId) {
      other.adapter.sendText(ownerId, msg).catch(err => {
        logger.error(`[ChannelHealth] Failed to notify ${other.adapter.name} owner:`, err);
      });
    }
  }
});
```

- [ ] **Step 4: Update preloadThreads to handle multiple feishu instances**

```typescript
for (const inst of channelInstances) {
  const channelType = inst.channelType || inst.adapter.name;
  if (channelType === 'feishu' && 'preloadThreads' in inst.channel) {
    const threadIds = sessionManager.getKnownThreadIds(inst.adapter.name);
    (inst.channel as any).preloadThreads(threadIds);
  }
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/core/message-bridge.ts src/core/channel-loader.ts
git commit -m "feat: adapt message bridge and cross-notify for multi-instance channels"
```

---

### Task 4: Startup Validation

**Files:**
- Modify: `src/index.ts` (add instance name validation at startup)
- Modify: `src/config.ts` (integrate into validateConfig or standalone)

- [ ] **Step 1: Write failing test for startup validation**

Append to `tests/unit/multi-instance-channels.test.ts`:

```typescript
describe('validateChannelInstanceNames - edge cases', () => {
  it('should allow single-object configs with default names', () => {
    const config = makeConfig({
      feishu: { appId: 'A', appSecret: 'S' },
      wechat: { token: 'T', enabled: true },
    });
    expect(() => validateChannelInstanceNames(config)).not.toThrow();
  });

  it('should detect duplicate within same channel type', () => {
    const config = makeConfig({
      feishu: [
        { name: 'dup', appId: 'A1', appSecret: 'S1' },
        { name: 'dup', appId: 'A2', appSecret: 'S2' },
      ] as any,
    });
    expect(() => validateChannelInstanceNames(config)).toThrow('Duplicate channel instance name: "dup"');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (already implemented in Task 1)**

Run: `npx vitest run tests/unit/multi-instance-channels.test.ts`
Expected: PASS

- [ ] **Step 3: Add validation call in index.ts after config load**

In `src/index.ts`, after `validateConfigIntegrity`:

```typescript
import { validateChannelInstanceNames } from './config.js';

// After line 62 (after integrity check)
validateChannelInstanceNames(config);
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/config.ts
git commit -m "feat: validate channel instance name uniqueness at startup"
```

---

### Task 5: CLI notifyChannel Adaptation

**Files:**
- Modify: `src/cli.ts:913-990` (notifyChannel function)

- [ ] **Step 1: Update notifyChannel to resolve instance config from name**

The current code uses `config.channels?.feishu?.appId` directly. With multi-instance, `pendingInfo.channel` is an instance name like `feishu-work`. We need to find the matching instance config:

```typescript
async function notifyChannel(
  p: ReturnType<typeof resolvePaths>,
  pendingInfo: { channel: string; channelId: string; rootId?: string } | null,
  message: string,
  log: (msg: string) => void
) {
  if (!pendingInfo) return;

  const configPath = path.join(p.dataDir, 'evolclaw.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Resolve instance config by instance name
  const instanceConfig = resolveInstanceConfig(config, pendingInfo.channel);
  if (!instanceConfig) {
    log(`Channel instance "${pendingInfo.channel}" not found in config`);
    return;
  }

  if (instanceConfig.type === 'feishu') {
    const inst = instanceConfig.config;
    if (!inst.appId || !inst.appSecret) return;
    // ... rest of feishu notification code using inst.appId, inst.appSecret
  } else if (instanceConfig.type === 'wechat') {
    const inst = instanceConfig.config;
    if (!inst.token) return;
    // ... rest of wechat notification code using inst.token, inst.baseUrl
  }
}
```

Add helper function:

```typescript
function resolveInstanceConfig(config: any, instanceName: string): { type: string; config: any } | null {
  for (const type of ['feishu', 'wechat', 'aun']) {
    const raw = config.channels?.[type];
    if (!raw) continue;
    if (Array.isArray(raw)) {
      const inst = raw.find((i: any) => i.name === instanceName);
      if (inst) return { type, config: inst };
    } else {
      const name = raw.name || type;
      if (name === instanceName) return { type, config: raw };
    }
  }
  return null;
}
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: notifyChannel resolves instance config by name"
```

---

### Task 6: Init Command — Multi-Instance Selection UI

**Files:**
- Modify: `src/utils/init-feishu.ts`
- Modify: `src/utils/init-wechat.ts`

- [ ] **Step 1: Add instance selection helper**

Create a shared helper in `src/utils/init-common.ts`:

```typescript
import readline from 'readline';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export interface InstanceChoice {
  action: 'overwrite';
  index: number;
  name: string;
} | {
  action: 'add';
}

/**
 * Present instance selection menu when existing instances are found.
 * Returns the user's choice, or null if cancelled.
 */
export async function selectInstance(
  rl: readline.Interface,
  channelType: string,
  instances: Array<{ name: string; [key: string]: any }>
): Promise<InstanceChoice | null> {
  const typeLabel = channelType === 'feishu' ? '飞书' : channelType === 'wechat' ? '微信' : 'AUN';
  console.log(`\n发现已有 ${typeLabel} 机器人：`);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < instances.length; i++) {
    console.log(`  ${letters[i]}. ${instances[i].name}`);
  }
  console.log(`  ${letters[instances.length]}. 添加新机器人`);
  console.log('');

  const validOptions = letters.slice(0, instances.length + 1);
  let choice = '';
  while (!validOptions.includes(choice)) {
    choice = (await ask(rl, '请选择: ')).trim().toLowerCase();
    if (!validOptions.includes(choice)) {
      console.log(`无效选择，请输入 ${validOptions.split('').join('/')}`);
    }
  }

  const choiceIndex = letters.indexOf(choice);
  if (choiceIndex === instances.length) {
    // Add new
    let name = '';
    while (!name) {
      name = (await ask(rl, '请输入新机器人名称: ')).trim();
      if (!name) console.log('  名称不能为空');
      if (instances.some(i => i.name === name)) {
        console.log(`  名称 "${name}" 已存在，请换一个`);
        name = '';
      }
    }
    return { action: 'add', name };
  }

  // Overwrite — requires confirmation
  const target = instances[choiceIndex];
  const confirm = (await ask(rl, `⚠️ 即将覆盖 "${target.name}" 的配置，确认？(y/N) `)).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('已取消');
    return null;
  }

  return { action: 'overwrite', index: choiceIndex, name: target.name };
}
```

- [ ] **Step 2: Update cmdInitFeishu to use instance selection**

In `src/utils/init-feishu.ts`, replace the existing "检查已有配置" block with:

```typescript
import { normalizeChannelInstances } from '../config.js';
import { selectInstance } from './init-common.js';

export async function cmdInitFeishu(): Promise<void> {
  const p = resolvePaths();

  if (!fs.existsSync(p.config)) {
    console.log(`❌ 配置文件不存在，请先运行 evolclaw init`);
    return;
  }

  const config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));

  // Normalize existing instances
  const existingInstances = normalizeChannelInstances(config.channels?.feishu, 'feishu')
    .filter(inst => {
      // Filter out placeholder configs
      return inst.appId && inst.appSecret &&
        !inst.appId.includes('your-') && !inst.appId.includes('placeholder') &&
        !inst.appSecret.includes('your-') && !inst.appSecret.includes('placeholder');
    });

  let targetName = 'feishu';
  let overwriteIndex = -1;

  if (existingInstances.length > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const choice = await selectInstance(rl, 'feishu', existingInstances);
      if (!choice) return;  // cancelled

      if (choice.action === 'overwrite') {
        targetName = choice.name;
        overwriteIndex = choice.index;
      } else {
        targetName = choice.name;
      }
    } finally {
      rl.close();
    }
  }

  // ... proceed with QR flow (unchanged) ...

  // Write config — update the correct instance
  if (!config.channels) config.channels = {};

  if (overwriteIndex >= 0 && Array.isArray(config.channels.feishu)) {
    // Overwrite existing instance in array
    config.channels.feishu[overwriteIndex] = {
      ...config.channels.feishu[overwriteIndex],
      appId: result.appId,
      appSecret: result.appSecret,
      enabled: true,
      owner: result.openId || undefined,
    };
  } else if (existingInstances.length > 0) {
    // Add new instance — upgrade to array if needed
    const newInst = {
      name: targetName,
      appId: result.appId,
      appSecret: result.appSecret,
      enabled: true,
      owner: result.openId || undefined,
    };

    if (Array.isArray(config.channels.feishu)) {
      config.channels.feishu.push(newInst);
    } else {
      // Upgrade single object to array
      const oldInst = { ...config.channels.feishu, name: config.channels.feishu.name || 'feishu' };
      config.channels.feishu = [oldInst, newInst];
    }
  } else {
    // First instance — use single object format (backward compat)
    config.channels.feishu = config.channels.feishu || {};
    config.channels.feishu.appId = result.appId;
    config.channels.feishu.appSecret = result.appSecret;
    config.channels.feishu.enabled = true;
    if (result.openId) config.channels.feishu.owner = result.openId;
    else delete config.channels.feishu.owner;
  }

  if (!config.channels.defaultChannel) config.channels.defaultChannel = 'feishu';
  fs.writeFileSync(p.config, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n✅ 飞书连接成功！`);
  console.log(`  实例: ${targetName}`);
  console.log(`  App ID: ${result.appId}`);
  // ...
}
```

- [ ] **Step 3: Update cmdInitWechat with same pattern**

Same approach: normalize existing instances, present selection if any exist, write to the correct slot.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Manual test init flow**

Run: `EVOLCLAW_HOME=/home/evolclaw node dist/cli.js init feishu`
Expected: If existing feishu config found, shows instance selection menu.

- [ ] **Step 6: Commit**

```bash
git add src/utils/init-common.ts src/utils/init-feishu.ts src/utils/init-wechat.ts
git commit -m "feat: init commands support multi-instance selection"
```

---

### Task 7: MessageBridge Debouncer Config Adaptation

**Files:**
- Modify: `src/core/message-bridge.ts:32-40` (getDebouncer)

- [ ] **Step 1: Update getDebouncer to handle instance names**

The current code accesses `config.channels[channelName]` directly. With multi-instance, `channelName` is an instance name. Use `resolveInstanceConfig` pattern or pass debounce config through another path.

Simplest fix: the debounce value is already available in `ChannelOptions.flushDelay` via the processor, but `getDebouncer` reads from raw config. Update to use `getOwner`-style lookup:

```typescript
private getDebouncer(channelName: string): StreamDebouncer {
  let d = this.debouncers.get(channelName);
  if (!d) {
    // Resolve per-instance debounce config
    let seconds = this.defaultDebounce;
    for (const type of ['feishu', 'wechat', 'aun'] as const) {
      const raw = (this.config.channels as any)?.[type];
      if (!raw) continue;
      if (Array.isArray(raw)) {
        const inst = raw.find((i: any) => (i.name || type) === channelName);
        if (inst?.debounce !== undefined) { seconds = inst.debounce; break; }
      } else if ((raw.name || type) === channelName) {
        if (raw.debounce !== undefined) { seconds = raw.debounce; break; }
      }
    }
    d = new StreamDebouncer(seconds);
    this.debouncers.set(channelName, d);
  }
  return d;
}
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/message-bridge.ts
git commit -m "feat: message bridge debouncer resolves config by instance name"
```

---

### Task 8: Build Verification and Final Test

**Files:** None new

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Run with single-instance config (backward compat)**

Run: `EVOLCLAW_HOME=/home/evolclaw npm run dev`
Expected: Starts normally, all channels connect, behaves identically to before.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: multi-instance channel support — complete"
```
