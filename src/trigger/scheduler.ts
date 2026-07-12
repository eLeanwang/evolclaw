import crypto from 'crypto';
import fs from 'fs';
import { CronExpressionParser } from 'cron-parser';
import { logger } from '../utils/logger.js';
import type { EventBus } from '../core/event-bus.js';
import type { TriggerDefinitionManager } from './manager.js';
import type { TriggerRunStateStore } from './state.js';
import type { TriggerAuditLogger, TriggerRunStats } from './audit.js';
import type { TriggerHistoryEvent } from './history.js';
import type { TriggerScriptExecutor } from './script-executor.js';
import type { TriggerFeedbackDispatcher, TriggerFeedbackDispatchResult } from './feedback.js';
import type { DaemonChannel } from '../channels/daemon.js';
import { TriggerEventSource } from './sources/event-source.js';
import {
  definitionRevision,
  parseDurationMs,
  previewText,
  renderTemplate,
  resolveScriptPath,
  sha256,
} from './validation.js';
import type {
  TriggerActiveRun,
  TriggerAuditRecord,
  TriggerCreateFile,
  TriggerDefinition,
  TriggerFeedbackBranch,
  TriggerLimitState,
  TriggerProcessingAudit,
  TriggerReply,
  TriggerRunPayload,
  TriggerRuntimeResult,
  TriggerScheduleState,
  TriggerScriptPreview,
  TriggerScriptResult,
  TriggerSource,
  TriggerSourceEvent,
  TriggerSourceRunInfo,
  TriggerSubscriptionInfo,
  TriggerFeedbackTarget,
} from './types.js';

const MAX_TIMER_MS = 2_147_483_647;
const SCRIPT_PREVIEW_MAX_BYTES = 64 * 1024;

interface RunningRun {
  run: TriggerActiveRun;
  controller: AbortController;
}

interface TriggerRuntimeConfig {
  projectPath: string;
  baseagent: string;
  getBaseagent?: () => string;
}

interface ExecutionRunResult {
  branch?: TriggerFeedbackBranch;
  script: TriggerScriptResult | null;
  processing: TriggerProcessingAudit;
  reply: TriggerReply | null;
  feedbackResult?: TriggerFeedbackDispatchResult;
}

type TriggerLimitDisabledReason = NonNullable<TriggerLimitState['disabledReason']>;

