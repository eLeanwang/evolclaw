import type { ChannelAdapter, Message, Session } from '../types.js';
import type { MessageQueue } from '../core/message/message-queue.js';
import type { SessionManager } from '../core/session/session-manager.js';
import { renderTemplate, previewText, sha256 } from './validation.js';
import type {
  TriggerAuditRecord,
  TriggerDefinition,
  TriggerEffectRecord,
  TriggerFeedbackAction,
  TriggerFeedbackBranch,
  TriggerFeedbackTarget,
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
  getChannel(agentAid: string, channelKey: string, channelName?: string): TriggerChannelBinding | undefined;
  sessionManager: SessionManager;
  messageQueue: MessageQueue;
}

export interface TriggerFeedbackDispatchInput {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  branch: TriggerFeedbackBranch;
  action: TriggerFeedbackAction;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
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
    const renderedText = renderTemplate(input.action.template, {
      trigger: input.trigger,
      result: input.result,
      error: input.error,
      event: input.sourcePayload,
      source: input.sourcePayload ? { type: input.trigger.source.type, payload: input.sourcePayload } : undefined,
      timestamp: input.firedAt,
    });
    const feedback = {
      branch: input.branch,
      mode: input.action.mode,
      target: input.action.target,
      renderedTextHash: sha256(renderedText),
      renderedTextPreview: previewText(renderedText),
    };

    if (input.action.mode === 'none') {
      const shouldRunSilently = input.trigger.processing.mode === 'prompt'
        && input.trigger.session.strategy === 'thread';
      if (shouldRunSilently) {
        const action: TriggerFeedbackAction = {
          mode: 'agent-session',
          target: targetFromTriggerSession(input.trigger),
        };
        if (input.dryRun) {
          return {
            status: 'dry-run',
            feedback,
            effects: [],
            error: null,
            dryRunText: this.markTriggerMessage(input.trigger, renderedText),
          };
        }
        return await this.dispatchAgentSession(input, feedback, renderedText, action, { silent: true });
      }

      const noop = input.branch === 'onNoop';
      return {
        status: noop ? 'noop' : 'completed',
        reason: noop ? 'matched_false' : undefined,
        feedback,
        effects: [],
        error: null,
        dryRunText: renderedText,
      };
    }

    if (!input.action.target) {
      return this.failed(feedback, [], 'feedback_target_missing', 'feedback target is required');
    }

    if (input.dryRun) {
      return {
        status: 'dry-run',
        feedback,
        effects: [],
        error: null,
        dryRunText: input.action.mode === 'agent-session' ? this.markTriggerMessage(input.trigger, renderedText) : renderedText,
      };
    }

