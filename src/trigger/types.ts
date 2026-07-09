import type { PermissionMode } from '../types.js';

export type TriggerMatchValue =
  | string
  | number
  | boolean
  | { $in: unknown[] }
  | { $regex: string }
  | { $gt?: number; $gte?: number; $lt?: number; $lte?: number }
  | { $exists: boolean };

export interface TriggerEventFilter {
  match?: Record<string, TriggerMatchValue>;
}

export interface TriggerEventSource {
  type: 'event';
  eventPattern: string;
  filter?: TriggerEventFilter;
}

export interface TriggerSourceEvent {
  sourceType: 'event';
  eventName: string;
  firedAt: number;
  payload: Record<string, unknown>;
}

export type TriggerSource =
  | { type: 'once' }
  | { type: 'delay'; afterMs: number }
  | { type: 'at'; at: string }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; everyMs: number }
  | TriggerEventSource;

export type TriggerExecutionType = 'script' | 'trigger_session' | 'target_session';
export type TriggerExecutionThread = 'per_run' | 'by_trigger';
export type TriggerConcurrency = 'forbid' | 'replace' | 'allow';
export type TriggerMissedPolicy = 'skip' | 'run_once' | 'run_all';
export type TriggerFeedbackBranch = 'onReply' | 'onNoop' | 'onFailure';
export type TriggerRunPhase = 'running' | 'feedback-pending';
export type TriggerRunStatus = 'completed' | 'noop' | 'skipped' | 'failed' | 'dry-run';
export type TriggerPermissionMode = PermissionMode;
export type TriggerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TriggerOrigin {
  channelKey: string;
  channelId: string;
  session: 'main' | 'thread';
  threadId?: string;
  peerId?: string;
  sessionKey?: string;
}

export interface TriggerScriptConfig {
  path: string;
  runtime: string;
  args?: unknown;
  timeoutMs?: number;
}

export interface TriggerScriptPreview {
  path: string;
  runtime: string;
  content?: string;
  sizeBytes?: number;
  truncated?: boolean;
  mtime?: number;
  error?: string;
}

export interface TriggerExecution {
  type: TriggerExecutionType;
  prompt?: string;
  script?: TriggerScriptConfig;
  thread?: TriggerExecutionThread;
  model?: string;
  effort?: TriggerEffort;
  permissionMode?: TriggerPermissionMode;
  onError: 'fail' | 'retry';
  noopSentinel: string;
}

export interface TriggerFeedbackTarget {
  channelKey: string;
  channelId: string;
  session: 'main' | 'thread';
  threadId?: string;
}

export type TriggerFeedbackStrategy = 'origin' | 'target' | 'silent';

export interface TriggerFeedbackTemplate {
  template?: string;
}

export interface TriggerFeedbackConfig {
  strategy: TriggerFeedbackStrategy;
  target?: TriggerFeedbackTarget;
  onReply?: TriggerFeedbackTemplate;
  onNoop?: TriggerFeedbackTemplate;
  onFailure?: TriggerFeedbackTemplate;
}

export interface TriggerReliability {
  concurrency: TriggerConcurrency;
  missedPolicy: TriggerMissedPolicy;
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
}

export interface TriggerLimits {
  maxRuns?: number;
  maxDuration?: string;
}

export interface TriggerDefinition {
  $schema_version: 4;
  id: string;
  agentAid: string;
  enabled: boolean;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  origin?: TriggerOrigin;
  source: TriggerSource;
  execution: TriggerExecution;
  feedback: TriggerFeedbackConfig;
  reliability: TriggerReliability;
  limits?: TriggerLimits;
}

export interface TriggerCreateFile {
  relativePath: string;
  contentBase64: string;
}

export interface TriggerRunEvent {
  seq: number;
  event: string;
  ts: number;
  [key: string]: unknown;
}

export interface TriggerActiveRun {
  phase: TriggerRunPhase;
  triggerId: string;
  runId: string;
  startedAt: number;
  deadlineAt?: number;
  events: TriggerRunEvent[];
}

export interface TriggerLimitState {
  startedAt: number;
  runCount: number;
  disabledReason?: 'max_runs' | 'max_duration';
}

export interface TriggerActiveFile {
  runs: Record<string, TriggerActiveRun>;
  schedule?: TriggerScheduleState;
  limits?: TriggerLimitState;
}

export interface TriggerScheduleState {
  nextFireAt: number;
  updatedAt: number;
  sourceSignature: string;
  lastScheduledAt?: number;
  lastFiredAt?: number;
}

export interface TriggerSourceRunInfo {
  type: TriggerSource['type'];
  eventName?: string;
  scheduledAt?: number;
  firedAt: number;
  payload: Record<string, unknown>;
}

export type TriggerSubscriptionStatus = 'active' | 'inactive' | 'event-bus-unavailable' | 'not-event';

export interface TriggerSubscriptionInfo {
  status: TriggerSubscriptionStatus;
  warning?: string;
}

export interface TriggerScriptResult {
  exitCode: number;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutHash?: string;
  stderrHash?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    stdoutPreview?: string;
    stderrPreview?: string;
  };
}

export interface AgentTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

export interface TriggerReply {
  outcome: 'success' | 'noop' | 'error' | 'interrupted' | 'timeout';
  text: string;
  files: { path: string; name?: string }[];
  error?: { reason?: string; text: string };
  meta: {
    runId: string;
    durationMs: number;
    numTurns?: number;
    tokenUsage?: AgentTokenUsage;
    contextUsage?: unknown;
    toolCallCount: number;
  };
}

export interface TriggerProcessingAudit {
  mode: TriggerExecutionType;
  renderedTextHash?: string;
  renderedTextPreview?: string;
}

export interface TriggerEffectRecord {
  type: 'message.send' | 'message.inbound' | 'agent.conversation';
  status: 'success' | 'failed' | 'skipped';
  channelKey?: string;
  channelType?: string;
  channelId?: string;
  sessionId?: string;
  messageId?: string;
  attempt: number;
  startedAt: number;
  finishedAt: number;
  error?: string;
}

export interface TriggerAuditRecord {
  runId: string;
  triggerId: string;
  agentAid: string;
  startedAt: number;
  finishedAt: number;
  status: TriggerRunStatus;
  reason?: string;
  conflictRunId?: string;
  definition: {
    schemaVersion: 4;
    revision: string;
    name: string;
  };
  source: TriggerSourceRunInfo;
  processing?: TriggerProcessingAudit | null;
  script?: TriggerScriptResult | null;
  reply?: {
    outcome: TriggerReply['outcome'];
    textHash?: string;
    textPreview?: string;
    fileCount: number;
    durationMs: number;
    numTurns?: number;
    tokenUsage?: AgentTokenUsage;
    toolCallCount: number;
  } | null;
  feedback?: {
    branch?: TriggerFeedbackBranch;
    strategy: TriggerFeedbackStrategy;
    target?: TriggerFeedbackTarget;
    renderedTextHash?: string;
    renderedTextPreview?: string;
  } | null;
  effects: TriggerEffectRecord[];
  error: { code: string; message: string } | null;
}

export interface TriggerRunPayload {
  scheduledAt?: number;
  firedAt: number;
  payload?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface TriggerRuntimeResult {
  ok: boolean;
  runId: string;
  triggerId: string;
  status: TriggerRunStatus;
  reason?: string;
  audit?: TriggerAuditRecord;
  error?: string;
}
