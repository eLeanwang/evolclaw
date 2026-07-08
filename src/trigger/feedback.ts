import type { ChannelAdapter, Message, ReplyContext, Session } from '../types.js';
import type { MessageQueue } from '../core/message/message-queue.js';
import type { SessionManager } from '../core/session/session-manager.js';
import { buildEnvelope } from '../core/message/message-utils.js';
import type { EventBus, GatewayEvent } from '../core/event-bus.js';
import { renderTemplate, previewText, sha256 } from './validation.js';
import type {
  TriggerAuditRecord,
  TriggerDefinition,
  TriggerEffectRecord,
  TriggerFeedbackBranch,
  TriggerFeedbackTarget,
  TriggerReply,
  TriggerRunStatus,
} from './types.js';

const FEEDBACK_DEADLINE_MS = 30_000;
const TARGET_SESSION_DEADLINE_MS = 30 * 60_000;

export interface TriggerChannelBinding {
  adapter: ChannelAdapter;
  agentAid: string;
  agentName: string;
  projectPath: string;
  baseagent?: string;
}

export interface TriggerFeedbackDependencies {
  getChannel(agentAid: string, channelKey: string): TriggerChannelBinding | undefined;
  sessionManager: SessionManager;
  messageQueue: MessageQueue;
  eventBus?: EventBus;
}

export interface TriggerFeedbackDispatchInput {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  branch?: TriggerFeedbackBranch;
  reply: TriggerReply;
  sourcePayload?: Record<string, unknown>;
  dryRun?: boolean;
}

export interface TriggerTargetSessionInput {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  prompt: string;
  dryRun?: boolean;
}

export interface TriggerFeedbackDispatchResult {
  status: TriggerRunStatus;
  reason?: string;
  feedback: NonNullable<TriggerAuditRecord['feedback']>;
  effects: TriggerEffectRecord[];
  error: TriggerAuditRecord['error'];
  dryRunText?: string;
}

interface TargetSessionResult {
  status: Extract<TriggerRunStatus, 'completed' | 'failed'>;
  reason?: string;
  feedback: NonNullable<TriggerAuditRecord['feedback']>;
  effects: TriggerEffectRecord[];
  error: TriggerAuditRecord['error'];
}

type TriggerOutcomeEvent =
  | Extract<GatewayEvent, { type: 'trigger:completed' }>
  | Extract<GatewayEvent, { type: 'trigger:failed' }>
  | Extract<GatewayEvent, { type: 'trigger:skipped' }>;

export class TriggerFeedbackDispatcher {
  constructor(private deps: TriggerFeedbackDependencies) {}

  async dispatch(input: TriggerFeedbackDispatchInput): Promise<TriggerFeedbackDispatchResult> {
    const feedback = this.auditFeedback(input.trigger, input.branch);
    const renderedText = this.renderFeedbackText(input);
    feedback.renderedTextHash = sha256(renderedText);
    feedback.renderedTextPreview = previewText(renderedText);

    if (input.trigger.feedback.strategy === 'silent' || !renderedText.trim()) {
      return {
        status: statusFromReply(input.reply),
        reason: reasonFromReply(input.reply),
        feedback,
        effects: [],
        error: errorFromReply(input.reply),
        dryRunText: renderedText,
      };
    }

    const target = this.resolveDeliveryTarget(input.trigger);
    if (!target) return this.failed(feedback, [], 'target_missing', 'trigger feedback target is missing');
    feedback.target = target;

    if (input.dryRun) {
      return { status: 'dry-run', feedback, effects: [], error: null, dryRunText: renderedText };
    }

    const result = await this.dispatchDirect(input, renderedText, target);
    if (result.error) return { status: 'failed', reason: result.error.code, feedback, effects: result.effects, error: result.error };
    return {
      status: statusFromReply(input.reply),
      reason: reasonFromReply(input.reply),
      feedback,
      effects: result.effects,
      error: errorFromReply(input.reply),
    };
  }

