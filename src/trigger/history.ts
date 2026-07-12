import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { TriggerAuditRecord, TriggerDefinition } from './types.js';
import { definitionRevision } from './validation.js';
import type { TriggerRunStats } from './audit.js';

export type TriggerHistoryEventType =
  | 'trigger.created'
  | 'trigger.updated'
  | 'trigger.enabled'
  | 'trigger.disabled'
  | 'trigger.deleted'
  | 'trigger.legacy_archived'
  | 'run.completed'
  | 'run.noop'
  | 'run.skipped'
  | 'run.failed';

interface TriggerHistoryEventBase {
  schemaVersion: 1;
  eventId: string;
  type: TriggerHistoryEventType;
  timestamp: number;
  triggerId: string;
  agentAid: string;
}

export interface TriggerDefinitionHistoryEvent extends TriggerHistoryEventBase {
  type:
    | 'trigger.created'
    | 'trigger.updated'
    | 'trigger.enabled'
    | 'trigger.disabled'
    | 'trigger.deleted';
  definition: TriggerDefinition;
  revision: string;
  previousRevision?: string;
  reason?: string;
}

export interface TriggerRunHistoryEvent extends TriggerHistoryEventBase {
  type: 'run.completed' | 'run.noop' | 'run.skipped' | 'run.failed';
  audit: TriggerAuditRecord;
  importedFrom?: string;
}

export interface TriggerLegacyHistoryEvent extends TriggerHistoryEventBase {
  type: 'trigger.legacy_archived';
  legacyRecord: Record<string, unknown>;
}

export type TriggerHistoryEvent =
  | TriggerDefinitionHistoryEvent
  | TriggerRunHistoryEvent
  | TriggerLegacyHistoryEvent;

export class TriggerHistoryStore {
  readonly file: string;

  constructor(
    readonly rootDir: string,
    readonly agentAid: string,
  ) {
    fs.mkdirSync(rootDir, { recursive: true });
    this.file = path.join(rootDir, 'history.jsonl');
  }

