/**
 * V1 引擎 —— 交互流（interactive）
 *
 * 行为自合并前的 modes/interactive（InteractiveMode）下沉，语义不变：
 * 输出即回复，所有消息立即处理；Runner 返回后扫描文本中的文件标记
 * （[SEND_FILE:...]），实际发送由引擎能力 ctx.processFileMarkers 完成。
 *
 * flow 是无状态单例：不持有 context，全部依赖由调用点显式传入。
 */

import type {
  V1Context,
  InboundMessage,
  InboundDecision,
  OutboundPayload,
  OutboundDecision,
  AfterProcessContext,
} from './types.js';
import type { V1Flow } from './types.js';

export const interactiveFlow: V1Flow = {
  chatMode: 'interactive',

  handleInbound(message: InboundMessage, ctx: V1Context): InboundDecision {
    ctx.logger.debug('[V1Engine] interactive inbound chatType=' + message.chatType + ' peerId=' + message.peerId);
    return { action: 'process', queueBehavior: 'enqueue' };
  },

  handleOutbound(payload: OutboundPayload, ctx: V1Context): OutboundDecision {
    ctx.logger.debug('[V1Engine] interactive outbound kind=' + ((payload as any).kind ?? 'unknown'));
    return { method: 'direct', type: 'message' };
  },

  /**
   * Runner 返回后：处理文本中的文件标记（[SEND_FILE:...]）。
   * interactive 特有——proactive 改用 ctl file 工具，不走标记。
   */
  async afterProcess(ctx: AfterProcessContext): Promise<void> {
    await ctx.processFileMarkers(ctx.fullText);
  },
};
