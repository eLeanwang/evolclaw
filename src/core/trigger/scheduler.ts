export * from '../../trigger/scheduler.js';

import type { EventBus } from '../event-bus.js';
import type { TriggerManager } from './manager.js';
import type {
  TriggerActiveRun,
  TriggerDefinition,
  TriggerScheduleState,
  TriggerSubscriptionInfo,
} from '../../trigger/types.js';
import type { TriggerRunStats } from '../../trigger/audit.js';

export class TriggerScheduler {
  constructor(
    readonly agentAid: string,
    private manager: TriggerManager,
    _eventBus?: EventBus,
  ) {}

  list(opts: { all?: boolean } = {}): TriggerDefinition[] {
    return this.manager.list(opts);
  }

  show(triggerId: string): {
    definition: TriggerDefinition;
    active: TriggerActiveRun[];
    schedule?: TriggerScheduleState;
    limitState?: undefined;
    recentRuns: [];
    subscription: TriggerSubscriptionInfo;
  } {
    const definition = this.manager.require(triggerId);
    const nextFireAt = definition.source.type === 'once'
      ? Date.now()
      : definition.source.type === 'delay'
        ? definition.createdAt + definition.source.afterMs
        : definition.source.type === 'at'
          ? new Date(definition.source.at).getTime()
          : undefined;
    return {
      definition,
      active: [],
      schedule: nextFireAt === undefined ? undefined : { nextFireAt, updatedAt: Date.now(), sourceSignature: JSON.stringify(definition.source) },
      recentRuns: [],
      subscription: { status: 'not-event' },
    };
  }

  stats(_triggerId: string): TriggerRunStats {
    return { fireCount: 0, failCount: 0 };
  }

  create(input: unknown, files: any[] = [], opts: { enable?: boolean } = {}): TriggerDefinition {
    return this.manager.create(input, files, opts);
  }

  update(triggerId: string, input: unknown, files: any[] = []): TriggerDefinition {
    return this.manager.update(triggerId, input, files);
  }

  cancel(triggerId: string): TriggerDefinition {
    return this.manager.cancel(triggerId);
  }

  setEnabled(triggerId: string, enabled: boolean): TriggerDefinition {
    return this.manager.setEnabled(triggerId, enabled);
  }

  delete(triggerId: string): TriggerDefinition {
    return this.manager.delete(triggerId);
  }

  async run(triggerId: string, _opts: { dryRun?: boolean } = {}): Promise<{ runId: string; status: string; reason?: string }> {
    this.manager.require(triggerId);
    return { runId: `run-${Date.now()}`, status: 'queued' };
  }
}
