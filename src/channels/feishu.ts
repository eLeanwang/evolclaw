import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import imageType from 'image-type';
import { ensureDir } from '../config.js';
import { logger } from '../utils/logger.js';
import { hasRichContent, renderAllRichContent } from '../utils/rich-content-renderer.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface MessageHandlerOptions {
  channelId: string;
  content: string;
  chatType: 'private' | 'group';
  images?: Array<{ data: string; mimeType: string }>;
  peerId?: string;
  peerName?: string;
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
  private cleanupInterval?: NodeJS.Timeout;
  private seenMessages = new Map<string, number>();  // messageId -> timestamp
  private seenThreads = new Set<string>();  // 已见的 thread_id，用于判断话题创建消息
  private userNameCache = new Map<string, string>();  // userId -> userName
  private recallHandler?: (messageId: string) => void;

  constructor(private config: FeishuConfig) {
  }

  /**
   * 预填充已知的 thread_id（重启后从数据库恢复，避免误判话题创建）
   */
  preloadThreads(threadIds: string[]): void {
    for (const id of threadIds) this.seenThreads.add(id);
    if (threadIds.length > 0) {
      logger.info(`[Feishu] Preloaded ${threadIds.length} known thread(s)`);
    }
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

          if (!this.messageHandler) return;

          // 提取 chatType（从 SDK 事件直接获取）
          const chatType: 'private' | 'group' = msg.chat_type === 'group' ? 'group' : 'private';

          // 话题消息检测日志
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
          const peerId = data.sender?.sender_id?.open_id;
          // 尝试从 mentions 中查找发送者名字（群聊中可能包含）
          let peerName: string | undefined;
          if (mentions.length > 0) {
            const senderMention = mentions.find((m: any) => m.userId === peerId);
            peerName = senderMention?.name;
          }

          // 如果 mentions 中没有，尝试调用 API 获取
          if (!peerName && peerId) {
            try {
              peerName = await this.getUserName(peerId);
            } catch (err) {
              logger.debug('[Feishu] getUserName error:', err);
            }
          }

          try {
            // 提取话题信息
            const threadId = msg.thread_id || undefined;
            const rootId = msg.root_id || undefined;

            // 处理引用消息（话题内后续消息跳过，避免每条都拼接引用前缀）
            let quotedText = '';
            let quotedImages: Array<{ data: string; mimeType: string }> = [];

            // 引用消息处理：
            // - 非话题：直接回复某条消息时，拉取被引用的消息内容
            // - 话题首条：创建话题时，拉取根消息内容作为上下文
            // - 话题后续：不拉取（上下文由 session 维护）
            const isThreadCreation = !!(msg.thread_id && msg.parent_id && !this.seenThreads.has(msg.thread_id));
            if (msg.thread_id) this.seenThreads.add(msg.thread_id);
            if (msg.parent_id && (!msg.thread_id || isThreadCreation) && this.client) {
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
              let content = (parsed.text_without_at_bot || parsed.text || '').trim();
              // 清理残留的 mention 占位符（@_user_N 代表机器人）
              content = content.replace(/@_user_\d+/g, '').trim();
              const finalContent = quotedText + content;
              await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, mentions: mentions.length > 0 ? mentions : undefined, threadId, rootId, chatType });
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
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: allImages, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              } else {
                const prompt = quotedText + '[图片下载失败] 应用可能缺少 im:message 或 im:message:readonly 权限';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
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
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              } else {
                const prompt = quotedText + '[文件下载失败] 应用可能缺少 im:resource 权限';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              }
            }
            // 处理富文本消息
            else if (msg.message_type === 'post') {
              const parsed = JSON.parse(msg.content);
              let text = '';
              const postImages: { data: string; mimeType: string }[] = [];
              const title = parsed.zh_cn?.title || parsed.en_us?.title || parsed.title;
              const content = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content;
              if (content) {
                const projectPath = this.projectPathProvider
                  ? await this.projectPathProvider(msg.chat_id)
                  : process.cwd();
                for (const line of content) {
                  for (const elem of line) {
                    if (elem.tag === 'img' && elem.image_key) {
                      const imageData = await this.downloadAndSaveImage(elem.image_key, msg.chat_id, msg.message_id, projectPath);
                      if (imageData) postImages.push(imageData);
                    } else if (elem.text) {
                      text += elem.text;
                    }
                  }
                  text += '\n';
                }
              }
              let finalContent = text.trim();
              if (title) finalContent = `${title}\n${finalContent}`;
              finalContent = quotedText + finalContent;
              const allImages = [...quotedImages, ...postImages];
              await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: allImages.length > 0 ? allImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
            }
            // 处理其他类型消息
            else {
              logger.debug('[Feishu] Unsupported message type:', msg.message_type);
              const prompt = quotedText + `[不支持的消息类型: ${msg.message_type}]`;
              await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
            }
          } catch (error) {
            logger.error('[Feishu] Failed to process message:', error);
          }
        },
        'im.message.recalled_v1': async (data: any) => {
          const messageId = data?.message_id;
          if (messageId) {
            logger.info('[Feishu] Message recalled:', messageId);
            this.recallHandler?.(messageId);
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

  onRecall(handler: (messageId: string) => void): void {
    this.recallHandler = handler;
  }

  onProjectPathRequest(provider: ProjectPathProvider): void {
    this.projectPathProvider = provider;
  }

  private async getUserName(userId?: string): Promise<string | undefined> {
    if (!userId || !this.client) return undefined;

    // 检查缓存
    if (this.userNameCache.has(userId)) {
      return this.userNameCache.get(userId);
    }

    try {
      const res = await this.client.contact.user.get({
        path: { user_id: userId },
        params: { user_id_type: 'open_id' }
      });

      const userName = res.data?.user?.name;
      if (userName) {
        this.userNameCache.set(userId, userName);
        return userName;
      }
    } catch (err: any) {
      logger.debug('[Feishu] Failed to get user name, code:', err?.code, 'msg:', err?.message);
    }

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
      // 检测富内容并渲染
      const richItems = hasRichContent(content) ? await renderAllRichContent(content) : [];

      // 上传所有图片获取 image_key，建立位置映射
      const richItemsWithKeys: Array<{ start: number; end: number; imageKey: string }> = [];
      for (const item of richItems) {
        try {
          const uploadResponse = await this.client.im.image.create({
            data: { image_type: 'message', image: Buffer.from(item.png) as any }
          });
          if (uploadResponse?.image_key) {
            richItemsWithKeys.push({ start: item.start, end: item.end, imageKey: uploadResponse.image_key });
            logger.debug(`[Feishu] Uploaded ${item.type} image, image_key:`, uploadResponse.image_key);
          }
        } catch (err) {
          logger.warn(`[Feishu] Failed to upload ${item.type} image:`, err);
        }
      }

      const useMarkdown = !options?.forceText && hasMarkdownSyntax(content);
      const hasMention = !!(options?.mentionUserIds && options.mentionUserIds.length > 0);
      const hasRichImages = richItemsWithKeys.length > 0;

      // 如果有富内容图片、Markdown 或 @，使用 post 格式
      const msgType = (useMarkdown || hasMention || hasRichImages) ? 'post' : 'text';

      let msgContent: string;
      if (msgType === 'post') {
        let postData: any;

        if (hasRichImages) {
          // 有富内容图片：按位置分段文本并插入图片
          postData = { zh_cn: { title: options?.title || '', content: [] } };
          const sorted = [...richItemsWithKeys].sort((a, b) => a.start - b.start);
          let lastEnd = 0;

          for (const item of sorted) {
            // 插入图片前的文本段
            if (item.start > lastEnd) {
              const textSegment = content.slice(lastEnd, item.start).trim();
              if (textSegment) {
                postData.zh_cn.content.push([{ tag: 'text', text: textSegment }]);
              }
            }
            // 插入图片
            postData.zh_cn.content.push([{ tag: 'img', image_key: item.imageKey }]);
            lastEnd = item.end;
          }

          // 插入最后一段文本
          if (lastEnd < content.length) {
            const textSegment = content.slice(lastEnd).trim();
            if (textSegment) {
              postData.zh_cn.content.push([{ tag: 'text', text: textSegment }]);
            }
          }
        } else {
          // 无富内容图片：使用原有逻辑
          postData = useMarkdown
            ? markdownToFeishuPost(content, options?.title)
            : { zh_cn: { title: options?.title || '', content: [[{ tag: 'text', text: content }]] } };
        }

        // 在第一行开头插入所有 @ 标签
        if (hasMention && postData.zh_cn.content.length > 0) {
          const atTags = options!.mentionUserIds!.map(uid => ({ tag: 'at', user_id: uid }));
          postData.zh_cn.content[0].unshift(...atTags);
        }

        msgContent = JSON.stringify(postData);
      } else {
        msgContent = JSON.stringify({ text: content });
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

      if (hasRichImages) {
        logger.info(`[Feishu] Sent message with ${richItemsWithKeys.length} embedded images`);
      } else {
        logger.debug(`[Feishu] Sent message as ${useMarkdown ? 'post (Markdown)' : 'text'}`);
      }
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

  async sendFile(chatId: string, filePath: string, options?: { replyToMessageId?: string; replyInThread?: boolean }): Promise<void> {
    if (!this.client) return;

    try {
      // 检测是否为图片，是则走 sendImage（内联预览）而非文件卡片
      const header = Buffer.alloc(12);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, header, 0, 12, 0);
      fs.closeSync(fd);
      const imgType = await imageType(header);
      if (imgType) {
        logger.info(`[Feishu] Detected image (${imgType.mime}), sending as inline image:`, filePath);
        const buf = fs.readFileSync(filePath);
        return this.sendImage(chatId, buf, options);
      }

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
      const msgContent = JSON.stringify({ file_key: fileKey });

      logger.info('[Feishu] File uploaded, file_key:', fileKey);

      if (options?.replyToMessageId) {
        const replyData: any = { msg_type: 'file', content: msgContent };
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
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: msgContent
          }
        });
      }

      logger.info('[Feishu] File message sent successfully');
    } catch (error: any) {
      // 230011: 消息已被撤回，降级为普通消息重试
      if (error.response?.data?.code === 230011 && options?.replyToMessageId) {
        logger.warn('[Feishu] Message withdrawn (230011), retrying file send without reply');
        return this.sendFile(chatId, filePath);
      }
      logger.error('[Feishu] Failed to send file:', error);
      throw error;
    }
  }

  async sendImage(chatId: string, png: Buffer, options?: { replyToMessageId?: string; replyInThread?: boolean }): Promise<void> {
    if (!this.client) return;

    try {
      const uploadResponse = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: Buffer.from(png) as any,
        }
      });

      const imageKey = uploadResponse?.image_key;
      if (!imageKey) {
        logger.error('[Feishu] Image upload failed: no image_key returned');
        return;
      }

      logger.debug('[Feishu] Image uploaded, image_key:', imageKey);

      const msgContent = JSON.stringify({ image_key: imageKey });

      if (options?.replyToMessageId) {
        const replyData: any = { msg_type: 'image', content: msgContent };
        if (options.replyInThread) replyData.reply_in_thread = true;
        await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: replyData
        });
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'image', content: msgContent }
        });
      }

      logger.debug('[Feishu] Image message sent successfully');
    } catch (error) {
      logger.error('[Feishu] Failed to send image:', error);
      throw error;
    }
  }

  private isDuplicate(msgId: string): boolean {
    return this.seenMessages.has(msgId);
  }

  private markSeen(msgId: string): void {
    this.seenMessages.set(msgId, Date.now());
  }

  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let cleaned = 0;
      for (const [id, ts] of this.seenMessages) {
        if (ts < cutoff) { this.seenMessages.delete(id); cleaned++; }
      }
      if (cleaned > 0) logger.info(`[Feishu] Cleaned ${cleaned} old message IDs`);
      // seenThreads 无时间戳，仅限容量（话题持久存在，不按时间清理）
      if (this.seenThreads.size > 1000) this.seenThreads.clear();
    }, 60 * 60 * 1000);
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

        const uploadsDir = path.join(projectPath, '.evolclaw', 'uploads');
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

  addAckReaction(messageId: string): void {
    if (!this.client) return;
    this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: 'CheckMark' }
      }
    }).catch(() => {});
  }
}

