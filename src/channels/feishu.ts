import fs from 'fs';
import path from 'path';
import imageType from 'image-type';
import { sanitizeFileName, saveToUploads, validateImage } from '../utils/media-cache.js';
import { logger } from '../utils/logger.js';
import { hasRichContent, renderAllRichContent, checkDependencies } from '../utils/rich-content-renderer.js';
import type { InteractionRequest, InteractionResponse, ActionInteraction, ThoughtItem } from '../types.js';
import { formatItemsAsText } from '../core/message/items-formatter.js';


export interface FeishuConfig {
  appId: string;
  appSecret: string;
  enableRichContent?: boolean;  // 全局开关，默认 false
  seenMsgFile?: string;         // 跨重启消息去重文件路径（可选）
}

export interface MessageHandlerOptions {
  channelId: string;
  content: string;
  chatType?: 'private' | 'group';
  images?: Array<{ data: string; mimeType: string }>;
  peerId?: string;
  peerName?: string;
  messageId?: string;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  threadId?: string;
  rootId?: string;
  source?: 'user' | 'card-trigger';
}

export interface MessageHandler {
  (options: MessageHandlerOptions): Promise<void>;
}

export interface ProjectPathProvider {
  (channelId: string): Promise<string>;
}

export class FeishuChannel {
  private client: any = null;
  private wsClient: any = null;
  private messageHandler?: MessageHandler;
  private projectPathProvider?: ProjectPathProvider;
  private cleanupInterval?: NodeJS.Timeout;
  private seenMessages = new Map<string, number>();  // messageId -> timestamp
  private seenThreads = new Set<string>();  // 已见的 thread_id，用于判断话题创建消息
  private userNameCache = new Map<string, string>();  // userId -> userName
  private recallHandler?: (messageId: string) => void;
  private interactionCallback?: (response: InteractionResponse) => void;
  private connected = false;
  private enableRichContent: boolean;
  // chatId → 该会话内仍 pending 的交互卡片 messageId 集合，用于作废
  private pendingCardsByChat = new Map<string, Set<string>>();
  private pendingV2Messages = new Set<string>(); // messageIds of V2 (schema 2.0) cards
  readonly cardManager = new FeishuCardManager();

