import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveRoot } from '../../paths.js';
import { atomicReadJson } from '../../utils/atomic-write.js';
import { appendJsonl, readAllJsonlLines } from '../session/session-fs-store.js';
import { classifyAunPayloadForLog } from '../message/message-log.js';
import {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_QUERY_DEFAULT_LIMIT,
  HANDOFF_QUERY_MAX_LIMIT,
  type HandoffAttentionReason,
  type HandoffEvent,
  type HandoffEventType,
  type HandoffInstance,
  type HandoffReturnCandidate,
  type HandoffReturnResponse,
  type HandoffState,
  type HandoffStatusResponse,
} from './types.js';

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
export const HANDOFF_ID_RE = /^h-[A-Za-z0-9._-]+$/;

export interface CreateHandoffInput {
  selfAid: string;
  originSessionId: string;
  originMessageId: string;
  targetSessionId: string;
  payload: Record<string, unknown>;
  encrypt: boolean;
  now?: number;
}

export interface BindReplyInput {
  selfAid: string;
  targetSessionId: string;
  responseMessageId: string;
  refMessageId?: string | null;
  now?: number;
}

export interface ReturnHandoffInput {
  selfAid: string;
  currentSessionId: string;
  handoffId?: string;
  currentTaskHandoffIds?: string[];
  content: string;
  now?: number;
}

export interface ListHandoffsInput {
  state?: HandoffState;
  sessionId?: string;
  limit?: number;
}

