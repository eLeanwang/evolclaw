import fs from 'fs';
import path from 'path';
import { EvolAgent } from './evolagent.js';
import { validateEvolAgentConfig } from './evolagent-schema.js';
import { extractFingerprint } from '../utils/channel-fingerprint.js';
import { logger } from '../utils/logger.js';
import type { Config, AgentInfo, EvolAgentConfig } from '../types.js';

export class AgentRegistry {
  private agents: Map<string, EvolAgent> = new Map();
  private defaultAgent: EvolAgent | null = null;
  private channelIndex: Map<string, string> = new Map();

  constructor(private agentsDir: string) {}

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

  private toInfo(agent: EvolAgent): AgentInfo {
    let baseagent = 'claude';
    try { baseagent = agent.baseagent; } catch { /* invalid config */ }
    return {
      name: agent.name,
      status: agent.status,
      channels: agent.channelInstanceNames(),
      projectPath: agent.config.projects?.defaultPath ?? '',
      baseagent,
      lastActivity: agent.lastActivity,
      activeSessions: agent.activeSessions,
      error: agent.error,
      isDefault: agent.isDefault,
    };
  }
}
