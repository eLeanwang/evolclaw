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
} from '../../types.js';
import { FIFOQueue } from '../../queues/fifo-queue.js';

/** proactive 模式的 per-message 运行时状态（存 ctx.state['proactive']） */
export interface ProactiveState {
  firstToolDone: boolean;
  toolCount: number;
  lastQueueReminderLen: number;
  chatType: string;
  peerType?: string;
  preTool1stMsgChk: boolean;
  toolUseReminder: boolean;
  firstSendRequired: boolean;
  toolReportRequired: boolean;
  toolReportInterval: number;
  toolReportPending: boolean;
}

const STATE_KEY = 'proactive';
const TOOL_REPORT_INTERVAL = 10;

function isHumanFacingMessage(message: InboundMessage): boolean {
  if (message.source === 'trigger') return false;
  if (message.chatType === 'group') return true;
  return message.chatType === 'private' && message.peerType === 'human';
}

function buildState(message: InboundMessage, cfg: Record<string, any>): ProactiveState {
  const preTool1stMsgChk = cfg.pre_tool_1stmsgchk ?? true;
  const toolUseReminder = cfg.tool_use_reminder ?? true;
  const humanFacing = isHumanFacingMessage(message);
  return {
    firstToolDone: false,
    toolCount: 0,
    lastQueueReminderLen: 0,
    chatType: message.chatType,
    peerType: message.peerType,
    preTool1stMsgChk,
    toolUseReminder,
    firstSendRequired: preTool1stMsgChk && humanFacing,
    toolReportRequired: toolUseReminder && humanFacing,
    toolReportInterval: TOOL_REPORT_INTERVAL,
    toolReportPending: false,
  };
}

export class ProactiveMode implements ResponseMode {
  readonly id = 'proactive';
  readonly displayName = '主动模式';
  readonly description = '工具调用才回复，普通文本作为思考过程。Agent 对话默认。';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['private', 'group'] as ('private' | 'group')[];
  readonly configSchema = {
    type: 'object' as const,
    properties: {
      pre_tool_1stmsgchk: { type: 'boolean' as const, default: true },
      tool_use_reminder: { type: 'boolean' as const, default: true },
    },
  };

  private queue = new FIFOQueue();
  private context!: ResponseModeContext;

  async initialize(context: ResponseModeContext): Promise<void> {
    this.context = context;
    this.context.logger.debug('[ResponseSystem] proactive initialized');
  }

  async cleanup(): Promise<void> { await this.queue.clear(); }

  // ─── 入站决策（迁移点 1：runtimeState 构造）───
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    this.context?.logger.debug('[ResponseSystem] proactive inbound chatType=' + message.chatType + ' peerId=' + message.peerId);
    const cfg = this.context?.modeConfig ?? {};
    const state = buildState(message, cfg);
    return {
      action: 'process',
      queueBehavior: 'enqueue',
      runtimeState: { proactive: state },
    };
  }

  // ─── 出站决策（迁移点 3：thought 投影）───
  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    this.context?.logger.debug('[ResponseSystem] proactive outbound kind=' + ((payload as any).kind ?? 'unknown'));
    if (payload.kind === 'activity.batch') {
      if (!this.context?.channel.capabilities.supportsThought) {
        return { method: 'suppress', reason: 'channel does not support thought' };
      }
      return { method: 'direct', type: 'thought' };
    }
    return { method: 'direct', type: 'message' };
  }

  // ─── beforeProcess（迁移点 1：把 runtimeState 落入 ctx.state，供后续钩子共享）───
  beforeProcess(ctx: ProcessContext): void {
    const cfg = ctx.modeConfig ?? {};
    const state = buildState(ctx.message, cfg);
    ctx.state.set(STATE_KEY, state);
  }

  // ─── configureRun（迁移点 2：policyHook 首工具表态）───
  configureRun(ctx: ProcessContext): RunConfig | undefined {
    const state = ctx.state.get(STATE_KEY) as ProactiveState | undefined;
    if (!state || (!state.firstSendRequired && !state.toolReportRequired)) return undefined;

    return {
      policyHook: (toolName, toolInput) => {
        const isSendCommand = ctx.isSendCommand(toolName, toolInput);
        if (state.firstSendRequired && !state.firstToolDone) {
          if (!isSendCommand) {
            const cmdHint = state.chatType === 'group' ? 'ec group send' : 'ec msg send';
            const target = state.chatType === 'group' ? '群里' : '对方';
            return { block: true, reason: `请先用 ${cmdHint} 向${target}说明你的意图，再执行其他工具` };
          }
          state.firstToolDone = true;
        }
        if (state.toolReportPending) {
          if (!isSendCommand) {
            const cmdHint = state.chatType === 'group' ? 'ec group send' : 'ec msg send';
            const target = state.chatType === 'group' ? '群里' : '对方';
            return { block: true, reason: `工具调用已达到 ${state.toolCount} 次，请先用 ${cmdHint} 向${target}汇报当前情况和下一步意图，再执行其他工具` };
          }
          state.toolReportPending = false;
        }
        return undefined;
      },
    };
  }

  // ─── onToolUse（迁移点 4：工具汇报提醒）───
  onToolUse(ctx: ToolUseContext): void {
    const state = ctx.state.get(STATE_KEY) as ProactiveState | undefined;
    if (!state || !state.toolUseReminder) return;

    // 队列未读变化提醒
    const queueLen = ctx.getQueueLength();
    if (queueLen !== state.lastQueueReminderLen) {
      state.lastQueueReminderLen = queueLen;
      if (queueLen > 0) {
        const queueMsg = queueLen >= 5
          ? `⚠️ 有 ${queueLen} 条消息未读，请尽快完成当前任务，或使用 ec ctl queue 读取后同步处理。`
          : `⚠️ 有 ${queueLen} 条消息未读，可使用 ec ctl queue 读取。`;
        ctx.injectToModel(queueMsg);
      }
    }

    // 工具计数（排除表态命令白名单）
    const isAllowedTool = ctx.isSendCommand(ctx.toolName, ctx.toolInput);
    if (state.toolReportRequired && !isAllowedTool) state.toolCount++;

    // 每 N 次工具调用警告
    if (state.toolReportRequired && state.toolCount > 0 && state.toolCount % state.toolReportInterval === 0) {
      state.toolReportPending = true;
      const cmdHint = state.chatType === 'group' ? 'ec group send' : 'ec msg send';
      const target = state.chatType === 'group' ? '群里' : '对方';
      ctx.injectToModel(`⚠️ 工具调用已达到 ${state.toolCount} 次，请立即用 ${cmdHint} 向${target}汇报当前情况和下一步意图。`);
    }
  }

  // ─── onComplete（迁移点 5：标志位检查）───
  async onComplete(ctx: CompleteContext): Promise<void> {
    if (/\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(ctx.lastReplyText)) {
      await ctx.updateSessionMeta({ lastProactiveFlag: true });
    }
  }

  // ─── afterProcess（迁移点 6：Unknown skill 兜底）───
  async afterProcess(ctx: AfterProcessContext): Promise<void> {
    if (!ctx.streamResult.hasReceivedText && /^Unknown skill:\s+\S+/i.test(ctx.fullText.trim())) {
      // SDK 本地兜底：直接发送绕过 silent renderer
      await ctx.send({ kind: 'result.text', text: ctx.fullText, isFinal: true } as OutboundPayload);
    }
  }

  getQueue(): MessageQueueInterface { return this.queue; }
}
