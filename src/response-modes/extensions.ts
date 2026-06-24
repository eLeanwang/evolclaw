/**
 * Response Mode System - Extension Capabilities
 *
 * 扩展能力接口：采用可选接口模式（方案 B）
 * - 简单模式不需要实现用不到的方法
 * - 通过类型守卫判断能力（'methodName' in mode）
 * - 接口职责单一，符合接口隔离原则
 */

import type { AuxiliarySession, ThreadManager, WorkflowEngine } from './types.js';

// ============================================================================
// 扩展能力接口
// ============================================================================

/**
 * 辅助会话能力：模式可创建轻量会话用于判断/过滤
 * 使用场景：dual-session、smart-filter 等模式
 */
export interface WithAuxiliarySession {
  /**
   * 获取辅助会话实例（由模式在 initialize 时创建并缓存）
   */
  getAuxiliarySession(): AuxiliarySession;
}

/**
 * 线索跟踪能力：模式可维护活跃对话线索
 * 使用场景：thread-tracking 模式
 */
export interface WithThreadTracking {
  /**
   * 获取线索管理器实例
   */
  getThreadManager(): ThreadManager;
}

/**
 * 工作流能力：模式可执行多步骤工作流
 * 使用场景：workflow 模式
 */
export interface WithWorkflow {
  /**
   * 获取工作流引擎实例
   */
  getWorkflowEngine(): WorkflowEngine;
}

/**
 * 批量处理能力：模式可批量累积消息后统一处理
 * 使用场景：batch-processor 模式
 */
export interface WithBatchProcessing {
  /**
   * 批量处理累积的消息
   * @param messages 累积的消息列表
   * @returns 处理结果摘要
   */
  processBatch(messages: any[]): Promise<string>;

  /**
   * 获取当前批次状态
   */
  getBatchStatus(): {
    pending: number;
    lastFlushAt?: number;
  };
}

/**
 * 状态持久化能力：模式可保存/恢复运行时状态
 * 使用场景：需要跨重启保持状态的模式
 */
export interface WithStatePersistence {
  /**
   * 保存当前状态到磁盘
   */
  saveState(): Promise<void>;

  /**
   * 从磁盘恢复状态
   */
  loadState(): Promise<void>;

  /**
   * 获取状态快照（用于调试）
   */
  getStateSnapshot(): any;
}

// ============================================================================
// 类型守卫工具
// ============================================================================

/**
 * 检查模式是否支持辅助会话
 */
export function hasAuxiliarySession(mode: any): mode is WithAuxiliarySession {
  return typeof mode === 'object' && mode !== null && 'getAuxiliarySession' in mode;
}

/**
 * 检查模式是否支持线索跟踪
 */
export function hasThreadTracking(mode: any): mode is WithThreadTracking {
  return typeof mode === 'object' && mode !== null && 'getThreadManager' in mode;
}

/**
 * 检查模式是否支持工作流
 */
export function hasWorkflow(mode: any): mode is WithWorkflow {
  return typeof mode === 'object' && mode !== null && 'getWorkflowEngine' in mode;
}

/**
 * 检查模式是否支持批量处理
 */
export function hasBatchProcessing(mode: any): mode is WithBatchProcessing {
  return typeof mode === 'object' && mode !== null && 'processBatch' in mode;
}

/**
 * 检查模式是否支持状态持久化
 */
export function hasStatePersistence(mode: any): mode is WithStatePersistence {
  return typeof mode === 'object' && mode !== null && 'saveState' in mode;
}
