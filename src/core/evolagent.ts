import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { saveAgent } from '../config-store.js';
import { formatChannelKey } from './channel-key.js';
import { agentPersonalDir } from '../paths.js';
import type {
  AgentConfig,
  MergedAgentConfig,
  ChannelInstance,
  AgentContext,
  AgentStatus,
  ChannelAdapter,
  ShowActivitiesMode,
  ChatmodeBlock,
} from '../types.js';

// ── 校验：迁到 config-store.validateAgentConfig ──
// EvolAgent 假定传入的 AgentConfig 已通过 ConfigStore.validateAgentConfig，
// 这里不再做结构校验。

type GlobalChatmode = ChatmodeBlock;

/**
 * EvolAgent —— 一个 self-agent 的运行时表示。
 *
 * 输入：MergedAgentConfig（defaults + per-agent 合并后的 effective 形态）。
 * 持有该 agent 的 channels Map、活跃状态、生命周期。
 *
 * 写入永远落到 agents/<aid>/config.json（通过 ConfigStore.saveAgent 走双 rename），
 * 不再有 "DefaultAgent" 概念，不再有 globalWriter / configPath null 的路径。
 */
export class EvolAgent {
  readonly aid: string;
  /** 兼容字段：name = aid。channel routing / log / IPC 都用 aid 作 agent 标识。 */
  readonly name: string;

  /** in-memory effective config（含 defaults 合并结果）；写盘时只回写 per-agent 部分。 */
  private merged: MergedAgentConfig;
  /** per-agent 原始配置（写盘真相源） */
  private rawAgent: AgentConfig;

  readonly channels: Map<string, ChannelAdapter> = new Map();
  activeSessions: number = 0;
  lastActivity?: number;
  status: AgentStatus;
  error?: string;

  constructor(rawAgent: AgentConfig, merged: MergedAgentConfig) {
    if (rawAgent.aid !== merged.aid) {
      throw new Error(`EvolAgent: rawAgent.aid (${rawAgent.aid}) != merged.aid (${merged.aid})`);
    }
    this.rawAgent = rawAgent;
    this.merged = merged;
    this.aid = rawAgent.aid;
    this.name = rawAgent.aid;
    this.status = rawAgent.enabled === false ? 'disabled' : 'stopped';
  }

  /** 当前 effective config（合并后的） */
  get config(): MergedAgentConfig {
    return this.merged;
  }

  get baseagent(): string {
    return this.merged.active_baseagent || 'claude';
  }

  get model(): string | undefined {
    const ba = this.baseagent;
    const block = this.merged.baseagents?.[ba as keyof typeof this.merged.baseagents] as any;
    return block?.model;
  }

  get effort(): string | undefined {
    const ba = this.baseagent;
    const block = this.merged.baseagents?.[ba as keyof typeof this.merged.baseagents] as any;
    if (ba === 'codex') return block?.effort ?? block?.reasoning;
    return block?.effort;
  }

  get projectPath(): string {
    return this.merged.projects?.defaultPath || process.cwd();
  }

  // ── Channels ──────────────────────────────────────────────────────────

  /**
   * effective channel key：`<aid>#<type>#<name>`。AUN 实例一个 agent 只有一条；
   * 其它类型靠 name 区分。
   */
  effectiveChannelName(type: string, rawName: string): string {
    return formatChannelKey({ aid: this.aid, type, name: rawName });
  }

  channelInstanceNames(): string[] {
    // AUN channel 隐式存在（从 agent.aid 派生），不需要在 channels[] 里声明
    const aunKey = this.effectiveChannelName('aun', 'main');
    const others = this.merged.channels
      .filter(c => c.type !== 'aun')
      .map(c => this.effectiveChannelName(c.type, c.name));
    return [aunKey, ...others];
  }

  /** 列出所有 channel 实例（含 effective key） */
  listChannels(): Array<{ key: string; instance: ChannelInstance }> {
    return this.merged.channels.map(inst => ({
      key: this.effectiveChannelName(inst.type, inst.name),
      instance: inst,
    }));
  }

  /**
   * 按 effective channel key 找到 instance（只读视图）。
   * 找不到返回 null。
   */
  findChannelInstance(channelKey: string): ChannelInstance | null {
    return this.merged.channels.find(c => this.effectiveChannelName(c.type, c.name) === channelKey) ?? null;
  }

  // ── Owner / Admin（per-channel-instance）─────────────────────────────

  getOwner(channelKey: string): string | undefined {
    const inst = this.findChannelInstance(channelKey);
    return inst?.owners?.[0];
  }

  isOwner(channelKey: string, userId: string): boolean {
    const inst = this.findChannelInstance(channelKey);
    return inst?.owners?.includes(userId) ?? false;
  }

  isAdmin(channelKey: string, userId: string): boolean {
    if (this.isOwner(channelKey, userId)) return true;
    const inst = this.findChannelInstance(channelKey);
    return inst?.admins?.includes(userId) ?? false;
  }

