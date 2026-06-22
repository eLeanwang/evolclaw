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
  getChannel(agentAid: string, channelType: string, channelName?: string): TriggerChannelBinding | undefined;
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
    });
    const feedback = {
      branch: input.branch,
      mode: input.action.mode,
      target: input.action.target,
      renderedTextHash: sha256(renderedText),
      renderedTextPreview: previewText(renderedText),
    };

    if (input.action.mode === 'none') {
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
        dryRunText: input.action.mode === 'agent-runner' ? this.markTriggerMessage(input.trigger, renderedText) : renderedText,
      };
    }

    if (input.action.mode === 'direct-message') {
      return await this.dispatchDirectMessage(input, feedback, renderedText);
    }
    return await this.dispatchAgentRunner(input, feedback, renderedText);
  }

  private async dispatchDirectMessage(
    input: TriggerFeedbackDispatchInput,
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    text: string,
  ): Promise<TriggerFeedbackDispatchResult> {
    const target = input.action.target!;
    const binding = this.deps.getChannel(input.trigger.agentAid, target.channelType, target.channelName);
    if (!binding) return this.failed(feedback, [], 'channel_not_configured', `agent ${input.trigger.agentAid} has no channel ${target.channelType}`);

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
          channelType: target.channelType,
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
          channelType: target.channelType,
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

  private async dispatchAgentRunner(
    input: TriggerFeedbackDispatchInput,
    feedback: NonNullable<TriggerAuditRecord['feedback']>,
    text: string,
  ): Promise<TriggerFeedbackDispatchResult> {
    const target = input.action.target!;
    const binding = this.deps.getChannel(input.trigger.agentAid, target.channelType, target.channelName);
    if (!binding) return this.failed(feedback, [], 'channel_not_configured', `agent ${input.trigger.agentAid} has no channel ${target.channelType}`);

    const session = await this.resolveSession(target.channelName ?? binding.adapter.channelKey, target);
    if (!session) return this.failed(feedback, [], 'session_not_found', `session not found for ${target.channelType}:${target.channelId}`);

    const effects: TriggerEffectRecord[] = [];
    const deadline = Date.now() + FEEDBACK_DEADLINE_MS;
    while (this.deps.messageQueue.isProcessing(session.id) || this.deps.messageQueue.getQueueLength(session.id) > 0) {
      if (Date.now() >= deadline) {
        effects.push({
          type: 'agent-runner.enqueue',
          status: 'skipped',
          channelType: target.channelType,
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
      },
    };
    this.deps.messageQueue.enqueue(session.id, message, session.projectPath, {
      interruptible: false,
      agentName: binding.agentName,
      sessionKeyField: session.sessionKey,
    }).catch(() => {});
    effects.push({
      type: 'agent-runner.enqueue',
      status: 'success',
      channelType: target.channelType,
      channelId: target.channelId,
      sessionId: session.id,
      attempt: 1,
      startedAt,
      finishedAt: Date.now(),
    });
    return { status: 'completed', feedback, effects, error: null };
  }

  private async resolveSession(channelKey: string, target: TriggerFeedbackTarget): Promise<Session | undefined> {
    const strategy = target.sessionStrategy ?? 'latest';
    if (strategy === 'current') {
      if (!target.sessionId) return undefined;
      const session = await this.deps.sessionManager.getSessionById(target.sessionId);
      return session && session.channelId === target.channelId ? session : undefined;
    }
    if (strategy === 'thread') {
      if (!target.threadId) return undefined;
      return await this.deps.sessionManager.getThreadSession(channelKey, target.channelId, target.threadId);
    }
    const sessions = await this.deps.sessionManager.listSessions(channelKey, target.channelId);
    return sessions[0];
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
