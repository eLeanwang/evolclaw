/**
 * Decision Executor
 *
 * 执行响应模式返回的决策对象（InboundDecision / OutboundDecision）。
 *
 * 设计：决策与执行分离
 *   - 响应模式只做决策（返回 Decision 对象，纯函数、易测试）
 *   - DecisionExecutor 负责执行（操作队列、发送消息、切换模型）
 *
 * 副作用通过 ExecutorSinks 接口注入，便于单测 mock。
 *
 * 异常处理（D6）：不降级。执行中任何异常都记录日志、上报，由调用方决定后续。
 */

import type {
  InboundDecision,
  OutboundDecision,
  InboundMessage,
  OutboundPayload,
  ResponseModeContext,
} from './types.js';

/** 执行决策时的副作用出口（由 Coordinator 注入真实实现，单测注入 mock） */
export interface ExecutorSinks {
  /** 入队（标准路径：enqueue / priority / clear-and-enqueue / interrupt） */
  enqueue(message: InboundMessage, behavior: NonNullable<InboundDecision['queueBehavior']>): Promise<void>;
  /** 清空队列（clear-and-enqueue 用） */
  clearQueue(): Promise<void>;
  /** 中断当前处理（interrupt 用） */
  interrupt(): Promise<void>;
  /** 切换模型（instructions.switchModel） */
  switchModel(model: string): Promise<void>;
  /** 注入上下文（instructions.injectContext） */
  injectContext(docs: string[]): Promise<void>;
  /** 发送消息（出站 direct） */
  send(payload: OutboundPayload, type: 'message' | 'thought'): Promise<void>;
}

export class DecisionExecutor {
  constructor(
    private sinks: ExecutorSinks,
    private logger: ResponseModeContext['logger'],
  ) {}

  /**
   * 执行入站决策。
   * @returns 是否实际入队（drop/defer 返回 false）
   */
  async executeInbound(
    decision: InboundDecision,
    message: InboundMessage,
    context: ResponseModeContext,
  ): Promise<boolean> {
    // 逃生舱优先
    if (decision.customHandler) {
      await decision.customHandler(message, context);
      return false; // customHandler 自行处理，不走标准入队
    }

    if (decision.action === 'drop') {
      this.logger.debug(`[Executor] inbound dropped: ${decision.reason ?? 'no reason'}`);
      return false;
    }
    if (decision.action === 'defer') {
      this.logger.debug(`[Executor] inbound deferred: ${decision.reason ?? 'no reason'}`);
      return false;
    }

    // action === 'process'：先执行附加指令，再入队
    if (decision.instructions?.switchModel) {
      await this.sinks.switchModel(decision.instructions.switchModel);
    }
    if (decision.instructions?.injectContext?.length) {
      await this.sinks.injectContext(decision.instructions.injectContext);
    }
    if (decision.instructions?.interruptCurrent) {
      await this.sinks.interrupt();
    }

    const behavior = decision.queueBehavior ?? 'enqueue';
    if (behavior === 'clear-and-enqueue') {
      await this.sinks.clearQueue();
      await this.sinks.enqueue(message, 'enqueue');
    } else {
      await this.sinks.enqueue(message, behavior);
    }
    return true;
  }

  /**
   * 执行出站决策。
   * @returns 是否实际发送（suppress/defer/batch 返回 false）
   */
  async executeOutbound(
    decision: OutboundDecision,
    payload: OutboundPayload,
    context: ResponseModeContext,
  ): Promise<boolean> {
    // 逃生舱优先
    if (decision.customSender) {
      await decision.customSender(payload, context);
      return true;
    }

    switch (decision.method) {
      case 'direct':
        await this.sinks.send(payload, decision.type ?? 'message');
        return true;
      case 'suppress':
        this.logger.debug(`[Executor] outbound suppressed: ${decision.reason ?? 'no reason'}`);
        return false;
      case 'defer':
      case 'batch':
        // defer/batch 由响应模式自行决定何时调 send，此处不发
        this.logger.debug(`[Executor] outbound ${decision.method}: held by mode`);
        return false;
      default:
        this.logger.warn(`[Executor] unknown outbound method: ${(decision as any).method}`);
        return false;
    }
  }
}
