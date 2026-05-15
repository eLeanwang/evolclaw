/**
 * Reload Hooks
 *
 * Extracted from index.ts main() for testability. Builds the ReloadHooks
 * implementation used by EvolAgentRegistry.reload() to drain/disconnect/start
 * channels during a hot reload.
 */

import type { ReloadHooks } from '../core/evolagent-registry.js';
import type { ChannelLoader, ChannelInstance } from '../core/channel-loader.js';
import { logger } from './logger.js';

export interface ReloadHooksDeps {
  channelLoader: ChannelLoader;
  /** Mutable list of currently-active channel instances. Hooks splice removed instances. */
  channelInstances: ChannelInstance[];
  /** Called for newly-created instances to wire them into the message pipeline. */
  registerChannelInstance: (inst: ChannelInstance) => void;
  /**
   * Optional: real drain via MessageQueue. If provided, drainChannel polls
   * `isChannelProcessing(channelName)` until empty (or timeout). If absent,
   * falls back to a fixed `drainDelayMs` sleep.
   */
  messageQueue?: { isChannelProcessing(channelName: string): boolean };
  /** Drain delay in ms when messageQueue is absent (default 500). Tests can override to 0. */
  drainDelayMs?: number;
  /** Max wait for real drain in ms (default 30000). */
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
        // Real drain: poll until empty or timeout
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
          if (name === channelName) {
            channelType = type;
            break;
          }
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
      if (!newInst) {
        throw new Error(`[Reload] Failed to create instance ${channelName}`);
      }
      registerChannelInstance(newInst);
      await newInst.connect();
      channelInstances.push(newInst);
      logger.info(`[Reload] Started channel: ${channelName}`);
    },
  };
}