// ── Markdown 转换工具（合并自 markdown-to-feishu.ts）──

interface PostElement {
  tag: string;
  text?: string;
  user_id?: string;
  image_key?: string;
}

interface PostContent {
  zh_cn: {
    title: string;
    content: Array<Array<PostElement>>;
  };
}

function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF01 && code <= 0xFF60) ||
      (code >= 0x3000 && code <= 0x303F)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padToWidth(str: string, targetWidth: number): string {
  const current = displayWidth(str);
  const padding = Math.max(0, targetWidth - current);
  return str + ' '.repeat(padding);
}

function convertTablesToText(text: string): string {
  const tableRegex = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;
  return text.replace(tableRegex, (_match, headerLine: string, _sep: string, bodyBlock: string) => {
    const parseRow = (line: string) => line.split('|').slice(1, -1).map((c: string) => c.trim());
    const headers = parseRow(headerLine);
    const rows = bodyBlock.trim().split('\n').map(parseRow);
    const colWidths = headers.map((h, i) => {
      const cellWidths = rows.map(r => displayWidth(r[i] || ''));
      return Math.max(displayWidth(h), ...cellWidths);
    });
    const headerStr = headers.map((h, i) => padToWidth(h, colWidths[i])).join('  ');
    const sepStr = colWidths.map(w => '-'.repeat(w)).join('  ');
    const rowStrs = rows.map(r =>
      headers.map((_, i) => padToWidth(r[i] || '', colWidths[i])).join('  ')
    );
    return '```\n' + [headerStr, sepStr, ...rowStrs].join('\n') + '\n```';
  });
}