  constructor(private config: FeishuConfig) {
    this.enableRichContent = config.enableRichContent ?? false;  // 默认关闭
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

    // 加载持久化的已处理消息 ID，防止重启后 Feishu 重推同一条消息
    this.loadSeenMessages();

    const { requireOptional } = await import('../utils/npm-ops.js');
    const lark = await requireOptional<typeof import('@larksuiteoapi/node-sdk')>('@larksuiteoapi/node-sdk');

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

          // 丢弃飞书服务端积压超过 5 分钟才下发的消息：上游观察到 65 分钟级延迟下发的
          // 历史消息（含 /restart 这类破坏性命令），无差别接收会导致非预期重启。
          // create_time 是 ms 字符串。
          {
            const createTimeMs = Number(msg.create_time ?? 0);
            const ageMs = Date.now() - createTimeMs;
            const STALE_THRESHOLD_MS = 5 * 60 * 1000;
            if (createTimeMs > 0 && ageMs > STALE_THRESHOLD_MS) {
              logger.warn(`[Feishu] Dropping stale message: id=${msg.message_id} type=${msg.message_type} age=${Math.round(ageMs / 1000)}s create_time=${createTimeMs}`);
              return;
            }
          }

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
                  quotedText = `> 以下是引用的原消息\n> ================\n> ${parsed.text}\n> ================\n\n`;
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
                  quotedText = `> 以下是引用的原消息\n> ================\n> ${text.trim()}\n> ================\n\n`;
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
                    quotedText = `> 以下是引用的原消息\n> ================\n> [引用的图片]\n> ================\n\n`;
                  } else {
                    quotedText = `> 以下是引用的原消息\n> ================\n> [图片消息]\n> ================\n\n`;
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
                    quotedText = `> 以下是引用的原消息\n> ================\n> [引用的文件：${quotedFileName}]\n> 文件已保存到：${quotedFilePath}\n> ================\n\n`;
                  } else {
                    quotedText = `> 以下是引用的原消息\n> ================\n> [文件消息]\n> ================\n\n`;
                  }
                } else if (quotedMsgType === 'merge_forward') {
                  const { text: mergedText, images: mergedImages } = await this.extractMergeForwardContent(msg.parent_id, msg.chat_id);
                  if (mergedText) {
                    quotedText = `> 以下是引用的原消息\n> ================\n> [合并转发消息]\n> ================\n\n${mergedText}\n\n`;
                    quotedImages.push(...mergedImages);
                  } else {
                    quotedText = `> 以下是引用的原消息\n> ================\n> [合并转发消息]\n> ================\n\n`;
                  }
                } else {
                  quotedText = `> 以下是引用的原消息\n> ================\n> [${quotedMsgType}消息]\n> ================\n\n`;
                }
              } catch (err) {
                logger.warn({ err }, '[Feishu] Failed to fetch quoted message');
              }
            }

            logger.info(`[Feishu] Incoming message_type=${msg.message_type} content=${msg.content?.substring(0, 200)}`);

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
                const prompt = quotedText + '用户发送了一张图片，请结合上下文理解用户意图并回应。';
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
            // 处理合并转发消息
            else if (msg.message_type === 'merge_forward') {
              const { text: mergedText, images: mergedImages } = await this.extractMergeForwardContent(msg.message_id, msg.chat_id);
              if (mergedText) {
                const finalContent = quotedText + mergedText;
                const allImages = [...quotedImages, ...mergedImages];
                await this.messageHandler({ channelId: msg.chat_id, content: finalContent, images: allImages.length > 0 ? allImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              } else {
                const prompt = quotedText + '[合并转发消息解析失败]';
                await this.messageHandler({ channelId: msg.chat_id, content: prompt, images: quotedImages.length > 0 ? quotedImages : undefined, peerId, peerName, messageId: msg.message_id, threadId, rootId, chatType });
              }
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
        'im.message.reaction.created_v1': async () => {},
        'card.action.trigger': async (data: any) => {
          try {
            const action = data?.action;
            if (!action?.value) return;

            const value = action.value;
            const operatorId = data.operator?.open_id;
            const chatId = data.context?.open_chat_id || data.open_chat_id;
            const cardMessageId = data.open_message_id || data.context?.open_message_id;

            // ── CommandCard 分支：按钮直接触发命令 ──
            if (value._command) {
              if (value._initiator && operatorId && operatorId !== value._initiator) {
                return {
                  toast: { type: 'warning', content: '⚠️ 仅卡片发起者可操作' },
                };
              }

              logger.info(`[Feishu] CommandCard trigger: command=${value._command}, operator=${operatorId}`);
              if (this.messageHandler) {
                // 卡片回调不传 chatType——oc_ 前缀不区分群聊/单聊，
                // 由 ensureSession 从已有 session 中继承正确的 chatType
                await this.messageHandler({
                  channelId: chatId,
                  content: value._command,
                  peerId: operatorId,
                  messageId: `card-trigger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  source: 'card-trigger',
                });
              }

              // 点击后从作废集合移除——已 resolved 的卡片不再被新卡片到来时 PATCH
              if (chatId && cardMessageId) this.untrackPendingCard(chatId, cardMessageId);

              const cardTitle = value._card_title || '操作';
              const btnLabel = value._btn_label || value._command;
              const cardBody = value._card_body || '';
              return this.buildResolvedCard(cardTitle, { type: 'interaction.response', id: '', action: value._command, operatorId }, cardBody, btnLabel);
            }

            // ── ActionInteraction 分支 ──
            const requestId = value._request_id;
            if (!requestId) {
              logger.debug('[Feishu] Card action without _request_id or _command, ignoring');
              return;
            }

            // initiator 校验
            if (value._initiator && operatorId && operatorId !== value._initiator) {
              return {
                toast: { type: 'warning', content: '⚠️ 仅卡片发起者可操作' },
              };
            }

            // Legacy field change (non-form select_static with _field_key): ignore silently
            if (value._field_key) {
              logger.debug(`[Feishu] Legacy field change: requestId=${requestId}, field=${value._field_key}`);
              return;
            }

            // _show_input：点击「手动输入」后，整卡替换为内联输入框的版本。
            // 飞书规定：用户点击交互期间无法对该卡片做流式更新（append/patch），
            // 即使 API 返回 code=0，回调结束后客户端也会复原（错误码 200810，
            // 对应 FAQ「为什么进行卡片更新时，更新成功后立即复原?」）。
            // 唯一可靠方式是把更新后的整卡作为本次点击回调的返回值下发。
            if (value._action === '_show_input') {
              const meta = this.cardManager.getEntryMeta(requestId);
              if (meta?.action) {
                const rebuilt = buildActionCardV2(requestId, meta.action, meta.initiatorId, { showInput: true });
                this.cardManager.markInputShown(requestId);
                return {
                  toast: { type: 'info', content: '请在下方输入' },
                  card: { type: 'raw', data: rebuilt },
                };
              }
              logger.warn(`[Feishu] _show_input: no entry meta for requestId=${requestId}`);
              return { toast: { type: 'warning', content: '⚠️ 卡片已失效，请重新发起' } };
            }

            // Form submit: `action.form_value` contains all field values from form container
            const formValues = action.form_value || {};

            const response: InteractionResponse = {
              type: 'interaction.response',
              id: requestId,
              action: value._action || 'submit',
              values: { ...formValues, ...value },
              operatorId,
            };

            // Remove internal fields from values
            delete response.values!._request_id;
            delete response.values!._action;
            delete response.values!._initiator;
            delete response.values!._card_title;
            let cardBody = value._card_body || '';
            delete response.values!._card_body;
            const btnLabel = value._btn_label || '';
            delete response.values!._btn_label;
            const checkersRaw = value._checkers || '';
            delete response.values!._checkers;

            // _custom_input: append user's typed text to card body
            if (response.action === '_custom_input' && formValues.custom_text) {
              cardBody = [cardBody, `**输入内容：** ${formValues.custom_text}`].filter(Boolean).join('\n\n');
            }

            logger.info(`[Feishu] Card action: requestId=${requestId}, action=${response.action}, values=${JSON.stringify(response.values)}`);
            this.interactionCallback?.(response);

            // 点击后从作废集合移除——已 resolved 的卡片不再被新卡片到来时 PATCH
            if (chatId && cardMessageId) this.untrackPendingCard(chatId, cardMessageId);

            // Return updated card (buttons disabled + result shown)
            // V2 entity cards (checkers/allowCustomInput) MUST respond with schema 2.0 — error 200830 otherwise
            const cardTitle = value._card_title || '操作';
            const isV2Card = !!this.cardManager.getCardId(requestId);
            return this.buildResolvedCard(cardTitle, response, cardBody, btnLabel, isV2Card, checkersRaw, formValues);
          } catch (err) {
            logger.error('[Feishu] Failed to handle card action:', err);
          }
        },
      });

      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });

      await this.wsClient.start({ eventDispatcher });
      this.connected = true;
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

  onInteraction(callback: (response: InteractionResponse) => void): void {
    this.interactionCallback = callback;
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

    // 飞书消息内容限制约 30KB（text）/ 150KB（post），安全阈值 28000 字符
    // 超长消息自动拆分，按段落边界分割
    const MAX_CONTENT_LENGTH = 28000;
    if (content.length > MAX_CONTENT_LENGTH) {
      logger.info(`[Feishu] Message too long (${content.length} chars), splitting into parts`);
      const parts = splitLongMessage(content, MAX_CONTENT_LENGTH);
      for (let i = 0; i < parts.length; i++) {
        // 首条消息保留 reply 选项，后续消息不再 reply
        const partOptions = i === 0 ? options : { ...options, replyToMessageId: undefined };
        await this.sendMessage(chatId, parts[i], partOptions);
      }
      return;
    }

    logger.debug(`[Feishu] sendMessage called, chatId: ${chatId}, content length: ${content.length}`);

    try {
      // 检测富内容并渲染（受 enableRichContent 开关控制，且依赖必须可用）
      const richItems = (this.enableRichContent && checkDependencies() && hasRichContent(content))
        ? await renderAllRichContent(content)
        : [];

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

      // 消息类型决策：有 Markdown / @ / 富内容图片 → post，否则 text
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
          params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : chatId.startsWith('on_') ? 'union_id' : 'chat_id' },
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
      // 99992354: message_id 不存在（合成 ID 或已过期），降级为普通消息
      const errCode = error.response?.data?.code;
      if ((errCode === 230011 || errCode === 99992354) && options?.replyToMessageId) {
        logger.warn(`[Feishu] Reply target invalid (${errCode}), retrying without reply`);
        return this.sendMessage(chatId, content, { ...options, replyToMessageId: undefined });
      }
      // 230025: 消息内容超长，截断后重试
      if (errCode === 230025) {
        logger.warn(`[Feishu] Message too long (230025, ${content.length} chars), truncating`);
        const truncated = content.slice(0, 28000) + '\n\n⚠️ 消息过长，已截断';
        return this.sendMessage(chatId, truncated, options);
      }
      const respData = error?.response?.data;
      logger.error('[Feishu] Failed to send message:', respData ? JSON.stringify(respData) : error?.message ?? error);
      // post 格式相关错误（400/230001）：降级为纯文本重试
      if (!options?.forceText && (error?.response?.status === 400 || errCode === 230001)) {
        logger.warn('[Feishu] Retrying as plain text (forceText)');
        return this.sendMessage(chatId, content, { ...options, forceText: true });
      }
      throw error;
    }
  }

  async sendFile(chatId: string, filePath: string, options?: { replyToMessageId?: string; replyInThread?: boolean }): Promise<void> {
    if (!this.client) return;

    try {
      // 检测是否为图片，是则走 sendImage（内联预览）而非文件卡片
      // 读取足够字节供 file-type 解析（ZIP-based 格式如 PPTX 需要更多字节）
      const header = Buffer.alloc(4100);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, header, 0, 4100, 0);
      fs.closeSync(fd);
      const imgType = await imageType(header.subarray(0, bytesRead)).catch(() => undefined);
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
          params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : chatId.startsWith('on_') ? 'union_id' : 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: msgContent
          }
        });
      }

      logger.info('[Feishu] File message sent successfully');
    } catch (error: any) {
      // 230011/99992354: reply target invalid, retry without reply
      const errCode = error.response?.data?.code;
      if ((errCode === 230011 || errCode === 99992354) && options?.replyToMessageId) {
        logger.warn(`[Feishu] Reply target invalid (${errCode}), retrying file send without reply`);
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
          params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : chatId.startsWith('on_') ? 'union_id' : 'chat_id' },
          data: { receive_id: chatId, msg_type: 'image', content: msgContent }
        });
      }

      logger.debug('[Feishu] Image message sent successfully');
    } catch (error: any) {
      // 99992354: reply target invalid — image cannot easily retry, just log
      logger.error('[Feishu] Failed to send image:', error);
      throw error;
    }
  }

  private isDuplicate(msgId: string): boolean {
    return this.seenMessages.has(msgId);
  }

  private markSeen(msgId: string): void {
    const now = Date.now();
    this.seenMessages.set(msgId, now);
    // 持久化到文件，供重启后去重
    if (this.config.seenMsgFile) {
      try {
        fs.appendFileSync(this.config.seenMsgFile, JSON.stringify({ id: msgId, ts: now }) + '\n');
      } catch {}
    }
  }

  private loadSeenMessages(): void {
    if (!this.config.seenMsgFile) return;
    try {
      if (!fs.existsSync(this.config.seenMsgFile)) return;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const lines = fs.readFileSync(this.config.seenMsgFile, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const { id, ts } = JSON.parse(line);
          if (ts > cutoff) this.seenMessages.set(id, ts);
        } catch {}
      }
      logger.info(`[Feishu] Loaded ${this.seenMessages.size} seen message ID(s) from disk`);
    } catch {}
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
      // 重写文件，去掉过期条目
      if (this.config.seenMsgFile && this.seenMessages.size > 0) {
        try {
          const lines = [...this.seenMessages.entries()]
            .map(([id, ts]) => JSON.stringify({ id, ts }))
            .join('\n') + '\n';
          fs.writeFileSync(this.config.seenMsgFile, lines);
        } catch {}
      }
    }, 60 * 60 * 1000);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
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

  /** Get current connection status */
  getStatus(): { connected: boolean } {
    return { connected: this.connected };
  }

  /** Reconnect: disconnect then connect again */
  async reconnect(): Promise<string> {
    if (this.connected) {
      await this.disconnect();
    }
    try {
      await this.connect();
      return '重连成功';
    } catch (err) {
      return `重连失败: ${err instanceof Error ? err.message : String(err)}`;
    }
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

        // 统一图片验证（类型白名单 + 大小限制）
        const result = await validateImage(buffer);
        if (result.mime === null) {
          logger.warn(`[Feishu] Image validation failed: ${result.reason}`);
          return null;
        }

        const base64Data = buffer.toString('base64');
        logger.debug('[Feishu] Image downloaded successfully, type:', result.mime, 'size:', base64Data.length);

        return {
          data: base64Data,
          mimeType: result.mime
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

  /**
   * 提取合并转发消息的子消息内容。
   * 调用 im.message.get 获取子消息列表，逐条解析 text/image/post/file 类型。
   */
  private async extractMergeForwardContent(
    messageId: string,
    chatId: string
  ): Promise<{ text: string; images: Array<{ data: string; mimeType: string }> }> {
    const empty = { text: '', images: [] as Array<{ data: string; mimeType: string }> };
    if (!this.client) return empty;

    try {
      const res = await this.client.im.message.get({
        path: { message_id: messageId }
      });

      const items = res.data?.items;
      if (!items || items.length === 0) {
        logger.warn('[Feishu] merge_forward: no sub-messages found');
        return empty;
      }

      logger.info(`[Feishu] merge_forward: ${items.length} sub-messages`);

      const projectPath = this.projectPathProvider
        ? await this.projectPathProvider(chatId)
        : process.cwd();

      const textParts: string[] = [];
      const images: Array<{ data: string; mimeType: string }> = [];
      const MAX_IMAGES = 10;

      textParts.push('以下是用户转发的合并消息：\n---');

      for (const item of items) {
        const msgType = item.msg_type;
        const content = item.body?.content;
        if (!content) continue;

        try {
          if (msgType === 'text') {
            const parsed = JSON.parse(content);
            textParts.push(parsed.text || '');
          } else if (msgType === 'post') {
            const parsed = JSON.parse(content);
            let text = '';
            const postContent = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content;
            if (postContent) {
              for (const line of postContent) {
                for (const elem of line) {
                  if (elem.tag === 'img' && elem.image_key && item.message_id && images.length < MAX_IMAGES) {
                    const imageData = await this.downloadAndSaveImage(elem.image_key, chatId, item.message_id, projectPath);
                    if (imageData) images.push(imageData);
                  } else if (elem.text) {
                    text += elem.text;
                  }
                }
                text += '\n';
              }
            }
            const title = parsed.zh_cn?.title || parsed.en_us?.title || parsed.title;
            textParts.push(title ? `${title}\n${text.trim()}` : text.trim());
          } else if (msgType === 'image' && item.message_id) {
            const parsed = JSON.parse(content);
            if (parsed.image_key && images.length < MAX_IMAGES) {
              const imageData = await this.downloadAndSaveImage(parsed.image_key, chatId, item.message_id, projectPath);
              if (imageData) {
                images.push(imageData);
                textParts.push('[图片]');
              }
            }
          } else if (msgType === 'file') {
            const parsed = JSON.parse(content);
            textParts.push(`[文件: ${parsed.file_name || 'unknown'}]`);
          } else {
            textParts.push(`[${msgType}]`);
          }
        } catch (parseErr) {
          logger.debug('[Feishu] merge_forward: failed to parse sub-message:', parseErr);
          textParts.push(`[${msgType}: 解析失败]`);
        }
      }

      textParts.push('---');
      return { text: textParts.join('\n'), images };
    } catch (error) {
      logger.error('[Feishu] Failed to extract merge_forward content:', error);
      return empty;
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

        const { filePath } = saveToUploads(buffer, sanitizeFileName(fileName), projectPath);
        return filePath;
      }

      logger.error('[Feishu] File download failed: no valid method');
      return null;
    } catch (error) {
      logger.error('[Feishu] Failed to download file:', error);
      return null;
    }
  }

  /** 跟踪 pending 交互卡片，等待后续作废 */
  private trackPendingCard(chatId: string, messageId: string, isV2?: boolean): void {
    let set = this.pendingCardsByChat.get(chatId);
    if (!set) {
      set = new Set();
      this.pendingCardsByChat.set(chatId, set);
    }
    set.add(messageId);
    if (isV2) this.pendingV2Messages.add(messageId);
  }

  /** 卡片已 resolved（用户点击了按钮，飞书已用回调返回值替换卡片），从作废集合移除 */
  private untrackPendingCard(chatId: string, messageId: string): void {
    const set = this.pendingCardsByChat.get(chatId);
    if (!set) return;
    set.delete(messageId);
    this.pendingV2Messages.delete(messageId);
    if (set.size === 0) this.pendingCardsByChat.delete(chatId);
  }

  /**
   * 作废 chatId 下所有未被点击的旧卡片：PATCH 为"已过期"灰色卡片。
   * 卡片需在 config 中声明 update_multi: true 才能被 PATCH。
   */
  private async invalidatePendingCards(chatId: string): Promise<void> {
    const set = this.pendingCardsByChat.get(chatId);
    if (!set || set.size === 0) return;
    const expiredCardV1 = {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '已过期' },
      },
      elements: [{ tag: 'markdown', content: '此卡片已过期，请查看最新卡片。' }],
    };
    // V2 (schema 2.0) cards can only be updated with 2.0 content — 1.0 patch is rejected (200830)
    const expiredCardV2 = {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '已过期' },
      },
      body: { elements: [{ tag: 'markdown', content: '此卡片已过期，请查看最新卡片。' }] },
    };
    const ids = Array.from(set);
    this.pendingCardsByChat.delete(chatId);
    await Promise.all(ids.map(async msgId => {
      const isV2 = this.pendingV2Messages.has(msgId);
      this.pendingV2Messages.delete(msgId);
      try {
        await this.client.im.message.patch({
          path: { message_id: msgId },
          data: { content: JSON.stringify(isV2 ? expiredCardV2 : expiredCardV1) },
        });
      } catch (err: any) {
        const detail = err?.response?.data ?? err?.message ?? err;
        logger.debug(`[Feishu] Patch expired card failed (msgId=${msgId}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      }
    }));
  }

  async sendInteraction(
    chatId: string,
    interaction: InteractionRequest,
    options?: { replyToMessageId?: string; replyInThread?: boolean }
  ): Promise<string | false> {
    if (!this.client) return false;

    // V2 路径：checkers 或 allowCustomInput → CardKit 实体发送
    if (interaction.kind.kind === 'action' && needsCardKitV2(interaction.kind)) {
      const cardJson = buildActionCardV2(interaction.id, interaction.kind, interaction.initiatorId);
      await this.invalidatePendingCards(chatId);
      const result = await this.cardManager.createAndSend(
        this.client, chatId, cardJson, interaction.id, options,
        { action: interaction.kind, initiatorId: interaction.initiatorId },
      );
      if (result) {
        logger.info(`[Feishu] Sent V2 interaction card: ${interaction.id}, cardId=${result.cardId}, messageId=${result.messageId}`);
        this.trackPendingCard(chatId, result.messageId, true);
        return result.messageId;
      }
      return false;
    }

    // V1 路径：现有逻辑
    const card = buildInteractionCard(interaction);
    if (!card) return false;

    await this.invalidatePendingCards(chatId);

    try {
      let messageId: string | undefined;
      if (options?.replyToMessageId) {
        const replyData: any = {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        };
        if (options.replyInThread) replyData.reply_in_thread = true;
        const res = await this.client.im.message.reply({
          path: { message_id: options.replyToMessageId },
          data: replyData,
        });
        messageId = (res as any)?.data?.message_id;
      } else {
        const res = await this.client.im.message.create({
          params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : chatId.startsWith('on_') ? 'union_id' : 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        });
        messageId = (res as any)?.data?.message_id;
      }
      logger.info(`[Feishu] Sent interaction card: ${interaction.id}, messageId=${messageId}`);
      if (messageId) this.trackPendingCard(chatId, messageId);
      return messageId || false;
    } catch (error: any) {
      const respData = error?.response?.data;
      const detail = respData
        ? JSON.stringify(respData)
        : error?.message && error.message !== String(error)
          ? error.message
          : JSON.stringify(error, Object.getOwnPropertyNames(error));
      logger.error(`[Feishu] Failed to send interaction card (id=${interaction.id}, replyTo=${options?.replyToMessageId || 'none'}): ${detail}`);
      logger.debug(`[Feishu] Card payload for ${interaction.id}: ${JSON.stringify(buildInteractionCard(interaction))}`);
      return false;
    }
  }

  private buildResolvedCard(cardTitle: string, response: InteractionResponse, cardBody?: string, btnLabel?: string, isV2?: boolean, checkersRaw?: string, formValues?: Record<string, any>): object | undefined {
    const action = response.action;

    const labelMap: Record<string, string> = {
      'allow': '✅ 已允许',
      'always': '🔓 已设为始终允许',
      'deny': '❌ 已拒绝',
      'cancel': '取消',
    };
    const rawLabel = btnLabel || action;
    const statusText = labelMap[action] || (/^\p{Emoji}/u.test(rawLabel) ? rawLabel : `✅ ${rawLabel}`);

    const headerTemplate = action === 'deny' ? 'red' : 'green';
    const headerTitle = `${cardTitle} — ${statusText}`;

    // Build checkers summary if present
    let checkersSummary = '';
    if (checkersRaw && formValues) {
      try {
        const labels: string[] = JSON.parse(checkersRaw);
        const lines = labels.map((label, idx) => {
          const checked = !!formValues[`opt_${idx}`];
          return `${checked ? '☑' : '☐'} ${label}`;
        });
        checkersSummary = lines.join('\n');
      } catch { /* ignore */ }
    }

    // V2 (schema 2.0) cards MUST respond with 2.0 structure — error 200830 otherwise
    if (isV2) {
      const bodyElements: any[] = [];
      if (cardBody) {
        bodyElements.push({ tag: 'markdown', content: cardBody });
      }
      if (checkersSummary) {
        bodyElements.push({ tag: 'markdown', content: checkersSummary });
      }
      return {
        toast: { type: 'success', content: statusText },
        card: {
          type: 'raw',
          data: {
            schema: '2.0',
            config: { update_multi: true, streaming_mode: false },
            header: {
              template: headerTemplate,
              title: { tag: 'plain_text', content: headerTitle },
            },
            body: { elements: bodyElements },
          },
        },
      };
    }

    // V1 (schema 1.0) cards
    const elements: any[] = [];
    if (cardBody) {
      elements.push({ tag: 'markdown', content: cardBody });
    }

    return {
      toast: {
        type: 'success',
        content: statusText,
      },
      card: {
        type: 'raw',
        data: {
          config: { wide_screen_mode: true, update_multi: true },
          header: {
            template: headerTemplate,
            title: { tag: 'plain_text', content: headerTitle },
          },
          elements,
        },
      },
    };
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

// ── CardKit 2.0 实体管理 ──

interface CardEntry {
  cardId: string;
  messageId: string;
  requestId: string;
  sequence: number;
  /** 自定义输入区是否已展开，用于「手动输入」幂等 */
  inputShown?: boolean;
  /** 原始 action + 发起者，供「手动输入」点击时重建带输入框的整卡作为回调返回值 */
  action?: ActionInteraction;
  initiatorId?: string;
}

export class FeishuCardManager {
  private cards = new Map<string, CardEntry>();

  async createAndSend(
    client: any,
    chatId: string,
    cardJson: object,
    requestId: string,
    replyOpts?: { replyToMessageId?: string; replyInThread?: boolean },
    meta?: { action?: ActionInteraction; initiatorId?: string },
  ): Promise<{ cardId: string; messageId: string } | null> {
    try {
      const createRes = await client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardJson) },
      });
      const cardId = (createRes as any)?.data?.card_id;
      if (!cardId) {
        logger.error(`[FeishuCardManager] card.create returned no card_id. code=${(createRes as any)?.code} msg=${(createRes as any)?.msg} resp=${JSON.stringify(createRes)}`);
        return null;
      }

      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let messageId: string | undefined;

      if (replyOpts?.replyToMessageId) {
        const replyData: any = { msg_type: 'interactive', content };
        if (replyOpts.replyInThread) replyData.reply_in_thread = true;
        const res = await client.im.message.reply({
          path: { message_id: replyOpts.replyToMessageId },
          data: replyData,
        });
        messageId = (res as any)?.data?.message_id;
      } else {
        const idType = chatId.startsWith('ou_') ? 'open_id' : chatId.startsWith('on_') ? 'union_id' : 'chat_id';
        const res = await client.im.message.create({
          params: { receive_id_type: idType },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
        messageId = (res as any)?.data?.message_id;
      }

      if (!messageId) {
        logger.error('[FeishuCardManager] message send returned no message_id');
        return null;
      }

      this.cards.set(requestId, { cardId, messageId, requestId, sequence: 0, action: meta?.action, initiatorId: meta?.initiatorId });
      return { cardId, messageId };
    } catch (err: any) {
      logger.error('[FeishuCardManager] createAndSend failed:', err?.message || err);
      return null;
    }
  }

  async appendElement(
    client: any,
    requestId: string,
    elements: object[],
    targetElementId?: string,
  ): Promise<boolean> {
    const entry = this.cards.get(requestId);
    if (!entry) {
      logger.warn(`[FeishuCardManager] appendElement: no card for requestId=${requestId}`);
      return false;
    }
    try {
      entry.sequence++;
      // SDK 路径是 cardkit.v1.cardElement.create（不是 card.element.create）—
      // 后者 card.element 为 undefined，会抛 "Cannot read properties of undefined (reading 'create')"
      const res = await client.cardkit.v1.cardElement.create({
        path: { card_id: entry.cardId },
        data: {
          type: 'append',
          target_element_id: targetElementId,
          elements: JSON.stringify(elements),
          sequence: entry.sequence,
        },
      });
      // 飞书 node-sdk 对业务错误码（非零 code）默认不抛异常，必须显式检查
      const code = (res as any)?.code;
      if (code !== undefined && code !== 0) {
        logger.error(`[FeishuCardManager] appendElement rejected (cardId=${entry.cardId}, seq=${entry.sequence}): code=${code} msg=${(res as any)?.msg} resp=${JSON.stringify(res)}`);
        return false;
      }
      logger.info(`[FeishuCardManager] appendElement ok (cardId=${entry.cardId}, seq=${entry.sequence}, target=${targetElementId})`);
      return true;
    } catch (err: any) {
      logger.error(`[FeishuCardManager] appendElement failed (cardId=${entry.cardId}):`, err?.message || err);
      return false;
    }
  }

  getCardId(requestId: string): string | undefined {
    return this.cards.get(requestId)?.cardId;
  }

  /** 自定义输入区是否已展开（幂等保护，防止重复点击「手动输入」） */
  isInputShown(requestId: string): boolean {
    return !!this.cards.get(requestId)?.inputShown;
  }

  /** 标记自定义输入区已展开 */
  markInputShown(requestId: string): void {
    const entry = this.cards.get(requestId);
    if (entry) entry.inputShown = true;
  }

  /** 取出原始 action + 发起者，供「手动输入」点击时重建整卡 */
  getEntryMeta(requestId: string): { action?: ActionInteraction; initiatorId?: string } | undefined {
    const entry = this.cards.get(requestId);
    if (!entry) return undefined;
    return { action: entry.action, initiatorId: entry.initiatorId };
  }

  cleanup(requestId: string): void {
    this.cards.delete(requestId);
  }
}

// ── 交互卡片构建工具 ──

export function buildInteractionCard(interaction: InteractionRequest): object | null {
  const { kind } = interaction;

  if (kind.kind === 'command-card') {
    return buildCommandCardFeishu(kind, interaction.initiatorId);
  }
  if (kind.kind === 'action') {
    if (needsCardKitV2(kind)) return null; // V2 卡片走 CardKit 实体路径，不返回内联 JSON
    return buildActionCard(interaction.id, kind, interaction.initiatorId);
  }
  return null;
}

/** 判断 ActionInteraction 是否需要走 CardKit 2.0 实体路径 */
export function needsCardKitV2(action: ActionInteraction): boolean {
  return !!(action.checkers?.length || action.allowCustomInput);
}

function buildCommandCardFeishu(card: import('../types.js').CommandCard, initiatorId?: string): object {
  const elements: any[] = [];

  if (card.body) {
    elements.push({ tag: 'markdown', content: card.body });
  }

  // Build full card body for resolved state: original body + button labels
  const btnLabels = card.buttons.map(btn => btn.label).join('  ·  ');
  const fullCardBody = [card.body, btnLabels].filter(Boolean).join('\n\n');

  const buttons = card.buttons.map(btn => {
    const buttonEl: any = {
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : 'default',
      value: {
        _command: btn.command,
        _initiator: initiatorId,
        _card_title: card.title,
        _card_body: fullCardBody,
        _btn_label: btn.label,
      },
    };

    if (btn.disabled) {
      buttonEl.disabled = true;
    }

    if (btn.confirm) {
      buttonEl.confirm = {
        title: { tag: 'plain_text', content: btn.confirm.title },
        text: { tag: 'plain_text', content: btn.confirm.body },
      };
    }

    return buttonEl;
  });

  elements.push({ tag: 'action', actions: buttons });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: card.title },
    },
    elements,
  };
}

export function buildActionCard(requestId: string, action: ActionInteraction, initiatorId?: string): object {
  const elements: any[] = [];

  // Body text
  if (action.body) {
    elements.push({ tag: 'markdown', content: action.body });
  }

  // Build full card body for resolved state: original body + button labels
  const btnLabels = action.buttons.map(btn => btn.label).join('  ·  ');
  const fullCardBody = [action.body, btnLabels].filter(Boolean).join('\n\n');

  // Buttons row
  const buttons = action.buttons.map(btn => {
    const buttonEl: any = {
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : 'default',
      value: {
        _request_id: requestId,
        _action: btn.key,
        _initiator: initiatorId,
        _card_title: action.title,
        _card_body: fullCardBody,
        _btn_label: btn.label,
      },
    };

    if (btn.confirm) {
      buttonEl.confirm = {
        title: { tag: 'plain_text', content: btn.confirm.title },
        text: { tag: 'plain_text', content: btn.confirm.body },
      };
    }

    return buttonEl;
  });

  elements.push({
    tag: 'action',
    actions: buttons,
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: action.title },
    },
    elements,
  };
}

