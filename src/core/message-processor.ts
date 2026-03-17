import path from 'path';
import fs from 'fs';
import { AgentRunner } from './agent-runner.js';
import { SessionManager } from './session-manager.js';
import { StreamFlusher } from './stream-flusher.js';
import { MessageCache } from './message-cache.js';
import { IdleHealthTracker } from './idle-health-tracker.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/error-handler.js';
import { classifyError, ErrorType } from '../utils/error-classifier.js';
import type { Message, Config, Session, ChannelAdapter, ChannelOptions, CommandHandler } from '../types.js';

/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class MessageProcessor {
  private channels = new Map<string, { adapter: ChannelAdapter; options?: ChannelOptions }>();
  private currentFlusher?: StreamFlusher;
  private currentIsGroup = false;

  constructor(
    private agentRunner: AgentRunner,
    private sessionManager: SessionManager,
    private config: Config,
    private messageCache: MessageCache,
    private commandHandler?: CommandHandler
  ) {}

  /**
   * 注册渠道适配器
   */
  registerChannel(adapter: ChannelAdapter, options?: ChannelOptions): void {
    this.channels.set(adapter.name, { adapter, options });
  }

  /**
   * 处理 compact 开始事件
   */
  handleCompactStart(): void {
    if (this.currentFlusher && !this.currentIsGroup) {
      this.currentFlusher.addActivity('⏳ 会话压缩中...');
    }
  }

  /**
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
    const isGroup = message.isGroup ?? false;
    this.currentIsGroup = isGroup;
    const idleMs = this.config.timeout?.idle ?? 120000;
    const streamKey = `${message.channel}-${message.channelId}`;
    const channelInfo = this.channels.get(message.channel);

    const tracker = new IdleHealthTracker(idleMs);
    let healthInterval: ReturnType<typeof setInterval>;
    let rejectFn: (err: Error) => void;

    const resetTimer = (eventType?: string, toolName?: string) => {
      tracker.recordEvent(eventType || 'unknown', toolName);
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      healthInterval = setInterval(async () => {
        // Drain all pending levels in one tick
        let result = tracker.checkHealth();
        while (result) {
          if (result.action === 'kill') {
            logger.warn(`[MessageProcessor] Health check: kill after ${result.idleSec}s idle, stream: ${streamKey}`);
            // 先发送诊断信息，让用户知道发生了什么（群聊时静默）
            if (channelInfo && !isGroup) {
              try {
                await channelInfo.adapter.sendText(message.channelId, result.message);
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
            // notify or warn: send diagnostic message, task continues（群聊时静默）
            logger.info(`[MessageProcessor] Health check: ${result.action} after ${result.idleSec}s idle, stream: ${streamKey}`);
            if (channelInfo && !isGroup) {
              try {
                await channelInfo.adapter.sendText(message.channelId, result.message);
              } catch (e) {
                logger.debug(`[MessageProcessor] Failed to send health check message:`, e);
              }
            }
          }
          result = tracker.checkHealth();
        }
      }, 30000);
    });

    try {
      await Promise.race([
        this._processMessageInternal(message, resetTimer),
        timeoutPromise
      ]);
    } catch (error: any) {
      // 超时错误：kill 级别已发送诊断信息，无需再发
      // 非超时错误走通用处理

      // 记录错误到健康状态
      if (channelInfo) {
        try {
          const session = await this.sessionManager.getOrCreateSession(
            message.channel as 'feishu' | 'acp',
            message.channelId,
            this.config.projects?.defaultPath || process.cwd()
          );

          const errorType = classifyError(error);

          // 上下文过长是可恢复错误，不累计触发安全模式
          if (errorType === ErrorType.CONTEXT_TOO_LONG) {
            logger.info(`[MessageProcessor] Context too long error, skipping safe mode accumulation`);
          } else if (error.message === 'SDK_TIMEOUT') {
            // 仅 kill 级别记录错误
            await this.sessionManager.recordError(session.id, errorType, error.message);

            const health = await this.sessionManager.getHealthStatus(session.id);
            if (health.consecutiveErrors >= 3 && !health.safeMode) {
              await this.sessionManager.setSafeMode(session.id, true);
              logger.warn(`[MessageProcessor] Session ${session.id} entered safe mode after ${health.consecutiveErrors} errors`);

              if (!isGroup) {
                await channelInfo.adapter.sendText(
                  message.channelId,
                  `⚠️ 安全模式已启用（连续 ${health.consecutiveErrors} 次异常）

当前限制：
- 无法记住之前的对话
- 每次提问需要提供完整上下文

建议操作：
1. /repair - 检查并修复会话（推荐，保留历史）
2. /new [名称] - 创建新会话（清空历史）
3. /status - 查看详细状态`
                );
              }
            } else if (health.consecutiveErrors === 2) {
              if (!isGroup) {
                await channelInfo.adapter.sendText(
                  message.channelId,
                  `⚠️ 检测到异常（${health.consecutiveErrors}/3）\n\n如果问题持续，系统将自动进入安全模式。建议使用 /status 查看状态。`
                );
              }
            }
          } else {
            await this.sessionManager.recordError(session.id, errorType, error.message);

            // 检查是否需要进入安全模式
            const health = await this.sessionManager.getHealthStatus(session.id);
            if (health.consecutiveErrors >= 3 && !health.safeMode) {
              await this.sessionManager.setSafeMode(session.id, true);
              logger.warn(`[MessageProcessor] Session ${session.id} entered safe mode after ${health.consecutiveErrors} errors`);

              // 发送安全模式提示（群聊时静默）
              if (!isGroup) {
                await channelInfo.adapter.sendText(
                  message.channelId,
                  `⚠️ 安全模式已启用（连续 ${health.consecutiveErrors} 次异常）

当前限制：
- 无法记住之前的对话
- 每次提问需要提供完整上下文

建议操作：
1. /repair - 检查并修复会话（推荐，保留历史）
2. /new [名称] - 创建新会话（清空历史）
3. /status - 查看详细状态`
                );
              }
            } else if (health.consecutiveErrors === 2) {
              // 第2次错误，发送警告（群聊时静默）
              if (!isGroup) {
                await channelInfo.adapter.sendText(
                  message.channelId,
                  `⚠️ 检测到异常（${health.consecutiveErrors}/3）\n\n如果问题持续，系统将自动进入安全模式。建议使用 /status 查看状态。`
                );
              }
            }
          }
        } catch (healthError) {
          logger.error('[MessageProcessor] Failed to update health status:', healthError);
        }
      }

      throw error;
    } finally {
      clearInterval(healthInterval!);
    }
  }

  private async _processMessageInternal(message: Message, resetTimer: (eventType?: string, toolName?: string) => void): Promise<void> {
    const messageId = `${message.channel}_${message.channelId}_${message.timestamp || Date.now()}`;
    const channelInfo = this.channels.get(message.channel);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${message.channel}`);
      return;
    }

    const { adapter, options } = channelInfo;

    try {
      // 检查是否为命令
      if (this.commandHandler) {
        const cmdResult = await this.commandHandler(message.content, message.channel, message.channelId, message.userId);
        if (cmdResult) {
          await adapter.sendText(message.channelId, cmdResult);
          return;
        }
      }

      // 解析会话和项目路径
      const { session, absoluteProjectPath } = await this.resolveSession(message);

      // 判断是否是后台任务
      const activeSession = await this.sessionManager.getActiveSession(message.channel, message.channelId);
      const isBackground = activeSession ? session.id !== activeSession.id : false;

      // 记录收到消息
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'received'
      });

      const imageInfo = message.images && message.images.length > 0 ? ` [${message.images.length} image(s)]` : '';
      const modeInfo = isBackground ? ' [后台]' : '';
      logger.info(`[${message.channel}] ${message.channelId}: ${message.content}${imageInfo}${modeInfo}`);

      // 记录开始处理
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
          // 动态判断是否是后台任务
          const currentActiveSession = await this.sessionManager.getActiveSession(message.channel, message.channelId);
          const isCurrentlyBackground = currentActiveSession ? session.id !== currentActiveSession.id : false;

          if (!isCurrentlyBackground) {
            const opts: { title?: string; replyToMessageId?: string } = {};
            if (isFinal) opts.title = '最终回复:';
            // 首条消息引用回复用户原消息
            if (firstReply && message.messageId) {
              opts.replyToMessageId = message.messageId;
              firstReply = false;
            }
            await adapter.sendText(message.channelId, text, Object.keys(opts).length ? opts : undefined);
          }
          // 后台任务：静默，不发送输出
        },
        this.config.flushDelay ?? 4000,
        options?.fileMarkerPattern
      );

      // 保存当前 flusher，用于 compact 事件
      this.currentFlusher = flusher;

      // 调用 AgentRunner（含上下文过长自动 compact 重试）
      const streamKey = `${message.channel}-${message.channelId}`;

      try {
        const stream = await this.agentRunner.runQuery(
          session.id,
          message.content,
          absoluteProjectPath,
          session.claudeSessionId,
          message.images,
          options?.systemPromptAppend,
          this.sessionManager
        );
        this.agentRunner.registerStream(streamKey, stream);

        await this.processEventStream(
          stream,
          session,
          message.channelId,
          adapter,
          options,
          flusher,
          isBackground,
          resetTimer
        );
      } catch (error) {
        if (this.isContextTooLongError(error) && session.claudeSessionId) {
          // 尝试 compact 压缩会话
          flusher.addActivity('⚠️ 上下文过长，正在压缩会话...');
          await flusher.flush();

          const compacted = await this.agentRunner.compactSession(
            session.id, session.claudeSessionId, absoluteProjectPath
          );

          if (compacted) {
            // compact 成功，带 resume 重试
            flusher.addActivity('✅ 压缩完成，正在重试...');
            const retryStream = await this.agentRunner.runQuery(
              session.id,
              message.content,
              absoluteProjectPath,
              session.claudeSessionId,
              message.images,
              options?.systemPromptAppend,
              this.sessionManager
            );
            this.agentRunner.registerStream(streamKey, retryStream);

            await this.processEventStream(
              retryStream,
              session,
              message.channelId,
              adapter,
              options,
              flusher,
              isBackground,
              resetTimer
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
          const resolvedPath = this.resolveFilePath(filePath, absoluteProjectPath);
          logger.info(`[${adapter.name}] Sending file: ${resolvedPath}`);
          try {
            await adapter.sendFile(message.channelId, resolvedPath);
          } catch (error) {
            logger.error(`[${adapter.name}] Failed to send file: ${resolvedPath}`, error);
            await adapter.sendText(message.channelId, `❌ 文件发送失败: ${filePath}`);
          }
        }
      }

      // Flush 剩余内容（文件标记已在 flush 时自动移除）
      await flusher.flush(true);

      // 清理 activeStreams（正常完成）
      this.agentRunner.cleanupStream(streamKey);

      // 记录成功响应（重置错误计数）
      await this.sessionManager.recordSuccess(session.id);

      // 动态判断是否是后台任务，决定是否发送通知
      const currentActive = await this.sessionManager.getActiveSession(message.channel, message.channelId);
      const isFinallyBackground = currentActive ? session.id !== currentActive.id : false;

      if (isFinallyBackground) {
        const projectName = path.basename(session.projectPath);
        const count = this.messageCache.getCount(session.id);
        await adapter.sendText(message.channelId, `[后台-${projectName}] ✓ 任务完成 (${count}条消息已缓存)`);
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

      // 发送用户友好的错误消息
      const userMessage = getErrorMessage(error);
      await adapter.sendText(message.channelId, userMessage);
    }
  }

  /**
   * 解析会话和项目路径
   */
  private async resolveSession(message: Message): Promise<{
    session: Session;
    absoluteProjectPath: string;
  }> {
    const session = await this.sessionManager.getOrCreateSession(
      message.channel,
      message.channelId,
      this.config.projects?.defaultPath || process.cwd()
    );

    const absoluteProjectPath = path.isAbsolute(session.projectPath)
      ? session.projectPath
      : path.resolve(process.cwd(), session.projectPath);

    return { session, absoluteProjectPath };
  }

  /**
   * 处理事件流
   */
  private async processEventStream(
    stream: AsyncIterable<any>,
    session: Session,
    channelId: string,
    adapter: ChannelAdapter,
    options: ChannelOptions | undefined,
    flusher: StreamFlusher,
    isBackground: boolean,
    resetTimer: (eventType?: string, toolName?: string) => void
  ): Promise<void> {
    let hasTextDelta = false;
    let hasReceivedText = false;

    let lastSessionId: string | undefined;

    try {
      for await (const event of stream) {
      // 每收到事件重置空闲超时，传入事件类型和工具名
      const toolName = event.type === 'assistant'
        ? event.message?.content?.find((c: any) => c.type === 'tool_use')?.name
        : undefined;
      resetTimer(event.type, toolName);

      // 记录所有事件类型（INFO级别，便于诊断）
      logger.info(`[MessageProcessor] Event: type=${event.type}, subtype=${event.subtype || 'none'}`);

      // 提取 session_id（只在首次或变化时更新）
      if (event.session_id && event.session_id !== lastSessionId) {
        logger.info(`[MessageProcessor] Extracted session_id: ${event.session_id} for session: ${session.id}`);
        this.agentRunner.updateSessionId(session.id, event.session_id);
        lastSessionId = event.session_id;
      }

      // 动态判断当前是否是后台任务
      const currentActive = await this.sessionManager.getActiveSession(session.channel, session.channelId);
      const isCurrentlyBackground = currentActive ? session.id !== currentActive.id : false;

      // === 前台任务：正常处理所有事件 ===
      if (!isCurrentlyBackground) {
        // 流式文本事件
        if (event.type === 'text_delta' && event.text) {
          hasTextDelta = true;
          hasReceivedText = true;
          flusher.addText(event.text);
        }

        // 系统事件：compact_boundary（群聊时静默）
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          if (!this.currentIsGroup) {
            const preTokens = event.compact_metadata?.pre_tokens || 0;
            flusher.addActivity(`💡 会话压缩完成，继续执行...（压缩前 tokens: ${preTokens}）`);
          }
        }

        // Assistant 事件：提取工具调用和文本内容
        if (event.type === 'assistant' && event.message?.content) {
          for (const content of event.message.content) {
            if (content.type === 'tool_use') {
              const desc = this.formatToolDescription(content);
              flusher.addActivity(`🔧 ${content.name}${desc ? ': ' + desc : ''}`);
            } else if (content.type === 'text' && content.text && !hasTextDelta) {
              // 仅在没有 text_delta 事件时从 assistant 事件提取文本，避免重复
              hasReceivedText = true;
              flusher.addTextBlock(content.text);
            }
          }
        }

        // 工具结果事件：显示失败信息（包括权限拒绝、执行失败等所有场景）
        if (event.type === 'tool_result') {
          logger.debug(`[MessageProcessor] tool_result: is_error=${event.is_error}, error=${event.error}, content=${typeof event.content}`);

          if (event.is_error) {
            const toolName = event.tool_name || '工具';
            const errorMsg = event.error || (typeof event.content === 'string' ? event.content : JSON.stringify(event.content)) || '执行失败';
            flusher.addActivity(`⚠️ ${toolName}: ${errorMsg}`);
          }
        }

        // Result 事件：仅在没有流式文本时使用 result 作为最终输出
        if (event.type === 'result' && event.result) {
          logger.debug(`[MessageProcessor] result event: hasReceivedText=${hasReceivedText}, result="${event.result}"`);
          if (!hasReceivedText) {
            // 没有通过 text_delta 或 assistant 收到文本，使用 result 作为兜底
            flusher.addText(event.result);
          }
          await flusher.flush();
        }

        continue;
      }

      // === 后台任务：只处理 result 事件，仅缓存不发送 ===
      if (event.type !== 'result') {
        continue;
      }

      if (event.subtype === 'success') {
        this.messageCache.addEvent(session.id, {
          type: 'completed',
          message: event.result,
          timestamp: Date.now(),
          metadata: {
            duration: event.duration_ms,
            cost: event.total_cost_usd
          }
        });
      } else if (event.is_error === true) {
        this.messageCache.addEvent(session.id, {
          type: 'error',
          message: event.errors?.join('\n') || '未知错误',
          timestamp: Date.now(),
          metadata: {
            errorType: event.subtype
          }
        });
      }
    }
    } catch (error) {
      // 捕获 SDK 进程崩溃或流迭代错误
      logger.error('[MessageProcessor] Stream processing error:', error);
      if (error instanceof Error && error.message.includes('process exited')) {
        flusher.addActivity('❌ Claude Code 进程异常退出，请重试');
      }
      throw error; // 重新抛出，让外层处理
    }
  }

  /**
   * 判断是否为上下文过长错误
   */
  private isContextTooLongError(error: any): boolean {
    const msg = (error?.message || String(error)).toLowerCase();
    return msg.includes('上下文过长') || msg.includes('context too long')
      || msg.includes('context_length_exceeded');
  }

  /**
   * 格式化工具描述（通用）
   */
  private formatToolDescription(toolUse: {
    name: string;
    input: Record<string, any>;
  }): string {
    const input = toolUse.input || {};
    return (
      input.description ||
      input.file_path ||
      input.pattern ||
      (typeof input.command === 'string' ? input.command.substring(0, 80) : undefined) ||
      (typeof input.prompt === 'string' ? input.prompt.substring(0, 80) : undefined) ||
      (typeof input.query === 'string' ? input.query.substring(0, 80) : undefined) ||
      ''
    );
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
}
