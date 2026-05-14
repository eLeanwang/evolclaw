import fs from 'fs';
import path from 'path';
import { EvolAgent } from './evolagent.js';
import { validateEvolAgentConfig } from './evolagent-schema.js';
import { extractFingerprint } from '../utils/channel-fingerprint.js';
import { logger } from '../utils/logger.js';
import type { Config, AgentInfo, EvolAgentConfig } from '../types.js';

export interface ReloadHooks {
  drainChannel(channelName: string): Promise<void>;
  disconnectChannel(channelName: string): Promise<void>;
  startChannel(agent: EvolAgent, channelName: string): Promise<void>;
}

/**
 * Plug-in for writing back to the global config (evolclaw.json) when
 * AgentRegistry is asked to mutate a channel that belongs to the
 * DefaultAgent. Named EvolAgents persist directly to their own agent.json
 * via `EvolAgent.setOwner` / `EvolAgent.setShowActivities`.
 */
export interface GlobalConfigWriter {
  setOwner(channelName: string, userId: string): void;
  setShowActivities?(channelName: string, mode: 'all' | 'dm-only' | 'owner-dm-only' | 'none'): void;
}

export class AgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  private defaultAgent: EvolAgent | null = null;
  private channelIndex: Map<string, string> = new Map();
  private globalWriter?: GlobalConfigWriter;

  constructor(private agentsDir: string, globalWriter?: GlobalConfigWriter) {
    this.globalWriter = globalWriter;
  }

  /** Late-binding setter for tests / index.ts wiring order. */
  setGlobalWriter(writer: GlobalConfigWriter): void {
    this.globalWriter = writer;
  }

  loadAll(globalConfig: Config): void {
    this.agents.clear();
    this.channelIndex.clear();

    const files = fs.existsSync(this.agentsDir)
      ? fs.readdirSync(this.agentsDir).filter(f => f.endsWith('.json'))
      : [];

    for (const file of files) {
      const fullPath = path.join(this.agentsDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const validation = validateEvolAgentConfig(raw);
        if (!validation.valid) {
          const name = raw?.name || path.basename(file, '.json');
          const errorAgent = new EvolAgent(fullPath, { ...raw, name } as EvolAgentConfig);
          errorAgent.status = 'error';
          errorAgent.error = validation.errors.join('; ');
          this.agents.set(name, errorAgent);
          logger.warn(`[AgentRegistry] ${file}: ${validation.errors.join('; ')}`);
          continue;
        }
        const agent = new EvolAgent(fullPath, raw as EvolAgentConfig);
        this.agents.set(agent.name, agent);
      } catch (e) {
        logger.warn(`[AgentRegistry] Failed to load ${file}: ${e}`);
      }
    }

    this.defaultAgent = this.buildDefaultAgent(globalConfig);
    this.detectAndFlagConflicts();
    this.buildChannelIndex();
  }

  private buildDefaultAgent(globalConfig: Config): EvolAgent {
    const agents: any = globalConfig.agents || {};
    const defaultName = agents.defaultAgent || 'claude';
    const cfg: EvolAgentConfig = {
      name: '[default]',
      enabled: true,
      agents: { [defaultName]: agents[defaultName] || {} },
      channels: (globalConfig.channels as any) || {},
      projects: { defaultPath: globalConfig.projects?.defaultPath || process.cwd() },
      chatmode: (globalConfig as any).chatmode,
    };
    return new EvolAgent(null, cfg, { isDefault: true });
  }

  private detectAndFlagConflicts(): void {
    const seen = new Map<string, Array<{ agent: string; instance: string }>>();

    const record = (agentName: string, channelsBlock: any): void => {
      for (const [type, raw] of Object.entries(channelsBlock || {})) {
        if (type === 'defaultChannel') continue;
        const instances = Array.isArray(raw) ? raw : [raw];
        for (const inst of instances) {
          if (!inst || typeof inst !== 'object') continue;
          const fp = extractFingerprint(type, inst as any);
          if (!fp) continue;
          const instName = (inst as any).name ?? type;
          const entry = seen.get(fp) || [];
          entry.push({ agent: agentName, instance: instName });
          seen.set(fp, entry);
        }
      }
    };

    for (const agent of this.agents.values()) {
      if (agent.status === 'error') continue;
      record(agent.name, agent.config.channels);
    }
    if (this.defaultAgent) {
      record(this.defaultAgent.name, this.defaultAgent.config.channels);
    }

    for (const [_fp, occurrences] of seen) {
      if (occurrences.length <= 1) continue;
      const msg = `Channel conflict: fingerprint claimed by ${occurrences.map(o => `${o.agent}(${o.instance})`).join(', ')}`;
      const involvedNames = [...new Set(occurrences.map(o => o.agent))];
      for (const name of involvedNames) {
        if (name === '[default]') continue;
        const a = this.agents.get(name);
        if (a && a.status !== 'error') {
          a.status = 'error';
          a.error = msg;
        }
      }
      logger.error(`[AgentRegistry] ${msg}`);
    }
  }

  private buildChannelIndex(): void {
    for (const agent of this.agents.values()) {
      if (agent.status === 'error' || agent.status === 'disabled') continue;
      for (const name of agent.channelInstanceNames()) {
        this.channelIndex.set(name, agent.name);
      }
    }
    if (this.defaultAgent) {
      for (const name of this.defaultAgent.channelInstanceNames()) {
        if (this.channelIndex.has(name)) continue;
        this.channelIndex.set(name, '[default]');
      }
    }
  }

  resolveByChannel(channelName: string): EvolAgent | null {
    const agentName = this.channelIndex.get(channelName);
    if (!agentName) return null;
    if (agentName === '[default]') return this.defaultAgent;
    return this.agents.get(agentName) || null;
  }

  /**
   * Check ownership of a channel via the agent that owns it.
   * - For named EvolAgent: reads agent.config (memory; reflects agent.json).
   * - For DefaultAgent or unknown channel: invokes `globalFallback`, which
   *   should consult the global config (evolclaw.json) via `config.ts:isOwner`.
   */
  isOwner(channelName: string, userId: string, globalFallback: (ch: string, uid: string) => boolean): boolean {
    const agent = this.resolveByChannel(channelName);
    if (agent && !agent.isDefault) return agent.isOwner(channelName, userId);
    return globalFallback(channelName, userId);
  }

  /** Same routing logic as `isOwner`, applied to admin checks. */
  isAdmin(channelName: string, userId: string, globalFallback: (ch: string, uid: string) => boolean): boolean {
    const agent = this.resolveByChannel(channelName);
    if (agent && !agent.isDefault) return agent.isAdmin(channelName, userId);
    return globalFallback(channelName, userId);
  }

  /** Lookup current owner — agent first, then DefaultAgent (which mirrors evolclaw.json). */
  getOwner(channelName: string): string | undefined {
    const agent = this.resolveByChannel(channelName);
    if (!agent) return undefined;
    return agent.getOwner(channelName);
  }

  /**
   * Persist owner. Routes to agent.json for named agents, or to evolclaw.json
   * via the configured `globalWriter` for DefaultAgent. No-ops with a warning
   * when the channel is unknown or no global writer is wired.
   */
  setChannelOwner(channelName: string, userId: string): void {
    const agent = this.resolveByChannel(channelName);
    if (!agent) {
      logger.warn(`[AgentRegistry] setChannelOwner: channel "${channelName}" not found`);
      return;
    }
    if (agent.isDefault) {
      if (!this.globalWriter) {
        logger.warn(`[AgentRegistry] setChannelOwner: no globalWriter wired for default channel "${channelName}"`);
        return;
      }
      this.globalWriter.setOwner(channelName, userId);
    } else {
      agent.setOwner(channelName, userId);
    }
  }

  /**
   * Read showActivities mode. Falls back to `'all'` when the channel is
   * unknown — matches the prior behavior of `config.ts:getChannelShowActivities`.
   */
  getShowActivities(channelName: string): 'all' | 'dm-only' | 'owner-dm-only' | 'none' {
    const agent = this.resolveByChannel(channelName);
    if (!agent) return 'all';
    return agent.getShowActivities(channelName);
  }

  /** Persist showActivities. Routes to agent.json or evolclaw.json. */
  setShowActivities(channelName: string, mode: 'all' | 'dm-only' | 'owner-dm-only' | 'none'): void {
    const agent = this.resolveByChannel(channelName);
    if (!agent) {
      logger.warn(`[AgentRegistry] setShowActivities: channel "${channelName}" not found`);
      return;
    }
    if (agent.isDefault) {
      if (!this.globalWriter?.setShowActivities) {
        logger.warn(`[AgentRegistry] setShowActivities: no globalWriter wired for default channel "${channelName}"`);
        return;
      }
      this.globalWriter.setShowActivities(channelName, mode);
    } else {
      agent.setShowActivities(channelName, mode);
    }
  }

  get(name: string): EvolAgent | null {
    if (name === '[default]') return this.defaultAgent;
    return this.agents.get(name) || null;
  }

  list(): AgentInfo[] {
    const result: AgentInfo[] = [];
    for (const agent of this.agents.values()) {
      result.push(this.toInfo(agent));
    }
    if (this.defaultAgent) {
      result.push(this.toInfo(this.defaultAgent));
    }
    return result;
  }

  runnableAgents(): EvolAgent[] {
    return [...this.agents.values()].filter(a => a.status === 'stopped');
  }

  async reload(name: string, hooks: ReloadHooks): Promise<void> {
    const oldAgent = this.agents.get(name);
    if (!oldAgent) throw new Error(`Agent "${name}" not found`);
    if (!oldAgent.configPath) throw new Error(`Cannot reload DefaultAgent`);

    // 1. Re-read config from disk
    const raw = JSON.parse(fs.readFileSync(oldAgent.configPath, 'utf-8'));
    const validation = validateEvolAgentConfig(raw);
    if (!validation.valid) {
      throw new Error(`Invalid config after edit: ${validation.errors.join('; ')}`);
    }

    const newAgent = new EvolAgent(oldAgent.configPath, raw);

    // 2. Fingerprint conflict check (against all others except self)
    const conflict = this.checkConflictForReload(newAgent, name);
    if (conflict) {
      throw new Error(`Channel conflict: ${conflict}`);
    }

    // 3. Compute channel diff
    const oldChannels = new Set(oldAgent.channelInstanceNames());
    const newChannels = new Set(newAgent.channelInstanceNames());
    const toRemove = [...oldChannels].filter(c => !newChannels.has(c));
    const toAdd = [...newChannels].filter(c => !oldChannels.has(c));
    const kept = [...oldChannels].filter(c => newChannels.has(c));

    // I6: detect kept-channel credential changes — treat as remove+add so
    // the channel reconnects with new credentials (e.g. appSecret rotated).
    const credentialsChanged: string[] = [];
    const trulyKept: string[] = [];
    for (const ch of kept) {
      const oldCh = getChannelInstanceConfig(oldAgent, ch);
      const newCh = getChannelInstanceConfig(newAgent, ch);
      if (oldCh && newCh && channelConfigChanged(oldCh.config, newCh.config)) {
        credentialsChanged.push(ch);
      } else {
        trulyKept.push(ch);
      }
    }
    toRemove.push(...credentialsChanged);
    toAdd.push(...credentialsChanged);

    // Track what was removed/added so we can roll back on failure
    const removedSuccessfully: string[] = [];
    const addedSuccessfully: string[] = [];

    try {
      // 4. Drain channels being removed
      for (const ch of toRemove) {
        await hooks.drainChannel(ch);
      }

      // 5. Disconnect removed channels
      for (const ch of toRemove) {
        await hooks.disconnectChannel(ch);
        removedSuccessfully.push(ch);
      }

      // 6. Start new channels
      for (const ch of toAdd) {
        await hooks.startChannel(newAgent, ch);
        addedSuccessfully.push(ch);
      }

      // 7. Transfer kept channel adapters from old to new (only truly unchanged ones)
      for (const ch of trulyKept) {
        const adapter = oldAgent.channels.get(ch);
        if (adapter) newAgent.channels.set(ch, adapter);
      }

      // 8. Preserve runtime state
      // I5: only set 'running' when oldAgent was running; preserve error/disabled
      newAgent.activeSessions = oldAgent.activeSessions;
      newAgent.lastActivity = oldAgent.lastActivity;
      if (oldAgent.status === 'error' || oldAgent.status === 'disabled') {
        newAgent.status = oldAgent.status;
        newAgent.error = oldAgent.error;
      } else {
        newAgent.status = 'running';
      }

      // 9. Swap in registry
      this.agents.set(name, newAgent);

      // 10. Rebuild channel index
      this.channelIndex.clear();
      this.buildChannelIndex();
    } catch (err) {
      // C1: Rollback — restore original channels, keep oldAgent in registry
      logger.error(`[Reload] Failed: ${err}. Attempting rollback for "${name}".`);
      for (const ch of addedSuccessfully) {
        try { await hooks.disconnectChannel(ch); } catch (_) { /* best effort */ }
      }
      for (const ch of removedSuccessfully) {
        try { await hooks.startChannel(oldAgent, ch); } catch (_) { /* best effort */ }
      }
      // Don't swap registry — oldAgent stays in place
      oldAgent.status = 'error';
      oldAgent.error = `Reload failed (rollback attempted): ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  private checkConflictForReload(newAgent: EvolAgent, excludeName: string): string | null {
    const newFingerprints = new Map<string, string>(); // fp → instanceName

    for (const [type, raw] of Object.entries(newAgent.config.channels || {})) {
      if (type === 'defaultChannel') continue;
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        const fp = extractFingerprint(type, inst as any);
        if (!fp) continue;
        const instName = (inst as any).name ?? type;
        newFingerprints.set(fp, instName);
      }
    }

    // Check against all other agents (excluding self)
    for (const [agentName, agent] of this.agents) {
      if (agentName === excludeName) continue;
      if (agent.status === 'error' || agent.status === 'disabled') continue;
      for (const [type, raw] of Object.entries(agent.config.channels || {})) {
        if (type === 'defaultChannel') continue;
        const instances = Array.isArray(raw) ? raw : [raw];
        for (const inst of instances) {
          if (!inst || typeof inst !== 'object') continue;
          const fp = extractFingerprint(type, inst as any);
          if (!fp) continue;
          if (newFingerprints.has(fp)) {
            return `${fp} conflicts with agent "${agentName}"`;
          }
        }
      }
    }

    // Check against DefaultAgent
    if (this.defaultAgent) {
      for (const [type, raw] of Object.entries(this.defaultAgent.config.channels || {})) {
        if (type === 'defaultChannel') continue;
        const instances = Array.isArray(raw) ? raw : [raw];
        for (const inst of instances) {
          if (!inst || typeof inst !== 'object') continue;
          const fp = extractFingerprint(type, inst as any);
          if (!fp) continue;
          if (newFingerprints.has(fp)) {
            return `${fp} conflicts with DefaultAgent`;
          }
        }
      }
    }

    return null;
  }

  private toInfo(agent: EvolAgent): AgentInfo {
    let baseagent = 'claude';
    let model: string | undefined;
    let effort: string | undefined;
    try {
      baseagent = agent.baseagent;
      model = agent.model;
      effort = agent.effort;
    } catch { /* invalid config */ }
    return {
      name: agent.name,
      status: agent.status,
      channels: agent.channelInstanceNames(),
      projectPath: agent.config.projects?.defaultPath ?? '',
      baseagent,
      model,
      effort,
      lastActivity: agent.lastActivity,
      activeSessions: agent.activeSessions,
      error: agent.error,
      isDefault: agent.isDefault,
    };
  }
}

/**
 * Locate the raw config of a channel instance by name within an agent config.
 * Returns `{ type, config }` or null if not found.
 *
 * Matches against the effective channel name (with agent prefix for EvolAgents),
 * mirroring `EvolAgent.findChannelInstance`. Only used by `reload()` to detect
 * kept-channel credential changes.
 */
function getChannelInstanceConfig(agent: EvolAgent, channelName: string): { type: string; config: any } | null {
  for (const [type, raw] of Object.entries(agent.config?.channels || {})) {
    if (type === 'defaultChannel') continue;
    const instances = Array.isArray(raw) ? raw : [raw];
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue;
      const effName = agent.effectiveChannelName(type, (inst as any).name);
      if (effName === channelName) return { type, config: inst };
    }
  }
  return null;
}

/**
 * Compare two channel-instance configs by serialized JSON. Channel configs
 * are plain JSON-shaped objects (no functions/Buffers), so this is a sound
 * structural compare for "did anything in this channel block change".
 */
function channelConfigChanged(oldConfig: any, newConfig: any): boolean {
  return JSON.stringify(oldConfig) !== JSON.stringify(newConfig);
}
