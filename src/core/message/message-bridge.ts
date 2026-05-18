import { logger } from '../../utils/logger.js';
import { StreamDebouncer } from './stream-debouncer.js';
import { appendMessageLog, buildInboundEntry } from '../session/message-log.js';
import type { SessionManager } from '../session/session-manager.js';
import type { MessageProcessor } from './message-processor.js';
import type { MessageQueue } from './message-queue.js';
import type { CommandHandler as CmdHandler } from '../command-handler.js';
import type { EventBus } from '../event-bus.js';
import type { Message, InboundMessage, ChannelAdapter, ReplyContext, EvolAgentRegistryHandle } from '../../types.js';

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
  private agentRegistry?: EvolAgentRegistryHandle;

  constructor(
    private defaultProjectPath: string,
    private sessionManager: SessionManager,
    private processor: MessageProcessor,
    private messageQueue: MessageQueue,
    private cmdHandler: CmdHandler,
    private eventBus: EventBus,
    defaultDebounce?: number,
  ) {
    this.defaultDebounce = defaultDebounce ?? 2;
  }

  /** Inject EvolAgentRegistry so owner lookups/writes route to agent.json for agent-owned channels. */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  private getDebouncer(channelName: string, channelType?: string): StreamDebouncer {
    let d = this.debouncers.get(channelName);
    if (!d) {
      // 从 owning agent 的 channel 配置取 debounce，找不到用全局默认
      let seconds = this.defaultDebounce;
      const agent = this.agentRegistry?.resolveByChannel(channelName);
      if (agent) {
        const merged = (agent as any).config;
        if (merged?.debounce !== undefined) seconds = merged.debounce;
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
        if (chatType === 'group') {
          // 群聊：peerId 是当前消息发送者；groupId 在 channel 提供时存到 metadata
          if (msg.peerId) metadata.peerId = msg.peerId;
          if (msg.peerName) metadata.peerName = msg.peerName;
          if (msg.groupId) metadata.groupId = msg.groupId;
        }
        // Resolve effective project path: 用通道所属 agent 的 projectPath；
        // 通道找不到归属时退回到 globalConfig（一般是测试场景）
        const owningAgent = this.agentRegistry?.resolveByChannel(channelName);
        const effectiveProjectPath = owningAgent?.projectPath
          ?? this.defaultProjectPath;

        const session = await this.sessionManager.getOrCreateSession(
          channelName, msg.channelId,
          effectiveProjectPath,
          msg.threadId, Object.keys(metadata).length ? metadata : undefined, undefined, msg.peerId, chatType,
          undefined, msg.selfId, msg.channelType || effectiveChannelType
        );

        // 4. 消息前缀（由 policy 决定）
        const channelInfo = this.processor.getChannelInfo?.(channelName);
        if (channelInfo?.policy) {
          const prefix = channelInfo.policy.messagePrefix(chatType, msg.peerName);
          if (prefix) content = prefix + content;
        }

        // 5. 构造完整消息（channel 字段存实例名，用于 session 精确匹配）
        const fullMessage: Message = {
          channel: channelName,
          channelType: msg.channelType || effectiveChannelType,
          channelId: msg.channelId, content,
          selfId: msg.selfId,
          chatType,
          images: msg.images, timestamp: Date.now(),
          peerId: msg.peerId, peerName: msg.peerName,
          peerType: msg.peerType,
          messageId: msg.messageId,
          mentions: msg.mentions, threadId: msg.threadId,
          replyContext: msg.replyContext,
        };

        // 5.5 写入消息记录（入方向）
        const chatDir = this.sessionManager.getChatDir(session);
        appendMessageLog(chatDir, buildInboundEntry({
          from: msg.peerId || 'unknown',
          to: msg.selfId || 'self',
          chatType,
          groupId: msg.groupId ?? null,
          msgId: msg.messageId ?? null,
          content,
          replyTo: msg.replyContext?.replyToMessageId ?? null,
          permMode: session.identity?.role ?? null,
          timestamp: fullMessage.timestamp,
        }));

        // 6. ACK + debounce/enqueue
        //    ACK 在到达时立即做（每条独立 ACK），不等合并
        //    Interrupt 模式（单聊）→ 入队前 debounce 合并
        //    FIFO 模式（群聊）    → 跳过 debouncer，独立入队，出队时贪心合并
        if (fullMessage.messageId) adapter?.acknowledge?.(fullMessage.messageId).catch(() => {});

        const isInterrupt = chatType !== 'group';
        const enqueueAgentName = owningAgent?.name ?? '<unknown>';
        const doEnqueue = async (m: Message) => {
          return this.messageQueue.enqueue(session.id, m, session.projectPath, {
            interruptible: isInterrupt,
            agentName: enqueueAgentName,
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
      if (parsed.cmd && (parsed.mode === 'query' || parsed.mode === 'update')) {
        // exec 模式：查询状态或执行命令
        const result = await this.cmdHandler.execMenu(parsed.cmd, parsed.mode, channel, msg.channelId, msg.peerId);
        const base = { type: 'menu.response', cmd: parsed.cmd };
        const response = JSON.stringify('error' in result ? { ...base, error: result.error } : { ...base, data: result.data });
        if (adapter?.sendCustomPayload) {
          adapter.sendCustomPayload(msg.channelId, response);
        } else {
          await sendReply(msg.channelId, response);
        }
      } else if (parsed.cmd) {
        // 动态子菜单查询
        const items = await this.cmdHandler.getSubMenuItems(parsed.cmd, channel, msg.channelId, msg.peerId);
        const response = JSON.stringify({ type: 'menu.response', cmd: parsed.cmd, items: items ?? [] });
        if (adapter?.sendCustomPayload) {
          adapter.sendCustomPayload(msg.channelId, response);
        } else {
          await sendReply(msg.channelId, response);
        }
      } else {
        // 全量菜单
        const identity = this.sessionManager.resolveIdentity(channel, msg.peerId);
        const items = this.cmdHandler.getMenuItems(identity.role, msg.chatType || 'private');
        const response = JSON.stringify({ type: 'menu.response', items });
        if (adapter?.sendCustomPayload) {
          adapter.sendCustomPayload(msg.channelId, response);
        } else {
          await sendReply(msg.channelId, response);
        }
      }
      return true;
    }

    return false;
  }

  /** 首次交互自动绑定 owner —— 通过 channel-routed self-agent 完成 */
  private async autoBindOwner(channel: string, userId: string): Promise<void> {
    const currentOwner = this.agentRegistry?.getOwner?.(channel);
    if (currentOwner === undefined) {
      if (this.agentRegistry?.setChannelOwner) {
        this.agentRegistry.setChannelOwner(channel, userId);
      } else {
        logger.warn(`[Owner] no agentRegistry; skip auto-bind for ${channel}`);
        return;
      }
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
   * 撤回消息：先查 debounce 窗口，再查 message queue，最后查正在执行的任务。
   * @returns true 如果找到并取消/中断
   */
  cancel(messageId: string): boolean {
    // 阶段 1: debounce 窗口（尚未入队）
    for (const d of this.debouncers.values()) {
      if (d.cancel(messageId)) return true;
    }
    // 阶段 2: 已入队但未处理（合并后 messageId 可能是逗号分隔的多个 id）
    if (this.messageQueue.cancel(messageId)) return true;
    // 阶段 3: 正在执行的任务 → 触发 interrupt
    return this.messageQueue.cancelActive(messageId);
  }

  /** 清理资源 */
  dispose(): void {
    for (const d of this.debouncers.values()) d.dispose();
    this.debouncers.clear();
  }
}
