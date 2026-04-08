import { EventBus, GatewayEvent } from './event-bus.js';

interface EventRecord {
  type: string;
  timestamp: number;
  durationMs?: number;
  errorType?: string;
}

export interface StatsSnapshot {
  uptimeMs: number;
  lastHour: {
    received: number;
    completed: number;
    errors: number;
    errorsByType: Record<string, number>;
    interrupts: number;
    safeModeEntries: number;
    avgResponseMs: number;
  };
}

export class StatsCollector {
  private events: EventRecord[] = [];
  private startTime: number;
  private readonly HOUR_MS = 3_600_000;

  constructor(eventBus: EventBus) {
    this.startTime = Date.now();

    // 订阅相关事件
    eventBus.subscribe('message:received', (event) => {
      const e = event as { timestamp?: number };
      this.recordEvent({ type: 'received', timestamp: e.timestamp || Date.now() });
    });

    eventBus.subscribe('message:completed', (event) => {
      const e = event as { timestamp?: number; durationMs?: number };
      this.recordEvent({ type: 'completed', timestamp: e.timestamp || Date.now(), durationMs: e.durationMs });
    });

    eventBus.subscribe('message:error', (event) => {
      const e = event as { errorType?: string };
      this.recordEvent({ type: 'error', timestamp: Date.now(), errorType: e.errorType });
    });

    eventBus.subscribe('message:interrupted', (_event) => {
      this.recordEvent({ type: 'interrupted', timestamp: Date.now() });
    });

    eventBus.subscribe('session:safe-mode-entered', (_event) => {
      this.recordEvent({ type: 'safe-mode-entered', timestamp: Date.now() });
    });
  }

  private recordEvent(record: EventRecord): void {
    this.events.push(record);
  }

  /**
   * 获取统计快照（自动裁剪 >1h 的事件）
   */
  getSnapshot(): StatsSnapshot {
    const now = Date.now();
    const cutoff = now - this.HOUR_MS;

    // 裁剪过期事件
    this.events = this.events.filter(e => e.timestamp >= cutoff);

    // 聚合统计
    let received = 0;
    let completed = 0;
    let errors = 0;
    const errorsByType: Record<string, number> = {};
    let interrupts = 0;
    let safeModeEntries = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const event of this.events) {
      switch (event.type) {
        case 'received':
          received++;
          break;
        case 'completed':
          completed++;
          if (event.durationMs !== undefined) {
            totalDuration += event.durationMs;
            durationCount++;
          }
          break;
        case 'error':
          errors++;
          if (event.errorType) {
            errorsByType[event.errorType] = (errorsByType[event.errorType] || 0) + 1;
          }
          break;
        case 'interrupted':
          interrupts++;
          break;
        case 'safe-mode-entered':
          safeModeEntries++;
          break;
      }
    }

    return {
      uptimeMs: now - this.startTime,
      lastHour: {
        received,
        completed,
        errors,
        errorsByType,
        interrupts,
        safeModeEntries,
        avgResponseMs: durationCount > 0 ? totalDuration / durationCount : 0
      }
    };
  }
}