  async dispatchTargetSession(input: TriggerTargetSessionInput): Promise<TargetSessionResult> {
    const feedback = this.auditFeedback(input.trigger);
    const target = this.resolveDeliveryTarget(input.trigger);
    if (!target) return this.failed(feedback, [], 'target_missing', 'target_session feedback target is missing') as TargetSessionResult;
    feedback.target = target;
    feedback.renderedTextHash = sha256(input.prompt);
    feedback.renderedTextPreview = previewText(input.prompt);

    if (input.dryRun) {
      return { status: 'completed', feedback, effects: [], error: null };
    }

    const binding = this.deps.getChannel(input.trigger.agentAid, target.channelKey);
    if (!binding) {
      return this.failed(feedback, [], 'channel_not_configured', `agent ${input.trigger.agentAid} has no channel ${target.channelKey}`) as TargetSessionResult;
    }
    const startedAt = Date.now();
    const channelType = channelTypeFromKey(target.channelKey);
    let session: Session;
    try {
      session = await this.deps.sessionManager.getOrCreateSession(
        target.channelKey,
        target.channelId,
        binding.projectPath,
        target.session === 'thread' ? target.threadId : undefined,
        { channelKey: target.channelKey, peerId: `trigger:${input.trigger.id}`, peerName: input.trigger.name },
        input.trigger.name,
        undefined,
        'private',
        binding.baseagent,
        input.trigger.agentAid,
        channelType,
        'system',
      );
    } catch (err: any) {
      return this.failed(feedback, [], 'session_error', err?.message || String(err)) as TargetSessionResult;
    }

    const message: Message = {
      channel: target.channelKey,
      channelType,
      channelId: target.channelId,
      selfAID: input.trigger.agentAid,
      baseagent: session.baseagent || binding.baseagent,
      threadId: session.threadId || '',
      chatType: session.chatType === 'group' ? 'group' : 'private',
      peerId: `trigger:${input.trigger.id}`,
      peerName: input.trigger.name,
      peerType: 'system',
      content: input.prompt,
      messageId: input.runId,
      timestamp: Date.now(),
      source: 'trigger',
      triggerMeta: {
        triggerId: input.trigger.id,
        runId: input.runId,
        triggerName: input.trigger.name,
        fireTime: input.firedAt,
        boundSessionId: session.id,
        modelOverride: input.trigger.execution.model,
        effortOverride: input.trigger.execution.effort,
        permissionModeOverride: input.trigger.execution.permissionMode,
      },
    };

    const outcome = this.waitForTriggerOutcome(input.runId);
    try {
      await this.deps.messageQueue.enqueue(session.id, message, session.projectPath, {
        interruptible: false,
        agentName: binding.agentName,
        sessionKeyField: session.sessionKey,
        selfAID: input.trigger.agentAid,
      });
      const event = outcome ? await outcome : undefined;
      if (event?.type === 'trigger:failed') {
        return {
          status: 'failed',
          reason: event.phase,
          feedback,
          effects: [this.inboundEffect('success', target, session.id, startedAt)],
          error: { code: event.phase || 'target_session_failed', message: event.error },
        };
      }
      if (event?.type === 'trigger:skipped') {
        return {
          status: 'failed',
          reason: event.reason,
          feedback,
          effects: [this.inboundEffect('success', target, session.id, startedAt)],
          error: { code: event.reason || 'target_session_skipped', message: event.reason || 'target session skipped' },
        };
      }
      return {
        status: 'completed',
        feedback,
        effects: [this.inboundEffect('success', target, session.id, startedAt, event?.messageId)],
        error: null,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        reason: 'enqueue_error',
        feedback,
        effects: [this.inboundEffect('failed', target, session.id, startedAt, undefined, err?.message || String(err))],
        error: { code: 'enqueue_error', message: err?.message || String(err) },
      };
    }
  }

  private renderFeedbackText(input: TriggerFeedbackDispatchInput): string {
    const template = input.branch && input.trigger.execution.type === 'script'
      ? branchTemplate(input.trigger, input.branch)
      : defaultResultTemplate(input.reply);
    return renderTemplate(template, {
      trigger: input.trigger,
      reply: replyTemplateObject(input.reply),
      error: input.reply.error ? { code: input.reply.error.reason, message: input.reply.error.text } : undefined,
      event: input.sourcePayload,
      source: input.sourcePayload ? { type: input.trigger.source.type, payload: input.sourcePayload } : undefined,
      timestamp: input.firedAt,
    });
  }

  private auditFeedback(trigger: TriggerDefinition, branch?: TriggerFeedbackBranch): NonNullable<TriggerAuditRecord['feedback']> {
    return {
      branch,
      strategy: trigger.feedback.strategy,
      target: trigger.feedback.strategy === 'target' ? trigger.feedback.target : trigger.origin ? originAsTarget(trigger.origin) : undefined,
    };
  }

