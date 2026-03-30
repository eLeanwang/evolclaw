import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import imageType from 'image-type';
import { ensureDir } from '../config.js';
import { logger } from '../utils/logger.js';
import { markdownToFeishuPost, hasMarkdownSyntax } from '../utils/markdown-to-feishu.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  db: DatabaseSync;
}

export interface MessageHandlerOptions {
  channelId: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  userId?: string;
  userName?: string;
  messageId?: string;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  threadId?: string;
  rootId?: string;
}

export interface MessageHandler {
  (options: MessageHandlerOptions): Promise<void>;
}

export interface ProjectPathProvider {
  (channelId: string): Promise<string>;
}

export class FeishuChannel {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private messageHandler?: MessageHandler;
  private projectPathProvider?: ProjectPathProvider;
  private db: DatabaseSync;
  private cleanupInterval?: NodeJS.Timeout;
  private chatTypeCache: Map<string, string> = new Map();

  constructor(private config: FeishuConfig) {
    this.db = config.db;
    this.initChatTypeTable();
  }

  private initChatTypeTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_types (
        chat_id TEXT PRIMARY KEY,
        chat_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async connect(): Promise<void> {
    // 检查配置有效性
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu credentials missing (appId or appSecret is empty)');
    }

    if (this.config.appId.startsWith('YOUR_') || this.config.appSecret.startsWith('YOUR_')) {
      throw new Error('Feishu credentials not configured (placeholder values detected)');
    }

    try {
      this.client = new lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });

      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          const msg = data.message;
          logger.debug('[Feishu] Received message, message_id:', msg.message_id, 'type:', msg.message_type);
          logger.debug('[Feishu] Full data object:', JSON.stringify(data, null, 2));

          if (!msg.message_id || this.isDuplicate(msg.message_id)) {
            logger.debug('[Feishu] Duplicate message ignored:', msg.message_id);
            return;
          }
          this.markSeen(msg.message_id);
          this.addAckReaction(msg.message_id);

          if (!this.messageHandler) return;

          // 话题消息检测日志（去重后）
          if (msg.thread_id) {
            logger.info('[Feishu] Thread message, thread_id:', msg.thread_id, 'root_id:', msg.root_id);
          }

          // 提取 @ 提及列表（排除机器人自身）
          const mentions = (msg.mentions || []).map((m: any) => ({
            userId: m.id?.open_id || '',
            name: m.name,
            key: m.key
          })).filter((m: any) => m.userId && m.userId !== this.config.appId);

          // 提取发送者信息
          const userId = data.sender?.sender_id?.open_id;
          let userName: string | undefined;
          try {
            userName = await this.getUserName(userId);
          } catch {
            userName = undefined;
          }

