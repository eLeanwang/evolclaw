/**
 * Response Mode System - Public API
 *
 * 统一导出响应系统的所有公共接口
 */

// Core types
export type {
  // Data types
  InboundMessage,
  OutboundPayload,

  // Decision types
  InboundDecision,
  OutboundDecision,

  // Core interfaces
  ResponseMode,
  ResponseModeContext,
  MessageQueueInterface,

  // Auxiliary types
  JSONSchema,
  AuxiliarySession,
  ThreadManager,
  Thread,
  WorkflowEngine,
  WorkflowState,
  WorkflowNode,

  // 处理流程钩子的 Context 类型
  ResponseLogger,
  ProcessContext,
  RunConfig,
  ToolUseContext,
  CompleteContext,
  AfterProcessContext,
} from './types.js';

// Extension capabilities
export type {
  WithAuxiliarySession,
  WithThreadTracking,
  WithWorkflow,
  WithBatchProcessing,
  WithStatePersistence,
} from './extensions.js';

export {
  hasAuxiliarySession,
  hasThreadTracking,
  hasWorkflow,
  hasBatchProcessing,
  hasStatePersistence,
} from './extensions.js';

// Scheduler types (Phase 7, not implemented yet)
export type {
  SchedulingContext,
  SchedulingStrategy,
  Task,
  SlotManager,
  SlotStatus,
} from '../scheduler/types.js';

export {
  TokenBudgetStrategy,
  TimeSliceStrategy,
  FairSchedulingStrategy,
} from '../scheduler/types.js';
