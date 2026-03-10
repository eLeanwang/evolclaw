import path from 'path';
import { AgentRunner } from './agent-runner.js';
import { SessionManager } from './session-manager.js';
import { StreamFlusher } from './stream-flusher.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/error-handler.js';
import type { Message, Config, Session, ChannelAdapter, ChannelOptions, CommandHandler } from '../types.js';

/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class MessageProcessor {
  private channels = new Map<string, { adapter: ChannelAdapter; options?: ChannelOptions }>();
  private currentFlusher?: StreamFlusher;

  constructor(
    private agentRunner: AgentRunner,
    private sessionManager: SessionManager,
    private config: Config,
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
    if (this.currentFlusher) {
      this.currentFlusher.addActivity('⏳ 会话压缩中...');
    }
  }

  /**
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
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
        const cmdResult = await this.commandHandler(message.content, message.channel, message.channelId);
        if (cmdResult) {
          await adapter.sendText(message.channelId, cmdResult);
          return;
        }
      }

      // 解析会话和项目路径
      const { session, absoluteProjectPath } = await this.resolveSession(message);

      // 记录收到消息
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'received'
      });

      const imageInfo = message.images && message.images.length > 0 ? ` [${message.images.length} image(s)]` : '';
      logger.info(`[${message.channel}] ${message.channelId}: ${message.content}${imageInfo}`);

      // 记录开始处理
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'processing'
      });

      const startTime = Date.now();

      // 创建 StreamFlusher，传入文件标记模式用于自动过滤
      const flusher = new StreamFlusher(
        (text) => adapter.sendText(message.channelId, text),
        this.config.flushDelay ?? 4000,
        options?.fileMarkerPattern
      );

      // 保存当前 flusher，用于 compact 事件
      this.currentFlusher = flusher;

      // 调用 AgentRunner
      const stream = await this.agentRunner.runQuery(
        session.id,
        message.content,
        absoluteProjectPath,
        session.claudeSessionId,
        message.images,
        options?.systemPromptAppend
      );

      // 使用 channelId 作为 stream key 存储，便于中断
      const streamKey = `${message.channel}-${message.channelId}`;
      this.agentRunner.registerStream(streamKey, stream);

      // 处理事件流
      await this.processEventStream(
        stream,
        session.id,
        message.channelId,
        adapter,
        options,
        flusher
      );

      // 处理文件标记（Feishu 专用）- 提取并发送文件
      if (options?.fileMarkerPattern && adapter.sendFile) {
        const fullText = flusher.getFinalText();
        const fileMatches = [...fullText.matchAll(options.fileMarkerPattern)];

        for (const match of fileMatches) {
          const filePath = match[1].trim();
          const absoluteFilePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(absoluteProjectPath, filePath);
          logger.info(`[${adapter.name}] Sending file: ${absoluteFilePath}`);
          await adapter.sendFile(message.channelId, absoluteFilePath);
        }
      }

      // Flush 剩余内容（文件标记已在 flush 时自动移除）
      await flusher.flush();

      // 清理 activeStreams（正常完成）
      this.agentRunner.cleanupStream(streamKey);

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
    sessionId: string,
    channelId: string,
    adapter: ChannelAdapter,
    options: ChannelOptions | undefined,
    flusher: StreamFlusher
  ): Promise<void> {
    for await (const event of stream) {
      // 提取 session_id
      if (event.session_id) {
        this.agentRunner.updateSessionId(sessionId, event.session_id);
      }

      // 系统事件：compact_boundary
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        const preTokens = event.compact_metadata?.pre_tokens || 0;
        flusher.addActivity(`💡 会话压缩完成，继续执行...（压缩前 tokens: ${preTokens}）`);
      }

      // Assistant 事件：提取工具调用
      if (event.type === 'assistant' && event.message?.content) {
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            const desc = this.formatToolDescription(content);
            flusher.addActivity(`🔧 ${content.name}${desc ? ': ' + desc : ''}`);
          }
        }
      }

      // Result 事件：累积文本
      if (event.type === 'result' && event.result) {
        flusher.addText(event.result);
      }
    }
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
}
