/**
 * Channel Plugin System
 *
 * Provides a lightweight plugin interface for channel integration.
 * Plugins are responsible for creating channel instances only.
 * The main service (index.ts) handles registration and message flow wiring.
 */

import type { ChannelAdapter, ChannelPolicy, ChannelOptions } from '../types.js';
import type { Config } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Channel instance returned by plugin
 */
export interface ChannelInstance {
  /** Channel type (e.g., 'feishu', 'wechat', 'aun') — used for message bridge wiring */
  channelType?: string;

  /** Channel adapter for message sending */
  adapter: ChannelAdapter;

  /** Actual channel object (for lifecycle management) */
  channel: any;

  /** Optional permission policy */
  policy?: ChannelPolicy;

  /** Optional channel options */
  options?: ChannelOptions;

  /** Connect to the channel */
  connect(): Promise<void>;

  /** Disconnect from the channel */
  disconnect(): Promise<void>;

  /** Optional callback for project path requests */
  onProjectPathRequest?: (channelId: string) => Promise<string>;
}

/**
 * Channel plugin interface
 *
 * Plugins implement this interface to provide channel integration.
 * They are responsible for creating channel instances only.
 */
export interface ChannelPlugin {
  /** Channel name (e.g., 'feishu', 'wechat', 'aun') */
  readonly name: string;

  /** Check if channel is enabled in config */
  isEnabled(config: Config): boolean;

  /** Create channel instance */
  createChannel(config: Config): Promise<ChannelInstance>;

  /** Optional: create multiple instances from array config */
  createChannels?(config: Config): Promise<ChannelInstance[]>;
}

/**
 * Channel Loader
 *
 * Manages channel plugin registration and lifecycle.
 */
export class ChannelLoader {
  private plugins = new Map<string, ChannelPlugin>();

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Channel plugin '${plugin.name}' already registered`);
    }
    this.plugins.set(plugin.name, plugin);
    logger.debug(`Registered channel plugin: ${plugin.name}`);
  }

  async createAll(config: Config): Promise<ChannelInstance[]> {
    const instances: ChannelInstance[] = [];

    for (const [name, plugin] of this.plugins) {
      if (!plugin.isEnabled(config)) {
        logger.info(`Channel '${name}' is disabled, skipping`);
        continue;
      }

      try {
        if (plugin.createChannels) {
          const channelInstances = await plugin.createChannels(config);
          instances.push(...channelInstances);
          logger.info(`✓ Channel '${name}' created ${channelInstances.length} instance(s)`);
        } else {
          const instance = await plugin.createChannel(config);
          instances.push(instance);
          logger.info(`✓ Channel '${name}' instance created`);
        }
      } catch (error) {
        logger.error(`✗ Failed to create channel '${name}':`, error);
      }
    }

    return instances;
  }

  async connectAll(instances: ChannelInstance[]): Promise<string[]> {
    const results = await Promise.allSettled(
      instances.map(async (inst) => {
        await inst.connect();
        return inst.adapter.name;
      })
    );

    const connected = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<string>).value);

    const failed = results
      .filter((r) => r.status === 'rejected')
      .map((r) => (r as PromiseRejectedResult).reason);

    if (failed.length > 0) {
      logger.warn(`Some channels failed to connect:`, failed);
    }

    return connected;
  }

  async disconnectAll(instances: ChannelInstance[]): Promise<void> {
    await Promise.allSettled(
      instances.map((inst) => inst.disconnect())
    );
  }
}