          try {
            // 提取话题信息
            const threadId = msg.thread_id || undefined;
            const rootId = msg.root_id || undefined;

            // 处理引用消息（话题内消息跳过，避免每条都拼接引用前缀）
            let quotedText = '';
            let quotedImages: Array<{ data: string; mimeType: string }> = [];

            // 话题创建消息检测：DB 中无对应 thread session 时为首条消息
            const isThreadCreating = threadId && !this.hasThreadSession(threadId);

            if (msg.parent_id && (!msg.thread_id || isThreadCreating) && this.client) {
              try {
                const res = await this.client.im.message.get({
                  path: { message_id: msg.parent_id }
                });

                if (!res.data?.items?.[0]?.body) {
                  throw new Error('Invalid response');
                }

                const quotedMsgType = res.data.items[0].msg_type;
                const quotedContent = res.data.items[0].body.content;

                if (quotedMsgType === 'text') {
                  const parsed = JSON.parse(quotedContent);
                  quotedText = `> ${parsed.text}\n\n`;
                } else if (quotedMsgType === 'post') {
                  const parsed = JSON.parse(quotedContent);
                  logger.info('[Feishu] Post message structure:', JSON.stringify(parsed, null, 2));
                  let text = '';
                  const content = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content;
                  if (content) {
                    for (const line of content) {
                      for (const elem of line) {
                        if (elem.text) text += elem.text;
                      }
                      text += '\n';
                    }
                  }
                  quotedText = `> ${text.trim()}\n\n`;
                } else if (quotedMsgType === 'image') {
                  const parsed = JSON.parse(quotedContent);
                  const imageKey = parsed.image_key;

                  const projectPath = this.projectPathProvider
                    ? await this.projectPathProvider(msg.chat_id)
                    : process.cwd();

                  const imageData = await this.downloadAndSaveImage(
                    imageKey,
                    msg.chat_id,
                    msg.parent_id,
                    projectPath
                  );

                  if (imageData) {
                    quotedImages.push(imageData);
                    quotedText = `> [引用的图片]\n\n`;
                  } else {
                    quotedText = `> [图片消息]\n\n`;
                  }
                } else if (quotedMsgType === 'file') {
                  const parsedFile = JSON.parse(quotedContent);
                  const quotedFileKey = parsedFile.file_key;
                  const quotedFileName = parsedFile.file_name || 'unknown';

                  const projectPath = this.projectPathProvider
                    ? await this.projectPathProvider(msg.chat_id)
                    : process.cwd();

                  const quotedFilePath = await this.downloadFile(quotedFileKey, quotedFileName, msg.parent_id, projectPath);
                  if (quotedFilePath) {
                    quotedText = `> [引用的文件：${quotedFileName}]\n> 文件已保存到：${quotedFilePath}\n\n`;
                  } else {
                    quotedText = `> [文件消息]\n\n`;
                  }
                } else {
                  quotedText = `> [${quotedMsgType}消息]\n\n`;
                }
              } catch (err) {
                logger.warn({ err }, '[Feishu] Failed to fetch quoted message');
              }
            }

            // 处理文本消息
            if (msg.message_type === 'text') {
              const parsed = JSON.parse(msg.content);
              // 优先使用 text_without_at_bot（去除机器人 @），否则使用 text
              const content = parsed.text_without_at_bot || parsed.text;
              const finalContent = quotedText + content;
              await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, mentions: mentions.length > 0 ? mentions : undefined, threadId, rootId });
            }
            // 处理图片消息
            else if (msg.message_type === 'image') {
              const imageContent = JSON.parse(msg.content);
              const imageKey = imageContent.image_key;
              logger.debug('[Feishu] Received image message, image_key:', imageKey, 'message_id:', msg.message_id);

              const projectPath = this.projectPathProvider
                ? await this.projectPathProvider(msg.chat_id)
                : process.cwd();

              const imageData = await this.downloadAndSaveImage(imageKey, msg.chat_id, msg.message_id, projectPath);
              if (imageData) {
                const allImages = [...quotedImages, imageData];
                const prompt = quotedText + '用户发送了一张图片，请分析这张图片的内容。';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: allImages, userId, userName, messageId: msg.message_id, threadId, rootId });
              } else {
                const prompt = quotedText + '[图片下载失败] 应用可能缺少 im:message 或 im:message:readonly 权限';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, threadId, rootId });
              }
            }
            // 处理文件消息
            else if (msg.message_type === 'file') {
              const fileContent = JSON.parse(msg.content);
              const fileKey = fileContent.file_key;
              const fileName = fileContent.file_name || 'unknown';
              logger.debug('[Feishu] Received file message, file_key:', fileKey, 'file_name:', fileName);

              const projectPath = this.projectPathProvider
                ? await this.projectPathProvider(msg.chat_id)
                : process.cwd();

              const filePath = await this.downloadFile(fileKey, fileName, msg.message_id, projectPath);
              if (filePath) {
                const prompt = quotedText + `用户发送了文件：${fileName}\n文件已保存到：${filePath}\n请使用 Read 工具读取并分析文件内容。`;
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, threadId, rootId });
              } else {
                const prompt = quotedText + '[文件下载失败] 应用可能缺少 im:resource 权限';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, threadId, rootId });
              }
            }
            // 处理富文本消息
            else if (msg.message_type === 'post') {
              const parsed = JSON.parse(msg.content);
              let text = '';
              const title = parsed.zh_cn?.title || parsed.en_us?.title || parsed.title;
              const content = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content;
              if (content) {
                for (const line of content) {
                  for (const elem of line) {
                    if (elem.text) text += elem.text;
                  }
                  text += '\n';
                }
              }
              let finalContent = text.trim();
              if (title) finalContent = `${title}\n${finalContent}`;
              finalContent = quotedText + finalContent;
              await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, threadId, rootId });
            }
            // 处理其他类型消息
            else {
              logger.debug('[Feishu] Unsupported message type:', msg.message_type);
              const prompt = quotedText + `[不支持的消息类型: ${msg.message_type}]`;
              await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, userId, userName, messageId: msg.message_id, threadId, rootId });
            }
          } catch (error) {
            logger.error('[Feishu] Failed to process message:', error);
          }
        },
        'im.message.message_read_v1': async () => {},
        'im.message.reaction.created_v1': async () => {}
      });

      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });

      await this.wsClient.start({ eventDispatcher });
      this.startCleanupTask();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Feishu connection failed: ${error.message}`);
      }
      throw error;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onProjectPathRequest(provider: ProjectPathProvider): void {
    this.projectPathProvider = provider;
  }

  async getChatMode(chatId: string): Promise<string> {
    logger.info(`[Feishu] getChatMode called for chatId: ${chatId}`);

    // 检查缓存
    if (this.chatTypeCache.has(chatId)) {
      logger.info(`[Feishu] getChatMode from cache: ${this.chatTypeCache.get(chatId)}`);
      return this.chatTypeCache.get(chatId)!;
    }

    // 检查数据库
    const row = this.db.prepare('SELECT chat_mode FROM chat_types WHERE chat_id = ?').get(chatId) as { chat_mode: string } | undefined;
    if (row) {
      logger.info(`[Feishu] getChatMode from db: ${row.chat_mode}`);
      this.chatTypeCache.set(chatId, row.chat_mode);
      return row.chat_mode;
    }

    // 调用 API 获取
    if (!this.client) return 'p2p';

    try {
      logger.info(`[Feishu] Calling API to get chat mode for ${chatId}`);
      const res = await this.client.im.chat.get({ path: { chat_id: chatId } });
      const chatMode = res.data?.chat_mode || 'p2p';
      logger.info(`[Feishu] API returned chat_mode: ${chatMode}`);

      // 保存到数据库和缓存
      this.db.prepare('INSERT OR REPLACE INTO chat_types (chat_id, chat_mode, updated_at) VALUES (?, ?, ?)').run(chatId, chatMode, Date.now());
      this.chatTypeCache.set(chatId, chatMode);

      return chatMode;
    } catch (error) {
      logger.warn('[Feishu] Failed to get chat mode, defaulting to p2p:', error);
      return 'p2p';
    }
  }

  private async getUserName(_userId?: string): Promise<string | undefined> {
    // TODO: 需要开通 contact:contact.base:readonly 权限后启用
    return undefined;
  }

  async sendMessage(chatId: string, content: string, options?: { title?: string; replyToMessageId?: string; forceText?: boolean; mentionUserIds?: string[]; replyInThread?: boolean }): Promise<void> {
    if (!this.client) return;

    if (!content || content.trim() === '') {
      logger.warn('[Feishu] Attempted to send empty message, skipping');
      return;
    }

    logger.debug(`[Feishu] sendMessage called, chatId: ${chatId}, content length: ${content.length}`);

    try {
      const useMarkdown = !options?.forceText && hasMarkdownSyntax(content);
      const hasMention = !!(options?.mentionUserIds && options.mentionUserIds.length > 0);

      // 如果需要 @，强制使用 post 格式
      const msgType = (useMarkdown || hasMention) ? 'post' : 'text';

      let msgContent: string;
      if (hasMention) {
        // 构造带 @ 的富文本消息
        const postData = useMarkdown
          ? markdownToFeishuPost(content, options?.title)
          : { zh_cn: { title: options?.title || '', content: [[{ tag: 'text', text: content }]] } };

        // 在第一行开头插入所有 @ 标签
        if (postData.zh_cn.content.length > 0) {
          const atTags = options!.mentionUserIds!.map(uid => ({ tag: 'at', user_id: uid }));
          postData.zh_cn.content[0].unshift(...atTags);
        }
        msgContent = JSON.stringify(postData);
      } else {
        msgContent = useMarkdown
          ? JSON.stringify(markdownToFeishuPost(content, options?.title))
          : JSON.stringify({ text: content });
      }

      if (options?.replyToMessageId) {
        const replyData: any = { msg_type: msgType, content: msgContent };
        if (options.replyInThread) {
          replyData.reply_in_thread = true;
        }
        await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: replyData
        });
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: msgType, content: msgContent }
        });
      }
      logger.debug(`[Feishu] Sent message as ${useMarkdown ? 'post (Markdown)' : 'text'}`);
    } catch (error: any) {
      // 230011: 消息已被撤回，降级为普通消息重试
      if (error.response?.data?.code === 230011 && options?.replyToMessageId) {
        logger.warn('[Feishu] Message withdrawn (230011), retrying without reply');
        return this.sendMessage(chatId, content, { ...options, replyToMessageId: undefined });
      }
      logger.error('[Feishu] Failed to send message:', error);
      throw error;
    }
  }

  async sendFile(chatId: string, filePath: string): Promise<void> {
    if (!this.client) return;

    try {
      logger.info('[Feishu] Uploading file:', filePath);

      const fileStream = fs.createReadStream(filePath);
      const fileName = path.basename(filePath);

      const uploadResponse = await this.client.im.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: fileStream
        }
      });

      if (!uploadResponse || !uploadResponse.file_key) {
        logger.error('[Feishu] File upload failed: no file_key returned');
        return;
      }

      const fileKey = uploadResponse.file_key;

      logger.info('[Feishu] File uploaded, file_key:', fileKey);

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey })
        }
      });

      logger.info('[Feishu] File message sent successfully');
    } catch (error) {
      logger.error('[Feishu] Failed to send file:', error);
      throw error;
    }
  }

  private hasThreadSession(threadId: string): boolean {
    try {
      const row = this.db.prepare('SELECT 1 FROM sessions WHERE thread_id = ? LIMIT 1').get(threadId);
      return !!row;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    if (this.wsClient) {
      await this.wsClient.close();
      this.wsClient = null;
    }
    this.client = null;
  }

  private async downloadAndSaveImage(imageKey: string, chatId: string, messageId: string, projectPath: string): Promise<{ data: string; mimeType: string } | null> {
    if (!this.client) return null;

    try {
      logger.debug('[Feishu] Downloading image, image_key:', imageKey);

      // 使用 message-resource API 下载用户发送的图片
      const response = await this.client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: imageKey
        },
        params: {
          type: 'image'
        }
      });

      // 读取图片数据流并转换为 base64
      if (response && typeof response.getReadableStream === 'function') {
        const stream = response.getReadableStream();
        const chunks: Buffer[] = [];

        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          logger.warn('[Feishu] Empty response from image download');
          return null;
        }

        // 使用 image-type 检测真实的图片格式
        const type = await imageType(buffer);

        if (!type) {
          logger.warn('[Feishu] Unable to detect image type');
          return null;
        }

        // 白名单验证：只允许常见的图片格式
        const allowedMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (!allowedMimes.includes(type.mime)) {
          logger.warn('[Feishu] Unsupported image type:', type.mime);
          return null;
        }

        // 大小限制：10MB
        if (buffer.length > 10 * 1024 * 1024) {
          logger.warn('[Feishu] Image too large:', buffer.length, 'bytes');
          return null;
        }

        const base64Data = buffer.toString('base64');
        logger.debug('[Feishu] Image downloaded successfully, type:', type.mime, 'size:', base64Data.length);

        return {
          data: base64Data,
          mimeType: type.mime  // 使用真实检测的 MIME 类型
        };
      }

      logger.error('[Feishu] Image download failed: no valid method');
      return null;
    } catch (error) {
      logger.error('[Feishu] Failed to download image:', error);
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        logger.error('[Feishu] Response status:', axiosError.response?.status);
        logger.error('[Feishu] Response data:', JSON.stringify(axiosError.response?.data));
      }
      return null;
    }
  }

  private async downloadFile(fileKey: string, fileName: string, messageId: string, projectPath: string): Promise<string | null> {
    if (!this.client) return null;

    try {
      logger.debug('[Feishu] Downloading file, file_key:', fileKey, 'file_name:', fileName);

      const response = await this.client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey
        },
        params: {
          type: 'file'
        }
      });

      if (response && typeof response.getReadableStream === 'function') {
        const stream = response.getReadableStream();
        const chunks: Buffer[] = [];

        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          logger.warn('[Feishu] Empty response from file download');
          return null;
        }

        const uploadsDir = path.join(projectPath, '.claude', 'uploads');
        ensureDir(uploadsDir);

        const filePath = path.join(uploadsDir, fileName);
        fs.writeFileSync(filePath, buffer);

        logger.info('[Feishu] File downloaded successfully:', filePath, 'size:', buffer.length);
        return filePath;
      }

      logger.error('[Feishu] File download failed: no valid method');
      return null;
    } catch (error) {
      logger.error('[Feishu] Failed to download file:', error);
      return null;
    }
  }

  private isDuplicate(msgId: string): boolean {
    const result = this.db.prepare(
      'SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1'
    ).get(msgId);
    return !!result;
  }

  private markSeen(msgId: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO processed_messages (message_id, channel, channel_id, processed_at) VALUES (?, ?, ?, ?)'
    ).run(msgId, 'feishu', '', Date.now());
  }

  private addAckReaction(messageId: string): void {
    if (!this.client) return;

    this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: 'CheckMark' }
      }
    }).catch(() => {});
  }

  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const result = this.db.prepare(
        'DELETE FROM processed_messages WHERE processed_at < ?'
      ).run(cutoff);
      if (result.changes > 0) {
        logger.info(`[Feishu] Cleaned ${result.changes} old processed messages`);
      }
    }, 60 * 60 * 1000);
  }
}
