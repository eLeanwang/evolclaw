# DingTalk Channel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DingTalk as a new messaging channel to EvolClaw, supporting single/group chat with text, image, and file in both directions.

**Architecture:** Follows the existing ChannelPlugin pattern — a single new file `src/channels/dingtalk.ts` containing `DingtalkChannel` (transport) and `DingtalkChannelPlugin` (factory). Type definitions added to `types.ts`, config validation to `config.ts`, plugin registration and message bridge wiring to `index.ts`. Uses `dingtalk-stream` SDK for inbound WebSocket, `sessionWebhook` for text replies, and DingTalk Open API for image/file sends.

**Tech Stack:** `dingtalk-stream` v2.1.6+ (official SDK), `axios` (bundled with SDK), EvolClaw `media-cache.ts` utilities

**Spec:** `docs/superpowers/specs/2026-04-18-dingtalk-channel-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/channels/dingtalk.ts` | **New** — DingtalkChannel class (connect, message handling, send) + DingtalkChannelPlugin (factory) |
| `src/types.ts` | Add `DingtalkChannelConfig`, `DingtalkChannelInstanceConfig`, extend `Config.channels` |
| `src/config.ts` | Add `'dingtalk'` to `channelTypes`, add validation in `validateConfig` |
| `src/utils/media-cache.ts` | Add DingTalk domains to SSRF whitelist |
| `src/index.ts` | Import plugin, register, add message bridge wiring block |
| `package.json` | Add `dingtalk-stream` dependency |
| `tests/unit/dingtalk-channel.test.ts` | **New** — Unit tests for channel logic |

---

### Task 1: Install SDK and Add Type Definitions

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/types.ts:0-52` (add DingtalkChannelConfig after AunChannelInstanceConfig)
- Modify: `src/types.ts:86-92` (extend Config.channels)

- [ ] **Step 1: Install dingtalk-stream**

```bash
cd /home/evolclaw && npm install dingtalk-stream
```

Expected: package.json updated with `"dingtalk-stream": "^2.x.x"` in dependencies.

- [ ] **Step 2: Add DingtalkChannelConfig types to types.ts**

Add after line 51 (after `AunChannelInstanceConfig`), before the `Config` interface:

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
  requireMention?: boolean;       // default true — group chats require @mention
  freeResponseChats?: string[];   // conversationId whitelist (skip @mention gate)
}

export interface DingtalkChannelInstanceConfig extends DingtalkChannelConfig {
  name: string;
}
```

- [ ] **Step 3: Extend Config.channels with dingtalk**

In the `Config` interface, add `dingtalk` to the `channels` object (after the `aun` line):

```typescript
    dingtalk?: DingtalkChannelConfig | DingtalkChannelInstanceConfig[];
```

