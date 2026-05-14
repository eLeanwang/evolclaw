/**
 * Reload Hooks
 *
 * Extracted from index.ts main() for testability. Builds the ReloadHooks
 * implementation used by AgentRegistry.reload() to drain/disconnect/start
 * channels during a hot reload.
 */

import type { ReloadHooks } from './agent-registry.js';
import type { ChannelLoader, ChannelInstance } from './channel-loader.js';
import { logger } from '../utils/logger.js';

export interface ReloadHooksDeps {
  channelLoader: ChannelLoader;
  /** Mutable list of currently-active channel instances. Hooks splice removed instances. */
  channelInstances: ChannelInstance[];
  /** Called for newly-created instances to wire them into the message pipeline. */
  registerChannelInstance: (inst: ChannelInstance) => void;
  /** Drain delay in ms (default 500). Tests can override to 0. */
  drainDelayMs?: number;
}

export function buildReloadHooks(deps: ReloadHooksDeps): ReloadHooks {
  const { channelLoader, channelInstances, registerChannelInstance } = deps;
  const drainDelayMs = deps.drainDelayMs ?? 500;

  return {
    async drainChannel(channelName: string): Promise<void> {
      logger.info(`[Reload] Draining channel: ${channelName}`);
      if (drainDelayMs > 0) await new Promise(r => setTimeout(r, drainDelayMs));
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