  private resolveDeliveryTarget(trigger: TriggerDefinition): TriggerFeedbackTarget | undefined {
    if (trigger.feedback.strategy === 'silent') return undefined;
    if (trigger.feedback.strategy === 'target') return trigger.feedback.target;
    return trigger.origin ? originAsTarget(trigger.origin) : undefined;
  }

  private async dispatchDirect(
    input: TriggerFeedbackDispatchInput,
    text: string,
    target: TriggerFeedbackTarget,
  ): Promise<{ effects: TriggerEffectRecord[]; error: TriggerAuditRecord['error'] }> {
    const binding = this.deps.getChannel(input.trigger.agentAid, target.channelKey);
    if (!binding) return { effects: [], error: { code: 'channel_not_configured', message: `agent ${input.trigger.agentAid} has no channel ${target.channelKey}` } };

    const effects: TriggerEffectRecord[] = [];
    const deadline = Date.now() + FEEDBACK_DEADLINE_MS;
    let attempt = 0;
    let lastError = '';
    let lastCode = 'send_error';
    while (Date.now() < deadline) {
      attempt += 1;
      const startedAt = Date.now();
      try {
        await binding.adapter.send(buildEnvelope({
          taskId: `trigger:${input.runId}`,
          channel: binding.adapter.channelKey,
          channelId: target.channelId,
          agentName: binding.agentName,
          replyContext: replyContextFromTarget(target),
        }), {
          kind: 'result.text',
          text,
          isFinal: true,
          format: 'plain',
        });
        effects.push({
          type: 'message.send',
          status: 'success',
          channelKey: target.channelKey,
          channelType: channelTypeFromKey(target.channelKey),
          channelId: target.channelId,
          attempt,
          startedAt,
          finishedAt: Date.now(),
        });
        return { effects, error: null };
      } catch (err: any) {
        const classified = this.classifySendError(err);
        lastError = classified.message;
        lastCode = classified.code;
        effects.push({
          type: 'message.send',
          status: 'failed',
          channelKey: target.channelKey,
          channelType: channelTypeFromKey(target.channelKey),
          channelId: target.channelId,
          attempt,
          startedAt,
          finishedAt: Date.now(),
          error: lastError,
        });
        if (!classified.retryable) return { effects, error: { code: classified.code, message: classified.message } };
        if (Date.now() + 1_000 >= deadline) break;
        await sleep(1_000);
      }
    }
    return { effects, error: { code: lastCode, message: lastError || 'direct feedback deadline reached' } };
  }

  private inboundEffect(
    status: TriggerEffectRecord['status'],
    target: TriggerFeedbackTarget,
    sessionId: string,
    startedAt: number,
    messageId?: string,
    error?: string,
  ): TriggerEffectRecord {
    return {
      type: 'message.inbound',
      status,
      channelKey: target.channelKey,
      channelType: channelTypeFromKey(target.channelKey),
      channelId: target.channelId,
      sessionId,
      messageId,
      attempt: 1,
      startedAt,
      finishedAt: Date.now(),
      error,
    };
  }

  private waitForTriggerOutcome(runId: string): Promise<TriggerOutcomeEvent> | undefined {
    if (!this.deps.eventBus) return undefined;
    return new Promise(resolve => {
      const finish = (event: TriggerOutcomeEvent) => {
        clearTimeout(timer);
        this.deps.eventBus?.unsubscribe('trigger:completed', onEvent);
        this.deps.eventBus?.unsubscribe('trigger:failed', onEvent);
        this.deps.eventBus?.unsubscribe('trigger:skipped', onEvent);
        resolve(event);
      };
      const onEvent = (event: GatewayEvent) => {
        if (
          (event.type === 'trigger:completed' || event.type === 'trigger:failed' || event.type === 'trigger:skipped')
          && event.runId === runId
        ) {
          finish(event as TriggerOutcomeEvent);
        }
      };
      const timer = setTimeout(() => {
        finish({
          type: 'trigger:failed',
          triggerId: '',
          name: '',
          runId,
          originTriggerId: '',
          messageId: runId,
          error: `target session timed out after ${TARGET_SESSION_DEADLINE_MS}ms`,
          targetChannel: '',
          targetChannelId: '',
          fireTime: Date.now(),
          phase: 'execute',
        });
      }, TARGET_SESSION_DEADLINE_MS);
      timer.unref?.();
      this.deps.eventBus?.subscribe('trigger:completed', onEvent);
      this.deps.eventBus?.subscribe('trigger:failed', onEvent);
      this.deps.eventBus?.subscribe('trigger:skipped', onEvent);
    });
  }

