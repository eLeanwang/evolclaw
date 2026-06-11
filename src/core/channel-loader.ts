/**
 * Channel Plugin System
 *
 * Provides a lightweight plugin interface for channel integration.
 * Plugins are responsible for creating channel instances only.
 * The main service (index.ts) handles registration and message flow wiring.
 */

import type { ChannelAdapter, ChannelPolicy, ChannelOptions, DebugBlock } from '../types.js';
import type { ChannelInstance as ChannelInstanceConfig } from '../types.js';
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
 * Shared per-agent context passed to every plugin's createInstance.
 * Per-instance config (credentials, name, showActivities…) lives on the inst arg.
 */
export interface ChannelBuildContext {
  agentName: string;           // selfAID
  defaultProjectPath: string;
  enableRichContent?: boolean;
  debug?: DebugBlock;
}

/**
 * Runtime channel object returned by a plugin (adapter + lifecycle + wiring).
 * NOTE: naming collides with the *config* ChannelInstance union in types.ts —
 * pre-existing debt, tracked separately.
 */
export interface ChannelInstance {
  channelType?: string;
  adapter: ChannelAdapter;
  channel: any;
  policy?: ChannelPolicy;
  options?: ChannelOptions;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onProjectPathRequest?: (channelId: string) => Promise<string>;
  registerBridge?(bridge: MessageBridge, channelType: string): void;
  registerHooks?(ctx: BridgeHookContext): void;
}

/**
 * Channel plugin interface.
 * Build one runtime ChannelInstance from one config instance. Return null to skip.
 */
export interface ChannelPlugin {
  readonly name: string;
  createInstance(inst: ChannelInstanceConfig, ctx: ChannelBuildContext): Promise<ChannelInstance | null>;
}

// ── Shared helpers for plugins ─────────────────────────────────────────────

type ShowActivitiesMode = 'all' | 'dm-only' | 'owner-dm-only' | 'none';

/** Resolve showActivities for a single instance (instance overrides default). */
export function resolveShowActivities(inst: ChannelInstanceConfig): ShowActivitiesMode {
  return (inst as any).showActivities ?? 'all';
}

/** Standard showMiddleResult / showIdleMonitor policy function. */
export function showActivitiesPolicy(
  mode: ShowActivitiesMode,
  chatType: string,
  identity: string,
): boolean {
  if (mode === 'none') return false;
  if (mode === 'dm-only') return chatType === 'private';
  if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
  return true;
}

// ── ChannelLoader ──────────────────────────────────────────────────────────