function safeSegment(value: string, field: string): string {
  if (!value || !SAFE_ID_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function newHandoffId(): string {
  return `h-${crypto.randomBytes(4).toString('hex')}`;
}

function newEventId(): string {
  return `ev-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function normalizeReturnContent(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function boundedQueryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit)) return HANDOFF_QUERY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(HANDOFF_QUERY_MAX_LIMIT, limit));
}

export class HandoffStore {
  constructor(private rootDir = path.join(resolveRoot(), 'data', 'handoff')) {}

  private agentDir(selfAid: string): string {
    return path.join(this.rootDir, safeSegment(selfAid, 'self_aid'));
  }

  private handoffsDir(selfAid: string): string {
    return path.join(this.agentDir(selfAid), 'handoffs');
  }

  private instancePath(selfAid: string, handoffId: string): string {
    if (!HANDOFF_ID_RE.test(handoffId)) throw new Error('invalid handoff_id');
    return path.join(this.handoffsDir(selfAid), safeSegment(handoffId, 'handoff_id'), 'handoff.json');
  }

  private historyPath(selfAid: string): string {
    return path.join(this.agentDir(selfAid), 'history.jsonl');
  }

  private appendEvent(selfAid: string, eventType: HandoffEventType, handoffId: string | undefined, opts: {
    operationKey?: string;
    fromVersion?: number;
    toVersion?: number;
    details?: Record<string, unknown>;
    now?: number;
  } = {}): HandoffEvent {
    fs.mkdirSync(this.agentDir(selfAid), { recursive: true });
    const event: HandoffEvent = {
      event_id: newEventId(),
      event_type: eventType,
      ...(handoffId ? { handoff_id: handoffId } : {}),
      ...(opts.operationKey ? { operation_key: opts.operationKey } : {}),
      ...(opts.fromVersion !== undefined ? { from_version: opts.fromVersion } : {}),
      ...(opts.toVersion !== undefined ? { to_version: opts.toVersion } : {}),
      ...(opts.details ? { details: opts.details } : {}),
      created_at: opts.now ?? Date.now(),
    };
    appendJsonl(this.historyPath(selfAid), event);
    return event;
  }

  private write(selfAid: string, instance: HandoffInstance): void {
    const filePath = this.instancePath(selfAid, instance.handoff_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const pendingPath = `${filePath}__`;
    const backupPath = `${filePath}_`;
    const fd = fs.openSync(pendingPath, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(instance, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(backupPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fs.renameSync(filePath, backupPath);
    }
    fs.renameSync(pendingPath, filePath);
  }

  create(input: CreateHandoffInput): HandoffInstance {
    const now = input.now ?? Date.now();
    const handoffId = newHandoffId();
    const instance: HandoffInstance = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      handoff_id: handoffId,
      origin_session_id: input.originSessionId,
      origin_message_id: input.originMessageId,
      target_session_id: input.targetSessionId,
      request: { payload: clonePayload(input.payload), encrypt: input.encrypt },
      return_policy: 'required',
      state: 'queued',
      target_message_id: null,
      response_message_id: null,
      consumed_at: null,
      consumed_target_session_id: null,
      return_content: null,
      return_content_hash: null,
      origin_delivery_message_id: null,
      attention_required: false,
      attention_reason: null,
      version: 1,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    this.appendEvent(input.selfAid, 'created', handoffId, { toVersion: 1, now });
    this.write(input.selfAid, instance);
    return instance;
  }

  get(selfAid: string, handoffId: string): HandoffInstance | null {
    if (!HANDOFF_ID_RE.test(handoffId)) return null;
    const parsed = atomicReadJson<HandoffInstance>(this.instancePath(selfAid, handoffId));
    if (!parsed) return null;
    if (parsed.schema_version !== HANDOFF_SCHEMA_VERSION || parsed.handoff_id !== handoffId) {
      throw new Error('invalid handoff snapshot');
    }
    return parsed;
  }

  list(selfAid: string): HandoffInstance[] {
    const dir = this.handoffsDir(selfAid);
    if (!fs.existsSync(dir)) return [];
    const result: HandoffInstance[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !HANDOFF_ID_RE.test(entry.name)) continue;
      const instance = this.get(selfAid, entry.name);
      if (instance) result.push(instance);
    }
    return result.sort((left, right) => left.created_at - right.created_at || left.handoff_id.localeCompare(right.handoff_id));
  }

  listByTarget(selfAid: string, targetSessionId: string, state?: HandoffState): HandoffInstance[] {
    return this.list(selfAid).filter(item => item.target_session_id === targetSessionId && (!state || item.state === state));
  }

  listByOrigin(selfAid: string, originSessionId: string, state?: HandoffState): HandoffInstance[] {
    return this.list(selfAid).filter(item => item.origin_session_id === originSessionId && (!state || item.state === state));
  }

  query(selfAid: string, input: ListHandoffsInput = {}): HandoffInstance[] {
    return this.list(selfAid)
      .filter(item => !input.state || item.state === input.state)
      .filter(item => !input.sessionId
        || item.origin_session_id === input.sessionId
        || item.target_session_id === input.sessionId)
      .sort((left, right) => right.updated_at - left.updated_at || left.handoff_id.localeCompare(right.handoff_id))
      .slice(0, boundedQueryLimit(input.limit));
  }

  events(selfAid: string): HandoffEvent[] {
    return readAllJsonlLines<HandoffEvent>(this.historyPath(selfAid));
  }

  trace(selfAid: string, handoffId: string, limit?: number): HandoffEvent[] | null {
    if (!this.get(selfAid, handoffId)) return null;
    const events = this.events(selfAid).filter(event => event.handoff_id === handoffId);
    return events.slice(-boundedQueryLimit(limit));
  }

  recordSendStarted(selfAid: string, handoffId: string, now = Date.now()): HandoffInstance {
    const instance = this.requireState(selfAid, handoffId, 'queued');
    this.appendEvent(selfAid, 'target_send_started', handoffId, {
      operationKey: `target-send:${handoffId}`,
      fromVersion: instance.version,
      toVersion: instance.version,
      now,
    });
    return instance;
  }

  recordSendSucceeded(selfAid: string, handoffId: string, targetMessageId: string, now = Date.now()): HandoffInstance {
    const instance = this.requireState(selfAid, handoffId, 'queued');
    const previous = instance.version;
    instance.state = 'target_sent';
    instance.target_message_id = targetMessageId;
    instance.version++;
    instance.updated_at = now;
    this.appendEvent(selfAid, 'target_send_succeeded', handoffId, {
      operationKey: `target-send:${handoffId}`,
      fromVersion: previous,
      toVersion: instance.version,
      details: { target_message_id: targetMessageId },
      now,
    });
    this.write(selfAid, instance);
    return instance;
  }

  recordSendFailed(selfAid: string, handoffId: string, error: string, now = Date.now()): HandoffInstance {
    const instance = this.requireState(selfAid, handoffId, 'queued');
    this.appendEvent(selfAid, 'target_send_failed', handoffId, {
      operationKey: `target-send:${handoffId}`,
      fromVersion: instance.version,
      toVersion: instance.version,
      details: { error },
      now,
    });
    return instance;
  }

  bindExactReply(input: BindReplyInput): HandoffInstance | null {
    const open = this.listByTarget(input.selfAid, input.targetSessionId, 'target_sent');
    let selected: HandoffInstance | undefined;
    if (input.refMessageId) {
      selected = open.find(item => item.target_message_id === input.refMessageId);
    } else if (open.length === 1) {
      selected = open[0];
    }
    const now = input.now ?? Date.now();
    const previousVersion = selected?.version;
    this.appendEvent(input.selfAid, 'reply_bound', selected?.handoff_id, {
      operationKey: `reply-enqueue:${input.responseMessageId}:${input.targetSessionId}`,
      ...(previousVersion !== undefined ? {
        fromVersion: previousVersion,
        toVersion: previousVersion + 1,
      } : {}),
      details: {
        response_message_id: input.responseMessageId,
        target_session_id: input.targetSessionId,
        consumed_handoff_ids: selected ? [selected.handoff_id] : [],
      },
      now,
    });
    if (!selected) return null;
    const previous = selected.version;
    selected.state = 'return_pending';
    selected.response_message_id = input.responseMessageId;
    selected.consumed_at = now;
    selected.consumed_target_session_id = input.targetSessionId;
    selected.version++;
    selected.updated_at = now;
    this.write(input.selfAid, selected);
    return selected;
  }

  returnHandoff(input: ReturnHandoffInput): HandoffReturnResponse {
    const selected = this.selectReturnCandidate(input);
    if ('ok' in selected) return selected;
    const { instance, selectedBy } = selected;
    if (instance.target_session_id !== input.currentSessionId || instance.consumed_target_session_id !== input.currentSessionId) {
      return {
        ok: false,
        code: 'HANDOFF_TARGET_SESSION_MISMATCH',
        error: 'handoff cannot be returned from the current session',
        handoff_id: instance.handoff_id,
        state: instance.state,
      };
    }
    if (!instance.response_message_id || !instance.consumed_at) {
      return {
        ok: false,
        code: 'HANDOFF_CONSUMPTION_BINDING_INVALID',
        error: 'handoff consumption binding is missing or inconsistent',
        handoff_id: instance.handoff_id,
        state: instance.state,
      };
    }

    const normalized = normalizeReturnContent(input.content);
    const hash = contentHash(normalized);
    if (instance.state !== 'return_pending') {
      if (instance.return_content_hash) {
        if (instance.return_content_hash === hash) {
          return {
            ok: true,
            code: 'HANDOFF_RETURN_ALREADY_APPLIED',
            handoff_id: instance.handoff_id,
            selected_by: selectedBy,
            previous_state: instance.state,
            state: instance.state,
            idempotent: true,
          };
        }
        return {
          ok: false,
          code: 'HANDOFF_RETURN_CONFLICT',
          error: 'handoff was already returned with different content',
          handoff_id: instance.handoff_id,
          state: instance.state,
        };
      }
      return {
        ok: false,
        code: 'HANDOFF_NOT_RETURNABLE',
        error: 'handoff is not return_pending',
        handoff_id: instance.handoff_id,
        state: instance.state,
      };
    }
    if (!normalized.trim()) {
      return {
        ok: false,
        code: 'HANDOFF_RETURN_CONTENT_REQUIRED',
        error: 'return content is required',
        handoff_id: instance.handoff_id,
        state: instance.state,
      };
    }

    const now = input.now ?? Date.now();
    const previousState = instance.state;
    const previousVersion = instance.version;
    instance.state = 'origin_queued';
    instance.return_content = normalized;
    instance.return_content_hash = hash;
    instance.version++;
    instance.updated_at = now;
    try {
      this.appendEvent(input.selfAid, 'return_accepted', instance.handoff_id, {
        operationKey: `handoff-return:${instance.handoff_id}`,
        fromVersion: previousVersion,
        toVersion: instance.version,
        now,
      });
      this.write(input.selfAid, instance);
    } catch {
      return {
        ok: false,
        code: 'HANDOFF_STORE_WRITE_FAILED',
        error: 'failed to persist handoff return',
        handoff_id: instance.handoff_id,
        state: previousState,
        retryable: true,
      };
    }
    return {
      ok: true,
      code: 'HANDOFF_RETURN_ACCEPTED',
      handoff_id: instance.handoff_id,
      selected_by: selectedBy,
      previous_state: previousState,
      state: instance.state,
      idempotent: false,
    };
  }

  recordOriginEnqueued(selfAid: string, handoffId: string, messageId: string, now = Date.now()): HandoffInstance {
    const instance = this.requireState(selfAid, handoffId, 'origin_queued');
    const previous = instance.version;
    instance.state = 'origin_delivered';
    instance.origin_delivery_message_id = messageId;
    instance.version++;
    instance.updated_at = now;
    this.appendEvent(selfAid, 'origin_enqueue_succeeded', handoffId, {
      operationKey: messageId,
      fromVersion: previous,
      toVersion: instance.version,
      now,
    });
    this.write(selfAid, instance);
    return instance;
  }

  recordOriginEnqueueFailed(selfAid: string, handoffId: string, error: string, now = Date.now()): void {
    const instance = this.requireState(selfAid, handoffId, 'origin_queued');
    this.appendEvent(selfAid, 'origin_enqueue_failed', handoffId, {
      operationKey: `origin-deliver:${handoffId}:${instance.origin_session_id}`,
      details: { error },
      now,
    });
  }

  completeOriginContext(selfAid: string, handoffId: string, now = Date.now()): HandoffInstance {
    const instance = this.requireState(selfAid, handoffId, 'origin_delivered');
    const previous = instance.version;
    instance.state = 'completed';
    instance.version++;
    instance.updated_at = now;
    instance.completed_at = now;
    this.appendEvent(selfAid, 'origin_context_consumed', handoffId, {
      operationKey: instance.origin_delivery_message_id ?? undefined,
      fromVersion: previous,
      toVersion: instance.version,
      now,
    });
    this.write(selfAid, instance);
    return instance;
  }

  requireState(selfAid: string, handoffId: string, expected: HandoffState): HandoffInstance {
    const instance = this.get(selfAid, handoffId);
    if (!instance) throw new Error('handoff not found');
    if (instance.attention_required) throw new Error(`handoff requires attention: ${instance.attention_reason}`);
    if (instance.state !== expected) throw new Error(`handoff state ${instance.state}, expected ${expected}`);
    return instance;
  }

  markAttention(selfAid: string, handoffId: string, reason: HandoffAttentionReason, now = Date.now()): HandoffInstance {
    const instance = this.get(selfAid, handoffId);
    if (!instance) throw new Error('handoff not found');
    const previous = instance.version;
    instance.attention_required = true;
    instance.attention_reason = reason;
    instance.version++;
    instance.updated_at = now;
    this.appendEvent(selfAid, 'attention_required', handoffId, {
      fromVersion: previous,
      toVersion: instance.version,
      details: { reason },
      now,
    });
    this.write(selfAid, instance);
    return instance;
  }

  status(selfAid: string, handoffId: string): HandoffStatusResponse | null {
    const instance = this.get(selfAid, handoffId);
    if (!instance) return null;
    return {
      ok: true,
      handoff_id: instance.handoff_id,
      state: instance.state,
      origin_session_id: instance.origin_session_id,
      target_session_id: instance.target_session_id,
      return_policy: instance.return_policy,
      created_at: instance.created_at,
      updated_at: instance.updated_at,
      attention_required: instance.attention_required,
      attention_reason: instance.attention_reason,
    };
  }

  requestSummary(instance: HandoffInstance): string {
    return classifyAunPayloadForLog(instance.request.payload).content || '[payload]';
  }

  private selectReturnCandidate(input: ReturnHandoffInput):
    | { instance: HandoffInstance; selectedBy: 'explicit_id' | 'single_current_task_candidate' }
    | Extract<HandoffReturnResponse, { ok: false }> {
    if (input.handoffId) {
      if (!HANDOFF_ID_RE.test(input.handoffId)) {
        return { ok: false, code: 'INVALID_HANDOFF_ID', error: 'invalid handoff_id format', handoff_id: input.handoffId };
      }
      const instance = this.get(input.selfAid, input.handoffId);
      if (!instance) return { ok: false, code: 'HANDOFF_NOT_FOUND', error: 'handoff not found', handoff_id: input.handoffId };
      return { instance, selectedBy: 'explicit_id' };
    }

    const candidates = (input.currentTaskHandoffIds ?? [])
      .map(id => this.get(input.selfAid, id))
      .filter((item): item is HandoffInstance => !!item && item.state === 'return_pending');
    if (candidates.length === 0) {
      return { ok: false, code: 'HANDOFF_ID_REQUIRED', error: 'no current-task handoff candidate; specify handoff_id' };
    }
    if (candidates.length > 1) {
      const summaries: HandoffReturnCandidate[] = candidates.map(instance => ({
        handoff_id: instance.handoff_id,
        state: instance.state,
        request_summary: this.requestSummary(instance),
      }));
      return { ok: false, code: 'AMBIGUOUS_HANDOFF', error: 'current task has multiple return_pending handoffs; specify handoff_id', candidates: summaries };
    }
    return { instance: candidates[0], selectedBy: 'single_current_task_candidate' };
  }
}
