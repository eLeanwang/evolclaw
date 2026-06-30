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

  /**
   * 汇总某 trigger 的运行统计——扫描所有保留的 trigger-runs 切片（活跃文件 +
   * 按天归档的 trigger-runs-YYYYMMDD.log），统计执行过的运行（completed/noop/failed）。
   *
   * 注意：受日志保留期（默认 7 天）限制，这是「保留窗口内」的统计而非全生命周期计数。
   * skipped（并发禁止/错过策略）和 dry-run 不计入 fireCount——它们没有真正执行脚本。
   */
  stats(triggerId: string): TriggerRunStats {
    const out: TriggerRunStats = { fireCount: 0, failCount: 0 };
    let latestFinishedAt = -1;
    for (const file of this.listLogFiles()) {
      let lines: string[];
      try { lines = fs.readFileSync(file, 'utf-8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line) continue;
        let record: TriggerAuditRecord;
        try { record = JSON.parse(line) as TriggerAuditRecord; } catch { continue; }
        if (record.triggerId !== triggerId) continue;
        if (record.status !== 'completed' && record.status !== 'noop' && record.status !== 'failed') continue;
        out.fireCount += 1;
        if (record.status === 'failed') out.failCount += 1;
        if (record.finishedAt > latestFinishedAt) {
          latestFinishedAt = record.finishedAt;
          out.lastFiredAt = record.finishedAt;
          out.lastResult = record.status === 'failed' ? 'failed' : 'completed';
        }
      }
    }
    return out;
  }

  hasSkippedSchedule(triggerId: string, scheduledAt: number): boolean {
    for (const file of this.listLogFiles()) {
      let lines: string[];
      try { lines = fs.readFileSync(file, 'utf-8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line) continue;
        let record: TriggerAuditRecord;
        try { record = JSON.parse(line) as TriggerAuditRecord; } catch { continue; }
        if (
          record.triggerId === triggerId
          && record.status === 'skipped'
          && record.source.scheduledAt === scheduledAt
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** 列出所有 trigger-runs 日志文件（活跃 + 归档切片），用于跨切片统计。 */
  private listLogFiles(): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(this.logDir); } catch { return []; }
    return entries
      .filter(f => f === 'trigger-runs.log' || /^trigger-runs-\d{8}\.log$/.test(f))
      .map(f => path.join(this.logDir, f));
  }
}

export interface TriggerRunStats {
  fireCount: number;
  failCount: number;
  lastFiredAt?: number;
  lastResult?: 'completed' | 'failed';
}
