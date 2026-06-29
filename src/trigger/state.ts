import fs from 'fs';
import { atomicWriteJson } from '../core/session/session-fs-store.js';
import type {
  TriggerActiveFile,
  TriggerActiveRun,
  TriggerLimitState,
  TriggerRunEvent,
  TriggerScheduleState,
} from './types.js';
import type { TriggerDefinitionManager } from './manager.js';

export class TriggerRunStateStore {
  constructor(private manager: TriggerDefinitionManager) {}

  read(triggerId: string): TriggerActiveFile {
    const file = this.manager.activePath(triggerId);
    if (!fs.existsSync(file)) return { runs: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as TriggerActiveFile;
      if (!parsed || typeof parsed !== 'object') return { runs: {} };
      const runs = parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {};
      const schedule = isValidSchedule(parsed.schedule) ? parsed.schedule : undefined;
      const limits = isValidLimitState(parsed.limits) ? parsed.limits : undefined;
      return { runs, ...(schedule ? { schedule } : {}), ...(limits ? { limits } : {}) };
    } catch {
      return { runs: {} };
    }
  }

  list(triggerId: string): TriggerActiveRun[] {
    return Object.values(this.read(triggerId).runs);
  }

  upsert(triggerId: string, run: TriggerActiveRun): void {
    const active = this.read(triggerId);
    active.runs[run.runId] = run;
    this.write(triggerId, active);
  }

  appendEvent(triggerId: string, runId: string, event: { event: string; ts: number; [key: string]: unknown }): TriggerActiveRun | undefined {
    const active = this.read(triggerId);
    const run = active.runs[runId];
    if (!run) return undefined;
    run.events.push({ seq: run.events.length, ...event });
    this.write(triggerId, active);
    return run;
  }

  setPhase(triggerId: string, runId: string, phase: TriggerActiveRun['phase'], patch: Partial<TriggerActiveRun> = {}): TriggerActiveRun | undefined {
    const active = this.read(triggerId);
    const run = active.runs[runId];
    if (!run) return undefined;
    Object.assign(run, patch, { phase });
    this.write(triggerId, active);
    return run;
  }

  remove(triggerId: string, runId: string): void {
    const active = this.read(triggerId);
    delete active.runs[runId];
    this.write(triggerId, active);
  }

  clear(triggerId: string): void {
    const active = this.read(triggerId);
    active.runs = {};
    this.write(triggerId, active);
  }

  readSchedule(triggerId: string): TriggerScheduleState | undefined {
    return this.read(triggerId).schedule;
  }

  writeSchedule(triggerId: string, schedule: TriggerScheduleState): void {
    const active = this.read(triggerId);
    active.schedule = schedule;
    this.write(triggerId, active);
  }

  clearSchedule(triggerId: string): void {
    const active = this.read(triggerId);
    delete active.schedule;
    this.write(triggerId, active);
  }

  readLimitState(triggerId: string): TriggerLimitState | undefined {
    return this.read(triggerId).limits;
  }

  ensureLimitState(triggerId: string, startedAt = Date.now()): TriggerLimitState {
    const active = this.read(triggerId);
    if (!active.limits) {
      active.limits = { startedAt, runCount: 0 };
      this.write(triggerId, active);
    }
    return active.limits;
  }

  resetLimitState(triggerId: string, startedAt = Date.now()): TriggerLimitState {
    const active = this.read(triggerId);
    active.limits = { startedAt, runCount: 0 };
    this.write(triggerId, active);
    return active.limits;
  }

  incrementLimitRunCount(triggerId: string, startedAt = Date.now()): TriggerLimitState {
    const active = this.read(triggerId);
    const current = active.limits ?? { startedAt, runCount: 0 };
    active.limits = {
      startedAt: current.startedAt,
      runCount: current.runCount + 1,
    };
    this.write(triggerId, active);
    return active.limits;
  }

  markLimitDisabled(triggerId: string, reason: TriggerLimitState['disabledReason']): TriggerLimitState {
    const active = this.read(triggerId);
    const current = active.limits ?? { startedAt: Date.now(), runCount: 0 };
    active.limits = {
      startedAt: current.startedAt,
      runCount: current.runCount,
      disabledReason: reason,
    };
    this.write(triggerId, active);
    return active.limits;
  }

  clearLimitState(triggerId: string): void {
    const active = this.read(triggerId);
    delete active.limits;
    this.write(triggerId, active);
  }

  private write(triggerId: string, active: TriggerActiveFile): void {
    if (Object.keys(active.runs).length === 0 && !active.schedule && !active.limits) {
      this.manager.clearActive(triggerId);
      return;
    }
    atomicWriteJson(this.manager.activePath(triggerId), active);
  }
}

function isValidSchedule(value: unknown): value is TriggerScheduleState {
  if (!value || typeof value !== 'object') return false;
  const schedule = value as TriggerScheduleState;
  return Number.isFinite(schedule.nextFireAt)
    && Number.isFinite(schedule.updatedAt)
    && typeof schedule.sourceSignature === 'string'
    && (schedule.lastScheduledAt === undefined || Number.isFinite(schedule.lastScheduledAt))
    && (schedule.lastFiredAt === undefined || Number.isFinite(schedule.lastFiredAt));
}

function isValidLimitState(value: unknown): value is TriggerLimitState {
  if (!value || typeof value !== 'object') return false;
  const limits = value as TriggerLimitState;
  return Number.isFinite(limits.startedAt)
    && Number.isInteger(limits.runCount)
    && limits.runCount >= 0
    && (
      limits.disabledReason === undefined
      || limits.disabledReason === 'max_runs'
      || limits.disabledReason === 'max_duration'
    );
}
