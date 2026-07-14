import { createHash, randomBytes } from 'crypto';
import { logger } from '../../utils/logger.js';
import { StreamDebouncer } from './stream-debouncer.js';
import { appendMessageLog, appendMessageLogStrict, buildInboundEntry, isTransientProtocolMessage } from './message-log.js';
import { buildEnvelope } from './message-utils.js';
import { chatDirPath } from '../session/session-fs-store.js';
import { tryParseChannelKey } from '../channel-loader.js';
import { resolvePaths } from '../../paths.js';
import { addStaticAgentOwner, hasStaticAgentOwner, resolvePeerRoleDetail, type ResolvedPeerRole } from '../../config/peer-role-resolver.js';
import { handlePendingDingtalkContactBindMessage } from '../../channels/dingtalk.js';
import { authorizeAccess, buildAuthSubject } from '../auth/auth-gateway.js';
import {
  MenuDiagnosticLimiter,
  MenuRequestDeduper,
  hasValidMenuId,
  menuFailure,
  menuPayloadFingerprint,
  menuSuccess,
  normalizeMenuError,
  parseMenuControl,
  validateMenuRequest,
  type ParsedMenuControl,
} from './menu-control-protocol.js';
import type { SessionManager } from '../session/session-manager.js';
import { SessionRenewService } from '../session/session-renew.js';
import type { IMessageProcessor } from './message-processor-interface.js';
import type { MessageQueue } from './message-queue.js';
import type { CommandHandler as CmdHandler } from '../command/command-handler.js';
import type { EventBus } from '../event-bus.js';
import type { BootstrapService } from '../bootstrap-service.js';
import type { HandoffRuntime } from '../handoff/runtime.js';
import type { Message, InboundMessage, ChannelAdapter, ReplyContext, EvolAgentRegistryHandle, OutboundPayload, MenuResponse, SessionIdentity } from '../../types.js';
import type { AuthSubject } from '../auth/auth-gateway.js';

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
  private bootstrapService?: BootstrapService;
  private readonly menuDeduper = new MenuRequestDeduper<MenuResponse>();
  private readonly menuDiagnostics = new MenuDiagnosticLimiter();
  private handoffRuntime?: HandoffRuntime;
  private sessionRenewService: SessionRenewService;

  constructor(
    private defaultProjectPath: string,
    private sessionManager: SessionManager,
    private processor: IMessageProcessor,
    private messageQueue: MessageQueue,
    private cmdHandler: CmdHandler,
    private eventBus: EventBus,
    defaultDebounce?: number,
  ) {
    this.defaultDebounce = defaultDebounce ?? 0;
    this.sessionRenewService = new SessionRenewService(sessionManager, processor);
  }

  /** Inject EvolAgentRegistry so owner lookups/writes route to agent.json for agent-owned channels. */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  setBootstrapService(service: BootstrapService): void {
    this.bootstrapService = service;
  }

  setHandoffRuntime(runtime: HandoffRuntime): void {
    this.handoffRuntime = runtime;
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
        const channelKey = adapter?.channelKey || channelName;
        const owningAgent = this.agentRegistry?.resolveByChannel(channelKey)
          ?? this.agentRegistry?.resolveByChannel(channelName);
        const parsedChannelKey = tryParseChannelKey(channelKey);
        const chatType = msg.chatType || 'private';
        const actorId = msg.peerId;
        const conversationId = chatType === 'group' ? (msg.groupId || msg.channelId) : msg.peerId;
        const selfAid = msg.selfAID || owningAgent?.aid || parsedChannelKey?.selfAID;
        const menuControl = parseMenuControl(content);
        if (menuControl.isMenu) {
          this.logMenuInbound(channelName, msg, menuControl);
          if (!hasValidMenuId(menuControl)) {
            this.logMenuDiagnostic('missing-id', channelName, msg, menuControl);
            return;
          }
          const validationError = validateMenuRequest(menuControl.request);
          if (validationError) {
            const header = { id: menuControl.id, ...(menuControl.name?.trim() ? { name: menuControl.name } : {}) };
            await this.sendMenuResponse(adapter, channelName, msg, menuFailure(header, validationError));
            return;
          }
        }
        const resolvedChannelType = msg.channelType || parsedChannelKey?.type || effectiveChannelType;

        if (!menuControl.isMenu && selfAid && actorId) {
          await this.autoBindOwner(selfAid, channelKey, actorId);
        }

        if (!menuControl.isMenu) {
          const contactBind = handlePendingDingtalkContactBindMessage({
            selfAid,
            channelName: channelKey,
            channelType: resolvedChannelType,
            chatType,
            actorId,
            content,
          });
          if (contactBind.handled) {
            logger.info(`[MessageBridge] DingTalk contact bind handled: channel=${channelKey} actor=${actorId ?? '<none>'} status=${contactBind.status}`);
            if (contactBind.reply) {
              await sendReply(msg.channelId, contactBind.reply, msg.replyContext);
            }
            return;
          }
        }

        const roleDetail = this.resolveInboundRole({
          selfAid,
          channelKey,
          channelType: resolvedChannelType,
          chatType,
          actorId,
          conversationId,
          peerType: msg.peerType,
        });
        const authSubject = buildAuthSubject({
          selfAid,
          actorId,
          channel: channelName,
          channelType: resolvedChannelType,
          channelId: msg.channelId,
          chatType,
          conversationId,
          peerType: msg.peerType,
          roleDetail,
          fromControlChannel: msg.isControlChannel ?? false,
        });
        const identity = authSubject.identity;

        if (menuControl.isMenu) {
          await this.handleMenuControl(menuControl, channelName, effectiveChannelType, msg, adapter, authSubject);
          return;
        }

        // 普通消息保留原始日志；控制 payload 使用脱敏元数据日志。
        logger.channelIn({ channel: channelName, channelId: msg.channelId, peerId: msg.peerId, peerName: msg.peerName, chatType: msg.chatType, msgId: msg.messageId, threadId: msg.threadId, content, images: msg.images?.length ?? 0, mentions: msg.mentions, replyContext: msg.replyContext });

        const accessDecision = authorizeAccess(authSubject);
        if (!accessDecision.allow) {
          logger.warn(`[MessageBridge] Access denied before command routing: channel=${channelName} channelId=${msg.channelId} actor=${actorId ?? '<none>'} role=${identity.role} reason=${accessDecision.reason}`);
          await this.sendAccessDenied(adapter, channelName, msg, sendReply);
          return;
        }

        // 0. 仅阻止协议遥测进入 session / model / messages.jsonl；协议本身已在
        // channel/main/events/AUN/handoff 专用链路中处理和记录。
        // 注：menu.* 自定义消息已由上方 handleMenuControl 快速路径处理。
        if (isTransientProtocolMessage({
          msgType: msg.msgType ?? 'custom',
          payloadType: msg.payloadType,
        })) {
          logger.debug(`[MessageBridge] Transient protocol message ignored: channel=${channelName} type=${msg.payloadType || msg.msgType || '<unknown>'}`);
          return;
        }

        // 1. owner 绑定（按实例名绑定）
        if (adapter && actorId && roleDetail.effectiveRole === 'owner') {
          await this.bootstrapService?.tryStartBootstrap({
            adapter,
            channelKey,
            channelType: msg.channelType || effectiveChannelType,
            channelId: msg.channelId,
            recipientId: actorId,
            recipientName: msg.peerName,
            source: 'inbound',
          });
        }

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
            const inboundReplyTo = typeof msg.replyContext?.metadata?.refMessageId === 'string'
              ? msg.replyContext.metadata.refMessageId
              : null;
            appendMessageLog(chatDir, buildInboundEntry({
              from: msg.peerId || 'unknown',
              to: msg.selfAID || 'self',
              chatType: msg.chatType || 'private',
              groupId: msg.groupId ?? null,
              msgId: msg.messageId ?? null,
              content: msg.messageLogContent ?? content,
              replyTo: inboundReplyTo,
              permMode: null,
              timestamp: Date.now(),
              encrypt: inboundEncrypt,
              chatmode: inboundChatmode,
              peerName: msg.peerName,
              peerType: msg.peerType,
              msgType: msg.msgType,
              payloadType: msg.payloadType,
              payloadSummary: msg.payloadSummary,
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
          msg.replyContext, msg.messageId, msg.selfAID, identity
        )) return;

        // 3. session 解析（使用 Channel 层填充的 chatType）
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
        metadata.channelKey = channelKey;
        if (chatType === 'private' && msg.peerId) {
          metadata.peerId = msg.peerId;
          if (msg.peerName) metadata.peerName = msg.peerName;
          if (msg.peerType) metadata.peerType = msg.peerType;
        }
        if (chatType === 'group') {
          // 群聊：peerId 是当前消息发送者；groupId 在 channel 提供时存到 metadata
          if (msg.peerId) metadata.peerId = msg.peerId;
          if (msg.peerName) metadata.peerName = msg.peerName;
          if (msg.peerType) metadata.peerType = msg.peerType;
          if (msg.groupId) metadata.groupId = msg.groupId;
        }
        // Resolve effective project path: 用通道所属 agent 的 projectPath；
        // 通道找不到归属时退回到 globalConfig（一般是测试场景）
        const effectiveProjectPath = owningAgent?.projectPath
          ?? this.defaultProjectPath;

        const hadMainSession = msg.threadId ? true : this.sessionManager.hasMainSession(
          channelName,
          msg.channelId,
          msg.channelType || effectiveChannelType,
          msg.selfAID || selfAid,
        );
        let session = await this.sessionManager.getOrCreateSession(
          channelName, msg.channelId,
          effectiveProjectPath,
          msg.threadId, Object.keys(metadata).length ? metadata : undefined, this.extractTopicName(msg), msg.peerId, chatType,
          owningAgent?.baseagent, msg.selfAID, msg.channelType || effectiveChannelType,
          msg.peerType, identity
        );
        session = await this.alignSessionBaseagent(channelName, session);

        const replyToMessageId = typeof msg.replyContext?.metadata?.refMessageId === 'string'
          ? msg.replyContext.metadata.refMessageId
          : msg.replyContext?.replyToMessageId ?? null;
        const renewResult = await this.sessionRenewService.resolve({
          session,
          channelName,
          channelType: msg.channelType || effectiveChannelType,
          channelId: msg.channelId,
          selfAid: session.selfAID || selfAid,
          peerId: msg.peerId,
          groupId: msg.groupId,
          chatType,
          role: identity.role,
          content,
          replyToMessageId,
          isNewSession: !hadMainSession,
        });
        session = renewResult.session;

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

        const inboundEntry = (() => {
          const chatDir = this.sessionManager.getChatDir(session);
          const inboundEncrypt = msg.replyContext?.metadata?.encrypted != null ? !!(msg.replyContext.metadata.encrypted) : undefined;
          const inboundChatmode = msg.replyContext?.metadata?.chatmode as string | undefined;
          const inboundReplyTo = typeof msg.replyContext?.metadata?.refMessageId === 'string'
            ? msg.replyContext.metadata.refMessageId
            : null;
          return { chatDir, entry: buildInboundEntry({
            from: msg.peerId || 'unknown',
            to: msg.selfAID || 'self',
            sessionId: session.id,
            chatType,
            groupId: msg.groupId ?? null,
            msgId: msg.messageId ?? null,
            content: msg.messageLogContent ?? content,
            replyTo: inboundReplyTo,
            permMode: session.identity?.role ?? null,
            timestamp: fullMessage.timestamp,
            encrypt: inboundEncrypt,
            chatmode: inboundChatmode,
            peerName: msg.peerName,
            peerType: msg.peerType,
            msgType: msg.msgType,
            payloadType: msg.payloadType,
            payloadSummary: msg.payloadSummary,
          }) };
        })();

        let handoffCandidate = false;
        if (
          this.handoffRuntime &&
          chatType === 'private' &&
          (msg.channelType || effectiveChannelType) === 'aun' &&
          session.selfAID &&
          fullMessage.messageId
        ) {
          const refMessageId = typeof msg.replyContext?.metadata?.refMessageId === 'string'
            ? msg.replyContext.metadata.refMessageId
            : null;
          const bound = await this.handoffRuntime.bindReply({
            selfAid: session.selfAID,
            targetSessionId: session.id,
            responseMessageId: fullMessage.messageId,
            refMessageId,
            persistReply: () => appendMessageLogStrict(inboundEntry.chatDir, {
              ...inboundEntry.entry,
              handoff_trace: { version: 2, reply_candidate: true },
            }),
          });
          handoffCandidate = bound.candidate;
          if (bound.handoffId) {
            fullMessage.handoffDelivery = { direction: 'target', handoffId: bound.handoffId };
          }
        }
        if (!handoffCandidate) appendMessageLog(inboundEntry.chatDir, inboundEntry.entry);

        // 6. ACK + debounce/enqueue
        //    ACK 在到达时立即做（每条独立 ACK），不等合并
        //    Interrupt 模式（单聊）→ 入队前 debounce 合并
        //    FIFO 模式（群聊）    → 跳过 debouncer，独立入队，出队时贪心合并
        //    优化：队列空闲时跳过 Pin 表情，直接在开始执行时添加 CheckMark
        if (fullMessage.messageId && this.messageQueue.getGlobalProcessingCount() > 0) {
          adapter?.acknowledge?.(fullMessage.messageId).catch(() => {});
        }

        const isInterrupt = chatType !== 'group' && !handoffCandidate;
        const enqueueAgentName = owningAgent?.name ?? '<unknown>';
        const selfAID = session.selfAID;
        const doEnqueue = async (m: Message) => {
          const enqueue = handoffCandidate ? this.messageQueue.enqueuePersisted.bind(this.messageQueue) : this.messageQueue.enqueue.bind(this.messageQueue);
          try {
            return await enqueue(session.id, m, session.projectPath, {
            interruptible: isInterrupt,
            interruptSamePeer: !isInterrupt,  // 群聊：同人连发且队列无他人时打断
            agentName: enqueueAgentName,
            role: !isInterrupt ? (session.identity?.role ?? 'none') : undefined,
            sessionKeyField: session.sessionKey,
            selfAID,  // ← 传递 selfAID，用于队列隔离
            });
          } catch (error) {
            if (handoffCandidate && m.handoffDelivery?.handoffId && session.selfAID) {
              this.handoffRuntime?.markBindingIncomplete(session.selfAID, m.handoffDelivery.handoffId);
            }
            throw error;
          }
        };

        if (handoffCandidate) {
          await doEnqueue(fullMessage);
        } else if (isInterrupt) {
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
    capability: '/capability',
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
    if (!mapped) throw { code: 'NOT_SUPPORTED', message: `Unsupported menu name: ${name}` };
    return mapped;
  }

  private async handleMenuControl(
    parsed: Extract<ParsedMenuControl, { isMenu: true }>,
    channel: string,
    channelType: string,
    msg: InboundMessage,
    adapter: ChannelAdapter | undefined,
    authSubject: AuthSubject,
  ): Promise<void> {
    if (!hasValidMenuId(parsed)) return;
    const header = { id: parsed.id, ...(parsed.name?.trim() ? { name: parsed.name } : {}) };
    const access = authorizeAccess(authSubject);
    if (!access.allow) {
      this.logMenuDiagnostic('access-denied', channel, msg, parsed, access.code);
      await this.sendMenuResponse(adapter, channel, msg, menuFailure(header, {
        code: 'ROLE_ACCESS_DENIED',
        message: access.reason,
      }));
      return;
    }

    const scope = msg.chatType === 'group' ? (msg.groupId || msg.channelId) : msg.peerId;
    const dedupKey = [msg.selfAID || channel, channelType, msg.chatType || 'private', scope, msg.peerId, parsed.id].join('\u001f');
    const deduped = await this.menuDeduper.execute(
      dedupKey,
      menuPayloadFingerprint(parsed.raw),
      () => this.dispatchMenuRequest(parsed.request, header, channel, msg, authSubject.identity),
    );
    if ('conflict' in deduped) {
      this.logMenuDiagnostic('request-conflict', channel, msg, parsed, 'CONFLICT');
      await this.sendMenuResponse(adapter, channel, msg, menuFailure(header, {
        code: 'CONFLICT',
        message: 'Request ID was already used with a different payload',
      }));
      return;
    }
    if (deduped.replayed) this.logMenuDiagnostic('request-replay', channel, msg, parsed);
    await this.sendMenuResponse(adapter, channel, msg, deduped.value);
  }

  private async dispatchMenuRequest(
    request: Record<string, unknown>,
    header: { id: string; name?: string },
    channel: string,
    msg: InboundMessage,
    identity: SessionIdentity,
  ): Promise<MenuResponse> {
    try {
      const name = header.name ?? '';
      const cmd = typeof request.cmd === 'string' ? request.cmd : undefined;
      const args = request.args as Record<string, any> | undefined;
      switch (request.type) {
        case 'menu.list':
          return menuSuccess(header, this.cmdHandler.getMenuItems(
            identity.role,
            msg.chatType || 'private',
            msg.isControlChannel ? 'control' : 'agent',
          ));
        case 'menu.query': {
          const result = await this.cmdHandler.execMenuQuery(
            this.resolveCmd(name, cmd), channel, msg.channelId, msg.peerId, args,
            msg.chatType, msg.isControlChannel ?? false, identity,
          );
          if ('error' in result) throw result;
          return menuSuccess(header, result.data);
        }
        case 'menu.options': {
          const data = await this.cmdHandler.getSubMenuItems(
            this.resolveCmd(name, cmd), channel, msg.channelId, msg.peerId, args,
            identity, msg.chatType, msg.isControlChannel ?? false,
          ) ?? [];
          return menuSuccess(header, data);
        }
        case 'menu.update': {
          const result = await this.cmdHandler.execMenuUpdate(
            this.resolveCmd(name, cmd), request.value as string, channel, msg.channelId,
            msg.peerId, identity, msg.isControlChannel ?? false, args,
          );
          if ('error' in result) throw result;
          return menuSuccess(header, result.data);
        }
        case 'menu.action': {
          const result = await this.cmdHandler.execMenuAction(
            this.resolveCmd(name, cmd), request.action as string, args, channel,
            msg.channelId, msg.peerId, identity, msg.chatType, header.id,
            msg.isControlChannel ?? false,
          );
          if ('error' in result) throw result;
          return menuSuccess(header, result.data);
        }
        default:
          return menuFailure(header, {
            code: 'METHOD_NOT_FOUND',
            message: `Unknown menu request type: ${String(request.type)}`,
          });
      }
    } catch (error) {
      return menuFailure(header, normalizeMenuError(error));
    }
  }

  private async sendMenuResponse(
    adapter: ChannelAdapter | undefined,
    channel: string,
    msg: InboundMessage,
    response: MenuResponse,
  ): Promise<void> {
    if (!adapter?.send) {
      this.logMenuDiagnostic('transport-unavailable', channel, msg, {
        isMenu: true,
        raw: '',
        request: {},
        type: 'menu.response',
        id: response.id,
        name: response.name,
      }, 'TEMPORARILY_UNAVAILABLE');
      return;
    }
    const agentName = this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>';
    const envelope = buildEnvelope({
      taskId: `menu-${randomBytes(4).toString('hex')}`,
      channel,
      channelId: msg.channelId,
      agentName,
      replyContext: msg.replyContext,
    });
    await adapter.send(envelope, { kind: 'custom', channelType: channel, payload: response });
  }

  private logMenuInbound(
    channel: string,
    msg: InboundMessage,
    parsed: Extract<ParsedMenuControl, { isMenu: true }>,
  ): void {
    logger.channelIn({
      channel,
      channelId: this.shortHash(msg.channelId),
      peerId: this.shortHash(msg.peerId),
      chatType: msg.chatType,
      msgId: msg.messageId,
      control: {
        id: parsed.id,
        type: parsed.type,
        name: parsed.name,
        action: parsed.action,
      },
    });
  }

  private logMenuDiagnostic(
    category: string,
    channel: string,
    msg: InboundMessage,
    parsed: Extract<ParsedMenuControl, { isMenu: true }>,
    code?: string,
  ): void {
    const scope = msg.chatType === 'group' ? (msg.groupId || msg.channelId) : msg.peerId;
    const key = `${category}:${channel}:${this.shortHash(scope)}`;
    const decision = this.menuDiagnostics.check(key);
    if (!decision.log) return;
    logger.warn(
      `[MenuControl] category=${category} request=${parsed.id || '<missing>'}`
      + ` type=${parsed.type} name=${parsed.name || '<none>'} action=${parsed.action || '<none>'}`
      + ` transport=${channel} scope=${this.shortHash(scope)} sender=${this.shortHash(msg.peerId)}`
      + `${code ? ` code=${code}` : ''}${decision.suppressed ? ` suppressed=${decision.suppressed}` : ''}`,
    );
  }

  private shortHash(value?: string): string {
    if (!value) return 'none';
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }

  private async sendAccessDenied(
    adapter: ChannelAdapter | undefined,
    channel: string,
    msg: InboundMessage,
    sendReply: (channelId: string, text: string, replyContext?: ReplyContext) => Promise<void>,
  ): Promise<void> {
    const text = 'Access denied: this role is not allowed to access this agent.';
    if (adapter?.send) {
      const envelope = buildEnvelope({
        taskId: `access-denied-${randomBytes(4).toString('hex')}`,
        channel,
        channelId: msg.channelId,
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>',
        chatmode: 'interactive',
        replyContext: msg.replyContext,
      });
      await adapter.send(envelope, {
        kind: 'system.error',
        text,
        subtype: 'access_denied',
        recoverable: false,
      });
      return;
    }
    await sendReply(msg.channelId, text, msg.replyContext);
  }

  private async autoBindOwner(selfAid: string, channelKey: string, userId: string): Promise<void> {
    if (hasStaticAgentOwner(selfAid)) return;
    addStaticAgentOwner(selfAid, userId);
    logger.info(`[Owner] Auto-bound ${channelKey} owner: ${userId}`);
    this.eventBus.publish({ type: 'channel:owner-bound', channel: channelKey, userId });
  }

  private resolveInboundRole(ctx: {
    selfAid?: string;
    channelKey: string;
    channelType: string;
    chatType: 'private' | 'group';
    actorId?: string;
    conversationId?: string;
    peerType?: string;
  }): ResolvedPeerRole {
    if (!ctx.selfAid || !ctx.actorId || !ctx.conversationId) {
      return {
        effectiveRole: null,
        source: 'none',
        isAuthenticated: false,
        allowAccess: false,
        roleExists: false,
      };
    }
    return resolvePeerRoleDetail({
      selfAid: ctx.selfAid,
      channelType: ctx.channelType,
      chatType: ctx.chatType,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
      peerType: ctx.peerType,
    });
  }

  /** 命令快速路径：返回 true 表示已处理 */
  private async handleCommand(
    content: string, channel: string, channelId: string,
    sendReply: (text: string) => Promise<void>,
    userId?: string, threadId?: string, chatType?: string, source?: 'user' | 'card-trigger',
    replyContext?: ReplyContext, messageId?: string, selfAID?: string,
    identity?: SessionIdentity,
  ): Promise<boolean> {
    if (!this.cmdHandler.isCommand(content)) return false;
    logger.info(`[${channel}] ${channelId}: ${content}${source === 'card-trigger' ? ' [card]' : ''}`);
    const cmdResult = await this.cmdHandler.handle(content, channel, channelId,
      (_cid, text, opts) => sendReply(text),
      userId, threadId, chatType, source, messageId, selfAID, identity);
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
