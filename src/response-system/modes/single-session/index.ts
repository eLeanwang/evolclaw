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
import { loadSchema } from '../../../config/schema-registry.js';

/**
 * 模式桶 schema —— 候选值与默认值的**唯一事实源**，从 kits/schemas/single-session.schema.1.json
 * 读取（随包分发、config schema 子命令可展示、write 时桶专项校验共用同一份）。
 * `default` 即运行时出厂默认，由宿主组装 modeConfig 时提取注入（coordinator.schemaDefaults），
 * flow 不再硬编码默认。chatMode 无 default——由宿主按 chatmode 场景表解析后强制注入。
 */
const CONFIG_SCHEMA = loadSchema('single-session').raw as JSONSchema;

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

  /**
   * 本会话生效的 chatmode——从 modeConfig 读取；缺省 interactive（宿主注入前的兜底）。
   * 大小写不敏感：宿主注入的是小写 `chatmode`，但兼容历史/外部注入的 `chatMode`
   * （二者语义同一，不应同时存在）。
   */
  private chatMode(): 'interactive' | 'proactive' {
    const cfg = this.context?.modeConfig as Record<string, unknown> | undefined;
    const value = cfg?.chatmode ?? cfg?.chatMode;
    return value === 'proactive' ? 'proactive' : 'interactive';
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
