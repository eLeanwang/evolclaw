import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { logger } from '../../utils/logger.js';
import type { TriggerDefinitionManager } from './manager.js';
import type { TriggerRunStateStore } from './state.js';
import type { TriggerAuditLogger } from './audit.js';
import type { TriggerScriptExecutor } from './script-executor.js';
import type { TriggerFeedbackDispatcher } from './feedback.js';
import {
  definitionRevision,
} from './validation.js';
import type {
  TriggerActiveRun,
  TriggerAuditRecord,
  TriggerCreateFile,
  TriggerDefinition,
  TriggerFeedbackBranch,
  TriggerRunPayload,
  TriggerRuntimeResult,
  TriggerScheduleState,
  TriggerScriptResult,
  TriggerSource,
  TriggerSourceRunInfo,
} from './types.js';

const MAX_TIMER_MS = 2_147_483_647;

interface RunningRun {
  run: TriggerActiveRun;
  controller: AbortController;
}

export class TriggerRuntimeScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Map<string, RunningRun>>();
  private initialized = false;

  constructor(
    private manager: TriggerDefinitionManager,
    private state: TriggerRunStateStore,
    private audit: TriggerAuditLogger,
    private scriptExecutor: TriggerScriptExecutor,
    private feedback: TriggerFeedbackDispatcher,
  ) {}

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
    for (const runs of this.running.values()) {
      for (const runtime of runs.values()) runtime.controller.abort();
    }
    this.running.clear();
    this.initialized = false;
  }

  list(opts: { all?: boolean } = {}): TriggerDefinition[] {
    return this.manager.list(opts);
  }

  show(triggerId: string): { definition: TriggerDefinition; active: TriggerActiveRun[]; schedule?: TriggerScheduleState; recentRuns: TriggerAuditRecord[] } {
    return {
      definition: this.manager.require(triggerId),
      active: this.state.list(triggerId),
      schedule: this.state.readSchedule(triggerId),
      recentRuns: this.audit.recent(triggerId, 10),
    };
  }

  create(input: unknown, files: TriggerCreateFile[] = [], opts: { enable?: boolean } = {}): TriggerDefinition {
    const definition = this.manager.create(input, files, opts);
    this.state.clearSchedule(definition.id);
    if (definition.enabled && this.initialized) this.schedule(definition);
    return definition;
  }

  update(triggerId: string, input: unknown, files: TriggerCreateFile[] = []): TriggerDefinition {
    const definition = this.manager.update(triggerId, input, files);
    this.clearTimer(triggerId);
    this.state.clearSchedule(triggerId);
    if (definition.enabled && this.initialized) this.schedule(definition);
    return definition;
  }

  setEnabled(triggerId: string, enabled: boolean): TriggerDefinition {
    const definition = this.manager.setEnabled(triggerId, enabled);
    this.clearTimer(triggerId);
    this.state.clearSchedule(triggerId);
    if (definition.enabled && this.initialized) this.schedule(definition);
    return definition;
  }

  cancel(triggerId: string): TriggerDefinition {
    return this.setEnabled(triggerId, false);
  }

  async run(triggerId: string, opts: { dryRun?: boolean } = {}): Promise<TriggerRuntimeResult> {
    const definition = this.manager.require(triggerId);
    return await this.startRun(definition, {
      firedAt: Date.now(),
      payload: this.sourcePayload(definition.source),
      dryRun: opts.dryRun,
    });
  }

  private schedule(definition: TriggerDefinition): void {
    this.clearTimer(definition.id);
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
    const delay = Math.min(MAX_TIMER_MS, rawDelay);
    const timer = setTimeout(() => {
      this.timers.delete(definition.id);
      if (scheduledAt - Date.now() > 1000) {
        this.schedule(definition);
        return;
      }
      void this.handleScheduledFire(definition.id, scheduledAt);
    }, delay);
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
      this.advancePeriodicSchedule(definition, scheduledAt, firedAt);
    }

    const runPromise = this.startRun(definition, {
      scheduledAt,
      firedAt,
      payload: this.sourcePayload(definition.source),
    });

    if (this.isPeriodic(definition.source)) {
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
    }

    let script: TriggerScriptResult | null = null;
    let branch: TriggerFeedbackBranch = 'onSuccess';
    let result: Record<string, unknown> | undefined;
    let error: { code?: string; message?: string } | undefined;

    try {
      script = await this.runScriptWithRetry(definition, runId, firedAt, source.payload, controller.signal);
      if (!payload.dryRun && !this.isRunning(definition.id, runId)) {
        return {
          ok: false,
          runId,
          triggerId: definition.id,
          status: 'failed',
          reason: controller.signal.aborted ? 'replaced' : 'cancelled',
        };
      }
      if (script.error || script.exitCode !== 0) {
        branch = 'onFailure';
        error = { code: script.error?.code || 'script_error', message: script.error?.message || 'script failed' };
      } else {
        result = script.result ?? {};
        branch = result.matched === false ? 'onNoop' : 'onSuccess';
      }

      if (!payload.dryRun) {
        this.state.appendEvent(definition.id, runId, {
          event: script.error ? 'script.failed' : 'script.completed',
          ts: Date.now(),
          exitCode: script.exitCode,
        });
        this.state.setPhase(definition.id, runId, 'feedback-pending', {
          deadlineAt: Date.now() + 30_000,
        });
        this.state.appendEvent(definition.id, runId, {
          event: 'feedback.pending',
          ts: Date.now(),
          branch,
        });
      }

      const action = branch === 'onNoop'
        ? (definition.feedback.onNoop ?? { mode: 'none' as const })
        : definition.feedback[branch];
      const feedbackResult = await this.feedback.dispatch({
        trigger: definition,
        runId,
        firedAt,
        branch,
        action,
        result,
        error,
        dryRun: payload.dryRun,
      });

      const audit = this.buildAudit({
        definition,
        runId,
        startedAt,
        status: payload.dryRun ? 'dry-run' : feedbackResult.status,
        reason: feedbackResult.reason,
        source,
        script,
        feedback: feedbackResult.feedback,
        effects: feedbackResult.effects,
        error: feedbackResult.error,
      });

      if (!payload.dryRun) {
        this.audit.write(audit);
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
        script,
        feedback: null,
        effects: [],
        error: { code: 'daemon_error', message },
      });
      if (!payload.dryRun) {
        this.audit.write(audit);
        this.finishRun(definition.id, runId);
      }
      return { ok: false, runId, triggerId: definition.id, status: 'failed', reason: 'daemon_error', audit, error: message };
    }
  }

  private async runScriptWithRetry(
    definition: TriggerDefinition,
    runId: string,
    firedAt: number,
    sourcePayload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TriggerScriptResult> {
    const maxAttempts = definition.reliability.scriptRetry.maxAttempts;
    const backoffMs = definition.reliability.scriptRetry.backoffMs;
    let last: TriggerScriptResult | undefined;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      last = await this.scriptExecutor.execute({
        trigger: definition,
        triggerDir: this.manager.triggerDir(definition.id),
        runId,
        firedAt,
        sourcePayload,
        signal,
      });
      if (!last.error && last.exitCode === 0) return last;
      if (attempt < maxAttempts && !signal.aborted) await sleep(backoffMs);
    }
    return last!;
  }

  private checkConcurrency(definition: TriggerDefinition, nextRunId: string, source: TriggerSourceRunInfo): TriggerRuntimeResult | undefined {
    const runs = this.running.get(definition.id);
    if (!runs || runs.size === 0 || definition.reliability.concurrency === 'allow') return undefined;
    const first = runs.values().next().value as RunningRun | undefined;
    const conflictRunId = first?.run.runId;

    if (definition.reliability.concurrency === 'forbid') {
      this.writeSkippedAudit(definition, source.scheduledAt, source.firedAt, 'concurrency_forbid', conflictRunId);
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
        feedback: null,
        effects: [],
        error: { code: 'replaced', message: `run replaced by ${nextRunId}` },
      });
      this.audit.write(audit);
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
        if (state?.sourceSignature === signature) return state.nextFireAt;
        const nextFireAt = this.nextPeriodicFireAt(definition.source, now);
        this.writeScheduleCursor(definition, nextFireAt, signature);
        return nextFireAt;
      }
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
    this.writeScheduleCursor(definition, nextFireAt);
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

  private writeScheduleCursor(definition: TriggerDefinition, nextFireAt: number, signature = this.sourceSignature(definition.source)): void {
    this.state.writeSchedule(definition.id, {
      nextFireAt,
      updatedAt: Date.now(),
      sourceSignature: signature,
    });
  }

  private sourceSignature(source: TriggerSource): string {
    return JSON.stringify(source);
  }

  private sourcePayload(source: TriggerSource): Record<string, unknown> {
    switch (source.type) {
      case 'delay': return { afterMs: source.afterMs };
      case 'at': return { at: source.at };
      case 'cron': return { expression: source.expression, timezone: source.timezone };
      case 'interval': return { everyMs: source.everyMs };
    }
  }

  private buildSourceInfo(source: TriggerSource, firedAt: number, scheduledAt?: number, payload?: Record<string, unknown>): TriggerSourceRunInfo {
    return {
      type: source.type,
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
    script: TriggerScriptResult | null;
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
        schemaVersion: 1,
        revision: definitionRevision(input.definition),
        name: input.definition.name,
      },
      source: input.source,
      script: input.script,
      feedback: input.feedback,
      effects: input.effects,
      error: input.error,
    };
  }

  private writeSkippedAudit(definition: TriggerDefinition, scheduledAt: number | undefined, firedAt: number, reason: string, conflictRunId?: string): void {
    this.audit.write(this.buildAudit({
      definition,
      runId: `run_${firedAt}_${crypto.randomBytes(3).toString('hex')}`,
      startedAt: firedAt,
      status: 'skipped',
      reason,
      source: this.buildSourceInfo(definition.source, firedAt, scheduledAt, this.sourcePayload(definition.source)),
      script: null,
      feedback: null,
      effects: [],
      error: null,
      conflictRunId,
    }));
  }

  private isOneShot(source: TriggerSource): boolean {
    return source.type === 'delay' || source.type === 'at';
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