export class TriggerRuntimeScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Map<string, RunningRun>>();
  private eventSource?: TriggerEventSource;
  private initialized = false;

  constructor(
    private manager: TriggerDefinitionManager,
    private state: TriggerRunStateStore,
    private audit: TriggerAuditLogger,
    private scriptExecutor: TriggerScriptExecutor,
    private feedback: TriggerFeedbackDispatcher,
    private daemonChannel: DaemonChannel,
    private runtime: TriggerRuntimeConfig,
    private eventBus?: EventBus,
  ) {
    if (eventBus) {
      this.eventSource = new TriggerEventSource(eventBus, (triggerId, event) => {
        void this.fireEventTrigger(triggerId, event);
      });
    }
  }

  async init(): Promise<void> {
    this.stop();
    this.recoverOpenRuns();
    for (const definition of this.manager.list()) {
      this.schedule(definition);
    }
    this.initialized = true;
    logger.info(`[Trigger] scheduler initialized for ${this.manager.agentAid}`);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.eventSource?.stop();
    for (const runs of this.running.values()) {
      for (const runtime of runs.values()) runtime.controller.abort();
    }
    this.running.clear();
    this.initialized = false;
  }

  list(opts: { all?: boolean } = {}): TriggerDefinition[] {
    return this.manager.list(opts);
  }

  show(triggerId: string): { definition: TriggerDefinition; active: TriggerActiveRun[]; schedule?: TriggerScheduleState; limitState?: TriggerLimitState; recentRuns: TriggerAuditRecord[]; scriptPreview?: TriggerScriptPreview; subscription: TriggerSubscriptionInfo } {
    const definition = this.manager.require(triggerId);
    return {
      definition,
      active: this.state.list(triggerId),
      schedule: this.state.readSchedule(triggerId),
      limitState: this.state.readLimitState(triggerId),
      recentRuns: this.audit.recent(triggerId, 10),
      scriptPreview: this.scriptPreview(definition),
      subscription: this.subscriptionInfo(definition),
    };
  }

  history(triggerId?: string, limit = 100): TriggerHistoryEvent[] {
    return this.manager.history.events(triggerId, limit);
  }

  private scriptPreview(definition: TriggerDefinition): TriggerScriptPreview | undefined {
    if (definition.execution.type !== 'script' || !definition.execution.script) return undefined;
    const script = definition.execution.script;
    const preview: TriggerScriptPreview = {
      path: script.path,
      runtime: script.runtime,
    };
    try {
      const abs = resolveScriptPath(this.manager.triggerDir(definition.id), script.path);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) {
        return { ...preview, error: 'script path is not a file' };
      }
      const fd = fs.openSync(abs, 'r');
      try {
        const size = stat.size;
        const limit = Math.min(size, SCRIPT_PREVIEW_MAX_BYTES + 1);
        const buffer = Buffer.alloc(limit);
        const bytesRead = fs.readSync(fd, buffer, 0, limit, 0);
        const slice = buffer.subarray(0, Math.min(bytesRead, SCRIPT_PREVIEW_MAX_BYTES));
        if (slice.includes(0)) {
          return { ...preview, sizeBytes: size, mtime: stat.mtimeMs, error: 'script file appears to be binary' };
        }
        return {
          ...preview,
          content: slice.toString('utf8'),
          sizeBytes: size,
          truncated: bytesRead > SCRIPT_PREVIEW_MAX_BYTES,
          mtime: stat.mtimeMs,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err: any) {
      return { ...preview, error: err?.message || String(err) };
    }
  }

  stats(triggerId: string): TriggerRunStats {
    const historyStats = this.audit.stats(triggerId);
    const merged = this.manager.history.hasLegacyArchive(triggerId)
      ? historyStats
      : mergeStats(this.manager.legacyStats(triggerId), historyStats);
    const schedule = this.state.readSchedule(triggerId);
    return accountScheduleMarker(merged, schedule, skipped => this.audit.hasSkippedSchedule(triggerId, skipped));
  }

  create(input: unknown, files: TriggerCreateFile[] = [], opts: { enable?: boolean } = {}): TriggerDefinition {
    const definition = this.manager.create(input, files, opts);
    this.state.clearSchedule(definition.id);
    if (!definition.limits) this.state.clearLimitState(definition.id);
    if (definition.enabled && this.initialized) this.schedule(definition);
    this.publishTriggerDefinitionEvent('trigger:registered', definition);
    return definition;
  }

  update(triggerId: string, input: unknown, files: TriggerCreateFile[] = []): TriggerDefinition {
    const previous = this.manager.get(triggerId);
    const definition = this.manager.update(triggerId, input, files);
    this.clearTimer(triggerId);
    this.unregisterEvent(triggerId);
    this.state.clearSchedule(triggerId);
    if (!definition.limits) {
      this.state.clearLimitState(triggerId);
    } else if (definition.enabled && limitsSignature(previous?.limits) !== limitsSignature(definition.limits)) {
      this.state.resetLimitState(triggerId);
    } else if (definition.enabled) {
      this.state.ensureLimitState(triggerId);
    }
    if (definition.enabled && this.initialized) this.schedule(definition);
    this.publishTriggerDefinitionEvent('trigger:updated', definition);
    return definition;
  }

  setEnabled(triggerId: string, enabled: boolean): TriggerDefinition {
    const definition = this.manager.setEnabled(triggerId, enabled);
    this.clearTimer(triggerId);
    this.unregisterEvent(triggerId);
    this.state.clearSchedule(triggerId);
    if (enabled && definition.limits) this.state.resetLimitState(triggerId);
    if (!definition.limits) this.state.clearLimitState(triggerId);
    if (definition.enabled && this.initialized) this.schedule(definition);
    return definition;
  }

  cancel(triggerId: string): TriggerDefinition {
    return this.setEnabled(triggerId, false);
  }

  delete(triggerId: string): TriggerDefinition {
    const definition = this.manager.require(triggerId);
    this.clearTimer(triggerId);
    this.unregisterEvent(triggerId);
    this.state.clearSchedule(triggerId);
    this.state.clearLimitState(triggerId);
    return this.manager.delete(triggerId);
  }

  async run(triggerId: string, opts: { dryRun?: boolean } = {}): Promise<TriggerRuntimeResult> {
    const definition = this.manager.require(triggerId);
    const firedAt = Date.now();
    if (!opts.dryRun) {
      const disabledReason = this.limitDisabledReason(definition, firedAt);
      if (disabledReason) {
        const audit = this.disableForLimit(definition, undefined, firedAt, disabledReason);
        return {
          ok: true,
          runId: audit.runId,
          triggerId: definition.id,
          status: 'skipped',
          reason: audit.reason,
          audit,
        };
      }
    }
    return await this.startRun(definition, {
      firedAt,
      payload: this.sourcePayload(definition.source),
      dryRun: opts.dryRun,
    });
  }

  private schedule(definition: TriggerDefinition): void {
    this.clearTimer(definition.id);
    this.unregisterEvent(definition.id);
    if (definition.limits) this.state.ensureLimitState(definition.id);
    else this.state.clearLimitState(definition.id);
    if (definition.source.type === 'event') {
      this.registerEvent(definition);
      return;
    }

    const scheduledAt = this.resolveScheduledAt(definition);
    if (scheduledAt === null) {
      if (this.isOneShot(definition.source) && definition.reliability.missedPolicy === 'skip') {
        this.writeSkippedAudit(definition, undefined, Date.now(), 'missed_skip');
        this.setEnabled(definition.id, false);
      }
      return;
    }

    const now = Date.now();
    if (this.isPeriodic(definition.source) && scheduledAt < now - 1000 && definition.reliability.missedPolicy === 'skip') {
      this.writeSkippedAudit(definition, scheduledAt, now, 'missed_skip');
      this.advancePeriodicSchedule(definition, scheduledAt, now);
      this.schedule(definition);
      return;
    }

    const rawDelay = Math.max(0, scheduledAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(definition.id);
      if (scheduledAt - Date.now() > 1000) {
        this.schedule(definition);
        return;
      }
      void this.handleScheduledFire(definition.id, scheduledAt);
    }, Math.min(MAX_TIMER_MS, rawDelay));
    timer.unref?.();
    this.timers.set(definition.id, timer);
  }

  private async handleScheduledFire(triggerId: string, scheduledAt: number): Promise<void> {
    const definition = this.manager.get(triggerId);
    if (!definition?.enabled) return;
    const firedAt = Date.now();

    if (this.isOneShot(definition.source) && scheduledAt < firedAt - 1000 && definition.reliability.missedPolicy === 'skip') {
      this.writeSkippedAudit(definition, scheduledAt, firedAt, 'missed_skip');
      this.setEnabled(definition.id, false);
      return;
    }

    if (this.isPeriodic(definition.source)) {
      if (scheduledAt < firedAt - 1000 && definition.reliability.missedPolicy === 'skip') {
        this.writeSkippedAudit(definition, scheduledAt, firedAt, 'missed_skip');
        this.advancePeriodicSchedule(definition, scheduledAt, firedAt);
        this.schedule(definition);
        return;
      }
      const disabledReason = this.limitDisabledReason(definition, firedAt);
      if (disabledReason) {
        this.disableForLimit(definition, scheduledAt, firedAt, disabledReason);
        return;
      }
    } else {
      const disabledReason = this.limitDisabledReason(definition, firedAt);
      if (disabledReason) {
        this.disableForLimit(definition, scheduledAt, firedAt, disabledReason);
        return;
      }
    }

    const runPromise = this.startRun(definition, {
      scheduledAt,
      firedAt,
      payload: this.sourcePayload(definition.source),
    });

    if (this.isPeriodic(definition.source)) {
      this.advancePeriodicSchedule(definition, scheduledAt, firedAt);
      this.schedule(definition);
      await runPromise;
      return;
    }

    await runPromise;
    const fresh = this.manager.get(triggerId);
    if (fresh?.enabled) this.setEnabled(triggerId, false);
  }

  private async startRun(definition: TriggerDefinition, payload: TriggerRunPayload): Promise<TriggerRuntimeResult> {
    const firedAt = payload.firedAt;
    const runId = `run_${firedAt}_${crypto.randomBytes(3).toString('hex')}`;
    const source = this.buildSourceInfo(definition.source, firedAt, payload.scheduledAt, payload.payload);

    if (!payload.dryRun) {
      const conflict = this.checkConcurrency(definition, runId, source);
      if (conflict) return conflict;
      if (definition.limits) this.state.incrementLimitRunCount(definition.id);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const activeRun: TriggerActiveRun = {
      phase: 'running',
      triggerId: definition.id,
      runId,
      startedAt,
      events: [{ seq: 0, event: 'run.started', ts: startedAt }],
    };

    if (!payload.dryRun) {
      this.addRunning(definition.id, runId, { run: activeRun, controller });
      this.state.upsert(definition.id, activeRun);
      this.publishTriggerFired(definition, runId, firedAt);
    }

    let script: TriggerScriptResult | null = null;
    let processing: TriggerProcessingAudit | null = null;
    let reply: TriggerReply | null = null;

    try {
      const execution = await this.runExecution(definition, runId, firedAt, source.payload, controller.signal, payload.dryRun === true);
      script = execution.script;
      processing = execution.processing;
      reply = execution.reply ?? null;

      if (!payload.dryRun && !this.isRunning(definition.id, runId)) {
        return {
          ok: false,
          runId,
          triggerId: definition.id,
          status: 'failed',
          reason: controller.signal.aborted ? 'replaced' : 'cancelled',
        };
      }

      if (!payload.dryRun) {
        const executionFailed = execution.reply
          ? shouldRetryExecution(execution.reply)
          : execution.feedbackResult?.status === 'failed';
        this.state.appendEvent(definition.id, runId, {
          event: executionFailed ? 'execution.failed' : 'execution.completed',
          ts: Date.now(),
          mode: definition.execution.type,
          outcome: execution.reply?.outcome ?? execution.feedbackResult?.status,
          ...(script ? { exitCode: script.exitCode } : {}),
        });
        if (!execution.feedbackResult) {
          this.state.setPhase(definition.id, runId, 'feedback-pending', {
            deadlineAt: Date.now() + 30_000,
          });
          this.state.appendEvent(definition.id, runId, {
            event: 'feedback.pending',
            ts: Date.now(),
            branch: execution.branch,
          });
        }
      }

      const feedbackResult = execution.feedbackResult ?? await this.feedback.dispatch({
        trigger: definition,
        runId,
        firedAt,
        branch: execution.branch,
        reply: execution.reply!,
        sourcePayload: source.payload,
        dryRun: payload.dryRun,
      });

      const audit = this.buildAudit({
        definition,
        runId,
        startedAt,
        status: payload.dryRun ? 'dry-run' : feedbackResult.status,
        reason: feedbackResult.reason,
        source,
        processing,
        script,
        reply,
        feedback: feedbackResult.feedback,
        effects: feedbackResult.effects,
        error: feedbackResult.error,
      });

      if (!payload.dryRun) {
        this.audit.write(audit);
        this.publishTriggerRunOutcome(definition, audit);
        this.finishRun(definition.id, runId);
      }

      return {
        ok: feedbackResult.status !== 'failed',
        runId,
        triggerId: definition.id,
        status: audit.status,
        reason: audit.reason,
        audit,
        error: audit.error?.message,
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      const audit = this.buildAudit({
        definition,
        runId,
        startedAt,
        status: 'failed',
        reason: 'daemon_error',
        source,
        processing,
        script,
        reply,
        feedback: null,
        effects: [],
        error: { code: 'daemon_error', message },
      });
      if (!payload.dryRun) {
        this.audit.write(audit);
        this.publishTriggerRunOutcome(definition, audit);
        this.finishRun(definition.id, runId);
      }
      return { ok: false, runId, triggerId: definition.id, status: 'failed', reason: 'daemon_error', audit, error: message };
    }
  }

  private async runExecution(
    definition: TriggerDefinition,
    runId: string,
    firedAt: number,
    sourcePayload: Record<string, unknown>,
    signal: AbortSignal,
    dryRun: boolean,
  ): Promise<ExecutionRunResult> {
    const maxAttempts = !dryRun && definition.execution.onError === 'retry'
      ? definition.reliability.retry.maxAttempts
      : 0;
    let execution = await this.runExecutionAttempt(definition, runId, firedAt, sourcePayload, signal, dryRun);
    for (let attempt = 0; execution.reply && shouldRetryExecution(execution.reply) && attempt < maxAttempts && !signal.aborted; attempt++) {
      await sleep(definition.reliability.retry.backoffMs);
      execution = await this.runExecutionAttempt(definition, runId, firedAt, sourcePayload, signal, dryRun);
    }
    return execution;
  }

  private async runExecutionAttempt(
    definition: TriggerDefinition,
    runId: string,
    firedAt: number,
    sourcePayload: Record<string, unknown>,
    signal: AbortSignal,
    dryRun: boolean,
  ): Promise<ExecutionRunResult> {
    if (definition.execution.type === 'script') {
      const script = await this.runScriptOnce(definition, runId, firedAt, sourcePayload, signal);
      if (script.error || script.exitCode !== 0) {
        const reply = errorReply(runId, script.durationMs, script.error?.code || 'script_error', script.error?.message || 'script failed');
        return {
          branch: 'onFailure',
          script,
          processing: { mode: 'script' },
          reply,
        };
      }
      const reply = replyFromScriptResult(script, runId);
      return {
        branch: branchFromReply(reply),
        script,
        processing: { mode: 'script' },
        reply,
      };
    }

    const prompt = renderTemplate(definition.execution.prompt ?? '', {
      trigger: definition,
      timestamp: firedAt,
      event: sourcePayload,
      source: { type: definition.source.type, payload: sourcePayload },
    });
    const processing = {
      mode: definition.execution.type,
      renderedTextHash: sha256(prompt),
      renderedTextPreview: previewText(prompt),
    };

    if (definition.execution.type === 'target_session') {
      const feedbackResult = await this.feedback.dispatchTargetSession({
        trigger: definition,
        runId,
        firedAt,
        prompt,
        dryRun,
      });
      return {
        script: null,
        processing,
        reply: null,
        feedbackResult,
      };
    }

    if (dryRun) {
      const reply: TriggerReply = {
        outcome: prompt.trim() ? 'success' : 'noop',
        text: prompt,
        files: [],
        meta: {
          runId,
          durationMs: 0,
          toolCallCount: 0,
        },
      };
      return { branch: branchFromReply(reply), script: null, processing, reply };
    }

    try {
      const runtimeBaseagent = this.runtime.getBaseagent?.() || this.runtime.baseagent;
      const executionSession = await this.daemonChannel.getOrCreateConversationSession(
        definition,
        this.runtime.projectPath,
        runtimeBaseagent,
        runId,
      );
      const daemonReply = await this.daemonChannel.converse(prompt, {
        trigger: definition,
        runId,
        firedAt,
        projectPath: this.runtime.projectPath,
        baseagent: runtimeBaseagent,
        session: executionSession,
      });
      const sentinel = definition.execution.noopSentinel ?? '[[NOOP]]';
      const reply: TriggerReply = {
        ...daemonReply,
        outcome: daemonReply.outcome === 'success' && daemonReply.text.trim() === sentinel ? 'noop' : daemonReply.outcome,
        text: daemonReply.text.trim() === sentinel ? '' : daemonReply.text,
      };
      return {
        branch: branchFromReply(reply),
        script: null,
        processing,
        reply,
      };
    } catch (err: any) {
      const reply = errorReply(runId, 0, 'agent_execution_error', err?.message || String(err));
      return {
        branch: 'onFailure',
        script: null,
        processing,
        reply,
      };
    }
  }

  private async runScriptOnce(
    definition: TriggerDefinition,
    runId: string,
    firedAt: number,
    sourcePayload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TriggerScriptResult> {
    return await this.scriptExecutor.execute({
      trigger: definition,
      triggerDir: this.manager.triggerDir(definition.id),
      runId,
      firedAt,
      sourcePayload,
      signal,
    });
  }

  private checkConcurrency(definition: TriggerDefinition, nextRunId: string, source: TriggerSourceRunInfo): TriggerRuntimeResult | undefined {
    const runs = this.running.get(definition.id);
    if (!runs || runs.size === 0 || definition.reliability.concurrency === 'allow') return undefined;
    const first = runs.values().next().value as RunningRun | undefined;
    const conflictRunId = first?.run.runId;

    if (definition.reliability.concurrency === 'forbid') {
      this.writeSkippedAudit(definition, source.scheduledAt, source.firedAt, 'concurrency_forbid', conflictRunId, nextRunId);
      return {
        ok: true,
        runId: nextRunId,
        triggerId: definition.id,
        status: 'skipped',
        reason: 'concurrency_forbid',
      };
    }

    for (const [runId, runtime] of runs.entries()) {
      runtime.controller.abort();
      const audit = this.buildAudit({
        definition,
        runId,
        startedAt: runtime.run.startedAt,
        status: 'failed',
        reason: 'replaced',
        source,
        script: null,
        reply: null,
        feedback: null,
        effects: [],
        error: { code: 'replaced', message: `run replaced by ${nextRunId}` },
      });
      this.audit.write(audit);
      this.publishTriggerRunOutcome(definition, audit);
      this.state.remove(definition.id, runId);
    }
    this.running.delete(definition.id);
    return undefined;
  }

  private recoverOpenRuns(): void {
    for (const definition of this.manager.list({ all: true })) {
      const activeRuns = this.state.list(definition.id);
      if (activeRuns.length === 0) continue;
      for (const run of activeRuns) {
        const status = run.phase === 'feedback-pending' ? 'skipped' : 'failed';
        const audit = this.buildAudit({
          definition,
          runId: run.runId,
          startedAt: run.startedAt,
          status,
          reason: 'daemon_restart',
          source: this.buildSourceInfo(definition.source, run.startedAt, run.startedAt, this.sourcePayload(definition.source)),
          script: null,
          reply: null,
          feedback: null,
          effects: [],
          error: status === 'failed' ? { code: 'daemon_restart', message: 'daemon restarted while run was open' } : null,
        });
        this.audit.write(audit);
      }
      this.state.clear(definition.id);
    }
  }

  private resolveScheduledAt(definition: TriggerDefinition): number | null {
    const now = Date.now();
    switch (definition.source.type) {
      case 'once':
        return now;
      case 'delay': {
        const at = definition.createdAt + definition.source.afterMs;
        return at <= now && definition.reliability.missedPolicy === 'skip' ? null : Math.max(at, now);
      }
      case 'at': {
        const at = new Date(definition.source.at).getTime();
        return at <= now && definition.reliability.missedPolicy === 'skip' ? null : Math.max(at, now);
      }
      case 'interval':
      case 'cron': {
        const signature = this.sourceSignature(definition.source);
        const state = this.state.readSchedule(definition.id);
        if (state?.sourceSignature === signature) {
          return this.ensureScheduleRunMarker(definition, state).nextFireAt;
        }
        const nextFireAt = this.nextPeriodicFireAt(definition.source, now);
        this.writeScheduleCursor(definition, nextFireAt, signature);
        return nextFireAt;
      }
      case 'event':
        return null;
    }
  }

  private advancePeriodicSchedule(definition: TriggerDefinition, scheduledAt: number, firedAt: number): void {
    if (!this.isPeriodic(definition.source)) return;
    const missed = scheduledAt < firedAt - 1000;
    const ref = missed ? firedAt : scheduledAt;
    let nextFireAt = this.nextPeriodicFireAt(definition.source, ref);
    const now = Date.now();
    if (nextFireAt <= now && missed) {
      nextFireAt = this.nextPeriodicFireAt(definition.source, now);
    }
    this.writeScheduleCursor(definition, nextFireAt, undefined, { lastScheduledAt: scheduledAt, lastFiredAt: firedAt });
  }

  private nextPeriodicFireAt(source: Extract<TriggerSource, { type: 'cron' | 'interval' }>, ref: number): number {
    if (source.type === 'interval') return ref + source.everyMs;
    return this.nextCronFireAt(source, ref);
  }

  private nextCronFireAt(source: Extract<TriggerSource, { type: 'cron' }>, ref: number): number {
    const interval = CronExpressionParser.parse(source.expression, {
      currentDate: new Date(ref),
      tz: source.timezone,
    });
    return interval.next().getTime();
  }

  private writeScheduleCursor(
    definition: TriggerDefinition,
    nextFireAt: number,
    signature = this.sourceSignature(definition.source),
    patch: Partial<Pick<TriggerScheduleState, 'lastScheduledAt' | 'lastFiredAt'>> = {},
  ): void {
    const previous = this.state.readSchedule(definition.id);
    this.state.writeSchedule(definition.id, {
      nextFireAt,
      updatedAt: Date.now(),
      sourceSignature: signature,
      ...(previous?.sourceSignature === signature && previous.lastScheduledAt !== undefined
        ? { lastScheduledAt: previous.lastScheduledAt }
        : {}),
      ...(previous?.sourceSignature === signature && previous.lastFiredAt !== undefined
        ? { lastFiredAt: previous.lastFiredAt }
        : {}),
      ...patch,
    });
  }

  private ensureScheduleRunMarker(definition: TriggerDefinition, schedule: TriggerScheduleState): TriggerScheduleState {
    if (schedule.lastScheduledAt !== undefined || !this.isPeriodic(definition.source)) return schedule;
    const inferred = this.previousPeriodicFireAt(definition.source, schedule.nextFireAt);
    if (inferred === undefined) return schedule;
    if (Math.abs(schedule.updatedAt - inferred) > 300_000) return schedule;
    const patched = {
      ...schedule,
      lastScheduledAt: inferred,
      lastFiredAt: schedule.updatedAt,
    };
    this.state.writeSchedule(definition.id, patched);
    return patched;
  }

  private previousPeriodicFireAt(source: Extract<TriggerSource, { type: 'cron' | 'interval' }>, ref: number): number | undefined {
    if (source.type === 'interval') return ref - source.everyMs;
    try {
      const interval = CronExpressionParser.parse(source.expression, {
        currentDate: new Date(ref),
        tz: source.timezone,
      });
      return interval.prev().getTime();
    } catch {
      return undefined;
    }
  }

  private sourceSignature(source: TriggerSource): string {
    return JSON.stringify(source);
  }

  private sourcePayload(source: TriggerSource): Record<string, unknown> {
    switch (source.type) {
      case 'once': return {};
      case 'delay': return { afterMs: source.afterMs };
      case 'at': return { at: source.at };
      case 'cron': return { expression: source.expression, timezone: source.timezone };
      case 'interval': return { everyMs: source.everyMs };
      case 'event': return { eventPattern: source.eventPattern };
    }
  }

  private buildSourceInfo(source: TriggerSource, firedAt: number, scheduledAt?: number, payload?: Record<string, unknown>): TriggerSourceRunInfo {
    return {
      type: source.type,
      eventName: source.type === 'event' ? (typeof payload?.type === 'string' ? payload.type : source.eventPattern) : undefined,
      scheduledAt,
      firedAt,
      payload: payload ?? this.sourcePayload(source),
    };
  }

  private buildAudit(input: {
    definition: TriggerDefinition;
    runId: string;
    startedAt: number;
    status: TriggerAuditRecord['status'];
    reason?: string;
    source: TriggerSourceRunInfo;
    processing?: TriggerProcessingAudit | null;
    script: TriggerScriptResult | null;
    reply?: TriggerReply | null;
    feedback: TriggerAuditRecord['feedback'];
    effects: TriggerAuditRecord['effects'];
    error: TriggerAuditRecord['error'];
    conflictRunId?: string;
  }): TriggerAuditRecord {
    return {
      runId: input.runId,
      triggerId: input.definition.id,
      agentAid: input.definition.agentAid,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
      status: input.status,
      reason: input.reason,
      conflictRunId: input.conflictRunId,
      definition: {
        schemaVersion: 4,
        revision: definitionRevision(input.definition),
        name: input.definition.name,
      },
      source: input.source,
      processing: input.processing ?? null,
      script: input.script,
      reply: summarizeReply(input.reply),
      feedback: input.feedback,
      effects: input.effects,
      error: input.error,
    };
  }

  private writeSkippedAudit(definition: TriggerDefinition, scheduledAt: number | undefined, firedAt: number, reason: string, conflictRunId?: string, runId = `run_${firedAt}_${crypto.randomBytes(3).toString('hex')}`): TriggerAuditRecord {
    const audit = this.buildAudit({
      definition,
      runId,
      startedAt: firedAt,
      status: 'skipped',
      reason,
      source: this.buildSourceInfo(definition.source, firedAt, scheduledAt, this.sourcePayload(definition.source)),
      script: null,
      reply: null,
      feedback: null,
      effects: [],
      error: null,
      conflictRunId,
    });
    this.audit.write(audit);
    this.publishTriggerRunOutcome(definition, audit);
    return audit;
  }

  private limitDisabledReason(definition: TriggerDefinition, firedAt: number): TriggerLimitDisabledReason | undefined {
    if (!definition.limits) return undefined;
    const limitState = this.state.ensureLimitState(definition.id);
    if (definition.limits.maxRuns !== undefined && limitState.runCount >= definition.limits.maxRuns) {
      return 'max_runs';
    }
    if (definition.limits.maxDuration !== undefined) {
      const durationMs = parseDurationMs(definition.limits.maxDuration);
      if (firedAt - limitState.startedAt >= durationMs) return 'max_duration';
    }
    return undefined;
  }

  private disableForLimit(
    definition: TriggerDefinition,
    scheduledAt: number | undefined,
    firedAt: number,
    reason: TriggerLimitDisabledReason,
  ): TriggerAuditRecord {
    this.state.markLimitDisabled(definition.id, reason);
    this.setEnabled(definition.id, false);
    return this.writeSkippedAudit(
      definition,
      scheduledAt,
      firedAt,
      reason === 'max_runs' ? 'max_runs_reached' : 'max_duration_reached',
    );
  }

  private isOneShot(source: TriggerSource): boolean {
    return source.type === 'once' || source.type === 'delay' || source.type === 'at';
  }

  private isPeriodic(source: TriggerSource): source is Extract<TriggerSource, { type: 'cron' | 'interval' }> {
    return source.type === 'cron' || source.type === 'interval';
  }

  private addRunning(triggerId: string, runId: string, runtime: RunningRun): void {
    let runs = this.running.get(triggerId);
    if (!runs) {
      runs = new Map();
      this.running.set(triggerId, runs);
    }
    runs.set(runId, runtime);
  }

  private finishRun(triggerId: string, runId: string): void {
    const runs = this.running.get(triggerId);
    runs?.delete(runId);
    if (runs && runs.size === 0) this.running.delete(triggerId);
    this.state.remove(triggerId, runId);
  }

  private isRunning(triggerId: string, runId: string): boolean {
    return this.running.get(triggerId)?.has(runId) === true;
  }

  private clearTimer(triggerId: string): void {
    const timer = this.timers.get(triggerId);
    if (timer) clearTimeout(timer);
    this.timers.delete(triggerId);
  }

  private registerEvent(definition: TriggerDefinition): void {
    if (!this.eventSource) {
      logger.warn(`[Trigger] event source disabled; skip ${definition.id}`);
      return;
    }
    this.eventSource.register(definition);
  }

  private unregisterEvent(triggerId: string): void {
    this.eventSource?.unregister(triggerId);
  }

  private subscriptionInfo(definition: TriggerDefinition): TriggerSubscriptionInfo {
    if (definition.source.type !== 'event') return { status: 'not-event' };
    if (!definition.enabled) return { status: 'inactive', warning: 'trigger is disabled' };
    if (!this.eventSource) return { status: 'event-bus-unavailable', warning: 'event bus is not attached to this scheduler' };
    if (this.eventSource.has(definition.id)) return { status: 'active' };
    return { status: 'inactive', warning: 'event subscription is not registered' };
  }

  private async fireEventTrigger(triggerId: string, event: TriggerSourceEvent): Promise<void> {
    const definition = this.manager.get(triggerId);
    if (!definition?.enabled || definition.source.type !== 'event') return;
    const disabledReason = this.limitDisabledReason(definition, event.firedAt);
    if (disabledReason) {
      this.disableForLimit(definition, undefined, event.firedAt, disabledReason);
      return;
    }
    await this.startRun(definition, {
      firedAt: event.firedAt,
      payload: event.payload,
    });
  }

  private publishTriggerDefinitionEvent(type: 'trigger:registered' | 'trigger:updated', definition: TriggerDefinition): void {
    const target = primaryTarget(definition);
    this.eventBus?.publish({
      type,
      triggerId: definition.id,
      name: definition.name,
      peerId: definition.origin?.peerId,
      targetChannel: target?.channelKey,
      targetChannelId: target?.channelId,
      scheduleType: definition.source.type,
      scheduleValue: this.sourceScheduleValue(definition.source),
      timestamp: Date.now(),
    });
  }

  private publishTriggerFired(definition: TriggerDefinition, runId: string, firedAt: number): void {
    const target = primaryTarget(definition);
    this.eventBus?.publish({
      type: 'trigger:fired',
      triggerId: definition.id,
      name: definition.name,
      runId,
      originTriggerId: definition.id,
      fireTime: firedAt,
      targetChannel: target?.channelKey,
      targetChannelId: target?.channelId,
      scheduleType: definition.source.type,
      timestamp: Date.now(),
    });
  }

  private publishTriggerRunOutcome(definition: TriggerDefinition, audit: TriggerAuditRecord): void {
    if (!this.eventBus || audit.status === 'dry-run') return;
    const target = primaryTarget(definition);
    const targetChannel = target?.channelKey ?? 'daemon';
    const targetChannelId = target?.channelId ?? definition.agentAid;
    const base = {
      triggerId: definition.id,
      name: definition.name,
      runId: audit.runId,
      originTriggerId: definition.id,
      targetChannel,
      targetChannelId,
      fireTime: audit.source.firedAt,
    };

    if (audit.status === 'completed' || audit.status === 'noop') {
      this.eventBus.publish({
        type: 'trigger:completed',
        ...base,
        messageId: this.triggerOutcomeMessageId(audit),
        durationMs: Math.max(0, audit.finishedAt - audit.startedAt),
      });
      return;
    }

    if (audit.status === 'failed') {
      this.eventBus.publish({
        type: 'trigger:failed',
        ...base,
        messageId: this.triggerOutcomeMessageId(audit),
        error: audit.error?.message ?? audit.reason ?? 'trigger failed',
        phase: 'execute',
      });
      return;
    }

    if (audit.status === 'skipped') {
      this.eventBus.publish({
        type: 'trigger:skipped',
        ...base,
        reason: audit.reason ?? 'skipped',
      });
    }
  }

  private triggerOutcomeMessageId(audit: TriggerAuditRecord): string {
    return audit.effects.find(effect => effect.messageId)?.messageId ?? audit.runId;
  }

  private sourceScheduleValue(source: TriggerSource): string {
    switch (source.type) {
      case 'cron': return source.expression;
      case 'interval': return `${source.everyMs}ms`;
      case 'delay': return `${source.afterMs}ms`;
      case 'at': return String(source.at);
      case 'once': return 'once';
      case 'event': return source.eventPattern;
    }
  }
}

function replyFromScriptResult(script: TriggerScriptResult, runId: string): TriggerReply {
  const result = script.result ?? {};
  const outcomeRaw = typeof result.outcome === 'string' ? result.outcome : undefined;
  const outcome = normalizeReplyOutcome(outcomeRaw);
  const text = result.text === undefined || result.text === null ? '' : String(result.text);
  if (!outcome) {
    return invalidScriptReply(
      script,
      runId,
      'script_reply_invalid',
      'script stdout must be a TriggerReply object with outcome: success | noop | error | interrupted | timeout',
    );
  }
  const files = Array.isArray(result.files)
    ? result.files
        .filter((file): file is Record<string, unknown> => isRecord(file) && typeof file.path === 'string')
        .map(file => ({
          path: String(file.path),
          name: typeof file.name === 'string' ? file.name : undefined,
        }))
    : [];
  const error = isRecord(result.error)
    ? {
      reason: typeof result.error.reason === 'string' ? result.error.reason : undefined,
      text: typeof result.error.text === 'string' ? result.error.text : text || 'script returned error',
    }
    : outcome === 'error'
      ? { text: text || 'script returned error' }
      : undefined;
  return {
    outcome,
    text,
    files,
    error,
    meta: {
      runId,
      durationMs: script.durationMs,
      toolCallCount: 0,
    },
  };
}

function normalizeReplyOutcome(value: string | undefined): TriggerReply['outcome'] | undefined {
  if (value === 'success' || value === 'noop' || value === 'error' || value === 'interrupted' || value === 'timeout') {
    return value;
  }
  return undefined;
}

function invalidScriptReply(script: TriggerScriptResult, runId: string, reason: string, text: string): TriggerReply {
  return {
    outcome: 'error',
    text: '',
    files: [],
    error: { reason, text },
    meta: {
      runId,
      durationMs: script.durationMs,
      toolCallCount: 0,
    },
  };
}

function branchFromReply(reply: TriggerReply): TriggerFeedbackBranch {
  if (reply.outcome === 'success') return 'onReply';
  if (reply.outcome === 'noop') return 'onNoop';
  return 'onFailure';
}

function shouldRetryExecution(reply: TriggerReply): boolean {
  return reply.outcome === 'error' || reply.outcome === 'timeout' || reply.outcome === 'interrupted';
}

function errorReply(runId: string, durationMs: number, reason: string, text: string): TriggerReply {
  return {
    outcome: 'error',
    text: '',
    files: [],
    error: { reason, text },
    meta: {
      runId,
      durationMs,
      toolCallCount: 0,
    },
  };
}

function summarizeReply(reply: TriggerReply | null | undefined): TriggerAuditRecord['reply'] {
  if (!reply) return null;
  return {
    outcome: reply.outcome,
    textHash: reply.text ? sha256(reply.text) : undefined,
    textPreview: reply.text ? previewText(reply.text) : undefined,
    fileCount: reply.files.length,
    durationMs: reply.meta.durationMs,
    numTurns: reply.meta.numTurns,
    tokenUsage: reply.meta.tokenUsage,
    toolCallCount: reply.meta.toolCallCount,
  };
}

function primaryTarget(definition: TriggerDefinition): TriggerFeedbackTarget | undefined {
  if (definition.feedback.strategy === 'target') return definition.feedback.target;
  if (!definition.origin) return undefined;
  return {
    channelKey: definition.origin.channelKey,
    channelId: definition.origin.channelId,
    session: definition.origin.session,
    threadId: definition.origin.threadId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limitsSignature(limits: TriggerDefinition['limits']): string {
  return JSON.stringify(limits ?? null);
}

function mergeStats(legacy: TriggerRunStats | undefined, current: TriggerRunStats): TriggerRunStats {
  if (!legacy) return current;
  const out: TriggerRunStats = {
    fireCount: legacy.fireCount + current.fireCount,
    failCount: legacy.failCount + current.failCount,
  };
  const legacyAt = legacy.lastFiredAt ?? -1;
  const currentAt = current.lastFiredAt ?? -1;
  if (legacyAt >= currentAt && legacy.lastFiredAt !== undefined) {
    out.lastFiredAt = legacy.lastFiredAt;
    out.lastResult = legacy.lastResult;
  } else if (current.lastFiredAt !== undefined) {
    out.lastFiredAt = current.lastFiredAt;
    out.lastResult = current.lastResult;
  }
  return out;
}

function accountScheduleMarker(
  stats: TriggerRunStats,
  schedule: TriggerScheduleState | undefined,
  hasSkippedSchedule: (scheduledAt: number) => boolean,
): TriggerRunStats {
  if (stats.fireCount > 0 || schedule?.lastScheduledAt === undefined) return stats;
  if (hasSkippedSchedule(schedule.lastScheduledAt)) return stats;
  return {
    ...stats,
    fireCount: 1,
  };
}
