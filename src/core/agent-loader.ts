/**
 * Agent Plugin System
 *
 * Per-EvolAgent runner instantiation: each (EvolAgent × baseagent) gets its
 * own runner so that runtime state (model/effort/permissionMode/credentials)
 * is fully isolated.
 */

import type { Config } from '../types.js';
import type { EvolAgent } from './evolagent.js';
import type { EvolAgentRegistry } from './evolagent-registry.js';
import { logger } from '../utils/logger.js';

/** Agent callbacks for session management */
export interface AgentCallbacks {
  onSessionIdUpdate: (sessionId: string, agentSessionId: string) => Promise<void>;
}

/** Single runner instance returned by a plugin. */
export interface AgentInstance {
  /** EvolAgent name (e.g. 'review' or '[default]') that owns this runner. */
  evolagentName: string;
  /** Baseagent type (e.g. 'claude', 'codex', 'gemini'). */
  baseagent: string;
  /** Actual runner object (AgentRunnerFull-shaped). */
  agent: any;
}

/** Plugin interface — one plugin per baseagent type. */
export interface AgentPlugin {
  /** Baseagent name (e.g., 'claude'). Matches `agent.config.agents.<name>`. */
  readonly name: string;

  /**
   * Whether this plugin should produce a runner for `agent`.
   * Plugins must return false when the EvolAgent doesn't declare this baseagent.
   */
  isEnabled(globalConfig: Config, agent: EvolAgent): boolean;

  /**
   * Create a runner for `agent`. Returns null if creation should be skipped
   * (e.g. missing required credentials after override resolution).
   */
  createAgent(globalConfig: Config, agent: EvolAgent, callbacks: AgentCallbacks): AgentInstance | null;
}

/** Agent Loader — produces one runner per (EvolAgent × baseagent). */
export class AgentLoader {
  private plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Agent plugin '${plugin.name}' already registered`);
    }
    this.plugins.set(plugin.name, plugin);
    logger.debug(`Registered agent plugin: ${plugin.name}`);
  }

  /**
   * Iterate over all EvolAgents (DefaultAgent + each named agent in registry)
   * × all registered plugins. Each successful (agent, plugin) pair yields one
   * runner instance.
   */
  createAll(globalConfig: Config, registry: EvolAgentRegistry, callbacks: AgentCallbacks): AgentInstance[] {
    const instances: AgentInstance[] = [];

    const allAgents: EvolAgent[] = [];
    const def = registry.get('[default]');
    if (def) allAgents.push(def);
    for (const a of registry.runnableAgents()) allAgents.push(a);

    for (const agent of allAgents) {
      for (const [pluginName, plugin] of this.plugins) {
        if (!plugin.isEnabled(globalConfig, agent)) {
          logger.debug(`Plugin '${pluginName}' disabled for agent '${agent.name}', skipping`);
          continue;
        }

        try {
          const instance = plugin.createAgent(globalConfig, agent, callbacks);
          if (!instance) {
            logger.debug(`Plugin '${pluginName}' returned null for agent '${agent.name}', skipping`);
            continue;
          }
          instances.push(instance);
          logger.info(`✓ Runner created: agent=${instance.evolagentName} baseagent=${instance.baseagent}`);
        } catch (error) {
          logger.error(`✗ Failed to create runner for agent='${agent.name}' baseagent='${pluginName}':`, error);
        }
      }
    }

    return instances;
  }
}
