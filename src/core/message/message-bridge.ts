import { randomBytes } from 'crypto';
import { logger } from '../../utils/logger.js';
import { StreamDebouncer } from './stream-debouncer.js';
import { appendMessageLog, buildInboundEntry } from './message-log.js';
import { buildEnvelope } from './message-processor.js';
import { chatDirPath } from '../session/session-fs-store.js';
import { resolvePaths } from '../../paths.js';
import type { SessionManager } from '../session/session-manager.js';
import type { MessageProcessor } from './message-processor.js';
import type { MessageQueue } from './message-queue.js';
import type { CommandHandler as CmdHandler } from '../command/command-handler.js';
import type { EventBus } from '../event-bus.js';
import type { Message, InboundMessage, ChannelAdapter, ReplyContext, EvolAgentRegistryHandle, OutboundPayload, MenuListRequest, MenuQueryRequest, MenuOptionsRequest, MenuUpdateRequest, MenuActionRequest, MenuResponse } from '../../types.js';

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
    this.defaultDebounce = defaultDebounce ?? 0;
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

  private availableBaseagentsFor(channelName: string): string[] {
    const owningAgent = this.agentRegistry?.resolveByChannel(channelName);
    if (!owningAgent) return [];
    const prefix = `${owningAgent.name}::`;
    return this.processor.getAvailableAgents()
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length));
  }

  private async alignSessionBaseagent(channelName: string, session: any): Promise<any> {
    const owningAgent = this.agentRegistry?.resolveByChannel(channelName);
    if (!owningAgent) return session;
    const available = this.availableBaseagentsFor(channelName);
    if (available.length === 0 || available.includes(session.baseagent)) return session;

    const preferred = available.includes(owningAgent.baseagent)
      ? owningAgent.baseagent
      : available[0];
    logger.warn(`[MessageBridge] Aligning unavailable session baseagent: session=${session.id} ${session.baseagent} -> ${preferred} agent=${owningAgent.name} available=${available.join(',')}`);
    await this.sessionManager.updateSession(session.id, { baseagent: preferred, agentSessionId: null });
    return { ...session, baseagent: preferred, agentSessionId: undefined };
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

        // 渠道入站日志
        logger.channelIn({ channel: channelName, channelId: msg.channelId, peerId: msg.peerId, peerName: msg.peerName, chatType: msg.chatType, msgId: msg.messageId, threadId: msg.threadId, content, images: msg.images?.length ?? 0, mentions: msg.mentions, replyContext: msg.replyContext });

        // 0. 自定义消息快速路径（menu.query 等）
        if (await this.handleCustomPayload(content, channelName, msg, sendReply, adapter)) return;

        // 1. owner 绑定（按实例名绑定）
        if (msg.peerId) await this.autoBindOwner(channelName, msg.peerId);

        // 2. 命令快速路径（去除引用前缀后检查，兼容话题中引用上文的情况）
        const contentForCmd = content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
        const cmdContent = contentForCmd || content;
        const isCmd = this.cmdHandler.isCommand(cmdContent);
        if (isCmd) {
          logger.debug(`[MessageBridge] Command detected: "${cmdContent}", routing to handler`);
          // 命令也要记录入方向 jsonl（不创建 session，直接用 chatDirPath 计算路径）
          try {
            const chatDir = chatDirPath(resolvePaths().sessionsDir, msg.channelType || effectiveChannelType, msg.channelId, msg.selfAID || '');
            const inboundEncrypt = msg.replyContext?.metadata?.encrypted != null ? !!(msg.replyContext.metadata.encrypted) : undefined;
            const inboundChatmode = msg.replyContext?.metadata?.chatmode as string | undefined;
            appendMessageLog(chatDir, buildInboundEntry({
              from: msg.peerId || 'unknown',
              to: msg.selfAID || 'self',
              chatType: msg.chatType || 'private',
              groupId: msg.groupId ?? null,
              msgId: msg.messageId ?? null,
              content,
              replyTo: msg.replyContext?.replyToMessageId ?? null,
              permMode: null,
              timestamp: Date.now(),
              encrypt: inboundEncrypt,
              chatmode: inboundChatmode,
            }));
          } catch (e) {
            logger.debug(`[MessageBridge] Failed to log inbound command: ${e}`);
          }
        }
        if (await this.handleCommand(cmdContent, channelName, msg.channelId,
          (text) => {
            logger.channelOut({ channel: channelName, channelId: msg.channelId, taskId: `cmd-${msg.messageId || Date.now()}`, payload: { kind: 'command.result', text } });
            return sendReply(msg.channelId, text, msg.replyContext);
          },
          msg.peerId, msg.threadId, msg.chatType, msg.source,
          msg.replyContext, msg.messageId, msg.selfAID
        )) return;

        // 3. session 解析（使用 Channel 层填充的 chatType）
        const chatType = msg.chatType || 'private';
        if (!(await this.canCreateThreadSession(channelName, msg, chatType))) {
          // 静默丢弃：绝不向群里注入回复。
          // 拒绝消息本身会带原 thread_id（AUN replyContext 透传），变成一条新群消息；
          // 若发送者也是 agent，该拒绝消息又会 @ 回对方 → A 拒绝→B 收到→B 拒绝→A 收到 的无限循环。
          // AUN 自主模式下「不响应」是合法的，因此无权限创建话题时只记日志、直接 return。
          logger.info(`[MessageBridge] Thread creation denied (silent drop): channel=${channelName} channelId=${msg.channelId} thread=${msg.threadId} sender=${msg.peerId}`);
          return;
        }
        const metadata: Record<string, any> = {};
        // 话题会话创建时写入 replyContext（用于 threadId 路由）；主会话不写（避免群聊覆盖）
        if (msg.threadId && msg.replyContext) metadata.replyContext = msg.replyContext;
        // 写入实例名（审计 + 精确出站路由）
        metadata.channelKey = channelName;
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

        let session = await this.sessionManager.getOrCreateSession(
          channelName, msg.channelId,
          effectiveProjectPath,
          msg.threadId, Object.keys(metadata).length ? metadata : undefined, this.extractTopicName(msg), msg.peerId, chatType,
          owningAgent?.baseagent, msg.selfAID, msg.channelType || effectiveChannelType,
          msg.peerType
        );
        session = await this.alignSessionBaseagent(channelName, session);

        // 4. 群聊发送者标注由消息渲染层（message-renderer）逐条承担，不再在此硬编码前缀，
        //    消息日志因此保存干净原文。policy.messagePrefix 暂保留（未来清理）。

        // 5. 构造完整消息（channel 字段存实例名，用于 session 精确匹配）
        const fullMessage: Message = {
          channel: channelName,
          channelType: msg.channelType || effectiveChannelType,
          channelId: msg.channelId, content,
          selfAID: msg.selfAID,
          baseagent: session.baseagent,
          chatType,
          images: msg.images, timestamp: Date.now(),
          peerId: msg.peerId, peerName: msg.peerName,
          peerType: msg.peerType,
          sameDevice: msg.sameDevice,
          sameNetwork: msg.sameNetwork,
          sameEgressIp: msg.sameEgressIp,
          // 入站加密态（仅 aun 渠道有意义；非 aun 为 undefined）。回复加密态跟随此值，
          // 并经 mergeItems 逐条保留 + 密文优先聚合，message-renderer 据此标注。
          encrypted: msg.replyContext?.metadata?.encrypted != null ? !!(msg.replyContext.metadata.encrypted) : undefined,
          messageId: msg.messageId,
          mentions: msg.mentions, mentionAids: msg.mentionAids, threadId: msg.threadId,
          topicName: this.extractTopicName(msg),
          replyContext: msg.replyContext,
          source: msg.source,
          dispatchMode: msg.dispatchMode,
        };

        // 5.5 写入消息记录（入方向）。
        {
          const chatDir = this.sessionManager.getChatDir(session);
          const inboundEncrypt = msg.replyContext?.metadata?.encrypted != null ? !!(msg.replyContext.metadata.encrypted) : undefined;
          const inboundChatmode = msg.replyContext?.metadata?.chatmode as string | undefined;
          appendMessageLog(chatDir, buildInboundEntry({
            from: msg.peerId || 'unknown',
            to: msg.selfAID || 'self',
            chatType,
            groupId: msg.groupId ?? null,
            msgId: msg.messageId ?? null,
            content,
            replyTo: msg.replyContext?.replyToMessageId ?? null,
            permMode: session.identity?.role ?? null,
            timestamp: fullMessage.timestamp,
            encrypt: inboundEncrypt,
            chatmode: inboundChatmode,
          }));
        }

        // 6. ACK + debounce/enqueue
        //    ACK 在到达时立即做（每条独立 ACK），不等合并
        //    Interrupt 模式（单聊）→ 入队前 debounce 合并
        //    FIFO 模式（群聊）    → 跳过 debouncer，独立入队，出队时贪心合并
        //    优化：队列空闲时跳过 Pin 表情，直接在开始执行时添加 CheckMark
        if (fullMessage.messageId && this.messageQueue.getGlobalProcessingCount() > 0) {
          adapter?.acknowledge?.(fullMessage.messageId).catch(() => {});
        }

        const isInterrupt = chatType !== 'group';
        const enqueueAgentName = owningAgent?.name ?? '<unknown>';
        const doEnqueue = async (m: Message) => {
          return this.messageQueue.enqueue(session.id, m, session.projectPath, {
            interruptible: isInterrupt,
            interruptSamePeer: !isInterrupt,  // 群聊：同人连发且队列无他人时打断
            agentName: enqueueAgentName,
            role: !isInterrupt ? (session.identity?.role ?? 'anonymous') : undefined,
            sessionKeyField: session.sessionKey,
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

  // ── Menu Protocol ──

  private static readonly MENU_NAME_MAP: Record<string, string> = {
    pwd: '/pwd',
    session: '/session',
    topic: '/topic',
    baseagent: '/baseagent',
    model: '/model',
    effort: '/effort',
    chatmode: '/chatmode',
    dispatch: '/dispatch',
    permission: '/perm',
    activity: '/activity',
    system: '/system',
    cli: '/cli',
    agent: '/agent',
    trigger: '/trigger',
    file: '/file',
  };

  private extractTopicName(msg: InboundMessage): string | undefined {
    const raw = msg.topicName
      ?? msg.replyContext?.title
      ?? msg.replyContext?.metadata?.topicName
      ?? msg.replyContext?.metadata?.title;
    const name = typeof raw === 'string' ? raw.trim() : '';
    return name || undefined;
  }

  private async canCreateThreadSession(channel: string, msg: InboundMessage, chatType: 'private' | 'group'): Promise<boolean> {
    if (chatType !== 'group' || !msg.threadId) return true;
    const existing = await this.sessionManager.getThreadSession(channel, msg.channelId, msg.threadId);
    if (existing) return true;
    // 群话题创建权限只看「发送者在该群里的角色」（AUN 经 group.get_admins 实时查询，权威源）。
    // 仅群 owner/admin 可建话题；member / 非成员 / 查询失败（undefined）一律 fail-closed 拒绝。
    // 这与 bot 的 owner/admin 无关——不引入 resolveIdentity 兜底。
    // 不暴露群角色的渠道（adapter 无 getGroupMemberRole）不受此守卫约束，放行。
    const adapter = this.processor?.getChannelInfo?.(channel)?.adapter;
    if (adapter?.getGroupMemberRole) {
      const groupRole = await adapter.getGroupMemberRole(msg.channelId, msg.peerId);
      return groupRole === 'owner' || groupRole === 'admin';
    }
    return true;
  }

  private resolveCmd(name: string, cmd?: string): string {
    if (cmd) return cmd;
    const mapped = MessageBridge.MENU_NAME_MAP[name];
    if (!mapped) throw { code: 'UNKNOWN_NAME', message: `未知操作: ${name}` };
    return mapped;
  }

  /** 自定义消息快速路径：拦截 menu.* 协议 */
  private async handleCustomPayload(
    content: string, channel: string, msg: InboundMessage,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
    adapter?: ChannelAdapter
  ): Promise<boolean> {
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { return false; }
    if (!parsed || typeof parsed !== 'object' || !parsed.type) return false;

    switch (parsed.type) {
      case 'menu.list':
        await this.handleMenuList(parsed, channel, msg, adapter, sendReply);
        return true;
      case 'menu.query':
        await this.handleMenuQuery(parsed, channel, msg, adapter, sendReply);
        return true;
      case 'menu.options':
        await this.handleMenuOptions(parsed, channel, msg, adapter, sendReply);
        return true;
      case 'menu.update':
        await this.handleMenuUpdate(parsed, channel, msg, adapter, sendReply);
        return true;
      case 'menu.action':
        await this.handleMenuAction(parsed, channel, msg, adapter, sendReply);
        return true;
      default:
        return false;
    }
  }

  private async handleMenuList(
    req: MenuListRequest, channel: string, msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
  ): Promise<void> {
    const { id } = req;
    try {
      const identity = this.sessionManager.resolveIdentity(channel, msg.peerId);
      const data = this.cmdHandler.getMenuItems(identity.role, msg.chatType || 'private', msg.isControlChannel ? 'control' : 'agent');
      await this.sendMenuResponse(adapter, channel, msg.channelId,
        { type: 'menu.response', id, data }, sendReply);
    } catch (err: any) {
      await this.sendMenuResponse(adapter, channel, msg.channelId, {
        type: 'menu.response', id,
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
      }, sendReply);
    }
  }

  private async handleMenuQuery(
    req: MenuQueryRequest, channel: string, msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
  ): Promise<void> {
    const { id, name, cmd } = req;
    try {
      const resolvedCmd = this.resolveCmd(name, cmd);
      const result = await this.cmdHandler.execMenuQuery(resolvedCmd, channel, msg.channelId, msg.peerId, (req as any).args, msg.chatType, msg.isControlChannel ?? false);
      if ('error' in result) throw { code: result.code || 'EXEC_FAILED', message: result.error };
      await this.sendMenuResponse(adapter, channel, msg.channelId,
        { type: 'menu.response', id, name, data: result.data }, sendReply);
    } catch (err: any) {
      await this.sendMenuResponse(adapter, channel, msg.channelId, {
        type: 'menu.response', id, name,
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
      }, sendReply);
    }
  }

  private async handleMenuOptions(
    req: MenuOptionsRequest, channel: string, msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
  ): Promise<void> {
    const { id, name, cmd } = req;
    try {
      const resolvedCmd = this.resolveCmd(name, cmd);
      const data = await this.cmdHandler.getSubMenuItems(resolvedCmd, channel, msg.channelId, msg.peerId, (req as any).args, undefined, msg.chatType, msg.isControlChannel ?? false) ?? [];
      await this.sendMenuResponse(adapter, channel, msg.channelId,
        { type: 'menu.response', id, name, data }, sendReply);
    } catch (err: any) {
      await this.sendMenuResponse(adapter, channel, msg.channelId, {
        type: 'menu.response', id, name,
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
      }, sendReply);
    }
  }

  private async handleMenuUpdate(
    req: MenuUpdateRequest, channel: string, msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
  ): Promise<void> {
    const { id, name, cmd, value, args } = req;
    try {
      if (!value) throw { code: 'MISSING_VALUE', message: '缺少 value 参数' };
      const resolvedCmd = this.resolveCmd(name, cmd);
      const result = await this.cmdHandler.execMenuUpdate(resolvedCmd, value, channel, msg.channelId, msg.peerId, undefined, msg.isControlChannel ?? false, args);
      if ('error' in result) throw { code: result.code || 'EXEC_FAILED', message: result.error };
      await this.sendMenuResponse(adapter, channel, msg.channelId,
        { type: 'menu.response', id, name, data: result.data }, sendReply);
    } catch (err: any) {
      await this.sendMenuResponse(adapter, channel, msg.channelId, {
        type: 'menu.response', id, name,
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
      }, sendReply);
    }
  }

  private async handleMenuAction(
    req: MenuActionRequest, channel: string, msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>
  ): Promise<void> {
    const { id, name, cmd, action, args } = req;
    try {
      if (!action) throw { code: 'MISSING_VALUE', message: '缺少 action 参数' };
      const resolvedCmd = this.resolveCmd(name, cmd);
      const result = await this.cmdHandler.execMenuAction(resolvedCmd, action, args, channel, msg.channelId, msg.peerId, undefined, msg.chatType, id, msg.isControlChannel ?? false);
      if ('error' in result) throw { code: result.code || 'EXEC_FAILED', message: result.error };
      await this.sendMenuResponse(adapter, channel, msg.channelId,
        { type: 'menu.response', id, name, data: result.data }, sendReply);
    } catch (err: any) {
      await this.sendMenuResponse(adapter, channel, msg.channelId, {
        type: 'menu.response', id, name,
        error: { code: err?.code || 'INTERNAL', message: err?.message || String(err) }
      }, sendReply);
    }
  }

  private async sendMenuResponse(
    adapter: ChannelAdapter | undefined, channel: string, channelId: string,
    response: MenuResponse,
    sendReply: (channelId: string, text: string) => Promise<void>
  ): Promise<void> {
    await this.sendCustomResponse(adapter, channel, channelId, JSON.stringify(response), sendReply);
  }

  /** menu.query 响应：优先走 adapter.send(custom)，降级 sendReply */
  private async sendCustomResponse(
    adapter: ChannelAdapter | undefined,
    channel: string,
    channelId: string,
    response: string,
    sendReply: (channelId: string, text: string) => Promise<void>,
  ): Promise<void> {
    if (adapter?.send) {
      const agentName = this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>';
      const envelope = buildEnvelope({
        taskId: `menu-${randomBytes(4).toString('hex')}`,
        channel,
        channelId,
        agentName,
      });
      await adapter.send(envelope, { kind: 'custom', channelType: channel, payload: response });
    } else {
      await sendReply(channelId, response);
    }
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
    userId?: string, threadId?: string, chatType?: string, source?: 'user' | 'card-trigger',
    replyContext?: ReplyContext, messageId?: string, selfAID?: string,
  ): Promise<boolean> {
    if (!this.cmdHandler.isCommand(content)) return false;
    logger.info(`[${channel}] ${channelId}: ${content}${source === 'card-trigger' ? ' [card]' : ''}`);
    const cmdResult = await this.cmdHandler.handle(content, channel, channelId,
      (_cid, text, opts) => sendReply(text),
      userId, threadId, chatType, source, messageId, selfAID);
    logger.debug(`[MessageBridge] handleCommand: result type=${typeof cmdResult}`);
    if (cmdResult === undefined) return false;
    if (cmdResult) {
      // 规范化为 OutboundPayload：string → command.result 包装；object → 透传
      let payload: OutboundPayload;
      if (typeof cmdResult === 'string') {
        payload = { kind: 'command.result', text: cmdResult };
      } else if (typeof cmdResult === 'object' && cmdResult !== null && 'kind' in cmdResult) {
        payload = cmdResult as OutboundPayload;
      } else {
        // 不识别的返回值，按已处理但无回显处理
        return true;
      }

      // 出站走 adapter.send 统一入口
      const adapter = this.processor.getChannelInfo?.(channel)?.adapter;
      const envelope = buildEnvelope({
        taskId: `cmd-${randomBytes(5).toString('hex')}`,
        channel,
        channelId,
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>',
        chatmode: 'interactive',
        replyContext,
      });

      try {
        if (adapter?.send) {
          await adapter.send(envelope, payload);
        } else {
          // 降级路径：渠道未实现 send 时回退到原有 sendReply（仅文本）
          const fallbackText = ('text' in payload && typeof payload.text === 'string') ? payload.text : '';
          if (fallbackText) await sendReply(fallbackText);
        }
      } catch (error) {
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

  /** 注销单个渠道的 debouncer（热重载断开渠道时调用） */
  removeChannel(channelName: string): void {
    const d = this.debouncers.get(channelName);
    if (d) {
      d.dispose();
      this.debouncers.delete(channelName);
    }
  }
}
