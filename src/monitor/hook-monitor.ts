import { HookCollector } from './hook-collector.js';
import { EventEmitter } from 'events';

export interface HookMonitorConfig {
  timeoutLimit: number;
  checkInterval: number;
}

export class HookBasedMonitor extends EventEmitter {
  private collector: HookCollector;
  private config: HookMonitorConfig;
  private checkTimer?: NodeJS.Timeout;

  constructor(collector: HookCollector, config: HookMonitorConfig) {
    super();
    this.collector = collector;
    this.config = config;
  }

  start(): void {
    this.checkTimer = setInterval(() => this.checkTimeouts(), this.config.checkInterval);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  private checkTimeouts(): void {
    const activeSessions = this.collector.getActiveSessions();
    const now = Date.now();

    for (const sessionId of activeSessions) {
      const lastActivity = this.collector.getLastActivity(sessionId);
      if (lastActivity && now - lastActivity > this.config.timeoutLimit) {
        this.emit('timeout', { sessionId, lastActivity, now });
      }
    }
  }
}
