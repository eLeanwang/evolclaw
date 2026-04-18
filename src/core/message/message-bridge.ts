import { logger } from '../../utils/logger.js';
import { StreamDebouncer } from './stream-debouncer.js';
import type { SessionManager } from '../session/session-manager.js';
import type { MessageProcessor } from './message-processor.js';
import type { MessageQueue } from './message-queue.js';
import type { CommandHandler as CmdHandler } from '../command-handler.js';
import type { EventBus } from '../event-bus.js';
import type { Config, Message, InboundMessage, ChannelAdapter, ReplyContext } from '../../types.js';

/**
 * MessageBridge — Channel 与 Core 之间的消息桥梁
 *
 * 入站管线：Channel.onMessage → owner 绑定 → 命令路由 → session 解析
 *          → 策略前缀 → 构造 Message → debounce → ACK → enqueue
 * 出站：命令响应通过 sendReply 回调直接发送到渠道
 */
export class MessageBridge {
  private debouncers = new Map<string, StreamDebouncer>();
  private defaultDebounce: number;

  constructor(
    private config: Config,
    private sessionManager: SessionManager,
    private processor: MessageProcessor,
    private messageQueue: MessageQueue,
    private cmdHandler: CmdHandler,
    private eventBus: EventBus,
  ) {
    this.defaultDebounce = config.debounce ?? 2;
  }

  private getDebouncer(channelName: string, channelType?: string): StreamDebouncer {
    let d = this.debouncers.get(channelName);
    if (!d) {
      let seconds = this.defaultDebounce;
      // 查找渠道级 debounce 配置：先用 channelType（如 'feishu'）在 config.channels 里查
      const type = channelType || channelName;
      const raw = (this.config.channels as any)?.[type];
      if (raw) {
        if (Array.isArray(raw)) {
          const inst = raw.find((i: any) => (i.name || type) === channelName);
          if (inst?.debounce !== undefined) seconds = inst.debounce;
        } else if (raw.debounce !== undefined) {
          seconds = raw.debounce;
        }
      }
      d = new StreamDebouncer(seconds);
      this.debouncers.set(channelName, d);
    }
    return d;
  }

  /**
   * 为渠道注册消息桥梁：入站处理管线 + 出站命令响应
   *
   * @param channelName     渠道实例名（用于 debounce 隔离）
   * @param onMessage       注册入站消息监听
   * @param sendReply       出站：命令响应发送回调
   * @param adapter         渠道适配器（用于 ACK）
   * @param channelType     渠道类型（feishu/wechat/aun），用于 session 和 message.channel
   */
  register(
    channelName: string,
    onMessage: (handler: (msg: InboundMessage) => Promise<void>) => void,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
    adapter?: ChannelAdapter,
    channelType?: string
  ): void {
    const effectiveChannelType = channelType || channelName;
    onMessage(async (msg) => {
      try {
        let content = msg.content.trim();

        // 0. 自定义消息快速路径（menu.query 等）
        if (await this.handleCustomPayload(content, channelName, msg, sendReply, adapter)) return;

        // 1. owner 绑定（按实例名绑定）
        if (msg.peerId) await this.autoBindOwner(channelName, msg.peerId);

        // 2. 命令快速路径（去除引用前缀后检查，兼容话题中引用上文的情况）
        const contentForCmd = content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
        const cmdContent = contentForCmd || content;
        if (this.cmdHandler.isCommand(cmdContent)) {
          logger.debug(`[MessageBridge] Command detected: "${cmdContent}", routing to handler`);
        }
        if (await this.handleCommand(cmdContent, channelName, msg.channelId,
          (text) => sendReply(msg.channelId, text, msg.replyContext),
          msg.peerId, msg.threadId
        )) return;

        // 3. session 解析（使用 Channel 层填充的 chatType）
        const chatType = msg.chatType || 'private';
        const metadata: Record<string, any> = {};
        // 话题会话创建时写入 replyContext（用于 threadId 路由）；主会话不写（避免群聊覆盖）
        if (msg.threadId && msg.replyContext) metadata.replyContext = msg.replyContext;
        // 写入实例名（审计 + 精确出站路由）
        metadata.channelName = channelName;
        if (chatType === 'private' && msg.peerId) {
          metadata.peerId = msg.peerId;
          if (msg.peerName) metadata.peerName = msg.peerName;
        }
        const session = await this.sessionManager.getOrCreateSession(
          channelName, msg.channelId,
          this.config.projects?.defaultPath || process.cwd(),
          msg.threadId, Object.keys(metadata).length ? metadata : undefined, undefined, msg.peerId, chatType
        );

        // 4. 消息前缀（由 policy 决定）
        const channelInfo = this.processor.getChannelInfo?.(channelName);
        if (channelInfo?.policy) {
          const prefix = channelInfo.policy.messagePrefix(chatType, msg.peerName);
          if (prefix) content = prefix + content;
        }

        // 5. 构造完整消息（channel 字段存实例名，用于 session 精确匹配）
        const fullMessage: Message = {
          channel: channelName, channelId: msg.channelId, content,
          chatType,
          images: msg.images, timestamp: Date.now(),
          peerId: msg.peerId, peerName: msg.peerName,
          messageId: msg.messageId,
          mentions: msg.mentions, threadId: msg.threadId,
          replyContext: msg.replyContext,
        };

        // 6. ACK + debounce/enqueue
        //    ACK 在到达时立即做（每条独立 ACK），不等合并
        //    Interrupt 模式（单聊）→ 入队前 debounce 合并
        //    FIFO 模式（群聊）    → 跳过 debouncer，独立入队，出队时贪心合并
        if (fullMessage.messageId) adapter?.acknowledge?.(fullMessage.messageId).catch(() => {});

        const isInterrupt = chatType !== 'group';
        const doEnqueue = async (m: Message) => {
          return this.messageQueue.enqueue(session.id, m, session.projectPath, {
            interruptible: isInterrupt,
          });
        };

        if (isInterrupt) {
          const debouncer = this.getDebouncer(channelName, effectiveChannelType);
          if (debouncer.enabled) {
            const debounceKey = msg.peerId ? `${session.id}:${msg.peerId}` : session.id;
            await debouncer.submit(debounceKey, fullMessage, doEnqueue);
          } else {
            await doEnqueue(fullMessage);
          }
        } else {
          // 群聊 FIFO：直接入队，由 MessageQueue.processNext 出队时合并
          await doEnqueue(fullMessage);
        }
      } catch (error) {
        logger.error(`[MessageBridge] Error in onMessage handler for ${channelName}:`, error);
      }
    });
  }

