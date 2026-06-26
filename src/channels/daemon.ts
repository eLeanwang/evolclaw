import type {
  ChannelAdapter,
  ChannelCapabilities,
  Message,
  OutboundEnvelope,
  OutboundPayload,
  Session,
} from '../types.js';
import type { MessageQueue } from '../core/message/message-queue.js';
import type { SessionManager } from '../core/session/session-manager.js';
import type { TriggerDefinition, TriggerReply } from '../trigger/types.js';

interface PendingConversation {
  resolve: (reply: TriggerReply) => void;
  acc: {
    text: string;
    files: { path: string; name?: string }[];
    error?: { reason?: string; text: string };
    toolCallCount: number;
  };
  startedAt: number;
  timer: NodeJS.Timeout;
}

export interface DaemonConversationContext {
  trigger: TriggerDefinition;
  runId: string;
  firedAt: number;
  projectPath: string;
  baseagent: string;
  session: Session;
  timeoutMs?: number;
}

export class DaemonChannel implements ChannelAdapter {
  readonly channelName = 'daemon';
  readonly channelKey = 'daemon';
  readonly capabilities: ChannelCapabilities = {
    file: true,
    image: false,
    interaction: false,
    markdown: true,
    thought: true,
    status: true,
    thread: true,
  };

  private pending = new Map<string, PendingConversation>();

  constructor(
    private sessionManager: SessionManager,
    private messageQueue: MessageQueue,
  ) {}

  async converse(prompt: string, ctx: DaemonConversationContext): Promise<TriggerReply> {
    const runId = ctx.runId;
    const startedAt = Date.now();
    const promise = new Promise<TriggerReply>((resolve) => {
      const timer = setTimeout(() => this.finish(runId, 'timeout'), ctx.timeoutMs ?? 120_000);
      timer.unref?.();
      this.pending.set(runId, {
        resolve,
        startedAt,
        timer,
        acc: { text: '', files: [], toolCallCount: 0 },
      });
    });

    const message: Message = {
      channel: this.channelName,
      channelType: this.channelName,
      channelId: ctx.session.channelId,
      selfAID: ctx.trigger.agentAid,
      baseagent: ctx.baseagent,
      threadId: ctx.session.threadId || '',
      chatType: 'private',
      peerId: `trigger:${ctx.trigger.id}`,
      peerName: ctx.trigger.name,
      peerType: 'system',
      content: prompt,
      messageId: runId,
      timestamp: Date.now(),
      source: 'trigger',
      triggerMeta: {
        triggerId: ctx.trigger.id,
        runId,
        triggerName: ctx.trigger.name,
        fireTime: ctx.firedAt,
        boundSessionId: ctx.session.id,
      },
    };

    try {
      await this.messageQueue.enqueue(ctx.session.id, message, ctx.projectPath, {
        interruptible: false,
        agentName: ctx.trigger.agentAid,
        sessionKeyField: ctx.session.sessionKey,
        selfAID: ctx.trigger.agentAid,
      });
    } catch (err: any) {
      this.fail(runId, 'enqueue_error', err?.message || String(err));
    }

    return promise;
  }

  async send(envelope: OutboundEnvelope, payload: OutboundPayload): Promise<void> {
    const runId = this.runIdFromEnvelope(envelope);
    if (!runId) return;
    const slot = this.pending.get(runId);
    if (!slot) return;

    switch (payload.kind) {
      case 'result.text':
        if (payload.isFinal) slot.acc.text = payload.text;
        else slot.acc.text += payload.text;
        break;
      case 'result.file':
        slot.acc.files.push({ path: payload.filePath, name: payload.fileName });
        break;
      case 'result.error':
        slot.acc.error = { reason: payload.reason, text: payload.text };
        break;
      case 'status.progress':
        if (payload.metadata?.activityType === 'tool_call') slot.acc.toolCallCount += 1;
        break;
      case 'status.completed':
        this.finish(runId, 'success', payload.metadata);
        break;
      case 'status.error':
        this.finish(runId, 'error', payload.metadata);
        break;
      case 'status.interrupted':
        this.finish(runId, 'interrupted', payload.metadata);
        break;
      case 'status.timeout':
        this.finish(runId, 'timeout', payload.metadata);
        break;
    }
  }

  async getOrCreateConversationSession(
    trigger: TriggerDefinition,
    projectPath: string,
    baseagent: string,
  ): Promise<Session> {
    const strategy = trigger.execution.session.strategy;
    if (strategy === 'main' && trigger.execution.session.sessionId) {
      const session = await this.sessionManager.getSessionById(trigger.execution.session.sessionId);
      if (session) return session;
    }
    if (strategy === 'main') {
      const channelKey = trigger.execution.session.channelKey;
      const channelId = trigger.execution.session.channelId;
      if (!channelKey || !channelId) throw new Error('main execution session requires channelKey and channelId');
      const channelType = channelTypeFromKey(channelKey);
      return await this.sessionManager.getOrCreateSession(
        channelKey,
        channelId,
        projectPath,
        undefined,
        { channelKey, peerId: `trigger:${trigger.id}`, peerName: trigger.name },
        trigger.execution.session.name || trigger.name,
        undefined,
        'private',
        baseagent,
        trigger.agentAid,
        channelType,
        'system',
      );
    }

    const channelId = trigger.execution.session.channelId || `trigger:${trigger.id}`;
    const threadId = strategy === 'isolated'
      ? `run:${Date.now()}`
      : (strategy === 'thread' ? (trigger.execution.session.threadId || `trigger:${trigger.id}`) : undefined);
    return await this.sessionManager.getOrCreateSession(
      this.channelName,
      channelId,
      projectPath,
      threadId,
      { channelKey: this.channelKey, peerId: `trigger:${trigger.id}`, peerName: trigger.name },
      trigger.execution.session.name || trigger.name,
      undefined,
      'private',
      baseagent,
      trigger.agentAid,
      this.channelName,
      'system',
    );
  }

  private runIdFromEnvelope(envelope: OutboundEnvelope): string | undefined {
    const metadata = envelope.replyContext?.metadata as Record<string, unknown> | undefined;
    const runId = metadata?.triggerRunId;
    return typeof runId === 'string' ? runId : undefined;
  }

  private finish(runId: string, status: TriggerReply['outcome'], metadata?: Record<string, unknown>): void {
    const slot = this.pending.get(runId);
    if (!slot) return;
    clearTimeout(slot.timer);
    this.pending.delete(runId);
    const durationMs = typeof metadata?.durationMs === 'number'
      ? metadata.durationMs
      : Math.max(0, Date.now() - slot.startedAt);
    const text = slot.acc.text;
    const outcome = status === 'success' && (slot.acc.error || !text.trim()) ? (slot.acc.error ? 'error' : 'noop') : status;
    slot.resolve({
      outcome,
      text,
      files: slot.acc.files,
      error: slot.acc.error,
      meta: {
        runId,
        durationMs,
        numTurns: typeof metadata?.numTurns === 'number' ? metadata.numTurns : undefined,
        tokenUsage: isObject(metadata?.tokenUsage) ? metadata.tokenUsage as any : undefined,
        contextUsage: metadata?.contextUsage,
        toolCallCount: slot.acc.toolCallCount,
      },
    });
  }

  private fail(runId: string, reason: string, text: string): void {
    const slot = this.pending.get(runId);
    if (!slot) return;
    slot.acc.error = { reason, text };
    this.finish(runId, 'error');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function channelTypeFromKey(channelKey: string): string {
  const idx = channelKey.indexOf('#');
  return idx > 0 ? channelKey.slice(0, idx) : channelKey;
}
