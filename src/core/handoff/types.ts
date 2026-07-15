import type { CausationContext } from '../causation/types.js';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export const HANDOFF_STATES = [
  'queued',
  'target_sent',
  'return_pending',
  'origin_queued',
  'origin_delivered',
  'completed',
] as const;

export type HandoffState = typeof HANDOFF_STATES[number];

export const HANDOFF_QUERY_DEFAULT_LIMIT = 100;
export const HANDOFF_QUERY_MAX_LIMIT = 500;

export type HandoffAttentionReason =
  | 'TARGET_SEND_OUTCOME_UNKNOWN'
  | 'TARGET_SEND_RETRIES_EXHAUSTED'
  | 'REPLY_BINDING_INCOMPLETE'
  | 'STORE_CONFLICT'
  | 'STORE_CORRUPT';

export interface HandoffRequest {
  payload: Record<string, unknown>;
  encrypt: boolean;
}

export interface HandoffInstance {
  schema_version: typeof HANDOFF_SCHEMA_VERSION;
  handoff_id: string;
  origin_session_id: string;
  origin_message_id: string;
  target_session_id: string;
  request: HandoffRequest;
  causation?: CausationContext;
  return_causation?: CausationContext;
  return_policy: 'required';
  state: HandoffState;
  target_message_id: string | null;
  response_message_id: string | null;
  consumed_at: number | null;
  consumed_target_session_id: string | null;
  return_content: string | null;
  return_content_hash: string | null;
  origin_delivery_message_id: string | null;
  attention_required: boolean;
  attention_reason: HandoffAttentionReason | null;
  version: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export type HandoffEventType =
  | 'created'
  | 'target_send_started'
  | 'target_send_succeeded'
  | 'target_send_failed'
  | 'reply_bound'
  | 'return_accepted'
  | 'origin_enqueue_succeeded'
  | 'origin_enqueue_failed'
  | 'origin_context_consumed'
  | 'attention_required';

export interface HandoffEvent {
  event_id: string;
  event_type: HandoffEventType;
  handoff_id?: string;
  operation_key?: string;
  from_version?: number;
  to_version?: number;
  details?: Record<string, unknown>;
  created_at: number;
}

export interface HandoffReturnCandidate {
  handoff_id: string;
  state: HandoffState;
  request_summary: string;
}

export type HandoffReturnCode =
  | 'HANDOFF_RETURN_ACCEPTED'
  | 'HANDOFF_RETURN_ALREADY_APPLIED'
  | 'INVALID_HANDOFF_ID'
  | 'HANDOFF_ID_REQUIRED'
  | 'AMBIGUOUS_HANDOFF'
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_TARGET_SESSION_MISMATCH'
  | 'HANDOFF_CONSUMPTION_BINDING_INVALID'
  | 'HANDOFF_NOT_RETURNABLE'
  | 'HANDOFF_RETURN_CONTENT_REQUIRED'
  | 'HANDOFF_RETURN_CONFLICT'
  | 'HANDOFF_STORE_WRITE_FAILED'
  | 'DELEGATION_REQUIRED'
  | 'INVALID_DELEGATION';

export interface HandoffReturnSuccess {
  ok: true;
  code: 'HANDOFF_RETURN_ACCEPTED' | 'HANDOFF_RETURN_ALREADY_APPLIED';
  handoff_id: string;
  selected_by: 'explicit_id' | 'single_current_task_candidate';
  previous_state: HandoffState;
  state: HandoffState;
  idempotent: boolean;
}

export interface HandoffReturnError {
  ok: false;
  code: Exclude<HandoffReturnCode, HandoffReturnSuccess['code']>;
  error: string;
  handoff_id?: string;
  state?: HandoffState;
  retryable?: boolean;
  candidates?: HandoffReturnCandidate[];
}

export type HandoffReturnResponse = HandoffReturnSuccess | HandoffReturnError;

export interface HandoffStatusResponse {
  ok: true;
  handoff_id: string;
  state: HandoffState;
  origin_session_id: string;
  target_session_id: string;
  return_policy: 'required';
  created_at: number;
  updated_at: number;
  attention_required: boolean;
  attention_reason: HandoffAttentionReason | null;
}

export interface HandoffListItem {
  handoff_id: string;
  state: HandoffState;
  origin_session_id: string;
  target_session_id: string;
  return_policy: 'required';
  created_at: number;
  updated_at: number;
  attention_required: boolean;
  attention_reason: HandoffAttentionReason | null;
}

export interface HandoffListResponse {
  ok: true;
  handoffs: HandoffListItem[];
}

export interface HandoffTraceResponse {
  ok: true;
  handoff_id: string;
  events: HandoffEvent[];
}
