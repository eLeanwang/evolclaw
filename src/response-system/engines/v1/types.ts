export type {
  ResponseMode as V1ResponseMode,
  ResponseModeContext as V1Context,
  InboundMessage,
  InboundDecision,
  OutboundPayload,
  OutboundDecision,
  MessageQueueInterface,
  ProcessContext,
  RunConfig,
  ToolUseContext,
  CompleteContext,
  AfterProcessContext,
} from '../../types.js';

import type {
  ResponseModeContext,
  InboundMessage,
  InboundDecision,
  OutboundPayload,
  OutboundDecision,
  ProcessContext,
  RunConfig,
  ToolUseContext,
  CompleteContext,
  AfterProcessContext,
} from '../../types.js';

/**
 * V1 流（flow）—— 单会话处理行为的载体，按 chatMode 二选一。
 *
 * 钩子面与 ResponseMode 的处理钩子一一对应，差异仅在：
 * - flow 是无状态单例，不持有 context——handleInbound/handleOutbound 显式收
 *   ResponseModeContext，per-message 状态存 ctx.state；
 * - 不含模式元数据/生命周期/队列——那些属于模式层（modes/single-session 薄包装）。
 *
 * chatMode 分流收拢在引擎内（flowForChatMode），模式层与调用方不再散布分支。
 */
export interface V1Flow {
  readonly chatMode: 'interactive' | 'proactive';

  handleInbound(message: InboundMessage, ctx: ResponseModeContext): Promise<InboundDecision> | InboundDecision;
  handleOutbound(payload: OutboundPayload, ctx: ResponseModeContext): Promise<OutboundDecision> | OutboundDecision;

  beforeProcess?(ctx: ProcessContext): Promise<void> | void;
  configureRun?(ctx: ProcessContext): RunConfig | undefined;
  onToolUse?(ctx: ToolUseContext): Promise<void> | void;
  onComplete?(ctx: CompleteContext): Promise<void> | void;
  afterProcess?(ctx: AfterProcessContext): Promise<void> | void;
}
