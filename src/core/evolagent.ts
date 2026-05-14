import type { EvolAgentConfig, AgentContext, AgentStatus, ChannelAdapter } from '../types.js';

type GlobalChatmode = { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };

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
