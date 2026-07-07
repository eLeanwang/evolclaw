/**
 * Scheduler - Types
 *
 * 调度层类型定义（预留给 Phase 7，当前暂不实施）
 * 接口已定义，为未来扩展预留扩展点
 */

import type { ResponseMode } from '../response-system/types.js';

// ============================================================================
// 调度上下文
// ============================================================================

/**
 * 调度上下文：提供给调度策略的运行时信息
 */
export interface SchedulingContext {
  /** 当前活跃的响应模式实例 */
  activeMode: ResponseMode;

  /** 当前会话 ID */
  sessionId: string;

  /** 当前任务 ID */
  taskId?: string;

  /** 已消耗的 token 数（本次会话） */
  tokensUsed: number;

  /** token 预算（如果设置） */
  tokenBudget?: number;

  /** 当前处理的消息数 */
  messagesProcessed: number;

  /** 队列中待处理的消息数 */
  queueLength: number;

  /** 当前时间戳 */
  timestamp: number;

  /** 会话元数据 */
  metadata?: Record<string, any>;
}

// ============================================================================
// 调度策略
// ============================================================================

/**
 * 调度策略接口：决定是否允许模式继续执行
 */
export interface SchedulingStrategy {
  /**
   * 判断是否应该让出控制权
   * @param context 调度上下文
   * @returns true=应该让出，false=继续执行
   */
  shouldYield(context: SchedulingContext): boolean;

  /**
   * 选择下一个任务（多任务场景）
   * @param tasks 待处理任务列表
   * @param context 调度上下文
   * @returns 选中的任务 ID，无可执行任务时返回 undefined
   */
  selectNextTask?(tasks: Task[], context: SchedulingContext): string | undefined;

  /**
   * 分配资源配额（token/时间）
   * @param context 调度上下文
   * @returns 分配的配额
   */
  allocateQuota?(context: SchedulingContext): {
    tokens?: number;
    timeMs?: number;
  };
}

/**
 * 任务（多任务调度用）
 */
export interface Task {
  id: string;
  priority: number;
  createdAt: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// Slot 管理器
// ============================================================================

/**
 * Slot 管理器：管理并发执行槽位（预留接口）
 */
export interface SlotManager {
  /**
   * 申请一个执行槽位
   * @param sessionId 会话 ID
   * @returns 槽位 ID，无可用槽位时返回 undefined
   */
  acquire(sessionId: string): Promise<string | undefined>;

  /**
   * 释放槽位
   * @param slotId 槽位 ID
   */
  release(slotId: string): Promise<void>;

  /**
   * 获取槽位状态
   * @param slotId 槽位 ID
   */
  getStatus(slotId: string): SlotStatus | undefined;

  /**
   * 列出所有槽位
   */
  listSlots(): SlotStatus[];

  /**
   * 获取可用槽位数
   */
  availableSlots(): number;
}

/**
 * 槽位状态
 */
export interface SlotStatus {
  id: string;
  sessionId?: string;
  taskId?: string;
  status: 'idle' | 'busy' | 'reserved';
  acquiredAt?: number;
  tokensUsed?: number;
}

// ============================================================================
// 内置调度策略
// ============================================================================

/**
 * Token 预算策略：根据 token 消耗决定是否让出
 */
export class TokenBudgetStrategy implements SchedulingStrategy {
  constructor(private maxTokensPerTurn: number) {}

  shouldYield(context: SchedulingContext): boolean {
    if (!context.tokenBudget) return false;
    return context.tokensUsed >= this.maxTokensPerTurn;
  }
}

/**
 * 时间片策略：根据执行时间决定是否让出
 */
export class TimeSliceStrategy implements SchedulingStrategy {
  constructor(private maxTimeMs: number) {}

  shouldYield(context: SchedulingContext): boolean {
    // 简化实现：实际需要记录任务开始时间
    return false;
  }
}

/**
 * 公平调度策略：轮流执行，防止某个会话独占
 */
export class FairSchedulingStrategy implements SchedulingStrategy {
  private lastSessionId?: string;

  shouldYield(context: SchedulingContext): boolean {
    // 如果当前会话已处理过，且队列中有其他会话的消息，则让出
    if (this.lastSessionId === context.sessionId && context.queueLength > 0) {
      return true;
    }
    this.lastSessionId = context.sessionId;
    return false;
  }
}
