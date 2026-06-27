import type { ChannelAdapter, Message, Session } from '../types.js';
import type { MessageQueue } from '../core/message/message-queue.js';
import type { SessionManager } from '../core/session/session-manager.js';
import { buildEnvelope } from '../core/message/message-utils.js';
import { renderTemplate, previewText, sha256 } from './validation.js';
import type {
  FeedbackDisposition,
  FeedbackTarget,
  TriggerAuditRecord,
  TriggerDefinition,
  TriggerEffectRecord,
  TriggerFeedbackBranch,
  TriggerReply,
  TriggerRunStatus,
} from './types.js';

const FEEDBACK_DEADLINE_MS = 30_000;

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
}

export interface TriggerFeedbackDispatchInput {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  branch: TriggerFeedbackBranch;
  disposition: FeedbackDisposition;
  reply: TriggerReply;
  sourcePayload?: Record<string, unknown>;
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

export class TriggerFeedbackDispatcher {
  constructor(private deps: TriggerFeedbackDependencies) {}

  async dispatch(input: TriggerFeedbackDispatchInput): Promise<TriggerFeedbackDispatchResult> {
    const template = input.disposition.kind === 'silent' ? undefined : input.disposition.template;
    const renderedText = template ? renderTemplate(template, {
      trigger: input.trigger,
      reply: replyTemplateObject(input.reply),
      error: input.reply.error ? { code: input.reply.error.reason, message: input.reply.error.text } : undefined,
      event: input.sourcePayload,
      source: input.sourcePayload ? { type: input.trigger.source.type, payload: input.sourcePayload } : undefined,
      timestamp: input.firedAt,
    }) : '';
    const feedback: NonNullable<TriggerAuditRecord['feedback']> = {
      branch: input.branch,
      disposition: input.disposition.kind,
      target: dispositionTarget(input.disposition),
      renderedTextHash: sha256(renderedText),
      renderedTextPreview: previewText(renderedText),
    };

    if (input.disposition.kind === 'silent') {
      return {
        status: statusFromReply(input.reply, input.branch),
        reason: reasonFromReply(input.reply, input.branch),
        feedback,
        effects: [],
        error: errorFromReply(input.reply),
        dryRunText: renderedText,
      };
    }

    if (input.dryRun) {
      return {
        status: 'dry-run',
        feedback,
        effects: [],
        error: null,
        dryRunText: renderedText,
      };
    }

    if (input.disposition.kind === 'reply-origin') {
      const target = this.originTarget(input.trigger);
      if (!target) return this.failed(feedback, [], 'origin_missing', 'trigger.origin does not contain a reply target');
      return await this.dispatchForwardTargets(input, feedback, renderedText, [target]);
    }

    return await this.dispatchForwardTargets(input, feedback, renderedText, input.disposition.targets);
  }

  private async dispatchForwardTargets(
    input: TriggerFeedbackDispatchInput,
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    text: string,
    targets: FeedbackTarget[],
  ): Promise<TriggerFeedbackDispatchResult> {
    const effects: TriggerEffectRecord[] = [];
    for (const target of targets) {
      const result = target.delivery === 'inbound'
        ? await this.dispatchInbound(input, text, target)
        : await this.dispatchDirect(input, text, target);
      effects.push(...result.effects);
      if (result.error) return { status: 'failed', reason: result.error.code, feedback, effects, error: result.error };
    }
    return {
      status: statusFromReply(input.reply, input.branch),
      reason: reasonFromReply(input.reply, input.branch),
      feedback,
      effects,
      error: errorFromReply(input.reply),
    };
  }

  private async dispatchDirect(
    input: TriggerFeedbackDispatchInput,
    text: string,
    target: FeedbackTarget,
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

  private async dispatchInbound(
    input: TriggerFeedbackDispatchInput,
    text: string,
    target: FeedbackTarget,
  ): Promise<{ effects: TriggerEffectRecord[]; error: TriggerAuditRecord['error'] }> {
    const binding = this.deps.getChannel(input.trigger.agentAid, target.channelKey);
    if (!binding) return { effects: [], error: { code: 'channel_not_configured', message: `agent ${input.trigger.agentAid} has no channel ${target.channelKey}` } };
    const startedAt = Date.now();
    const channelType = channelTypeFromKey(target.channelKey);
    let session: Session;
    try {
      session = await this.deps.sessionManager.getOrCreateSession(
        target.channelKey,
        target.channelId,
        binding.projectPath,
        target.threadId,
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
      return { effects: [], error: { code: 'session_error', message: err?.message || String(err) } };
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
      content: text,
      messageId: input.runId,
      timestamp: Date.now(),
      source: 'trigger',
      triggerMeta: {
        triggerId: input.trigger.id,
        runId: input.runId,
        triggerName: input.trigger.name,
        fireTime: input.firedAt,
        boundSessionId: session.id,
      },
    };
    try {
      await this.deps.messageQueue.enqueue(session.id, message, session.projectPath, {
        interruptible: false,
        agentName: binding.agentName,
        sessionKeyField: session.sessionKey,
        selfAID: input.trigger.agentAid,
      });
      return {
        effects: [{
          type: 'message.inbound',
          status: 'success',
          channelKey: target.channelKey,
          channelType,
          channelId: target.channelId,
          sessionId: session.id,
          attempt: 1,
          startedAt,
          finishedAt: Date.now(),
        }],
        error: null,
      };
    } catch (err: any) {
      return {
        effects: [{
          type: 'message.inbound',
          status: 'failed',
          channelKey: target.channelKey,
          channelType,
          channelId: target.channelId,
          sessionId: session.id,
          attempt: 1,
          startedAt,
          finishedAt: Date.now(),
          error: err?.message || String(err),
        }],
        error: { code: 'enqueue_error', message: err?.message || String(err) },
      };
    }
  }

  private originTarget(trigger: TriggerDefinition): FeedbackTarget | undefined {
    const channelKey = trigger.origin?.channel || trigger.execution.session.channelKey;
    const channelId = trigger.origin?.peerId || trigger.execution.session.channelId;
    if (!channelKey || !channelId) return undefined;
    return { channelKey, channelId, delivery: 'direct' };
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

function dispositionTarget(disposition: FeedbackDisposition): FeedbackTarget | FeedbackTarget[] | undefined {
  if (disposition.kind === 'forward') return disposition.targets;
  return undefined;
}

function statusFromReply(reply: TriggerReply, branch: TriggerFeedbackBranch): TriggerRunStatus {
  if (reply.outcome === 'success') return 'completed';
  if (reply.outcome === 'noop') return 'noop';
  if (reply.outcome === 'timeout' || reply.outcome === 'interrupted' || reply.outcome === 'error') return 'failed';
  return branch === 'onNoop' ? 'noop' : 'completed';
}

function reasonFromReply(reply: TriggerReply, branch: TriggerFeedbackBranch): string | undefined {
  if (reply.outcome === 'noop' || branch === 'onNoop') return 'noop';
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

function channelTypeFromKey(channelKey: string): string {
  const idx = channelKey.indexOf('#');
  return idx > 0 ? channelKey.slice(0, idx) : channelKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