/**
 * 构建 JSON 2.0 form 卡片（用于 checkers 多选 / allowCustomInput 场景）
 * 通过 CardKit 实体 API 发送。
 * @param opts.showInput 为 true 时，自定义输入框 + 提交按钮直接内联进 form，并隐藏「手动输入」按钮。
 *   用于点击「手动输入」后，作为回调返回值整卡替换（避免交互期间并发更新被飞书复原，错误码 200810）。
 */
export function buildActionCardV2(
  requestId: string,
  action: ActionInteraction,
  initiatorId?: string,
  opts?: { showInput?: boolean },
): object {
  const formElements: any[] = [];

  if (action.body) {
    formElements.push({ tag: 'markdown', content: action.body, element_id: 'body_md' });
  }

  if (action.checkers?.length) {
    action.checkers.forEach((chk, idx) => {
      const text = chk.description ? `${chk.label} — ${chk.description}` : chk.label;
      formElements.push({
        tag: 'checker',
        name: `opt_${idx}`,
        checked: false,
        text: { tag: 'plain_text', content: text },
        element_id: `chk_${idx}`,
      });
    });
    formElements.push({ tag: 'hr', element_id: 'hr_btns' });
  }

  const btnLabels = action.buttons.map(btn => btn.label).join('  ·  ');
  const fullCardBody = [action.body, btnLabels].filter(Boolean).join('\n\n');

  action.buttons.forEach((btn, idx) => {
    // element_id/name 必须满足飞书规则：字母开头、仅字母数字下划线、≤20 字符。
    // btn.key 可能是选项 label（中文/空格/连字符/超长），不能直接拼进 element_id，
    // 否则触发飞书 300301。真实 key 通过 value._action 回传，路由不依赖 element_id。
    formElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.style === 'danger' ? 'danger' : btn.style === 'primary' ? 'primary' : 'default',
      action_type: 'form_submit',
      name: `btn_${idx}`,
      element_id: `btn_${idx}`,
      value: {
        _request_id: requestId,
        _action: btn.key,
        _initiator: initiatorId,
        _card_title: action.title,
        _card_body: fullCardBody,
        _btn_label: btn.label,
        ...(action.checkers?.length ? { _checkers: JSON.stringify(action.checkers.map(c => c.label)) } : {}),
      },
    });
  });

  const outerElements: any[] = [];
  if (action.allowCustomInput && opts?.showInput) {
    // 展开态：输入框 + 提交按钮内联进 form。整卡作为点击回调返回值替换，
    // 不走并发 append，因此不触发 200810「交互期间无法更新」与随后的客户端复原。
    formElements.push(...buildCustomInputElements(requestId, initiatorId, action.title, fullCardBody));
  } else if (action.allowCustomInput) {
    // 初始态：「手动输入」按钮放在 form 容器**外**。
    // form 内按钮只接受 action_type=form_submit（11310），会提交并收起表单；
    // form 外按钮不带 action_type 时为 callback 行为，仅触发 _show_input 回调。
    outerElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✏️ 手动输入' },
      type: 'default',
      element_id: 'btn_show_input',
      value: {
        _request_id: requestId,
        _action: '_show_input',
        _initiator: initiatorId,
        _card_title: action.title,
        _card_body: fullCardBody,
        _btn_label: '手动输入',
      },
    });
  }

  return {
    schema: '2.0',
    config: { update_multi: true, streaming_mode: false },
    header: { title: { tag: 'plain_text', content: action.title }, template: 'blue' },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'action_form',
          element_id: 'action_form',
          elements: formElements,
        },
        ...outerElements,
      ],
    },
  };
}

