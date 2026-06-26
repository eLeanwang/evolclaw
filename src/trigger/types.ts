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
  | { type: 'delay'; afterMs: number }
  | { type: 'at'; at: string }
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; everyMs: number }
  | TriggerEventSource;

export type TriggerExecutionMode = 'agent' | 'script';
export type TriggerExecutionSessionStrategy = 'isolated' | 'thread' | 'main';
export type TriggerConcurrency = 'forbid' | 'replace' | 'allow';
export type TriggerMissedPolicy = 'skip' | 'run_once' | 'run_all';
export type TriggerFeedbackBranch = 'onReply' | 'onNoop' | 'default';
export type TriggerRunPhase = 'running' | 'feedback-pending';
export type TriggerRunStatus = 'completed' | 'noop' | 'skipped' | 'failed' | 'dry-run';

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

export interface TriggerExecutionSession {
  strategy: TriggerExecutionSessionStrategy;
  baseagent?: string;
  channelKey?: string;
  channelId?: string;
  sessionId?: string;
  threadId?: string;
  name?: string;
}

export interface TriggerExecution {
  mode: TriggerExecutionMode;
  prompt?: string;
  script?: TriggerScriptConfig;
  session: TriggerExecutionSession;
  onError: 'fail' | 'retry';
  noopSentinel: string;
}

export type FeedbackDelivery = 'direct' | 'inbound';

export interface FeedbackTarget {
  channelKey: string;
  channelId: string;
  delivery: FeedbackDelivery;
  threadId?: string;
}

export type FeedbackDisposition =
  | { kind: 'forward'; targets: FeedbackTarget[]; template?: string }
  | { kind: 'reply-origin'; template?: string }
  | { kind: 'silent' };

export interface TriggerFeedbackConfig {
  onReply: FeedbackDisposition;
  onNoop: FeedbackDisposition;
  default: FeedbackDisposition;
}

export interface TriggerReliability {
  concurrency: TriggerConcurrency;
  missedPolicy: TriggerMissedPolicy;
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
}

export interface TriggerDefinition {
  $schema_version: 3;
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
  eventName?: string;
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
  mode: TriggerExecutionMode;
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
    schemaVersion: 3;
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
    branch: TriggerFeedbackBranch;
    disposition: FeedbackDisposition['kind'];
    target?: FeedbackTarget | FeedbackTarget[];
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
