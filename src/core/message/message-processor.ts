import path from 'path';
import fs from 'fs';
import { type AgentRunnerFull, hasCompact, type AgentEvent } from '../../agents/claude-runner.js';
import { SessionManager } from '../session/session-manager.js';
import { StreamFlusher } from './stream-flusher.js';
import { ThoughtEmitter } from './thought-emitter.js';
import { MessageCache } from './message-cache.js';
import type { MessageQueue } from './message-queue.js';
import { StreamIdleMonitor } from './stream-idle-monitor.js';
import { logger } from '../../utils/logger.js';
import { getErrorMessage, classifyError, ErrorType, ERROR_PREFIX, isInfraError, prefixErrorType, isRetryableError } from '../../utils/error-utils.js';
import { EventBus } from '../event-bus.js';
import { summarizeToolInput } from '../permission.js';
import type { Message, Config, Session, ChannelAdapter, ChannelOptions, ChannelPolicy, CommandHandler } from '../../types.js';
import { getOwner } from '../../config.js';
import { getPackageRoot, resolveRoot } from '../../paths.js';
import type { InteractionRouter } from '../interaction-router.js';

/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class MessageProcessor {
  private channels = new Map<string, { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy }>();
  private channelTypeMap = new Map<string, string>();  // channelType → channelName（首个实例）
  private currentFlusher?: StreamFlusher;
  private shouldSuppressActivities = false;
  private agentMap: Map<string, AgentRunnerFull>;
  private defaultAgentId: string;
  private interruptedSessions = new Map<string, string>();  // sessionId → reason ('new_message' | 'stop' | ...)
  private interactionRouter?: InteractionRouter;
  private messageQueue?: MessageQueue;
  private skillsHintDesc: string | null | undefined = undefined; // undefined=未加载, null=无模板, string=缓存描述
  private skillsEnsured = false; // 全局 SKILLS.md 是否已确保

  /** 按 agentId 获取 agent，回退到默认 */
  getAgent(agentId?: string): AgentRunnerFull {
    if (agentId && this.agentMap.has(agentId)) return this.agentMap.get(agentId)!;
    return this.agentMap.get(this.defaultAgentId) || this.agentMap.values().next().value!;
  }

  /** 获取可用 agent 列表 */
  getAvailableAgents(): string[] {
    return [...this.agentMap.keys()];
  }

  /** 判断是否为后台会话（仅主会话参与判断，话题会话独立） */
  private async isBackgroundSession(session: Session, channel: string, channelId: string): Promise<boolean> {
    if (session.threadId) return false;
    const active = await this.sessionManager.getActiveSession(channel, channelId);
    return active ? session.id !== active.id : false;
  }

  constructor(
    agentRunnerOrMap: AgentRunnerFull | Map<string, AgentRunnerFull>,
    private sessionManager: SessionManager,
    private config: Config,
    private messageCache: MessageCache,
    private eventBus: EventBus,
    private commandHandler?: CommandHandler,
    defaultAgentId?: string
  ) {
    if (agentRunnerOrMap instanceof Map) {
      this.agentMap = agentRunnerOrMap;
      this.defaultAgentId = defaultAgentId || 'claude';
    } else {
      // 向后兼容：单个 agentRunner
      this.agentMap = new Map([[agentRunnerOrMap.name, agentRunnerOrMap]]);
      this.defaultAgentId = agentRunnerOrMap.name;
    }

    // 监听中断事件，标记被中断的 session
    this.eventBus.subscribe('message:interrupted', (event) => {
      if ('sessionId' in event && event.sessionId) {
        this.interruptedSessions.set(event.sessionId as string, (event as any).reason || 'unknown');
      }
    });
  }

  setInteractionRouter(router: InteractionRouter): void {
    this.interactionRouter = router;
  }

  setMessageQueue(queue: MessageQueue): void {
    this.messageQueue = queue;
  }

  /**
   * 注册渠道适配器
   */
  registerChannel(adapter: ChannelAdapter, policy: ChannelPolicy, options?: ChannelOptions): void {
    this.channels.set(adapter.channelName, { adapter, options, policy });
    // 维护 channelType → channelName 映射（首个实例优先）
    const type = options?.channelType || adapter.channelName;
    if (!this.channelTypeMap.has(type)) {
      this.channelTypeMap.set(type, adapter.channelName);
    }
  }

  /**
   * 获取渠道适配器（支持实例名和 channelType）
   */
  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.resolveChannelInfo(channelName)?.adapter;
  }

  /**
   * 获取渠道信息（含 policy，支持实例名和 channelType）
   */
  getChannelInfo(channelName: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined {
    return this.resolveChannelInfo(channelName);
  }

  /**
   * 处理 compact 开始事件
   */
  handleCompactStart(sessionId?: string): void {
    if (sessionId) {
      this.eventBus.publish({ type: 'agent:compact-start', sessionId });
    }
    if (this.currentFlusher && !this.shouldSuppressActivities) {
      this.currentFlusher.addActivity('\u23f3 会话压缩中...');
    }
  }

  /**
   * 根据 channel 标识查找渠道信息
   * 先按实例名精确匹配，再按 channelType 映射到实例名
   */
  private resolveChannelInfo(channel: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined {
    // 1. 精确匹配实例名
    let info = this.channels.get(channel);
    if (info) return info;
    // 2. 按 channelType 查找（兼容按类型名路由）
    const instanceName = this.channelTypeMap.get(channel);
    if (instanceName) info = this.channels.get(instanceName);
    return info;
  }

  // 命令前缀列表（与 CommandHandler.quickCommandPrefixes 保持同步）
  private static readonly COMMAND_PREFIXES = [
    '/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart',
    '/model', '/effort', '/agent', '/slist', '/session', '/rename', '/repair', '/fork',
    '/stop', '/clear', '/compact', '/safe', '/del', '/perm', '/file', '/check',
    '/p ', '/s ', '/name ',
  ];

  /** 判断消息内容是否为已知命令 */
  private isKnownCommand(content: string): boolean {
    return content === '/p' || content === '/s' ||
      MessageProcessor.COMMAND_PREFIXES.some(cmd => content.startsWith(cmd));
  }

  /**
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
    const idleMs = (this.config.idleMonitor?.timeout ?? 120) * 1000;

    // 先解析会话，再优先用 session.metadata.channelName 精确定位实例级 adapter
    // message.channel 现在存实例名（channelName），可直接用于精确路由
    const { session, absoluteProjectPath } = await this.resolveSession(message);
    const channelKey = session.metadata?.channelName || message.channel;
    const channelInfo = this.resolveChannelInfo(channelKey);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${channelKey}`);
      return;
    }

    const { policy } = channelInfo;
    const streamKey = session.id;
    const chatType = message.chatType || 'private';
    const identityRole = session.identity?.role || 'anonymous';

    // 按 session.agentId 选择 agent 后端
    const agent = this.getAgent(session.agentId);

    const monitorEnabled = this.config.idleMonitor?.enabled !== false;
    const showIdleMonitor = policy.showIdleMonitor(chatType, identityRole);

    // 计算是否抑制中间输出（工具活动 + 流式文本）
    const shouldSuppress = (): boolean => {
      return !policy.showMiddleResult(chatType, identityRole);
    };
    this.shouldSuppressActivities = shouldSuppress();

    let monitor: StreamIdleMonitor | undefined;
    let monitorInterval: ReturnType<typeof setInterval> | undefined;
    let rejectFn: (err: Error) => void;

    const resetTimer = (eventType?: string, toolName?: string) => {
      monitor?.recordEvent(eventType || 'unknown', toolName);
    };

    // Cache background status to avoid async call inside setInterval
    const isBackground = await this.isBackgroundSession(session, message.channel, message.channelId);

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      if (!monitorEnabled) return;

      monitor = new StreamIdleMonitor(idleMs);
      monitorInterval = setInterval(() => {
        // Drain all pending levels in one tick
        let result = monitor!.check();
        while (result) {
          if (result.action === 'kill') {
            logger.warn(`[MessageProcessor] Idle monitor: kill after ${result.idleSec}s idle, stream: ${streamKey}`);
            this.eventBus.publish({ type: 'agent:idle-timeout', sessionId: streamKey, idleSec: result.idleSec });
            // 后台任务也需要中断（释放资源），但不发送通知
            if (channelInfo && !isBackground) {
              const msg = showIdleMonitor
                ? result.message
                : `\u26a0\ufe0f 任务超时（${result.idleSec}秒无响应），已自动中断`;
              channelInfo.adapter.sendText(message.channelId, msg, this.getReplyContext(message)).catch(e => {
                logger.debug(`[MessageProcessor] Failed to send kill diagnostic message:`, e);
              });
            }
            agent.interrupt(streamKey).catch(e => {
              logger.debug(`[MessageProcessor] Interrupt failed (may already be cleaned up):`, e);
            });
            rejectFn(new Error('SDK_TIMEOUT'));
            return;
          } else {
            // notify or warn: send diagnostic message, task continues
            logger.info(`[MessageProcessor] Idle monitor: ${result.action} after ${result.idleSec}s idle, stream: ${streamKey}`);
            if (channelInfo && showIdleMonitor && !shouldSuppress()) {
              if (!isBackground) {
                channelInfo.adapter.sendText(message.channelId, result.message, this.getReplyContext(message)).catch(e => {
                  logger.debug(`[MessageProcessor] Failed to send idle monitor message:`, e);
                });
              }
            }
          }
          result = monitor!.check();
        }
      }, 30000);
    });

    try {
      await Promise.race([
        this._processMessageInternal(message, session, absoluteProjectPath, resetTimer, shouldSuppress),
        timeoutPromise
      ]);
    } catch (error: any) {
      // 超时错误：kill 级别已发送诊断信息，无需再发
      // 非超时错误走通用处理

      // 记录错误到健康状态（复用已有 session）
      if (channelInfo) {
        try {
          const errorType = classifyError(error);

          // 上下文过长是可恢复错误，不累计错误计数
          if (errorType === ErrorType.CONTEXT_TOO_LONG) {
            logger.info(`[MessageProcessor] Context too long error, skipping error accumulation`);
          // 认证错误（401 / Invalid API Key）不是会话问题，不累计
          } else if (errorType === ErrorType.AUTH_ERROR) {
            logger.info(`[MessageProcessor] Auth error (invalid API key), skipping error accumulation`);
          // API 错误（5xx / 算力池切换等）是平台暂时性问题，不累计
          } else if (errorType === ErrorType.API_ERROR) {
            logger.info(`[MessageProcessor] API error, skipping error accumulation`);
          } else if (!policy.accumulateErrors(chatType, identityRole)) {
            logger.info(`[MessageProcessor] Non-accumulating error (chatType=${chatType}, identity=${identityRole}), skipping error accumulation`);
          } else {
            const prefixed = prefixErrorType(ERROR_PREFIX.INFRA, errorType);
            await this.sessionManager.recordError(session.id, prefixed, error.message);
          }
        } catch (statusError) {
          logger.error('[MessageProcessor] Failed to update health status:', statusError);
        }
      }

      throw error;
    } finally {
      if (monitorInterval) clearInterval(monitorInterval);
    }
  }

  /** 获取回复上下文（跟着任务走） */
  private getReplyContext(message: Message): import('../../types.js').ReplyContext | undefined {
    return message.replyContext;
  }

  /** 自动安全模式已禁用：仅保留错误计数，不再自动切换状态 */
  private async _processMessageInternal(message: Message, session: Session, absoluteProjectPath: string, resetTimer: (eventType?: string, toolName?: string) => void, shouldSuppress: () => boolean): Promise<void> {
    const messageId = `${message.channel}_${message.channelId}_${message.timestamp || Date.now()}`;
    const channelKey = session.metadata?.channelName || message.channel;
    const channelInfo = this.resolveChannelInfo(channelKey);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${channelKey}`);
      return;
    }

    // 二次拦截：如果命令消息绕过 MessageBridge 的 handleCommand 泄漏到这里，
    // 静默丢弃而不是发送给 Agent（命令已在 MessageBridge 层处理过）
    const rawContent = message.content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
    if (rawContent.startsWith('/') && this.isKnownCommand(rawContent)) {
      logger.warn(`[MessageProcessor] Command leaked past MessageBridge, dropped: "${rawContent.substring(0, 40)}"`);
      return;
    }

    const { adapter, options } = channelInfo;
    const agent = this.getAgent(session.agentId);
    const streamKey = session.id;

    // ThoughtEmitter new-inbound 订阅句柄（在 try/catch 外声明，确保 catch 可访问）
    let thoughtNewInboundHandler: ((event: any) => void) | null = null;

    try {
      const isBackground = await this.isBackgroundSession(session, message.channel, message.channelId);

      // 记录收到消息
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'received'
      });

      this.eventBus.publish({
        type: 'message:received',
        sessionId: session.id,
        channel: message.channel,
        channelId: message.channelId,
        content: message.content,
        timestamp: Date.now()
      });

      const imageInfo = message.images && message.images.length > 0 ? ` [${message.images.length} image(s)]` : '';
      const modeInfo = isBackground ? ' [\u540e\u53f0]' : '';
      logger.info(`[${message.channel}] ${message.channelId}: ${message.content}${imageInfo}${modeInfo}`);
      logger.info(`[MessageProcessor] session=${session.id} chatType=${session.chatType} sessionMode=${session.sessionMode} agentId=${session.agentId} msgChatType=${message.chatType ?? 'n/a'}`);

      // 记录开始处理
      this.eventBus.publish({ type: 'message:processing', sessionId: session.id });
      adapter.sendProcessingStatus?.(message.channelId, 'start', session.id, this.getReplyContext(message));

      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'processing'
      });

      const startTime = Date.now();

      // 创建 StreamFlusher，传入文件标记模式用于自动过滤
      // 使用动态判断，确保切换项目后不会继续输出
      let firstReply = true;
      const isProactive = session.sessionMode === 'proactive';
      const flusher = new StreamFlusher(
        async (text, isFinal, hasText) => {
          const isCurrentlyBackground = await this.isBackgroundSession(session, message.channel, message.channelId);

          if (!isCurrentlyBackground) {
            const opts: { title?: string; replyToMessageId?: string; mentionUserIds?: string[]; replyInThread?: boolean } = {};
            if (isFinal) opts.title = '\u2713 \u6700\u7ec8\u56de\u590d:';
            // replyContext 跟着任务走：优先用当前 message 的，兜底用 session 的（话题会话创建时写入）
            const replyCtx = this.getReplyContext(message);
            if (replyCtx) {
              Object.assign(opts, replyCtx);
            } else if (firstReply && message.messageId) {
              // 主会话：首条消息引用回复用户原消息（只在含真实文字时消费）
              if (hasText) {
                opts.replyToMessageId = message.messageId;
                firstReply = false;
              }
            }
            await adapter.sendText(message.channelId, text, Object.keys(opts).length ? opts : undefined);
          }
          // 后台任务：静默，不发送输出
        },
        (options?.flushDelay ?? this.config.flushDelay ?? 3) * 1000,
        options?.fileMarkerPattern,
        this.config.debug?.flusherDiag,
        isProactive
      );

      // 保存当前 flusher，用于 compact 事件
      this.currentFlusher = flusher;

      // Proactive 模式可观测：创建 ThoughtEmitter，将静默的流式事件转发为 thought
      let thoughtEmitter: ThoughtEmitter | null = null;
      if (isProactive && adapter.putThought && message.messageId) {
        thoughtEmitter = new ThoughtEmitter(adapter, message.channelId, message.messageId);
        // 订阅 new-inbound 事件：新消息到达时切换锚定 messageId
        thoughtNewInboundHandler = (ev: any) => {
          if (
            ev.type === 'message:new-inbound' &&
            ev.sessionId === session.id &&
            ev.channelId === message.channelId &&
            ev.messageId
          ) {
            thoughtEmitter?.updateReplyTo(ev.messageId);
          }
        };
        this.eventBus.subscribe('message:new-inbound', thoughtNewInboundHandler);
      }

      // 调用 AgentRunner（含上下文过长自动 compact 重试）

      // 捕获当前消息的上下文（闭包），避免后续消息处理时串台
      const capturedChannelId = message.channelId;
      const capturedReplyContext = this.getReplyContext(message);

      // 设置权限审批的消息发送回调（指向当前渠道）
      agent.setSendPrompt(async (text: string) => {
        await adapter.sendText(capturedChannelId, text, capturedReplyContext);
      });

      // 设置权限审批的交互上下文（支持交互卡片）
      agent.setPermissionContext?.(session.id, {
        adapter,
        channelId: capturedChannelId,
        replyContext: capturedReplyContext,
        interactionRouter: this.interactionRouter,
        interceptNextMessage: this.messageQueue
          ? (sessionKey, handler) => this.messageQueue!.interceptNext(sessionKey, handler)
          : undefined,
        cancelIntercept: this.messageQueue
          ? (sessionKey) => this.messageQueue!.cancelIntercept(sessionKey)
          : undefined,
      });

      // 设置 per-session 权限模式（动态默认值：owner → bypass，admin → auto，guest → readonly）
      const role = session.identity?.role;
      const defaultPermMode = role === 'owner' ? 'bypass' : role === 'admin' ? 'auto' : 'readonly';
      agent.setMode(session.metadata?.permissionMode ?? defaultPermMode);

      // 标记会话为处理中（实时持久化，重启后可恢复）
      this.sessionManager.markProcessing(session.id);

      // 检查是否因新消息自动中断 — 包装 prompt 让 Agent 知道上下文
      const prevInterruptReason = this.interruptedSessions.get(session.id);
      this.interruptedSessions.delete(session.id);
      const effectivePrompt = prevInterruptReason === 'new_message' && session.agentSessionId
        ? `【新消息插入】\n\n${message.content}\n\n【请无视之前中断继续处理】`
        : message.content;

      let streamResult: { isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean } = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };

      try {
        // 动态构建运行时上下文提示
        const contextParts: string[] = [];
        const currentChannelType = options?.channelType || message.channel;

        // 1. 当前环境信息
        const peerLabel = session.identity?.role || 'unknown';
        const peerName = message.peerName || session.metadata?.peerName;
        const peerType = message.peerType;
        const envParts = [
          `会话通道: ${currentChannelType}`,
          `当前项目: ${path.basename(absoluteProjectPath)}`,
        ];
        if (session.name) envParts.push(`会话名称: ${session.name}`);
        envParts.push(`对端身份: ${peerLabel}`);
        if (peerName) envParts.push(`对端名称: ${peerName}`);
        if (peerType && peerType !== 'unknown') envParts.push(`对端类型: ${peerType}`);
        if (session.chatType) envParts.push(`聊天类型: ${session.chatType}`);
        if (session.agentId && session.agentId !== 'claude') envParts.push(`当前Agent: ${session.agentId}`);
        contextParts.push(`[当前环境] ${envParts.join(' | ')}`);

        // 只读模式提示
        if (session.metadata?.permissionMode === 'readonly') {
          const sendHint = isProactive
            ? '使用 evolclaw ctl file 发送'
            : '使用 [SEND_FILE:] 发送';
          contextParts.push(`[只读模式] 禁止修改项目文件。如需生成文件供用户下载，请写入 .evolclaw/tmp/ 目录后${sendHint}`);
        }

        // 2. 文件发送能力（按 channelType 去重，提示词只展示第一级通道名）
        // proactive 模式：不推送 [SEND_FILE:] 提示，统一通过 evolclaw ctl file 显式发送（与 ctl send 契约一致）
        if (!isProactive) {
          const fileChannelTypes = new Set<string>();
          const currentCanSend = !!channelInfo.adapter.sendFile;
          for (const [, info] of this.channels) {
            if (info.adapter.sendFile) {
              fileChannelTypes.add(info.options?.channelType || info.adapter.channelName);
            }
          }
          const crossChannelTypes = [...fileChannelTypes].filter(t => t !== currentChannelType);
          if (currentCanSend || crossChannelTypes.length > 0) {
            const hints: string[] = [];
            if (currentCanSend) hints.push(`[SEND_FILE:路径] 发送文件到当前通道`);
            if (crossChannelTypes.length > 0) hints.push(`[SEND_FILE:${crossChannelTypes[0]}:路径] 发送文件到指定通道（可用: ${crossChannelTypes.join('/')}）`);
            contextParts.push(hints.join('，'));
          }
        }

        // 3. 当前通道能力
        const capParts: string[] = [];
        if (options?.supportsImages) capParts.push('图片输入');
        if (channelInfo.adapter.sendImage) capParts.push('图片输出');
        if (channelInfo.adapter.sendFile) capParts.push('文件发送');
        if (capParts.length > 0) {
          contextParts.push(`[通道能力] ${capParts.join('、')}`);
        }

        // 4. 群聊 @ 规则：告知 agent 应该 @ 谁，由 agent 自行在回复中添加
        if (message.chatType === 'group' && message.peerId) {
          contextParts.push(`[群聊回复规则] 回复时必须在开头添加 @${message.peerId} 来通知对方`);
        }

        // 5. Agent ctl 自管理指令提示 + SKILLS.md 生成
        if (!this.skillsEnsured) {
          this.ensureSkillsFile();
          this.skillsEnsured = true;
        }
        const skillsHint = this.getSkillsHint();
        if (skillsHint) {
          contextParts.push(`[EvolClaw 自管理] ${skillsHint}`);
        }

        // 6. Proactive 模式提示词：agent 的输出不会自动发送，必须主动调用 ctl send/file
        if (isProactive) {
          contextParts.push(
            '[Proactive 模式] 本次对话中你的流式输出不会自动发送给用户，必须通过以下命令主动发送：\n' +
            '- 发送文本：evolclaw ctl send "<消息内容>"\n' +
            '- 发送文件：evolclaw ctl file <路径>\n' +
            '可多次调用。如不调用，用户将看不到任何回复。'
          );
        }

        const effectiveSystemPrompt = [options?.systemPromptAppend, ...contextParts].filter(Boolean).join('\n') || undefined;

        // 可重试错误（403/429/5xx）指数退避重试，最多 3 次
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          let streamRegistered = false;
          try {
            const stream = await agent.runQuery(
              session.id,
              effectivePrompt,
              absoluteProjectPath,
              session.agentSessionId,
              message.images,
              effectiveSystemPrompt,
              this.sessionManager
            );
            agent.registerStream(streamKey, stream);
            streamRegistered = true;

            streamResult = await this.processEventStream(
              stream,
              session,
              flusher,
              resetTimer,
              shouldSuppress,
              thoughtEmitter
            );
            break; // 成功，跳出重试循环
          } catch (retryError) {
            if (streamRegistered) {
              agent.cleanupStream(streamKey);
            }
            if (attempt < MAX_RETRIES && isRetryableError(retryError)) {
              const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
              logger.warn(`[MessageProcessor] Retryable error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms:`, retryError);
              flusher.addActivity(`⚠️ API 暂时不可用，${delay / 1000}秒后重试 (${attempt}/${MAX_RETRIES})...`);
              await flusher.flush();
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            throw retryError; // 不可重试或已耗尽重试次数
          }
        }
      } catch (error) {
        if (classifyError(error) === ErrorType.CONTEXT_TOO_LONG && session.agentSessionId && hasCompact(agent)) {
          // 尝试 compact 压缩会话
          flusher.addActivity('\u26a0\ufe0f 上下文过长，正在压缩会话...');
          await flusher.flush();

          const compacted = await agent.compact(
            session.id, session.agentSessionId, absoluteProjectPath
          );

          if (compacted) {
            // compact 成功，带 resume 重试（不重复原始消息，让 Agent 继续未完成的工作）
            flusher.addActivity('\u2705 压缩完成，正在重试...');
            const retryStream = await agent.runQuery(
              session.id,
              '上下文已自动压缩，请继续之前未完成的任务。',
              absoluteProjectPath,
              session.agentSessionId,
              undefined,
              options?.systemPromptAppend,
              this.sessionManager
            );
            agent.registerStream(streamKey, retryStream);

            streamResult = await this.processEventStream(
              retryStream,
              session,
              flusher,
              resetTimer,
              shouldSuppress,
              thoughtEmitter
            );
          } else {
            throw new Error('CONTEXT_COMPACT_FAILED');
          }
        } else {
          throw error;
        }
      }

      // 处理文件标记 - 支持 [SEND_FILE:path] 和 [SEND_FILE:channel:path]
      // 注意：始终扫描全部文本（含中间轮），因为文件标记可能出现在任意轮次
      // suppressed 模式下 flusher 只有最后一轮文本，需要用 streamResult.fullText（SDK 全文）兜底
      // proactive 模式：agent 主动调用 ctl file 发送文件，跳过标记处理
      if (!isProactive) {
        const FILE_MARKER_RE = /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g;
        const markerPattern = options?.fileMarkerPattern ?? FILE_MARKER_RE;
        const flusherText = flusher.getFinalText();
        const fullText = flusherText.length >= (streamResult.fullText?.length || 0) ? flusherText : streamResult.fullText;
        const fileMatches = [...fullText.matchAll(markerPattern)];

      for (const match of fileMatches) {
        // 兼容旧格式 (1组) 和新格式 (2组)
        const hasChannelGroup = match.length >= 3;
        const targetSpec = hasChannelGroup ? (match[1] ?? undefined) : undefined;
        const filePath = (hasChannelGroup ? match[2] : match[1]).trim();

        if (this.isPlaceholderPath(filePath)) {
          logger.info(`[${adapter.channelName}] Skipped placeholder file marker: [SEND_FILE:${filePath}]`);
          continue;
        }

        // 解析目标：按实例名匹配，再按 channelType 映射
        let targetInfo = targetSpec ? this.channels.get(targetSpec) : channelInfo;
        let targetLabel = targetSpec || message.channel;
        if (targetSpec && !targetInfo) {
          // 按 channelType 查找首个匹配的实例
          const instanceName = this.channelTypeMap.get(targetSpec);
          if (instanceName) targetInfo = this.channels.get(instanceName);
        }
        const currentChannelType = channelInfo.options?.channelType || adapter.channelName;
        const isCrossChannel = targetSpec && targetSpec !== message.channel
          && targetSpec !== currentChannelType;

        // 跨通道仅限 owner
        if (isCrossChannel && session.identity?.role !== 'owner') {
          await adapter.sendText(message.channelId, `\u274c 跨通道发送仅限管理员`, this.getReplyContext(message));
          continue;
        }

        const resolvedPath = this.resolveFilePath(filePath, absoluteProjectPath);
        if (!fs.existsSync(resolvedPath)) {
          logger.warn(`[${adapter.channelName}] File not found: ${resolvedPath}`);
          await adapter.sendText(message.channelId, `\u26a0\ufe0f 文件未找到: ${filePath}`, this.getReplyContext(message));
          continue;
        }

        // 找目标 adapter
        if (!targetInfo) {
          await adapter.sendText(message.channelId, `\u274c 通道 ${targetLabel} 未启用或不存在`, this.getReplyContext(message));
          continue;
        }
        if (!targetInfo.adapter.sendFile) {
          await adapter.sendText(message.channelId, `\u274c 通道 ${targetLabel} 不支持文件发送`, this.getReplyContext(message));
          continue;
        }

        // 找目标 channelId
        let targetChannelId = message.channelId;
        if (isCrossChannel) {
          const targetAdapterName = targetInfo.adapter.channelName;
          const targetChannelType = targetInfo.options?.channelType || targetAdapterName;
          const ownerPeerId = getOwner(this.config, targetAdapterName);
          targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannelType, ownerPeerId) ?? '') : '';
          if (!targetChannelId) {
            await adapter.sendText(message.channelId, `\u274c 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息`, this.getReplyContext(message));
            continue;
          }
        }

        logger.info(`[${adapter.channelName}] Sending file via ${targetInfo.adapter.channelName}: ${resolvedPath}`);
        try {
          await targetInfo.adapter.sendFile(targetChannelId, resolvedPath, this.getReplyContext(message));
          this.eventBus.publish({ type: 'agent:file-sent', sessionId: session.id, filePath: resolvedPath, channel: targetInfo.adapter.channelName });
          if (isCrossChannel) {
            await adapter.sendText(message.channelId, `\ud83d\udcce 文件已通过 ${targetLabel} 发送`, this.getReplyContext(message));
          }
        } catch (error) {
          logger.error(`[${adapter.channelName}] Failed to send file: ${resolvedPath}`, error);
          await adapter.sendText(message.channelId, `\u274c 文件发送失败: ${filePath}`, this.getReplyContext(message));
        }
      }
      }  // end of !isProactive

      // 最终回复文本添加到 flusher（统一在流结束后处理，避免多 complete 事件重复发送）
      // suppressed 模式：中间流式文本未推送，使用最后一轮回复（回退到全文）
      // 非 suppressed 且无流式文本：同上
      // 非 suppressed 且有流式文本：已经逐步推送过了，不重复添加
      //   但如果 flusher 既未发送过内容也没有 pending 内容（如 text 事件全为空），仍需兜底
      const finalReplyText = streamResult.lastReplyText || streamResult.fullText;
      if (finalReplyText) {
        if (shouldSuppress()) {
          flusher.addText(finalReplyText);
        } else if (!streamResult.hasReceivedText || (!flusher.hasSentContent() && !flusher.hasContent())) {
          flusher.addText(finalReplyText);
        }
      }

      // Flush 剩余内容（文件标记已在 flush 时自动移除）
      await flusher.flush(true);

      // 清理 ThoughtEmitter 的事件订阅
      if (thoughtNewInboundHandler) {
        this.eventBus.unsubscribe('message:new-inbound', thoughtNewInboundHandler);
      }

      // 清理 activeStreams（正常完成）
      agent.cleanupStream(streamKey);

      // 清除处理中状态
      this.sessionManager.clearProcessing(session.id);
      // 注意：不在此处清除 interruptedSessions，由下一条消息的 prompt 包装逻辑消费
      const interruptReason = this.interruptedSessions.get(session.id);

      if (streamResult.isError) {
        // Agent 流正常结束但任务结果失败（权限被拒、max turns、工具链失败等）
        const errorSummary = streamResult.errors?.join('; ') || '任务执行失败';
        const rawSubtype = streamResult.subtype || 'agent_error';
        const errorType = prefixErrorType(ERROR_PREFIX.AGENT, rawSubtype);
        adapter.sendProcessingStatus?.(message.channelId, 'error', session.id, this.getReplyContext(message));

        this.eventBus.publish({
          type: 'message:error',
          sessionId: session.id,
          error: errorSummary,
          errorType,
          terminalReason: streamResult.terminalReason
        });

        // 系统级 subtype 仍累计错误计数，供 /status 诊断使用
        if (isInfraError(rawSubtype, streamResult.terminalReason)) {
          const chatType = message.chatType || 'private';
          const identityRole = session.identity?.role || 'anonymous';
          const { policy } = channelInfo;
          if (policy.accumulateErrors(chatType, identityRole)) {
            await this.sessionManager.recordError(session.id, errorType, errorSummary);
          }
        }

        logger.message({
          msgId: messageId,
          sessionId: session.id,
          dir: 'inbound',
          status: 'failed',
          error: errorSummary,
          terminalReason: streamResult.terminalReason
        });
      } else {
        // 真正的成功
        adapter.sendProcessingStatus?.(message.channelId, interruptReason ? 'interrupted' : 'done', session.id, this.getReplyContext(message));
        await this.sessionManager.recordSuccess(session.id);

        this.eventBus.publish({
          type: 'message:completed',
          sessionId: session.id,
          channel: message.channel,
          channelId: message.channelId,
          terminalReason: streamResult.terminalReason,
          finalText: streamResult.lastReplyText || undefined,
          durationMs: Date.now() - startTime,
          timestamp: Date.now()
        });

        // 记录处理完成
        logger.message({
          msgId: messageId,
          sessionId: session.id,
          dir: 'inbound',
          status: 'completed',
          duration: Date.now() - startTime
        });
      }

      const isFinallyBackground = await this.isBackgroundSession(session, message.channel, message.channelId);
      if (isFinallyBackground) {
        const projectName = path.basename(session.projectPath);
        const count = this.messageCache.getCount(session.id);
        await adapter.sendText(message.channelId, `[\u540e\u53f0-${projectName}] \u2713 任务完成 (${count}条消息已缓存)`);
      }

      // 记录发送响应
      logger.message({
        msgId: `${messageId}_reply`,
        sessionId: session.id,
        dir: 'outbound',
        status: 'sent'
      });
    } catch (error) {
      // 清理流和处理中状态（异常时也要清除）
      agent.cleanupStream(streamKey);
      try { this.sessionManager.clearProcessing(session.id); } catch {}
      // 清理 ThoughtEmitter 的事件订阅
      if (thoughtNewInboundHandler) {
        try { this.eventBus.unsubscribe('message:new-inbound', thoughtNewInboundHandler); } catch {}
      }
      // 注意：不在此处清除 interruptedSessions，由下一条消息的 prompt 包装逻辑消费

      // 区分超时 / 中断 / 错误
      const errType = classifyError(error);
      const interruptReason = this.interruptedSessions.get(session.id);
      const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
      const procStatus = errType === ErrorType.SDK_TIMEOUT ? 'timeout' as const
        : errType === ErrorType.STREAM_ERROR ? 'interrupted' as const
        : 'error' as const;

      // 用户主动中断（新消息打断 或 /stop 命令）时静默，不发送中断/错误提示
      if (!isUserInterrupt) {
        try { adapter.sendProcessingStatus?.(message.channelId, procStatus, session.id, this.getReplyContext(message)); } catch {}
      }

      // 用户主动中断时降级日志；其余仍按 error 记录
      if (isUserInterrupt) {
        logger.info(`[${message.channel}] Interrupted by user (${interruptReason})`);
      } else {
        logger.error(`[${message.channel}] Error:`, error);
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = prefixErrorType(ERROR_PREFIX.INFRA, errType);

      this.eventBus.publish({
        type: 'message:error',
        sessionId: session.id,
        error: errorMsg,
        errorType
      });

      // 记录处理失败
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof Error && !isUserInterrupt) {
        logger.error(`[${message.channel}] Error stack:`, error.stack);
      }

      // 发送用户友好的错误消息（SDK_TIMEOUT 已在 kill 级别发过提示，跳过）
      // 用户主动中断（新消息打断 或 /stop 命令）时静默，不发送错误提示
      // processEventStream 已通过 flusher 发过错误时也跳过
      if (error instanceof Error && error.message === 'SDK_TIMEOUT') {
        logger.info(`[MessageProcessor] SDK_TIMEOUT error, skip sending duplicate message`);
      } else if (isUserInterrupt) {
        logger.info(`[MessageProcessor] User interrupt by new_message, skip sending error message`);
      } else if ((error as any)?._errorAlreadySent) {
        logger.info(`[MessageProcessor] Error already sent via flusher, skip sending duplicate message`);
      } else {
        const userMessage = getErrorMessage(error, undefined);
        // 获取 session 用于话题回复（如果 resolveSession 已执行）
        let sendOpts: { replyToMessageId?: string; replyInThread?: boolean } | undefined;
        try {
          const session = await this.sessionManager.getOrCreateSession(
            message.channel,
            message.channelId,
            this.config.projects?.defaultPath || process.cwd(),
            message.threadId
          );
          sendOpts = this.getReplyContext(message);
        } catch {}
        await adapter.sendText(message.channelId, userMessage, sendOpts);
      }
    }
  }

  /**
   * 解析会话和项目路径
   */
  private async resolveSession(message: Message): Promise<{
    session: Session;
    absoluteProjectPath: string;
  }> {
    // 话题会话创建时写入 replyContext（threadId 路由）；主会话不写（避免群聊覆盖）
    const metadata = (message.threadId && message.replyContext)
      ? { replyContext: message.replyContext }
      : undefined;

    const session = await this.sessionManager.getOrCreateSession(
      message.channel,
      message.channelId,
      this.config.projects?.defaultPath || process.cwd(),
      message.threadId,
      metadata,
      undefined,
      message.peerId
    );

    // replyContext 不再写入 session.metadata（跟着 message 走，避免群聊多人覆盖）

    const absoluteProjectPath = path.isAbsolute(session.projectPath)
      ? session.projectPath
      : path.resolve(process.cwd(), session.projectPath);

    return { session, absoluteProjectPath };
  }

  /**
   * 处理标准事件流（AgentEvent）
   *
   * 此方法只消费标准 AgentEvent 类型，不引用任何 SDK 特有事件。
   * SDK 事件 → AgentEvent 的转换在 AgentRunner.transformStream() 中完成。
   */
  private async processEventStream(
    stream: AsyncIterable<AgentEvent>,
    session: Session,
    flusher: StreamFlusher,
    resetTimer: (eventType?: string, toolName?: string) => void,
    shouldSuppress: () => boolean,
    thoughtEmitter?: ThoughtEmitter | null
  ): Promise<{ isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean }> {
    let hasReceivedText = false;
    let hasErrorResult = false;  // 是否已有 tool_result/error 事件输出过错误
    let completeResult: { isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean } = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };

    // 追踪最后一轮 assistant 回复文本（tool_use 之后的纯文本）
    let lastReplyText = '';

    try {
      for await (const event of stream) {
      // 每收到事件重置空闲超时
      const toolName = event.type === 'tool_use' ? event.name : undefined;
      resetTimer(event.type, toolName);

      // 记录所有事件类型
      logger.info(`[MessageProcessor] Event: type=${event.type}`);

      // Proactive 可观测：将事件实时透传为 thought（fire-and-forget）
      if (thoughtEmitter) {
        thoughtEmitter.emit(event).catch(() => {});
      }

      // session_id 已在 AgentRunner.transformStream 中处理，此处仅记录
      if (event.type === 'session_id') {
        logger.info(`[MessageProcessor] Session ID updated: ${event.sessionId} for session: ${session.id}`);
        continue;
      }

      // session 状态变更（idle/running/requires_action）
      if (event.type === 'state_changed') {
        logger.info(`[MessageProcessor] Session state: ${event.state} for session: ${session.id}`);
        this.eventBus.publish({ type: 'agent:state-changed', sessionId: session.id, state: event.state });
        continue;
      }

      // agent 状态通知（仅事件，不直出给用户）
      if (event.type === 'status') {
        logger.info(`[MessageProcessor] Agent status: ${event.subtype}: ${event.message}`);
        this.eventBus.publish({
          type: 'agent:status',
          sessionId: session.id,
          subtype: event.subtype,
          message: event.message,
          timestamp: Date.now()
        });
        continue;
      }

      const isCurrentlyBackground = await this.isBackgroundSession(session, session.channel, session.channelId);

      // === 前台任务：正常处理所有事件 ===
      if (!isCurrentlyBackground) {
        // 流式文本
        if (event.type === 'text') {
          hasReceivedText = true;
          lastReplyText += event.text;
          this.eventBus.publish({ type: 'message:text', sessionId: session.id, text: event.text, isFinal: false });
          if (!shouldSuppress()) {
            flusher.addText(event.text);
          }
        }

        // compact 完成
        if (event.type === 'compact') {
          this.eventBus.publish({ type: 'agent:compact-complete', sessionId: session.id, preTokens: event.preTokens });
          if (!shouldSuppress()) {
            flusher.addActivity(`\ud83d\udca1 会话压缩完成，继续执行...（压缩前 tokens: ${event.preTokens}）`);
          }
        }

        // 子任务进度
        if (event.type === 'task_progress') {
          const tools = event.toolUses ?? 0;
          const duration = event.durationMs ? `${Math.round(event.durationMs / 1000)}s` : '';
          const stats = [tools > 0 ? `${tools}\u6b21\u5de5\u5177\u8c03\u7528` : '', duration].filter(Boolean).join(', ');

          if (event.summary && !shouldSuppress()) {
            flusher.addActivity(`\u23f3 \u5b50\u4efb\u52a1: ${event.summary}${stats ? ` (${stats})` : ''}`);
          } else if (stats && !shouldSuppress()) {
            flusher.addActivity(`\u23f3 \u5b50\u4efb\u52a1\u8fdb\u884c\u4e2d: ${stats}`);
          }
        }

        // 工具调用
        if (event.type === 'tool_use') {
          // 工具调用意味着当前文本是中间轮，重置最后回复追踪
          lastReplyText = '';
          this.eventBus.publish({
            type: 'tool:use',
            sessionId: session.id,
            toolName: event.name,
            input: event.input,
            timestamp: Date.now()
          });
          if (!shouldSuppress()) {
            const desc = summarizeToolInput(event.name, event.input || {});
            flusher.addActivity(`\ud83d\udd27 ${event.name}${desc ? ': ' + desc : ''}`);
          }
        }

        // 工具结果
        if (event.type === 'tool_result') {
          logger.debug(`[MessageProcessor] tool_result: name=${event.name}, is_error=${event.isError}`);

          this.eventBus.publish({
            type: 'tool:result',
            sessionId: session.id,
            toolName: event.name,
            isError: event.isError,
            content: event.result,
            timestamp: Date.now()
          });

          if (event.isError && !shouldSuppress()) {
            hasErrorResult = true;
            let errorMsg = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)) || '\u6267\u884c\u5931\u8d25';
            // 移除 XML 风格的错误标签
            errorMsg = errorMsg.replace(/<tool_use_error>(.*?)<\/tool_use_error>/gs, '$1');
            flusher.addActivity(`\u26a0\ufe0f ${event.name || '\u5de5\u5177'}: ${errorMsg}`);
          }
        }

        // 运行时错误（Codex: turn.failed / item error）
        if (event.type === 'error') {
          logger.warn(`[MessageProcessor] error event: ${event.errorType}: ${event.error}`);

          if (!hasErrorResult && !shouldSuppress()) {
            hasErrorResult = true;
            flusher.addActivity(`\u274c ${event.error}`);
          }
        }

        // 完成事件
        // SDK 可能产生多个 complete 事件（如 subagent 或 auto-compact 二次查询），
        // 仅记录状态，最终 flush(true) 在流结束后统一执行
        if (event.type === 'complete') {
          logger.debug(`[MessageProcessor] complete event: hasReceivedText=${hasReceivedText}, isError=${event.isError}, shouldSuppress=${shouldSuppress()}`);

          // 自动回填会话名称
          if (event.sessionTitle && session.name === '默认会话') {
            await this.sessionManager.renameSession(session.id, event.sessionTitle);
            logger.info(`[MessageProcessor] Auto-filled session name: ${event.sessionTitle}`);
          }

          // 记录完成状态 + 最后一轮回复文本（后续 complete 覆盖前序）
          completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText };

          // 失败且无前置错误输出：显示 errors 摘要
          // 但用户主动中断（新消息打断 或 /stop 命令）时不显示错误提示
          const interruptReason = this.interruptedSessions.get(session.id);
          const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
          if (event.isError && !hasErrorResult && !shouldSuppress() && !isUserInterrupt) {
            const errorSummary = event.errors?.join('; ') || '\u4efb\u52a1\u6267\u884c\u5931\u8d25';
            // 使用 terminalReason 提供更友好的错误提示
            const userFriendlyMessage = event.terminalReason
              ? getErrorMessage(null, event.terminalReason)
              : `\u274c ${errorSummary}`;
            flusher.addActivity(userFriendlyMessage);
          }

          // 中间 complete：flush 掉已有 activities（不带 isFinal），让中间结果及时显示
          // 最终文本留给流结束后的统一 flush(true)
          if (flusher.hasContent()) {
            await flusher.flushActivitiesOnly();
          }
        }

        continue;
      }

      // === 后台任务：追踪最后回复文本，但只处理 complete 事件 ===
      if (event.type === 'text') {
        lastReplyText += event.text;
      } else if (event.type === 'tool_use') {
        lastReplyText = '';
      }
      if (event.type !== 'complete') {
        continue;
      }

      // 自动回填会话名称
      if (event.sessionTitle && session.name === '默认会话') {
        await this.sessionManager.renameSession(session.id, event.sessionTitle);
        logger.info(`[MessageProcessor] Auto-filled session name: ${event.sessionTitle}`);
      }

      // 记录完成状态
      completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText };

      if (event.subtype === 'success') {
        this.messageCache.addEvent(session.id, {
          type: 'completed',
          message: lastReplyText || event.result || '',
          timestamp: Date.now(),
          metadata: {
            duration: event.durationMs,
            cost: event.costUsd
          }
        });
        // 后台任务完成也纳入统计
        this.eventBus.publish({
          type: 'message:completed',
          sessionId: session.id,
          channel: session.channel,
          channelId: session.channelId,
          finalText: lastReplyText || event.result || undefined,
          durationMs: event.durationMs,
          timestamp: Date.now()
        });
      } else if (event.isError === true) {
        const bgErrorType = prefixErrorType(ERROR_PREFIX.AGENT, event.subtype || 'agent_error');
        this.messageCache.addEvent(session.id, {
          type: 'error',
          message: event.errors?.join('\n') || '\u672a\u77e5\u9519\u8bef',
          timestamp: Date.now(),
          metadata: {
            errorType: event.subtype
          }
        });
        // 后台任务失败也纳入统计
        this.eventBus.publish({
          type: 'message:error',
          sessionId: session.id,
          error: event.errors?.join('; ') || '\u672a\u77e5\u9519\u8bef',
          errorType: bgErrorType
        });
      }
    }

    } catch (error) {
      // User interrupt (AbortError) is expected, log at info level
      const catchInterruptReason = this.interruptedSessions.get(session.id);
      const catchIsUserInterrupt = catchInterruptReason === 'new_message' || catchInterruptReason === 'stop';
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('[MessageProcessor] Stream interrupted (AbortError)');
      } else if (catchIsUserInterrupt) {
        // SDK telemetry noise after user-initiated interrupt — not a real error
        logger.debug('[MessageProcessor] Stream ended after user interrupt:', (error as Error)?.message?.split('\n')[0]);
        completeResult.isError = false;
        completeResult.hasReceivedText = hasReceivedText;
        return completeResult;
      } else if (isRetryableError(error)) {
        // Retryable errors (network aborts, transient API failures) are noise at ERROR level
        logger.warn('[MessageProcessor] Stream processing error (retryable):', (error as Error)?.message?.split('\n')[0]);
      } else {
        logger.error('[MessageProcessor] Stream processing error:', error);
      }
      if (error instanceof Error && error.message.includes('process exited')) {
        flusher.addActivity('\u274c Claude Code \u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u8bf7\u91cd\u8bd5');
      }
      // Flush any pending error activities before re-throwing,
      // and mark the error so outer catch won't send a duplicate message
      if (hasErrorResult || flusher.hasContent()) {
        try { await flusher.flush(true); } catch {}
        if (error instanceof Error) {
          (error as any)._errorAlreadySent = true;
        }
      }
      throw error;
    }

    completeResult.hasReceivedText = hasReceivedText;
    return completeResult;
  }

  /**
   * 解析文件路径，支持相对路径和绝对路径
   * 优先在项目根目录查找，兜底尝试 .openclaw/workspace/
   */
  private resolveFilePath(filePath: string, projectPath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    // 优先在项目根目录查找
    const rootPath = path.join(projectPath, filePath);
    if (fs.existsSync(rootPath)) {
      return rootPath;
    }

    // 兜底：尝试 .openclaw/workspace/
    const workspacePath = path.join(projectPath, '.openclaw', 'workspace', filePath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }

    // 都找不到，返回项目根目录路径
    return rootPath;
  }

  /**
   * 确保全局数据目录下有最新版本的 SKILLS.md
   * 目标：{EVOLCLAW_HOME}/data/SKILLS.md
   */
  private ensureSkillsFile(): void {
    try {
      const targetDir = path.join(resolveRoot(), 'data');
      const targetPath = path.join(targetDir, 'SKILLS.md');
      const templatePath = path.join(getPackageRoot(), 'src', 'templates', 'skills.md');

      // 模板不存在则跳过（构建环境可能没有 src/）
      if (!fs.existsSync(templatePath)) {
        // 尝试 dist/templates/skills.md
        const distTemplatePath = path.join(getPackageRoot(), 'dist', 'templates', 'skills.md');
        if (!fs.existsSync(distTemplatePath)) return;
        this.copySkillsIfNeeded(distTemplatePath, targetDir, targetPath);
        return;
      }
      this.copySkillsIfNeeded(templatePath, targetDir, targetPath);
    } catch {
      // 静默失败，不影响正常消息处理
    }
  }

  private copySkillsIfNeeded(templatePath: string, targetDir: string, targetPath: string): void {
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const templateVersion = templateContent.match(/^version:\s*(.+)$/m)?.[1]?.trim() || '0';

    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      const existingVersion = existing.match(/^version:\s*(.+)$/m)?.[1]?.trim() || '0';
      if (this.compareSemver(existingVersion, templateVersion) >= 0) return; // 已是最新
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(targetPath, templateContent, 'utf-8');
  }

  /** 简易 semver 比较：支持 "1", "1.0", "1.0.0" 等格式，返回 -1/0/1 */
  private compareSemver(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  }

  /**
   * 从模板 frontmatter 缓存提示（懒加载，整个进程只读一次模板文件）
   */
  private getSkillsHint(): string | null {
    if (this.skillsHintDesc === undefined) {
      this.skillsHintDesc = this.loadSkillsHint();
    }
    return this.skillsHintDesc;
  }

  /**
   * 从包模板源读取 frontmatter 并生成提示（仅执行一次）
   */
  private loadSkillsHint(): string | null {
    try {
      const candidates = [
        path.join(getPackageRoot(), 'src', 'templates', 'skills.md'),
        path.join(getPackageRoot(), 'dist', 'templates', 'skills.md'),
      ];
      for (const templatePath of candidates) {
        if (!fs.existsSync(templatePath)) continue;
        const content = fs.readFileSync(templatePath, 'utf-8');
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) continue;

        const fm = frontmatterMatch[1];
        const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || 'EvolClaw 运行时管理指令';
        const trigger = fm.match(/^trigger:\s*(.+)$/m)?.[1]?.trim() || '';

        const skillsPath = path.join(resolveRoot(), 'data', 'SKILLS.md');
        const parts = [
          `可通过 Bash 执行 \`evolclaw ctl <cmd>\` 管理运行时：${desc}`,
          trigger ? `触发时机：${trigger}` : '',
          `完整文档见 ${skillsPath}`,
        ];
        return parts.filter(Boolean).join('\n');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 判断文件路径是否为占位符/示例文本
   * 用于过滤大模型在说明文字中误写的 [SEND_FILE:...] 标记
   */
  private isPlaceholderPath(filePath: string): boolean {
    if (!filePath) return true;

    // 精确占位符
    const exactPlaceholders = ['...', '\u2026', 'path', 'file', 'file_path', 'filepath',
      '\u8def\u5f84', '\u6587\u4ef6\u8def\u5f84', '\u6587\u4ef6', 'filename', 'xxx'];
    if (exactPlaceholders.includes(filePath.toLowerCase())) return true;

    // 示例路径前缀
    if (/^(\/path\/to\/|\.\/path\/to\/|example\/|\u793a\u4f8b|\/example)/i.test(filePath)) return true;

    // 含模板变量
    if (/\$\{.+\}|\{\{.+\}\}|<.+>/.test(filePath)) return true;

    // 纯标点/特殊字符（非路径字符）
    if (/^[.\s\u2026]+$/.test(filePath)) return true;

    // 含正则/代码特殊字符（Agent 在说明中引用了代码或正则表达式）
    if (/[\\[\]{}*+?|^$]/.test(filePath)) return true;

    return false;
  }
}