  private failed(
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    effects: TriggerEffectRecord[],
    code: string,
    message: string,
  ): TriggerFeedbackDispatchResult {
    return {
      status: 'failed',
      reason: code,
      feedback,
      effects,
      error: { code, message },
    };
  }

  private classifySendError(err: any): { retryable: boolean; code: string; message: string } {
    const message = err?.message || String(err);
    const status = Number(err?.status ?? err?.statusCode ?? err?.code);
    const rawCode = String(err?.code ?? err?.errorCode ?? '').toLowerCase();
    const lower = `${message} ${rawCode}`.toLowerCase();

    if (status === 408 || status === 429 || status >= 500) {
      return { retryable: true, code: 'send_retryable_error', message };
    }
    if (status >= 400 && status < 500) {
      return { retryable: false, code: 'send_permanent_error', message };
    }

    const retryablePatterns = [
      'timeout', 'timed out', 'rate limit', 'too many requests', 'temporarily',
      'temporary', 'network', 'disconnect', 'disconnected', 'not connected',
      'econnreset', 'econnrefused', 'etimedout', 'eai_again', 'socket hang up',
      'gateway', 'service unavailable',
    ];
    if (retryablePatterns.some(pattern => lower.includes(pattern))) {
      return { retryable: true, code: 'send_retryable_error', message };
    }

    const permanentPatterns = [
      'auth', 'unauthorized', 'forbidden', 'permission', 'invalid', 'bad request',
      'not found', 'unknown receiver', 'user not found', 'chat not found',
      'peer not found', 'target not found', 'not configured', 'unsupported',
    ];
    if (permanentPatterns.some(pattern => lower.includes(pattern))) {
      return { retryable: false, code: 'send_permanent_error', message };
    }

    return { retryable: true, code: 'send_retryable_error', message };
  }
}

function replyTemplateObject(reply: TriggerReply): Record<string, unknown> {
  return {
    outcome: reply.outcome,
    text: reply.text,
    files: reply.files,
    meta: reply.meta,
    error: reply.error,
  };
}

function branchTemplate(trigger: TriggerDefinition, branch: TriggerFeedbackBranch): string | undefined {
  const value = trigger.feedback[branch]?.template;
  if (value !== undefined) return value;
  if (branch === 'onReply') return '{{reply.text}}';
  if (branch === 'onNoop') return '';
  return '触发器失败：{{error.message}}';
}

function defaultResultTemplate(reply: TriggerReply): string | undefined {
  if (reply.outcome === 'success') return '{{reply.text}}';
  if (reply.outcome === 'noop') return '';
  return '触发器失败：{{error.message}}';
}

function statusFromReply(reply: TriggerReply): TriggerRunStatus {
  if (reply.outcome === 'success') return 'completed';
  if (reply.outcome === 'noop') return 'noop';
  return 'failed';
}

function reasonFromReply(reply: TriggerReply): string | undefined {
  if (reply.outcome === 'noop') return 'noop';
  if (reply.outcome === 'timeout') return 'timeout';
  if (reply.outcome === 'interrupted') return 'interrupted';
  if (reply.outcome === 'error') return reply.error?.reason ?? 'reply_error';
  return undefined;
}

function errorFromReply(reply: TriggerReply): TriggerAuditRecord['error'] {
  if (reply.outcome !== 'error' && reply.outcome !== 'timeout' && reply.outcome !== 'interrupted') return null;
  return {
    code: reply.error?.reason ?? reply.outcome,
    message: reply.error?.text ?? reply.outcome,
  };
}

function originAsTarget(origin: NonNullable<TriggerDefinition['origin']>): TriggerFeedbackTarget {
  return {
    channelKey: origin.channelKey,
    channelId: origin.channelId,
    session: origin.session,
    threadId: origin.threadId,
  };
}

function replyContextFromTarget(target: TriggerFeedbackTarget): ReplyContext | undefined {
  if (target.session !== 'thread' || !target.threadId) return undefined;
  return { threadId: target.threadId };
}

function channelTypeFromKey(channelKey: string): string {
  const idx = channelKey.indexOf('#');
  return idx > 0 ? channelKey.slice(0, idx) : channelKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
