import path from 'path';
import { logger } from '../utils/logger.js';
import { saveAgent } from '../config-store.js';
import { formatChannelKey, tryParseChannelKey } from './channel-loader.js';
import { agentPersonalDir } from '../paths.js';
import { fileCache } from './cache/file-cache.js';
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
import type { TriggerScheduler } from './trigger/scheduler.js';
import type { TriggerManager } from './trigger/manager.js';

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
  triggerScheduler?: TriggerScheduler;
  triggerManager?: TriggerManager;

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

  // ── Owner / Admin（per-channel-instance；AUN 走顶层 owners/admins）──────

  /**
   * AUN channel 是隐式的，不在 channels[] 里——其 owner/admin 存于 EvolAgent 顶层
   * `owners`/`admins`（config 加载时由 aunBlock.owner/admins 收集而来）。
   */
  private isAunChannelKey(channelKey: string): boolean {
    const parsed = tryParseChannelKey(channelKey);
    return parsed?.type === 'aun' && parsed.selfAID === this.aid;
  }

  getOwner(channelKey: string): string | undefined {
    if (this.isAunChannelKey(channelKey)) {
      return this.merged.owners?.[0];
    }
    const inst = this.findChannelInstance(channelKey);
    return inst?.owners?.[0];
  }

  isOwner(channelKey: string, userId: string): boolean {
    if (this.isAunChannelKey(channelKey)) {
      return this.merged.owners?.includes(userId) ?? false;
    }
    const inst = this.findChannelInstance(channelKey);
    return inst?.owners?.includes(userId) ?? false;
  }

  isAdmin(channelKey: string, userId: string): boolean {
    if (this.isOwner(channelKey, userId)) return true;
    if (this.isAunChannelKey(channelKey)) {
      return this.merged.admins?.includes(userId) ?? false;
    }
    const inst = this.findChannelInstance(channelKey);
    return inst?.admins?.includes(userId) ?? false;
  }

  setOwner(channelKey: string, userId: string): void {
    // AUN：写到 rawAgent 顶层 owners（merged 也指向同一份引用）
    if (this.isAunChannelKey(channelKey)) {
      if (!this.rawAgent.owners) this.rawAgent.owners = [];
      if (!this.rawAgent.owners.includes(userId)) this.rawAgent.owners.push(userId);
      // merged.owners 是从 rawAgent.owners 派生的拷贝；同步内存视图避免重新 merge
      if (!this.merged.owners) this.merged.owners = [];
      if (!this.merged.owners.includes(userId)) this.merged.owners.push(userId);
      this.persist();
      return;
    }
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

  getShowActivities(_channelKey: string): ShowActivitiesMode {
    return this.merged.show_activities ?? 'all';
  }

  setShowActivities(_channelKey: string, mode: ShowActivitiesMode): void {
    this.rawAgent.show_activities = mode;
    this.merged.show_activities = mode;
    this.persist();
  }

  // ── Baseagent 字段写入 ────────────────────────────────────────────────

  /** 切换当前活跃 baseagent（写顶层 active_baseagent）。 */
  setActiveBaseagent(value: string | undefined): void {
    if (value === undefined) delete this.rawAgent.active_baseagent;
    else this.rawAgent.active_baseagent = value;
    this.merged.active_baseagent = value;
    this.persist();
  }

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

  /** 设置私聊 chatmode（群聊/非 human 强制 proactive，无可写入项）。 */
  setChatmodePrivate(value: 'interactive' | 'proactive' | undefined): void {
    if (!this.rawAgent.chatmode) this.rawAgent.chatmode = {};
    if (value === undefined) delete this.rawAgent.chatmode.private;
    else this.rawAgent.chatmode.private = value;
    if (!this.merged.chatmode) this.merged.chatmode = {};
    this.merged.chatmode.private = value;
    this.persist();
  }

  /** 设置群聊 dispatch 默认值（mention | broadcast）。 */
  setDispatch(value: 'mention' | 'broadcast' | undefined): void {
    if (value === undefined) delete this.rawAgent.dispatch;
    else this.rawAgent.dispatch = value;
    this.merged.dispatch = value;
    this.persist();
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

  // ── Personal layer ────────────────────────────────────────────────────

  /**
   * 读取 personal/persona.md 内容。走统一 fileCache（on-reload，group
   * 'agent-files'）：人格稳定，靠 reload/重启刷新即可。文件不存在返回 null。
   */
  getPersona(): string | null {
    const personaPath = path.join(agentPersonalDir(this.aid), 'persona.md');
    return fileCache.get<string | null>(
      personaPath,
      (raw) => (raw === null ? null : (raw.trim() || null)),
      { policy: 'on-reload', group: 'agent-files' },
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
      { policy: 'mtime', group: 'agent-files' },
    );
  }

  /** 清除 persona 缓存（reload 后重新读取）。失效本 agent 的身份层文件组。 */
  invalidatePersonaCache(): void {
    fileCache.invalidateGroup('agent-files');
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
