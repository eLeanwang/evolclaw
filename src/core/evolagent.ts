import path from 'path';
import { logger } from '../utils/logger.js';
import { saveAgent } from '../config-store.js';
import { formatChannelKey } from './channel-loader.js';
import { agentPersonalDir } from '../paths.js';
import { fileCache } from './daemon-file-cache.js';
import { ConfigTarget, read as cfgRead, write as cfgWrite, ensureFile as cfgEnsure, resolveEffective } from '../config/config-manager.js';
import { withLifecycleForWrite } from '../config/lifecycle.js';
import { listRoleAssignments, setPrivateRoleAssignment } from '../config/role-assignments.js';
import type {
  AgentConfig,
  AgentLifecycle,
  EffectiveAgentConfig,
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
 * 输入：EffectiveAgentConfig（defaults + per-agent 合并后的 effective 形态）。
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
  private merged: EffectiveAgentConfig;
  /** per-agent 原始配置（写盘真相源） */
  private rawAgent: AgentConfig;

  readonly channels: Map<string, ChannelAdapter> = new Map();
  activeSessions: number = 0;
  lastActivity?: number;
  status: AgentStatus;
  error?: string;

  constructor(rawAgent: AgentConfig, merged: EffectiveAgentConfig) {
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
  get config(): EffectiveAgentConfig {
    return this.merged;
  }

  get baseagent(): string {
    if (!this.merged.active_baseagent) {
      throw new Error(`[EvolAgent] active_baseagent is empty for agent ${this.name}`);
    }
    return this.merged.active_baseagent;
  }

  get model(): string | undefined {
    const ba = this.baseagent;
    // 动态读取配置（基于 fileCache + mtime），使 ec model 修改后立即体现在显示中
    try {
      const effective = resolveEffective({ self: this.aid }, { cache: true });
      const block = effective.baseagents?.[ba as keyof typeof effective.baseagents] as any;
      return block?.model;
    } catch {
      // 降级：读取快照
      const block = this.merged.baseagents?.[ba as keyof typeof this.merged.baseagents] as any;
      return block?.model;
    }
  }

  get effort(): string | undefined {
    const ba = this.baseagent;
    // 动态读取配置（基于 fileCache + mtime），使 ec model 修改后立即体现在显示中
    try {
      const effective = resolveEffective({ self: this.aid }, { cache: true });
      const block = effective.baseagents?.[ba as keyof typeof effective.baseagents] as any;
      if (ba === 'codex') return block?.effort ?? block?.reasoning;
      return block?.effort;
    } catch {
      // 降级：读取快照
      const block = this.merged.baseagents?.[ba as keyof typeof this.merged.baseagents] as any;
      if (ba === 'codex') return block?.effort ?? block?.reasoning;
      return block?.effort;
    }
  }

  get projectPath(): string {
    return this.merged.projects?.defaultPath || process.cwd();
  }

  // ── Channels ──────────────────────────────────────────────────────────

  /**
   * effective channel key：`<type>#<selfAID>#<name>`。
   * AUN channel 的 selfAID 是 agent.aid，name 固定为 'main'。
   */
  effectiveChannelName(type: string, rawName: string): string {
    return formatChannelKey({ type, selfAID: this.aid, name: rawName });
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

  // ── ShowActivities ────────────────────────────────────────────────────

  getShowActivities(_channelKey: string): ShowActivitiesMode {
    return this.merged.show_activities ?? 'all';
  }

  setShowActivities(_channelKey: string, mode: ShowActivitiesMode): void {
    this.merged.show_activities = mode;
    this.mutateBehavior(b => { b.show_activities = mode; });
  }

  // ── Role-based Access Control ─────────────────────────────────────────

  /**
   * Check if a user has owner role for this agent (private scope).
   * Uses the role-assignments system.
   */
  isOwner(_channelKey: string, userId: string): boolean {
    if (this.merged.owners?.includes(userId)) return true;
    const assignments = listRoleAssignments(this.aid, { scope: 'private', role: 'owner', peerId: userId });
    return assignments.length > 0;
  }

  /**
   * Check if a user has admin role for this agent (private scope).
   * Uses the role-assignments system.
   */
  isAdmin(_channelKey: string, userId: string): boolean {
    if (this.isOwner(_channelKey, userId)) return true;
    const assignments = listRoleAssignments(this.aid, { scope: 'private', role: 'admin', peerId: userId });
    return assignments.length > 0;
  }

  /**
   * Get the first owner of this agent (private scope).
   * Returns the peerId of the first owner assignment.
   */
  getOwner(_channelKey: string): string | undefined {
    if (this.merged.owners?.[0]) return this.merged.owners[0];
    const owners = listRoleAssignments(this.aid, { scope: 'private', role: 'owner' });
    return owners[0]?.peerId;
  }

  /**
   * Set a user as owner for this agent (private scope).
   * Creates a role assignment in the role-assignments system.
   */
  setOwner(_channelKey: string, userId: string): void {
    setPrivateRoleAssignment(this.aid, userId, 'owner');
  }

  // ── Baseagent 字段写入 ────────────────────────────

  /** 切换当前活跃 baseagent（写 behavior.active_baseagent）。 */
  setActiveBaseagent(value: string | undefined): void {
    this.merged.active_baseagent = value;
    this.mutateBehavior(b => {
      if (value === undefined) delete b.active_baseagent;
      else b.active_baseagent = value;
    });
  }

  setBaseagentModel(value: string | undefined, baseagentName?: string): void {
    const ba = baseagentName || this.baseagent;
    if (!this.merged.baseagents) (this.merged as any).baseagents = {};
    const mBlock = (((this.merged as any).baseagents)[ba] ??= {});
    if (value === undefined) delete mBlock.model; else mBlock.model = value;
    this.mutateBehavior(b => {
      b.baseagents = b.baseagents || {};
      const blk = ((b.baseagents as any)[ba] ??= {});
      if (value === undefined) delete blk.model; else blk.model = value;
    });
  }

  setBaseagentEffort(value: string | undefined, baseagentName?: string): void {
    const ba = baseagentName || this.baseagent;
    if (!this.merged.baseagents) (this.merged as any).baseagents = {};
    const mBlock = (((this.merged as any).baseagents)[ba] ??= {});
    if (value === undefined) {
      delete mBlock.effort;
      delete mBlock.reasoning;
    } else {
      mBlock.effort = value;
      delete mBlock.reasoning;
    }
    this.mutateBehavior(b => {
      b.baseagents = b.baseagents || {};
      const blk = ((b.baseagents as any)[ba] ??= {});
      if (value === undefined) {
        delete blk.effort;
        delete blk.reasoning;
      } else {
        blk.effort = value;
        delete blk.reasoning;
      }
    });
  }

  /** 设置私聊 chatmode（群聊/非 human 强制 proactive，无可写入项）。 */
  setChatmodePrivate(value: 'interactive' | 'proactive' | undefined): void {
    if (!this.merged.chatmode) this.merged.chatmode = {};
    this.merged.chatmode.private = value;
    this.mutateBehavior(b => {
      b.chatmode = b.chatmode || {};
      if (value === undefined) delete b.chatmode.private; else b.chatmode.private = value;
    });
  }

  /** 设置群聊 dispatch 默认值（mention | broadcast）。 */
  setDispatch(value: 'mention' | 'broadcast' | undefined): void {
    this.merged.dispatch = value;
    this.mutateBehavior(b => {
      if (value === undefined) delete b.dispatch; else b.dispatch = value;
    });
  }

  /** 读取观察者模式开关（默认 false）。 */
  getObservable(): boolean {
    return this.merged.observable === true;
  }

  /** 设置观察者模式开关：开启后入站/出站消息各转发一份给 owners[]。 */
  setObservable(value: boolean): void {
    if (value) this.rawAgent.observable = true;
    else delete this.rawAgent.observable;
    this.merged.observable = value;
    this.persist();
  }

  setLifecycle(value: AgentLifecycle): void {
    this.rawAgent = withLifecycleForWrite(this.rawAgent, value) as AgentConfig;
    this.rawAgent.$schema_version = Math.max(this.rawAgent.$schema_version || 0, this.merged.$schema_version || 0);
    this.merged.lifecycle = value;
    delete this.merged.initialized;
    this.persist();
  }

  // ── Personal layer ────────────────────────────────────────────────────

  /** 本 agent 身份层文件在 fileCache 的组名（带 aid，避免 reload 单个 agent 误失效他人）。 */
  private agentFilesGroup(): string {
    return `agent-files:${this.aid}`;
  }

  /**
   * 读取 personal/persona.md 内容。走 fileCache（mtime 门控）：persona 没有任何
   * 写入命令、由 agent 自己带外改写，与 working memory 同样改了即应生效，故每次读
   * stat 比对、变了自动重读。文件不存在返回 null。
   */
  getPersona(): string | null {
    const personaPath = path.join(agentPersonalDir(this.aid), 'persona.md');
    return fileCache.get<string | null>(
      personaPath,
      (raw) => (raw === null ? null : (raw.trim() || null)),
      { policy: 'mtime', group: this.agentFilesGroup() },
    );
  }

  /**
   * 读取 personal/memory/working.md 内容。走 fileCache（mtime 门控）：
   * agent 在对话中改写 working memory、不触发 reload，故每次读 stat 比对、
   * 变了自动重读，既即时反映又避免无谓重读。
   */
  getWorkingMemory(): string | null {
    const workingPath = path.join(agentPersonalDir(this.aid), 'memory', 'working.md');
    return fileCache.get<string | null>(
      workingPath,
      (raw) => (raw === null ? null : (raw.trim() || null)),
      { policy: 'mtime', group: this.agentFilesGroup() },
    );
  }

  /** 清除本 agent 身份层缓存（reload 后重新读取）。只失效自己的文件组，不波及他人。 */
  invalidatePersonaCache(): void {
    fileCache.invalidateGroup(this.agentFilesGroup());
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
  swapConfig(rawAgent: AgentConfig, merged: EffectiveAgentConfig): void {
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
   * merged.channels 是 deep clone 时 raw 跟 merged 的 channels 引用同一份（resolveEffective
   * 直接透传 agent.channels），所以 raw 里的实例就等于 merged 里的实例。
   */
  private findRawChannelInstance(channelKey: string): ChannelInstance | null {
    return this.rawAgent.channels.find(c => this.effectiveChannelName(c.type, c.name) === channelKey) ?? null;
  }

  private persist(): void {
    saveAgent(this.rawAgent);
  }

  /** 读改写 agent 级 config.json（v3 设计，走 ConfigManager 唯一写入口）。 */
  private mutateBehavior(fn: (b: AgentConfig) => void): void {
    const sel = { self: this.aid };
    const cur = (cfgRead<AgentConfig>(ConfigTarget.Agent, sel) as AgentConfig) || {};
    fn(cur);
    cfgEnsure(ConfigTarget.Agent, sel);
    cfgWrite(ConfigTarget.Agent, cur, sel);
  }
}
