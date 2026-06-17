import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { LogWriter } from '../utils/log-writer.js';
import type { TriggerAuditRecord } from './types.js';

export class TriggerAuditLogger {
  private writer: LogWriter;
  private logDir: string;

  constructor(logDir = resolvePaths().logs) {
    this.logDir = logDir;
    this.writer = new LogWriter({
      baseName: 'trigger-runs',
      logDir,
      rotation: 'daily',
      retention: { days: 7 },
    });
  }

  write(record: TriggerAuditRecord): void {
    this.writer.write(JSON.stringify(record));
  }

  recent(triggerId: string, limit = 20): TriggerAuditRecord[] {
    const file = path.join(this.logDir, 'trigger-runs.log');
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
    const out: TriggerAuditRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const record = JSON.parse(lines[i]) as TriggerAuditRecord;
        if (record.triggerId === triggerId) out.push(record);
      } catch {
        // skip malformed audit lines
      }
    }
    return out;
  }
}
