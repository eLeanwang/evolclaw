import type {
  ResponseMode,
  InboundDecision,
  OutboundDecision,
  ResponseModeContext,
  InboundMessage,
  OutboundPayload,
  MessageQueueInterface,
  AfterProcessContext,
} from '../../types.js';
import { FIFOQueue } from '../../queues/fifo-queue.js';

export class InteractiveMode implements ResponseMode {
  readonly id = 'interactive';
  readonly displayName = '交互模式';
  readonly description = '输出即回复，所有消息立即处理。人机单聊默认。';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['private'] as ('private' | 'group')[];

  private queue = new FIFOQueue();
  private context?: ResponseModeContext;

  async initialize(context: ResponseModeContext): Promise<void> {
    this.context = context;
    this.context.logger.debug('[ResponseSystem] interactive initialized');
  }
  async cleanup(): Promise<void> { await this.queue.clear(); }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    this.context?.logger.debug('[ResponseSystem] interactive inbound chatType=' + message.chatType + ' peerId=' + message.peerId);
    return { action: 'process', queueBehavior: 'enqueue' };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    this.context?.logger.debug('[ResponseSystem] interactive outbound kind=' + ((payload as any).kind ?? 'unknown'));
    return { method: 'direct', type: 'message' };
  }

  /**
   * Runner 返回后：处理文本中的文件标记（[SEND_FILE:...]）。
   * interactive 模式特有——proactive 改用 ctl file 工具，不走标记。
   * 扫描属模式决策，实际发送由引擎能力 ctx.processFileMarkers 完成（多通道路由/权限/路径）。
   */
  async afterProcess(ctx: AfterProcessContext): Promise<void> {
    await ctx.processFileMarkers(ctx.fullText);
  }

  getQueue(): MessageQueueInterface { return this.queue; }
}