  setOwner(channelKey: string, userId: string): void {
    const inst = this.findRawChannelInstance(channelKey);
    if (!inst) {
      logger.warn(`[EvolAgent ${this.aid}] setOwner: channel "${channelKey}" not found`);
      return;
    }
    // 顶层 owners 是单值列表（首通信者即 owner）；channel 实例 owners 也允许多值
    if (!inst.owners) inst.owners = [];
    if (!inst.owners.includes(userId)) inst.owners.push(userId);
    this.persist();
  }

  // ── ShowActivities ────────────────────────────────────────────────────

  getShowActivities(channelKey: string): ShowActivitiesMode {
    const inst = this.findChannelInstance(channelKey);
    return inst?.showActivities ?? this.merged.show_activities ?? 'all';
  }

  setShowActivities(channelKey: string, mode: ShowActivitiesMode): void {
    const inst = this.findRawChannelInstance(channelKey);
    if (!inst) {
      logger.warn(`[EvolAgent ${this.aid}] setShowActivities: channel "${channelKey}" not found`);
      return;
    }
    inst.showActivities = mode;
    this.persist();
  }

  // ── Baseagent 字段写入 ────────────────────────────────────────────────

  setBaseagentModel(value: string | undefined): void {
    const ba = this.baseagent;
    if (!this.rawAgent.baseagents) this.rawAgent.baseagents = {};
    const block = ((this.rawAgent.baseagents as any)[ba] ??= {});
    if (value === undefined) delete block.model;
    else block.model = value;
    this.persist();
  }

  setBaseagentEffort(value: string | undefined): void {
    const ba = this.baseagent;
    if (!this.rawAgent.baseagents) this.rawAgent.baseagents = {};
    const block = ((this.rawAgent.baseagents as any)[ba] ??= {});
    const fieldName = ba === 'codex' ? 'reasoning' : 'effort';
    if (value === undefined) delete block[fieldName];
    else block[fieldName] = value;
    this.persist();
  }

  // ── Projects ──────────────────────────────────────────────────────────

  getProjects(): Record<string, string> {
    const list = this.merged.projects?.list;
    if (list && Object.keys(list).length > 0) return { ...list };
    const dp = this.merged.projects?.defaultPath;
    if (dp) return { [path.basename(dp)]: dp };
    return {};
  }

  addProject(name: string, projectPath: string): void {
    if (!this.rawAgent.projects) this.rawAgent.projects = { defaultPath: projectPath, list: {} };
    if (!this.rawAgent.projects.list) this.rawAgent.projects.list = {};
    this.rawAgent.projects.list[name] = projectPath;
    this.persist();
  }

  // ── Personal layer ────────────────────────────────────────────────────

  private _personaCache: string | null | undefined = undefined;

  /**
   * 读取 personal/persona.md 内容（缓存，首次调用时从磁盘读）。
   * 文件不存在返回 null。
   */
  getPersona(): string | null {
    if (this._personaCache !== undefined) return this._personaCache;
    const personaPath = path.join(agentPersonalDir(this.aid), 'persona.md');
    try {
      this._personaCache = fs.readFileSync(personaPath, 'utf-8').trim() || null;
    } catch {
      this._personaCache = null;
    }
    return this._personaCache;
  }

  /**
   * 读取 personal/memory/working.md 内容（不缓存，每次会话开始时读）。
   */
  getWorkingMemory(): string | null {
    const workingPath = path.join(agentPersonalDir(this.aid), 'memory', 'working.md');
    try {
      const content = fs.readFileSync(workingPath, 'utf-8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  /** 清除 persona 缓存（reload 后重新读取） */
  invalidatePersonaCache(): void {
    this._personaCache = undefined;
  }

  // ── Context（喂给 message-processor / command-handler） ──────────────

  getContext(_channelKey: string, chatType: string, globalChatmode?: GlobalChatmode): AgentContext {
    const chatMode = this.resolveChatMode(chatType, globalChatmode);
    return {
      name: this.name,
      isOwned: true,
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
    const key = chatType === 'group' ? 'group' : 'private';
    return (
      this.merged.chatmode?.[key]
      ?? globalChatmode?.[key]
      ?? (key === 'group' ? 'proactive' : 'interactive')
    );
  }

  // ── Reload 支持：替换 in-memory config 并复用 channels Map ───────────

  /** 用新的 raw + merged 替换 in-memory 状态。channels 由调用方决定如何 reconcile。 */
  swapConfig(rawAgent: AgentConfig, merged: MergedAgentConfig): void {
    if (rawAgent.aid !== this.aid) {
      throw new Error(`EvolAgent.swapConfig: aid mismatch (${rawAgent.aid} vs ${this.aid})`);
    }
    this.rawAgent = rawAgent;
    this.merged = merged;
  }

  // ── 内部辅助 ─────────────────────────────────────────────────────────

  /**
   * 找 rawAgent.channels 里的可变实例，用于写入。
   *
   * merged.channels 是 deep clone 时 raw 跟 merged 的 channels 引用同一份（mergeForAgent
   * 直接 `agent.channels` 透传），所以 raw 里的实例就等于 merged 里的实例。
   */
  private findRawChannelInstance(channelKey: string): ChannelInstance | null {
    return this.rawAgent.channels.find(c => this.effectiveChannelName(c.type, c.name) === channelKey) ?? null;
  }

  private persist(): void {
    saveAgent(this.rawAgent);
  }
}
