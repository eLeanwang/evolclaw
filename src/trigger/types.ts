export type TriggerSource =
  | { type: 'delay'; afterMs: number }
  | { type: 'at'; at: string }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; everyMs: number };

export type TriggerFeedbackMode = 'none' | 'direct-message' | 'agent-runner';
export type TriggerSessionStrategy = 'latest' | 'current' | 'thread';
export type TriggerConcurrency = 'forbid' | 'replace' | 'allow';
export type TriggerMissedPolicy = 'skip' | 'run_once' | 'run_all';

export interface TriggerOrigin {
  channel?: string;
  peerId?: string;
  sessionKey?: string;
}

export interface TriggerScriptConfig {
  path: string;
  runtime: string;
  args?: unknown;
  timeoutMs?: number;
}

export interface TriggerFeedbackTarget {
  channelType: string;
  channelName?: string;
  channelId: string;
  sessionStrategy?: TriggerSessionStrategy;
  sessionId?: string;
  threadId?: string;
}

export interface TriggerFeedbackAction {
  mode: TriggerFeedbackMode;
  target?: TriggerFeedbackTarget;
  template?: string;
}

export interface TriggerFeedbackConfig {
  onSuccess: TriggerFeedbackAction;
  onNoop?: TriggerFeedbackAction;
  onFailure: TriggerFeedbackAction;
}

export interface TriggerReliability {
  concurrency: TriggerConcurrency;
  missedPolicy: TriggerMissedPolicy;
  scriptRetry: {
    maxAttempts: number;
    backoffMs: number;
  };
}

export interface TriggerDefinition {
  $schema_version: 1;
  id: string;
  agentAid: string;
  enabled: boolean;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  origin?: TriggerOrigin;
  source: TriggerSource;
  script?: TriggerScriptConfig;
  feedback: TriggerFeedbackConfig;
  reliability: TriggerReliability;
}

export interface TriggerCreateFile {
  relativePath: string;
  contentBase64: string;
}

export type TriggerFeedbackBranch = 'onSuccess' | 'onNoop' | 'onFailure';
export type TriggerRunPhase = 'running' | 'feedback-pending';
export type TriggerRunStatus = 'completed' | 'noop' | 'skipped' | 'failed' | 'dry-run';

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

export interface TriggerActiveFile {
  runs: Record<string, TriggerActiveRun>;
  schedule?: TriggerScheduleState;
}

export interface TriggerScheduleState {
  nextFireAt: number;
  updatedAt: number;
  sourceSignature: string;
}

export interface TriggerSourceRunInfo {
  type: TriggerSource['type'];
  scheduledAt?: number;
  firedAt: number;
  payload: Record<string, unknown>;
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

export interface TriggerEffectRecord {
  type: 'message.send' | 'agent-runner.enqueue';
  status: 'success' | 'failed' | 'skipped';
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
    schemaVersion: 1;
    revision: string;
    name: string;
  };
  source: TriggerSourceRunInfo;
  script?: TriggerScriptResult | null;
  feedback?: {
    branch: TriggerFeedbackBranch;
    mode: TriggerFeedbackMode;
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