  recordDefinition(
    type: TriggerDefinitionHistoryEvent['type'],
    definition: TriggerDefinition,
    opts: { previousRevision?: string; reason?: string } = {},
  ): TriggerDefinitionHistoryEvent {
    const event: TriggerDefinitionHistoryEvent = {
      schemaVersion: 1,
      eventId: `evt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      type,
      timestamp: Date.now(),
      triggerId: definition.id,
      agentAid: definition.agentAid,
      definition,
      revision: definitionRevision(definition),
      previousRevision: opts.previousRevision,
      reason: opts.reason,
    };
    this.append(event);
    return event;
  }

  recordRun(audit: TriggerAuditRecord, importedFrom?: string): TriggerRunHistoryEvent {
    const event: TriggerRunHistoryEvent = {
      schemaVersion: 1,
      eventId: `run:${audit.runId}`,
      type: `run.${audit.status}` as TriggerRunHistoryEvent['type'],
      timestamp: audit.finishedAt,
      triggerId: audit.triggerId,
      agentAid: audit.agentAid,
      audit,
      importedFrom,
    };
    this.append(event);
    return event;
  }

  events(triggerId?: string, limit = 100): TriggerHistoryEvent[] {
    if (limit <= 0) return [];
    const lines = this.readLines();
    const out: TriggerHistoryEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const event = parseHistoryEvent(lines[i], this.agentAid);
      if (!event || event.agentAid !== this.agentAid) continue;
      if (triggerId && event.triggerId !== triggerId) continue;
      out.push(event);
    }
    return out;
  }

  recentRuns(triggerId: string, limit = 20): TriggerAuditRecord[] {
    if (limit <= 0) return [];
    const lines = this.readLines();
    const out: TriggerAuditRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const event = parseHistoryEvent(lines[i], this.agentAid);
      if (!event || !isRunEvent(event)) continue;
      if (event.agentAid === this.agentAid && event.triggerId === triggerId) {
        out.push(event.audit);
      }
    }
    return out;
  }

  stats(triggerId: string): TriggerRunStats {
    const legacy: TriggerRunStats = { fireCount: 0, failCount: 0 };
    const current: TriggerRunStats = { fireCount: 0, failCount: 0 };
    let legacyMatched = false;
    let latestFinishedAt = -1;
    for (const line of this.readLines()) {
      const event = parseHistoryEvent(line, this.agentAid);
      if (!event || event.triggerId !== triggerId || event.agentAid !== this.agentAid) continue;
      if (isLegacyEvent(event)) {
        legacyMatched = true;
        const fireCount = nonNegativeInteger(event.legacyRecord.fireCount);
        const failCount = nonNegativeInteger(event.legacyRecord.failCount);
        legacy.fireCount = Math.max(legacy.fireCount, fireCount ?? 0);
        legacy.failCount = Math.max(legacy.failCount, failCount ?? 0);
        const lastFiredAt = finiteNumber(event.legacyRecord.lastFiredAt);
        if (lastFiredAt !== undefined && lastFiredAt > latestFinishedAt) {
          latestFinishedAt = lastFiredAt;
          legacy.lastFiredAt = lastFiredAt;
          legacy.lastResult = event.legacyRecord.lastResult === 'failed' ? 'failed' : 'completed';
        }
        continue;
      }
      if (!isRunEvent(event)) continue;
      const record = event.audit;
      if (record.status !== 'completed' && record.status !== 'noop' && record.status !== 'failed') continue;
      current.fireCount += 1;
      if (record.status === 'failed') current.failCount += 1;
      if (record.finishedAt > latestFinishedAt) {
        latestFinishedAt = record.finishedAt;
        current.lastFiredAt = record.finishedAt;
        current.lastResult = record.status === 'failed' ? 'failed' : 'completed';
      }
    }
    return this.mergeRunStats(legacyMatched ? legacy : undefined, current);
  }

  hasSkippedSchedule(triggerId: string, scheduledAt: number): boolean {
    for (const line of this.readLines()) {
      const event = parseHistoryEvent(line, this.agentAid);
      if (!event || !isRunEvent(event) || event.triggerId !== triggerId || event.agentAid !== this.agentAid) continue;
      if (event.audit.status === 'skipped' && event.audit.source.scheduledAt === scheduledAt) return true;
    }
    return false;
  }

  hasLegacyArchive(triggerId: string): boolean {
    return this.readLines().some(line => {
      const event = parseHistoryEvent(line, this.agentAid);
      return !!event
        && event.agentAid === this.agentAid
        && event.triggerId === triggerId
        && isLegacyEvent(event);
    });
  }

  ensureDefinitionSnapshot(definition: TriggerDefinition): void {
    const revision = definitionRevision(definition);
    for (const event of this.events(definition.id, Number.MAX_SAFE_INTEGER)) {
      if (isDefinitionEvent(event) && event.revision === revision) return;
    }
    this.recordDefinition('trigger.created', definition, { reason: 'migration_snapshot' });
  }

  importAuditLogs(logDir: string): number {
    const knownRuns = new Set(
      this.events(undefined, Number.MAX_SAFE_INTEGER)
        .filter(isRunEvent)
        .map(event => event.audit.runId),
    );
    let imported = 0;
    for (const file of listAuditLogFiles(logDir)) {
      let lines: string[];
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line) continue;
        let audit: TriggerAuditRecord;
        try {
          audit = JSON.parse(line) as TriggerAuditRecord;
        } catch {
          continue;
        }
        if (audit.agentAid !== this.agentAid || !audit.runId || knownRuns.has(audit.runId)) continue;
        if (audit.status === 'dry-run') continue;
        this.recordRun(audit, path.basename(file));
        knownRuns.add(audit.runId);
        imported += 1;
      }
    }
    return imported;
  }

  private append(event: TriggerHistoryEvent): void {
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private readLines(): string[] {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private mergeRunStats(
    legacy: TriggerRunStats | undefined,
    current: TriggerRunStats,
  ): TriggerRunStats {
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
}

function parseHistoryEvent(line: string, fallbackAgentAid: string): TriggerHistoryEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    const triggerId = stringValue(record.id);
    if (!triggerId) return undefined;
    const timestamp = finiteNumber(record.doneAt)
      ?? finiteNumber(record.updatedAt)
      ?? finiteNumber(record.createdAt)
      ?? 0;
    return {
      schemaVersion: 1,
      eventId: `legacy:${triggerId}:${timestamp}`,
      type: 'trigger.legacy_archived',
      timestamp,
      triggerId,
      agentAid: stringValue(record.schedulerAid) ?? fallbackAgentAid,
      legacyRecord: record,
    };
  }
  const event = record as unknown as Partial<TriggerHistoryEvent>;
  if (typeof event.type !== 'string' || typeof event.triggerId !== 'string') return undefined;
  if (!event.type.startsWith('trigger.') && !event.type.startsWith('run.')) return undefined;
  return event as TriggerHistoryEvent;
}

function isRunEvent(event: TriggerHistoryEvent): event is TriggerRunHistoryEvent {
  return event.type.startsWith('run.');
}

function isDefinitionEvent(event: TriggerHistoryEvent): event is TriggerDefinitionHistoryEvent {
  return event.type.startsWith('trigger.') && event.type !== 'trigger.legacy_archived';
}

function isLegacyEvent(event: TriggerHistoryEvent): event is TriggerLegacyHistoryEvent {
  return event.type === 'trigger.legacy_archived';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function listAuditLogFiles(logDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return [];
  }
  return entries
    .filter(file => file === 'trigger-runs.log' || /^trigger-runs-\d{8}\.log$/.test(file))
    .sort()
    .map(file => path.join(logDir, file));
}
