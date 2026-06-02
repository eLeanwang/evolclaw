import { CronExpressionParser } from 'cron-parser';
import { logger as baseLogger } from '../../utils/logger.js';
import type { Trigger, Message } from '../../types.js';
import type { EventBus } from '../event-bus.js';
import type { TriggerManager } from './manager.js';

const logger = {
  info: (msg: string) => baseLogger.info(msg),
  warn: (msg: string) => baseLogger.warn(msg),
  debug: (msg: string) => baseLogger.debug(msg),
};

export type FireCallback = (message: Message, trigger: Trigger) => void;

// Min-heap ordered by nextFireAt
class TriggerHeap {
  private heap: Trigger[] = [];

  push(t: Trigger): void {
    this.heap.push(t);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): Trigger | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): Trigger | undefined {
    return this.heap[0];
  }

  remove(id: string): boolean {
    const idx = this.heap.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const last = this.heap.pop()!;
    if (idx < this.heap.length) {
      this.heap[idx] = last;
      this.bubbleUp(idx);
      this.sinkDown(idx);
    }
    return true;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].nextFireAt <= this.heap[i].nextFireAt) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.heap[l].nextFireAt < this.heap[smallest].nextFireAt) smallest = l;
      if (r < n && this.heap[r].nextFireAt < this.heap[smallest].nextFireAt) smallest = r;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }

  get size(): number { return this.heap.length; }
}

/**
 * Calculate the next fire timestamp for a trigger.
 *
 * For `delay` type: `now` is the reference point — returns `now + delayMs`.
 *   Pass `Date.now()` at registration time to get the original fire time.
 *   Do NOT pass a stored `nextFireAt` as `now` — that would double-add the delay.
 * For `at` type: `now` is ignored; returns the absolute ISO timestamp.
 * For `cron` type: returns the next occurrence after `now`.
 */
export function calcNextFireAt(scheduleType: string, scheduleValue: string, now = Date.now()): number {
  if (scheduleType === 'delay') {
    return now + parseInt(scheduleValue);
  }
  if (scheduleType === 'at') {
    return new Date(scheduleValue).getTime();
  }
  // cron
  const interval = CronExpressionParser.parse(scheduleValue, { currentDate: new Date(now) });
  return interval.next().getTime();
}

export class TriggerScheduler {
  private heap = new TriggerHeap();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflightCron = new Set<string>(); // trigger IDs currently executing (cron)
  private fireCallback?: FireCallback;

  constructor(
    private aid: string,
    private manager: TriggerManager,
    private eventBus: EventBus,
  ) {}

  setFireCallback(cb: FireCallback): void {
    this.fireCallback = cb;
  }

  async init(): Promise<void> {
    const triggers = this.manager.load();
    const now = Date.now();

    for (const t of triggers) {
      if (t.scheduleType === 'cron') {
        // Recalculate next fire from now (don't backfill missed cron runs)
        const next = calcNextFireAt('cron', t.scheduleValue, now);
        if (next !== t.nextFireAt) {
          this.manager.updateNextFireAt(t.id, next);
          t.nextFireAt = next;
        }
        this.heap.push(t);
      } else {
        // delay/at: if missed, fire immediately (backfill)
        if (t.nextFireAt < now) {
          logger.info(`[${this.aid}] Backfilling missed trigger: ${t.name} (${t.id})`);
          this.heap.push({ ...t, nextFireAt: now });
        } else {
          this.heap.push(t);
        }
      }
    }

    this.resetTimer();
    logger.info(`[${this.aid}] Scheduler initialized with ${triggers.length} trigger(s)`);
  }

  register(trigger: Trigger): void {
    this.heap.push(trigger);
    this.resetTimer();
    this.eventBus.publish({ type: 'trigger:registered', triggerId: trigger.id, name: trigger.name, peerId: trigger.createdByPeerId });
  }

  cancel(id: string): void {
    this.heap.remove(id);
    this.inflightCron.delete(id);
    this.resetTimer();
  }

