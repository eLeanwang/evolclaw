import { EventBus, GatewayEvent } from '../core/event-bus.js';

interface EventRecord {
  type: string;
  timestamp: number;
  agentName?: string;  // for per-agent bucketing
  durationMs?: number;
  errorType?: string;
  toolName?: string;
}

export interface StatsSnapshot {
  uptimeMs: number;
  lastHour: {
    received: number;
    completed: number;
    errors: number;
    errorsByType: Record<string, number>;
    toolErrors: number;
    toolErrorsByName: Record<string, number>;
    interrupts: number;
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
      const e = event as { timestamp?: number; agentName?: string };
      this.recordEvent({ type: 'received', timestamp: e.timestamp || Date.now(), agentName: e.agentName });
    });

    eventBus.subscribe('message:completed', (event) => {
      const e = event as { timestamp?: number; durationMs?: number; agentName?: string };
      this.recordEvent({ type: 'completed', timestamp: e.timestamp || Date.now(), durationMs: e.durationMs, agentName: e.agentName });
    });

    eventBus.subscribe('message:error', (event) => {
      const e = event as { errorType?: string; agentName?: string };
      this.recordEvent({ type: 'error', timestamp: Date.now(), errorType: e.errorType, agentName: e.agentName });
    });

    eventBus.subscribe('message:interrupted', (event) => {
      const e = event as { agentName?: string };
      this.recordEvent({ type: 'interrupted', timestamp: Date.now(), agentName: e.agentName });
    });

    eventBus.subscribe('tool:result', (event) => {
      const e = event as { isError?: boolean; toolName?: string; agentName?: string };
      if (e.isError) {
        this.recordEvent({ type: 'tool-error', timestamp: Date.now(), toolName: e.toolName, agentName: e.agentName });
      }
    });
  }

  private recordEvent(record: EventRecord): void {
    this.events.push(record);
  }

  /**
   * 获取统计快照。可选 agentName 过滤：未传则全局；传入则只统计该 agent。
   * 自动裁剪 >1h 的事件。
   */
  getSnapshot(agentName?: string): StatsSnapshot {
    const now = Date.now();
    const cutoff = now - this.HOUR_MS;

    // 裁剪过期事件
    this.events = this.events.filter(e => e.timestamp >= cutoff);

    // 聚合统计（可按 agent 过滤）
    const filtered = agentName === undefined
      ? this.events
      : this.events.filter(e => (e.agentName ?? '<unknown>') === agentName);

    let received = 0;
    let completed = 0;
    let errors = 0;
    const errorsByType: Record<string, number> = {};
    let toolErrors = 0;
    const toolErrorsByName: Record<string, number> = {};
    let interrupts = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const event of filtered) {
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
        case 'tool-error':
          toolErrors++;
          if (event.toolName) {
            toolErrorsByName[event.toolName] = (toolErrorsByName[event.toolName] || 0) + 1;
          }
          break;
        case 'interrupted':
          interrupts++;
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
        toolErrors,
        toolErrorsByName,
        interrupts,
        avgResponseMs: durationCount > 0 ? totalDuration / durationCount : 0
      }
    };
  }
}
