# QQBot Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add QQ Bot as a new messaging channel to EvolClaw, supporting C2C + group chat with text/image/file in both directions, using pure-qqbot SDK.

**Architecture:** Follows the existing ChannelPlugin pattern — a single new file `src/channels/qqbot.ts` containing `QQBotChannel` (transport) and `QQBotChannelPlugin` (factory). Type definitions added to `types.ts`, config validation to `config.ts`, plugin registration and message bridge wiring to `index.ts`. Uses `pure-qqbot` SDK for WebSocket connection, token management, and message send/receive. Markdown sending with automatic plaintext fallback.

**Tech Stack:** `pure-qqbot` v2.0.0 (official QQ Bot API v2 SDK), EvolClaw `media-cache.ts` utilities

**Spec:** `docs/superpowers/specs/2026-04-19-qqbot-channel-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/channels/qqbot.ts` | **New** — QQBotChannel class (connect, message handling, send with markdown fallback) + QQBotChannelPlugin (factory) |
| `src/types.ts` | Add `QQBotChannelConfig`, `QQBotChannelInstanceConfig`, extend `Config.channels` |
| `src/config.ts` | Add `'qqbot'` to `channelTypes`, add validation in `validateConfig` |
| `src/utils/format.ts` | **New** — Extract `markdownToPlainText()` from wechat.ts as shared utility |
| `src/channels/wechat.ts` | Remove local `markdownToPlainText`, import from `../utils/format.js` |
| `src/index.ts` | Import plugin, register, add message bridge wiring block |
| `package.json` | Add `pure-qqbot` dependency |
| `tests/unit/format.test.ts` | **New** — Tests for markdownToPlainText |
| `tests/unit/qqbot-channel.test.ts` | **New** — Unit tests for channel logic |

---

### Task 1: Extract markdownToPlainText to Shared Utility

**Files:**
- Create: `src/utils/format.ts`
- Create: `tests/unit/format.test.ts`
- Modify: `src/channels/wechat.ts:137-169` (remove local function, add import)

- [ ] **Step 1: Write failing tests for markdownToPlainText**

Create `tests/unit/format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('markdownToPlainText', () => {
  async function convert(text: string) {
    const { markdownToPlainText } = await import('../../src/utils/format.js');
    return markdownToPlainText(text);
  }

  it('should strip code fences', async () => {
    expect(await convert('```js\nconsole.log("hi")\n```')).toBe('console.log("hi")');
  });

  it('should strip bold and italic', async () => {
    expect(await convert('**bold** and *italic*')).toBe('bold and italic');
  });

  it('should strip headers', async () => {
    expect(await convert('## Title\ntext')).toBe('Title\ntext');
  });

  it('should strip inline code', async () => {
    expect(await convert('use `foo()` here')).toBe('use foo() here');
  });

  it('should keep link text, remove URL', async () => {
    expect(await convert('[click here](https://example.com)')).toBe('click here');
  });

  it('should remove images', async () => {
    expect(await convert('![alt](https://img.png)')).toBe('');
  });

  it('should strip list markers', async () => {
    expect(await convert('- item1\n- item2')).toBe('item1\nitem2');
  });

  it('should strip blockquotes', async () => {
    expect(await convert('> quoted text')).toBe('quoted text');
  });

  it('should handle empty string', async () => {
    expect(await convert('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/format.test.ts
```

Expected: FAIL — module `../../src/utils/format.js` not found.

- [ ] **Step 3: Create src/utils/format.ts**

```typescript
// ── Markdown → Plain Text ───────────────────────────────────────────────────

export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Tables: remove separator rows
  result = result.replace(/^\|[\s:|-]+\|$/gm, '');
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split('|').map(cell => cell.trim()).join('  ')
  );
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/\*(.+?)\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/_(.+?)_/g, '$1');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1');
  // Inline code
  result = result.replace(/`([^`]+)`/g, '$1');
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, '');
  // Blockquotes
  result = result.replace(/^>\s?/gm, '');
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, '');
  // List markers
  result = result.replace(/^(\s*)[-*+]\s/gm, '$1');
  result = result.replace(/^(\s*)\d+\.\s/gm, '$1');
  return result.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/evolclaw && npx vitest run tests/unit/format.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Update wechat.ts to import from shared utility**

