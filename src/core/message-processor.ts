import path from 'path';
import fs from 'fs';
import { AgentRunner, hasCompact, AgentEvent } from '../agents/claude-runner.js';
import { SessionManager } from './session-manager.js';
import { StreamFlusher } from '../utils/stream-flusher.js';
import { MessageCache } from '../utils/message-cache.js';
import { StreamIdleMonitor } from '../utils/stream-idle-monitor.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage, classifyError, ErrorType } from '../utils/error-utils.js';
import { EventBus } from './event-bus.js';
import { summarizeToolInput } from '../utils/permission-utils.js';
import type { Message, Config, Session, ChannelAdapter, ChannelOptions, ChannelPolicy, CommandHandler } from '../types.js';

/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class MessageProcessor {
  private channels = new Map<string, { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy }>();
  private currentFlusher?: StreamFlusher;
  private shouldSuppressActivities = false;

  /** 判断是否为后台会话（仅主会话参与判断，话题会话独立） */
  private async isBackgroundSession(session: Session, channel: string, channelId: string): Promise<boolean> {
    if (session.threadId) return false;
    const active = await this.sessionManager.getActiveSession(channel, channelId);
    return active ? session.id !== active.id : false;
  }

  constructor(
    private agentRunner: AgentRunner,
    private sessionManager: SessionManager,
    private config: Config,
    private messageCache: MessageCache,
    private eventBus: EventBus,
    private commandHandler?: CommandHandler
  ) {}

  /**
   * 注册渠道适配器
   */
  registerChannel(adapter: ChannelAdapter, policy: ChannelPolicy, options?: ChannelOptions): void {
    this.channels.set(adapter.name, { adapter, options, policy });
  }

  /**
   * 获取渠道适配器
   */
  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.channels.get(channelName)?.adapter;
  }

  /**
   * 获取渠道信息（含 policy）
   */
  getChannelInfo(channelName: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined {
    return this.channels.get(channelName);
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
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
    const idleMs = (this.config.idleMonitor?.timeout ?? 120) * 1000;
    const streamKey = `${message.channel}-${message.channelId}`;
    const channelInfo = this.channels.get(message.channel);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${message.channel}`);
      return;
    }

    const { policy } = channelInfo;

    // 解析会话（唯一的 getOrCreateSession 调用点）
    const { session, absoluteProjectPath } = await this.resolveSession(message);
    const chatType = session.chatType;
    const identityRole = session.identity?.role || 'anonymous';

    const monitorEnabled = this.config.idleMonitor?.enabled !== false;
    const safeModeThreshold = this.config.idleMonitor?.safeModeThreshold ?? 3;
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

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      if (!monitorEnabled) return;

      monitor = new StreamIdleMonitor(idleMs);
      monitorInterval = setInterval(async () => {
        // Drain all pending levels in one tick
        let result = monitor!.check();
        while (result) {
          if (result.action === 'kill') {
            logger.warn(`[MessageProcessor] Idle monitor: kill after ${result.idleSec}s idle, stream: ${streamKey}`);
            this.eventBus.publish({ type: 'agent:idle-timeout', sessionId: streamKey, idleSec: result.idleSec });
            // 先发送诊断信息，让用户知道发生了什么
            if (channelInfo) {
              try {
                const msg = showIdleMonitor
                  ? result.message
                  : `\u26a0\ufe0f 任务超时（${result.idleSec}秒无响应），已自动中断`;
                await channelInfo.adapter.sendText(message.channelId, msg);
              } catch (e) {
                logger.debug(`[MessageProcessor] Failed to send kill diagnostic message:`, e);
              }
            }
            try {
              await this.agentRunner.interrupt(streamKey);
            } catch (e) {
              logger.debug(`[MessageProcessor] Interrupt failed (may already be cleaned up):`, e);
            }
            rejectFn(new Error('SDK_TIMEOUT'));
            return;
          } else {
            // notify or warn: send diagnostic message, task continues
            logger.info(`[MessageProcessor] Idle monitor: ${result.action} after ${result.idleSec}s idle, stream: ${streamKey}`);
            if (channelInfo && showIdleMonitor && !shouldSuppress()) {
              try {
                await channelInfo.adapter.sendText(message.channelId, result.message);
              } catch (e) {
                logger.debug(`[MessageProcessor] Failed to send idle monitor message:`, e);
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

          // 上下文过长是可恢复错误，不累计触发安全模式
          if (errorType === ErrorType.CONTEXT_TOO_LONG) {
            logger.info(`[MessageProcessor] Context too long error, skipping safe mode accumulation`);
          } else if (!policy.accumulateErrors(chatType, identityRole)) {
            logger.info(`[MessageProcessor] Non-accumulating error (chatType=${chatType}, identity=${identityRole}), skipping safe mode accumulation`);
          } else {
            const newCount = await this.sessionManager.recordError(session.id, errorType, error.message);
            await this.checkSafeMode(session, message.channelId, channelInfo.adapter, safeModeThreshold, newCount);
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

  /** 从 session 提取渠道预构建的回复上下文 */
  private getReplyContext(session: Session): import('../types.js').ReplyContext | undefined {
    return session.metadata?.replyContext;
  }

  /**
   * 检查是否需要进入安全模式（safeModeThreshold 为 0 时跳过）
   */
  private async checkSafeMode(
    session: Session,
    channelId: string,
    adapter: ChannelAdapter,
    safeModeThreshold: number,
    consecutiveErrors: number
  ): Promise<void> {
    if (safeModeThreshold <= 0) return;

    const health = await this.sessionManager.getHealthStatus(session.id);
    const sendOpts = this.getReplyContext(session);
    const isThread = !!session.threadId;
    if (consecutiveErrors >= safeModeThreshold && !health.safeMode) {
      await this.sessionManager.setSafeMode(session.id, true);
      logger.warn(`[MessageProcessor] Session ${session.id} entered safe mode after ${consecutiveErrors} errors`);
      this.eventBus.publish({ type: 'session:safe-mode-entered', sessionId: session.id, consecutiveErrors });

      const suggestions = isThread
        ? `1. /repair - 检查并修复会话（推荐，保留历史）\n2. /clear - 清空会话历史\n3. /status - 查看详细状态`
        : `1. /repair - 检查并修复会话（推荐，保留历史）\n2. /new [名称] - 创建新会话（清空历史）\n3. /status - 查看详细状态`;

      await adapter.sendText(
        channelId,
        `\u26a0\ufe0f 安全模式已启用（连续 ${consecutiveErrors} 次异常）

当前限制：
- 无法记住之前的对话
- 每次提问需要提供完整上下文

建议操作：
${suggestions}`,
        sendOpts
      );
    } else if (safeModeThreshold >= 2 && consecutiveErrors === safeModeThreshold - 1) {
      await adapter.sendText(
        channelId,
        `\u26a0\ufe0f 检测到异常（${consecutiveErrors}/${safeModeThreshold}）\n\n如果问题持续，系统将自动进入安全模式。建议使用 /status 查看状态。`,
        sendOpts
      );
    }
  }

  private async _processMessageInternal(message: Message, session: Session, absoluteProjectPath: string, resetTimer: (eventType?: string, toolName?: string) => void, shouldSuppress: () => boolean): Promise<void> {
    const messageId = `${message.channel}_${message.channelId}_${message.timestamp || Date.now()}`;
    const channelInfo = this.channels.get(message.channel);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${message.channel}`);
      return;
    }

    const { adapter, options } = channelInfo;

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

      // 记录开始处理
      this.eventBus.publish({ type: 'message:processing', sessionId: session.id });

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
      const flusher = new StreamFlusher(
        async (text, isFinal) => {
          const isCurrentlyBackground = await this.isBackgroundSession(session, message.channel, message.channelId);

          if (!isCurrentlyBackground) {
            const opts: { title?: string; replyToMessageId?: string; mentionUserIds?: string[]; replyInThread?: boolean } = {};
            if (isFinal) opts.title = '\u6700\u7ec8\u56de\u590d:';
            // 话题会话：使用 Channel 预构建的 replyContext（确保消息进入话题）
            const replyCtx = session.metadata?.replyContext;
            if (replyCtx) {
              Object.assign(opts, replyCtx);
            } else if (firstReply && message.messageId) {
              // 主会话：首条消息引用回复用户原消息
              opts.replyToMessageId = message.messageId;
              firstReply = false;
            }
            await adapter.sendText(message.channelId, text, Object.keys(opts).length ? opts : undefined);
          }
          // 后台任务：静默，不发送输出
        },
        (options?.flushDelay ?? this.config.flushDelay ?? 4) * 1000,
        options?.fileMarkerPattern,
        this.config.debug?.flusherDiag
      );

      // 保存当前 flusher，用于 compact 事件
      this.currentFlusher = flusher;

      // 调用 AgentRunner（含上下文过长自动 compact 重试）
      const streamKey = `${message.channel}-${message.channelId}`;

      // 设置权限审批的消息发送回调（指向当前渠道）
      this.agentRunner.setSendPrompt(async (text: string) => {
        await adapter.sendText(message.channelId, text, this.getReplyContext(session));
      });

      // 设置 per-session 权限模式
      const permissionMode = session.metadata?.permissionMode || 'auto';
      this.agentRunner.setMode(permissionMode);

      try {
        const stream = await this.agentRunner.runQuery(
          session.id,
          message.content,
          absoluteProjectPath,
          session.agentSessionId,
          message.images,
          options?.systemPromptAppend,
          this.sessionManager
        );
        this.agentRunner.registerStream(streamKey, stream);

        await this.processEventStream(
          stream,
          session,
          flusher,
          resetTimer,
          shouldSuppress
        );
      } catch (error) {
        if (classifyError(error) === ErrorType.CONTEXT_TOO_LONG && session.agentSessionId && hasCompact(this.agentRunner)) {
          // 尝试 compact 压缩会话
          flusher.addActivity('\u26a0\ufe0f 上下文过长，正在压缩会话...');
          await flusher.flush();

          const compacted = await this.agentRunner.compact(
            session.id, session.agentSessionId, absoluteProjectPath
          );

          if (compacted) {
            // compact 成功，带 resume 重试
            flusher.addActivity('\u2705 压缩完成，正在重试...');
            const retryStream = await this.agentRunner.runQuery(
              session.id,
              message.content,
              absoluteProjectPath,
              session.agentSessionId,
              message.images,
              options?.systemPromptAppend,
              this.sessionManager
            );
            this.agentRunner.registerStream(streamKey, retryStream);

            await this.processEventStream(
              retryStream,
              session,
              flusher,
              resetTimer,
              shouldSuppress
            );
          } else {
            throw new Error('CONTEXT_COMPACT_FAILED');
          }
        } else {
          throw error;
        }
      }

      // 处理文件标记（Feishu 专用）- 提取并发送文件
      if (options?.fileMarkerPattern && adapter.sendFile) {
        const fullText = flusher.getFinalText();
        const fileMatches = [...fullText.matchAll(options.fileMarkerPattern)];

        for (const match of fileMatches) {
          const filePath = match[1].trim();

          // 占位符/示例检测：静默跳过，不打扰用户
          if (this.isPlaceholderPath(filePath)) {
            logger.info(`[${adapter.name}] Skipped placeholder file marker: [SEND_FILE:${filePath}]`);
            continue;
          }

          const resolvedPath = this.resolveFilePath(filePath, absoluteProjectPath);

          // 文件存在性检查：真实路径但文件不存在，告知用户
          if (!fs.existsSync(resolvedPath)) {
            logger.warn(`[${adapter.name}] File not found: ${resolvedPath}`);
            await adapter.sendText(message.channelId, `\u26a0\ufe0f 文件未找到: ${filePath}`, this.getReplyContext(session));
            continue;
          }

          logger.info(`[${adapter.name}] Sending file: ${resolvedPath}`);
          try {
            await adapter.sendFile(message.channelId, resolvedPath);
            this.eventBus.publish({ type: 'agent:file-sent', sessionId: session.id, filePath: resolvedPath, channel: message.channel });
          } catch (error) {
            logger.error(`[${adapter.name}] Failed to send file: ${resolvedPath}`, error);
            await adapter.sendText(message.channelId, `\u274c 文件发送失败: ${filePath}`, this.getReplyContext(session));
          }
        }
      }

      // Flush 剩余内容（文件标记已在 flush 时自动移除）
      await flusher.flush(true);

      // 安全模式尾部提示：如果当前会话处于安全模式，追加提醒
      const healthStatus = await this.sessionManager.getHealthStatus(session.id);
      if (healthStatus.safeMode) {
        const hint = session.threadId
          ? '\n\n\u26a0\ufe0f 当前处于安全模式（无上下文记忆）。使用 /repair 修复 或 /clear 清空会话'
          : '\n\n\u26a0\ufe0f 当前处于安全模式（无上下文记忆）。使用 /repair 修复 或 /new 新建会话';
        await adapter.sendText(message.channelId, hint, this.getReplyContext(session));
      }

      // 清理 activeStreams（正常完成）
      this.agentRunner.cleanupStream(streamKey);

      // 记录成功响应（重置错误计数）
      await this.sessionManager.recordSuccess(session.id);

      this.eventBus.publish({
        type: 'message:completed',
        sessionId: session.id,
        channel: message.channel,
        channelId: message.channelId,
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      });

      const isFinallyBackground = await this.isBackgroundSession(session, message.channel, message.channelId);

      if (isFinallyBackground) {
        const projectName = path.basename(session.projectPath);
        const count = this.messageCache.getCount(session.id);
        await adapter.sendText(message.channelId, `[\u540e\u53f0-${projectName}] \u2713 任务完成 (${count}条消息已缓存)`);
      }

      const duration = Date.now() - startTime;

      // 记录处理完成
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'completed',
        duration
      });

      // 记录发送响应
      logger.message({
        msgId: `${messageId}_reply`,
        sessionId: session.id,
        dir: 'outbound',
        status: 'sent'
      });
    } catch (error) {
      logger.error(`[${message.channel}] Error:`, error);

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = classifyError(error);

      this.eventBus.publish({
        type: 'message:error',
        sessionId: message.channelId,
        error: errorMsg,
        errorType: String(errorType)
      });

      // 记录处理失败
      logger.message({
        msgId: messageId,
        sessionId: message.channelId,
        dir: 'inbound',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof Error) {
        logger.error(`[${message.channel}] Error stack:`, error.stack);
      }

      // 发送用户友好的错误消息（SDK_TIMEOUT 已在 kill 级别发过提示，跳过）
      if (error instanceof Error && error.message === 'SDK_TIMEOUT') {
        logger.info(`[MessageProcessor] SDK_TIMEOUT error, skip sending duplicate message`);
      } else {
        const userMessage = getErrorMessage(error);
        // 获取 session 用于话题回复（如果 resolveSession 已执行）
        let sendOpts: { replyToMessageId?: string; replyInThread?: boolean } | undefined;
        try {
          const session = await this.sessionManager.getOrCreateSession(
            message.channel,
            message.channelId,
            this.config.projects?.defaultPath || process.cwd(),
            message.threadId
          );
          sendOpts = this.getReplyContext(session);
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
    // 话题会话：使用 Channel 预构建的 replyContext
    const metadata = message.replyContext
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
    shouldSuppress: () => boolean
  ): Promise<void> {
    let hasReceivedText = false;

    try {
      for await (const event of stream) {
      // 每收到事件重置空闲超时
      const toolName = event.type === 'tool_use' ? event.name : undefined;
      resetTimer(event.type, toolName);

      // 记录所有事件类型
      logger.info(`[MessageProcessor] Event: type=${event.type}`);

      // session_id 已在 AgentRunner.transformStream 中处理，此处仅记录
      if (event.type === 'session_id') {
        logger.info(`[MessageProcessor] Session ID updated: ${event.sessionId} for session: ${session.id}`);
        continue;
      }

      const isCurrentlyBackground = await this.isBackgroundSession(session, session.channel, session.channelId);

      // === 前台任务：正常处理所有事件 ===
      if (!isCurrentlyBackground) {
        // 流式文本
        if (event.type === 'text') {
          hasReceivedText = true;
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
            const errorMsg = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)) || '\u6267\u884c\u5931\u8d25';
            flusher.addActivity(`\u26a0\ufe0f ${event.name || '\u5de5\u5177'}: ${errorMsg}`);
          }
        }

        // 完成事件
        if (event.type === 'complete' && event.result) {
          logger.debug(`[MessageProcessor] complete event: hasReceivedText=${hasReceivedText}, shouldSuppress=${shouldSuppress()}`);

          if (shouldSuppress()) {
            flusher.addText(event.result);
          } else if (!hasReceivedText) {
            flusher.addText(event.result);
          }

          await flusher.flush(true);
        }

        continue;
      }

      // === 后台任务：只处理 complete 事件，仅缓存不发送 ===
      if (event.type !== 'complete') {
        continue;
      }

      if (event.subtype === 'success') {
        this.messageCache.addEvent(session.id, {
          type: 'completed',
          message: event.result || '',
          timestamp: Date.now(),
          metadata: {
            duration: event.durationMs,
            cost: event.costUsd
          }
        });
      } else if (event.isError === true) {
        this.messageCache.addEvent(session.id, {
          type: 'error',
          message: event.errors?.join('\n') || '\u672a\u77e5\u9519\u8bef',
          timestamp: Date.now(),
          metadata: {
            errorType: event.subtype
          }
        });
      }
    }
    } catch (error) {
      logger.error('[MessageProcessor] Stream processing error:', error);
      if (error instanceof Error && error.message.includes('process exited')) {
        flusher.addActivity('\u274c Claude Code \u8fdb\u7a0b\u5f02\u5e38\u9000\u51fa\uff0c\u8bf7\u91cd\u8bd5');
      }
      throw error;
    }
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
