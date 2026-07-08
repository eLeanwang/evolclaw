export * from '../../trigger/manager.js';

import { TriggerDefinitionManager } from '../../trigger/manager.js';
import type { TriggerDefinition } from '../../trigger/types.js';

export class TriggerManager extends TriggerDefinitionManager {
  getByName(nameOrId: string): (TriggerDefinition & {
    prompt?: string;
    targetSessionStrategy?: string;
    nextFireAt?: number;
  }) | undefined {
    const definition = this.list().find(item => item.name === nameOrId || item.id === nameOrId);
    if (!definition) return undefined;
    return {
      ...definition,
      prompt: definition.execution.type === 'script' ? undefined : definition.execution.prompt,
      targetSessionStrategy: definition.feedback.target?.session ?? 'main',
      nextFireAt: definition.source.type === 'once'
        ? Date.now()
        : definition.source.type === 'delay'
        ? definition.createdAt + definition.source.afterMs
        : definition.source.type === 'at'
          ? new Date(definition.source.at).getTime()
          : undefined,
    };
  }
}
