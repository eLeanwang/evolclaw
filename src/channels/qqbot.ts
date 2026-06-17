import { logger } from '../utils/logger.js';
import { markdownToPlainText } from '../utils/rich-content-renderer.js';
import { requireOptional } from '../utils/npm-ops.js';
import type { ChannelPlugin, ChannelInstance, ChannelBuildContext } from '../core/channel-loader.js';
import { resolveShowActivities, showActivitiesPolicy } from '../core/channel-loader.js';
import type { MessageBridge } from '../core/message/message-bridge.js';
import type { QQBotChannelInstance as QQBotInst, ThoughtItem } from '../types.js';
import { formatItemsAsText } from '../core/message/items-formatter.js';
import type { FirstInteractionWelcomeManager } from '../utils/welcome.js';
import { initWelcomeManager, sendWelcomeIfNeeded } from '../utils/welcome.js';

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
  private recallHandler?: (messageId: string) => void;
  private seenMessages = new Map<string, number>();
  private chatTypeCache = new Map<string, 'private' | 'group'>();
  private msgIdCache = new Map<string, string>();
  private groupOpenidCache = new Map<string, string>();
  private markdownFailed = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  projectPathProvider: ((channelId: string) => Promise<string>) | null = null;

  // Welcome message manager
  private welcomeManager?: FirstInteractionWelcomeManager;

  constructor(config: QQBotConfig, private agentAid?: string, private channelName?: string) {
    this.config = config;

    // 初始化 welcomeManager（使用共享帮助函数）
    if (agentAid && channelName) {
      this.welcomeManager = initWelcomeManager('qqbot', agentAid, channelName);
    }
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

    const { QQBotClient } = await requireOptional('pure-qqbot');

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

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
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

      // 首次交互欢迎消息（使用共享帮助函数）
      await sendWelcomeIfNeeded(
        this.welcomeManager,
        event.senderId,
        chatId,
        (id, text) => this.sendMessage(id, text),
        'QQBot'
      );

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

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpPath = path.join(os.tmpdir(), `evolclaw-qqbot-${Date.now()}.png`);
    try {
      fs.writeFileSync(tmpPath, png);

      const chatType = this.chatTypeCache.get(chatId);
      const msgId = this.msgIdCache.get(chatId);

      if (chatType === 'group') {
        const groupOpenid = this.groupOpenidCache.get(chatId) || chatId;
        await this.client.sendGroupImage(groupOpenid, `file://${tmpPath}`, msgId);
      } else {
        await this.client.sendPrivateImage(chatId, `file://${tmpPath}`, msgId);
      }
    } catch (error: any) {
      logger.error(`[QQBot] sendImage failed for ${chatId}:`, error?.message || error);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  // ── Outbound: file ─────────────────────────────────────────────────────────

  async sendFile(chatId: string, filePath: string): Promise<void> {
    if (!this.client) return;

    try {
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

// ── Plugin ─────────────────────────────────────────────────────────────────────

function isValidCredential(value: string | undefined): boolean {
  return !!value && !value.includes('your-') && !value.includes('placeholder');
}

export class QQBotChannelPlugin implements ChannelPlugin {
  readonly name = 'qqbot';

  async createInstance(inst: QQBotInst, ctx: ChannelBuildContext): Promise<ChannelInstance | null> {
    if (inst.enabled === false) return null;
    if (!isValidCredential(inst.appId) || !isValidCredential(inst.clientSecret)) return null;

    const channel = new QQBotChannel({
      appId: inst.appId,
      clientSecret: inst.clientSecret,
    }, ctx.agentName, inst.name);

    const mode = resolveShowActivities(inst);
    const adapter = {
      channelName: inst.name,
      channelKey: inst.name,
      capabilities: { file: true, image: true, interaction: false, markdown: true, thought: false, status: false, thread: false },
      send: async (envelope: any, payload: any) => {
        const channelId = envelope.channelId;
        switch (payload.kind) {
          case 'result.text': case 'command.result': case 'command.error':
          case 'system.notice': case 'system.error': case 'result.error':
            await channel.sendMessage(channelId, payload.text); return;
          case 'result.file': await channel.sendFile(channelId, payload.filePath); return;
          case 'result.image': await channel.sendImage(channelId, payload.data); return;
          case 'activity.batch': {
            const filtered = payload.items.filter((i: ThoughtItem) => !(i.kind === 'tool_result' && i.ok));
            const text = formatItemsAsText(filtered);
            if (text) await channel.sendMessage(channelId, text);
            return;
          }
          case 'interaction':
            if (payload.fallbackText) await channel.sendMessage(channelId, payload.fallbackText);
            return;
          default: return;
        }
      },
    };

    const policy = {
      canSwitchProject: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      canListProjects: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      canCreateSession: () => true,
      canDeleteSession: () => true,
      canImportCliSession: (_: string, identity: string) => identity === 'owner' || identity === 'admin',
      messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
      showMiddleResult: (chatType: string, identity: string) => showActivitiesPolicy(mode, chatType, identity),
      showIdleMonitor: (chatType: string, identity: string) => showActivitiesPolicy(mode, chatType, identity),
      accumulateErrors: () => true,
    };

    return {
      channelType: 'qqbot', adapter, channel,
      policy,
      options: { fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g, supportsImages: true, flushDelay: inst.flushDelay },
      connect: () => channel.connect(),
      disconnect: () => channel.disconnect(),
      onProjectPathRequest: () => Promise.resolve(ctx.defaultProjectPath),
      registerBridge(bridge: MessageBridge, channelType: string) {
        bridge.register(
          adapter.channelName,
          (handler) => channel.onMessage(async (event: any) => {
            handler({
              channel: adapter.channelName, channelType, channelId: event.channelId,
              selfAID: ctx.agentName, content: event.content, images: event.images,
              chatType: event.chatType || 'private', peerId: event.peerId || '',
              peerName: event.peerName, messageId: event.messageId,
            });
          }),
          (channelId, text) => channel.sendMessage(channelId, text),
          adapter, channelType,
        );
      },
    };
  }
}
