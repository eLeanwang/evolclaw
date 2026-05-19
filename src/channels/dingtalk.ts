import { logger } from '../utils/logger.js';
import { requireOptional } from '../utils/init-channel.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { MessageBridge } from '../core/message/message-bridge.js';
import type { Config, DingtalkChannelConfig } from '../types.js';
import { normalizeChannelInstances, getChannelShowActivities } from '../utils/channel-helpers.js';

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
  private recallHandler?: (messageId: string) => void;
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

    const { DWClient, TOPIC_ROBOT } = await requireOptional('dingtalk-stream');
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

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
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
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : (data.content || {});
    const downloadUrl = content.downloadUrl || content.downloadCode;
    if (!downloadUrl) {
      logger.warn('[DingTalk] Image message without downloadUrl');
      await this.messageHandler!({
        channelId: chatId, content: '[图片下载失败：缺少下载链接]',
        chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
      });
      return;
    }

    try {
      const { safeFetch, validateImage } = await import('../utils/media-cache.js');
      const buffer = await safeFetch(downloadUrl, { skipSsrfCheck: true });
      const result = await validateImage(buffer);

      if (result.mime) {
        await this.messageHandler!({
          channelId: chatId,
          content: '用户发送了一张图片，请分析这张图片的内容。',
          chatType, peerId: senderId || '', peerName: senderNick, messageId: msgId,
          images: [{ data: buffer.toString('base64'), mimeType: result.mime }],
        });
      } else {
        logger.warn(`[DingTalk] Image validation failed: ${!result.mime && 'reason' in result ? result.reason : 'unknown'}`);
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
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : (data.content || {});
    const downloadUrl = content.downloadUrl || content.downloadCode;
    const fileName = content.fileName || 'unknown';

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
    const content = typeof data.content === 'string' ? JSON.parse(data.content) : (data.content || {});
    const richText = content.richText;
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
          if (result.mime) {
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
      const response = await fetch(webhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token || '',
        },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { title: 'Bot', text: content },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.error(`[DingTalk] sendMessage failed for ${chatId}: ${response.status} ${body}`);
      }
    } catch (error: any) {
      logger.error(`[DingTalk] sendMessage failed for ${chatId}:`, error.message);
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
      const FormData = (await requireOptional('form-data')).default;
      const form = new FormData();
      form.append('type', 'image');
      form.append('media', png, { filename: 'image.png', contentType: 'image/png' });

      const uploadRes = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}`,
        { method: 'POST', body: form as any, signal: AbortSignal.timeout(30_000) }
      );
      const uploadData: any = await uploadRes.json();
      const mediaId = uploadData?.media_id;
      if (!mediaId) {
        logger.error('[DingTalk] Media upload failed:', uploadData);
        return;
      }

      // Step 2: Send via robot API
      await this.sendRobotMessage(chatId, token, 'sampleImageMsg', JSON.stringify({ photoURL: `@${mediaId}` }));
    } catch (error: any) {
      logger.error(`[DingTalk] sendImage failed for ${chatId}:`, error.message);
    }
  }

  // ── Outbound: file via Open API ────────────────────────────────────────────

  async sendFile(chatId: string, filePath: string): Promise<void> {
    try {
      // Detect image files → route to sendImage (same pattern as Feishu)
      const fs = await import('fs');
      const path = await import('path');
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

      const token = await this.client?.getAccessToken();
      if (!token) {
        logger.warn('[DingTalk] No access token for sendFile');
        return;
      }

      // Step 1: Upload media
      const FormData = (await requireOptional('form-data')).default;
      const form = new FormData();
      form.append('type', 'file');
      form.append('media', fs.createReadStream(filePath), { filename: path.basename(filePath) });

      const uploadRes = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${token}`,
        { method: 'POST', body: form as any, signal: AbortSignal.timeout(60_000) }
      );
      const uploadData: any = await uploadRes.json();
      const mediaId = uploadData?.media_id;
      if (!mediaId) {
        logger.error('[DingTalk] File upload failed:', uploadData);
        return;
      }

      // Step 2: Send via robot API
      const fileName = path.basename(filePath);
      const fileType = path.extname(filePath).replace('.', '') || 'file';
      await this.sendRobotMessage(chatId, token, 'sampleFile', JSON.stringify({ mediaId: `@${mediaId}`, fileName, fileType }));
    } catch (error: any) {
      logger.error(`[DingTalk] sendFile failed for ${chatId}:`, error.message);
    }
  }

  // ── Robot message send helper (group vs DM) ────────────────────────────────

  private async sendRobotMessage(chatId: string, token: string, msgKey: string, msgParam: string): Promise<void> {
    const headers = { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' };
    const { clientId } = this.config;

    // Group chatId = conversationId, DM chatId = senderId
    const cachedConvId = this.conversationIdCache.get(chatId);
    const staffId = this.senderStaffIdCache.get(chatId);

    if (cachedConvId === chatId) {
      // Group: chatId is the conversationId
      const res = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
        method: 'POST', headers,
        body: JSON.stringify({ msgKey, msgParam, openConversationId: chatId, robotCode: clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) logger.error(`[DingTalk] Group robot send failed: ${res.status}`);
    } else if (staffId) {
      // DM: use senderStaffId
      const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST', headers,
        body: JSON.stringify({ msgKey, msgParam, userIds: [staffId], robotCode: clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) logger.error(`[DingTalk] DM robot send failed: ${res.status}`);
    } else {
      logger.warn(`[DingTalk] Cannot send robot message: no conversation/staff ID cached for ${chatId}`);
    }
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

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
        channelType: 'dingtalk',
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
                images: event.images,
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
      throw new Error('DingTalk config missing or invalid');
    }
    return instances[0];
  }
}