/**
 * 构建动态追加的 input + 提交按钮元素（用于 _show_input 回调后追加）
 */
export function buildCustomInputElements(requestId: string, initiatorId?: string, cardTitle?: string, cardBody?: string): object[] {
  return [
    { tag: 'hr', element_id: 'hr_input' },
    {
      tag: 'input',
      name: 'custom_text',
      element_id: 'input_custom',
      placeholder: { tag: 'plain_text', content: '输入自定义回复...' },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 提交输入' },
      type: 'primary',
      action_type: 'form_submit',
      name: 'btn_submit_custom',
      element_id: 'btn_submit_custom',
      value: {
        _request_id: requestId,
        _action: '_custom_input',
        _initiator: initiatorId,
        _card_title: cardTitle,
        _card_body: cardBody,
        _btn_label: '提交输入',
      },
    },
  ];
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

/**
 * 按段落边界拆分超长消息
 * 优先在 \n\n 处分割，其次 \n，最后强制截断
 */
function splitLongMessage(content: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = maxLength;

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts;
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

/**
 * 将 Markdown 内容转为飞书消息卡片格式（interactive msg_type）
 * 飞书卡片的 markdown 组件支持完整 Markdown 渲染（代码块、表格、列表等）
 * 当前消息类型决策统一走 post + md tag，此函数为 interactive 卡片场景预留。
 */
export function markdownToFeishuCard(markdown: string, defaultTitle?: string): object {
  const match = markdown.match(/^# (.+)$/m);
  const title = match?.[1] ?? defaultTitle;
  let body = match ? markdown.replace(/^# .+\n?/, '') : markdown;
  body = convertTablesToText(body).trim();

  const card: any = {
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'markdown', content: body }
    ]
  };

  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title }
    };
  }

  return card;
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
import type { MessageBridge } from '../core/message/message-bridge.js';
import type { Config, FeishuChannelConfig } from '../types.js';
import { normalizeChannelInstances, getChannelShowActivities } from '../utils/channel-helpers.js';
import { resolvePaths } from '../paths.js';

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

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    const instances = normalizeChannelInstances<FeishuChannelConfig>(
      config.channels?.feishu,
      'feishu',
    );

    const result: ChannelInstance[] = [];
    for (const inst of instances) {
      if (inst.enabled === false || !inst.appId || !inst.appSecret) continue;

      const channel = new FeishuChannel({
        appId: inst.appId,
        appSecret: inst.appSecret,
        enableRichContent: config.enableRichContent,
        seenMsgFile: path.join(resolvePaths().dataDir, `feishu-seen-${inst.name}.jsonl`),
      });

      const adapter = {
        channelName: inst.name,
        channelKey: inst.name,
        capabilities: { file: true, image: true, interaction: true, markdown: true, thought: false, status: true },
        send: async (envelope: any, payload: any) => {
          const ctx = envelope.replyContext;
          const channelId = envelope.channelId;
          switch (payload.kind) {
            case 'result.text':
            case 'command.result':
            case 'command.error':
            case 'system.notice':
            case 'system.error':
            case 'result.error': {
              const sendCtx: any = { ...(ctx ?? {}) };
              if (payload.kind === 'result.text' && payload.isFinal) sendCtx.title = '✅ 最终回复:';
              await channel.sendMessage(channelId, payload.text, sendCtx);
              return;
            }
            case 'result.file':
              await channel.sendFile(channelId, payload.filePath, ctx);
              return;
            case 'result.image':
              await channel.sendImage(channelId, payload.data, ctx);
              return;
            case 'activity.batch': {
              // Feishu 不发送成功的 tool_result（信息密度低，刷屏）
              const filtered = payload.items.filter((i: ThoughtItem) => !(i.kind === 'tool_result' && i.ok));
              const text = formatItemsAsText(filtered);
              if (text) {
                await channel.sendMessage(channelId, text, ctx);
              }
              return;
            }
            case 'status.started':
            case 'status.completed':
            case 'status.interrupted':
            case 'status.error':
            case 'status.timeout':
            case 'status.progress':
              // Feishu 通过 acknowledge (✓ 表情) 表达状态，由 channel 自行处理
              return;
            case 'interaction': {
              const sent = await channel.sendInteraction(channelId, payload.interaction, ctx);
              if (!sent) throw new Error('sendInteraction returned false');
              return;
            }
            case 'custom':
              // Feishu 不支持自定义 payload
              return;
            default:
              logger.warn(`[Feishu] Unhandled payload kind: ${(payload as any).kind}`);
          }
        },        acknowledge: (messageId: string) => { channel.addAckReaction(messageId); return Promise.resolve(); },        onInteraction: (callback: (response: InteractionResponse) => void) => channel.onInteraction(callback),
      };

      const policy = {
        canSwitchProject: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canListProjects: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
        canCreateSession: (chatType: string, identity: string) => true,
        canDeleteSession: (chatType: string, identity: string) => true,
        canImportCliSession: (chatType: string, identity: string) => identity === 'owner' || identity === 'admin',
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
        accumulateErrors: (chatType: string, identity: string) => true,
      };

      const options = {
        fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
        supportsImages: true,
        flushDelay: inst.flushDelay,
      };

      result.push({
        channelType: 'feishu',
        adapter,
        channel,
        policy,
        options,
        connect: () => channel.connect(),
        disconnect: () => channel.disconnect(),
        onProjectPathRequest: (channelId: string) =>
          Promise.resolve(config.projects?.defaultPath || process.cwd()),
        registerBridge(bridge: MessageBridge, channelType: string) {
          bridge.register(
            adapter.channelName,
            (handler) => channel.onMessage(async ({ channelId: chatId, content, images, peerId, peerName, messageId, mentions, threadId, rootId, chatType, source }: any) => {
              await handler({
                channel: adapter.channelName, channelType, channelId: chatId, content, images,
                selfAID: (inst as any).agentName,
                chatType: chatType || 'private',
                peerId: peerId || '', peerName, messageId, mentions, threadId,
                replyContext: threadId ? { replyToMessageId: rootId ?? threadId, replyInThread: true } : undefined,
                source,
              });
            }),
            (channelId, text, replyContext) => channel.sendMessage(channelId, text, {
              replyToMessageId: replyContext?.replyToMessageId,
              replyInThread: replyContext?.replyInThread,
            }),
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
      throw new Error('Feishu config missing');
    }
    return instances[0];
  }
}
