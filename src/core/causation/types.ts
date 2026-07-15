export const CAUSATION_VERSION = 1 as const;
export const MAX_TRIGGER_CAUSATION_DEPTH = 16;

export interface TriggerCausationNode {
  triggerId: string;
  runId: string;
}

export interface TriggerCausationExtension {
  path: TriggerCausationNode[];
}

export interface CausationContext {
  version: typeof CAUSATION_VERSION;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  trigger?: TriggerCausationExtension;
}

export type CausationSpanType =
  | 'message.inbound'
  | 'message.outbound'
  | 'task.run'
  | 'handoff.request'
  | 'handoff.response'
  | 'permission.request'
  | 'permission.decision'
  | 'permission.consume'
  | 'trigger.run';

export interface CausationSpanRefs {
  messageId?: string;
  taskId?: string;
  sessionId?: string;
  handoffId?: string;
  permissionRequestId?: string;
  grantId?: string;
  triggerId?: string;
  runId?: string;
}

export interface CausationSpanRecord {
  version: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  type: CausationSpanType;
  timestamp: number;
  status?: 'started' | 'completed' | 'failed' | 'skipped';
  refs?: CausationSpanRefs;
  reason?: string;
}

export interface CausationSpanLinkRecord {
  version: 1;
  spanId: string;
  linkedTraceId: string;
  linkedSpanId: string;
  relation: 'batch_input';
  timestamp: number;
}

export interface CausationCarrier {
  causation?: CausationContext;
}
