import type {
  ResponseMode,
  InboundDecision,
  OutboundDecision,
  ResponseModeContext,
  InboundMessage,
  OutboundPayload,
  MessageQueueInterface,
  ProcessContext,
  RunConfig,
  ToolUseContext,
  CompleteContext,
  AfterProcessContext,
  JSONSchema,
} from '../../types.js';
import { FIFOQueue } from '../../queues/fifo-queue.js';
import { flowForChatMode, type V1Flow } from '../../engines/v1/index.js';

/** 与 config-schema.json 同源（该文件供文档/校验工具读取；此处内联供运行时使用）。 */
const CONFIG_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    chatMode: {
      type: 'string',
      enum: ['interactive', 'proactive'],
      description: '回复投递方式：interactive=输出即回复；proactive=CLI 回复 + 思考投影。每会话生效值由宿主按配置层级（chatmode 场景表）解析后注入。',
    },
    pre_tool_1stmsgchk: { type: 'boolean', default: true, description: 'proactive 首工具表态检查（仅 chatMode=proactive 生效）' },
    tool_use_reminder: { type: 'boolean', default: true, description: 'proactive 工具汇报提醒（仅 chatMode=proactive 生效）' },
  },
};

/**
 * 单会话响应模式（architecture.md §4.1）—— 合并原 interactive / proactive。
 *
 * 本层是薄包装：不含处理行为，全部钩子委托 V1 引擎的 flow。chatMode 决定用哪个
 * flow（interactive / proactive），取值来自 modeConfig.chatMode（宿主按配置层级
 * 解析后注入，见 implementation-plan.md §三；无 auto 值）。
 */
export class SingleSessionMode implements ResponseMode {
  readonly id = 'single-session';
  readonly displayName = '单会话模式';
  readonly description = '单会话直接响应，按 chatMode 决定投递方式。';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['private', 'group'] as ('private' | 'group')[];
  readonly configSchema = CONFIG_SCHEMA;

  private queue = new FIFOQueue();
  private context?: ResponseModeContext;

  async initialize(context: ResponseModeContext): Promise<void> {
    this.context = context;
    context.logger.debug('[ResponseSystem] single-session initialized chatMode=' + this.chatMode());
  }

  async cleanup(): Promise<void> { await this.queue.clear(); }

  /** 本会话生效的 chatMode——从 modeConfig 读取；缺省 interactive（宿主注入前的兜底）。 */
  private chatMode(): 'interactive' | 'proactive' {
    return this.context?.modeConfig?.chatMode === 'proactive' ? 'proactive' : 'interactive';
  }

  private flow(): V1Flow {
    return flowForChatMode(this.chatMode());
  }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    if (!this.context) throw new Error('[single-session] not initialized');
    return this.flow().handleInbound(message, this.context);
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    if (!this.context) throw new Error('[single-session] not initialized');
    return this.flow().handleOutbound(payload, this.context);
  }

  getQueue(): MessageQueueInterface { return this.queue; }

  // ─── 处理流程钩子：存在才委托（proactive flow 提供全套，interactive 仅 afterProcess）───

  beforeProcess(ctx: ProcessContext): Promise<void> | void {
    return this.flow().beforeProcess?.(ctx);
  }

  configureRun(ctx: ProcessContext): RunConfig | undefined {
    return this.flow().configureRun?.(ctx);
  }

  onToolUse(ctx: ToolUseContext): Promise<void> | void {
    return this.flow().onToolUse?.(ctx);
  }

  onComplete(ctx: CompleteContext): Promise<void> | void {
    return this.flow().onComplete?.(ctx);
  }

  afterProcess(ctx: AfterProcessContext): Promise<void> | void {
    return this.flow().afterProcess?.(ctx);
  }
}
