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
      // agent 顶层 owners[0] 透传给 AUN channel.owner（用于首次连接发欢迎消息）
      owner: agent.config.owners?.[0],
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

  async connectAll(instances: ChannelInstance[], { concurrency = 3, intervalMs = 50 } = {}): Promise<string[]> {
    const connected: string[] = [];
    const failed: { name: string; error: any }[] = [];
    const inflight = new Set<Promise<void>>();

    for (const inst of instances) {
      // 等待并发数降到 concurrency 以下
      while (inflight.size >= concurrency) {
        await Promise.race(inflight);
      }

      const task = (async () => {
        try {
          await inst.connect();
          connected.push(inst.adapter.channelName);
        } catch (e) {
          failed.push({ name: inst.adapter.channelName, error: e });
          logger.warn(`[connectAll] ${inst.adapter.channelName} connect failed: ${e}`);
        }
      })();

      const tracked = task.then(() => { inflight.delete(tracked); });
      inflight.add(tracked);

      // 间隔发起，避免瞬间并发冲击网关
      if (intervalMs > 0) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    // 等待所有剩余任务完成
    await Promise.allSettled(inflight);

    if (failed.length > 0) {
      logger.warn(`[connectAll] ${failed.length} channel(s) failed initial connect (will retry in background): ${failed.map(f => f.name).join(', ')}`);
    }

    return connected;
  }

  async disconnectAll(instances: ChannelInstance[]): Promise<void> {
    await Promise.allSettled(
      instances.map((inst) => inst.disconnect())
    );
  }
}

// ── Channel Key ────────────────────────────────────────────────────────────
// 编码格式：`<aid>#<type>#<name>`
// `#` 不在 AID 合法字符集内，天然无歧义切分。

export interface ChannelKey {
  aid: string;
  type: string;
  name: string;
}

const SEP = '#';

export function formatChannelKey(k: ChannelKey): string {
  return `${k.aid}${SEP}${k.type}${SEP}${k.name}`;
}

export function parseChannelKey(key: string): ChannelKey {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new Error(`Invalid channel key (expected 3 segments separated by '#'): ${key}`);
  }
  const [aid, type, name] = parts;
  if (!aid || !type || !name) {
    throw new Error(`Invalid channel key (empty segment): ${key}`);
  }
  return { aid, type, name };
}

export function tryParseChannelKey(key: string): ChannelKey | null {
  try { return parseChannelKey(key); } catch { return null; }
}

export function isValidChannelName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.includes(SEP);
}

// ── Reload Hooks ───────────────────────────────────────────────────────────
// Builds the ReloadHooks implementation used by EvolAgentRegistry.reload()
// to drain/disconnect/start channels during a hot reload.

import type { ReloadHooks } from './evolagent-registry.js';

export interface ReloadHooksDeps {
  channelLoader: ChannelLoader;
  channelInstances: ChannelInstance[];
  registerChannelInstance: (inst: ChannelInstance) => void;
  messageQueue?: { isChannelProcessing(channelName: string): boolean };
  drainDelayMs?: number;
  drainTimeoutMs?: number;
}

export function buildReloadHooks(deps: ReloadHooksDeps): ReloadHooks {
  const { channelLoader, channelInstances, registerChannelInstance, messageQueue } = deps;
  const drainDelayMs = deps.drainDelayMs ?? 500;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 30000;

  return {
    async drainChannel(channelName: string): Promise<void> {
      logger.info(`[Reload] Draining channel: ${channelName}`);
      if (messageQueue) {
        const pollMs = 100;
        const start = Date.now();
        while (messageQueue.isChannelProcessing(channelName)) {
          if (Date.now() - start > drainTimeoutMs) {
            logger.warn(`[Reload] Drain timeout (${drainTimeoutMs}ms) for channel: ${channelName}, proceeding anyway`);
            return;
          }
          await new Promise(r => setTimeout(r, pollMs));
        }
        logger.info(`[Reload] Drain complete: ${channelName}`);
      } else if (drainDelayMs > 0) {
        await new Promise(r => setTimeout(r, drainDelayMs));
      }
    },

    async disconnectChannel(channelName: string): Promise<void> {
      const inst = channelInstances.find(i => i.adapter.channelName === channelName);
      if (!inst) {
        logger.warn(`[Reload] Channel ${channelName} not found, skipping disconnect`);
        return;
      }
      try {
        await inst.disconnect();
        const idx = channelInstances.indexOf(inst);
        if (idx >= 0) channelInstances.splice(idx, 1);
        logger.info(`[Reload] Disconnected channel: ${channelName}`);
      } catch (e) {
        logger.error(`[Reload] Failed to disconnect ${channelName}: ${e}`);
        throw e;
      }
    },

    async startChannel(agent: any, channelName: string): Promise<void> {
      const channels = agent.config.channels;
      let channelType: string | null = null;
      for (const [type, raw] of Object.entries(channels)) {
        const instances = Array.isArray(raw) ? raw : [raw];
        for (const inst of instances) {
          const name = (inst as any).name ?? type;
          if (name === channelName) { channelType = type; break; }
        }
        if (channelType) break;
      }
      if (!channelType) {
        const msg = `[Reload] Channel ${channelName} not found in agent ${agent.name} config`;
        logger.error(msg);
        throw new Error(msg);
      }
      const partialConfig: any = {
        agents: agent.config.agents,
        channels: { [channelType]: channels[channelType] },
        projects: agent.config.projects,
      };
      const newInstances = await channelLoader.createAll(partialConfig);
      const newInst = newInstances.find(i => i.adapter.channelName === channelName);
      if (!newInst) throw new Error(`[Reload] Failed to create instance ${channelName}`);
      registerChannelInstance(newInst);
      await newInst.connect();
      channelInstances.push(newInst);
      logger.info(`[Reload] Started channel: ${channelName}`);
    },
  };
}
