import { logger } from '../utils/logger.js';
import { StreamDebouncer } from '../utils/stream-debouncer.js';
import type { SessionManager } from './session-manager.js';
import type { MessageProcessor } from './message-processor.js';
import type { MessageQueue } from './message-queue.js';
import type { CommandHandler as CmdHandler } from './command-handler.js';
import type { EventBus } from './event-bus.js';
import type { Config, Message, InboundMessage, ChannelAdapter, ReplyContext } from '../types.js';

/**
 * MessageBridge — Channel 与 Core 之间的消息桥梁
 *
 * 入站管线：Channel.onMessage → owner 绑定 → 命令路由 → session 解析
 *          → 策略前缀 → 构造 Message → debounce → ACK → enqueue
 * 出站：命令响应通过 sendReply 回调直接发送到渠道
 */
export class MessageBridge {
  private debouncer: StreamDebouncer;

  constructor(
    private config: Config,
    private sessionManager: SessionManager,
    private processor: MessageProcessor,
    private messageQueue: MessageQueue,
    private cmdHandler: CmdHandler,
    private eventBus: EventBus,
  ) {
    this.debouncer = new StreamDebouncer(config.debounce ?? 2);
  }

  /**
   * 为渠道注册消息桥梁：入站处理管线 + 出站命令响应
   *
   * @param channelName     渠道标识
   * @param onMessage       注册入站消息监听
   * @param sendReply       出站：命令响应发送回调
   * @param adapter         渠道适配器（用于 ACK）
   */
  register(
    channelName: string,
    onMessage: (handler: (msg: InboundMessage) => Promise<void>) => void,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
    adapter?: ChannelAdapter
  ): void {
    onMessage(async (msg) => {
      let content = msg.content.trim();

      // 1. owner 绑定
      if (msg.peerId) await this.autoBindOwner(channelName, msg.peerId);

      // 2. 命令快速路径（去除引用前缀后检查，兼容话题中引用上文的情况）
      const contentForCmd = content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
      if (await this.handleCommand(contentForCmd || content, channelName, msg.channelId,
        (text) => sendReply(msg.channelId, text, msg.replyContext),
        msg.peerId, msg.threadId
      )) return;

      // 3. session 解析（使用 Channel 层填充的 chatType）
      const chatType = msg.chatType || 'private';
      const metadata = msg.replyContext ? { replyContext: msg.replyContext } : undefined;
      const session = await this.sessionManager.getOrCreateSession(
        channelName, msg.channelId,
        this.config.projects?.defaultPath || process.cwd(),
        msg.threadId, metadata, undefined, msg.peerId, chatType
      );

      // 4. 消息前缀（由 policy 决定）
      const channelInfo = this.processor.getChannelInfo?.(channelName);
      if (channelInfo?.policy) {
        const prefix = channelInfo.policy.messagePrefix(chatType, msg.peerName);
        if (prefix) content = prefix + content;
      }

      // 5. 构造完整消息
      const fullMessage: Message = {
        channel: channelName, channelId: msg.channelId, content,
        chatType,
        images: msg.images, timestamp: Date.now(),
        peerId: msg.peerId, peerName: msg.peerName,
        messageId: msg.messageId,
        mentions: msg.mentions, threadId: msg.threadId,
        replyContext: msg.replyContext,
      };

      // 6. debounce + ACK + enqueue
      const doEnqueue = async (m: Message) => {
        if (m.messageId) adapter?.acknowledge?.(m.messageId).catch(() => {});
        return this.messageQueue.enqueue(session.id, m, session.projectPath, {
          interruptible: chatType !== 'group',
        });
      };
      if (this.debouncer.enabled) {
        await this.debouncer.submit(session.id, fullMessage, doEnqueue);
      } else {
        await doEnqueue(fullMessage);
      }
    });
  }

  /** 首次交互自动绑定 owner */
  private async autoBindOwner(channel: string, userId: string): Promise<void> {
    const channelConfig = (this.config.channels as any)?.[channel];
    if (channelConfig && !channelConfig.owner) {
      const { setOwner } = await import('../config.js');
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
    const cmdResult = await this.cmdHandler.handle(content, channel, channelId, undefined, userId, threadId);
    if (cmdResult === null) return false;
    if (cmdResult) {
      try { await sendReply(cmdResult); } catch (error) {
        logger.error(`[${channel}] Failed to send command response:`, error);
      }
    }
    return true;
  }

  /** 清理资源 */
  dispose(): void {
    this.debouncer.dispose();
  }
}
