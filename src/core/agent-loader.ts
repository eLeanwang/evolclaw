/**
 * Agent Plugin System
 *
 * Provides a lightweight plugin interface for agent integration.
 */

import type { Config } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Agent callbacks for session management
 */
export interface AgentCallbacks {
  onSessionIdUpdate: (sessionId: string, agentSessionId: string) => Promise<void>;
}

/**
 * Agent instance returned by plugin
 */
export interface AgentInstance {
  /** Actual agent object */
  agent: any;
}

/**
 * Agent plugin interface
 */
export interface AgentPlugin {
  /** Agent name (e.g., 'claude') */
  readonly name: string;

  /** Check if agent is enabled in config */
  isEnabled(config: Config): boolean;

  /** Create agent instance */
  createAgent(config: Config, callbacks: AgentCallbacks): AgentInstance;
}

/**
 * Agent Loader
 *
 * Manages agent plugin registration and creation.
 */
export class AgentLoader {
  private plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Agent plugin '${plugin.name}' already registered`);
    }
    this.plugins.set(plugin.name, plugin);
    logger.debug(`Registered agent plugin: ${plugin.name}`);
  }

  createAll(config: Config, callbacks: AgentCallbacks): AgentInstance[] {
    const instances: AgentInstance[] = [];

    for (const [name, plugin] of this.plugins) {
      if (!plugin.isEnabled(config)) {
        logger.info(`Agent '${name}' is disabled, skipping`);
        continue;
      }

      try {
        const instance = plugin.createAgent(config, callbacks);
        instances.push(instance);
        logger.info(`✓ Agent '${name}' instance created`);
      } catch (error) {
        logger.error(`✗ Failed to create agent '${name}':`, error);
      }
    }

    return instances;
  }
}