export function markdownToFeishuPost(markdown: string, defaultTitle?: string): PostContent {
  const match = markdown.match(/^# (.+)$/m);
  const title = match?.[1] ?? defaultTitle ?? '';
  let body = match ? markdown.replace(/^# .+\n?/, '') : markdown;
  body = convertTablesToText(body);
  return {
    zh_cn: {
      title,
      content: [[{ tag: 'md', text: body.trim() }]]
    }
  };
}

export function hasMarkdownSyntax(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m, /\*\*.*?\*\*/, /\*.*?\*/, /__.*?__/, /_.*?_/, /~~.*?~~/,
    /`.*?`/, /```[\s\S]*?```/, /\[.*?\]\(.*?\)/, /^[\s]*[-*+]\s/m,
    /^[\s]*\d+\.\s/m, /^\|.+\|$/m
  ];
  return markdownPatterns.some(pattern => pattern.test(text));
}

// Plugin implementation
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config } from '../types.js';

export class FeishuChannelPlugin implements ChannelPlugin {
  readonly name = 'feishu';

  isEnabled(config: Config): boolean {
    const feishuConfig = config.channels?.feishu;
    if (feishuConfig?.enabled === false) return false;
    return !!(feishuConfig?.appId && feishuConfig?.appSecret);
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const feishuConfig = config.channels?.feishu;
    if (!feishuConfig?.appId || !feishuConfig?.appSecret) {
      throw new Error('Feishu config missing');
    }

    const channel = new FeishuChannel({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });

    const adapter = {
      name: 'feishu' as const,
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
      systemPromptAppend: '[重要系统功能] 你可以通过飞书发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。示例：文件已准备好！[SEND_FILE:./report.txt] 路径支持相对路径（相对项目目录）或绝对路径。系统会自动上传并发送。',
      fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
      supportsImages: true,
      flushDelay: feishuConfig.flushDelay,
    };

    return {
      adapter,
      channel,
      policy,
      options,
      connect: () => channel.connect(),
      disconnect: () => channel.disconnect(),
      onProjectPathRequest: (channelId: string) =>
        Promise.resolve(config.projects?.defaultPath || process.cwd()),
    };
  }
}
