import type { EventBus, GatewayEvent } from '../../core/event-bus.js';
import { logger } from '../../utils/logger.js';
import type {
  TriggerDefinition,
  TriggerEventFilter,
  TriggerMatchValue,
  TriggerSourceEvent,
} from '../types.js';

export type TriggerEventUnsubscribe = () => void;

export class TriggerEventSource {
  private subscriptions = new Map<string, TriggerEventUnsubscribe>();

  constructor(
    private eventBus: EventBus,
    private fire: (triggerId: string, event: TriggerSourceEvent) => void,
  ) {}

  register(trigger: TriggerDefinition): TriggerEventUnsubscribe {
    if (trigger.source.type !== 'event') return () => {};

    this.unregister(trigger.id);
    const { eventPattern, filter } = trigger.source;
    const handler = (event: GatewayEvent) => {
      try {
        if (!this.matchPattern(event.type, eventPattern)) return;
        if (event.type.startsWith('trigger:') && (event as any).originTriggerId === trigger.id) return;
        if (filter && !this.matchFilter(event, filter)) return;

        this.fire(trigger.id, {
          sourceType: 'event',
          eventName: event.type,
          firedAt: Date.now(),
          payload: event as unknown as Record<string, unknown>,
        });
      } catch (err) {
        logger.warn(`[TriggerEventSource] handler failed for ${trigger.id}: ${err}`);
      }
    };

    this.eventBus.subscribeAll(handler);
    const unsubscribe = () => this.eventBus.unsubscribe('*', handler);
    this.subscriptions.set(trigger.id, unsubscribe);
    return unsubscribe;
  }

  unregister(triggerId: string): void {
    const unsubscribe = this.subscriptions.get(triggerId);
    if (!unsubscribe) return;
    unsubscribe();
    this.subscriptions.delete(triggerId);
  }

  has(triggerId: string): boolean {
    return this.subscriptions.has(triggerId);
  }

  stop(): void {
    for (const triggerId of [...this.subscriptions.keys()]) {
      this.unregister(triggerId);
    }
  }

  private matchPattern(eventType: string, pattern: string): boolean {
    if (pattern === '*' || pattern === eventType) return true;
    if (pattern.endsWith(':*')) return eventType.startsWith(pattern.slice(0, -1));
    return false;
  }

  private matchFilter(event: GatewayEvent, filter: TriggerEventFilter): boolean {
    if (!filter.match) return true;
    for (const [path, expected] of Object.entries(filter.match)) {
      if (!this.matchValue(this.getByPath(event, path), expected)) return false;
    }
    return true;
  }

  private matchValue(actual: unknown, expected: TriggerMatchValue): boolean {
    if (typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean') {
      return actual === expected;
    }

    if ('$exists' in expected) {
      const exists = actual !== undefined;
      if (exists !== expected.$exists) return false;
    }
    if ('$in' in expected && !expected.$in.includes(actual)) return false;
    if ('$regex' in expected && !new RegExp(expected.$regex).test(String(actual ?? ''))) return false;
    if ('$gt' in expected && !(typeof actual === 'number' && actual > expected.$gt!)) return false;
    if ('$gte' in expected && !(typeof actual === 'number' && actual >= expected.$gte!)) return false;
    if ('$lt' in expected && !(typeof actual === 'number' && actual < expected.$lt!)) return false;
    if ('$lte' in expected && !(typeof actual === 'number' && actual <= expected.$lte!)) return false;
    return true;
  }

  private getByPath(obj: unknown, path: string): unknown {
    let cur: any = obj;
    for (const part of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }
}
