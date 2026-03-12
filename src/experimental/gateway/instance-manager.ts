import { ClaudeInstance, InstanceState } from './claude-instance.js';
import { EventEmitter } from 'events';

export interface InstancePoolConfig {
  maxInstances: number;
  idleTimeout: number;
  apiKey?: string;
}

export class InstanceManager extends EventEmitter {
  private instances: Map<string, ClaudeInstance> = new Map();
  private config: InstancePoolConfig;
  private cleanerTimer?: NodeJS.Timeout;

  constructor(config: InstancePoolConfig) {
    super();
    this.config = config;
    this.startCleaner();
  }

  async getOrCreateInstance(sessionId: string, projectPath: string): Promise<ClaudeInstance> {
    let instance = this.instances.get(sessionId);

    if (instance?.isAlive()) {
      return instance;
    }

    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(`Max instances reached (${this.instances.size}/${this.config.maxInstances})`);
    }

    instance = new ClaudeInstance(sessionId, projectPath, this.config.apiKey || '');
    instance.on('hook', (event) => this.emit('hook', { sessionId, ...event }));

    this.instances.set(sessionId, instance);
    this.emit('instanceCreated', { sessionId, projectPath });
    return instance;
  }

  async stopInstance(sessionId: string): Promise<void> {
    const instance = this.instances.get(sessionId);
    if (instance) {
      await instance.stop();
      this.instances.delete(sessionId);
      this.emit('instanceStopped', { sessionId });
    }
  }

  getInstance(sessionId: string): ClaudeInstance | undefined {
    return this.instances.get(sessionId);
  }

  getAllInstances(): Map<string, ClaudeInstance> {
    return this.instances;
  }

  getMetrics() {
    const instances = Array.from(this.instances.values());
    return {
      total: instances.length,
      idle: instances.filter(i => i.getState() === InstanceState.IDLE).length,
      busy: instances.filter(i => i.getState() === InstanceState.BUSY).length
    };
  }

  private startCleaner(): void {
    this.cleanerTimer = setInterval(() => {
      for (const [sessionId, instance] of this.instances) {
        if (instance.getIdleTime() > this.config.idleTimeout) {
          this.stopInstance(sessionId);
        }
      }
    }, 60000);
  }

  async shutdown(): Promise<void> {
    if (this.cleanerTimer) {
      clearInterval(this.cleanerTimer);
      this.cleanerTimer = undefined;
    }
    for (const sessionId of this.instances.keys()) {
      await this.stopInstance(sessionId);
    }
  }
}
