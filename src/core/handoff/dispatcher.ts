import { logger } from '../../utils/logger.js';
import { HandoffStore } from './store.js';
import { KeyedFairMutex } from './mutex.js';
import type { HandoffInstance } from './types.js';

export interface HandoffTargetSendResult {
  ok: boolean;
  message_id?: string;
  error?: string;
}

export type HandoffTargetSender = (instance: HandoffInstance) => Promise<HandoffTargetSendResult>;

export interface HandoffDispatcherOptions {
  maxAttempts?: number;
  retryDelaysMs?: number[];
}

export class HandoffDispatcher {
  private running = new Set<string>();
  private pausedAgents = new Set<string>();
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];

  constructor(
    private store: HandoffStore,
    private mutexes: KeyedFairMutex,
    private sender: HandoffTargetSender,
    options: HandoffDispatcherOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 1000];
  }

  notify(selfAid: string, targetSessionId: string): void {
    if (this.pausedAgents.has(selfAid)) return;
    const key = this.key(selfAid, targetSessionId);
    if (this.running.has(key)) return;
    this.running.add(key);
    void this.run(selfAid, targetSessionId).finally(() => this.running.delete(key));
  }

  pauseAgent(selfAid: string): void {
    this.pausedAgents.add(selfAid);
  }

  async drainAgent(selfAid: string, timeoutMs = 30000): Promise<void> {
    this.pauseAgent(selfAid);
    const startedAt = Date.now();
    while (this.isAgentRunning(selfAid)) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Handoff drain timeout (${timeoutMs}ms) for agent: ${selfAid}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  resumeAgent(selfAid: string): void {
    this.pausedAgents.delete(selfAid);
    const targets = new Set(
      this.store.list(selfAid)
        .filter(instance => instance.state === 'queued' && !instance.attention_required)
        .map(instance => instance.target_session_id),
    );
    for (const targetSessionId of targets) this.notify(selfAid, targetSessionId);
  }

  isAgentPaused(selfAid: string): boolean {
    return this.pausedAgents.has(selfAid);
  }

  async drain(selfAid: string, targetSessionId: string): Promise<void> {
    const key = this.key(selfAid, targetSessionId);
    if (this.running.has(key)) {
      while (this.running.has(key)) await new Promise(resolve => setTimeout(resolve, 5));
      return;
    }
    this.running.add(key);
    try {
      await this.run(selfAid, targetSessionId);
    } finally {
      this.running.delete(key);
    }
  }

  private async run(selfAid: string, targetSessionId: string): Promise<void> {
    while (true) {
      if (this.pausedAgents.has(selfAid)) return;
      const next = this.store.listByTarget(selfAid, targetSessionId, 'queued')[0];
      if (!next || next.attention_required) return;
      let sent = false;
      let blocked = false;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (this.pausedAgents.has(selfAid)) return;
        sent = await this.mutexes.forKey(this.key(selfAid, targetSessionId)).runExclusive(async () => {
          if (this.pausedAgents.has(selfAid)) return false;
          const current = this.store.get(selfAid, next.handoff_id);
          if (!current || current.state !== 'queued' || current.attention_required) return current?.state === 'target_sent';
          this.store.recordSendStarted(selfAid, current.handoff_id);
          try {
            const result = await this.sender(current);
            if (!result.ok) {
              this.store.recordSendFailed(selfAid, current.handoff_id, result.error || 'target send failed');
              return false;
            }
            if (!result.message_id) {
              blocked = true;
              this.store.markAttention(selfAid, current.handoff_id, 'TARGET_SEND_OUTCOME_UNKNOWN');
              return false;
            }
            try {
              this.store.recordSendSucceeded(selfAid, current.handoff_id, result.message_id);
            } catch (error) {
              blocked = true;
              try {
                this.store.markAttention(selfAid, current.handoff_id, 'STORE_CONFLICT');
              } catch {}
              logger.error(`[Handoff] failed to persist successful target send: ${current.handoff_id}`, error);
              return false;
            }
            return true;
          } catch (error) {
            this.store.recordSendFailed(selfAid, current.handoff_id, error instanceof Error ? error.message : String(error));
            return false;
          }
        });
        if (this.pausedAgents.has(selfAid)) return;
        if (sent) break;
        if (blocked) return;
        if (attempt < this.maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 0));
        }
      }
      if (!sent) {
        this.store.markAttention(selfAid, next.handoff_id, 'TARGET_SEND_RETRIES_EXHAUSTED');
        logger.error(`[Handoff] target send retries exhausted: ${next.handoff_id}`);
        return;
      }
      await Promise.resolve();
    }
  }

  private key(selfAid: string, targetSessionId: string): string {
    return `${selfAid}\u0000${targetSessionId}`;
  }

  private isAgentRunning(selfAid: string): boolean {
    const prefix = `${selfAid}\u0000`;
    for (const key of this.running) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
}
