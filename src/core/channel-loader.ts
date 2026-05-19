/**
 * Channel Plugin System
 *
 * Provides a lightweight plugin interface for channel integration.
 * Plugins are responsible for creating channel instances only.
 * The main service (index.ts) handles registration and message flow wiring.
 */

import type { ChannelAdapter, ChannelPolicy, ChannelOptions } from '../types.js';
import type { Config } from '../types.js';
import type { EvolAgent } from './evolagent.js';
import type { MessageBridge } from './message/message-bridge.js';
import type { EventBus } from './event-bus.js';
import type { SessionManager } from './session/session-manager.js';
import { logger } from '../utils/logger.js';

export interface BridgeHookContext {
  eventBus: EventBus;
  sessionManager: SessionManager;
}

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

  /** Register inbound message mapping + outbound reply callback with MessageBridge. */
  registerBridge?(bridge: MessageBridge, channelType: string): void;

  /** Register lifecycle hooks (eventBus injection, channelDown, etc.). Separate from message mapping. */
  registerHooks?(ctx: BridgeHookContext): void;
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

  /**
   * 新结构入口：从 EvolAgent 的 channels[] 列表创建 channel 实例。
   *
   * 内部把 ChannelInstance[] 翻成各 plugin 期望的 dict 形态（`{ type: [instances...] }`），
   * 然后调用现有 plugin.createChannels / createChannel。
   *
   * 当所有 channel plugin 重写为直接吃 ChannelInstance[] 后，本方法可简化。
   */
  async createForAgent(agent: EvolAgent): Promise<ChannelInstance[]> {
    const rewrittenChannels: Record<string, any[]> = {};

    // AUN channel 从 agent.aid 隐式创建——不需要在 channels[] 里显式声明
    const aunEffName = agent.effectiveChannelName('aun', 'main');
    rewrittenChannels['aun'] = [{
      type: 'aun',
      name: aunEffName,
      aid: agent.aid,
      enabled: true,
      agentName: agent.aid,
    }];

    // 其它 channels（非 AUN）从 config.channels[] 取
    for (const inst of agent.config.channels) {
      if (inst.type === 'aun') continue; // 跳过显式声明的 AUN（已隐式处理）
      const effName = agent.effectiveChannelName(inst.type, inst.name);
      const rewritten: any = { ...inst, name: effName, agentName: agent.aid };
      (rewrittenChannels[inst.type] ??= []).push(rewritten);
    }

    // syntheticConfig 是老 Config schema（channel plugin 沿用旧接口），
    // 新 schema 字段命名为 snake_case，这里转 camelCase 透传。
    const syntheticConfig = {
      agents: agent.config.baseagents,
      channels: rewrittenChannels,
      projects: agent.config.projects,
      chatmode: agent.config.chatmode,
      debug: agent.config.debug,
      showActivities: agent.config.show_activities,
      flushDelay: agent.config.flush_delay,
      debounce: agent.config.debounce,
      enableRichContent: agent.config.enable_rich_content,
    } as any as Config;

    return this.createAll(syntheticConfig);
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

  async connectAll(instances: ChannelInstance[], delayMs = 150): Promise<string[]> {
    const connected: string[] = [];
    const failed: any[] = [];

    for (const inst of instances) {
      try {
        await inst.connect();
        connected.push(inst.adapter.channelName);
      } catch (e) {
        failed.push(e);
      }
      if (delayMs > 0 && inst !== instances[instances.length - 1]) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

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
