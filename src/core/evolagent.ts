import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { validateDefaultChannelRef } from '../config.js';
import type { EvolAgentConfig, AgentContext, AgentStatus, ChannelAdapter } from '../types.js';

// ── Config Schema Validation ───────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_BASEAGENTS = new Set(['claude', 'codex', 'gemini', 'hermes']);
const VALID_CHANNEL_TYPES = new Set(['feishu', 'aun', 'wechat', 'wecom', 'dingtalk', 'qqbot']);
const VALID_CHATMODES = new Set(['interactive', 'proactive']);

export function validateEvolAgentConfig(raw: any): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }

  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled must be a boolean if present');
  }

  if (!raw.agents || typeof raw.agents !== 'object') {
    errors.push('agents must be an object with exactly one baseagent block');
  } else {
    const keys = Object.keys(raw.agents).filter(k => VALID_BASEAGENTS.has(k));
    const unknownKeys = Object.keys(raw.agents).filter(k => !VALID_BASEAGENTS.has(k));
    if (unknownKeys.length > 0) {
      errors.push(`agents contains unknown baseagent keys: ${unknownKeys.join(', ')}`);
    }
    if (keys.length === 0) {
      errors.push('agents must contain exactly one of: claude | codex | gemini | hermes');
    } else if (keys.length > 1) {
      errors.push(`agents must contain exactly one baseagent (single baseagent only), got: ${keys.join(', ')}`);
    }
  }

  if (!raw.channels || typeof raw.channels !== 'object') {
    errors.push('channels is required');
  } else {
    const channelKeys = Object.keys(raw.channels).filter(k => k !== 'defaultChannel');
    if (channelKeys.length === 0) {
      errors.push('channels must contain at least one channel type');
    }
    for (const key of channelKeys) {
      if (!VALID_CHANNEL_TYPES.has(key)) {
        errors.push(`unknown channel type: ${key}`);
      }
    }
    // defaultChannel reference validation (same rules as evolclaw.json)
    let totalInstances = 0;
    for (const key of channelKeys) {
      const block = (raw.channels as any)[key];
      const insts = Array.isArray(block) ? block : (block ? [block] : []);
      totalInstances += insts.length;
    }
    const dc = (raw.channels as any).defaultChannel;
    if (dc) {
      const err = validateDefaultChannelRef(dc, raw.channels);
      if (err) errors.push(err);
    } else if (totalInstances > 1) {
      errors.push('channels.defaultChannel is required when multiple channel instances are configured (use "type" or "type/instanceName")');
    }
  }

  if (!raw.projects || typeof raw.projects !== 'object') {
    errors.push('projects is required');
  } else {
    const p = raw.projects.defaultPath;
    if (typeof p !== 'string' || p === '') {
      errors.push('projects.defaultPath is required');
    } else if (!path.isAbsolute(p)) {
      errors.push(`projects.defaultPath must be absolute, got: ${p}`);
    }
  }

  if (raw.chatmode !== undefined) {
    if (typeof raw.chatmode !== 'object' || raw.chatmode === null) {
      errors.push('chatmode must be an object if present');
    } else {
      for (const key of ['private', 'group']) {
        const val = raw.chatmode[key];
        if (val !== undefined && !VALID_CHATMODES.has(val)) {
          errors.push(`chatmode.${key} must be 'interactive' or 'proactive'`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── EvolAgent Class ────────────────────────────────────────────────────────

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

  /**
   * Compute the effective channel-instance name (used as registry key, session.channel, etc).
   *
   * - DefaultAgent: rawName ?? type  (preserves backward-compat with evolclaw.json)
   * - EvolAgent:
   *   - rawName present → `${agent.name}-${type}-${rawName}`
   *   - rawName absent  → `${agent.name}-${type}`
   *
   * The agent-name prefix avoids collisions with DefaultAgent channels, e.g.
   * test-bot's aun → "test-bot-aun" instead of "aun".
   */
  effectiveChannelName(type: string, rawName: string | undefined): string {
    if (this.isDefault) return rawName ?? type;
    return rawName ? `${this.name}-${type}-${rawName}` : `${this.name}-${type}`;
  }

  channelInstanceNames(): string[] {
    const names: string[] = [];
    for (const [type, raw] of Object.entries(this.config.channels || {})) {
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        names.push(this.effectiveChannelName(type, (inst as any).name));
      }
    }
    return names;
  }

  /**
   * Locate a channel-instance config block within this agent's config by
   * matching the effective channel name (with agent prefix for EvolAgents).
   * Returns the raw mutable instance object, or `null` if not found.
   */
  findChannelInstance(channelName: string): any | null {
    const channels = this.config.channels || {};
    for (const [type, raw] of Object.entries(channels)) {
      if (type === 'defaultChannel') continue;
      const instances = Array.isArray(raw) ? raw : [raw];
      for (const inst of instances) {
        if (!inst || typeof inst !== 'object') continue;
        const effName = this.effectiveChannelName(type, (inst as any).name);
        if (effName === channelName) return inst;
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
   * Set this agent's baseagent.model and persist to agent.json.
   * Refuses for DefaultAgent. Writes to config.agents[baseagent].model.
   */
  setBaseagentModel(value: string | undefined): void {
    const ba = this.baseagent;
    if (!this.config.agents[ba]) this.config.agents[ba] = {};
    if (value === undefined) {
      delete (this.config.agents[ba] as any).model;
    } else {
      (this.config.agents[ba] as any).model = value;
    }
    this.persist();
  }

  /**
   * Set this agent's baseagent.effort and persist to agent.json.
   * For codex, the field is named `reasoning` (alias). Refuses for DefaultAgent.
   */
  setBaseagentEffort(value: string | undefined): void {
    const ba = this.baseagent;
    if (!this.config.agents[ba]) this.config.agents[ba] = {};
    const fieldName = ba === 'codex' ? 'reasoning' : 'effort';
    if (value === undefined) {
      delete (this.config.agents[ba] as any)[fieldName];
    } else {
      (this.config.agents[ba] as any)[fieldName] = value;
    }
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