  /** 自定义消息快速路径：拦截 menu.query 等自定义 payload，返回 true 表示已处理 */
  private async handleCustomPayload(
    content: string, channel: string, msg: InboundMessage,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
    adapter?: ChannelAdapter
  ): Promise<boolean> {
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { return false; }
    if (!parsed || typeof parsed !== 'object' || !parsed.type) return false;

    if (parsed.type === 'menu.query') {
      const identity = this.sessionManager.resolveIdentity(channel, msg.peerId);
      const isAdmin = identity.role === 'owner';
      const items = this.cmdHandler.getMenuItems(isAdmin, msg.chatType || 'private');
      const response = JSON.stringify({ type: 'menu.response', items });

      if (adapter?.sendCustomPayload) {
        adapter.sendCustomPayload(msg.channelId, response);
      } else {
        await sendReply(msg.channelId, response);
      }
      return true;
    }

    return false;
  }

  /** 首次交互自动绑定 owner */
  private async autoBindOwner(channel: string, userId: string): Promise<void> {
    const { getOwner, setOwner } = await import('../../config.js');
    const currentOwner = getOwner(this.config, channel);
    // currentOwner === undefined means either no owner set, or instance not found
    // In both cases, try to set — setOwner is a no-op for unknown instances
    if (currentOwner === undefined) {
      setOwner(this.config, channel, userId);
      logger.info(`[Owner] Auto-bound ${channel} owner: ${userId}`);
      this.eventBus.publish({ type: 'channel:owner-bound', channel, userId });
    }
  }

  /** 命令快速路径：返回 true 表示已处理 */
  private async handleCommand(
    content: string, channel: string, channelId: string,
    sendReply: (text: string) => Promise<void>,
    userId?: string, threadId?: string
  ): Promise<boolean> {
    if (!this.cmdHandler.isCommand(content)) return false;
    logger.info(`[${channel}] ${channelId}: ${content}`);
    const cmdResult = await this.cmdHandler.handle(content, channel, channelId,
      (_cid, text, opts) => sendReply(text),
      userId, threadId);
    logger.debug(`[MessageBridge] handleCommand: result type=${typeof cmdResult}, value=${cmdResult === null ? 'null' : cmdResult === undefined ? 'undefined' : 'string'}`);
    if (cmdResult === undefined) return false;
    if (cmdResult) {
      try { await sendReply(cmdResult); } catch (error) {
        logger.error(`[${channel}] Failed to send command response:`, error);
      }
    }
    return true;
  }

  /**
   * 撤回消息：先查 debounce 窗口，再查 message queue。
   * @returns true 如果找到并取消
   */
  cancel(messageId: string): boolean {
    // 阶段 1: debounce 窗口（尚未入队）
    for (const d of this.debouncers.values()) {
      if (d.cancel(messageId)) return true;
    }
    // 阶段 2: 已入队但未处理（合并后 messageId 可能是逗号分隔的多个 id）
    return this.messageQueue.cancel(messageId);
  }

  /** 清理资源 */
  dispose(): void {
    for (const d of this.debouncers.values()) d.dispose();
    this.debouncers.clear();
  }
}