  update(trigger: Trigger): void {
    this.heap.remove(trigger.id);
    this.heap.push(trigger);
    this.resetTimer();
    this.eventBus.publish({ type: 'trigger:updated', triggerId: trigger.id, name: trigger.name, peerId: trigger.createdByPeerId });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inflightCron.clear();
  }

  private resetTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const top = this.heap.peek();
    if (!top) return;
    const delay = Math.max(0, top.nextFireAt - Date.now());
    this.timer = setTimeout(() => this.onFire(), delay).unref();
  }

  private onFire(): void {
    this.timer = null;
    const now = Date.now();

    // Fire all triggers that are due
    while (this.heap.peek() && this.heap.peek()!.nextFireAt <= now + 50) {
      const trigger = this.heap.pop()!;

      if (trigger.scheduleType === 'cron' && this.inflightCron.has(trigger.id)) {
        // Previous run still in flight — skip
        logger.warn(`[${this.aid}] Cron trigger ${trigger.name} still running, skipping`);
        this.eventBus.publish({ type: 'trigger:skipped', triggerId: trigger.id, reason: 'overlap' });
        // Re-schedule next cron occurrence
        const next = calcNextFireAt('cron', trigger.scheduleValue, now);
        this.manager.updateNextFireAt(trigger.id, next);
        this.heap.push({ ...trigger, nextFireAt: next });
        continue;
      }

      this.fireTrigger(trigger, now);
    }

    this.resetTimer();
  }

  private fireTrigger(trigger: Trigger, now: number): void {
    const messageId = `trigger:${trigger.id}:${now}`;
    const msg = this.buildSyntheticMessage(trigger, messageId);

    logger.info(`[${this.aid}] Firing trigger: ${trigger.name} (${trigger.id})`);

    // Update stats before moving to done so history captures the updated count
    this.manager.updateFireStats(trigger.id, now);

    if (trigger.scheduleType === 'cron') {
      this.inflightCron.add(trigger.id);
      // Re-schedule next occurrence
      const next = calcNextFireAt('cron', trigger.scheduleValue, now);
      this.manager.updateNextFireAt(trigger.id, next);
      this.heap.push({ ...trigger, nextFireAt: next });
    } else {
      // delay/at: one-shot, move to done
      this.manager.moveToDone(trigger.id, 'fired');
    }

    this.eventBus.publish({ type: 'trigger:fired', triggerId: trigger.id, name: trigger.name, fireTime: now });

    if (this.fireCallback) {
      this.fireCallback(msg, trigger);
    }
  }

  // Called by MessageProcessor when a trigger message completes/fails/is interrupted
  onTriggerComplete(triggerId: string, _outcome: 'completed' | 'failed' | 'interrupted'): void {
    // Only clear inflight state — message-processor already published the relevant events
    this.inflightCron.delete(triggerId);
  }

  private buildSyntheticMessage(trigger: Trigger, messageId: string): Message {
    const base: Message = {
      channel: trigger.targetChannel,
      channelType: trigger.targetChannelType,
      channelId: trigger.targetChannelId,
      selfAID: this.aid,
      threadId: '',
      agentId: trigger.agentId,
      chatType: 'private',
      peerId: `__trigger__:${trigger.id}`,  // unique per trigger to prevent greedy merge
      content: trigger.prompt,
      messageId,
      timestamp: Date.now(),
      source: 'trigger',
    };

    if (trigger.targetSessionStrategy === 'current') {
      base.triggerMeta = { triggerId: trigger.id, boundSessionId: trigger.boundSessionId };
    } else if (trigger.targetSessionStrategy === 'thread') {
      if (trigger.threadKind === 'feishu' && trigger.pendingThread) {
        base.triggerMeta = { triggerId: trigger.id, pendingThread: true, rootMessageId: trigger.rootMessageId };
        // threadId intentionally empty — first fire builds the thread via reply_in_thread
      } else {
        base.threadId = trigger.targetThreadId ?? '';
        base.triggerMeta = { triggerId: trigger.id };
      }
    } else {
      // latest
      base.triggerMeta = { triggerId: trigger.id };
    }

    return base;
  }
}