    if (input.action.mode === 'direct-message') {
      return await this.dispatchDirectMessage(input, feedback, renderedText);
    }
    return await this.dispatchAgentSession(input, feedback, renderedText, input.action);
  }

  private async dispatchDirectMessage(
    input: TriggerFeedbackDispatchInput,
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    text: string,
  ): Promise<TriggerFeedbackDispatchResult> {
    const target = input.action.target!;
    const channelKey = targetChannelKey(target);
    const binding = this.resolveBinding(input.trigger.agentAid, target);
    if (!binding) {
      return this.failed(feedback, [], 'channel_not_configured', `agent ${input.trigger.agentAid} has no channel ${channelKey}`);
    }

    const effects: TriggerEffectRecord[] = [];
    const deadline = Date.now() + FEEDBACK_DEADLINE_MS;
    let attempt = 0;
    let lastError = '';
    let lastCode = 'send_error';
    while (Date.now() < deadline) {
      attempt += 1;
      const startedAt = Date.now();
      try {
        await binding.adapter.send({
          taskId: `trigger:${input.runId}`,
          channel: binding.adapter.channelKey,
          channelId: target.channelId,
          agentName: binding.agentName,
          chatmode: 'interactive',
          timestamp: Date.now(),
        }, {
          kind: 'result.text',
          text,
          isFinal: true,
          format: 'plain',
        });
        effects.push({
          type: 'message.send',
          status: 'success',
          channelKey,
          channelType: target.channelType ?? channelTypeFromKey(channelKey),
          channelId: target.channelId,
          attempt,
          startedAt,
          finishedAt: Date.now(),
        });
        return { status: 'completed', feedback, effects, error: null };
      } catch (err: any) {
        const classified = this.classifySendError(err);
        lastError = classified.message;
        lastCode = classified.code;
        effects.push({
          type: 'message.send',
          status: 'failed',
          channelKey,
          channelType: target.channelType ?? channelTypeFromKey(channelKey),
          channelId: target.channelId,
          attempt,
          startedAt,
          finishedAt: Date.now(),
          error: lastError,
        });
        if (!classified.retryable) {
          return this.failed(feedback, effects, classified.code, classified.message);
        }
        if (Date.now() + 1_000 >= deadline) break;
        await sleep(1_000);
      }
    }
    return this.failed(feedback, effects, lastCode === 'send_permanent_error' ? 'send_error' : lastCode, lastError || 'direct-message deadline reached');
  }

  private async dispatchAgentSession(
    input: TriggerFeedbackDispatchInput,
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    text: string,
    action: TriggerFeedbackAction,
    opts: { silent?: boolean } = {},
  ): Promise<TriggerFeedbackDispatchResult> {
    const target = action.target!;
    const channelKey = targetChannelKey(target);
    const binding = this.resolveBinding(input.trigger.agentAid, target);
    if (!binding) {
      return this.failed(feedback, [], 'channel_not_configured', `agent ${input.trigger.agentAid} has no channel ${channelKey}`);
    }

    const session = await this.resolveSession(input.trigger, target, binding, input.runId);
    if (!session) {
      return this.failed(feedback, [], 'session_not_found', `session not found for ${channelKey}:${target.channelId}`);
    }

    const effects: TriggerEffectRecord[] = [];
    const isThread = !!session.threadId;
    const canWaitForIdle = !isThread;
    const deadline = Date.now() + FEEDBACK_DEADLINE_MS;
    while (canWaitForIdle && (this.deps.messageQueue.isProcessing(session.id) || this.deps.messageQueue.getQueueLength(session.id) > 0)) {
      if (Date.now() >= deadline) {
        effects.push({
          type: 'agent-session.enqueue',
          status: 'skipped',
          channelKey,
          channelType: target.channelType ?? channelTypeFromKey(channelKey),
          channelId: target.channelId,
          sessionId: session.id,
          attempt: 1,
          startedAt: deadline - FEEDBACK_DEADLINE_MS,
          finishedAt: Date.now(),
          error: 'queue_busy_timeout',
        });
        return {
          status: 'skipped',
          reason: 'queue_busy_timeout',
          feedback,
          effects,
          error: null,
        };
      }
      await sleep(250);
    }

    const startedAt = Date.now();
    const message: Message = {
      channel: binding.adapter.channelKey,
      channelType: target.channelType,
      channelId: target.channelId,
      selfAID: input.trigger.agentAid,
      baseagent: session.baseagent || binding.baseagent,
      threadId: session.threadId || '',
      chatType: session.chatType === 'group' ? 'group' : 'private',
      peerId: `trigger:${input.trigger.id}`,
      peerName: input.trigger.name,
      peerType: 'system',
      content: this.markTriggerMessage(input.trigger, text),
      messageId: input.runId,
      timestamp: Date.now(),
      source: 'trigger',
      triggerMeta: {
        triggerId: input.trigger.id,
        triggerName: input.trigger.name,
        fireTime: input.firedAt,
        boundSessionId: session.id,
        silent: opts.silent === true,
        chatModeOverride: opts.silent ? 'proactive' : undefined,
      },
    };
    this.deps.messageQueue.enqueue(session.id, message, session.projectPath, {
      interruptible: false,
      agentName: binding.agentName,
      sessionKeyField: session.sessionKey,
    }).catch(() => {});
    effects.push({
      type: 'agent-session.enqueue',
      status: 'success',
      channelKey,
      channelType: target.channelType ?? channelTypeFromKey(channelKey),
      channelId: target.channelId,
      sessionId: session.id,
      attempt: 1,
      startedAt,
      finishedAt: Date.now(),
    });
    return { status: 'completed', feedback, effects, error: null };
  }

  private async resolveSession(
    trigger: TriggerDefinition,
    target: TriggerFeedbackTarget,
    binding: TriggerChannelBinding,
    runId: string,
  ): Promise<Session | undefined> {
    const strategy = target.sessionStrategy ?? trigger.session.strategy;
    if (strategy === 'current') {
      if (!target.sessionId) return undefined;
      const session = await this.deps.sessionManager.getSessionById(target.sessionId);
      return session && session.channelId === target.channelId ? session : undefined;
    }

    const channelKey = targetChannelKey(target) || binding.adapter.channelKey;
    const channelType = target.channelType || channelTypeFromKey(channelKey);
    if (strategy === 'thread') {
      const threadMode = target.threadMode ?? trigger.session.thread?.mode ?? 'reuse';
      const threadId = threadMode === 'once'
        ? `trigger:${trigger.id}:${runId}`
        : (target.threadId ?? trigger.session.thread?.threadId ?? `trigger:${trigger.id}`);
      return await this.deps.sessionManager.getOrCreateSession(
        channelKey,
        target.channelId,
        binding.projectPath,
        threadId,
        { channelKey },
        trigger.session.thread?.name || trigger.name,
        undefined,
        undefined,
        binding.baseagent,
        trigger.agentAid,
        channelType,
        'system',
      );
    }

    const sessions = await this.deps.sessionManager.listSessions(channelKey, target.channelId);
    const latestMain = sessions
      .filter(session => !session.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latestMain) return latestMain;

    return await this.deps.sessionManager.getOrCreateSession(
      channelKey,
      target.channelId,
      binding.projectPath,
      undefined,
      { channelKey },
      undefined,
      undefined,
      undefined,
      binding.baseagent,
      trigger.agentAid,
      channelType,
      'system',
    );
  }

  private resolveBinding(agentAid: string, target: TriggerFeedbackTarget): TriggerChannelBinding | undefined {
    const channelKey = targetChannelKey(target);
    return this.deps.getChannel(agentAid, channelKey, channelKey);
  }

  private markTriggerMessage(trigger: TriggerDefinition, text: string): string {
    return `这是触发器结果，不是用户直接消息。\n触发器：${trigger.name}\n\n${text}`;
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
      'timeout',
      'timed out',
      'rate limit',
      'too many requests',
      'temporarily',
      'temporary',
      'network',
      'disconnect',
      'disconnected',
      'not connected',
      'econnreset',
      'econnrefused',
      'etimedout',
      'eai_again',
      'socket hang up',
      'gateway',
      'service unavailable',
    ];
    if (retryablePatterns.some(pattern => lower.includes(pattern))) {
      return { retryable: true, code: 'send_retryable_error', message };
    }

    const permanentPatterns = [
      'auth',
      'unauthorized',
      'forbidden',
      'permission',
      'invalid',
      'bad request',
      'not found',
      'unknown receiver',
      'user not found',
      'chat not found',
      'peer not found',
      'target not found',
      'not configured',
      'unsupported',
    ];
    if (permanentPatterns.some(pattern => lower.includes(pattern))) {
      return { retryable: false, code: 'send_permanent_error', message };
    }

    return { retryable: true, code: 'send_retryable_error', message };
  }
}

function targetFromTriggerSession(trigger: TriggerDefinition): TriggerFeedbackTarget {
  return {
    channelKey: trigger.session.channelKey,
    channelId: trigger.session.channelId,
    channelType: channelTypeFromKey(trigger.session.channelKey),
    channelName: trigger.session.channelKey,
    sessionStrategy: trigger.session.strategy,
    sessionId: trigger.session.sessionId,
    threadId: trigger.session.thread?.threadId,
    threadMode: trigger.session.thread?.mode,
  };
}

function channelTypeFromKey(channelKey: string): string {
  const idx = channelKey.indexOf('#');
  return idx > 0 ? channelKey.slice(0, idx) : channelKey;
}

function targetChannelKey(target: TriggerFeedbackTarget): string {
  return target.channelKey || target.channelName || target.channelType || '';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
