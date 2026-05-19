import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { requireOptional } from '../utils/init-channel.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { MessageBridge } from '../core/message/message-bridge.js';
import type { Config, WecomChannelConfig } from '../types.js';
import { normalizeChannelInstances, getChannelShowActivities } from '../utils/channel-helpers.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WecomConfig {
  botId: string;
  secret: string;
}

export interface WecomMessageEvent {
  channelId: string;
  content: string;
  chatType: 'private' | 'group';
  peerId: string;
  peerName?: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

type WecomMessageHandler = (event: WecomMessageEvent) => Promise<void>;

// ── WecomChannel ───────────────────────────────────────────────────────────────

export class WecomChannel {
  private config: WecomConfig;
  private client: any = null;
  private connected = false;
  private messageHandler: WecomMessageHandler | null = null;
  private seenMessages = new Map<string, number>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  projectPathProvider: ((channelId: string) => Promise<string>) | null = null;

  // Stream reply state: reqId → { streamId, frame }
  private activeStreams = new Map<string, { streamId: string; frame: any }>();

  constructor(config: WecomConfig) {
    this.config = config;
  }

  // ── Public helpers (testable) ─────────────────────────────────────────────

  isDuplicate(msgId: string): boolean {
    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, Date.now());
    return false;
  }