export class ChannelLoader {
  private plugins = new Map<string, ChannelPlugin>();

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Channel plugin '${plugin.name}' already registered`);
    }
    this.plugins.set(plugin.name, plugin);
    logger.debug(`Registered channel plugin: ${plugin.name}`);
  }

  /** Look up a registered plugin by channel type (used by reload hooks). */
  getPlugin(type: string): ChannelPlugin | undefined {
    return this.plugins.get(type);
  }

  /**
   * Create all runtime channels for an agent directly from its config.channels[].
   * AUN is always created implicitly from agent.aid (no explicit entry required).
   */
  async createForAgent(agent: EvolAgent): Promise<ChannelInstance[]> {
    const ctx: ChannelBuildContext = {
      agentName: agent.aid,
      defaultProjectPath: agent.config.projects?.defaultPath ?? process.cwd(),
      enableRichContent: agent.config.enable_rich_content,
      debug: agent.config.debug,
    };

    // Build the full list of config instances to create.
    // AUN is synthesised from agent.aid; any explicit aun entry in channels[] is skipped.
    const aunEffName = agent.effectiveChannelName('aun', 'main');
    const aunInst: ChannelInstanceConfig = {
      type: 'aun',
      name: aunEffName,
      aid: agent.aid,
      enabled: true,
      owner: agent.config.owners?.[0],
    } as any;

    const configInsts: ChannelInstanceConfig[] = [aunInst];
    for (const inst of agent.config.channels) {
      if (inst.type === 'aun') continue;
      const effName = agent.effectiveChannelName(inst.type, inst.name);
      configInsts.push({ ...inst, name: effName } as ChannelInstanceConfig);
    }

    return this._buildInstances(configInsts, ctx);
  }

  /** Build runtime instances for a list of config instances + context. */
  private async _buildInstances(
    configInsts: ChannelInstanceConfig[],
    ctx: ChannelBuildContext,
  ): Promise<ChannelInstance[]> {
    const result: ChannelInstance[] = [];
    for (const inst of configInsts) {
      const plugin = this.plugins.get(inst.type);
      if (!plugin) {
        logger.debug(`No plugin for channel type '${inst.type}', skipping`);
        continue;
      }
      try {
        const runtime = await plugin.createInstance(inst, ctx);
        if (runtime) {
          result.push(runtime);
          logger.info(`✓ Channel '${inst.name}' (${inst.type}) created`);
        } else {
          logger.info(`Channel '${inst.name}' (${inst.type}) disabled or invalid credentials, skipping`);
        }
      } catch (err) {
        logger.error(`✗ Failed to create channel '${inst.name}' (${inst.type}):`, err);
      }
    }
    return result;
  }

  async connectAll(instances: ChannelInstance[], { concurrency = 3, intervalMs = 50 } = {}): Promise<string[]> {
    const connected: string[] = [];
    const failed: { name: string; error: any }[] = [];
    const inflight = new Set<Promise<void>>();

    for (const inst of instances) {
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

      if (intervalMs > 0) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    await Promise.allSettled(inflight);

    if (failed.length > 0) {
      logger.warn(`[connectAll] ${failed.length} channel(s) failed initial connect (will retry in background): ${failed.map(f => f.name).join(', ')}`);
    }

    return connected;
  }

  async disconnectAll(instances: ChannelInstance[]): Promise<void> {
    await Promise.allSettled(instances.map(inst => inst.disconnect()));
  }
}

// ── Channel Key ────────────────────────────────────────────────────────────

export interface ChannelKey {
  type: string;
  selfAID: string;
  name: string;
}

const SEP = '#';

export function formatChannelKey(k: ChannelKey): string {
  if (k.selfAID.includes(SEP)) {
    throw new Error(`Invalid selfAID (contains '#'): ${k.selfAID}`);
  }
  return `${k.type}${SEP}${k.selfAID}${SEP}${k.name}`;
}

export function parseChannelKey(key: string): ChannelKey {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new Error(`Invalid channel key (expected 3 segments separated by '#'): ${key}`);
  }
  const [type, selfAID, name] = parts;
  if (!type || !selfAID || !name) {
    throw new Error(`Invalid channel key (empty segment): ${key}`);
  }
  return { type, selfAID, name };
}

export function tryParseChannelKey(key: string): ChannelKey | null {
  try { return parseChannelKey(key); } catch { return null; }
}

export function isValidChannelName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.includes(SEP);
}

// ── Reload Hooks ───────────────────────────────────────────────────────────

import type { ReloadHooks } from './evolagent-registry.js';

export interface ReloadHooksDeps {
  channelLoader: ChannelLoader;
  channelInstances: ChannelInstance[];
  registerChannelInstance: (inst: ChannelInstance) => void;
  /** 注销渠道在 core 各 map 中的登记（processor/cmdHandler/bridge）。热重载断开渠道时调用。 */
  unregisterChannelInstance?: (channelName: string) => void;
  messageQueue?: { isChannelProcessing(channelName: string): boolean };
  drainDelayMs?: number;
  drainTimeoutMs?: number;
}

export function buildReloadHooks(deps: ReloadHooksDeps): ReloadHooks {
  const { channelLoader, channelInstances, registerChannelInstance, unregisterChannelInstance, messageQueue } = deps;
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
        // 从 core 各 map 注销，避免死实例残留在 /status「未归属渠道」、菜单路由和 adapter 查找里
        unregisterChannelInstance?.(channelName);
        logger.info(`[Reload] Disconnected channel: ${channelName}`);
      } catch (e) {
        logger.error(`[Reload] Failed to disconnect ${channelName}: ${e}`);
        throw e;
      }
    },

    async startChannel(agent: any, channelName: string): Promise<void> {
      // The implicit AUN channel is synthesised from agent.aid (not in config.channels[]).
      // Reconstruct it the same way createForAgent does before falling back to config scan.
      const aid = agent.aid ?? agent.config?.aid;
      const aunEffName = agent.effectiveChannelName?.('aun', 'main') ?? 'aun-main';
      const isImplicitAun = channelName === aunEffName;

      // Find config instance: implicit AUN gets a synthetic entry; others scan channels[].
      const cfgInst: any = isImplicitAun
        ? { type: 'aun', name: aunEffName, aid, enabled: true, owner: agent.config?.owners?.[0] }
        : (() => {
            const agentChannels: any[] = agent.config?.channels ?? [];
            return agentChannels.find((i: any) => {
              const effName = agent.effectiveChannelName?.(i.type, i.name) ?? i.name;
              return effName === channelName;
            }) ?? null;
          })();

      if (!cfgInst) {
        const msg = `[Reload] Channel ${channelName} not found in agent config`;
        logger.error(msg);
        throw new Error(msg);
      }
      const ctx: ChannelBuildContext = {
        agentName: agent.aid ?? agent.config?.aid,
        defaultProjectPath: agent.config?.projects?.defaultPath ?? process.cwd(),
        enableRichContent: agent.config?.enable_rich_content,
        debug: agent.config?.debug,
      };
      const plugin = channelLoader.getPlugin(cfgInst.type);
      if (!plugin) throw new Error(`[Reload] No plugin for channel type '${cfgInst.type}'`);
      const effInst = { ...cfgInst, name: channelName };
      const newInst = await plugin.createInstance(effInst, ctx);
      if (!newInst) throw new Error(`[Reload] createInstance returned null for ${channelName}`);
      registerChannelInstance(newInst);
      await newInst.connect();
      channelInstances.push(newInst);
      logger.info(`[Reload] Started channel: ${channelName}`);
    },
  };
}
