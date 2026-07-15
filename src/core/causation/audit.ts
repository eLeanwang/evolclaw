import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../../paths.js';
import { LogWriter } from '../../utils/log-writer.js';
import type {
  CausationContext,
  CausationSpanLinkRecord,
  CausationSpanRecord,
  CausationSpanRefs,
  CausationSpanType,
} from './types.js';

let writer: LogWriter | undefined;

function auditWriter(): LogWriter {
  writer ??= new LogWriter({
    baseName: 'causation-spans',
    logDir: resolvePaths().logs,
    rotation: 'daily',
    retention: { days: 7 },
  });
  return writer;
}

function writeAuditRecord(record: CausationSpanRecord | CausationSpanLinkRecord): void {
  try {
    auditWriter().write(JSON.stringify(record));
  } catch {
  }
}

export function recordCausationSpan(
  context: CausationContext,
  type: CausationSpanType,
  options: {
    status?: CausationSpanRecord['status'];
    refs?: CausationSpanRefs;
    reason?: string;
    timestamp?: number;
  } = {},
): void {
  const record: CausationSpanRecord = {
    version: 1,
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    type,
    timestamp: options.timestamp ?? Date.now(),
    status: options.status,
    refs: options.refs,
    reason: options.reason,
  };
  writeAuditRecord(record);
}

export function recordCausationLink(record: Omit<CausationSpanLinkRecord, 'version' | 'timestamp'> & { timestamp?: number }): void {
  writeAuditRecord({
    version: 1,
    ...record,
    timestamp: record.timestamp ?? Date.now(),
  } satisfies CausationSpanLinkRecord);
}

export interface CausationTraceResult {
  traceId: string;
  spans: CausationSpanRecord[];
  links: CausationSpanLinkRecord[];
}

export function queryCausationTrace(traceId: string): CausationTraceResult {
  const records = readAuditRecords();
  const spans = records
    .filter(isSpanRecord)
    .filter(record => record.traceId === traceId)
    .sort((left, right) => left.timestamp - right.timestamp);
  const spanIds = new Set(spans.map(record => record.spanId));
  const links = records
    .filter(isLinkRecord)
    .filter(record => spanIds.has(record.spanId) || record.linkedTraceId === traceId)
    .sort((left, right) => left.timestamp - right.timestamp);
  return { traceId, spans, links };
}

function readAuditRecords(): Array<CausationSpanRecord | CausationSpanLinkRecord> {
  const logDir = resolvePaths().logs;
  let files: string[];
  try {
    files = fs.readdirSync(logDir)
      .filter(file => file === 'causation-spans.log' || /^causation-spans-\d{8}\.log$/.test(file))
      .map(file => path.join(logDir, file));
  } catch {
    return [];
  }
  const records: Array<CausationSpanRecord | CausationSpanLinkRecord> = [];
  for (const file of files) {
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as CausationSpanRecord | CausationSpanLinkRecord;
        if (isSpanRecord(parsed) || isLinkRecord(parsed)) records.push(parsed);
      } catch {
      }
    }
  }
  return records;
}

function isSpanRecord(value: CausationSpanRecord | CausationSpanLinkRecord): value is CausationSpanRecord {
  return typeof (value as CausationSpanRecord).traceId === 'string'
    && typeof value.spanId === 'string'
    && typeof (value as CausationSpanRecord).type === 'string';
}

function isLinkRecord(value: CausationSpanRecord | CausationSpanLinkRecord): value is CausationSpanLinkRecord {
  return (value as CausationSpanLinkRecord).relation === 'batch_input'
    && typeof (value as CausationSpanLinkRecord).linkedTraceId === 'string'
    && typeof (value as CausationSpanLinkRecord).linkedSpanId === 'string';
}

export function resetCausationAuditForTests(): void {
  writer?.close();
  writer = undefined;
}
