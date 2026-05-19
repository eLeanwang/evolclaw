import { ChannelAdapter, Session, ChannelPolicy, InteractionRequest, ReplyContext, ActionInteraction, DEFAULT_PERMISSION_MODE, type OutboundPayload, type EvolAgentRegistryHandle, type EvolAgentHandle } from '../types.js';
import { SessionManager } from './session/session-manager.js';
import { type AgentRunnerFull, hasModelSwitcher, hasPermissionController } from '../agents/claude-runner.js';
import { MessageCache } from './message/message-cache.js';
import { MessageProcessor } from './message/message-processor.js';
import { EventBus } from './event-bus.js';
import type { StatsCollector } from '../utils/stats.js';
import { PermissionGateway, type PermissionDecision } from './permission.js';
import { InteractionRouter } from './interaction-router.js';
import { MessageQueue } from './message/message-queue.js';
import { renderCommandCardAsText } from './interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from './message/message-processor.js';
import { resolvePaths, getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

export interface MenuNext {
  type: 'select' | 'text';
  items?: MenuItem[];
  dynamic?: boolean;
}

export interface MenuItem {
  cmd?: string;
  value?: string;
  label: string;
  args?: string;
  desc?: string;
  next?: MenuNext;
}

const allEfforts = ['low', 'medium', 'high', 'max'] as const;
type Effort = typeof allEfforts[number];
const nonMaxEfforts = allEfforts.filter(e => e !== 'max') as readonly Effort[];

function getAvailableEfforts(agent: AgentRunnerFull, model: string): readonly Effort[] {
  if (agent.name === 'claude') {
    if (model.includes('opus')) return allEfforts;
    return nonMaxEfforts;
  }

  if (agent.name === 'codex') {
    return nonMaxEfforts;
  }

  return [];
}


function formatModelUsage(agent: AgentRunnerFull, model: string): string {
  const efforts = getAvailableEfforts(agent, model);
  const lines = [
    '用法:',
    '  /model <模型>            切换模型',
  ];

  if (efforts.length > 0) {
    lines.push('  /model <模型> <强度>     切换模型+推理强度');
    lines.push('  /effort [level]          查看或切换推理强度');
  }

  return lines.join('\n');
}

/**
 * 写入用户级 ~/.claude/settings.json（与 Claude CLI 行为一致）
 */
function writeUserSettings(updates: { model?: string; effortLevel?: string | null }): { success: boolean; error?: string } {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings: any = {};

    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }

    if (updates.model !== undefined) settings.model = updates.model;
    if (updates.effortLevel !== undefined) {
      if (updates.effortLevel === null) {
        delete settings.effortLevel;
      } else {
        settings.effortLevel = updates.effortLevel;
      }
    }

    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * 计算两个字符串的 Levenshtein 距离（编辑距离）
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // 替换
          matrix[i][j - 1] + 1,     // 插入
          matrix[i - 1][j] + 1      // 删除
        );
      }
    }
  }

  return matrix[len1][len2];
}

function formatIdleTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

// 支持的命令列表
const commands = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/evolhelp', '/status', '/restart', '/model', '/setmodel', '/effort', '/agent', '/slist', '/session', '/rename', '/stop', '/clear', '/compact', '/repair', '/safe', '/fork', '/del', '/perm', '/file', '/check', '/rewind', '/activity', '/chatmode', '/dispatch', '/ask', '/resume', '/aid', '/rpc', '/storage'];

// 命令别名映射
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename',
  '/rw': '/rewind'
};

// 命令快速路径前缀（所有命令都不进入消息队列）
const quickCommandPrefixes = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/evolhelp', '/status', '/restart', '/model', '/setmodel', '/effort', '/agent', '/slist', '/session', '/rename', '/repair', '/fork', '/stop', '/clear', '/compact', '/safe', '/del', '/perm', '/file', '/check', '/p ', '/s ', '/name', '/rewind', '/rw', '/rw ', '/activity', '/chatmode', '/dispatch', '/ask', '/resume', '/aid', '/rpc', '/storage'];

export class CommandHandler {
  private adapters = new Map<string, ChannelAdapter>();
  private policies = new Map<string, ChannelPolicy>();
  private channelObjects = new Map<string, any>();  // name → actual channel instance (for /check)
  private channelTypeMap = new Map<string, string>();  // name → channelType (for grouping)
  private processor!: MessageProcessor;
  private messageQueue!: MessageQueue;
  private permissionGateway?: PermissionGateway;
  private interactionRouter?: InteractionRouter;
  private statsCollector?: StatsCollector;
  private agentMap: Map<string, AgentRunnerFull>;
  private primaryRunnerKey: string;
  private agentRegistry?: EvolAgentRegistryHandle;

  /**
   * Get the runner for a (channel, baseagent) pair.
   *
   * Resolves the owning EvolAgent via the registry; falls back to default key.
   * `baseagent` typically comes from `session.agentId` (e.g. 'claude').
   */
  private getAgent(channel?: string, baseagent?: string): AgentRunnerFull {
    if (channel && baseagent) {
      const evolName = this.agentRegistry?.resolveByChannel(channel)?.name || '<unknown>';
      const key = `${evolName}::${baseagent}`;
      if (this.agentMap.has(key)) return this.agentMap.get(key)!;
    }
    if (this.agentMap.has(this.primaryRunnerKey)) return this.agentMap.get(this.primaryRunnerKey)!;
    return this.agentMap.values().next().value!;
  }

