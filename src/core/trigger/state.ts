import fs from 'fs';
import { atomicWriteJson } from '../session/session-fs-store.js';
import type {
  TriggerActiveFile,
  TriggerActiveRun,
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
      return schedule ? { runs, schedule } : { runs };
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

  private write(triggerId: string, active: TriggerActiveFile): void {
    if (Object.keys(active.runs).length === 0 && !active.schedule) {
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
    && typeof schedule.sourceSignature === 'string';
}
