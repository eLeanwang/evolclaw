import { CONFIG_SCHEMA_VERSION } from '../types.js';
import type { AgentConfig, AgentLifecycle } from '../types.js';

const VALID_LIFECYCLES = new Set<AgentLifecycle>(['created', 'bootstrapping', 'active']);

export function normalizeAgentLifecycle<T extends Partial<AgentConfig>>(config: T): T & { lifecycle: AgentLifecycle } {
  const current = config.lifecycle;
  if (current && VALID_LIFECYCLES.has(current)) {
    return config as T & { lifecycle: AgentLifecycle };
  }

  const lifecycle: AgentLifecycle =
    config.initialized === true ? 'active'
      : config.initialized === false ? 'created'
        : 'active';

  return { ...config, lifecycle };
}

export function withLifecycleForWrite<T extends Partial<AgentConfig>>(config: T, lifecycle: AgentLifecycle): T & { lifecycle: AgentLifecycle } {
  const next: any = { ...config, $schema_version: CONFIG_SCHEMA_VERSION, lifecycle };
  delete next.initialized;
  return next;
}