In `src/channels/wechat.ts`, replace the local `markdownToPlainText` function (lines 135-169) with an import.

Add at the top of the file (after existing imports):
```typescript
import { markdownToPlainText } from '../utils/format.js';
```

Remove lines 135-169 (the `// ── Markdown → Plain Text` comment block and the entire `function markdownToPlainText(text: string)` function body).

- [ ] **Step 6: Verify build and existing tests**

```bash
cd /home/evolclaw && npm run build && npm test
```

Expected: Build succeeds, all existing tests pass (including any WeChat tests that use markdownToPlainText indirectly).

- [ ] **Step 7: Commit**

```bash
cd /home/evolclaw && git add src/utils/format.ts tests/unit/format.test.ts src/channels/wechat.ts && git commit -m "refactor: extract markdownToPlainText to shared src/utils/format.ts"
```

---

### Task 2: Install SDK and Add Type Definitions

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/types.ts:69` (add QQBotChannelConfig after DingtalkChannelInstanceConfig)
- Modify: `src/types.ts:105` (extend Config.channels)

- [ ] **Step 1: Install pure-qqbot**

```bash
cd /home/evolclaw && npm install pure-qqbot
```

Expected: package.json updated with `"pure-qqbot": "^2.x.x"` in dependencies.

- [ ] **Step 2: Add QQBotChannelConfig types to types.ts**

Add after line 69 (after `DingtalkChannelInstanceConfig`), before the `Config` interface:

```typescript
export interface QQBotChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  clientSecret: string;
  owner?: string;
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
}

export interface QQBotChannelInstanceConfig extends QQBotChannelConfig {
  name: string;
}
```

- [ ] **Step 3: Extend Config.channels with qqbot**

In the `Config` interface `channels` object (after the `dingtalk` line, currently line 105), add:

```typescript
    qqbot?: QQBotChannelConfig | QQBotChannelInstanceConfig[];
```

- [ ] **Step 4: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/evolclaw && git add src/types.ts package.json package-lock.json && git commit -m "feat(qqbot): add type definitions and install pure-qqbot SDK"
```

---

### Task 3: Config Validation

**Files:**
- Modify: `src/config.ts:237` (channelTypes array)
- Modify: `src/config.ts:394` (validateConfig function — add QQBot block after DingTalk block)
- Test: `tests/unit/qqbot-channel.test.ts` (new file, config tests)

- [ ] **Step 1: Write failing test for channelTypes**