  resolveChatId(chattype: string, chatid: string | undefined, userid: string): string {
    return chattype === 'group' && chatid ? chatid : userid;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { botId, secret } = this.config;
    if (!botId || !secret) {
      throw new Error('WeCom botId/secret not configured');
    }

    const { WSClient } = await requireOptional('@wecom/aibot-node-sdk');
    this.client = new WSClient({ botId, secret });

    // Message events
    this.client.on('message', (frame: any) => {
      this.handleIncoming(frame).catch((err: Error) => {
        logger.error('[WeCom] Failed to process incoming message:', err);
      });
    });

    // Event callbacks (enter_chat, etc.)
    this.client.on('event.enter_chat', (frame: any) => {
      const body = frame?.body;
      if (body) {
        logger.debug(`[WeCom] User entered chat: userid=${body.from?.userid} chattype=${body.chattype}`);
      }
    });

    // Lifecycle events
    this.client.on('authenticated', () => {
      logger.info('[WeCom] WebSocket authenticated');
    });

    this.client.on('disconnected', (reason: string) => {
      logger.warn(`[WeCom] WebSocket disconnected: ${reason}`);
      this.connected = false;
    });

    this.client.on('reconnecting', (attempt: number) => {
      logger.info(`[WeCom] Reconnecting (attempt ${attempt})...`);
    });

    this.client.on('error', (error: Error) => {
      logger.error('[WeCom] WebSocket error:', error);
    });

    this.client.connect();
    this.connected = true;

    // Hourly cleanup of old dedup entries
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, ts] of this.seenMessages) {
        if (ts < cutoff) this.seenMessages.delete(id);
      }
    }, 60 * 60 * 1000);

    logger.info('[WeCom] Channel connected');
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
    logger.info('[WeCom] Channel disconnected');
  }

  onMessage(handler: WecomMessageHandler): void {
    this.messageHandler = handler;
  }

  getStatus(): { connected: boolean } {
    return { connected: this.connected };
  }

  async reconnect(): Promise<string> {
    await this.disconnect();
    try {
      await this.connect();
      return '重连成功';
    } catch (err) {
      return `重连失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Inbound message handling ──────────────────────────────────────────────

  private async handleIncoming(frame: any): Promise<void> {
    const body = frame?.body;
    if (!body) return;

    const msgId = body.msgid;
    const chattype = body.chattype || 'single';
    const chatid = body.chatid;
    const userid = body.from?.userid || '';
    const msgtype = body.msgtype;

    // Dedup
    if (msgId && this.isDuplicate(msgId)) {
      logger.debug(`[WeCom] Duplicate message skipped: ${msgId}`);
      return;
    }

    const channelId = this.resolveChatId(chattype, chatid, userid);
    const chatTypeNorm: 'private' | 'group' = chattype === 'group' ? 'group' : 'private';

    // Store frame for stream replies
    this.activeStreams.set(channelId, {
      streamId: crypto.randomUUID(),
      frame: { headers: frame.headers },
    });

    if (!this.messageHandler) return;

    if (msgtype === 'text') {
      const text = body.text?.content?.trim();
      if (!text) return;

      // Handle quote/reference
      let content = text;
      if (body.quote) {
        const quoteText = body.quote.text?.content || '';
        if (quoteText) {
          content = `[引用: ${quoteText}]\n${text}`;
        }
      }

      await this.messageHandler({
        channelId, content, chatType: chatTypeNorm,
        peerId: userid, messageId: msgId,
      });
    } else if (msgtype === 'image') {
      await this.handleImageMessage(body, channelId, chatTypeNorm, userid, msgId, frame);
    } else if (msgtype === 'voice') {
      const voiceText = body.voice?.content?.trim();
      if (voiceText) {
        await this.messageHandler({
          channelId, content: voiceText, chatType: chatTypeNorm,
          peerId: userid, messageId: msgId,
        });
      }
    } else if (msgtype === 'file') {
      await this.handleFileMessage(body, channelId, chatTypeNorm, userid, msgId, frame);
    } else if (msgtype === 'video') {
      await this.handleVideoMessage(body, channelId, chatTypeNorm, userid, msgId, frame);
    } else if (msgtype === 'mixed') {
      await this.handleMixedMessage(body, channelId, chatTypeNorm, userid, msgId, frame);
    } else {
      await this.messageHandler({
        channelId,
        content: `[不支持的消息类型: ${msgtype}]`,
        chatType: chatTypeNorm, peerId: userid, messageId: msgId,
      });
    }
  }

  // ── Inbound media handling ────────────────────────────────────────────────

  private async handleImageMessage(body: any, channelId: string, chatType: 'private' | 'group', peerId: string, msgId: string, frame: any): Promise<void> {
    const imageUrl = body.image?.url;
    const aeskey = body.image?.aeskey;

    if (!imageUrl) {
      logger.warn('[WeCom] Image message without url');
      await this.messageHandler!({
        channelId, content: '[图片下载失败：缺少下载链接]',
        chatType, peerId, messageId: msgId,
      });
      return;
    }

    try {
      let buffer: Buffer;
      if (this.client && aeskey) {
        const result = await this.client.downloadFile(imageUrl, aeskey);
        buffer = result.buffer;
      } else {
        const { safeFetch } = await import('../utils/media-cache.js');
        buffer = await safeFetch(imageUrl, { skipSsrfCheck: true });
      }

      const { validateImage } = await import('../utils/media-cache.js');
      const result = await validateImage(buffer);

      if (result.mime) {
        await this.messageHandler!({
          channelId,
          content: '用户发送了一张图片，请分析这张图片的内容。',
          chatType, peerId, messageId: msgId,
          images: [{ data: buffer.toString('base64'), mimeType: result.mime }],
        });
      } else {
        logger.warn(`[WeCom] Image validation failed`);
        await this.messageHandler!({
          channelId, content: '[图片验证失败]',
          chatType, peerId, messageId: msgId,
        });
      }
    } catch (error) {
      logger.error('[WeCom] Failed to download image:', error);
      await this.messageHandler!({
        channelId, content: '[图片下载失败]',
        chatType, peerId, messageId: msgId,
      });
    }
  }

  private async handleFileMessage(body: any, channelId: string, chatType: 'private' | 'group', peerId: string, msgId: string, frame: any): Promise<void> {
    const fileUrl = body.file?.url;
    const aeskey = body.file?.aeskey;
    const fileName = body.file?.filename || 'unknown';

    if (!fileUrl) {
      logger.warn('[WeCom] File message without url');
      await this.messageHandler!({
        channelId, content: `[文件下载失败：缺少下载链接] ${fileName}`,
        chatType, peerId, messageId: msgId,
      });
      return;
    }

    try {
      let buffer: Buffer;
      if (this.client && aeskey) {
        const result = await this.client.downloadFile(fileUrl, aeskey);
        buffer = result.buffer;
      } else {
        const { safeFetch } = await import('../utils/media-cache.js');
        buffer = await safeFetch(fileUrl, { skipSsrfCheck: true });
      }

      const { saveToUploads, sanitizeFileName } = await import('../utils/media-cache.js');
      const projectPath = this.projectPathProvider
        ? await this.projectPathProvider(channelId)
        : process.cwd();
      const { filePath } = saveToUploads(buffer, sanitizeFileName(fileName), projectPath);

      await this.messageHandler!({
        channelId,
        content: `用户发送了文件：${fileName}\n文件已保存到：${filePath}\n请使用 Read 工具读取并分析文件内容。`,
        chatType, peerId, messageId: msgId,
      });
    } catch (error) {
      logger.error('[WeCom] Failed to download file:', error);
      await this.messageHandler!({
        channelId, content: `[文件下载失败] ${fileName}`,
        chatType, peerId, messageId: msgId,
      });
    }
  }

  private async handleVideoMessage(body: any, channelId: string, chatType: 'private' | 'group', peerId: string, msgId: string, frame: any): Promise<void> {
    const videoUrl = body.video?.url;
    const aeskey = body.video?.aeskey;

    if (!videoUrl) {
      await this.messageHandler!({
        channelId, content: '[视频下载失败：缺少下载链接]',
        chatType, peerId, messageId: msgId,
      });
      return;
    }

    try {
      let buffer: Buffer;
      if (this.client && aeskey) {
        const result = await this.client.downloadFile(videoUrl, aeskey);
        buffer = result.buffer;
      } else {
        const { safeFetch } = await import('../utils/media-cache.js');
        buffer = await safeFetch(videoUrl, { skipSsrfCheck: true });
      }

      const { saveToUploads } = await import('../utils/media-cache.js');
      const projectPath = this.projectPathProvider
        ? await this.projectPathProvider(channelId)
        : process.cwd();
      const fileName = `video_${Date.now()}.mp4`;
      const { filePath } = saveToUploads(buffer, fileName, projectPath);

      await this.messageHandler!({
        channelId,
        content: `用户发送了视频：${fileName}\n文件已保存到：${filePath}`,
        chatType, peerId, messageId: msgId,
      });
    } catch (error) {
      logger.error('[WeCom] Failed to download video:', error);
      await this.messageHandler!({
        channelId, content: '[视频下载失败]',
        chatType, peerId, messageId: msgId,
      });
    }
  }

  private async handleMixedMessage(body: any, channelId: string, chatType: 'private' | 'group', peerId: string, msgId: string, frame: any): Promise<void> {
    const msgItems = body.mixed?.msg_item;
    if (!Array.isArray(msgItems)) {
      await this.messageHandler!({
        channelId, content: '[不支持的图文混排格式]',
        chatType, peerId, messageId: msgId,
      });
      return;
    }

    let text = '';
    const images: Array<{ data: string; mimeType: string }> = [];

    for (const item of msgItems) {
      if (item.msgtype === 'text' && item.text?.content) {
        text += item.text.content;
      } else if (item.msgtype === 'image' && item.image?.url) {
        try {
          let buffer: Buffer;
          if (this.client && item.image.aeskey) {
            const result = await this.client.downloadFile(item.image.url, item.image.aeskey);
            buffer = result.buffer;
          } else {
            const { safeFetch } = await import('../utils/media-cache.js');
            buffer = await safeFetch(item.image.url, { skipSsrfCheck: true });
          }

          const { validateImage } = await import('../utils/media-cache.js');
          const result = await validateImage(buffer);
          if (result.mime) {
            images.push({ data: buffer.toString('base64'), mimeType: result.mime });
          }
        } catch (error) {
          logger.warn('[WeCom] Failed to download mixed image:', error);
        }
      }
    }

    const prompt = text.trim() || (images.length > 0 ? '用户发送了一张图片，请分析这张图片的内容。' : '[空消息]');
    await this.messageHandler!({
      channelId, content: prompt, chatType,
      peerId, messageId: msgId,
      images: images.length > 0 ? images : undefined,
    });
  }

  // ── Outbound: text ────────────────────────────────────────────────────────

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!content || content.trim() === '') {
      logger.warn('[WeCom] Attempted to send empty message, skipping');
      return;
    }

    if (!this.client) {
      logger.error('[WeCom] Client not connected, cannot send message');
      return;
    }

    try {
      // Try stream reply first (responds to a specific user message)
      const stream = this.activeStreams.get(chatId);
      if (stream) {
        await this.client.replyStream(
          stream.frame,
          stream.streamId,
          content,
          true, // finish
        );
        this.activeStreams.delete(chatId);
        logger.debug(`[WeCom] Sent stream reply to ${chatId}`);
        return;
      }

      // Fallback: proactive send (markdown)
      await this.client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content },
      });
      logger.debug(`[WeCom] Sent proactive message to ${chatId}`);
    } catch (error: any) {
      logger.error(`[WeCom] sendMessage failed for ${chatId}:`, error.message);
    }
  }

  // ── Outbound: image ───────────────────────────────────────────────────────

  async sendImage(chatId: string, png: Buffer): Promise<void> {
    if (!this.client) {
      logger.warn('[WeCom] Client not connected for sendImage');
      return;
    }

    try {
      const result = await this.client.uploadMedia(png, {
        type: 'image',
        filename: 'image.png',
      });
      const mediaId = result?.media_id;
      if (!mediaId) {
        logger.error('[WeCom] Media upload failed: no media_id');
        return;
      }

      // Try reply media if we have an active frame, else proactive send
      const stream = this.activeStreams.get(chatId);
      if (stream) {
        await this.client.replyMedia(stream.frame, 'image', mediaId);
        this.activeStreams.delete(chatId);
      } else {
        await this.client.sendMediaMessage(chatId, 'image', mediaId);
      }
      logger.debug(`[WeCom] Sent image to ${chatId}`);
    } catch (error: any) {
      logger.error(`[WeCom] sendImage failed for ${chatId}:`, error.message);
    }
  }

  // ── Outbound: file ────────────────────────────────────────────────────────

  async sendFile(chatId: string, filePath: string): Promise<void> {
    if (!this.client) {
      logger.warn('[WeCom] Client not connected for sendFile');
      return;
    }

    try {
      const fs = await import('fs');
      const path = await import('path');

      if (!fs.existsSync(filePath)) {
        logger.error(`[WeCom] File not found: ${filePath}`);
        return;
      }

      // Detect image files → route to sendImage
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

      const buf = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      const result = await this.client.uploadMedia(buf, {
        type: 'file',
        filename: fileName,
      });
      const mediaId = result?.media_id;
      if (!mediaId) {
        logger.error('[WeCom] File upload failed: no media_id');
        return;
      }

      const stream = this.activeStreams.get(chatId);
      if (stream) {
        await this.client.replyMedia(stream.frame, 'file', mediaId);
        this.activeStreams.delete(chatId);
      } else {
        await this.client.sendMediaMessage(chatId, 'file', mediaId);
      }
      logger.debug(`[WeCom] Sent file ${fileName} to ${chatId}`);
    } catch (error: any) {
      logger.error(`[WeCom] sendFile failed for ${chatId}:`, error.message);
    }
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

function isValidCredential(value: string | undefined): boolean {
  return !!value && !value.includes('your-') && !value.includes('placeholder');
}

export class WecomChannelPlugin implements ChannelPlugin {
  readonly name = 'wecom';

  isEnabled(config: Config): boolean {
    const raw = config.channels?.wecom;
    if (!raw) return false;
    if (Array.isArray(raw)) {
      return raw.some(inst => inst.enabled !== false && isValidCredential(inst.botId) && isValidCredential(inst.secret));
    }
    if (raw.enabled === false) return false;
    return isValidCredential(raw.botId) && isValidCredential(raw.secret);
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const instances = normalizeChannelInstances<WecomChannelConfig>(
      config.channels?.wecom,
      'wecom',
    );

    const result: ChannelInstance[] = [];
    for (const inst of instances) {
      if (inst.enabled === false) continue;
      if (!isValidCredential(inst.botId) || !isValidCredential(inst.secret)) continue;

      const channel = new WecomChannel({
        botId: inst.botId,
        secret: inst.secret,
      });

      const adapter = {
        channelName: inst.name,
        sendText: (id: string, text: string) => channel.sendMessage(id, text),
        sendFile: (id: string, filePath: string) => channel.sendFile(id, filePath),
        sendImage: (id: string, png: Buffer) => channel.sendImage(id, png),
      };

      const policy = {
        canSwitchProject: (_chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canListProjects: (_chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canCreateSession: () => true,
        canDeleteSession: () => true,
        canImportCliSession: (_chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
        showMiddleResult: (chatType: string, identity: string) => {
          const mode = getChannelShowActivities(config, inst.name);
          if (mode === 'none') return false;
          if (mode === 'dm-only') return chatType === 'private';
          if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
          return true;
        },
        showIdleMonitor: (chatType: string, identity: string) => {
          const mode = getChannelShowActivities(config, inst.name);
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
        channelType: 'wecom',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: () =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
        registerBridge(bridge: MessageBridge, channelType: string) {
          bridge.register(
            adapter.channelName,
            (handler) => channel.onMessage(async (event: any) => {
              handler({
                channel: adapter.channelName,
                channelType,
                channelId: event.channelId,
                content: event.content,
                chatType: event.chatType || 'private',
                peerId: event.peerId || '',
                peerName: event.peerName,
                messageId: event.messageId,
              });
            }),
            (channelId, text) => channel.sendMessage(channelId, text),
            adapter,
            channelType
          );
        },
      });
    }

    return result;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const instances = await this.createChannels(config);
    if (instances.length === 0) {
      throw new Error('WeCom config missing or invalid');
    }
    return instances[0];
  }
}
