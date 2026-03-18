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

export interface MessageHandler {
  (channelId: string, content: string, images?: Array<{ data: string; mimeType: string }>, userId?: string, userName?: string, messageId?: string): Promise<void>;
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

          // 提取发送者信息
          const userId = data.sender?.sender_id?.open_id;
          let userName: string | undefined;
          try {
            userName = await this.getUserName(userId);
          } catch {
            userName = undefined;
          }

          try {
            // 处理引用消息
            let quotedText = '';
            let quotedImages: Array<{ data: string; mimeType: string }> = [];

            if (msg.parent_id && this.client) {
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
                  quotedText = `> [文件消息]\n\n`;
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
              let content = parsed.text_without_at_bot || parsed.text;
              // 去除消息中所有的 @ 提及（支持命令在前或在后）
              content = content.replace(/@[^\s]+\s*/g, '').trim();
              const finalContent = quotedText + content;
              await this.messageHandler(msg.chat_id, finalContent, quotedImages.length > 0 ? quotedImages : undefined, userId, userName, msg.message_id);
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
                await this.messageHandler(msg.chat_id, prompt, allImages, userId, userName, msg.message_id);
              } else {
                const prompt = quotedText + '[图片下载失败] 应用可能缺少 im:resource 权限';
                await this.messageHandler(msg.chat_id, prompt, quotedImages.length > 0 ? quotedImages : undefined, userId, userName, msg.message_id);
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
                await this.messageHandler(msg.chat_id, prompt, quotedImages.length > 0 ? quotedImages : undefined, userId, userName, msg.message_id);
              } else {
                const prompt = quotedText + '[文件下载失败] 应用可能缺少 im:resource 权限';
                await this.messageHandler(msg.chat_id, prompt, quotedImages.length > 0 ? quotedImages : undefined, userId, userName, msg.message_id);
              }
            }
            // 处理其他类型消息
            else {
              logger.debug('[Feishu] Unsupported message type:', msg.message_type);
              const prompt = quotedText + `[不支持的消息类型: ${msg.message_type}]`;
              await this.messageHandler(msg.chat_id, prompt, quotedImages.length > 0 ? quotedImages : undefined, userId, userName, msg.message_id);
            }
          } catch (error) {
            logger.error('[Feishu] Failed to process message:', error);
          }
        },
        'im.message.message_read_v1': async () => {}
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

  async sendMessage(chatId: string, content: string, options?: { title?: string; replyToMessageId?: string; forceText?: boolean }): Promise<void> {
    if (!this.client) return;

    if (!content || content.trim() === '') {
      logger.warn('[Feishu] Attempted to send empty message, skipping');
      return;
    }

    logger.debug(`[Feishu] sendMessage called, chatId: ${chatId}, content length: ${content.length}`);

    try {
      const useMarkdown = !options?.forceText && hasMarkdownSyntax(content);

      const msgType = useMarkdown ? 'post' : 'text';
      const msgContent = useMarkdown
        ? JSON.stringify(markdownToFeishuPost(content, options?.title))
        : JSON.stringify({ text: content });

      if (options?.replyToMessageId) {
        await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: { msg_type: msgType, content: msgContent }
        });
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: msgType, content: msgContent }
        });
      }
      logger.debug(`[Feishu] Sent message as ${useMarkdown ? 'post (Markdown)' : 'text'}`);
    } catch (error) {
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