- [ ] **Step 4: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/evolclaw && git add src/types.ts package.json package-lock.json && git commit -m "feat(dingtalk): add type definitions and install dingtalk-stream SDK"
```

---

### Task 2: Config Validation and SSRF Whitelist

**Files:**
- Modify: `src/config.ts:237` (channelTypes array)
- Modify: `src/config.ts:348-383` (validateConfig function)
- Modify: `src/utils/media-cache.ts:26-30` (ALLOWED_CDN_HOSTS)
- Test: `tests/unit/dingtalk-channel.test.ts` (new file, config tests)

- [ ] **Step 1: Write failing tests for config validation**

Create `tests/unit/dingtalk-channel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('DingTalk Config', () => {
  describe('channelTypes', () => {
    it('should include dingtalk', async () => {
      const { channelTypes } = await import('../../src/config.js');
      expect(channelTypes).toContain('dingtalk');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: FAIL — `channelTypes` does not contain `'dingtalk'`.

- [ ] **Step 3: Add 'dingtalk' to channelTypes**

In `src/config.ts`, change line 237:

```typescript
// Before:
export const channelTypes = ['feishu', 'wechat', 'aun'] as const;

// After:
export const channelTypes = ['feishu', 'wechat', 'aun', 'dingtalk'] as const;
```

- [ ] **Step 4: Add DingTalk validation to validateConfig**

In `src/config.ts`, add after the WeChat validation block (after the `}` closing the wechat `for` loop, before the closing `}` of `validateConfig`):

```typescript
  // DingTalk 配置可选，但如果配置了就需要 clientId + clientSecret
  const dingtalkInstances = normalizeChannelInstances(config.channels?.dingtalk, 'dingtalk');
  for (const inst of dingtalkInstances) {
    if ((inst as any).enabled === false) continue;
    const label = dingtalkInstances.length > 1 ? ` [${inst.name}]` : '';
    const hasClientId = !!(inst as any).clientId && !(inst as any).clientId.includes('your-');
    const hasClientSecret = !!(inst as any).clientSecret && !(inst as any).clientSecret.includes('your-');
    if (hasClientId !== hasClientSecret) {
      logger.warn(`⚠ DingTalk${label} clientId/clientSecret incomplete (DingTalk channel will be disabled)`);
    }
  }
```

- [ ] **Step 5: Add DingTalk domains to SSRF whitelist**

In `src/utils/media-cache.ts`, add to `ALLOWED_CDN_HOSTS` (line 26-30):

```typescript
const ALLOWED_CDN_HOSTS = new Set([
  'novac2c.cdn.weixin.qq.com',
  'open.feishu.cn',
  'internal-api-lark-file.feishu.cn',
  'oapi.dingtalk.com',
  'api.dingtalk.com',
]);
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: PASS

- [ ] **Step 7: Verify full build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
cd /home/evolclaw && git add src/config.ts src/utils/media-cache.ts tests/unit/dingtalk-channel.test.ts && git commit -m "feat(dingtalk): add config validation and SSRF whitelist entries"
```

---

### Task 3: DingtalkChannel Core — Constructor, Connect, Disconnect, Dedup

**Files:**
- Create: `src/channels/dingtalk.ts`
- Test: `tests/unit/dingtalk-channel.test.ts` (append)

- [ ] **Step 1: Write failing tests for dedup and webhook validation**

Append to `tests/unit/dingtalk-channel.test.ts`:

```typescript
import { DingtalkChannel } from '../../src/channels/dingtalk.js';

describe('DingtalkChannel', () => {
  describe('webhook URL validation', () => {
    it('should accept valid DingTalk webhook URLs', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      // Access the internal validation method
      expect(channel.isValidWebhook('https://oapi.dingtalk.com/robot/sendBySession?session=abc')).toBe(true);
      expect(channel.isValidWebhook('https://api.dingtalk.com/robot/sendBySession?session=abc')).toBe(true);
    });

    it('should reject non-DingTalk URLs', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.isValidWebhook('https://evil.com/robot/send')).toBe(false);
      expect(channel.isValidWebhook('http://oapi.dingtalk.com/robot/send')).toBe(false);
      expect(channel.isValidWebhook('')).toBe(false);
    });
  });

  describe('message dedup', () => {
    it('should reject duplicate msgId', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.isDuplicate('msg-001')).toBe(false);
      expect(channel.isDuplicate('msg-001')).toBe(true);
      expect(channel.isDuplicate('msg-002')).toBe(false);
    });
  });

  describe('chatId resolution', () => {
    it('should use conversationId for group chat', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.resolveChatId('2', 'cid123', 'sender456')).toBe('cid123');
    });

    it('should use senderId for DM', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.resolveChatId('1', 'cid123', 'sender456')).toBe('sender456');
    });
  });

  describe('group gate', () => {
    it('should pass when requireMention is false', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test', requireMention: false });
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(true);
    });

    it('should pass when in freeResponseChats', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test', freeResponseChats: ['cid1'] });
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(true);
    });

    it('should pass when isInAtList is true', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.shouldProcessGroupMessage('cid1', true)).toBe(true);
    });

    it('should reject when not mentioned and not whitelisted', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.shouldProcessGroupMessage('cid1', false)).toBe(false);
    });
  });

  describe('text extraction', () => {
    it('should extract text from string format', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.extractText({ text: { content: 'hello' } })).toBe('hello');
    });

    it('should extract text from plain string format', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.extractText({ text: 'hello' })).toBe('hello');
    });

    it('should return empty string for missing text', () => {
      const channel = new DingtalkChannel({ clientId: 'test', clientSecret: 'test' });
      expect(channel.extractText({})).toBe('');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: FAIL — `DingtalkChannel` module not found.

- [ ] **Step 3: Create src/channels/dingtalk.ts with core class**

```typescript
import { logger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DingtalkConfig {
  clientId: string;
  clientSecret: string;
  requireMention?: boolean;
  freeResponseChats?: string[];
}

export interface DingtalkMessageEvent {
  channelId: string;
  content: string;
  chatType: 'private' | 'group';
  peerId: string;
  peerName?: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

type DingtalkMessageHandler = (event: DingtalkMessageEvent) => Promise<void>;

// ── Webhook SSRF validation ────────────────────────────────────────────────────

const WEBHOOK_RE = /^https:\/\/(api|oapi)\.dingtalk\.com\//;

// ── DingtalkChannel ────────────────────────────────────────────────────────────

export class DingtalkChannel {
  private config: DingtalkConfig;
  private client: any = null;
  private connected = false;
  private messageHandler: DingtalkMessageHandler | null = null;
  private webhookCache = new Map<string, string>();
  private conversationIdCache = new Map<string, string>();
  private senderStaffIdCache = new Map<string, string>();
  private seenMessages = new Map<string, number>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  projectPathProvider: ((channelId: string) => Promise<string>) | null = null;

  constructor(config: DingtalkConfig) {
    this.config = config;
  }

  // ── Public helpers (testable) ──────────────────────────────────────────────

  isValidWebhook(url: string): boolean {
    if (!url) return false;
    return WEBHOOK_RE.test(url);
  }

  isDuplicate(msgId: string): boolean {
    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, Date.now());
    return false;
  }

  resolveChatId(conversationType: string, conversationId: string, senderId: string): string {
    return conversationType === '2' ? conversationId : senderId;
  }

  shouldProcessGroupMessage(conversationId: string, isInAtList: boolean): boolean {
    if (this.config.requireMention === false) return true;
    if (this.config.freeResponseChats?.includes(conversationId)) return true;
    return isInAtList;
  }

  extractText(content: any): string {
    if (!content) return '';
    const text = content.text;
    if (typeof text === 'string') return text.trim();
    if (text && typeof text === 'object' && typeof text.content === 'string') return text.content.trim();
    return '';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret || clientId.includes('your-') || clientSecret.includes('your-')) {
      throw new Error('DingTalk clientId/clientSecret not configured');
    }

    const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream');
    this.client = new DWClient({ clientId, clientSecret });

    this.client.registerCallbackListener(TOPIC_ROBOT, async (msg: any) => {
      await this.handleIncoming(msg);
    });

    await this.client.connect();
    this.connected = true;

    // Hourly cleanup of old dedup entries
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, ts] of this.seenMessages) {
        if (ts < cutoff) this.seenMessages.delete(id);
      }
    }, 60 * 60 * 1000);

    logger.info('[DingTalk] Connected via Stream Mode');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.client) {
      try { this.client.disconnect(); } catch { /* ignore */ }
      this.client = null;
    }
    logger.info('[DingTalk] Disconnected');
  }

  onMessage(handler: DingtalkMessageHandler): void {
    this.messageHandler = handler;
  }

  // ── Inbound message handling ───────────────────────────────────────────────

  private async handleIncoming(msg: any): Promise<void> {
    try {
      const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      const msgId = data.msgId;
      const conversationType = data.conversationType;
      const conversationId = data.conversationId;
      const senderId = data.senderStaffId || data.senderId;
      const senderNick = data.senderNick;
      const sessionWebhook = data.sessionWebhook;
      const msgtype = data.msgtype;

      // Dedup
      if (msgId && this.isDuplicate(msgId)) {
        logger.debug(`[DingTalk] Duplicate message skipped: ${msgId}`);
        return;
      }

      const chatId = this.resolveChatId(conversationType, conversationId, senderId);
      const chatType = conversationType === '2' ? 'group' : 'private';

      // Cache sender info for Open API sends
      if (senderId) this.senderStaffIdCache.set(chatId, senderId);
      if (conversationId) this.conversationIdCache.set(chatId, conversationId);

      // Group gate
      if (conversationType === '2') {
        const isInAtList = !!(data.isInAtList || (data.atUsers && data.atUsers.length > 0));
        if (!this.shouldProcessGroupMessage(conversationId, isInAtList)) {
          logger.debug(`[DingTalk] Group message ignored (not mentioned): ${msgId}`);
          return;
        }
      }

      // Webhook cache (SSRF validated)
      if (sessionWebhook && this.isValidWebhook(sessionWebhook)) {
        this.webhookCache.set(chatId, sessionWebhook);
      }

      // ACK to prevent 60s retry
      if (this.client && msg.headers?.messageId) {
        try {
          this.client.socketCallBackResponse(msg.headers.messageId, { response: JSON.stringify({ status: 'OK' }) });
        } catch (e) {
          logger.warn('[DingTalk] ACK failed:', e);
        }
      }

      // Dispatch by msgtype
      if (!this.messageHandler) return;

      if (msgtype === 'text' || !msgtype) {
        const text = this.extractText(data);
        if (!text) return;
        await this.messageHandler({
          channelId: chatId, content: text, chatType,
          peerId: senderId || '', peerName: senderNick, messageId: msgId,
        });
      } else if (msgtype === 'picture' || msgtype === 'image') {
        await this.handleImageMessage(data, chatId, chatType, senderId, senderNick, msgId);
      } else if (msgtype === 'file') {
        await this.handleFileMessage(data, chatId, chatType, senderId, senderNick, msgId);
      } else if (msgtype === 'richText') {
        await this.handleRichTextMessage(data, chatId, chatType, senderId, senderNick, msgId);
      } else {
        await this.messageHandler({
          channelId: chatId,
          content: `[不支持的消息类型: ${msgtype}]`,
          chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
        });
      }
    } catch (error) {
      logger.error('[DingTalk] Failed to process incoming message:', error);
    }
  }

  // ── Inbound media handling ─────────────────────────────────────────────────

  private async handleImageMessage(data: any, chatId: string, chatType: 'private' | 'group', senderId: string, senderNick: string, msgId: string): Promise<void> {
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
    const downloadUrl = content?.downloadUrl;
    if (!downloadUrl) {
      logger.warn('[DingTalk] Image message without downloadUrl');
      await this.messageHandler!({
        channelId: chatId, content: '[图片下载失败：缺少下载链接]',
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
      return;
    }

    try {
      const { safeFetch } = await import('../utils/media-cache.js');
      const { validateImage } = await import('../utils/media-cache.js');
      const buffer = await safeFetch(downloadUrl, { skipSsrfCheck: true });
      const result = await validateImage(buffer);

      if ('mime' in result && result.mime) {
        const base64Data = buffer.toString('base64');
        await this.messageHandler!({
          channelId: chatId,
          content: '用户发送了一张图片，请分析这张图片的内容。',
          chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
          images: [{ data: base64Data, mimeType: result.mime }],
        });
      } else {
        logger.warn(`[DingTalk] Image validation failed: ${'reason' in result ? result.reason : 'unknown'}`);
        await this.messageHandler!({
          channelId: chatId, content: '[图片验证失败]',
          chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
        });
      }
    } catch (error) {
      logger.error('[DingTalk] Failed to download image:', error);
      await this.messageHandler!({
        channelId: chatId, content: '[图片下载失败]',
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
    }
  }

  private async handleFileMessage(data: any, chatId: string, chatType: 'private' | 'group', senderId: string, senderNick: string, msgId: string): Promise<void> {
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
    const downloadUrl = content?.downloadUrl;
    const fileName = content?.fileName || 'unknown';

    if (!downloadUrl) {
      logger.warn('[DingTalk] File message without downloadUrl');
      await this.messageHandler!({
        channelId: chatId, content: `[文件下载失败：缺少下载链接] ${fileName}`,
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
      return;
    }

    try {
      const { safeFetch, saveToUploads, sanitizeFileName } = await import('../utils/media-cache.js');
      const projectPath = this.projectPathProvider
        ? await this.projectPathProvider(chatId)
        : process.cwd();
      const buffer = await safeFetch(downloadUrl, { skipSsrfCheck: true });
      const { filePath } = saveToUploads(buffer, sanitizeFileName(fileName), projectPath);

      await this.messageHandler!({
        channelId: chatId,
        content: `用户发送了文件：${fileName}\n文件已保存到：${filePath}\n请使用 Read 工具读取并分析文件内容。`,
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
    } catch (error) {
      logger.error('[DingTalk] Failed to download file:', error);
      await this.messageHandler!({
        channelId: chatId, content: `[文件下载失败] ${fileName}`,
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
    }
  }

  private async handleRichTextMessage(data: any, chatId: string, chatType: 'private' | 'group', senderId: string, senderNick: string, msgId: string): Promise<void> {
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
    const richText = content?.richText;
    if (!Array.isArray(richText)) {
      await this.messageHandler!({
        channelId: chatId, content: '[不支持的富文本格式]',
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
      return;
    }

    let text = '';
    const images: Array<{ data: string; mimeType: string }> = [];

    for (const item of richText) {
      if (item.type === 'text' && item.text) {
        text += item.text;
      } else if (item.type === 'picture' && item.downloadUrl) {
        try {
          const { safeFetch, validateImage } = await import('../utils/media-cache.js');
          const buffer = await safeFetch(item.downloadUrl, { skipSsrfCheck: true });
          const result = await validateImage(buffer);
          if ('mime' in result && result.mime) {
            images.push({ data: buffer.toString('base64'), mimeType: result.mime });
          }
        } catch (error) {
          logger.warn('[DingTalk] Failed to download richText image:', error);
        }
      }
    }

    const prompt = text.trim() || (images.length > 0 ? '用户发送了一张图片，请分析这张图片的内容。' : '[空消息]');
    await this.messageHandler!({
      channelId: chatId, content: prompt, chatType,
      peerId: senderId || '', peerName: senderNick, messageId: msgId,
      images: images.length > 0 ? images : undefined,
    });
  }

  // ── Outbound: text via sessionWebhook ──────────────────────────────────────

  async sendMessage(chatId: string, content: string): Promise<void> {
    const webhook = this.webhookCache.get(chatId);
    if (!webhook) {
      logger.warn(`[DingTalk] No webhook cached for chatId: ${chatId}, message dropped`);
      return;
    }

    try {
      const token = await this.client?.getAccessToken();
      const { default: axios } = await import('axios');
      await axios.post(webhook, {
        msgtype: 'markdown',
        markdown: { title: 'Bot', text: content },
      }, {
        headers: { 'x-acs-dingtalk-access-token': token || '' },
        timeout: 15_000,
      });
    } catch (error: any) {
      logger.error(`[DingTalk] sendMessage failed for ${chatId}:`, error.response?.data || error.message);
    }
  }

  // ── Outbound: image via Open API ───────────────────────────────────────────

  async sendImage(chatId: string, png: Buffer): Promise<void> {
    try {
      const token = await this.client?.getAccessToken();
      if (!token) {
        logger.warn('[DingTalk] No access token for sendImage');
        return;
      }

      // Step 1: Upload media
      const { default: axios } = await import('axios');
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('type', 'image');
      form.append('media', png, { filename: 'image.png', contentType: 'image/png' });

      const uploadRes = await axios.post(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}`,
        form,
        { headers: form.getHeaders(), timeout: 30_000 }
      );
      const mediaId = uploadRes.data?.media_id;
      if (!mediaId) {
        logger.error('[DingTalk] Media upload failed:', uploadRes.data);
        return;
      }

      // Step 2: Send via robot API
      await this.sendRobotMessage(chatId, token, 'sampleImageMsg', JSON.stringify({ photoURL: `@${mediaId}` }));
    } catch (error: any) {
      logger.error(`[DingTalk] sendImage failed for ${chatId}:`, error.response?.data || error.message);
    }
  }

  // ── Outbound: file via Open API ────────────────────────────────────────────

  async sendFile(chatId: string, filePath: string): Promise<void> {
    try {
      // Detect image files → route to sendImage (same pattern as Feishu)
      const fs = await import('fs');
      const header = Buffer.alloc(12);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, header, 0, 12, 0);
      fs.closeSync(fd);
      const { default: imageType } = await import('image-type');
      const imgType = await imageType(header);
      if (imgType) {
        const buf = fs.readFileSync(filePath);
        return this.sendImage(chatId, buf);
      }

      const token = await this.client?.getAccessToken();
      if (!token) {
        logger.warn('[DingTalk] No access token for sendFile');
        return;
      }

      // Step 1: Upload media
      const { default: axios } = await import('axios');
      const FormData = (await import('form-data')).default;
      const path = await import('path');
      const form = new FormData();
      form.append('type', 'file');
      form.append('media', fs.createReadStream(filePath), { filename: path.basename(filePath) });

      const uploadRes = await axios.post(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}`,
        form,
        { headers: form.getHeaders(), timeout: 60_000 }
      );
      const mediaId = uploadRes.data?.media_id;
      if (!mediaId) {
        logger.error('[DingTalk] File upload failed:', uploadRes.data);
        return;
      }

      // Step 2: Send via robot API
      const fileName = path.basename(filePath);
      const fileType = path.extname(filePath).replace('.', '') || 'file';
      await this.sendRobotMessage(chatId, token, 'sampleFile', JSON.stringify({ mediaId: `@${mediaId}`, fileName, fileType }));
    } catch (error: any) {
      logger.error(`[DingTalk] sendFile failed for ${chatId}:`, error.response?.data || error.message);
    }
  }

  // ── Robot message send helper (group vs DM) ────────────────────────────────

  private async sendRobotMessage(chatId: string, token: string, msgKey: string, msgParam: string): Promise<void> {
    const { default: axios } = await import('axios');
    const headers = { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' };
    const { clientId } = this.config;

    const openConversationId = this.conversationIdCache.get(chatId);
    const staffId = this.senderStaffIdCache.get(chatId);

    if (openConversationId && openConversationId !== chatId) {
      // Group send — we have a conversationId that's different from chatId (DM chatId = senderId)
      // Actually: if chatId IS the conversationId (group), use group API
    }

    // Determine if group or DM based on cached data
    // Group chatId = conversationId, DM chatId = senderId
    // If conversationIdCache[chatId] === chatId → group; otherwise → DM
    const cachedConvId = this.conversationIdCache.get(chatId);
    if (cachedConvId === chatId) {
      // Group: chatId is the conversationId
      await axios.post('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
        msgKey, msgParam, openConversationId: chatId, robotCode: clientId,
      }, { headers, timeout: 15_000 });
    } else if (staffId) {
      // DM: use senderStaffId
      await axios.post('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        msgKey, msgParam, userIds: [staffId], robotCode: clientId,
      }, { headers, timeout: 15_000 });
    } else {
      logger.warn(`[DingTalk] Cannot send robot message: no conversation/staff ID cached for ${chatId}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/channels/dingtalk.ts tests/unit/dingtalk-channel.test.ts && git commit -m "feat(dingtalk): DingtalkChannel core — connect, dedup, text/image/file handling"
```

---

### Task 4: DingtalkChannelPlugin Factory

**Files:**
- Modify: `src/channels/dingtalk.ts` (append plugin class)
- Test: `tests/unit/dingtalk-channel.test.ts` (append plugin tests)

- [ ] **Step 1: Write failing tests for the plugin**

Append to `tests/unit/dingtalk-channel.test.ts`:

```typescript
import { DingtalkChannelPlugin } from '../../src/channels/dingtalk.js';
import type { Config } from '../../src/types.js';

describe('DingtalkChannelPlugin', () => {
  describe('isEnabled', () => {
    it('should return false when no dingtalk config', () => {
      const plugin = new DingtalkChannelPlugin();
      expect(plugin.isEnabled({ projects: { defaultPath: '/tmp', autoCreate: false } } as Config)).toBe(false);
    });

    it('should return true with valid credentials', () => {
      const plugin = new DingtalkChannelPlugin();
      const config = {
        channels: { dingtalk: { clientId: 'abc', clientSecret: 'xyz' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      } as Config;
      expect(plugin.isEnabled(config)).toBe(true);
    });

    it('should return false when explicitly disabled', () => {
      const plugin = new DingtalkChannelPlugin();
      const config = {
        channels: { dingtalk: { clientId: 'abc', clientSecret: 'xyz', enabled: false } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      } as Config;
      expect(plugin.isEnabled(config)).toBe(false);
    });

    it('should return true with array form if any instance valid', () => {
      const plugin = new DingtalkChannelPlugin();
      const config = {
        channels: { dingtalk: [
          { name: 'dt1', clientId: '', clientSecret: '' },
          { name: 'dt2', clientId: 'abc', clientSecret: 'xyz' },
        ] },
        projects: { defaultPath: '/tmp', autoCreate: false },
      } as Config;
      expect(plugin.isEnabled(config)).toBe(true);
    });

    it('should return false with placeholder credentials', () => {
      const plugin = new DingtalkChannelPlugin();
      const config = {
        channels: { dingtalk: { clientId: 'your-app-key', clientSecret: 'your-app-secret' } },
        projects: { defaultPath: '/tmp', autoCreate: false },
      } as Config;
      expect(plugin.isEnabled(config)).toBe(false);
    });
  });

  describe('name', () => {
    it('should be dingtalk', () => {
      const plugin = new DingtalkChannelPlugin();
      expect(plugin.name).toBe('dingtalk');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: FAIL — `DingtalkChannelPlugin` not exported.

- [ ] **Step 3: Add DingtalkChannelPlugin to dingtalk.ts**

Append to the end of `src/channels/dingtalk.ts`:

```typescript
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config } from '../types.js';
import { normalizeChannelInstances } from '../config.js';
import type { DingtalkChannelConfig } from '../types.js';

function isValidCredential(value: string | undefined): boolean {
  return !!value && !value.includes('your-') && !value.includes('placeholder');
}

export class DingtalkChannelPlugin implements ChannelPlugin {
  readonly name = 'dingtalk';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.dingtalk;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && isValidCredential(inst.clientId) && isValidCredential(inst.clientSecret));
    }
    if (raw.enabled === false) return false;
    return isValidCredential(raw.clientId) && isValidCredential(raw.clientSecret);
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const instances = normalizeChannelInstances<DingtalkChannelConfig>(
      config.channels?.dingtalk,
      'dingtalk',
    );

    const result: ChannelInstance[] = [];
    for (const inst of instances) {
      if (inst.enabled === false) continue;
      if (!isValidCredential(inst.clientId) || !isValidCredential(inst.clientSecret)) continue;

      const channel = new DingtalkChannel({
        clientId: inst.clientId,
        clientSecret: inst.clientSecret,
        requireMention: inst.requireMention,
        freeResponseChats: inst.freeResponseChats,
      });

      const adapter = {
        channelName: inst.name,
        sendText: (id: string, text: string) => channel.sendMessage(id, text),
        sendFile: (id: string, filePath: string) => channel.sendFile(id, filePath),
        sendImage: (id: string, png: Buffer) => channel.sendImage(id, png),
      };

      const policy = {
        canSwitchProject: (_chatType: string, identity: string) => identity === 'owner',
        canListProjects: (_chatType: string, identity: string) => identity === 'owner',
        canCreateSession: (_chatType: string, _identity: string) => true,
        canDeleteSession: (_chatType: string, _identity: string) => true,
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
        accumulateErrors: (_chatType: string, _identity: string) => true,
      };

      const options = {
        fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
        supportsImages: true,
        flushDelay: inst.flushDelay,
      };

      result.push({
        channelType: 'dingtalk',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: (channelId: string) =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
      });
    }

    return result;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const instances = await this.createChannels(config);
    if (instances.length === 0) {
      throw new Error('DingTalk config missing or invalid');
    }
    return instances[0];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/channels/dingtalk.ts tests/unit/dingtalk-channel.test.ts && git commit -m "feat(dingtalk): add DingtalkChannelPlugin factory"
```

---

### Task 5: Register Plugin and Wire Message Bridge

**Files:**
- Modify: `src/index.ts:9-11` (add import)
- Modify: `src/index.ts:141-143` (add register)
- Modify: `src/index.ts:310-330` (add message bridge block)

- [ ] **Step 1: Add import**

In `src/index.ts`, add after the AUN import (line 11):

```typescript
import { DingtalkChannelPlugin } from './channels/dingtalk.js';
```

- [ ] **Step 2: Add plugin registration**

In `src/index.ts`, add after `channelLoader.register(new AUNChannelPlugin());` (line 143):

```typescript
channelLoader.register(new DingtalkChannelPlugin());
```

- [ ] **Step 3: Add message bridge wiring**

In `src/index.ts`, add after the `if (channelType === 'aun')` block (after line 330):

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

- [ ] **Step 4: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/evolclaw && npm test
```

Expected: All existing tests still pass, new DingTalk tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/evolclaw && git add src/index.ts && git commit -m "feat(dingtalk): register plugin and wire message bridge in index.ts"
```

---

### Task 6: Install form-data Dependency

The `sendImage` and `sendFile` methods use `form-data` for multipart uploads. Verify if it's already available or install it.

- [ ] **Step 1: Check if form-data is available**

```bash
cd /home/evolclaw && node -e "require('form-data')" 2>&1 || echo "MISSING"
```

- [ ] **Step 2: Install if missing**

```bash
cd /home/evolclaw && npm install form-data
```

- [ ] **Step 3: Verify build**

```bash
cd /home/evolclaw && npm run build
```

Expected: Build succeeds with no `Cannot find module 'form-data'` errors.

- [ ] **Step 4: Commit if package.json changed**

```bash
cd /home/evolclaw && git add package.json package-lock.json && git commit -m "chore: add form-data dependency for DingTalk media uploads"
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

Expected: All tests pass (existing + new DingTalk tests).

- [ ] **Step 3: Verify DingTalk test coverage**

```bash
cd /home/evolclaw && npx vitest run tests/unit/dingtalk-channel.test.ts --reporter=verbose
```

Expected: All DingTalk tests pass:
- Config: `channelTypes` includes `'dingtalk'`
- Webhook validation: accept/reject
- Message dedup
- chatId resolution (group vs DM)
- Group gate logic (requireMention, freeResponseChats, isInAtList)
- Text extraction (string vs object format)
- Plugin: `isEnabled` with various config shapes
- Plugin: `name` is `'dingtalk'`

- [ ] **Step 4: Commit final state**

Only if there are uncommitted fixes from test failures:

```bash
cd /home/evolclaw && git add -A && git commit -m "fix(dingtalk): address test feedback"
```
