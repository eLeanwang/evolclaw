import { InstanceManager } from './instance-manager.js';
import { InstanceState } from './claude-instance.js';

export interface RecoveryConfig {
  retry: {
    maxAttempts: number;
    backoff: 'linear' | 'exponential';
    initialDelay: number;
  };
  restart: {
    enabled: boolean;
    maxRestarts: number;
    cooldown: number;
  };
}

export class FailureHandler {
  private instanceManager: InstanceManager;
  private config: RecoveryConfig;
  private retryAttempts: Map<string, number> = new Map();
  private restartCounts: Map<string, number> = new Map();

  constructor(instanceManager: InstanceManager, config: RecoveryConfig) {
    this.instanceManager = instanceManager;
    this.config = config;

    this.instanceManager.on('instanceError', ({ sessionId, error }) => {
      this.handleError(sessionId, error);
    });

    this.instanceManager.on('instanceExit', ({ sessionId }) => {
      this.handleExit(sessionId);
    });
  }

  async handleError(sessionId: string, error: Error): Promise<void> {
    const attempts = this.retryAttempts.get(sessionId) || 0;

    if (attempts < this.config.retry.maxAttempts) {
      await this.retry(sessionId, attempts);
    } else if (this.config.restart.enabled) {
      await this.restart(sessionId);
    }
  }

  async handleExit(sessionId: string): Promise<void> {
    if (this.config.restart.enabled) {
      await this.restart(sessionId);
    }
  }

  private async retry(sessionId: string, attempt: number): Promise<void> {
    const delay = this.calculateBackoff(attempt);
    await this.sleep(delay);

    this.retryAttempts.set(sessionId, attempt + 1);
  }

  private async restart(sessionId: string): Promise<void> {
    const restarts = this.restartCounts.get(sessionId) || 0;

    if (restarts >= this.config.restart.maxRestarts) {
      return;
    }

    await this.sleep(this.config.restart.cooldown);
    await this.instanceManager.stopInstance(sessionId);

    this.restartCounts.set(sessionId, restarts + 1);
    this.retryAttempts.delete(sessionId);
  }

  private calculateBackoff(attempt: number): number {
    if (this.config.retry.backoff === 'linear') {
      return this.config.retry.initialDelay * (attempt + 1);
    } else {
      return Math.min(
        this.config.retry.initialDelay * Math.pow(2, attempt),
        30000
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
