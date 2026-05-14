import fs from 'fs';
import { logger } from '../utils/logger.js';
import type { EvolAgentConfig, AgentContext, AgentStatus, ChannelAdapter } from '../types.js';

type GlobalChatmode = { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };
type ShowActivitiesMode = 'all' | 'dm-only' | 'owner-dm-only' | 'none';

export interface EvolAgentOptions {
  isDefault?: boolean;
}

export class EvolAgent {
  readonly name: string;
  readonly configPath: string | null;
  readonly config: EvolAgentConfig;
  readonly isDefault: boolean;

  readonly channels: Map<string, ChannelAdapter> = new Map();
  activeSessions: number = 0;
  lastActivity?: number;
  status: AgentStatus;
  error?: string;

  constructor(configPath: string | null, config: EvolAgentConfig, opts: EvolAgentOptions = {}) {
    this.configPath = configPath;
    this.config = config;
    this.name = config.name;
    this.isDefault = opts.isDefault === true;
    this.status = config.enabled === false ? 'disabled' : 'stopped';
  }

  get baseagent(): string {
    const keys = Object.keys(this.config.agents);
    return keys[0] || 'claude';
  }

  get model(): string | undefined {
    return this.config.agents[this.baseagent]?.model;
  }

  get effort(): string | undefined {
    return this.config.agents[this.baseagent]?.effort;
  }

  get projectPath(): string {
    return this.config.projects.defaultPath;
  }

  channelInstanceNames(): string[] {
    const names: string[] = [];
    for (const [type, raw] of Object.entries(this.config.channels || {})) {
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        names.push((inst as any).name ?? type);
      }
    }
    return names;
  }

  /**
   * Locate a channel-instance config block within this agent's config by
   * matching either the explicit `name` field or the channel-type key (when
   * the instance has no explicit name and is not in array form).
   * Returns the raw mutable instance object, or `null` if not found.
   */
  findChannelInstance(channelName: string): any | null {
    const channels = this.config.channels || {};
    for (const [type, raw] of Object.entries(channels)) {
      if (type === 'defaultChannel') continue;
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        const instName = (inst as any).name ?? type;
        if (instName === channelName) return inst;
      }
    }
    return null;
  }

  /** Get owner of a specific channel instance owned by this agent. */
  getOwner(channelName: string): string | undefined {
    const inst = this.findChannelInstance(channelName);
    return inst?.owner;
  }

  /** True when `userId` is the owner of `channelName`. */
  isOwner(channelName: string, userId: string): boolean {
    return this.getOwner(channelName) === userId;
  }

  /**
   * True when `userId` is admin (or owner) of `channelName`.
   * Owner implicitly has admin rights.
   */
  isAdmin(channelName: string, userId: string): boolean {
    if (this.isOwner(channelName, userId)) return true;
    const inst = this.findChannelInstance(channelName);
    const admins: string[] = inst?.admins || [];
    return admins.includes(userId);
  }

  /**
   * Set owner for a channel instance and persist to agent.json.
   * Throws when called on DefaultAgent (no configPath) — callers must use
   * the global config setter for default channels.
   */
  setOwner(channelName: string, userId: string): void {
    const inst = this.findChannelInstance(channelName);
    if (!inst) {
      logger.warn(`[EvolAgent] setOwner: channel "${channelName}" not found in agent "${this.name}"`);
      return;
    }
    inst.owner = userId;
    this.persist();
  }

  /** Get showActivities mode for a channel instance owned by this agent. */
  getShowActivities(channelName: string): ShowActivitiesMode {
    const inst = this.findChannelInstance(channelName);
    return inst?.showActivities ?? 'all';
  }

  /**
   * Set showActivities for a channel instance and persist to agent.json.
   * Throws when called on DefaultAgent — callers must use the global setter.
   */
  setShowActivities(channelName: string, mode: ShowActivitiesMode): void {
    const inst = this.findChannelInstance(channelName);
    if (!inst) {
      logger.warn(`[EvolAgent] setShowActivities: channel "${channelName}" not found in agent "${this.name}"`);
      return;
    }
    inst.showActivities = mode;
    this.persist();
  }

  /**
   * Persist the in-memory config back to the agent.json file.
   * Refuses for DefaultAgent: it is built from evolclaw.json and has no
   * dedicated file — callers must route writes through the global config.
   */
  private persist(): void {
    if (!this.configPath) {
      throw new Error('Cannot persist DefaultAgent config; use global config setters');
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n', 'utf-8');
  }

  getContext(channelName: string, chatType: string, globalChatmode?: GlobalChatmode): AgentContext {
    const chatMode = this.resolveChatMode(chatType, globalChatmode);
    return {
      name: this.name,
      isOwned: !this.isDefault,
      baseagent: this.baseagent,
      model: this.model,
      effort: this.effort,
      chatMode,
      projectPath: this.projectPath,
    };
  }

  private resolveChatMode(
    chatType: string,
    globalChatmode?: GlobalChatmode
  ): 'interactive' | 'proactive' {
    const agentCm = this.config.chatmode;
    const key = chatType === 'group' ? 'group' : 'private';
    if (agentCm) {
      return (agentCm[key] || 'interactive');
    }
    if (globalChatmode) {
      return (globalChatmode[key] || 'interactive');
    }
    return 'interactive';
  }
}