Create `tests/unit/qqbot-channel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('QQBot Config', () => {
  describe('channelTypes', () => {
    it('should include qqbot', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('qqbot');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: FAIL — `channelTypes` does not contain `'qqbot'`.

- [ ] **Step 3: Add 'qqbot' to channelTypes**

In `src/config.ts` line 237, change:

```typescript
export const channelTypes = ['feishu', 'wechat', 'aun', 'dingtalk'] as const;
```

to:

```typescript
export const channelTypes = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot'] as const;
```

- [ ] **Step 4: Add QQBot validation to validateConfig**

In `src/config.ts`, add after the DingTalk validation block (after line 394, before the closing `}` of `validateConfig`):

```typescript
  // QQBot 配置可选，但如果配置了就需要 appId + clientSecret
  const qqbotInstances = normalizeChannelInstances(config.channels?.qqbot, 'qqbot');
  for (const inst of qqbotInstances) {
    if ((inst as any).enabled === false) continue;
    const label = qqbotInstances.length > 1 ? ` [${inst.name}]` : '';
    const hasAppId = !!(inst as any).appId && !(inst as any).appId.includes('your-');
    const hasSecret = !!(inst as any).clientSecret && !(inst as any).clientSecret.includes('your-');
    if (hasAppId !== hasSecret) {
      logger.warn(`⚠ QQBot${label} appId/clientSecret incomplete (QQBot channel will be disabled)`);
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify full build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/evolclaw && git add src/config.ts tests/unit/qqbot-channel.test.ts && git commit -m "feat(qqbot): add config validation and channelTypes entry"
```

---

### Task 4: QQBotChannel Core — Constructor, Connect, Dedup, Text Handling

**Files:**
- Create: `src/channels/qqbot.ts`
- Test: `tests/unit/qqbot-channel.test.ts` (append)

- [ ] **Step 1: Write failing tests for dedup and chatId resolution**

Append to `tests/unit/qqbot-channel.test.ts`:

```typescript
describe('QQBotChannel', () => {
  async function createChannel(opts?: any) {
    const { QQBotChannel } = await import('../../src/channels/qqbot.js');
    return new QQBotChannel({ appId: 'test', clientSecret: 'test', ...opts });
  }

  describe('message dedup', () => {
    it('should reject duplicate messageId', async () => {
      const channel = await createChannel();
      expect(channel.isDuplicate('msg-001')).toBe(false);
      expect(channel.isDuplicate('msg-001')).toBe(true);
      expect(channel.isDuplicate('msg-002')).toBe(false);
    });
  });

  describe('chatId resolution', () => {
    it('should use groupOpenid for group chat', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId({
        type: 'group', senderId: 'user1', groupOpenid: 'group1',
        content: 'hi', messageId: 'm1', timestamp: '0',
      })).toBe('group1');
    });

    it('should use senderId for C2C', async () => {
      const channel = await createChannel();
      expect(channel.resolveChatId({
        type: 'c2c', senderId: 'user1',
        content: 'hi', messageId: 'm1', timestamp: '0',
      })).toBe('user1');
    });
  });

  describe('event type filter', () => {
    it('should accept c2c events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('c2c')).toBe(true);
    });

    it('should accept group events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('group')).toBe(true);
    });

    it('should reject guild events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('guild')).toBe(false);
    });

    it('should reject dm events', async () => {
      const channel = await createChannel();
      expect(channel.shouldProcess('dm')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: FAIL — `QQBotChannel` module not found.

- [ ] **Step 3: Create src/channels/qqbot.ts with core class**

```typescript
import { logger } from '../utils/logger.js';
import { markdownToPlainText } from '../utils/format.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QQBotConfig {
  appId: string;
  clientSecret: string;
}

export interface QQBotMessageEvent {
  channelId: string;
  content: string;
  chatType: 'private' | 'group';
  peerId: string;
  peerName?: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

type QQBotMessageHandler = (event: QQBotMessageEvent) => Promise<void>;

// ── Minimal MessageEvent shape (matches pure-qqbot) ─────────────────────────

interface SDKMessageEvent {
  type: 'c2c' | 'group' | 'guild' | 'dm';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

// ── QQBotChannel ────────────────────────────────────────────────────────────

export class QQBotChannel {
  private config: QQBotConfig;
  private client: any = null;
  private connected = false;
  private messageHandler: QQBotMessageHandler | null = null;
  private seenMessages = new Map<string, number>();
  private chatTypeCache = new Map<string, 'private' | 'group'>();
  private msgIdCache = new Map<string, string>();
  private groupOpenidCache = new Map<string, string>();
  private markdownFailed = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  projectPathProvider: ((channelId: string) => Promise<string>) | null = null;

  constructor(config: QQBotConfig) {
    this.config = config;
  }

  // ── Public helpers (testable) ──────────────────────────────────────────────

  isDuplicate(msgId: string): boolean {
    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, Date.now());
    return false;
  }

  resolveChatId(event: SDKMessageEvent): string {
    return event.type === 'group' && event.groupOpenid ? event.groupOpenid : event.senderId;
  }

  shouldProcess(type: string): boolean {
    return type === 'c2c' || type === 'group';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { appId, clientSecret } = this.config;
    if (!appId || !clientSecret || appId.includes('your-') || clientSecret.includes('your-')) {
      throw new Error('QQBot appId/clientSecret not configured');
    }

    const { QQBotClient } = await import('pure-qqbot');

    this.client = new QQBotClient({
      appId,
      clientSecret,
      typingKeepAlive: true,
      logger: {
        info: (msg: string) => logger.debug(`[QQBot/SDK] ${msg}`),
        error: (msg: string) => logger.error(`[QQBot/SDK] ${msg}`),
        debug: (msg: string) => logger.debug(`[QQBot/SDK] ${msg}`),
      },
    });

    this.client.onMessage(async (event: SDKMessageEvent) => {
      await this.handleIncoming(event);
    });

    await this.client.start();
    this.client.startBackgroundRefresh();
    this.connected = true;

    // Hourly cleanup of old dedup entries
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, ts] of this.seenMessages) {
        if (ts < cutoff) this.seenMessages.delete(id);
      }
    }, 60 * 60 * 1000);

    logger.info('[QQBot] Connected via WebSocket Gateway v2');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.client) {
      try {
        this.client.stopBackgroundRefresh();
        this.client.stop();
      } catch { /* ignore */ }
      this.client = null;
    }
    logger.info('[QQBot] Disconnected');
  }

  onMessage(handler: QQBotMessageHandler): void {
    this.messageHandler = handler;
  }

  // ── Inbound message handling ───────────────────────────────────────────────

  private async handleIncoming(event: SDKMessageEvent): Promise<void> {
    try {
      // Filter: only c2c and group
      if (!this.shouldProcess(event.type)) return;

      // Dedup
      if (event.messageId && this.isDuplicate(event.messageId)) {
        logger.debug(`[QQBot] Duplicate message skipped: ${event.messageId}`);
        return;
      }

      const chatId = this.resolveChatId(event);
      const chatType = event.type === 'group' ? 'group' as const : 'private' as const;

      // Cache for outbound routing
      this.chatTypeCache.set(chatId, chatType);
      this.msgIdCache.set(chatId, event.messageId);
      if (event.groupOpenid) this.groupOpenidCache.set(chatId, event.groupOpenid);

      if (!this.messageHandler) return;

      // Check for attachments (images/files)
      const attachments = event.attachments || [];
      const imageAttachments = attachments.filter(a => a.content_type?.startsWith('image/'));
      const fileAttachments = attachments.filter(a => !a.content_type?.startsWith('image/'));

      if (imageAttachments.length > 0) {
        await this.handleImageAttachments(imageAttachments, event, chatId, chatType);
      } else if (fileAttachments.length > 0) {
        await this.handleFileAttachments(fileAttachments, event, chatId, chatType);
      } else {
        // Pure text
        const text = (event.content || '').trim();
        if (!text) return;
        await this.messageHandler({
          channelId: chatId, content: text, chatType,
          peerId: event.senderId || '', peerName: event.senderName,
          messageId: event.messageId,
        });
      }
    } catch (error) {
      logger.error('[QQBot] Failed to process incoming message:', error);
    }
  }

  // ── Inbound media handling ─────────────────────────────────────────────────

  private async handleImageAttachments(
    attachments: Array<{ content_type: string; url: string; filename?: string }>,
    event: SDKMessageEvent, chatId: string, chatType: 'private' | 'group',
  ): Promise<void> {
    const images: Array<{ data: string; mimeType: string }> = [];

    for (const att of attachments) {
      if (!att.url) continue;
      try {
        const { safeFetch, validateImage } = await import('../utils/media-cache.js');
        const buffer = await safeFetch(att.url, { skipSsrfCheck: true });
        const result = await validateImage(buffer);
        if (result.mime) {
          images.push({ data: buffer.toString('base64'), mimeType: result.mime });
        } else {
          logger.warn(`[QQBot] Image validation failed: ${'reason' in result ? result.reason : 'unknown'}`);
        }
      } catch (error) {
        logger.error('[QQBot] Failed to download image:', error);
      }
    }

    const text = (event.content || '').trim();
    const prompt = text || (images.length > 0 ? '用户发送了一张图片，请分析这张图片的内容。' : '[空消息]');

    await this.messageHandler!({
      channelId: chatId, content: prompt, chatType,
      peerId: event.senderId || '', peerName: event.senderName,
      messageId: event.messageId,
      images: images.length > 0 ? images : undefined,
    });
  }

  private async handleFileAttachments(
    attachments: Array<{ content_type: string; url: string; filename?: string }>,
    event: SDKMessageEvent, chatId: string, chatType: 'private' | 'group',
  ): Promise<void> {
    for (const att of attachments) {
      if (!att.url) continue;
      const fileName = att.filename || 'unknown';
      try {
        const { safeFetch, saveToUploads, sanitizeFileName } = await import('../utils/media-cache.js');
        const projectPath = this.projectPathProvider
          ? await this.projectPathProvider(chatId)
          : process.cwd();
        const buffer = await safeFetch(att.url, { skipSsrfCheck: true });
        const { filePath } = saveToUploads(buffer, sanitizeFileName(fileName), projectPath);

        await this.messageHandler!({
          channelId: chatId,
          content: `用户发送了文件：${fileName}\n文件已保存到：${filePath}\n请使用 Read 工具读取并分析文件内容。`,
          chatType, peerId: event.senderId || '', peerName: event.senderName,
          messageId: event.messageId,
        });
      } catch (error) {
        logger.error('[QQBot] Failed to download file:', error);
        await this.messageHandler!({
          channelId: chatId, content: `[文件下载失败] ${fileName}`,
          chatType, peerId: event.senderId || '', peerName: event.senderName,
          messageId: event.messageId,
        });
      }
    }
  }

  // ── Outbound: text (markdown with fallback) ────────────────────────────────

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!this.client) return;

    const chatType = this.chatTypeCache.get(chatId);
    const msgId = this.msgIdCache.get(chatId);

    // Try Markdown first, fallback to plain text
    if (!this.markdownFailed) {
      try {
        if (chatType === 'group') {
          const groupOpenid = this.groupOpenidCache.get(chatId) || chatId;
          // sendGroupMessage with markdown content — pure-qqbot handles msg_type
          await this.client.sendGroupMessage(groupOpenid, content, msgId);
        } else {
          await this.client.sendPrivateMarkdown(chatId, content, msgId);
        }
        return; // success
      } catch (error: any) {
        const errMsg = String(error?.message || error);
        // Check if this is a markdown permission error
        if (errMsg.includes('not support') || errMsg.includes('permission') ||
            errMsg.includes('markdown') || error?.code === 304003 || error?.code === 304004) {
          logger.warn('[QQBot] Markdown not supported, falling back to plain text globally');
          this.markdownFailed = true;
          // Fall through to plain text below
        } else {
          // Other error — log and return, don't fallback
          logger.error(`[QQBot] sendMessage failed for ${chatId}:`, errMsg);
          return;
        }
      }
    }

    // Plain text fallback
    try {
      const plainText = markdownToPlainText(content);
      if (chatType === 'group') {
        const groupOpenid = this.groupOpenidCache.get(chatId) || chatId;
        await this.client.sendGroupMessage(groupOpenid, plainText, msgId);
      } else {
        await this.client.sendPrivateMessage(chatId, plainText, msgId);
      }
    } catch (error: any) {
      logger.error(`[QQBot] sendMessage (plaintext) failed for ${chatId}:`, error?.message || error);
    }
  }

  // ── Outbound: image ────────────────────────────────────────────────────────

  async sendImage(chatId: string, png: Buffer): Promise<void> {
    if (!this.client) return;

    try {
      // Write buffer to temp file for SDK upload
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const tmpPath = path.join(os.tmpdir(), `evolclaw-qqbot-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, png);

      const chatType = this.chatTypeCache.get(chatId);
      const msgId = this.msgIdCache.get(chatId);

      if (chatType === 'group') {
        const groupOpenid = this.groupOpenidCache.get(chatId) || chatId;
        await this.client.sendGroupImage(groupOpenid, `file://${tmpPath}`, msgId);
      } else {
        await this.client.sendPrivateImage(chatId, `file://${tmpPath}`, msgId);
      }

      // Cleanup temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    } catch (error: any) {
      logger.error(`[QQBot] sendImage failed for ${chatId}:`, error?.message || error);
    }
  }

  // ── Outbound: file ─────────────────────────────────────────────────────────

  async sendFile(chatId: string, filePath: string): Promise<void> {
    if (!this.client) return;

    try {
      // Detect image files → route to sendImage
      const fs = await import('fs');
      const header = Buffer.alloc(12);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, header, 0, 12, 0);
      fs.closeSync(fd);

      const { fileTypeFromBuffer } = await import('file-type');
      const ftype = await fileTypeFromBuffer(header);
      if (ftype && ftype.mime.startsWith('image/')) {
        const buf = fs.readFileSync(filePath);
        return this.sendImage(chatId, buf);
      }

      const chatType = this.chatTypeCache.get(chatId);
      const msgId = this.msgIdCache.get(chatId);

      if (chatType === 'group') {
        const groupOpenid = this.groupOpenidCache.get(chatId) || chatId;
        await this.client.sendGroupFile(groupOpenid, `file://${filePath}`, msgId);
      } else {
        await this.client.sendPrivateFile(chatId, `file://${filePath}`, msgId);
      }
    } catch (error: any) {
      logger.error(`[QQBot] sendFile failed for ${chatId}:`, error?.message || error);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/channels/qqbot.ts tests/unit/qqbot-channel.test.ts && git commit -m "feat(qqbot): QQBotChannel core — connect, dedup, text/image/file handling"
```

---

### Task 5: QQBotChannelPlugin Factory

**Files:**
- Modify: `src/channels/qqbot.ts` (append plugin class)
- Test: `tests/unit/qqbot-channel.test.ts` (append plugin tests)

- [ ] **Step 1: Write failing tests for the plugin**

Append to `tests/unit/qqbot-channel.test.ts`:

```typescript
describe('QQBotChannelPlugin', () => {
  describe('isEnabled', () => {
    it('should return false when no qqbot config', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      expect(plugin.isEnabled({ projects: { defaultPath: '/tmp', autoCreate: false } } as any)).toBe(false);
    });

    it('should return true with valid credentials', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'abc', clientSecret: 'xyz' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(true);
    });

    it('should return false when explicitly disabled', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'abc', clientSecret: 'xyz', enabled: false } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(false);
    });

    it('should return true with array form if any instance valid', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: [
          { name: 'qq1', appId: '', clientSecret: '' },
          { name: 'qq2', appId: 'abc', clientSecret: 'xyz' },
        ] },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(true);
    });

    it('should return false with placeholder credentials', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      const config = {
        channels: { qqbot: { appId: 'your-app-id', clientSecret: 'your-secret' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      };
      expect(plugin.isEnabled(config as any)).toBe(false);
    });
  });

  describe('name', () => {
    it('should be qqbot', async () => {
      const { QQBotChannelPlugin } = await import('../../src/channels/qqbot.js');
      const plugin = new QQBotChannelPlugin();
      expect(plugin.name).toBe('qqbot');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: FAIL — `QQBotChannelPlugin` not exported.

- [ ] **Step 3: Add QQBotChannelPlugin to qqbot.ts**

Add these imports at the top of `src/channels/qqbot.ts` (after existing imports):

```typescript
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, QQBotChannelConfig } from '../types.js';
import { normalizeChannelInstances } from '../config.js';
```

Append to the end of `src/channels/qqbot.ts`:

```typescript
// ── Plugin ─────────────────────────────────────────────────────────────────────

function isValidCredential(value: string | undefined): boolean {
  return !!value && !value.includes('your-') && !value.includes('placeholder');
}

export class QQBotChannelPlugin implements ChannelPlugin {
  readonly name = 'qqbot';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.qqbot;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && isValidCredential(inst.appId) && isValidCredential(inst.clientSecret));
    }
    if (raw.enabled === false) return false;
    return isValidCredential(raw.appId) && isValidCredential(raw.clientSecret);
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const instances = normalizeChannelInstances<QQBotChannelConfig>(
      config.channels?.qqbot,
      'qqbot',
    );

    const result: ChannelInstance[] = [];
    for (const inst of instances) {
      if (inst.enabled === false) continue;
      if (!isValidCredential(inst.appId) || !isValidCredential(inst.clientSecret)) continue;

      const channel = new QQBotChannel({
        appId: inst.appId,
        clientSecret: inst.clientSecret,
      });

      const adapter = {
        channelName: inst.name || 'qqbot',
        sendText: (id: string, text: string) => channel.sendMessage(id, text),
        sendFile: (id: string, filePath: string) => channel.sendFile(id, filePath),
        sendImage: (id: string, png: Buffer) => channel.sendImage(id, png),
      };

      const policy = {
        canSwitchProject: (_chatType: string, identity: string) => identity === 'owner',
        canListProjects: (_chatType: string, identity: string) => identity === 'owner',
        canCreateSession: () => true,
        canDeleteSession: () => true,
        canImportCliSession: (_chatType: string, identity: string) => identity === 'owner',
        messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
        showMiddleResult: (chatType: string, identity: string) => {
          const mode = inst.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        showIdleMonitor: (chatType: string, identity: string) => {
          const mode = inst.showActivities ?? config.showActivities ?? 'all';
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        accumulateErrors: () => true,
      };

      const options = {
        fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
        supportsImages: true,
        flushDelay: inst.flushDelay,
      };

      result.push({
        channelType: 'qqbot',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: () =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
      });
    }

    return result;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const instances = await this.createChannels(config);
    if (instances.length === 0) {
      throw new Error('QQBot config missing or invalid');
    }
    return instances[0];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/channels/qqbot.ts tests/unit/qqbot-channel.test.ts && git commit -m "feat(qqbot): add QQBotChannelPlugin factory"
```

---

### Task 6: Register Plugin and Wire Message Bridge

**Files:**
- Modify: `src/index.ts:12` (add import)
- Modify: `src/index.ts:147` (add register)
- Modify: `src/index.ts:354` (add message bridge block)

- [ ] **Step 1: Add import**

In `src/index.ts`, add after the DingTalk import (line 12):

```typescript
import { QQBotChannelPlugin } from './channels/qqbot.js';
```

- [ ] **Step 2: Add plugin registration**

In `src/index.ts`, add after `channelLoader.register(new DingtalkChannelPlugin());` (line 147):

```typescript
  channelLoader.register(new QQBotChannelPlugin());
```

- [ ] **Step 3: Add message bridge wiring**

In `src/index.ts`, add after the `if (channelType === 'dingtalk')` block (after line 354, before `}`):

```typescript
    if (channelType === 'qqbot') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (event: any) => {
          handler({
            channel: channelType,
            channelId: event.channelId,
            content: event.content,
            images: event.images,
            chatType: event.chatType || 'private',
            peerId: event.peerId || '',
            peerName: event.peerName,
            messageId: event.messageId,
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter,
        channelType
      );
    }
```

- [ ] **Step 4: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/evolclaw && npm test
```

Expected: All existing tests still pass, all new QQBot and format tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/index.ts && git commit -m "feat(qqbot): register plugin and wire message bridge in index.ts"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Full build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 2: Run all tests**

```bash
cd /home/evolclaw && npm test
```

Expected: All tests pass (existing + new QQBot + format tests).

- [ ] **Step 3: Verify QQBot test coverage**

```bash
cd /home/evolclaw && npx vitest run tests/unit/qqbot-channel.test.ts tests/unit/format.test.ts --reporter=verbose
```

Expected: All tests pass:
- format: markdownToPlainText conversions
- Config: `channelTypes` includes `'qqbot'`
- Message dedup
- chatId resolution (group vs C2C)
- Event type filter (c2c/group accepted, guild/dm rejected)
- Plugin: `isEnabled` with various config shapes
- Plugin: `name` is `'qqbot'`

- [ ] **Step 4: Commit final state if needed**

Only if there are uncommitted fixes from test failures:

```bash
cd /home/evolclaw && git add -A && git commit -m "fix(qqbot): address test feedback"
```