  /** Return the list of baseagents available to a given channel (per-EvolAgent isolation). */
  private getAvailableBaseagents(channel: string): string[] {
    const evolName = this.agentRegistry?.resolveByChannel(channel)?.name || '<unknown>';
    const prefix = `${evolName}::`;
    const result: string[] = [];
    for (const key of this.agentMap.keys()) {
      if (key.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  }

  /** Extract the baseagent component from `primaryRunnerKey` (e.g. `aid::claude` → `claude`). */
  private parseDefaultBaseagent(): string {
    const idx = this.primaryRunnerKey.indexOf('::');
    return idx >= 0 ? this.primaryRunnerKey.slice(idx + 2) : this.primaryRunnerKey;
  }

  constructor(
    private sessionManager: SessionManager,
    agentRunnerOrMap: AgentRunnerFull | Map<string, AgentRunnerFull>,
    private messageCache: MessageCache,
    private eventBus: EventBus,
    primaryRunnerKey?: string
  ) {
    if (agentRunnerOrMap instanceof Map) {
      this.agentMap = agentRunnerOrMap;
      this.primaryRunnerKey = primaryRunnerKey || '<unknown>::claude';
    } else {
      // 测试 / 单 runner 路径：占位 agent name 用 '<unknown>'
      this.agentMap = new Map([[`<unknown>::${agentRunnerOrMap.name}`, agentRunnerOrMap]]);
      this.primaryRunnerKey = `<unknown>::${agentRunnerOrMap.name}`;
    }
  }

  /** 注入 EvolAgentRegistry，用于判断通道是否被 EvolAgent 管理 */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  /** 返回管理当前通道的 EvolAgent，无则返回 null */
  private getOwningAgent(channel: string): EvolAgentHandle | null {
    if (!this.agentRegistry) return null;
    return this.agentRegistry.resolveByChannel(channel);
  }

  /** 返回当前通道的有效项目路径：从 owning agent 取。*/
  private getEffectiveDefaultPath(channel: string): string {
    const owning = this.getOwningAgent(channel);
    if (owning) return owning.projectPath;
    return process.cwd();
  }

  /**
   * 返回当前通道有效的 projects.list（从 owning agent 的 config 取）。
   * 都没配 list 时回退到 defaultPath 单项目。
   */
  private getEffectiveProjects(channel: string): Record<string, string> {
    const owning = this.getOwningAgent(channel);
    if (owning) {
      return owning.getProjects();
    }
    return this.projects;
  }

  /**
   * 添加项目到当前通道范围（写到 owning agent 的 config.json）。
   */
  private async addProjectInScope(channel: string, name: string, projectPath: string): Promise<string | undefined> {
    const owning = this.getOwningAgent(channel);
    if (!owning) {
      return `⚠️ 找不到通道 "${channel}" 所属的 self-agent`;
    }
    try {
      owning.addProject(name, projectPath);
    } catch (e: any) {
      return `⚠️ 写入 agent config 失败: ${e?.message || e}`;
    }
    return undefined;
  }

  /**
   * 持久化 baseagent.model：写到 agent config.json；找不到 owning agent 时
   * 退到用户级 ~/.claude/settings.json（Claude 专用）。
   */
  private persistBaseagentModel(channel: string, baseagentName: string, newModel: string | undefined): string | undefined {
    const owning = this.getOwningAgent(channel);
    if (owning) {
      try {
        owning.setBaseagentModel(newModel);
      } catch (e: any) {
        return `⚠️ 写入 agent config 失败: ${e?.message || e}`;
      }
      return undefined;
    }
    // 无 owning agent（罕见，新结构下应当不会发生）→ 仅 Claude 走用户级 fallback
    if (baseagentName !== 'claude') {
      return `⚠️ 找不到通道 "${channel}" 所属的 self-agent`;
    }
    const updates: { model?: string; effortLevel?: string } = {};
    if (newModel) updates.model = newModel;
    const writeResult = writeUserSettings(updates);
    if (!writeResult.success) {
      return `⚠️ 写入用户配置失败: ${writeResult.error}`;
    }
    return undefined;
  }

  /**
   * 持久化 baseagent.effort：写到 agent config.json；找不到时退到用户级 settings。
   */
  private persistBaseagentEffort(channel: string, baseagentName: string, newEffort: string | undefined): string | undefined {
    const owning = this.getOwningAgent(channel);
    if (owning) {
      try {
        owning.setBaseagentEffort(newEffort);
      } catch (e: any) {
        return `⚠️ 写入 agent config 失败: ${e?.message || e}`;
      }
      return undefined;
    }
    if (baseagentName !== 'claude') {
      return `⚠️ 找不到通道 "${channel}" 所属的 self-agent`;
    }
    const updates: { effortLevel?: string | null } = { effortLevel: newEffort ?? null };
    const writeResult = writeUserSettings(updates);
    if (!writeResult.success) {
      return `⚠️ 写入用户配置失败: ${writeResult.error}`;
    }
    return undefined;
  }

  /** 项目列表快捷访问（无 channel 上下文时的 fallback，尽量不用） */
  private get projects(): Record<string, string> {
    return {};
  }

  /** 根据项目路径查找配置中的项目名称 */
  private getConfiguredProjectName(projectPath: string): string | undefined {
    return Object.entries(this.projects).find(([_, p]) => p === projectPath)?.[0];
  }

  /** 根据项目路径查找项目名称（未配置时回退到目录名） */
  private getProjectName(projectPath: string): string {
    return this.getConfiguredProjectName(projectPath) || path.basename(projectPath);
  }

  /** 格式化运行时间 */
  private formatUptime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}天`);
    if (h > 0) parts.push(`${h}时`);
    if (m > 0) parts.push(`${m}分`);
    if (parts.length === 0) parts.push(`${s}秒`);
    return parts.join('');
  }

  /** 获取消息队列 key：话题用 session.id，主会话用 channel-channelId */
  private getQueueKey(session: Session | undefined, _channel: string, _channelId: string): string {
    // 队列和 agent 均使用 session.id 作为 key
    return session?.id || '';
  }

  /** 从 session 提取渠道预构建的回复上下文 */
  private getReplyContext(session: Session): import('../types.js').ReplyContext | undefined {
    return session.metadata?.replyContext;
  }

  /**
   * 发送 CommandCard 卡片。卡片成功返回 null（调用方直接 return），失败返回降级文本。
   * CommandCard 不进 InteractionRouter，按钮点击由 channel 直接构造伪命令入站消息。
   *
   * 走统一 adapter.send(envelope, { kind: 'interaction', ... }) 入口。
   */
  private async sendCommandCard(opts: {
    channel: string;
    channelId: string;
    interaction: InteractionRequest;
    replyCtx?: ReplyContext;
    canWrite?: boolean;
  }): Promise<string | null> {
    const adapter = this.adapters.get(opts.channel);
    if (opts.interaction.kind.kind !== 'command-card') {
      logger.warn(`[CommandHandler] sendCommandCard called with non-CommandCard kind`);
      return null;
    }
    const card = opts.interaction.kind;

    if (opts.canWrite === false) return renderCommandCardAsText(card);
    if (!adapter?.send) return renderCommandCardAsText(card);
    // session 忙碌时降级到文本，避免并发触发带参写操作
    if (this.isSessionBusy(opts.interaction.sessionId)) return renderCommandCardAsText(card);

    try {
      const envelope = buildEnvelope({
        channel: opts.channel,
        channelId: opts.channelId,
        agentName: this.agentRegistry?.resolveByChannel(opts.channel)?.name,
        replyContext: opts.replyCtx,
      });
      const fallbackText = renderCommandCardAsText(card);
      const messageId = await sendInteractionPayload(
        adapter,
        envelope,
        opts.interaction,
        fallbackText,
        opts.replyCtx,
      );
      if (messageId) return null;
    } catch (e) {
      logger.warn(`[CommandHandler] sendCommandCard failed: ${e}`);
    }
    return renderCommandCardAsText(card);
  }

  /**
   * 通用降级应答入口：按 (sessionId, fallbackCommand) 查找 pending interaction 并路由。
   * 返回 { matched: true } 表示已处理，调用方直接返回 result。
   */
  private async handleInteractionFallback(
    command: string,
    args: string,
    sessionId: string,
    userId?: string,
  ): Promise<{ matched: boolean; result?: string }> {
    if (!this.interactionRouter) return { matched: false };

    const pendingId = this.interactionRouter.findPendingByCommand(sessionId, command);
    if (!pendingId) return { matched: false };

    const initiatorId = this.interactionRouter.getInitiator(pendingId);
    if (initiatorId && userId && initiatorId !== userId) {
      return { matched: true, result: '⚠️ 仅卡片发起者可应答' };
    }

    this.interactionRouter.handle({
      type: 'interaction.response',
      id: pendingId,
      action: args,
      operatorId: userId,
    });
    return { matched: true, result: '✓ 已回答' };
  }

  /** 判断指定 session 是否有活跃流（用于 idle 守卫和卡片降级） */
  private isSessionBusy(sessionId: string): boolean {
    for (const agent of this.agentMap.values()) {
      if (agent.hasActiveStream(sessionId)) return true;
    }
    return false;
  }

  /** 获取活跃会话，无会话时自动创建（话题除外） */
  private async ensureSession(channel: string, channelId: string, threadId?: string, chatType?: string): Promise<{ session: Session } | { error: string }> {
    if (threadId) {
      // 话题会话：仅查询，不创建
      const session = await this.sessionManager.getThreadSession(channel, channelId, threadId);
      if (!session) {
        return { error: '❌ 话题中尚未创建会话\n发送消息后自动创建' };
      }
      return { session };
    }
    const ct: 'private' | 'group' | undefined = chatType === 'group' ? 'group' : chatType === 'private' ? 'private' : undefined;
    const session = await this.sessionManager.getActiveSession(channel, channelId)
      ?? await this.sessionManager.getOrCreateSession(channel, channelId, this.getEffectiveDefaultPath(channel), undefined, undefined, undefined, undefined, ct);
    // 如果 session 已存在但 chatType 跟传入的不一致，更新
    if (ct && session.chatType !== ct) {
      await this.sessionManager.updateSession(session.id, { chatType: ct });
      session.chatType = ct;
    }
    return { session };
  }

  setProcessor(processor: MessageProcessor): void {
    this.processor = processor;
  }

  setMessageQueue(messageQueue: MessageQueue): void {
    this.messageQueue = messageQueue;
  }

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  setInteractionRouter(router: InteractionRouter): void {
    this.interactionRouter = router;
  }

  setStatsCollector(collector: StatsCollector): void {
    this.statsCollector = collector;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelName, adapter);
  }

  registerChannel(name: string, channel: any, channelType?: string): void {
    this.channelObjects.set(name, channel);
    if (channelType) this.channelTypeMap.set(name, channelType);
  }

  /** 将实例名解析为渠道类型（用于 session 查询） */
  private resolveChannelType(channelName: string): string {
    return this.channelTypeMap.get(channelName) || channelName;
  }

  registerPolicy(channelName: string, policy: ChannelPolicy): void {
    this.policies.set(channelName, policy);
  }

  getAdapter(channelName: string): ChannelAdapter | undefined {
    // 先按实例名查找，再按 channelType 查找
    let adapter = this.adapters.get(channelName);
    if (adapter) return adapter;
    for (const [name, a] of this.adapters) {
      if ((this.channelTypeMap.get(name) || name) === channelName) return a;
    }
    return undefined;
  }

  private getPolicy(channel: string): ChannelPolicy {
    return this.policies.get(channel) || {
      canSwitchProject: () => true,
      canListProjects: () => true,
      canCreateSession: () => true,
      canDeleteSession: () => true,
      canImportCliSession: () => true,
      messagePrefix: () => '',
      showMiddleResult: () => true,
      showIdleMonitor: () => true,
      accumulateErrors: () => true,
    };
  }

  /**
   * 返回结构化命令菜单（供 menu.query 使用）
   * owner 看到全部命令，admin 看到管理级命令（不含 owner-only），guest 仅看到用户级命令
   */
  getMenuItems(role: string, chatType: string = 'private'): { group: string; commands: MenuItem[] }[] {
    const isOwner = role === 'owner';
    const isAdmin = role === 'owner' || role === 'admin';
    const items: { group: string; commands: MenuItem[] }[] = [];

    if (!isAdmin && chatType === 'group') {
      return [
        {
          group: '其他',
          commands: [
            { cmd: '/status', label: '显示会话状态' },
            { cmd: '/check', label: '检查渠道健康' },
            { cmd: '/help', label: '显示帮助信息' },
          ]
        }
      ];
    }

    if (isAdmin) {
      items.push({
        group: '项目管理',
        commands: [
          { cmd: '/pwd', label: '显示当前项目路径', desc: '查看当前会话绑定的项目目录' },
          { cmd: '/p', label: '列出或切换项目', desc: '切换到其他已配置的项目', next: { type: 'select', dynamic: true } },
          ...(isOwner ? [{ cmd: '/bind', label: '绑定新项目目录', desc: '将当前会话绑定到指定项目路径', next: { type: 'text' as const } }] : []),
        ]
      });
    }

    items.push({
      group: '会话管理',
      commands: [
        { cmd: '/new', label: '创建新会话', desc: '清空历史，开始全新对话', next: { type: 'text' as const } },
        { cmd: '/s', label: '切换会话', desc: '切换到同项目下的其他会话', next: { type: 'select', dynamic: true } },
        { cmd: '/name', label: '重命名当前会话', desc: '为当前会话设置一个易识别的名称', next: { type: 'text' as const } },
        { cmd: '/del', label: '删除指定会话', desc: '永久删除一个非活跃会话', next: { type: 'select', dynamic: true } },
        ...(isAdmin ? [
          { cmd: '/fork', label: '分支当前会话', desc: '基于当前会话创建独立分支', next: { type: 'text' as const } },
          { cmd: '/rewind', label: '查看历史/撤销指定轮次', desc: '回退会话到指定轮次，可选择撤销文件改动' },
          { cmd: '/compact', label: '压缩会话上下文', desc: '将长对话压缩为摘要以节省 token' },
        ] : []),
      ]
    });

    if (isAdmin) {
      items.push({
        group: 'Agent 与模型',
        commands: [
          { cmd: '/agent', label: '切换 Agent 后端', desc: '切换当前会话使用的 AI 后端', next: { type: 'select', dynamic: true } },
          { cmd: '/model', label: '切换模型', desc: '切换当前 Agent 使用的模型版本', next: { type: 'select', dynamic: true } },
          { cmd: '/effort', label: '切换推理强度', desc: '调整模型推理深度，影响响应速度与质量', next: { type: 'select', items: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
          ] } },
          { cmd: '/chatmode', label: '切换会话模式', desc: '控制 Agent 主动性（被动响应或主动推进）', next: { type: 'select', items: [
            { value: 'interactive', label: '交互模式', desc: '仅在收到消息时响应' },
            { value: 'proactive', label: '主动模式', desc: 'Agent 可主动推进任务' },
          ] } },
          { cmd: '/dispatch', label: '切换分发模式', desc: '控制群聊消息过滤（仅@提及或广播响应）', next: { type: 'select', items: [
            { value: 'mention', label: '@ 提及', desc: '仅在被 @ 提及时响应' },
            { value: 'all', label: '广播', desc: '响应群内所有消息' },
          ] } },
        ]
      });

      items.push({
        group: '权限管理',
        commands: [
          { cmd: '/perm', label: '权限模式管理', desc: '控制工具调用的审批策略', next: { type: 'select', items: [
            ...(isOwner ? [
              { value: 'auto', label: '自动模式', desc: '根据风险等级自动决定是否审批' },
              { value: 'bypass', label: '免审批模式', desc: '跳过所有工具审批确认' },
              { value: 'plan', label: '计划模式', desc: '仅允许只读操作，写操作需审批' },
              { value: 'edit', label: '编辑模式', desc: '允许文件编辑，其他操作需审批' },
              { value: 'request', label: '请求模式', desc: '所有操作均需审批' },
              { value: 'noask', label: '静默模式', desc: '不弹出审批，自动拒绝未授权操作' },
            ] : []),
            { value: 'allow', label: '允许此操作', desc: '本次允许当前待审批操作' },
            { value: 'always', label: '始终允许', desc: '永久允许同类操作' },
            { value: 'deny', label: '拒绝此操作', desc: '拒绝当前待审批操作' },
          ] } },
        ]
      });

      items.push({
        group: '运维',
        commands: [
          { cmd: '/status', label: '显示会话状态', desc: '查看当前会话、项目、Agent 的详细状态' },
          { cmd: '/stop', label: '中断当前任务', desc: '立即中断正在执行的 Agent 任务' },
          { cmd: '/check', label: '检查渠道状态', desc: '检查各消息渠道的连接健康状态' },
          { cmd: '/activity', label: '控制中间输出显示', desc: '设置工具调用过程的可见范围', next: { type: 'select', items: [
            { value: 'all', label: '全部显示', desc: '所有用户均可见中间输出' },
            { value: 'dm', label: '仅私聊', desc: '仅私聊中显示中间输出' },
            { value: 'owner', label: '仅 owner 私聊', desc: '仅 owner 的私聊中显示' },
            { value: 'none', label: '不显示', desc: '关闭所有中间输出' },
          ] } },
          ...(isAdmin ? [
            { cmd: '/restart', label: '重启/重连', desc: '重启服务或重连指定渠道', next: { type: 'select' as const, dynamic: true } },
          ] : []),
          ...(isOwner ? [
            { cmd: '/file', label: '发送项目内文件', desc: '将项目目录内的文件发送给用户' },
          ] : []),
        ]
      });
    } else {
      items.push({
        group: '其他',
        commands: [
          { cmd: '/status', label: '显示会话状态', desc: '查看当前会话的基本状态' },
          { cmd: '/check', label: '检查渠道健康', desc: '检查消息渠道连接状态' },
        ]
      });
    }

    items.push({
      group: '帮助',
      commands: [
        { cmd: '/help', label: '显示帮助信息', desc: '列出所有可用命令及说明' },
      ]
    });

    return items;
  }

  /** 动态子菜单：根据 cmd 路径返回选项列表（供 menu.query + cmd 使用） */
  async getSubMenuItems(cmd: string, channel: string, channelId: string, userId?: string): Promise<MenuItem[] | null> {
    const session = await this.sessionManager.getActiveSession(channel, channelId);

    if (cmd === '/s' || cmd === '/del') {
      const sessions = await this.sessionManager.listSessions(channel, channelId);
      const active = cmd === '/del' ? await this.sessionManager.getActiveSession(channel, channelId) : null;
      const items: MenuItem[] = sessions
        .filter(s => !active || s.id !== active.id)
        .map(s => {
          const shortId = s.agentSessionId ? s.agentSessionId.substring(0, 8) : '';
          const time = s.updatedAt ? formatIdleTime(Date.now() - s.updatedAt) : '';
          const parts = [shortId, time].filter(Boolean).join(' · ');
          return {
            value: s.name || s.id.slice(0, 8),
            label: s.name || s.id.slice(0, 8),
            desc: parts || undefined,
          };
        });
      if (cmd === '/s') {
        items.push({ value: 'cli', label: '查看 CLI 会话', desc: '列出未导入的 CLI 本地会话' });
      }
      return items;
    }

    if (cmd === '/p') {
      // Use agent-scoped project list: agent-owned channels see their agent.json's
      // projects.list; default channel sees agent config's projects.list
      const list = this.getEffectiveProjects(channel);
      return Object.entries(list).map(([name, path]) => ({ value: name, label: name, desc: path as string }));
    }

    if (cmd === '/agent') {
      return this.getAvailableBaseagents(channel).map(name => ({ value: name, label: name }));
    }

    if (cmd === '/model') {
      const agent = this.getAgent(channel, session?.agentId);
      if (hasModelSwitcher(agent) && agent.listModels) {
        const models = await agent.listModels() ?? [];
        if (models.length > 0) return models.map((m: string) => ({ value: m, label: m }));
      }
      return null;
    }

    if (cmd === '/restart') {
      const isOwner = userId ? this.sessionManager.resolveIdentity(channel, userId).role === 'owner' : false;
      // 列出所有 channel type
      const visibleTypes = new Set<string>();
      for (const [name] of this.adapters) {
        const t = this.channelTypeMap.get(name);
        if (t) visibleTypes.add(t);
      }
      const channels = [...visibleTypes].map(type => ({ value: type, label: type, desc: '重连此类型所有渠道实例' }));
      if (isOwner) channels.unshift({ value: '', label: '重启服务', desc: '重启整个 EvolClaw 服务进程' });
      return channels;
    }

    return null;
  }

  /** 菜单 exec 模式：查询状态或执行命令，返回结构化数据 */
  async execMenu(
    cmd: string, mode: 'query' | 'update',
    channel: string, channelId: string, userId?: string
  ): Promise<{ data: Record<string, any> } | { error: string }> {
    const session = await this.sessionManager.getActiveSession(channel, channelId);
    if (!session) return { error: '当前无活跃会话' };

    const trimmed = cmd.trim();
    const cmdBase = trimmed.split(' ')[0];
    if (!cmdBase) return { error: '缺少命令' };
    const arg = trimmed.slice(cmdBase.length).trim();

    if (cmdBase === '/perm') {
      const currentMode = session.metadata?.permissionMode ?? DEFAULT_PERMISSION_MODE;
      if (mode === 'query') {
        return { data: { mode: currentMode } };
      }
      // update
      if (!arg) return { error: '缺少目标模式' };
      const identity = this.sessionManager.resolveIdentity(channel, userId);
      if (identity.role !== 'owner') return { error: '无权限' };
      const permAgent = this.getAgent(channel, session.agentId);
      const validModes = hasPermissionController(permAgent)
        ? permAgent.listModes().filter(m => m.available).map(m => m.key)
        : ['auto', 'bypass', 'plan', 'edit', 'request', 'noask'];
      if (!validModes.includes(arg)) return { error: `无效模式: ${arg}` };
      const metadata = { ...(session.metadata || {}), permissionMode: arg };
      await this.sessionManager.updateSession(session.id, { metadata });
      return { data: { mode: arg } };
    }

    if (cmdBase === '/chatmode') {
      const currentMode = session.sessionMode || 'interactive';
      if (mode === 'query') {
        return { data: { mode: currentMode } };
      }
      // update
      if (!arg) return { error: '缺少目标模式' };
      if (arg !== 'interactive' && arg !== 'proactive') return { error: `无效模式: ${arg}` };
      const identity = this.sessionManager.resolveIdentity(channel, userId);
      const chatType = session.chatType || 'private';
      if (chatType === 'group' && identity.role !== 'owner' && identity.role !== 'admin') {
        return { error: '无权限：群聊中仅管理员可切换' };
      }
      await this.sessionManager.updateSession(session.id, { sessionMode: arg });
      this.eventBus.publish({ type: 'session:chat-mode-changed', sessionId: session.id, mode: arg, timestamp: Date.now() });
      return { data: { mode: arg } };
    }

    if (cmdBase === '/dispatch') {
      const currentMode = session.metadata?.dispatchMode || 'mention';
      if (mode === 'query') {
        return { data: { mode: currentMode } };
      }
      // update
      if (!arg) return { error: '缺少目标模式' };
      if (arg !== 'mention' && arg !== 'all') return { error: `无效模式: ${arg}` };
      const identity = this.sessionManager.resolveIdentity(channel, userId);
      const chatType = session.chatType || 'private';
      if (chatType === 'group' && identity.role !== 'owner' && identity.role !== 'admin') {
        return { error: '无权限：群聊中仅管理员可切换' };
      }
      const metadata = { ...(session.metadata || {}), dispatchMode: arg };
      await this.sessionManager.updateSession(session.id, { metadata });
      this.eventBus.publish({ type: 'session:dispatch-mode-changed', sessionId: session.id, mode: arg, timestamp: Date.now() });
      return { data: { mode: arg } };
    }

    return { error: `不支持 exec 模式: ${cmdBase}` };
  }

  isCommand(content: string): boolean {
    return content === '/p' || content === '/s' || quickCommandPrefixes.some(cmd => content.startsWith(cmd));
  }

  /**
   * 主命令处理入口
   */
  async handle(
    content: string,
    channel: string,
    channelId: string,
    sendMessage?: (channelId: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => Promise<void>,
    userId?: string,
    threadId?: string,
    chatType?: string,
    source?: 'user' | 'card-trigger',
  ): Promise<OutboundPayload | string | null | undefined> {
    const result = await this._handleInternal(content, channel, channelId, sendMessage, userId, threadId, chatType, source);

    return result;
  }

  private async _handleInternal(
    content: string,
    channel: string,
    channelId: string,
    sendMessage?: (channelId: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => Promise<void>,
    userId?: string,
    threadId?: string,
    chatType?: string,
    source?: 'user' | 'card-trigger',
  ): Promise<OutboundPayload | null | undefined> {
    // 解析身份（按实例名）
    const identity = this.sessionManager.resolveIdentity(channel, userId);
    const policy = this.getPolicy(channel);

    // 按当前会话选择 agent 后端
    const activeSession = await this.sessionManager.getActiveSession(channel, channelId);
    const agent = this.getAgent(channel, activeSession?.agentId);

    // 规范化命令（将别名转换为完整命令）
    let normalizedContent = content;
    for (const [alias, full] of Object.entries(aliases)) {
      if (content === alias || content.startsWith(alias + ' ')) {
        normalizedContent = content.replace(alias, full);
        break;
      }
    }

    if (normalizedContent !== content) {
      logger.debug(`[CommandHandler] normalized: "${content}" -> "${normalizedContent}"`);
    }
    logger.info(`[CommandHandler] handle: channel=${channel} channelId=${channelId} cmd="${normalizedContent.split(' ')[0]}" user=${userId ?? 'n/a'} role=${identity?.role ?? 'n/a'}`);

    // 话题内禁用部分命令
    if (threadId) {
      const threadBlocked = ['/new', '/slist', '/plist', '/bind', '/s', '/session', '/project', '/p', '/fork', '/del', '/agent'];
      const isBlocked = threadBlocked.some(c => normalizedContent === c || normalizedContent.startsWith(c + ' '));
      if (isBlocked) {
        return { kind: 'command.error' as const, text: '⚠️ 话题中不支持此命令' };
      }
    }

    // Agent-owned 通道：禁止项目切换和 agent 切换
    const owningAgent = this.getOwningAgent(channel);
    if (owningAgent) {
      const isProjectCmd = normalizedContent === '/project' || normalizedContent.startsWith('/project ') ||
        normalizedContent === '/bind' || normalizedContent.startsWith('/bind ') ||
        normalizedContent === '/plist' ||
        normalizedContent === '/p' || normalizedContent.startsWith('/p ');
      if (isProjectCmd) {
        return { kind: 'command.error' as const, text: `❌ 当前通道由 agent [${owningAgent.name}] 管理，项目已锁定为 ${owningAgent.projectPath}` };
      }
      if (normalizedContent.startsWith('/agent ')) {
        return { kind: 'command.error' as const, text: `❌ 当前通道由 agent [${owningAgent.name}] 管理，baseagent 已锁定为 ${owningAgent.baseagent}` };
      }
    }

    // 权限检查：区分用户级命令和管理级命令
    const isOwner = identity.role === 'owner';
    const isAdmin = identity.role === 'owner' || identity.role === 'admin';
    const activeChatType = activeSession?.chatType || 'private';

    if (normalizedContent.startsWith('/')) {
      // guest 在群聊和私聊中均可访问的只读命令：纯查询形态（带参写操作由各 handler 内部守卫拦截）
      const guestGroupCommands = [
        '/status', '/help', '/evolhelp', '/check', '/chatmode', '/dispatch',
        '/model', '/setmodel', '/effort', '/agent', '/perm', '/activity', '/safe', '/stop',
        '/resume',
      ];
      const userCommands = activeChatType === 'group' && !isAdmin
        ? guestGroupCommands
        : [
            ...guestGroupCommands,
            // 私聊 guest 额外可用：会话自管理 + 私聊专属的 /rewind 历史查看
            '/slist', '/new', '/session', '/rename', '/name', '/del', '/s ', '/rewind',
          ];
      const isUserCommand = userCommands.some(cmd =>
        normalizedContent === cmd.trimEnd() || normalizedContent.startsWith(cmd)
      );
      if (!isUserCommand && !isAdmin) {
        return { kind: 'command.error' as const, text: activeChatType === 'group'
                    ? '❌ 无权限：当前群聊仅支持 /status 和 /help'
                    : '❌ 无权限：此命令仅限管理员使用' };
      }
    }

    // 空闲检查：某些命令需要等待当前会话空闲
    // 原则：仅对"写/破坏性"形态拦截，纯读/用法提示的无参形态始终放行
    // - 始终需要 idle（无参即写）：/new /clear /compact /repair /fork
    // - 仅带参时需要 idle（无参是列表/用法）：/session /bind /project /agent /rewind
    // - /chatmode：在 handler 内部自行做写操作的 idle 检查
    // - /dispatch：在 handler 内部自行做写操作的 idle 检查
    // - /safe：已禁用 no-op，不再要求 idle
    const idleAlways = ['/new', '/clear', '/compact', '/repair', '/fork'];
    const idleWhenArg = ['/session', '/bind', '/project', '/agent', '/rewind'];
    const needsIdle =
      idleAlways.some(cmd => normalizedContent === cmd || normalizedContent.startsWith(cmd + ' ')) ||
      idleWhenArg.some(cmd => normalizedContent.startsWith(cmd + ' '));
    if (needsIdle) {
      if (threadId) {
        // 话题中：检查话题 session 是否在处理（不创建）
        const threadSession = await this.sessionManager.getThreadSession(channel, channelId, threadId);
        if (threadSession) {
          const threadAgent = this.getAgent(channel, threadSession.agentId);
          if (threadAgent.hasActiveStream(threadSession.id)) {
            return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
          }
        }
      } else if (activeSession && agent.hasActiveStream(activeSession.id)) {
        return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
      }
    }

    // 检查是否以 / 开头（可能是命令）
    if (normalizedContent.startsWith('/')) {
      const inputCmd = normalizedContent.split(' ')[0];
      const isValidCommand = commands.some(cmd => normalizedContent.startsWith(cmd));

      if (!isValidCommand) {
        const similar = commands.find(cmd => {
          const distance = levenshteinDistance(inputCmd, cmd);
          return distance <= 2;
        });

        if (similar) {
          return { kind: 'command.error' as const, text: `❌ 未知命令: ${inputCmd}\n💡 你是不是想输入: ${similar}\n\n输入 /help 查看所有可用命令` };
        } else {
          return { kind: 'command.error' as const, text: `❌ 未知命令: ${inputCmd}\n\n输入 /help 查看所有可用命令` };
        }
      }
    }

    const isCmd = commands.some(cmd => normalizedContent.startsWith(cmd));
    if (!isCmd) return undefined;

    // /help 命令不需要会话
    if (normalizedContent === '/help') {
      if (!isAdmin && activeChatType === 'group') {
        const lines = [
          '可用命令：',
          '',
          '其他：',
          '  /status - 显示会话状态',
          '  /check - 检查渠道健康',
          '  /help - 显示此帮助信息',
        ];
        return { kind: 'command.result' as const, text: lines.join('\n') };
      }

      if (!isAdmin) {
        const lines = [
          '可用命令：',
          '',
          '🔄 会话管理：',
          '  /new [名称] - 创建新会话（清空历史请用此命令，可选命名）',
          '  /s [cli|名称|序号|uuid] - 列出或切换会话（cli 查看未导入的 CLI 会话）',
          '  /name <新名称> - 重命名当前会话',
          '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
          '  /status - 显示会话状态',
          '  /check - 检查渠道健康',
          '',
          '❓ 帮助：',
          '  /help - 显示此帮助信息',
        ];
        return { kind: 'command.result' as const, text: lines.join('\n') };
      }

      // admin+ 基础命令
      const lines = [
        '可用命令：',
        '',
        '📁 项目管理：',
        '  /pwd - 显示当前项目路径',
        '  /p [name|path] - 列出或切换项目',
        ...(isOwner ? ['  /bind <path> - 绑定新项目目录'] : []),
        '',
        '🔄 会话管理：',
        '  /new [名称] - 创建新会话（清空历史请用此命令，可选命名）',
        '  /s [cli|名称|序号|uuid] - 列出或切换会话（cli 查看未导入的 CLI 会话）',
        '  /name <新名称> - 重命名当前会话',
        '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
        '  /fork [名称] - 分支当前会话（从当前对话点创建分支）',
        '  /rewind [N] [chat|file|all] - 查看历史/撤销指定轮次（别名: /rw）',
        '  /compact - 压缩会话上下文（减少 token 用量）',
        '',
        '🤖 Agent 与模型：',
        '  /agent [name] - 查看或切换 Agent 后端',
        '  /model [model] - 查看或切换模型',
        '  /effort [level] - 查看或切换推理强度',
        '',
        '💬 聊天设置：',
        '  /activity [all|dm|owner|none] - 查看/控制中间输出显示模式',
        '  /chatmode [interactive|proactive] - 查看/切换会话模式（被动响应或主动推进）',
        '  /dispatch [mention|all] - 查看/切换群聊分发模式（仅@响应或广播响应，仅群聊）',
        '',
        '🔐 权限管理：',
        '  /perm - 查看当前权限模式',
        ...(isOwner ? ['  /perm <auto|bypass|request|edit|plan|noask> - 切换权限模式'] : []),
        '  /perm allow|always|deny - 审批权限请求',
        '',
        '🛠️ 运维：',
        '  /status - 显示会话状态',
        '  /stop - 中断当前任务',
        '  /check - 检查渠道状态',
        ...(isAdmin ? [
          '  /restart <type> - 重连该类型所有渠道实例（服务级，admin+）',
        ] : []),
        ...(isOwner ? [
          '  /restart - 重启服务',
        ] : []),
        ...(isOwner ? [
          '',
          '🧰 工具：',
          '  /file [channel] <path> - 发送项目内文件',
          '  /aid [list|show|new|delete|lookup|agentmd] - AID 身份管理',
          '  /storage [upload|download|ls|rm|quota] <aid> - 文件存储',
        ] : []),
        '',
        '❓ 帮助：',
        '  /help - 显示此帮助信息',
      ];
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /evolhelp 命令：返回 JSON 格式的命令列表（供程序解析）
    if (normalizedContent === '/evolhelp') {
      type CmdEntry = { command: string; aliases?: string[]; args?: string; description: string; category: string; roles: string[] };
      const cmds: CmdEntry[] = [];

      // 项目管理
      cmds.push({ command: '/pwd', description: '显示当前项目路径', category: '项目管理', roles: ['admin', 'owner'] });
      cmds.push({ command: '/p', aliases: ['/project', '/plist'], args: '[name|path]', description: '列出或切换项目', category: '项目管理', roles: ['admin', 'owner'] });
      if (isOwner) {
        cmds.push({ command: '/bind', args: '<path>', description: '绑定新项目目录', category: '项目管理', roles: ['owner'] });
      }

      // 会话管理
      cmds.push({ command: '/new', args: '[名称]', description: '创建新会话（清空历史请用此命令，可选命名）', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
      cmds.push({ command: '/s', aliases: ['/session', '/slist'], args: '[cli|名称|序号|uuid]', description: '列出或切换会话', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
      cmds.push({ command: '/name', aliases: ['/rename'], args: '<新名称>', description: '重命名当前会话', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
      cmds.push({ command: '/del', args: '<名称>', description: '删除指定会话（仅解绑，不删除文件）', category: '会话管理', roles: ['guest', 'admin', 'owner'] });
      if (isAdmin) {
        cmds.push({ command: '/fork', args: '[名称]', description: '分支当前会话（从当前对话点创建分支）', category: '会话管理', roles: ['admin', 'owner'] });
        cmds.push({ command: '/rewind', aliases: ['/rw'], args: '[N] [chat|file|all]', description: '查看历史/撤销指定轮次', category: '会话管理', roles: ['admin', 'owner'] });
        cmds.push({ command: '/compact', description: '压缩会话上下文（减少 token 用量）', category: '会话管理', roles: ['admin', 'owner'] });
      }

      // Agent 与模型
      if (isAdmin) {
        cmds.push({ command: '/agent', args: '[name]', description: '查看或切换 Agent 后端', category: 'Agent 与模型', roles: ['admin', 'owner'] });
        cmds.push({ command: '/model', args: '[model]', description: '查看或切换模型', category: 'Agent 与模型', roles: ['admin', 'owner'] });
        cmds.push({ command: '/effort', args: '[level]', description: '查看或切换推理强度', category: 'Agent 与模型', roles: ['admin', 'owner'] });
      }

      // 权限管理
      if (isAdmin) {
        cmds.push({ command: '/perm', args: isOwner ? '<auto|bypass|request|edit|plan|noask>' : undefined, description: '查看当前权限模式', category: '权限管理', roles: ['admin', 'owner'] });
        cmds.push({ command: '/perm', args: 'allow|always|deny', description: '审批权限请求', category: '权限管理', roles: ['admin', 'owner'] });
      }

      // 运维
      cmds.push({ command: '/status', description: '显示会话状态', category: '运维', roles: ['guest', 'admin', 'owner'] });
      cmds.push({ command: '/stop', description: '中断当前任务', category: '运维', roles: ['admin', 'owner'] });
      cmds.push({ command: '/check', description: '检查渠道状态', category: '运维', roles: ['guest', 'admin', 'owner'] });
      if (isAdmin) {
        cmds.push({ command: '/activity', args: '[all|dm|owner|none]', description: '查看/控制中间输出显示模式', category: '聊天设置', roles: ['admin', 'owner'] });
        cmds.push({ command: '/restart', args: '<channel>', description: '重连指定渠道', category: '运维', roles: ['admin', 'owner'] });
      }
      if (isOwner) {
        cmds.push({ command: '/restart', description: '重启服务', category: '运维', roles: ['owner'] });
        cmds.push({ command: '/file', args: '[channel] <path>', description: '发送项目内文件', category: '工具', roles: ['owner'] });
        cmds.push({ command: '/aid', args: '[list|show|new|delete|lookup|agentmd]', description: 'AID 身份管理', category: '工具', roles: ['owner'] });
        cmds.push({ command: '/storage', args: '[upload|download|ls|rm|quota] <aid>', description: '文件存储', category: '工具', roles: ['owner'] });
      }

      // 聊天设置
      if (isAdmin) {
        cmds.push({ command: '/chatmode', args: '[interactive|proactive]', description: '查看/切换会话模式（被动响应或主动推进）', category: '聊天设置', roles: ['admin', 'owner'] });
        cmds.push({ command: '/dispatch', args: '[mention|all]', description: '查看/切换群聊分发模式（仅@响应或广播响应）', category: '聊天设置', roles: ['admin', 'owner'] });
      }

      // 交互
      cmds.push({ command: '/ask', args: '<选项>', description: '回答 Agent 的交互式问题', category: '运维', roles: ['guest', 'admin', 'owner'] });

      // 帮助
      cmds.push({ command: '/help', description: '显示帮助信息', category: '帮助', roles: ['guest', 'admin', 'owner'] });

      const categories = [...new Set(cmds.map(c => c.category))];
      return { kind: 'command.result' as const, text: JSON.stringify({ commands: cmds, categories }) };
    }

    // /perm 命令：权限模式切换 + 权限审批（快速路径，不进入消息队列）
    if (normalizedContent.startsWith('/perm')) {
      const args = normalizedContent.slice(5).trim();

      // 先获取正确的 session 和 agent（话题可能用不同 agent）
      const permResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in permResult) return { kind: 'command.result' as const, text: permResult.error };
      const { session: permSession } = permResult;
      const permAgent = this.getAgent(channel, permSession.agentId);

      // /perm（无参数）：显示当前模式和可选模式
      if (!args) {
        if (!hasPermissionController(permAgent)) {
          return { kind: 'command.error' as const, text: '❌ 权限控制不可用' };
        }
        const currentMode = permSession.metadata?.permissionMode ?? DEFAULT_PERMISSION_MODE;
        const modes = permAgent.listModes();

        // 尝试发送 CommandCard 卡片
        {
          const availableModes = modes.filter(m => m.available);
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `perm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: permSession.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '🔐 权限模式',
              body: availableModes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.nameZh}) - ${m.description}`).join('\n'),
              buttons: availableModes.map(m => ({
                label: m.key === currentMode ? `✓ ${m.key}` : m.key,
                command: `/perm ${m.key}`,
                style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
                disabled: m.key === currentMode,
              })),
            },
          };

          const replyCtx = this.getReplyContext(permSession);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isOwner });
          if (cardResult === null) return null;
          return { kind: 'command.result' as const, text: cardResult };
        }

        // 降级：文本
        const modeList = modes.map(m => {
          const prefix = m.key === currentMode ? '✓' : ' ';
          const suffix = m.available ? '' : ' ⚠️ 不可用';
          return `  ${prefix} ${m.key} (${m.nameZh}) - ${m.description}${suffix}`;
        }).join('\n');
        if (isOwner) {
          return { kind: 'command.result' as const, text: `🔐 当前权限模式: ${currentMode}\n\n${modeList}\n\n用法:\n  /perm <模式>              切换权限模式\n  /perm allow|always|deny   审批权限请求` };
        }
        return { kind: 'command.result' as const, text: `🔐 当前权限模式: ${currentMode}` };
      }

      const parts = args.split(/\s+/);

      // /perm <mode> 或 /perm allow|always|deny：切换模式 / 快捷审批
      if (parts.length === 1) {
        const arg = parts[0];

        // /perm allow|always|deny：快捷审批
        // 优先走 InteractionRouter fallback（统一降级路径）
        if (arg === 'allow' || arg === 'always' || arg === 'deny') {
          const fb = await this.handleInteractionFallback('perm', arg, permSession.id, userId);
          if (fb.matched) return { kind: 'command.result' as const, text: fb.result ?? '✓ 已回答' };

          // fallback 不命中：走 permissionGateway 直接审批（兼容旧路径）
          if (!this.permissionGateway) {
            return { kind: 'command.error' as const, text: '❌ 权限审批未启用' };
          }
          const pendingIds = this.permissionGateway.getPendingRequests(permSession.id);
          if (pendingIds.length === 0) {
            return { kind: 'command.error' as const, text: '❌ 当前没有待审批的权限请求' };
          }
          if (pendingIds.length > 1) {
            return { kind: 'command.error' as const, text: `❌ 当前有 ${pendingIds.length} 个待审批请求，请指定 requestId：\n${pendingIds.map(id => `  /perm ${id} ${arg}`).join('\n')}` };
          }
          const requestId = pendingIds[0];
          const decision: PermissionDecision = arg;
          this.permissionGateway.resolvePermission(permSession.id, requestId, decision);
          const labels: Record<PermissionDecision, string> = {
            allow: '✓ 已授权（本次），继续执行……',
            always: '✓ 已授权（始终允许该工具），继续执行……',
            deny: '✓ 已拒绝'
          };
          return { kind: 'command.result' as const, text: labels[decision] };
        }

        // /perm <mode>：切换权限模式
        if (hasPermissionController(permAgent)) {
          const modes = permAgent.listModes();
          const matched = modes.find(m => m.key === arg);
          if (matched) {
            if (!matched.available) {
              return { kind: 'command.error' as const, text: `❌ ${matched.key} 模式当前不可用：${matched.unavailableReason}` };
            }
            // guest 和 admin 用户不能切换权限模式（仅 owner）
            if (!isOwner) {
              return { kind: 'command.error' as const, text: '❌ 权限模式切换仅限 owner' };
            }
            const metadata = permSession.metadata || {};
            metadata.permissionMode = arg;
            await this.sessionManager.updateSession(permSession.id, { metadata });
            return { kind: 'command.result' as const, text: `✓ 权限模式已切换为: ${matched.key} (${matched.nameZh})\n${matched.description}` };
          }
        }
        // 不是已知模式名也不是 allow/deny
        const modeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'auto|bypass|request|edit|plan|noask';
        return { kind: 'command.error' as const, text: `❌ 未知参数: ${arg}\n用法: /perm <${modeKeys}> 或 /perm allow|always|deny` };
      }

      // 双参数不再支持，提示正确用法
      const allModeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'auto|bypass|request|edit|plan|noask';
      return { kind: 'command.error' as const, text: `❌ 未知参数: ${args}\n用法: /perm <${allModeKeys}> 或 /perm allow|always|deny` };
    }

    // /ask 命令：回答 AskUserQuestion / ExitPlanMode 的交互式问题
    if (normalizedContent.startsWith('/ask')) {
      const args = normalizedContent.slice(4).trim();
      if (!args) {
        const askResult = await this.ensureSession(channel, channelId, threadId, chatType);
        if ('error' in askResult) return { kind: 'command.result' as const, text: askResult.error };
        const pendingIds = this.interactionRouter?.getPending(askResult.session.id) || [];
        if (pendingIds.length === 0) return { kind: 'command.result' as const, text: '当前没有待回答的问题' };
        return { kind: 'command.result' as const, text: `当前有 ${pendingIds.length} 个待回答问题，请回复 /ask <选项>` };
      }

      const askResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in askResult) return { kind: 'command.result' as const, text: askResult.error };

      const fb = await this.handleInteractionFallback('ask', args, askResult.session.id, userId);
      if (fb.matched) return { kind: 'command.result' as const, text: fb.result ?? '✓ 已回答' };
      return { kind: 'command.error' as const, text: '❌ 当前没有待回答的问题' };
    }

    // /resume 命令：返回当前项目的 Claude 会话记录（JSON）
    if (normalizedContent === '/resume' || normalizedContent.startsWith('/resume ')) {
      const resumeResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in resumeResult) return { kind: 'command.result' as const, text: resumeResult.error };
      const { session: resumeSession } = resumeResult;

      try {
        const { encodePath } = await import('../utils/cross-platform.js');
        const homeDir = os.homedir();
        const encodedPath = encodePath(resumeSession.projectPath);
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        if (!fs.existsSync(projectDir)) {
          return { kind: 'command.error' as const, text: '❌ 未找到 Claude 会话记录目录' };
        }

        const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        if (jsonlFiles.length === 0) {
          return { kind: 'command.error' as const, text: '❌ 当前项目没有 Claude 会话记录' };
        }

        const sessions: Array<{
          sessionId: string;
          lastMessageTime: string;
          firstUserMessage: string;
          model: string;
          turns: number;
          branch: string;
        }> = [];

        for (const file of jsonlFiles) {
          const filePath = path.join(projectDir, file);
          const sessionId = file.replace('.jsonl', '');
          let lastTimestamp = '';
          let firstUserMessage = '';
          let model = '';
          let branch = '';
          let turns = 0;

          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());

            for (const line of lines) {
              const event = JSON.parse(line);

              if (event.timestamp && event.timestamp > lastTimestamp) {
                lastTimestamp = event.timestamp;
              }

              if (event.gitBranch && !branch) {
                branch = event.gitBranch;
              }

              if (event.type === 'user' && event.message?.role === 'user') {
                const msgContent = event.message.content;
                const isToolResult = Array.isArray(msgContent) && msgContent.every((c: any) => c.type === 'tool_result');
                if (!isToolResult) {
                  turns++;
                  if (!firstUserMessage) {
                    if (typeof msgContent === 'string') {
                      firstUserMessage = msgContent.slice(0, 100);
                    } else if (Array.isArray(msgContent)) {
                      const textBlock = msgContent.find((c: any) => c.type === 'text');
                      if (textBlock?.text) {
                        firstUserMessage = textBlock.text.slice(0, 100);
                      }
                    }
                  }
                }
              }

              if (event.type === 'assistant' && event.message?.model && !model) {
                model = event.message.model;
              }
            }
          } catch {
            continue;
          }

          if (!lastTimestamp) continue;

          sessions.push({
            sessionId,
            lastMessageTime: lastTimestamp,
            firstUserMessage: firstUserMessage || '(无消息)',
            model: model || 'unknown',
            turns,
            branch: branch || 'unknown',
          });
        }

        sessions.sort((a, b) => b.lastMessageTime.localeCompare(a.lastMessageTime));

        return { kind: 'command.result' as const, text: JSON.stringify(sessions, null, 2) };
      } catch (error) {
        logger.error('[CommandHandler] /resume failed:', error);
        return { kind: 'command.error' as const, text: `❌ 读取会话记录失败: ${error instanceof Error ? error.message : '未知错误'}` };
      }
    }

    // /agent 命令：查看或切换 Agent 后端
    if (normalizedContent === '/agent' || normalizedContent.startsWith('/agent ')) {
      const args = normalizedContent.slice(6).trim();
      // 切换（带参）需权限：群聊 owner only，私聊 admin+；无参查询对所有人放开
      if (args && (activeChatType === 'group' ? !isOwner : !isAdmin)) {
        return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限管理员使用' };
      }
      const available = this.getAvailableBaseagents(channel);

      if (!args) {
        // currentAgent: 当前 session 的 baseagent，或该 channel 所属 evolagent 的 baseagent
        const currentAgent = activeSession?.agentId
          || this.agentRegistry?.resolveByChannel(channel)?.baseagent
          || this.parseDefaultBaseagent();

        // 尝试发送 CommandCard 卡片
        if (this.interactionRouter && available.length > 1) {
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: activeSession?.id || `agent-${Date.now()}`,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '🔌 切换 Agent',
              buttons: available.map(a => ({
                label: a === currentAgent ? `✓ ${a}` : a,
                command: `/agent ${a}`,
                style: (a === currentAgent ? 'primary' : 'default') as 'primary' | 'default',
                disabled: a === currentAgent,
              })),
            },
          };

          const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: activeChatType === 'group' ? isOwner : isAdmin });
          if (cardResult === null) return null;
          return { kind: 'command.result' as const, text: cardResult };
        }

        // 降级：文本
        const list = available.map(a => `${a === currentAgent ? ' ✓' : '  '} ${a}`).join('\n');
        const canSwitchAgent = activeChatType === 'group' ? isOwner : isAdmin;
        if (canSwitchAgent) {
          return { kind: 'command.result' as const, text: `当前 Agent: ${currentAgent}\n\n可用:\n${list}\n\n用法: /agent <name>` };
        }
        return { kind: 'command.result' as const, text: `当前 Agent: ${currentAgent}` };
      }

      if (!available.includes(args)) {
        return { kind: 'command.error' as const, text: `❌ 未知 Agent: ${args}\n可用: ${available.join(', ')}` };
      }

      const result = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in result) return { kind: 'command.error' as const, text: result.error };
      const { session } = result;

      // 取消原会话的 pending 权限请求和交互卡片
      if (this.permissionGateway) {
        this.permissionGateway.cancelAll(session.id);
      }
      if (this.interactionRouter) {
        this.interactionRouter.cancelAll(session.id);
      }

      // 切换到目标 agent（恢复已有会话或创建新会话）
      const newSession = await this.sessionManager.switchAgent(channel, channelId, session.projectPath, args);
      const hasExistingSession = newSession.agentSessionId ? '（恢复已有会话）' : '（新建会话）';
      const projectName = this.getProjectName(session.projectPath);
      let agentSwitchResponse = `✓ 已切换 Agent: ${args}\n  项目: ${projectName}\n  会话: ${newSession.name || '(未命名)'}\n  ${hasExistingSession}`;

      return { kind: 'command.result' as const, text: agentSwitchResponse };
    }

    // /setmodel 命令：返回 JSON 格式的模型列表（供程序解析）
    if (normalizedContent === '/setmodel' || normalizedContent.startsWith('/setmodel ')) {
      const setmodelResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in setmodelResult) return { kind: 'command.result' as const, text: setmodelResult.error };
      const { session: setmodelSession } = setmodelResult;
      const setmodelAgent = this.getAgent(channel, setmodelSession.agentId);

      const currentModel = hasModelSwitcher(setmodelAgent) ? setmodelAgent.getModel() : setmodelAgent.name;
      const efforts = getAvailableEfforts(setmodelAgent, currentModel);
      const currentEffort = setmodelAgent.getEffort?.() || 'auto';

      // 获取 API URL 用于请求 /models
      let apiBaseUrl: string | undefined;
      try {
        const configBaseUrl = this.getOwningAgent(channel)?.config?.baseagents?.claude?.baseUrl;
        const isPlaceholderUrl = configBaseUrl?.includes('api.anthropic.com');
        if (configBaseUrl && !isPlaceholderUrl) {
          apiBaseUrl = configBaseUrl;
        } else if (process.env.ANTHROPIC_BASE_URL) {
          apiBaseUrl = process.env.ANTHROPIC_BASE_URL;
        } else {
          const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
          if (fs.existsSync(claudeSettingsPath)) {
            const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
            if (claudeSettings.env?.ANTHROPIC_BASE_URL) {
              apiBaseUrl = claudeSettings.env.ANTHROPIC_BASE_URL;
            }
          }
        }
      } catch {}

      // 从 API 获取模型列表（OpenAI /v1/models 风格）
      type ModelListResponse = { object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> };
      let modelListData: ModelListResponse | null = null;
      if (apiBaseUrl) {
        try {
          const modelsUrl = apiBaseUrl.replace(/\/+$/, '') + '/v1/models';
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(modelsUrl, {
            signal: controller.signal,
            headers: { 'Authorization': `Bearer ${this.getOwningAgent(channel)?.config?.baseagents?.claude?.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || ''}` },
          });
          clearTimeout(timeout);
          if (resp.ok) {
            modelListData = await resp.json() as ModelListResponse;
          }
        } catch {}
      }

      // 兜底模型列表
      if (!modelListData || !modelListData.data || modelListData.data.length === 0) {
        const now = Math.floor(Date.now() / 1000);
        modelListData = {
          object: 'list',
          data: [
            { id: 'claude-opus-4-7', object: 'model', created: now, owned_by: 'anthropic' },
            { id: 'claude-opus-4-6', object: 'model', created: now, owned_by: 'anthropic' },
            { id: 'claude-sonnet-4-6', object: 'model', created: now, owned_by: 'anthropic' },
          ],
        };
      }

      return { kind: 'command.result' as const, text: JSON.stringify({
                current_model: currentModel,
                current_effort: currentEffort,
                available_efforts: efforts,
                models: modelListData,
              }, null, 2) };
    }

    // /model 命令：查看或切换模型/推理强度
    if (normalizedContent.startsWith('/model')) {
      const args = normalizedContent.slice(6).trim();

      // 获取当前会话（话题会话可能绑定不同 agent）
      const modelResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in modelResult) return { kind: 'command.result' as const, text: modelResult.error };
      const { session: modelSession } = modelResult;
      const modelAgent = this.getAgent(channel, modelSession.agentId);

      const models = hasModelSwitcher(modelAgent) ? modelAgent.listModels() : [];

      if (!args) {
        const currentModel = hasModelSwitcher(modelAgent) ? modelAgent.getModel() : modelAgent.name;
        const efforts = getAvailableEfforts(modelAgent, currentModel);
        const currentEffort = modelAgent.getEffort?.() || 'auto';

        // 尝试发送 CommandCard 卡片
        if (this.interactionRouter && models.length > 0) {
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `model-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: modelSession.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '🤖 切换模型',
              buttons: models.map((m: string) => ({
                label: m === currentModel ? `✓ ${m}` : m,
                command: `/model ${m}`,
                style: (m === currentModel ? 'primary' : 'default') as 'primary' | 'default',
                disabled: m === currentModel,
              })),
            },
          };

          const replyCtx = this.getReplyContext(modelSession);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
          if (cardResult === null) return null;
          return { kind: 'command.result' as const, text: cardResult };
        }

        // 降级：文本
        const modelList = models.map((m: string) => `  ${m === currentModel ? '✓' : ' '} ${m}`).join('\n');
        const effortHint = efforts.length > 0
          ? `\n推理强度: ${currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort}  (使用 /effort 调整)`
          : '';
        if (isAdmin) {
          return { kind: 'command.result' as const, text: `当前模型: ${currentModel}${effortHint}\n\n可用模型：\n${modelList}\n\n${formatModelUsage(modelAgent, currentModel)}` };
        }
        return { kind: 'command.result' as const, text: `当前模型: ${currentModel}${effortHint}` };
      }

      // 带参（切换/调整）需 admin+；无参查询已在上方返回
      if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：切换模型仅限管理员使用' };

      const parts = args.split(/\s+/);
      let newModel: string | undefined;
      let newEffort: Effort | undefined;

      if (parts.length === 1) {
        const arg = parts[0];
        const currentModel = hasModelSwitcher(modelAgent) ? modelAgent.getModel() : modelAgent.name;
        const efforts = getAvailableEfforts(modelAgent, currentModel);
        // effort 相关参数统一转发到 /effort
        if ((efforts as readonly string[]).includes(arg) || arg === 'auto') {
          const delegated = await this.handle(`/effort ${arg}`, channel, channelId, undefined, userId, threadId);
          return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
        } else if ((allEfforts as readonly string[]).includes(arg)) {
          return { kind: 'command.error' as const, text: `⚠️ 请使用 /effort ${arg} 调整推理强度` };
        } else if (models.includes(arg)) {
          newModel = arg;
        } else {
          const modelList = models.map((m: string) => `  ${m === currentModel ? '✓' : ' '} ${m}`).join('\n');
          const effortHint = efforts.length > 0 ? `\n\n推理强度请使用 /effort 命令` : '';
          return { kind: 'command.error' as const, text: `❌ 无效参数: ${arg}\n\n可用模型：\n${modelList}${effortHint}` };
        }
      } else {
        // 双参数：model effort
        const [modelArg, effortArg] = parts;
        if (!models.includes(modelArg)) {
          return { kind: 'command.error' as const, text: `❌ 无效的模型ID: ${modelArg}` };
        }
        const targetEfforts = getAvailableEfforts(modelAgent, modelArg);
        if (targetEfforts.length === 0) {
          return { kind: 'command.error' as const, text: `⚠️ ${modelArg} 不支持推理强度设置` };
        }
        if (!(targetEfforts as readonly string[]).includes(effortArg)) {
          const errorLabel = (allEfforts as readonly string[]).includes(effortArg) ? '⚠️' : '❌';
          return { kind: 'command.result' as const, text: `${errorLabel} ${modelArg} 不支持 ${effortArg} 推理强度\n可选: ${targetEfforts.join(' / ')}` };
        }
        newModel = modelArg;
        newEffort = effortArg as Effort;
      }

      // 运行时 model/effort 切换已通过 EvolAgent.setBaseagentModel/setBaseagentEffort 持久化

      const isCodexAgent = modelAgent.name === 'codex';
      const changes: string[] = [];

      if (newModel) {
        modelAgent.setModel?.(newModel);
        this.eventBus.publish({
          type: 'runner:model-changed',
          sessionId: modelSession.id,
          model: newModel,
          timestamp: Date.now()
        });
        changes.push(`模型: ${newModel}`);
      }

      if (newEffort) {
        modelAgent.setEffort?.(newEffort);
        changes.push(`推理强度: ${newEffort}`);
      }

      // 持久化：agent-owned channel 写到 agent.json；default 走原"就近原则"
      if (newModel) {
        const err = this.persistBaseagentModel(channel, modelAgent.name, newModel);
        if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
      }
      if (newEffort) {
        const err = this.persistBaseagentEffort(channel, modelAgent.name, newEffort);
        if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
      }

      return { kind: 'command.result' as const, text: `✓ 已切换\n  ${changes.join('\n  ')}` };
    }

    // /effort 命令：查看或切换推理强度
    if (normalizedContent.startsWith('/effort')) {
      const args = normalizedContent.slice(7).trim();

      const effortResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in effortResult) return { kind: 'command.result' as const, text: effortResult.error };
      const { session: effortSession } = effortResult;
      const effortAgent = this.getAgent(channel, effortSession.agentId);

      const currentModel = hasModelSwitcher(effortAgent) ? effortAgent.getModel() : effortAgent.name;
      const efforts = getAvailableEfforts(effortAgent, currentModel);
      const currentEffort = effortAgent.getEffort?.() || 'auto';

      if (efforts.length === 0) {
        return { kind: 'command.error' as const, text: '⚠️ 当前模型不支持推理强度设置' };
      }

      if (!args) {
        // /effort（无参数）：显示当前推理强度 + 发送 CommandCard 卡片
        if (this.interactionRouter) {
          const allItems = [...efforts, 'auto'];
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `effort-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: effortSession.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '⚡ 推理强度',
              buttons: allItems.map(e => ({
                label: e === currentEffort ? `✓ ${e}` : e,
                command: `/effort ${e}`,
                style: (e === currentEffort ? 'primary' : 'default') as 'primary' | 'default',
                disabled: e === currentEffort,
              })),
            },
          };

          const replyCtx = this.getReplyContext(effortSession);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
          if (cardResult === null) return null;
          return { kind: 'command.result' as const, text: cardResult };
        }

        // 降级：文本
        const effortDisplay = currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort;
        const allItems = [...efforts, 'auto'];
        const effortList = allItems.map(e => `  ${e === currentEffort ? '✓' : ' '} ${e}${e === 'auto' ? ' (SDK默认)' : ''}`).join('\n');
        if (isAdmin) {
          return { kind: 'command.result' as const, text: `⚡ 推理强度: ${effortDisplay}\n\n可选:\n${effortList}\n\n用法: /effort <level>` };
        }
        return { kind: 'command.result' as const, text: `⚡ 推理强度: ${effortDisplay}` };
      }

      // 带参（切换）需 admin+；无参查询已在上方返回
      if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：切换推理强度仅限管理员使用' };

      // /effort auto：恢复 SDK 默认
      if (args === 'auto') {
        effortAgent.setEffort?.(undefined);
        const err = this.persistBaseagentEffort(channel, effortAgent.name, undefined);
        if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };
        return { kind: 'command.result' as const, text: '✓ 推理强度已恢复为 auto (SDK默认)' };
      }

      // /effort <level>：切换推理强度
      if (!(efforts as readonly string[]).includes(args)) {
        if ((allEfforts as readonly string[]).includes(args)) {
          return { kind: 'command.error' as const, text: `⚠️ ${currentModel} 不支持 ${args} 推理强度\n可选: ${efforts.join(' / ')}` };
        }
        return { kind: 'command.error' as const, text: `❌ 无效参数: ${args}\n可选: ${efforts.join(' / ')} / auto` };
      }

      const newEffort = args as Effort;
      effortAgent.setEffort?.(newEffort);

      const err = this.persistBaseagentEffort(channel, effortAgent.name, newEffort);
      if (err) return { kind: 'command.result' as const, text: `${err}\n已更新运行时配置，但未持久化` };

      return { kind: 'command.result' as const, text: `✓ 推理强度: ${newEffort}` };
    }

    // /aid, /rpc, /storage — 转发到 CLI 执行
    if (normalizedContent === '/aid' || normalizedContent.startsWith('/aid ') ||
        normalizedContent === '/rpc' || normalizedContent.startsWith('/rpc ') ||
        normalizedContent === '/storage' || normalizedContent.startsWith('/storage ')) {
      if (!isOwner) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限 owner 使用' };

      // 无参数时返回用法说明
      if (normalizedContent === '/aid') {
        return { kind: 'command.result' as const, text: `🆔 AID 身份管理

用法:
  /aid list              列出本地所有 AID
  /aid show <aid>        查看 AID 详情
  /aid new <aid>         创建新 AID
  /aid delete <aid>      删除本地 AID
  /aid lookup <aid>      远程探测 AID
  /aid agentmd put <aid> 签名并上传 agent.md
  /aid agentmd get <aid> 下载并验签 agent.md` };
      }
      if (normalizedContent === '/rpc') {
        return { kind: 'command.result' as const, text: `📡 AUN RPC 调用

用法:
  /rpc --as <aid> --params <json>

参数格式:
  单行 JSON    单次调用
  多行 JSONL   逐行执行，失败即停

示例:
  /rpc --as myaid.agentid.pub --params {"method":"meta.ping","params":{}}` };
      }
      if (normalizedContent === '/storage') {
        return { kind: 'command.result' as const, text: `📦 文件存储

用法:
  /storage upload <aid> <file> <path> [--public]   上传文件
  /storage download <aid> <url> [local-path]       下载文件
  /storage ls <aid> [prefix]                       列文件
  /storage rm <aid> <path>                         删文件
  /storage quota <aid>                             查配额` };
      }

      const cliArgs = normalizedContent.slice(1); // strip leading /
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync('evolclaw', cliArgs.split(/\s+/), {
          timeout: 30000,
          encoding: 'utf-8',
          env: { ...process.env, AUN_LOG_INI_DISABLE: '1' },
        });
        const output = (stdout || '').trim();
        if (!output && stderr) return { kind: 'command.result' as const, text: `⚠ ${stderr.trim().slice(0, 500)}` };
        return { kind: 'command.result' as const, text: output || '(无输出)' };
      } catch (e: any) {
        const msg = e.stderr?.trim() || e.stdout?.trim() || String(e.message || e);
        return { kind: 'command.error' as const, text: `❌ ${msg.slice(0, 500)}` };
      }
    }


    if (normalizedContent === '/activity' || normalizedContent.startsWith('/activity ')) {
      const activityArg = normalizedContent.slice(9).trim();
      // 带参（写操作）需 admin+；无参查询对所有人开放（owner 门在具体切换点还有一道）
      if (activityArg && !isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限管理员使用' };

      // proactive 模式下流式输出全部静默，activity 配置无意义
      if (activeSession?.sessionMode === 'proactive') {
        return { kind: 'command.error' as const, text: '❌ 当前会话为 proactive 模式，不支持 activity 配置（流式输出已全部静默）' };
      }

      const modeMap: Record<string, 'all' | 'dm-only' | 'owner-dm-only' | 'none'> = {
        all: 'all',
        dm: 'dm-only',
        owner: 'owner-dm-only',
        none: 'none',
      };

      const currentMode = this.agentRegistry?.getShowActivities?.(channel) ?? 'all';

      // 模式描述列表（用于 body 和文本降级）
      const modeDescriptions: { key: string; configVal: string; label: string }[] = [
        { key: 'all', configVal: 'all', label: '全部显示' },
        { key: 'dm', configVal: 'dm-only', label: '仅私聊显示' },
        { key: 'owner', configVal: 'owner-dm-only', label: '仅 owner 私聊显示' },
        { key: 'none', configVal: 'none', label: '全部静默' },
      ];

      if (!activityArg) {
        // 尝试发送 CommandCard 卡片
        {
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `activity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: activeSession?.id || '',
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '📋 中间输出模式',
              body: modeDescriptions.map(m =>
                `${m.configVal === currentMode ? '✓' : '•'} **${m.key}** (${m.label})`
              ).join('\n'),
              buttons: modeDescriptions.map(m => ({
                label: m.configVal === currentMode ? `✓ ${m.key}` : m.key,
                command: `/activity ${m.key}`,
                style: (m.configVal === currentMode ? 'primary' : 'default') as 'primary' | 'default',
                disabled: m.configVal === currentMode,
              })),
            },
          };

          const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isOwner });
          if (cardResult === null) return null;
          // 卡片降级：fall through 到下方文本输出
        }

        // 降级：文本
        const modeList = modeDescriptions.map(m => {
          const prefix = m.configVal === currentMode ? '✓' : '•';
          return `  ${prefix} ${m.key} — ${m.label}`;
        }).join('\n');
        if (isOwner) {
          return { kind: 'command.result' as const, text: [`📋 中间输出模式: ${currentMode}`, '', modeList, '', '用法: /activity <all|dm|owner|none>'].join('\n') };
        }
        return { kind: 'command.result' as const, text: `📋 中间输出模式: ${currentMode}` };
      }

      const newMode = modeMap[activityArg];
      if (!newMode) {
        return { kind: 'command.error' as const, text: `❌ 无效参数: ${activityArg}\n可选: all / dm / owner / none` };
      }

      const label = modeDescriptions.find(m => m.configVal === newMode)?.label || newMode;

      if (newMode === currentMode) {
        return { kind: 'command.result' as const, text: `📋 中间输出模式已是 ${activityArg}（${label}）` };
      }

      // 切换操作仅 owner
      if (!isOwner) return { kind: 'command.error' as const, text: '❌ 中间输出模式切换仅限 owner' };

      if (this.agentRegistry?.setShowActivities) {
        this.agentRegistry.setShowActivities(channel, newMode);
      } else {
        return { kind: 'command.error' as const, text: `⚠️ 找不到通道 "${channel}" 所属的 self-agent，无法持久化` };
      }
      return { kind: 'command.result' as const, text: `✅ 中间输出模式: ${activityArg}（${label}）` };
    }

    // /chatmode 命令：查看/切换 session 会话模式（interactive | proactive）
    // - 查看：所有人可用
    // - 设置：单聊任何角色可设置；群聊仅管理员可设置
    if (normalizedContent === '/chatmode' || normalizedContent.startsWith('/chatmode ')) {
      const chatmodeResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in chatmodeResult) return { kind: 'command.result' as const, text: chatmodeResult.error };
      const chatmodeSession = chatmodeResult.session;

      const arg = normalizedContent.slice(9).trim();
      const currentMode = chatmodeSession.sessionMode || 'interactive';
      const chatmodeChatType = chatmodeSession.chatType || activeChatType;
      const canSwitch = chatmodeChatType !== 'group' || isAdmin;

      if (!arg) {
        // 尝试发送 CommandCard 卡片
        if (canSwitch) {
          const modes = [
            { key: 'interactive', name: '交互模式', desc: '被动响应：收到消息时才回复，回复直接显示' },
            { key: 'proactive', name: '主动模式', desc: '主动推进：流式输出静默，由 Agent 自调 ctl send 发声' },
          ];
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `chatmode-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: chatmodeSession.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '🔄 会话模式',
              body: modes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.name}) - ${m.desc}`).join('\n'),
              buttons: modes.map(m => ({
                label: m.key === currentMode ? `✓ ${m.key}` : m.key,
                command: `/chatmode ${m.key}`,
                style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
                disabled: m.key === currentMode,
              })),
            },
          };

          const replyCtx = this.getReplyContext(chatmodeSession);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
          if (cardResult === null) return null;
          // 卡片降级：fall through 到下方文本输出
        }

        // 降级：文本
        if (canSwitch) {
          return { kind: 'command.result' as const, text: [
                        `📋 会话模式: ${currentMode}`,
                        '',
                        '模式说明：',
                        '  • interactive — 交互模式：收到消息时才回复，回复直接显示',
                        '  • proactive   — 主动模式：流式输出静默，由 Agent 自调 ctl send 发声',
                        '',
                        '用法: /chatmode <interactive|proactive>',
                      ].join('\n') };
        }
        return { kind: 'command.result' as const, text: `📋 会话模式: ${currentMode}` };
      }

      if (arg !== 'interactive' && arg !== 'proactive') {
        return { kind: 'command.error' as const, text: `❌ 无效模式: ${arg}\n可选: interactive / proactive` };
      }

      if ((chatmodeSession.chatType || activeChatType) === 'group' && !isAdmin) {
        return { kind: 'command.error' as const, text: '❌ 无权限：群聊中切换会话模式仅限管理员使用' };
      }

      if (arg === currentMode) {
        return { kind: 'command.result' as const, text: `📋 当前会话模式已是 ${arg}` };
      }

      // 仅在真正需要切换时才要求会话空闲
      if (threadId) {
        const threadSession = await this.sessionManager.getThreadSession(channel, channelId, threadId);
        if (threadSession) {
          const threadAgent = this.getAgent(channel, threadSession.agentId);
          if (threadAgent.hasActiveStream(threadSession.id)) {
            return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
          }
        }
      } else if (agent.hasActiveStream(chatmodeSession.id)) {
        return { kind: 'command.error' as const, text: '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试' };
      }

      await this.sessionManager.updateSession(chatmodeSession.id, { sessionMode: arg });
      this.eventBus.publish({ type: 'session:chat-mode-changed', sessionId: chatmodeSession.id, mode: arg, timestamp: Date.now() });
      return { kind: 'command.result' as const, text: `✅ 会话模式已切换: ${arg}` };
    }

    // /dispatch 命令：查看/切换群聊分发模式（mention | all）
    // 仅群聊可用；群聊中设置需管理员权限
    if (normalizedContent === '/dispatch' || normalizedContent.startsWith('/dispatch ')) {
      const dispatchResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in dispatchResult) return { kind: 'command.result' as const, text: dispatchResult.error };
      const dispatchSession = dispatchResult.session;

      const dispatchChatType = dispatchSession.chatType || activeChatType;
      if (dispatchChatType !== 'group') {
        return { kind: 'command.error' as const, text: '❌ /dispatch 仅在群聊中可用' };
      }

      const arg = normalizedContent.slice(9).trim();
      const currentMode = dispatchSession.metadata?.dispatchMode || 'mention';

      if (!arg) {
        // 尝试发送 CommandCard 卡片
        if (isAdmin) {
          const modes = [
            { key: 'mention', name: '提及模式', desc: '仅当被 @ 提及（含 @all）时响应群消息' },
            { key: 'all', name: '广播模式', desc: '群内所有消息都触发响应' },
          ];
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `dispatch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: dispatchSession.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: '📡 分发模式',
              body: modes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.name}) - ${m.desc}`).join('\n'),
              buttons: modes.map(m => ({
                label: m.key === currentMode ? `✓ ${m.key}` : m.key,
                command: `/dispatch ${m.key}`,
                style: (m.key === currentMode ? 'primary' : 'default') as 'primary' | 'default',
                disabled: m.key === currentMode,
              })),
            },
          };

          const replyCtx = this.getReplyContext(dispatchSession);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
          if (cardResult === null) return null;
          // 卡片降级：fall through 到下方文本输出
        }

        // 降级：文本
        const lines: string[] = [];
        lines.push(`📋 分发模式: ${currentMode}`);
        lines.push('');
        lines.push('模式说明：');
        lines.push('  • mention — 提及模式：仅当被@提及时响应群消息(含@all)');
        lines.push('  • all     — 广播模式：群内所有消息都触发响应');
        if (isAdmin) {
          lines.push('');
          lines.push('用法: /dispatch <mention|all>');
        }
        return { kind: 'command.result' as const, text: lines.join('\n') };
      }

      if (arg !== 'mention' && arg !== 'all') {
        return { kind: 'command.error' as const, text: `❌ 无效模式: ${arg}\n可选: mention / all\n用法: /dispatch <模式>` };
      }

      if (!isAdmin) {
        return { kind: 'command.error' as const, text: '❌ 无权限：群聊中切换分发模式仅限管理员使用' };
      }

      if (arg === currentMode) {
        return { kind: 'command.result' as const, text: `📋 当前已是 ${arg}` };
      }

      const metadata = { ...(dispatchSession.metadata || {}), dispatchMode: arg };
      await this.sessionManager.updateSession(dispatchSession.id, { metadata });
      this.eventBus.publish({ type: 'session:dispatch-mode-changed', sessionId: dispatchSession.id, mode: arg, timestamp: Date.now() });
      return { kind: 'command.result' as const, text: `✅ 分发模式已切换: ${currentMode} → ${arg}` };
    }

    // /stop 命令：中断当前任务
    if (normalizedContent === '/stop') {
      const stopResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in stopResult) return { kind: 'command.result' as const, text: '当前没有正在处理的任务' };
      const { session: stopSession } = stopResult;
      const stopAgent = this.getAgent(channel, stopSession.agentId);
      const sessionKey = stopSession.id;

      const queueLength = this.messageQueue.getQueueLength(sessionKey);
      const hasActive = stopAgent.hasActiveStream(sessionKey);

      if (queueLength === 0 && !hasActive) {
        return { kind: 'command.result' as const, text: '当前没有正在处理的任务' };
      }

      await stopAgent.interrupt(sessionKey);
      // 发布中断事件，让 MessageProcessor 标记为 interrupted（而非 done）
      this.eventBus.publish({
        type: 'task:interrupted',
        sessionId: sessionKey,
        reason: 'stop',
        agentName: this.agentRegistry?.resolveByChannel(channel)?.name ?? '<unknown>',
      });
      // 强制清除 processing_state
      this.sessionManager.clearProcessing(sessionKey);
      return { kind: 'command.result' as const, text: '✓ 已发送中断信号，任务将尽快停止' };
    }

    // /clear 命令：通过 SDK /clear 清空会话历史
    if (normalizedContent === '/clear') {
      const result = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in result) return { kind: 'command.error' as const, text: result.error };
      const { session } = result;

      const sessionAgent = this.getAgent(channel, session.agentId);
      if (!sessionAgent.capabilities?.clear) {
        return { kind: 'command.error' as const, text: `❌ 当前 Agent (${sessionAgent.name}) 不支持 /clear\n\n可使用 /new 创建新会话替代` };
      }

      if (!session.agentSessionId) {
        return { kind: 'command.error' as const, text: '❌ 当前会话没有历史记录，无需清空' };
      }

      const projectPath = path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);

      const releaseLock = this.messageQueue.acquireLock(session.id);
      try {
        const cleared = await sessionAgent.clearSession(session.id, session.agentSessionId, projectPath);
        if (cleared) {
          await this.sessionManager.updateAgentSessionIdBySessionId(session.id, '');
          sessionAgent.updateSessionId(session.id, '');
          return { kind: 'command.result' as const, text: '✅ 已清空当前会话的对话历史' };
        } else {
          return { kind: 'command.error' as const, text: '❌ 清空会话失败，请稍后重试' };
        }
      } finally {
        releaseLock();
      }
    }

    // /compact 命令：手动压缩会话上下文
    if (normalizedContent === '/compact') {
      const result = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in result) return { kind: 'command.error' as const, text: result.error };
      const { session } = result;

      const sessionAgent = this.getAgent(channel, session.agentId);
      if (!sessionAgent.capabilities?.compact) {
        return { kind: 'command.error' as const, text: `❌ 当前 Agent (${sessionAgent.name}) 不支持 /compact` };
      }

      if (!session.agentSessionId) {
        return { kind: 'command.error' as const, text: '❌ 当前会话没有历史记录，无需压缩' };
      }

      const projectPath = path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);

      const releaseLock = this.messageQueue.acquireLock(session.id);
      try {
        if (sendMessage) {
          await sendMessage(channelId, '⏳ 正在压缩会话上下文...', this.getReplyContext(session));
        }

        const compacted = await sessionAgent.compactSession(session.id, session.agentSessionId, projectPath);
        if (compacted) {
          return { kind: 'command.result' as const, text: '✅ 会话上下文已压缩' };
        } else {
          return { kind: 'command.error' as const, text: '❌ 会话压缩失败，请稍后重试' };
        }
      } finally {
        releaseLock();
      }
    }

    // 尝试获取活跃会话（话题时直接查找话题 session）
    let session: Session | undefined;
    if (threadId) {
      session = await this.sessionManager.getOrCreateSession(channel, channelId, this.getEffectiveDefaultPath(channel), threadId);
    } else {
      session = await this.sessionManager.getActiveSession(channel, channelId);
    }

    // 对于需要会话的命令，如果没有会话则使用默认项目创建临时会话
    // 这样 /pwd、/status 等命令可以在没有活跃会话时返回默认项目信息
    if (!session && (
      normalizedContent.startsWith('/new') ||
      normalizedContent.startsWith('/bind') ||
      normalizedContent.startsWith('/project') ||
      normalizedContent === '/pwd' ||
      normalizedContent === '/status'
    )) {
      session = await this.sessionManager.getOrCreateSession(
        channel,
        channelId,
        this.getEffectiveDefaultPath(channel)
      );
    }

    // /status 命令：显示会话状态
    if (normalizedContent === '/status') {
      // session 现在总是存在（上面已自动创建）
      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 无法创建会话，请检查配置` };
      }

      const sessionKey = this.getQueueKey(session, channel, channelId);
      const sessionAgent = this.getAgent(channel, session.agentId);
      const isCurrentlyProcessing = this.messageQueue.isProcessing(sessionKey) || sessionAgent.hasActiveStream(sessionKey);
      const queueLength = this.messageQueue.getQueueLength(sessionKey);

      const isThread = !!session.threadId;
      let sessionStatus = isCurrentlyProcessing ? '处理中' : '空闲';
      // 处理中时显示时长
      if (isCurrentlyProcessing) {
        const elapsed = Date.now() - parseInt(session.processingState!, 10);
        if (!isNaN(elapsed) && elapsed > 0) {
          const sec = Math.floor(elapsed / 1000);
          sessionStatus = sec < 60 ? `处理中 (${sec}秒)` :
                          sec < 3600 ? `处理中 (${Math.floor(sec / 60)}分钟)` :
                          `处理中 (${Math.floor(sec / 3600)}小时)`;
        }
      }

      const projectName = this.getProjectName(session.projectPath);
      const owningAgent = this.getOwningAgent(channel);
      const agentName = owningAgent?.name ?? 'DefaultAgent';

      const health = await this.sessionManager.getHealthStatus(session.id);
      const timeSinceSuccess = Date.now() - health.lastSuccessTime;
      const timeStr = timeSinceSuccess < 60000 ? '刚刚' :
                      timeSinceSuccess < 3600000 ? `${Math.floor(timeSinceSuccess / 60000)}分钟前` :
                      `${Math.floor(timeSinceSuccess / 3600000)}小时前`;

      // 获取会话文件信息并同步 name
      let sessionTurns = 0;
      if (session.agentSessionId) {
        const fileInfo = this.sessionManager.getSessionFileInfo(session.projectPath, session.agentSessionId, session.agentId);
        sessionTurns = fileInfo.turns;
        if (fileInfo.title && fileInfo.title !== session.name) {
          await this.sessionManager.renameSession(session.id, fileInfo.title);
          session.name = fileInfo.title;
        }
      }

      const lines: string[] = [];
      const sessionMode = session.sessionMode || 'interactive';
      const dispatchMode = session.metadata?.dispatchMode || 'mention';
      const chatModeLine = `会话模式: ${sessionMode}`;
      const dispatchModeLine = session.chatType === 'group' ? `分发模式: ${dispatchMode}` : null;
      if (isAdmin) {
        lines.push(
          `📊 ${isThread ? '话题' : '会话'}状态 (Agent: ${agentName})：`,
          `渠道: ${this.resolveChannelType(channel)} / 项目: ${projectName} / 会话: ${session.name || '(未命名)'}`,
          `会话ID: ${session.id}`,
          `项目路径: ${session.projectPath}`,
          `会话状态: ${sessionStatus}`,
          chatModeLine,
          ...(dispatchModeLine ? [dispatchModeLine] : []),
          `会话轮数: ${sessionTurns}`,
        );
        if (health.consecutiveErrors > 0) {
          lines.push(`异常计数: ${health.consecutiveErrors}`);
        }
        lines.push(
          `最后成功: ${timeStr}`,
          `${session.agentId}会话: ${session.agentSessionId || '(未初始化)'}`,
          `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
          `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
        );
      } else {
        lines.push(
          `📊 ${isThread ? '话题' : '会话'}状态 (Agent: ${agentName})：`,
          `渠道: ${channel} / 项目: ${projectName} / ${session.agentId}会话`,
          `状态: ${sessionStatus}`,
          chatModeLine,
          ...(dispatchModeLine ? [dispatchModeLine] : []),
          `会话轮数: ${sessionTurns}`,
          `最后活跃: ${timeStr}`
        );
      }

      if (health.lastError) {
        lines.push('');
        lines.push(`最后错误: ${health.lastErrorType || 'unknown'}`);
        lines.push(`错误信息: ${health.lastError.substring(0, 100)}`);
      }

      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /new 命令：创建新会话（支持命名）
    if (normalizedContent.startsWith('/new')) {
      const sessionName = normalizedContent.slice(4).trim() || undefined;

      if (sessionName) {
        const existing = await this.sessionManager.getSessionByName(channel, channelId, sessionName);
        if (existing) {
          return { kind: 'command.error' as const, text: `❌ 会话名称 "${sessionName}" 已存在，请使用其他名称` };
        }
      }

      const projectPath = this.getEffectiveDefaultPath(channel);

      const newSession = await this.sessionManager.createNewSession(
        channel,
        channelId,
        projectPath,
        sessionName,
        session?.agentId || this.primaryRunnerKey
      );

      this.eventBus.publish({
        type: 'session:created',
        sessionId: newSession.id,
        channel,
        channelId,
        projectPath,
        name: sessionName,
        timestamp: Date.now()
      });

      if (session) {
        // Reset agent backend state so the new
        // session starts with a fresh conversation history
        await agent.clearSession(session.id, session.agentSessionId || '', session.projectPath);
        await agent.closeSession(session.id);
      }

      return { kind: 'command.result' as const, text: `✓ 已创建新会话${sessionName ? `: ${sessionName}` : ''}\n  项目: ${this.getProjectName(projectPath)}\n  之前的对话历史已保留，可通过 /s 查看` };
    }

    // /check 命令：检查渠道状态（guest 可用，详情仅 admin）/ 重连指定渠道（admin only）
    if (normalizedContent === '/check' || normalizedContent.startsWith('/check ')) {
      const subCmd = normalizedContent.slice('/check'.length).trim();

      // 限定可见渠道：agent-owned 通道仅显示该 agent 名下的渠道；
      // default 通道也仅显示 default 的渠道（不再展示 evolagents 的渠道）
      const checkOwningAgent = this.getOwningAgent(channel);
      let allowedChannels: Set<string>;
      if (checkOwningAgent) {
        allowedChannels = new Set(checkOwningAgent.channelInstanceNames());
      } else {
        // default 范围：不再有 default channel 概念，等价于"所有 channel"
        const defaultNames: string[] = [];
        for (const [name] of this.adapters) {
          const owner = this.agentRegistry?.resolveByChannel(name);
          if (!owner) defaultNames.push(name);
        }
        allowedChannels = new Set(defaultNames);
      }

      // Default: show system health check (non-admin 仅看摘要)
      const checkAgentName = checkOwningAgent?.name ?? 'DefaultAgent';
      const lines: string[] = [`📡 渠道状态 (Agent: ${checkAgentName})：`];
      // Group by channelType
      const groups = new Map<string, Array<{ name: string; status: string }>>();
      for (const [name] of this.adapters) {
        if (!allowedChannels.has(name)) continue;
        const type = this.channelTypeMap.get(name) || name;
        const ch = this.channelObjects.get(name);
        let status: string;
        if (ch?.getStatus) {
          const s = ch.getStatus();
          status = s.connected ? '✓ 已连接' : '⏳ 重连中';
        } else {
          status = '✓ 已注册';
        }
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type)!.push({ name, status });
      }

      if (!isAdmin) {
        // guest/user: 仅显示渠道健康摘要
        const total = [...groups.values()].flat().length;
        const healthy = [...groups.values()].flat().filter(i => i.status.includes('✓')).length;
        lines.push(`  ${healthy}/${total} 渠道正常`);
        return { kind: 'command.result' as const, text: lines.join('\n') };
      }

      for (const [type, instances] of groups) {
        if (instances.length === 1) {
          lines.push(`  ${type}: ${instances[0].status}`);
        } else {
          const parts = instances.map(i => {
            const seg = i.name.split('#');
            const instName = seg.length >= 3 ? seg.slice(2).join('#') : i.name;
            return `${i.status.includes('✓') ? '✓' : '⏳'} ${instName}`;
          });
          lines.push(`  ${type}: ${parts.join(', ')}`);
        }
      }

      // 当前 agent 名（用于 agent 维度 stats / queue 查询）
      const currentAgentName = checkOwningAgent?.name ?? '<unknown>';

      // 队列状态（按当前 agent 维度）
      lines.push('', '📬 队列状态：');
      lines.push(`  待处理消息: ${this.messageQueue.getQueueLengthByAgent(currentAgentName)}`);
      lines.push(`  处理中队列: ${this.messageQueue.getProcessingCountByAgent(currentAgentName)}`);

      // 运行概况（全局，进程级）
      lines.push('', '🖥️ 运行概况：');
      const uptimeMs = this.statsCollector
        ? this.statsCollector.getSnapshot().uptimeMs
        : process.uptime() * 1000;
      lines.push(`  运行时间: ${this.formatUptime(uptimeMs)}`);

      // 近 1 小时统计（按当前 agent 维度）
      if (this.statsCollector) {
        const snap = this.statsCollector.getSnapshot(currentAgentName);
        const h = snap.lastHour;
        lines.push('', '📊 近 1 小时统计：');
        lines.push(`  收到消息: ${h.received}`);
        lines.push(`  完成处理: ${h.completed}`);
        if (h.errors > 0) {
          const breakdown = Object.entries(h.errorsByType).map(([t, c]) => `${t}: ${c}`).join(', ');
          lines.push(`  处理出错: ${h.errors} (${breakdown})`);
        } else {
          lines.push(`  处理出错: 0`);
        }
        if (h.toolErrors > 0) {
          const toolBreakdown = Object.entries(h.toolErrorsByName).map(([t, c]) => `${t}: ${c}`).join(', ');
          lines.push(`  工具失败: ${h.toolErrors} (${toolBreakdown})`);
        }
        lines.push(`  被中断: ${h.interrupts}`);
        if (h.completed > 0) {
          lines.push(`  平均响应耗时: ${(h.avgResponseMs / 1000).toFixed(1)}s`);
        }
      }

      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /restart 命令：重启服务（owner only） / 重连指定渠道（admin+）
    if (normalizedContent === '/restart' || normalizedContent.startsWith('/restart ')) {
      const restartArg = normalizedContent.slice('/restart'.length).trim();

      // /restart <type> — 重连指定类型的所有渠道（admin only）
      if (restartArg) {
        if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：渠道重连仅限管理员使用' };
        const type = restartArg;

        // /restart 是服务级操作：重连该 type 下的所有实例（不分 agent）
        const scopedNames: string[] = [];
        for (const [name] of this.adapters) {
          if (this.channelTypeMap.get(name) === type) scopedNames.push(name);
        }

        if (scopedNames.length === 0) {
          return { kind: 'command.error' as const, text: `❌ 没有类型为 "${type}" 的渠道` };
        }

        const results: string[] = [];
        for (const name of scopedNames) {
          const ch = this.channelObjects.get(name);
          if (!ch) {
            results.push(`${name}: 未找到渠道对象`);
            continue;
          }
          if (!ch.reconnect) {
            results.push(`${name}: 不支持重连`);
            continue;
          }
          try {
            const result = await ch.reconnect();
            results.push(`${name}: ${result}`);
          } catch (e: any) {
            results.push(`${name}: 重连失败 - ${e?.message || e}`);
          }
        }
        return { kind: 'command.result' as const, text: `🔄 重连 ${type}:\n  ${results.join('\n  ')}` };
      }

      // /restart（无参数）— 重启整个服务（owner only）
      if (!isOwner) return { kind: 'command.error' as const, text: '❌ 无权限：服务重启仅限 owner 使用' };
      const allSessions = await this.sessionManager.listSessions(channel, channelId);
      const sessionsWithMessages = allSessions
        .filter(s => this.messageCache.hasMessages(s.id))
        .map(s => {
          const count = this.messageCache.getCount(s.id);
          return `${s.projectPath} 有 ${count} 条新消息`;
        });

      // 执行重启逻辑（共用于卡片回调和文本确认）
      const executeRestart = async () => {
        let replyContext: ReplyContext | undefined;
        if (threadId) {
          const threadSession = await this.sessionManager.getOrCreateSession(channel, channelId, this.getEffectiveDefaultPath(channel), threadId);
          replyContext = this.getReplyContext(threadSession);
        }
        const restartInfo: Record<string, any> = {
          channel,
          channelId,
          timestamp: Date.now(),
          ...(replyContext?.replyToMessageId ? { rootId: replyContext.replyToMessageId } : {}),
        };
        fs.writeFileSync(path.join(resolvePaths().dataDir, 'restart-pending.json'), JSON.stringify(restartInfo));

        const { spawn } = await import('child_process');
        spawn('node', [path.join(getPackageRoot(), 'dist', 'cli', 'index.js'), 'restart-monitor'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
        }).unref();

        this.eventBus.publish({ type: 'system:restart', channel, channelId });

        // 发 SIGTERM 而非直接 process.exit(0)，让 index.ts 的 shutdown() 先
        // 正常关闭所有 channel（包括 Feishu WebSocket close frame），
        // 避免 Feishu 服务端因连接异常断开而重推未 ack 的消息给新进程。
        setTimeout(() => {
          logger.info('[System] Restarting by user command...');
          process.kill(process.pid, 'SIGTERM');
        }, 1000);
        return true;
      };

      // 文本确认流程
      if (sessionsWithMessages.length > 0) {
        const restartKey = `${channel}-${channelId}`;
        const restartConfirmFile = path.join(resolvePaths().dataDir, `restart-confirm-${restartKey}.json`);

        if (fs.existsSync(restartConfirmFile)) {
          const confirmInfo = JSON.parse(fs.readFileSync(restartConfirmFile, 'utf-8'));
          const now = Date.now();

          if (now - confirmInfo.timestamp < 10000) {
            fs.unlinkSync(restartConfirmFile);
          } else {
            fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: now }));
            return { kind: 'command.result' as const, text: sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。' };
          }
        } else {
          fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: Date.now() }));
          return { kind: 'command.result' as const, text: sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。' };
        }
      }

      await executeRestart();
      return { kind: 'command.result' as const, text: '🔄 服务正在重启，请稍候...（约 5 秒后恢复）' };
    }

    // /pwd 命令：显示当前项目路径
    if (normalizedContent === '/pwd') {
      // session 现在总是存在（上面已自动创建）
      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 无法创建会话，请检查配置` };
      }

      const configName = this.getConfiguredProjectName(session.projectPath);
      if (configName) {
        return { kind: 'command.result' as const, text: `当前项目: ${configName}\n路径: ${session.projectPath}` };
      }
      return { kind: 'command.result' as const, text: `当前项目: ${session.projectPath}` };
    }

    // /file 命令：发送项目内文件，支持 /file path 和 /file channel path（owner only）
    if (normalizedContent.startsWith('/file')) {
      if (!isOwner) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限 owner 使用' };
      // 飞书会将 .md 等后缀自动转为 Markdown 链接: foo.md → [foo.md](http://foo.md/)
      // 还原: 将 [text](url) 替换为 text
      const rawArg = normalizedContent.slice(5).trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (!rawArg) {
        return { kind: 'command.result' as const, text: '用法: /file <相对路径> 或 /file <渠道> <相对路径>\n示例: /file src/index.ts\n示例: /file feishu report.md' };
      }

      // 解析目标通道：第一个 token 按实例名匹配，再按 channelType 匹配
      const tokens = rawArg.split(/\s+/);
      let targetChannel = channel;
      let targetLabel = channel;
      let filePath = rawArg;
      if (tokens.length >= 2) {
        const spec = tokens[0];
        if (this.adapters.has(spec)) {
          // 精确实例名
          targetChannel = spec;
          targetLabel = spec;
          filePath = tokens.slice(1).join(' ');
        } else {
          // 按 channelType 查找第一个匹配的实例
          for (const [name] of this.adapters) {
            if ((this.channelTypeMap.get(name) || name) === spec) {
              targetChannel = name;
              targetLabel = spec;
              filePath = tokens.slice(1).join(' ');
              break;
            }
          }
        }
      }
      const isCrossChannel = targetChannel !== channel;

      // 跨通道仅限 owner
      if (isCrossChannel && identity.role !== 'owner') {
        return { kind: 'command.error' as const, text: '❌ 跨通道发送仅限管理员' };
      }

      // 找目标 adapter
      const targetAdapter = this.adapters.get(targetChannel);
      if (!targetAdapter) {
        return { kind: 'command.error' as const, text: `❌ 通道 ${targetLabel} 未启用或不存在` };
      }
      if (!targetAdapter.capabilities?.file) {
        return { kind: 'command.error' as const, text: `❌ 通道 ${targetLabel} 不支持文件发送` };
      }

      // 获取 session（需要 projectPath）
      const sendResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in sendResult) return { kind: 'command.result' as const, text: sendResult.error };
      const sendSession = sendResult.session;

      // 路径安全校验
      if (path.isAbsolute(filePath)) {
        return { kind: 'command.error' as const, text: '❌ 不支持绝对路径\n请使用项目内的相对路径' };
      }
      if (filePath.split(path.sep).includes('..') || filePath.split('/').includes('..')) {
        return { kind: 'command.error' as const, text: '❌ 不支持 .. 路径穿越' };
      }

      const resolvedPath = path.resolve(sendSession.projectPath, filePath);

      // 存在性检查
      if (!fs.existsSync(resolvedPath)) {
        return { kind: 'command.error' as const, text: `❌ 文件不存在: ${filePath}` };
      }

      // 符号链接安全：realpath 后验证仍在项目目录内
      const realPath = fs.realpathSync(resolvedPath);
      const realProjectPath = fs.realpathSync(sendSession.projectPath);
      if (!realPath.startsWith(realProjectPath + path.sep) && realPath !== realProjectPath) {
        return { kind: 'command.error' as const, text: '❌ 路径不允许: 文件不在项目目录内' };
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        return { kind: 'command.error' as const, text: '❌ 暂不支持发送目录\n目录打包发送将在后续版本支持' };
      }
      const MAX_SIZE = 10 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        return { kind: 'command.error' as const, text: `❌ 文件过大: ${(stat.size / 1024 / 1024).toFixed(1)} MB (限制 10 MB)` };
      }

      // 找目标 channelId
      let targetChannelId = channelId;
      if (isCrossChannel) {
        const ownerPeerId = this.agentRegistry?.getOwner?.(targetChannel);
        targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannel, ownerPeerId) ?? '') : '';
        if (!targetChannelId) {
          return { kind: 'command.error' as const, text: `❌ 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息` };
        }
      }

      // 发送文件
      try {
        const replyCtx = isCrossChannel ? undefined : this.getReplyContext(sendSession);
        await targetAdapter.send(buildEnvelope({ channel: targetAdapter.channelName, channelId: targetChannelId, replyContext: replyCtx }), { kind: 'result.file', filePath: realPath });
        const sizeStr = stat.size < 1024 ? `${stat.size} B`
          : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
        return { kind: 'command.result' as const, text: isCrossChannel
                    ? `📎 文件已通过 ${targetLabel} 发送: ${filePath} (${sizeStr})`
                    : `✅ 已发送: ${filePath} (${sizeStr})` };
      } catch (error: any) {
        logger.error('[CommandHandler] /file failed:', error);
        return { kind: 'command.error' as const, text: `❌ 文件发送失败: ${error.message || error}` };
      }
    }

    // /plist 命令：列出所有项目
    if (normalizedContent === '/plist') {
      if (!policy.canListProjects(session?.chatType || 'private', identity.role)) {
        if (!session) {
          return { kind: 'command.error' as const, text: `❌ 当前群聊未绑定项目

请使用 /bind <项目路径> 绑定项目` };
        }

        const projectName = this.getProjectName(session.projectPath);

        const isProcessing = !!session.processingState;
        const status = isProcessing ? '[处理中]' : '[空闲]';

        return { kind: 'command.result' as const, text: `当前群聊绑定的项目：
  ${projectName} (${session.projectPath}) - ${status}

提示：群聊不支持切换项目` };
      }

      // 收集项目信息并按最近活跃排序（唯一来源：agent config projects.list）
      const entries: { name: string; projectPath: string; projectSession: any; isCurrent: boolean; updatedAt: number }[] = [];

      for (const [name, projectPath] of Object.entries(this.projects)) {
        // 跳过不存在的路径
        if (!fs.existsSync(projectPath)) continue;
        const isCurrent = session ? path.resolve(session.projectPath) === path.resolve(projectPath) : false;
        const projectSession = await this.sessionManager.getSessionByProjectPath(channel, channelId, projectPath);
        entries.push({
          name, projectPath, projectSession, isCurrent,
          updatedAt: projectSession?.updatedAt ?? 0,
        });
      }

      // 当前活跃项目置顶，其余按 updatedAt 降序
      entries.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });

      // 构建项目状态文本的辅助函数
      const buildStatusText = (entry: typeof entries[0]) => {
        const { projectSession, isCurrent } = entry;
        if (!projectSession) return '无会话';
        const parts: string[] = [];
        if (isCurrent) { parts.push('活跃'); } else { parts.push(formatIdleTime(Date.now() - projectSession.updatedAt)); }
        const isProcessing = !!projectSession.processingState;
        if (isProcessing) {
          const qLen = this.messageQueue.getQueueLength(projectSession.id);
          parts.push(qLen > 0 ? `[处理中，队列${qLen}条]` : '[处理中]');
        }
        const unread = this.messageCache.getCount(projectSession.id);
        if (unread > 0) { parts.push(`[${unread}条新消息]`); }
        else if (!isProcessing && !isCurrent) { parts.push('[空闲]'); }
        return parts.join(' ');
      };

      // 尝试发送 CommandCard 卡片（每个项目一个按钮，一键切换）
      if (entries.length > 0) {
        const bodyLines = entries.map(e => {
          const status = buildStatusText(e);
          const prefix = e.isCurrent ? '✓' : '•';
          return `${prefix} **${e.name}** (${e.projectPath})  ${status}`;
        });

        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `plist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: activeSession?.id || '',
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: '📂 项目列表',
            body: bodyLines.join('\n'),
            buttons: entries.map(e => ({
              label: e.isCurrent ? `✓ ${e.name}` : e.name,
              command: `/project ${e.name}`,
              style: (e.isCurrent ? 'primary' : 'default') as 'primary' | 'default',
              disabled: e.isCurrent,
            })),
          },
        };

        const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx, canWrite: isAdmin });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本列表
      const lines = ['可用项目:'];
      for (const entry of entries) {
        const prefix = entry.isCurrent ? '  ✓' : '   ';
        lines.push(`${prefix} ${entry.name} (${entry.projectPath}) - ${buildStatusText(entry)}`);
      }
      lines.push('', '提示: 使用 /p <名称> 切换项目');
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /project（无参数）：直接复用 /plist 逻辑（含卡片交互）
    if (normalizedContent === '/project') {
      if (!policy.canSwitchProject(session?.chatType || 'private', identity.role)) {
        // 群聊不能切换项目，交由 /plist 逻辑处理
      }
      const delegated = await this.handle('/plist', channel, channelId, undefined, userId, threadId);
      return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
    }

    // /project 命令：切换项目（支持名称或路径）
    if (normalizedContent.startsWith('/project ')) {
      if (!policy.canSwitchProject(session?.chatType || 'private', identity.role)) {
        return { kind: 'command.error' as const, text: `❌ 群聊不支持切换项目

群聊只能绑定一个项目。如需更换项目，请联系管理员重新配置。` };
      }

      let arg = normalizedContent.slice(9).trim();

      if (!arg) return { kind: 'command.result' as const, text: '用法: /p <name|path> 或 /project <name|path>' };

      // 检查确认标志
      const hasConfirm = arg.endsWith(' --confirm');
      if (hasConfirm) {
        arg = arg.slice(0, -10).trim();
      }

      let projectPath: string;
      let projectName: string;

      if (arg.includes('/')) {
        if (!path.isAbsolute(arg)) {
          return { kind: 'command.error' as const, text: '❌ 项目路径必须是绝对路径' };
        }
        if (!fs.existsSync(arg)) {
          return { kind: 'command.error' as const, text: `❌ 路径不存在: ${arg}` };
        }
        projectPath = arg;
        projectName = path.basename(arg);
      } else {
        projectPath = this.projects[arg];
        if (!projectPath) {
          return { kind: 'command.error' as const, text: `❌ 项目 "${arg}" 不存在\n提示: 使用 /p 查看可用项目` };
        }
        projectName = arg;
      }

      if (session) {
        const normalizedSessionPath = path.resolve(session.projectPath);
        const normalizedProjectPath = path.resolve(projectPath);
        if (normalizedSessionPath === normalizedProjectPath) {
          return { kind: 'command.result' as const, text: `当前已在项目: ${projectName}\n  路径: ${projectPath}` };
        }
      }

      // 群聊切换项目需要确认
      const isGroupChat = session?.chatType === 'group';
      if (isGroupChat && !hasConfirm) {
        return { kind: 'command.error' as const, text: `⚠️ 群聊切换项目风险提示：

切换项目将影响所有群成员的对话上下文，可能导致：
  • 当前项目的会话历史被切换
  • 正在处理的任务被中断
  • 其他成员的工作受到影响

确认切换请执行：
  /p ${projectName} --confirm` };
      }

      const currentAgentId = activeSession?.agentId || this.primaryRunnerKey;
      const newSession = await this.sessionManager.switchProject(channel, channelId, projectPath, currentAgentId);

      this.eventBus.publish({
        type: 'project:switched',
        sessionId: newSession.id,
        channel,
        channelId,
        projectPath,
        timestamp: Date.now()
      });

      const cachedEvents = this.messageCache.getEvents(newSession.id);

      const hasExistingSession = newSession.agentSessionId ? '（恢复已有会话）' : '（新建会话）';
      const currentAgent = newSession.agentId || this.primaryRunnerKey;
      let response = `✓ 已切换到项目: ${projectName}\n  路径: ${projectPath}\n  Agent: ${currentAgent}\n  ${hasExistingSession}`;

      if (cachedEvents.length > 0 && sendMessage) {
        for (const event of cachedEvents) {
          if (event.type === 'completed') {
            response += `\n\n后台任务完成`;
            if (event.metadata?.duration) {
              response += ` (耗时: ${Math.round(event.metadata.duration / 1000)}s)`;
            }
          } else if (event.type === 'error') {
            response += `\n\n后台任务失败: ${event.metadata?.errorType || '未知错误'}`;
          }
        }

        await sendMessage(channelId, response);

        for (const event of cachedEvents) {
          await sendMessage(channelId, event.message);
        }

        this.messageCache.clearEvents(newSession.id);

        return { kind: 'command.result' as const, text: '' };
      }

      return { kind: 'command.result' as const, text: response };
    }

    // /bind 命令：持久化项目到配置（不切换）（owner only）
    if (normalizedContent === '/bind') return { kind: 'command.result' as const, text: '用法: /bind <路径>' };
    if (normalizedContent.startsWith('/bind ')) {
      if (!isOwner) return { kind: 'command.error' as const, text: '❌ 无权限：此命令仅限 owner 使用' };
      const projectPath = normalizedContent.slice(6).trim();

      if (!projectPath) return { kind: 'command.result' as const, text: '用法: /bind <路径>' };

      if (!path.isAbsolute(projectPath)) {
        return { kind: 'command.error' as const, text: '❌ 项目路径必须是绝对路径' };
      }
      if (!fs.existsSync(projectPath)) {
        if (this.getOwningAgent(channel)?.config?.projects?.autoCreate) {
          fs.mkdirSync(projectPath, { recursive: true });
        } else {
          return { kind: 'command.error' as const, text: `❌ 路径不存在: ${projectPath}` };
        }
      }

      // 生成项目名称（使用目录名）
      const projectName = path.basename(projectPath);

      // 检查在当前 scope 内是否已存在
      const scopeProjects = this.getEffectiveProjects(channel);
      const existing = scopeProjects[projectName];
      if (existing) {
        if (existing === projectPath) {
          return { kind: 'command.result' as const, text: `项目 "${projectName}" 已存在\n  路径: ${projectPath}\n\n使用 /p ${projectName} 切换到该项目` };
        }
        return { kind: 'command.error' as const, text: `❌ 项目名称 "${projectName}" 已被占用\n  现有路径: ${existing}\n  新路径: ${projectPath}\n\n请重命名目录或手动编辑配置文件` };
      }

      // 写入：agent-owned channel → agent.json；default → agent config
      const err = await this.addProjectInScope(channel, projectName, projectPath);
      if (err) return { kind: 'command.result' as const, text: err };

      return { kind: 'command.result' as const, text: `✓ 已添加项目: ${projectName}\n  路径: ${projectPath}\n\n使用 /p ${projectName} 切换到该项目` };
    }

    // /slist 命令：列出当前项目的会话
    // /slist      — 仅 EvolClaw 会话
    // /slist cli  — 仅 CLI 会话（未导入的）
    if (normalizedContent === '/slist' || normalizedContent === '/slist cli') {
      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /p <项目> - 切换到指定项目` };
      }

      const showCliOnly = normalizedContent === '/slist cli';

      // /slist cli — 仅显示 CLI 会话
      if (showCliOnly) {
        const canImportCli = policy.canImportCliSession(session.chatType || 'private', identity.role);
        if (!canImportCli) {
          return { kind: 'command.error' as const, text: '❌ 当前无权查看 CLI 会话' };
        }

        const cliSessions = await this.sessionManager.scanCliSessions(session.projectPath, session.agentId);
        const sessions = await this.sessionManager.listSessions(channel, channelId);
        const currentProjectSessions = sessions.filter(s => s.projectPath === session.projectPath && s.agentId === session.agentId);
        const dbSessionIds = new Set(currentProjectSessions.map(s => s.agentSessionId).filter(Boolean));
        const orphanCliSessions = cliSessions.filter(c => !dbSessionIds.has(c.uuid));

        if (orphanCliSessions.length === 0) {
          return { kind: 'command.result' as const, text: `当前项目 ${path.basename(session.projectPath)} 没有未导入的 CLI 会话` };
        }

        // 构建显示数据（复用于卡片和文本）
        const cliDisplayItems = orphanCliSessions.map(c => {
          const time = new Date(c.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const message = this.sessionManager.readSessionFirstMessage(session.projectPath, c.uuid, session.agentId) || '(无消息)';
          const uuid = c.uuid.substring(0, 8);
          return { uuid, fullUuid: c.uuid, time, message };
        });

        // 尝试发送 CommandCard 卡片
        if (this.interactionRouter && cliDisplayItems.length > 0) {
          const bodyLines = cliDisplayItems.map(item =>
            `• ${item.time}  (${item.uuid})  "${item.message}"`
          );

          const interaction: InteractionRequest = {
            type: 'interaction',
            id: `slist-cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            channelId,
            sessionId: session.id,
            initiatorId: userId,
            kind: {
              kind: 'command-card',
              title: `📋 ${path.basename(session.projectPath)} CLI 会话 (${cliDisplayItems.length})`,
              body: bodyLines.join('\n'),
              buttons: cliDisplayItems.map(item => ({
                label: item.uuid,
                command: `/session ${item.uuid}`,
                style: 'default' as 'primary' | 'default',
              })),
            },
          };

          const replyCtx = this.getReplyContext(session);
          const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx });
          if (cardResult === null) return null;
          return { kind: 'command.result' as const, text: cardResult };
        }

        // 降级：文本列表
        const lines = [`当前项目 ${path.basename(session.projectPath)} 的 CLI 会话 (共 ${orphanCliSessions.length} 个):`, ''];
        for (const item of cliDisplayItems) {
          lines.push(`  ${item.time}  (${item.uuid})  "${item.message}"`);
        }
        lines.push('');
        lines.push('使用 /s <8位uuid> 导入并切换到 CLI 会话');
        return { kind: 'command.result' as const, text: lines.join('\n') };
      }

      // /slist — 仅显示 EvolClaw 会话
      const sessions = await this.sessionManager.listSessions(channel, channelId);
      const currentProjectSessions = sessions.filter(s => s.projectPath === session.projectPath && s.agentId === session.agentId);

      // 从 SDK 同步会话名称（发现 CLI 改名）
      try {
        const sdkSessions = await this.sessionManager.listSdkSessions(session.projectPath, session.agentId);
        for (const sdkSession of sdkSessions) {
          if (!sdkSession.title) continue;
          const dbSession = currentProjectSessions.find(s => s.agentSessionId === sdkSession.sessionId);
          if (dbSession && sdkSession.title !== dbSession.name) {
            await this.sessionManager.renameSession(dbSession.id, sdkSession.title);
            dbSession.name = sdkSession.title;
          }
        }
      } catch (error) {
        logger.debug('[CommandHandler] SDK listSessions sync failed (non-critical):', error);
      }

      // 构建可显示会话列表（复用于卡片和文本）
      const hideTopics = currentProjectSessions.length > 10;
      const topicCount = hideTopics ? currentProjectSessions.filter(s => s.threadId).length : 0;
      const maxDisplay = 10;

      const displaySessions: Array<{ session: any; index: number; isActive: boolean; name: string; status: string; idleTime: string; fileMissing: boolean }> = [];
      let displayIndex = 0;
      for (let i = 0; i < currentProjectSessions.length; i++) {
        const s = currentProjectSessions[i];
        if (hideTopics && s.threadId) continue;
        if (displayIndex >= maxDisplay) break;

        const isActive = (s.metadata as any)?.isActive === true;
        displayIndex++;
        const name = s.name || '(未命名)';
        const idleTime = formatIdleTime(Date.now() - s.updatedAt);
        const fileMissing = !!(s.agentSessionId && !this.sessionManager.checkSessionFileExists(s.projectPath, s.agentSessionId, s.agentId));

        let status = '[空闲]';
        if (fileMissing) {
          status = '[会话文件缺失]';
        } else if (!!s.processingState) {
          status = '[处理中]';
        } else if (isActive) {
          status = '[活跃]';
        }

        displaySessions.push({ session: s, index: displayIndex, isActive, name, status, idleTime, fileMissing });
      }

      // 尝试发送 CommandCard 卡片（每个会话一个按钮，一键切换）
      if (this.interactionRouter && displaySessions.length >= 1) {
        const bodyLines = displaySessions.map(ds => {
          const prefix = ds.isActive ? '✓' : '•';
          const threadTag = ds.session.threadId ? '[话题] ' : '';
          const uuid = ds.session.agentSessionId ? `(${ds.session.agentSessionId.substring(0, 8)})` : '';
          const fileMark = ds.fileMissing ? '❌ ' : '';
          return `${prefix} ${ds.index}. ${threadTag}${fileMark}**${ds.name}** ${uuid}  ${ds.idleTime} ${ds.status}`;
        });

        const interaction: InteractionRequest = {
          type: 'interaction',
          id: `slist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
          channelId,
          sessionId: session.id,
          initiatorId: userId,
          kind: {
            kind: 'command-card',
            title: `📋 ${path.basename(session.projectPath)} 会话列表`,
            body: bodyLines.join('\n'),
            buttons: displaySessions.map(ds => {
              const shortId = ds.session.agentSessionId ? ds.session.agentSessionId.substring(0, 8) : ds.name;
              return {
                label: ds.isActive ? `✓ ${ds.index}. ${shortId}` : `${ds.index}. ${shortId}`,
                command: `/session ${ds.index}`,
                style: (ds.isActive ? 'primary' : 'default') as 'primary' | 'default',
                disabled: ds.isActive,
              };
            }),
          },
        };

        const replyCtx = this.getReplyContext(session);
        const cardResult = await this.sendCommandCard({ channel, channelId, interaction, replyCtx });
        if (cardResult === null) return null;
        return { kind: 'command.result' as const, text: cardResult };
      }

      // 降级：文本列表
      const lines = [`当前项目 ${path.basename(session.projectPath)} 的 [${session.agentId}] 会话列表:`, ''];

      if (currentProjectSessions.length > 0) {
        for (const ds of displaySessions) {
          const prefix = ds.isActive ? '  ✓' : '   ';
          const num = `${ds.index}.`;
          const threadTag = ds.session.threadId ? '[话题] ' : '';
          const uuid = ds.session.agentSessionId ? `(${ds.session.agentSessionId.substring(0, 8)})` : '';
          if (ds.fileMissing) {
            lines.push(`${prefix} ${num} ${threadTag}❌ ${ds.name} ${uuid} - ${ds.idleTime} ${ds.status}`);
          } else {
            lines.push(`${prefix} ${num} ${threadTag}${ds.name} ${uuid} - ${ds.idleTime} ${ds.status}`);
          }
        }
        const hiddenCount = currentProjectSessions.length - displayIndex - topicCount;
        if (topicCount > 0 || hiddenCount > 0) {
          const parts: string[] = [];
          if (hiddenCount > 0) parts.push(`${hiddenCount} 个更早的会话`);
          if (topicCount > 0) parts.push(`${topicCount} 个话题会话`);
          lines.push(`\n  (已隐藏 ${parts.join('、')})`);
        }
        lines.push('');
      }

      lines.push('使用 /s <序号、name或8位uuid> 切换会话');
      lines.push('使用 /s cli 查看 CLI 会话');
      return { kind: 'command.result' as const, text: lines.join('\n') };
    }

    // /session（无参数）：直接复用 /slist 逻辑（含卡片交互）
    if (normalizedContent === '/session') {
      const delegated = await this.handle('/slist', channel, channelId, undefined, userId, threadId);
      return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
    }

    // /session cli（= /s cli）：列出未导入的 CLI 会话
    if (normalizedContent === '/session cli') {
      const delegated = await this.handle('/slist cli', channel, channelId, undefined, userId, threadId);
      return typeof delegated === 'string' ? { kind: 'command.result' as const, text: delegated } : delegated;
    }

    // /session 或 /s 命令：切换会话
    if (normalizedContent.startsWith('/session ')) {
      const sessionName = normalizedContent.slice(9).trim();

      if (!sessionName) return { kind: 'command.result' as const, text: '用法: /s <序号、会话名称或前8位UUID>' };

      let targetSession = await this.sessionManager.getSessionByName(channel, channelId, sessionName);

      // 序号切换：纯数字时按 /slist 显示的序号匹配（超过10个时隐藏非活跃话题会话）
      if (!targetSession && /^\d+$/.test(sessionName) && session) {
        const idx = parseInt(sessionName, 10);
        const allSessions = await this.sessionManager.listSessions(channel, channelId);
        const projectSessions = allSessions.filter(s => s.projectPath === session.projectPath && s.agentId === session.agentId);
        // 与 /slist 显示逻辑一致：超过10个时隐藏非活跃话题会话
        const hideTopics = projectSessions.length > 10;
        const visibleSessions = hideTopics
          ? projectSessions.filter(s => !s.threadId)
          : projectSessions;
        if (idx >= 1 && idx <= visibleSessions.length) {
          targetSession = visibleSessions[idx - 1];
        } else {
          return { kind: 'command.error' as const, text: `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话` };
        }
      }

      if (!targetSession && sessionName.length >= 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      const canImport = policy.canImportCliSession(session?.chatType || 'private', identity.role);
      if (!targetSession && sessionName.length >= 8 && canImport) {
        const projectPaths = Object.values(this.projects);

        if (session) {
          projectPaths.unshift(session.projectPath);
        }

        for (const projectPath of projectPaths) {
          const currentAgentId = session?.agentId || this.primaryRunnerKey;
          const cliSessions = await this.sessionManager.scanCliSessions(projectPath, currentAgentId);
          const cliSession = cliSessions.find(c => c.uuid.startsWith(sessionName));

          if (cliSession) {
            const imported = await this.sessionManager.importCliSession(channel, channelId, projectPath, cliSession.uuid, currentAgentId);
            this.eventBus.publish({ type: 'session:imported', sessionId: imported.id, agentSessionId: cliSession.uuid, projectPath });
            const projectName = this.getProjectName(projectPath);
            return { kind: 'command.result' as const, text: `✓ 已导入 CLI 会话: ${imported.name}\n  项目: ${projectName}\n  将继续之前的对话历史` };
          }
        }
      }

      if (!targetSession) {
        return { kind: 'command.error' as const, text: `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话` };
      }

      const lastInput = targetSession.agentSessionId
        ? this.sessionManager.readSessionLastUserMessage(targetSession.projectPath, targetSession.agentSessionId, targetSession.agentId)
        : null;
      const lastInputLine = lastInput ? `\n  最后输入: "${lastInput}"` : '';

      if (!session) {
        const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);
        if (!switched) {
          return { kind: 'command.error' as const, text: `❌ 切换会话失败` };
        }
        return { kind: 'command.result' as const, text: `✓ 已切换到会话: ${targetSession.name || sessionName}\n  项目: ${path.basename(targetSession.projectPath)}${lastInputLine}` };
      }

      if (targetSession.id === session.id) {
        return { kind: 'command.result' as const, text: `当前已在会话: ${targetSession.name || sessionName}` };
      }

      // 阻止从主会话切换到话题会话
      if (!session.threadId && targetSession.threadId) {
        return { kind: 'command.error' as const, text: `❌ 无法从主会话切换到话题会话\n话题会话仅在对应话题内可用` };
      }

      const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);

      if (!switched) {
        return { kind: 'command.error' as const, text: `❌ 切换会话失败` };
      }

      this.eventBus.publish({ type: 'session:switched', sessionId: targetSession.id, fromSessionId: session.id, toSessionId: targetSession.id });

      const continueHint = lastInput ? '\n  将继续之前的对话历史' : '\n  当前会话未有发言';
      return { kind: 'command.result' as const, text: `✓ 已切换到会话: ${targetSession.name || sessionName}${continueHint}${lastInputLine}` };
    }

    // /rename 或 /name 命令：重命名当前会话
    if (normalizedContent === '/rename' || normalizedContent === '/name') {
      return { kind: 'command.result' as const, text: '用法: /name <新名称> 或 /rename <新名称>' };
    }
    if (normalizedContent.startsWith('/rename ')) {
      const newName = normalizedContent.slice(8).trim();

      if (!newName) return { kind: 'command.result' as const, text: '用法: /name <新名称> 或 /rename <新名称>' };

      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /session <名称> - 切换到已有会话` };
      }

      const existing = await this.sessionManager.getSessionByName(channel, channelId, newName);
      if (existing && existing.id !== session.id) {
        return { kind: 'command.error' as const, text: `❌ 会话名称 "${newName}" 已存在，请使用其他名称` };
      }

      const oldName = session.name || '(未命名)';
      const success = await this.sessionManager.renameSession(session.id, newName);

      if (!success) {
        return { kind: 'command.error' as const, text: `❌ 重命名失败` };
      }

      this.eventBus.publish({ type: 'session:renamed', sessionId: session.id, oldName, newName });

      return { kind: 'command.result' as const, text: `✓ 已将当前会话重命名为: ${newName}` };
    }

    // /del 命令：删除指定会话（仅解绑，不删除文件）
    if (normalizedContent.startsWith('/del ')) {
      const sessionName = normalizedContent.slice(5).trim();

      if (!sessionName) return { kind: 'command.result' as const, text: '用法: /del <序号、会话名称或前8位UUID>' };

      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话` };
      }

      // 权限检查：policy 控制谁可以删除会话
      if (!policy.canDeleteSession(session.chatType || 'private', identity.role)) {
        return { kind: 'command.error' as const, text: `❌ 无权限：群聊中仅管理员可删除会话` };
      }

      let targetSession = await this.sessionManager.getSessionByName(channel, channelId, sessionName);

      // 序号删除（与 /slist 显示序号一致）
      if (!targetSession && /^\d+$/.test(sessionName)) {
        const idx = parseInt(sessionName, 10);
        const allSessions = await this.sessionManager.listSessions(channel, channelId);
        const projectSessions = allSessions.filter(s => s.projectPath === session.projectPath && s.agentId === session.agentId);
        const hideTopics = projectSessions.length > 10;
        const visibleSessions = hideTopics
          ? projectSessions.filter(s => !s.threadId)
          : projectSessions;
        if (idx >= 1 && idx <= visibleSessions.length) {
          targetSession = visibleSessions[idx - 1];
        } else {
          return { kind: 'command.error' as const, text: `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话` };
        }
      }

      if (!targetSession && sessionName.length >= 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      if (!targetSession) {
        return { kind: 'command.error' as const, text: `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话` };
      }

      if (targetSession.id === session.id) {
        return { kind: 'command.error' as const, text: `❌ 无法删除当前活跃会话\n请先切换到其他会话` };
      }

      const success = await this.sessionManager.unbindSession(targetSession.id);

      if (!success) {
        return { kind: 'command.error' as const, text: `❌ 删除失败` };
      }

      this.eventBus.publish({ type: 'session:deleted', sessionId: targetSession.id });

      const targetAgent = this.getAgent(channel, targetSession.agentId);
      await targetAgent.closeSession(targetSession.id);

      return { kind: 'command.result' as const, text: `✓ 已删除会话: ${targetSession.name || sessionName}\n会话文件已保留，可通过 CLI 访问` };
    }

    // /fork 命令：分支当前会话
    if (normalizedContent === '/fork' || normalizedContent.startsWith('/fork ')) {
      const forkName = normalizedContent.slice(5).trim() || undefined;

      if (!session) {
        return { kind: 'command.error' as const, text: `❌ 当前没有活跃会话，无法分支` };
      }

      if (!session.agentSessionId) {
        return { kind: 'command.error' as const, text: `❌ 当前会话尚未初始化对话，无法分支\n\n请先发送一条消息，然后再使用 /fork` };
      }

      const forkAgent = this.getAgent(channel, session.agentId);
      if (!forkAgent.capabilities?.fork) {
        return { kind: 'command.error' as const, text: `❌ 当前 Agent (${forkAgent.name}) 不支持 /fork\n\n可使用 /new 创建新会话替代` };
      }

      try {
        const forkedSessionId = await forkAgent.forkSession!(session.agentSessionId, session.projectPath, forkName);
        const newSession = await this.sessionManager.createForkedSession(session, forkedSessionId, forkName);

        this.eventBus.publish({ type: 'session:forked', sessionId: newSession.id, sourceSessionId: session.id, name: forkName });

        return { kind: 'command.result' as const, text: `✅ 会话已分支: ${newSession.name}\n新会话已激活，可以继续对话\n\n使用 /s 查看所有会话，/s <名称> 切换回原会话` };
      } catch (error) {
        logger.error('[CommandHandler] Fork session failed:', error);
        return { kind: 'command.error' as const, text: `❌ 会话分支失败: ${error instanceof Error ? error.message : '未知错误'}` };
      }
    }

    // /rewind 命令：查看历史 / 回退会话
    if (normalizedContent === '/rewind' || normalizedContent.startsWith('/rewind ')) {
      const result = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in result) return { kind: 'command.error' as const, text: result.error };
      const { session } = result;

      const rewindAgent = this.getAgent(channel, session.agentId);

      if (rewindAgent.name !== 'claude') {
        return { kind: 'command.error' as const, text: '❌ /rewind 仅支持 Claude 后端' };
      }
      if (!session.agentSessionId) {
        return { kind: 'command.error' as const, text: '❌ 当前会话无历史记录\n\n请先发送一条消息，然后再使用 /rewind' };
      }
      if (!rewindAgent.getSessionMessages) {
        return { kind: 'command.error' as const, text: '❌ 当前 Agent 不支持 /rewind' };
      }

      const args = normalizedContent.slice('/rewind'.length).trim();

      if (!args) {
        return { kind: 'command.result' as const, text: await this.handleRewindList(session, rewindAgent) };
      }

      // 带参（执行回退，会删除文件/改对话）需 admin+
      if (!isAdmin) return { kind: 'command.error' as const, text: '❌ 无权限：回退操作仅限管理员使用' };

      const parts = args.split(/\s+/);
      const turnNum = parseInt(parts[0], 10);
      if (isNaN(turnNum) || turnNum < 1) {
        return { kind: 'command.error' as const, text: '❌ 无效轮次，用法：/rewind <N> chat|file|all（撤销第N轮）' };
      }

      const mode = parts[1]?.toLowerCase();
      if (!mode) {
        return { kind: 'command.error' as const, text: `❌ 请指定回退模式：/rewind ${turnNum} chat | file | all（撤销第${turnNum}轮）` };
      }
      if (!['chat', 'file', 'all'].includes(mode)) {
        return { kind: 'command.error' as const, text: `❌ 无效模式 "${mode}"，可选：chat | file | all` };
      }

      return { kind: 'command.result' as const, text: await this.handleRewind(session, rewindAgent, turnNum, mode as 'chat' | 'file' | 'all') };
    }

    // /repair 命令：检查并修复会话文件
    if (normalizedContent === '/repair') {
      const repairResult = await this.ensureSession(channel, channelId, threadId, chatType);
      if ('error' in repairResult) return { kind: 'command.result' as const, text: repairResult.error };
      const { session: repairSession } = repairResult;      const repairAgent = this.getAgent(channel, repairSession.agentId);
      const { checkSessionFile, backupSessionFile } = await import('./session/session-file-health.js');

      try {
        if (!repairSession.agentSessionId) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 未发现问题（新会话）\n- 已重置异常计数器` };
        }

        // 通过 agent 定位 session 文件
        const sessionFile = repairAgent.resolveSessionFile?.(repairSession.agentSessionId, repairSession.projectPath) ?? null;

        if (!sessionFile) {
          // 文件不存在（已被删除或从未创建），直接重置
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 会话文件不存在（可能已被清理）\n- 已重置异常计数器` };
        }

        const healthCheck = await checkSessionFile(sessionFile);

        if (healthCheck.corrupt) {
          const backupPath = await backupSessionFile(sessionFile);
          const fsPromises = await import('fs/promises');
          await fsPromises.unlink(sessionFile);
          await this.sessionManager.updateAgentSessionIdBySessionId(repairSession.id, '');
          repairAgent.updateSessionId(repairSession.id, '');
          await this.sessionManager.resetHealthStatus(repairSession.id);

          return { kind: 'command.result' as const, text: `✓ 修复完成\n\n检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n修复操作：\n- 已备份损坏文件\n- 已删除损坏文件\n- 已重置异常计数器\n\n备份位置：${backupPath}` };
        }

        if (healthCheck.issues.length > 0) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return { kind: 'command.error' as const, text: `⚠️ 检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n建议使用 /new 创建新会话\n\n已重置异常计数器，可继续使用当前会话。` };
        }

        await this.sessionManager.resetHealthStatus(repairSession.id);
        return { kind: 'command.result' as const, text: `✓ 修复完成\n\n修复内容：\n- 未发现问题\n- 已重置异常计数器` };
      } catch (error: any) {
        logger.error('[Repair] Failed:', error);
        return { kind: 'command.error' as const, text: `❌ 修复失败: ${error.message}` };
      }
    }

    // /safe 命令：安全模式已禁用
    if (normalizedContent === '/safe') {
      return { kind: 'command.result' as const, text: `ℹ️ 安全模式已禁用\n\n如需重置会话，请使用 /new 创建新会话。` };
    }

    return null;
  }

  // ── /rewind helpers ──

  private async handleRewindList(session: Session, agent: AgentRunnerFull): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(session.agentSessionId!, session.projectPath);
      const turns = this.buildTurnList(messages);

      if (turns.length === 0) {
        return '📋 当前会话暂无对话记录';
      }

      const lines = turns.map(t => `#${t.index} ${t.userContent}`);
      return [
        `📋 会话历史 (共 ${turns.length} 轮)`,
        '',
        ...lines,
        '',
        '💡 /rewind <N> chat|file|all — 撤销第N轮',
      ].join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Failed to read session messages:', error);
      return `❌ 读取会话历史失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  private async handleRewind(
    session: Session,
    agent: AgentRunnerFull,
    turnNum: number,
    mode: 'chat' | 'file' | 'all',
  ): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(session.agentSessionId!, session.projectPath);
      const turns = this.buildTurnList(messages);

      if (turnNum < 1 || turnNum > turns.length) {
        return `❌ 轮次超出范围，当前共 ${turns.length} 轮`;
      }

      // /rewind N = 撤销第N轮（及之后），保留 1..N-1
      const rewindTarget = turns[turnNum - 1]; // 被撤销的轮次（用于文件回退）
      const keepTarget = turnNum >= 2 ? turns[turnNum - 2] : null; // 保留到的轮次（用于对话回退）
      const results: string[] = [];

      // 文件回退（立即执行）
      if (mode === 'file' || mode === 'all') {
        if (!agent.rewindFiles) {
          return '❌ 当前 Agent 不支持文件回退';
        }
        const fileResult = await agent.rewindFiles(session.agentSessionId!, session.projectPath, rewindTarget.userUuid);
        if (!fileResult.canRewind) {
          if (mode === 'file') {
            return `❌ 当前会话无文件快照，无法回退文件${fileResult.error ? `\n原因: ${fileResult.error}` : ''}`;
          }
          results.push(`⚠️ 文件回退失败${fileResult.error ? `: ${fileResult.error}` : '（无文件快照）'}`);
        } else {
          const detail = fileResult.filesChanged
            ? `（恢复了 ${fileResult.filesChanged.length} 个文件）`
            : '';
          results.push(`✅ 已恢复文件到第 ${turnNum} 轮之前的状态${detail}`);
        }
      }

      // 对话回退（延迟执行 — 下次发消息时生效）
      if (mode === 'chat' || mode === 'all') {
        if (keepTarget) {
          const meta = { ...(session.metadata || {}), resumeAt: keepTarget.assistantUuid };
          await this.sessionManager.updateSession(session.id, { metadata: meta });
        } else {
          // N=1：撤销全部对话，清空 session 从头开始
          const meta = { ...(session.metadata || {}) };
          delete meta.resumeAt;
          await this.sessionManager.updateSession(session.id, {
            metadata: meta,
            agentSessionId: null,
          });
        }

        const discarded = turns.length - turnNum + 1;
        const keepDesc = keepTarget
          ? `回退到第 ${turnNum - 1} 轮："${keepTarget.userContent}"`
          : '已清空全部对话历史';
        results.push(
          `✅ 已撤销第 ${turnNum} 轮${discarded > 1 ? `及后续共 ${discarded} 轮` : ''}`,
          keepTarget ? `下次发言将从第 ${turnNum - 1} 轮继续` : '下次发言将开始全新对话'
        );
      }

      this.eventBus.publish({
        type: 'session:rewind',
        sessionId: session.id,
        turnNum,
        mode,
      });

      return results.join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Rewind failed:', error);
      return `❌ 回退失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  private buildTurnList(messages: Array<{ type: string; uuid: string; message: unknown }>): Array<{
    index: number; userContent: string; userUuid: string; assistantUuid: string;
  }> {
    const turns: Array<{ index: number; userContent: string; userUuid: string; assistantUuid: string }> = [];
    let pendingUser: { content: string; uuid: string } | null = null;

    for (const msg of messages) {
      if (msg.type === 'user') {
        const m = msg.message as any;
        if (Array.isArray(m?.content) && m.content.every((c: any) => c.type === 'tool_result')) {
          continue;
        }
        const content = this.extractUserContent(msg.message);
        if (content) {
          pendingUser = { content, uuid: msg.uuid };
        }
      } else if (msg.type === 'assistant' && pendingUser) {
        turns.push({
          index: turns.length + 1,
          userContent: pendingUser.content,
          userUuid: pendingUser.uuid,
          assistantUuid: msg.uuid,
        });
        pendingUser = null;
      }
    }
    return turns;
  }

  // ── Agent Ctl ──

  private static readonly CTL_COMMANDS = [
    '/help', '/status', '/check', '/pwd',
    '/model', '/effort', '/perm', '/agent',
    '/compact', '/file', '/send', '/restart', '/bind', '/aid', '/rpc', '/storage',
    '/rename', '/name', '/evolagent',
  ];

  /** ctl 中仅允许查询形态的指令；写形态（带参）一律拒绝 */
  private static readonly CTL_READONLY = new Set(['/agent']);

  /**
   * 从 session 恢复 ReplyContext，用于 ctl send 主动发送文本时的路由
   * - 群聊话题：metadata.replyContext.{threadId,peerId}
   * - 私聊：metadata.peerId
   * - taskId/chatmode：从 processing_state 和 sessionMode 注入
   */
  private buildCtlReplyContext(session: Session): ReplyContext | undefined {
    const ctx: ReplyContext = {};
    const meta = session.metadata;
    if (meta?.replyContext?.threadId) ctx.threadId = meta.replyContext.threadId;
    if (meta?.replyContext?.peerId) ctx.peerId = meta.replyContext.peerId;
    if (!ctx.peerId && meta?.peerId) ctx.peerId = meta.peerId;

    const taskId = this.sessionManager.getActiveTaskId(session.id);
    const chatmode = session.sessionMode || 'interactive';
    const encrypted = this.sessionManager.getSessionEncrypt(session.id);
    if (taskId || chatmode !== 'interactive' || encrypted != null) {
      ctx.metadata = {};
      if (taskId) ctx.metadata.taskId = taskId;
      if (chatmode !== 'interactive') ctx.metadata.chatmode = chatmode;
      if (encrypted != null) ctx.metadata.encrypted = encrypted;
    }

    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }

  /**
   * Agent ctl 入口：通过 IPC 接收 Agent 自主管理指令
   * 复用现有 slash cmd 逻辑，权限继承 session 用户角色
   */
  async handleCtl(cmd: string, sessionId: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    // 1. 白名单检查
    const inputCmd = cmd.split(' ')[0];
    if (!CommandHandler.CTL_COMMANDS.includes(inputCmd)) {
      return { ok: false, error: `不允许的指令: ${inputCmd}` };
    }

    // 1.1 只读守卫：带参形态（写操作）在 ctl 中禁止
    if (CommandHandler.CTL_READONLY.has(inputCmd) && cmd.trimEnd().length > inputCmd.length) {
      return { ok: false, error: `${inputCmd} 在 ctl 中仅支持查询形态，不支持带参切换` };
    }

    // 2. 通过 sessionId 查 session
    const session = await this.sessionManager.getSessionById(sessionId);
    if (!session) {
      return { ok: false, error: '无效的 session' };
    }

    // 3. 从 session.metadata.peerId 获取 userId（用于权限判断）
    const userId = session.metadata?.peerId;

    // 3.1 /evolagent: EvolAgent 管理（show identity / reload）
    if (cmd === '/evolagent' || cmd.startsWith('/evolagent ')) {
      const arg = cmd.slice('/evolagent'.length).trim();
      if (!arg) {
        const owning = this.getOwningAgent(session.channel);
        if (owning) {
          return { ok: true, result: `当前 EvolAgent: ${owning.name} (${owning.baseagent})` };
        }
        return { ok: true, result: '当前为 DefaultAgent 模式' };
      }
      if (arg.startsWith('reload ') || arg === 'reload') {
        const name = arg === 'reload' ? '' : arg.slice('reload '.length).trim();
        if (!name) return { ok: false, error: '用法: evolclaw ctl evolagent reload <name>' };
        // I8: reload is a structural op, require admin or owner
        if (!userId) {
          return { ok: false, error: '权限不足：evolagent reload 仅 owner/admin 可用' };
        }
        const identity = this.sessionManager.resolveIdentity(session.channel, userId);
        if (identity.role !== 'owner' && identity.role !== 'admin') {
          return { ok: false, error: '权限不足：evolagent reload 仅 owner/admin 可用' };
        }
        if (!this.agentRegistry) return { ok: false, error: 'EvolAgentRegistry not available' };
        const a = this.agentRegistry.get(name);
        if (!a) return { ok: false, error: `Agent "${name}" not found` };
        const hooks = (globalThis as any).__evolclaw_reloadHooks;
        if (!hooks) return { ok: false, error: 'Reload hooks not initialized' };
        if (!this.agentRegistry.reload) return { ok: false, error: 'EvolAgentRegistry.reload not available' };
        try {
          await this.agentRegistry.reload(name, hooks);
          return { ok: true, result: `Agent "${name}" reloaded` };
        } catch (e: any) {
          return { ok: false, error: `Reload failed: ${e?.message || e}` };
        }
      }
      return { ok: false, error: '用法: evolclaw ctl evolagent [reload <name>]' };
    }

    // 4. /send 文本消息：直接通过 adapter 主动发送，不走 handle()
    if (cmd.startsWith('/send ') || cmd === '/send') {
      const text = cmd.startsWith('/send ') ? cmd.slice(6).trim() : '';
      if (!text) return { ok: false, error: '消息内容不能为空' };

      const adapter = this.adapters.get(session.channel);
      if (!adapter) return { ok: false, error: `adapter 未找到: ${session.channel}` };

      try {
        const replyContext = this.buildCtlReplyContext(session);
        await adapter.send(buildEnvelope({ channel: adapter.channelName, channelId: session.channelId, replyContext: replyContext }), { kind: 'result.text', text, isFinal: true });
        return { ok: true, result: '已发送' };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    // 5. file 路径限制：只允许 projectPath 下的文件
    if (cmd.startsWith('/file')) {
      const sendArgs = cmd.slice(5).trim();
      const parts = sendArgs.split(/\s+/);
      const filePath = parts[parts.length - 1];
      if (filePath) {
        const resolved = path.resolve(session.projectPath, filePath).replace(/\\/g, '/');
        const projectPath = session.projectPath.replace(/\\/g, '/');
        if (!resolved.startsWith(projectPath)) {
          return { ok: false, error: '路径越界：只能发送项目目录下的文件' };
        }
      }
    }

    // 6. 调用现有 handle()，不传 sendMessage 回调（结果直接返回）
    try {
      const result = await this.handle(
        cmd,
        session.channel,
        session.channelId,
        undefined,  // 不发送消息
        userId,
      );
      const text = typeof result === 'string' ? result : (result && 'text' in result ? result.text : '(无输出)');
      return { ok: true, result: text || '(无输出)' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private extractUserContent(message: unknown): string {
    const m = message as any;
    let text = '';
    if (typeof m?.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m?.content)) {
      text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
    }
    text = text.trim().replace(/\s+/g, ' ');
    if (!text) return '';
    return text.length > 50 ? text.substring(0, 50) + '…' : text;
  }
}
