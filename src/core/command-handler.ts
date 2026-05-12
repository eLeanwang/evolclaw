import { Config, ChannelAdapter, Session, ChannelPolicy, InteractionRequest, ReplyContext, ActionInteraction } from '../types.js';
import { SessionManager } from './session/session-manager.js';
import { type AgentRunnerFull, hasModelSwitcher, hasPermissionController } from '../agents/claude-runner.js';
import { MessageCache } from './message/message-cache.js';
import { MessageProcessor } from './message/message-processor.js';
import { EventBus } from './event-bus.js';
import type { StatsCollector } from '../utils/stats-collector.js';
import { PermissionGateway, type PermissionDecision } from './permission.js';
import { InteractionRouter } from './interaction-router.js';
import { MessageQueue } from './message/message-queue.js';
import { saveConfig, resolvePaths, getPackageRoot, getOwner, getChannelShowActivities, setChannelShowActivities, getChannelSessionMode } from '../config.js';
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
const commands = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/effort', '/agent', '/slist', '/session', '/rename', '/stop', '/clear', '/compact', '/repair', '/safe', '/fork', '/del', '/perm', '/file', '/check', '/rewind', '/activity', '/aid', '/agentmd', '/chatmode'];

// 命令别名映射
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename',
  '/rw': '/rewind'
};

// 命令快速路径前缀（所有命令都不进入消息队列）
const quickCommandPrefixes = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/effort', '/agent', '/slist', '/session', '/rename', '/repair', '/fork', '/stop', '/clear', '/compact', '/safe', '/del', '/perm', '/file', '/check', '/p ', '/s ', '/name', '/rewind', '/rw', '/rw ', '/activity', '/chatmode'];

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
  private hotLoadChannel?: (inst: any) => Promise<void>;
  private agentMap: Map<string, AgentRunnerFull>;
  private defaultAgentId: string;

  /** 按 agentId 获取 agent，回退到默认 */
  private getAgent(agentId?: string): AgentRunnerFull {
    if (agentId && this.agentMap.has(agentId)) return this.agentMap.get(agentId)!;
    return this.agentMap.get(this.defaultAgentId) || this.agentMap.values().next().value!;
  }

  constructor(
    private sessionManager: SessionManager,
    agentRunnerOrMap: AgentRunnerFull | Map<string, AgentRunnerFull>,
    private config: Config,
    private messageCache: MessageCache,
    private eventBus: EventBus,
    defaultAgentId?: string
  ) {
    if (agentRunnerOrMap instanceof Map) {
      this.agentMap = agentRunnerOrMap;
      this.defaultAgentId = defaultAgentId || 'claude';
    } else {
      this.agentMap = new Map([[agentRunnerOrMap.name, agentRunnerOrMap]]);
      this.defaultAgentId = agentRunnerOrMap.name;
    }
  }

  /** 项目列表快捷访问 */
  private get projects(): Record<string, string> {
    return this.config.projects?.list || {};
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
   * 尝试通过渠道适配器发送交互卡片。
   * 返回 message_id 表示卡片已发送，false 表示降级为文本。
   */
  private async trySendInteraction(
    channel: string,
    channelId: string,
    interaction: InteractionRequest,
    replyContext?: ReplyContext,
  ): Promise<string | false> {
    const adapter = this.adapters.get(channel);
    if (!adapter?.sendInteraction) return false;
    try {
      return await adapter.sendInteraction(channelId, interaction, replyContext);
    } catch (e) {
      logger.warn(`[CommandHandler] sendInteraction failed: ${e}`);
      return false;
    }
  }

  /** 作废某 session 下所有 pending 交互卡片（PATCH 禁用 + cancel） */
  private async invalidateOldCards(channel: string, sessionId: string): Promise<void> {
    if (!this.interactionRouter) return;
    const adapter = this.adapters.get(channel);
    const pending = this.interactionRouter.getPending(sessionId);
    if (pending.length === 0) return;
    const disabledCard = {
      config: { wide_screen_mode: true },
      header: { template: 'grey', title: { tag: 'plain_text', content: '已过期' } },
      elements: [{ tag: 'markdown', content: '此卡片已过期，请查看最新卡片。' }],
    };
    for (const id of pending) {
      const msgId = this.interactionRouter.getMessageId(id);
      if (msgId && adapter?.patchInteractionCard) {
        adapter.patchInteractionCard(msgId, disabledCard).catch(() => {});
      }
      this.interactionRouter.cancel(id);
    }
  }

  /**
   * 发送交互卡片并注册回调。作废旧卡片 → 发送新卡片 → 注册到 interactionRouter。
   * 返回 true 表示卡片已发送（调用方应 return null），false 表示降级到文本。
   */
  private async sendInteractionCard(opts: {
    channel: string;
    channelId: string;
    sessionId: string;
    requestId: string;
    interaction: InteractionRequest;
    replyCtx?: ReplyContext;
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>;
    /** 当前用户对该命令是否有写权限；false → 只发文本、不发交互卡片。默认 true（兼容旧调用） */
    canWrite?: boolean;
  }): Promise<boolean> {
    if (!this.interactionRouter) return false;
    // 无写权限 → 走文本降级（由调用点 fall through 输出只读信息）
    if (opts.canWrite === false) return false;
    // 有写权限但此刻忙碌 → 也走文本降级（避免诱导用户在忙碌状态下触发带参写操作）
    if (this.isSessionBusy(opts.sessionId)) return false;
    await this.invalidateOldCards(opts.channel, opts.sessionId);
    const messageId = await this.trySendInteraction(opts.channel, opts.channelId, opts.interaction, opts.replyCtx);
    if (!messageId) return false;
    const wrappedCallback: typeof opts.callback = async (action, values, operatorId) => {
      // 点击回调时二次校验：若会话此刻忙碌，忽略本次点击（防止已弹卡片被用于带参切换）
      if (this.isSessionBusy(opts.sessionId)) {
        const adapter = this.adapters.get(opts.channel);
        adapter?.sendText(opts.channelId, '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试', opts.replyCtx);
        return;
      }
      await opts.callback(action, values, operatorId);
      // 已完成交互的卡片：保留原始内容，仅禁用按钮（不标记为"已过期"）
      // "已过期"仅用于被新卡片替代的旧卡片（invalidateOldCards）
    };
    this.interactionRouter.register(opts.requestId, opts.sessionId, wrappedCallback, { timeoutMs: 120_000, messageId });
    return true;
  }

  /** 判断指定 session 是否有活跃流（用于 idle 守卫和卡片降级） */
  private isSessionBusy(sessionId: string): boolean {
    for (const agent of this.agentMap.values()) {
      if (agent.hasActiveStream(sessionId)) return true;
    }
    return false;
  }

  /** 获取活跃会话，无会话时返回统一错误提示 */
  private async ensureSession(channel: string, channelId: string, threadId?: string): Promise<{ session: Session } | { error: string }> {
    if (threadId) {
      // 话题会话：仅查询，不创建
      const session = await this.sessionManager.getThreadSession(channel, channelId, threadId);
      if (!session) {
        return { error: '❌ 话题中尚未创建会话\n发送消息后自动创建' };
      }
      return { session };
    }
    const session = await this.sessionManager.getActiveSession(channel, channelId);
    if (!session) {
      return { error: '❌ 当前没有活跃会话\n使用 /new 创建新会话' };
    }
    return { session };
  }

  setProcessor(processor: MessageProcessor): void {
    this.processor = processor;
  }

  setMessageQueue(messageQueue: MessageQueue): void {
    this.messageQueue = messageQueue;
  }

  setHotLoadChannel(fn: (inst: any) => Promise<void>): void {
    this.hotLoadChannel = fn;
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
            { cmd: '/aid', label: 'AID 管理', desc: '创建新 AID 并上线新 Agent 实例', next: { type: 'select' as const, items: [
              { value: 'list', label: '列表', desc: '列出所有 AUN 实例及连接状态' },
              { value: 'new', label: '创建', desc: '创建新 AID 并热加载上线', next: { type: 'text' as const } },
            ] } },
            { cmd: '/agentmd', label: '管理 agent.md', desc: '查看或更新 AUN 网络上的 agent.md 身份文件', next: { type: 'select' as const, items: [
              { value: 'put', label: '上传当前', desc: '将本地 agent.md 上传到 AUN 网络' },
              { value: 'set', label: '直接设置', desc: '输入内容直接更新 agent.md', next: { type: 'text' as const } },
            ] } },
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
      const list = this.config.projects?.list || {};
      return Object.entries(list).map(([name, path]) => ({ value: name, label: name, desc: path as string }));
    }

    if (cmd === '/agent') {
      return [...this.agentMap.keys()].map(name => ({ value: name, label: name }));
    }

    if (cmd === '/model') {
      const agent = this.getAgent(session?.agentId);
      if (hasModelSwitcher(agent) && agent.listModels) {
        const models = await agent.listModels() ?? [];
        if (models.length > 0) return models.map((m: string) => ({ value: m, label: m }));
      }
      return null;
    }

    if (cmd === '/restart') {
      const isOwner = userId ? this.sessionManager.resolveIdentity(channel, userId).role === 'owner' : false;
      const channels = [...this.adapters.keys()].map(name => ({ value: name, label: name, desc: '重连此渠道' }));
      if (isOwner) channels.unshift({ value: '', label: '重启服务', desc: '重启整个 EvolClaw 服务进程' });
      return channels;
    }

    return null;
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
  ): Promise<string | null | undefined> {
    // 解析身份（按实例名）
    const identity = this.sessionManager.resolveIdentity(channel, userId);
    const policy = this.getPolicy(channel);

    // 按当前会话选择 agent 后端
    const activeSession = await this.sessionManager.getActiveSession(channel, channelId);
    const agent = this.getAgent(activeSession?.agentId);

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

    // 话题内禁用部分命令
    if (threadId) {
      const threadBlocked = ['/new', '/slist', '/plist', '/bind', '/s', '/session', '/project', '/p', '/fork', '/del', '/agent'];
      const isBlocked = threadBlocked.some(c => normalizedContent === c || normalizedContent.startsWith(c + ' '));
      if (isBlocked) {
        return '⚠️ 话题中不支持此命令';
      }
    }

    // 权限检查：区分用户级命令和管理级命令
    const isOwner = identity.role === 'owner';
    const isAdmin = identity.role === 'owner' || identity.role === 'admin';
    const activeChatType = activeSession?.chatType || 'private';

    if (normalizedContent.startsWith('/')) {
      // guest 在群聊和私聊中均可访问的只读命令：纯查询形态（带参写操作由各 handler 内部守卫拦截）
      const guestGroupCommands = [
        '/status', '/help', '/check', '/chatmode',
        '/model', '/effort', '/agent', '/perm', '/activity', '/safe',
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
        return activeChatType === 'group'
          ? '❌ 无权限：当前群聊仅支持 /status 和 /help'
          : '❌ 无权限：此命令仅限管理员使用';
      }
    }

    // 空闲检查：某些命令需要等待当前会话空闲
    // 原则：仅对"写/破坏性"形态拦截，纯读/用法提示的无参形态始终放行
    // - 始终需要 idle（无参即写）：/new /clear /compact /repair /fork
    // - 仅带参时需要 idle（无参是列表/用法）：/session /bind /project /agent /rewind
    // - /chatmode：在 handler 内部自行做写操作的 idle 检查
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
          const threadAgent = this.getAgent(threadSession.agentId);
          if (threadAgent.hasActiveStream(threadSession.id)) {
            return '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试';
          }
        }
      } else if (activeSession && agent.hasActiveStream(activeSession.id)) {
        return '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试';
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
          return `❌ 未知命令: ${inputCmd}\n💡 你是不是想输入: ${similar}\n\n输入 /help 查看所有可用命令`;
        } else {
          return `❌ 未知命令: ${inputCmd}\n\n输入 /help 查看所有可用命令`;
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
        return lines.join('\n');
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
        return lines.join('\n');
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
        '🔐 权限管理：',
        '  /perm - 查看当前权限模式',
        ...(isOwner ? ['  /perm <auto|bypass|request|edit|plan|noask> - 切换权限模式'] : []),
        '  /perm allow|always|deny - 审批权限请求',
        '',
        '🛠️ 运维：',
        '  /status - 显示会话状态',
        '  /stop - 中断当前任务',
        '  /check - 检查渠道状态',
        '  /activity [all|dm|owner|none] - 查看/控制中间输出显示模式',
        ...(isAdmin ? [
          '  /restart <channel> - 重连指定渠道',
        ] : []),
        ...(isOwner ? [
          '  /restart - 重启服务',
          '  /file [channel] <path> - 发送项目内文件',
          '  /aid [list|new <aid>] - AID 管理',
          '  /agentmd [put|set <内容>] - 管理 agent.md',
        ] : []),
        '',
        '❓ 帮助：',
        '  /help - 显示此帮助信息',
      ];
      return lines.join('\n');
    }

    // /perm 命令：权限模式切换 + 权限审批（快速路径，不进入消息队列）
    if (normalizedContent.startsWith('/perm')) {
      const args = normalizedContent.slice(5).trim();

      // 先获取正确的 session 和 agent（话题可能用不同 agent）
      const permResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in permResult) return permResult.error;
      const { session: permSession } = permResult;
      const permAgent = this.getAgent(permSession.agentId);

      // /perm（无参数）：显示当前模式和可选模式
      if (!args) {
        if (!hasPermissionController(permAgent)) {
          return '❌ 权限控制不可用';
        }
        const defaultPermMode = identity.role === 'owner' ? 'bypass' : identity.role === 'admin' ? 'auto' : 'noask';
        const currentMode = permSession.metadata?.permissionMode ?? defaultPermMode;
        const modes = permAgent.listModes();

        // 尝试发送交互卡片
        if (this.interactionRouter) {
          const requestId = `perm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const availableModes = modes.filter(m => m.available);
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: permSession.id,
            kind: {
              kind: 'action',
              title: '🔐 权限模式',
              body: availableModes.map(m => `${m.key === currentMode ? '✓' : '•'} **${m.key}** (${m.nameZh}) - ${m.description}`).join('\n'),
              buttons: availableModes.map(m => ({
                key: m.key,
                label: m.key === currentMode ? `✓ ${m.key}` : m.key,
                style: m.key === currentMode ? 'primary' : 'default',
              })),
            },
          };

          const replyCtx = this.getReplyContext(permSession);
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: permSession.id, requestId, interaction, replyCtx,
            canWrite: isOwner,
            callback: async (action, _values, operatorId) => {
              if (action !== currentMode) {
                if (userId && operatorId && operatorId !== userId) return;
                const result = await this.handle(`/perm ${action}`, channel, channelId, undefined, userId, threadId);
                if (result) {
                  const adapter = this.adapters.get(channel);
                  adapter?.sendText(channelId, result, replyCtx);
                }
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本
        const modeList = modes.map(m => {
          const prefix = m.key === currentMode ? '✓' : ' ';
          const suffix = m.available ? '' : ' ⚠️ 不可用';
          return `  ${prefix} ${m.key} (${m.nameZh}) - ${m.description}${suffix}`;
        }).join('\n');
        if (isOwner) {
          return `🔐 当前权限模式: ${currentMode}\n\n${modeList}\n\n用法:\n  /perm <模式>              切换权限模式\n  /perm allow|always|deny   审批权限请求`;
        }
        return `🔐 当前权限模式: ${currentMode}`;
      }

      const parts = args.split(/\s+/);

      // /perm <mode> 或 /perm allow|always|deny：切换模式 / 快捷审批
      if (parts.length === 1) {
        const arg = parts[0];

        // /perm allow|always|deny：快捷审批（自动找当前 session 唯一的 pending 请求）
        if (arg === 'allow' || arg === 'always' || arg === 'deny') {
          if (!this.permissionGateway) {
            return '❌ 权限审批未启用';
          }
          const pendingIds = this.permissionGateway.getPendingRequests(permSession.id);
          if (pendingIds.length === 0) {
            return '❌ 当前没有待审批的权限请求';
          }
          if (pendingIds.length > 1) {
            return `❌ 当前有 ${pendingIds.length} 个待审批请求，请指定 requestId：\n${pendingIds.map(id => `  /perm ${id} ${arg}`).join('\n')}`;
          }
          const requestId = pendingIds[0];
          const decision: PermissionDecision = arg;
          this.permissionGateway.resolvePermission(permSession.id, requestId, decision);
          const labels: Record<PermissionDecision, string> = {
            allow: '✓ 已授权（本次），继续执行……',
            always: '✓ 已授权（始终允许该工具），继续执行……',
            deny: '✓ 已拒绝'
          };
          return labels[decision];
        }

        // /perm <mode>：切换权限模式
        if (hasPermissionController(permAgent)) {
          const modes = permAgent.listModes();
          const matched = modes.find(m => m.key === arg);
          if (matched) {
            if (!matched.available) {
              return `❌ ${matched.key} 模式当前不可用：${matched.unavailableReason}`;
            }
            // guest 和 admin 用户不能切换权限模式（仅 owner）
            if (!isOwner) {
              return '❌ 权限模式切换仅限 owner';
            }
            const metadata = permSession.metadata || {};
            metadata.permissionMode = arg;
            await this.sessionManager.updateSession(permSession.id, { metadata });
            return `✓ 权限模式已切换为: ${matched.key} (${matched.nameZh})\n${matched.description}`;
          }
        }
        // 不是已知模式名也不是 allow/deny
        const modeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'auto|bypass|request|edit|plan|noask';
        return `❌ 未知参数: ${arg}\n用法: /perm <${modeKeys}> 或 /perm allow|always|deny`;
      }

      // 双参数不再支持，提示正确用法
      const allModeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'auto|bypass|request|edit|plan|noask';
      return `❌ 未知参数: ${args}\n用法: /perm <${allModeKeys}> 或 /perm allow|always|deny`;
    }

    // /agent 命令：查看或切换 Agent 后端
    if (normalizedContent === '/agent' || normalizedContent.startsWith('/agent ')) {
      const args = normalizedContent.slice(6).trim();
      // 切换（带参）需权限：群聊 owner only，私聊 admin+；无参查询对所有人放开
      if (args && (activeChatType === 'group' ? !isOwner : !isAdmin)) {
        return '❌ 无权限：此命令仅限管理员使用';
      }
      const available = [...this.agentMap.keys()];

      if (!args) {
        const currentAgent = activeSession?.agentId || this.defaultAgentId;

        // 尝试发送交互卡片
        if (this.interactionRouter && available.length > 1) {
          const requestId = `agent-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: activeSession?.id || requestId,
            kind: {
              kind: 'action',
              title: '🔌 切换 Agent',
              buttons: available.map(a => ({
                key: a,
                label: a === currentAgent ? `✓ ${a}` : a,
                style: a === currentAgent ? 'primary' : 'default',
              })),
            },
          };

          const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: activeSession?.id || requestId, requestId, interaction, replyCtx,
            canWrite: activeChatType === 'group' ? isOwner : isAdmin,
            callback: async (action, _values, operatorId) => {
              if (action !== currentAgent) {
                if (userId && operatorId && operatorId !== userId) return;
                const result = await this.handle(`/agent ${action}`, channel, channelId, undefined, userId, threadId);
                if (result) {
                  const adapter = this.adapters.get(channel);
                  adapter?.sendText(channelId, result, replyCtx);
                }
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本
        const list = available.map(a => `${a === currentAgent ? ' ✓' : '  '} ${a}`).join('\n');
        const canSwitchAgent = activeChatType === 'group' ? isOwner : isAdmin;
        if (canSwitchAgent) {
          return `当前 Agent: ${currentAgent}\n\n可用:\n${list}\n\n用法: /agent <name>`;
        }
        return `当前 Agent: ${currentAgent}`;
      }

      if (!this.agentMap.has(args)) {
        return `❌ 未知 Agent: ${args}\n可用: ${available.join(', ')}`;
      }

      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
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

      return agentSwitchResponse;
    }

    // /model 命令：查看或切换模型/推理强度
    if (normalizedContent.startsWith('/model')) {
      const args = normalizedContent.slice(6).trim();

      // 获取当前会话（话题会话可能绑定不同 agent）
      const modelResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in modelResult) return modelResult.error;
      const { session: modelSession } = modelResult;
      const modelAgent = this.getAgent(modelSession.agentId);

      const models = hasModelSwitcher(modelAgent) ? modelAgent.listModels() : [];

      if (!args) {
        const currentModel = hasModelSwitcher(modelAgent) ? modelAgent.getModel() : modelAgent.name;
        const efforts = getAvailableEfforts(modelAgent, currentModel);
        const currentEffort = modelAgent.getEffort?.() || 'auto';

        // 尝试发送交互卡片
        if (this.interactionRouter && models.length > 0) {
          const requestId = `model-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: modelSession.id,
            kind: {
              kind: 'action',
              title: '🤖 切换模型',
              buttons: models.map((m: string) => ({
                key: m,
                label: m === currentModel ? `✓ ${m}` : m,
                style: m === currentModel ? 'primary' : 'default',
              })),
            },
          };

          const replyCtx = this.getReplyContext(modelSession);
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: modelSession.id, requestId, interaction, replyCtx,
            canWrite: isAdmin,
            callback: async (action, _values, operatorId) => {
              if (action !== currentModel) {
                if (userId && operatorId && operatorId !== userId) return;
                const result = await this.handle(`/model ${action}`, channel, channelId, undefined, userId, threadId);
                if (result) {
                  const adapter = this.adapters.get(channel);
                  adapter?.sendText(channelId, result, replyCtx);
                }
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本
        const modelList = models.map((m: string) => `  ${m === currentModel ? '✓' : ' '} ${m}`).join('\n');
        const effortHint = efforts.length > 0
          ? `\n推理强度: ${currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort}  (使用 /effort 调整)`
          : '';
        if (isAdmin) {
          return `当前模型: ${currentModel}${effortHint}\n\n可用模型：\n${modelList}\n\n${formatModelUsage(modelAgent, currentModel)}`;
        }
        return `当前模型: ${currentModel}${effortHint}`;
      }

      // 带参（切换/调整）需 admin+；无参查询已在上方返回
      if (!isAdmin) return '❌ 无权限：切换模型仅限管理员使用';

      const parts = args.split(/\s+/);
      let newModel: string | undefined;
      let newEffort: Effort | undefined;

      if (parts.length === 1) {
        const arg = parts[0];
        const currentModel = hasModelSwitcher(modelAgent) ? modelAgent.getModel() : modelAgent.name;
        const efforts = getAvailableEfforts(modelAgent, currentModel);
        // effort 相关参数统一转发到 /effort
        if ((efforts as readonly string[]).includes(arg) || arg === 'auto') {
          return this.handle(`/effort ${arg}`, channel, channelId, undefined, userId, threadId);
        } else if ((allEfforts as readonly string[]).includes(arg)) {
          return `⚠️ 请使用 /effort ${arg} 调整推理强度`;
        } else if (models.includes(arg)) {
          newModel = arg;
        } else {
          const modelList = models.map((m: string) => `  ${m === currentModel ? '✓' : ' '} ${m}`).join('\n');
          const effortHint = efforts.length > 0 ? `\n\n推理强度请使用 /effort 命令` : '';
          return `❌ 无效参数: ${arg}\n\n可用模型：\n${modelList}${effortHint}`;
        }
      } else {
        // 双参数：model effort
        const [modelArg, effortArg] = parts;
        if (!models.includes(modelArg)) {
          return `❌ 无效的模型ID: ${modelArg}`;
        }
        const targetEfforts = getAvailableEfforts(modelAgent, modelArg);
        if (targetEfforts.length === 0) {
          return `⚠️ ${modelArg} 不支持推理强度设置`;
        }
        if (!(targetEfforts as readonly string[]).includes(effortArg)) {
          const errorLabel = (allEfforts as readonly string[]).includes(effortArg) ? '⚠️' : '❌';
          return `${errorLabel} ${modelArg} 不支持 ${effortArg} 推理强度\n可选: ${targetEfforts.join(' / ')}`;
        }
        newModel = modelArg;
        newEffort = effortArg as Effort;
      }

      if (!this.config.agents) this.config.agents = {};

      const isCodexAgent = modelAgent.name === 'codex';
      const changes: string[] = [];

      if (newModel) {
        modelAgent.setModel?.(newModel);
        this.eventBus.publish({
          type: 'agent:model-changed',
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

      // 持久化：写回来源（就近原则）
      // evolclaw.json 配了 → 写 evolclaw.json
      // evolclaw.json 没配 → 写 agent 全局配置
      if (isCodexAgent) {
        const configuredInEvolclaw = !!(this.config.agents?.openai?.model || this.config.agents?.openai?.reasoning);
        if (configuredInEvolclaw) {
          if (!this.config.agents!.openai) this.config.agents!.openai = {};
          if (newModel) this.config.agents!.openai.model = newModel;
          if (newEffort) this.config.agents!.openai.reasoning = newEffort;
          try {
            saveConfig(this.config);
          } catch (error: any) {
            return `⚠️ 写入 evolclaw.json 失败: ${error.message}\n已更新运行时配置，但未持久化`;
          }
        } else {
          // Codex 全局配置（~/.codex/config.toml）目前不支持写入，回退到 evolclaw.json
          if (!this.config.agents!.openai) this.config.agents!.openai = {};
          if (newModel) this.config.agents!.openai.model = newModel;
          if (newEffort) this.config.agents!.openai.reasoning = newEffort;
          try {
            saveConfig(this.config);
          } catch (error: any) {
            return `⚠️ 写入 evolclaw.json 失败: ${error.message}\n已更新运行时配置，但未持久化`;
          }
        }
      } else {
        const configuredInEvolclaw = !!(this.config.agents?.anthropic?.model || this.config.agents?.anthropic?.effort);
        if (configuredInEvolclaw) {
          if (!this.config.agents!.anthropic) this.config.agents!.anthropic = {};
          if (newModel) this.config.agents!.anthropic.model = newModel;
          if (newEffort) this.config.agents!.anthropic.effort = newEffort as any;
          try {
            saveConfig(this.config);
          } catch (error: any) {
            return `⚠️ 写入 evolclaw.json 失败: ${error.message}\n已更新运行时配置，但未持久化`;
          }
        } else {
          const updates: { model?: string; effortLevel?: string } = {};
          if (newModel) updates.model = newModel;
          if (newEffort) updates.effortLevel = newEffort;
          const writeResult = writeUserSettings(updates);
          if (!writeResult.success) {
            return `⚠️ 写入用户配置失败: ${writeResult.error}\n已更新运行时配置，但未持久化到 ~/.claude/settings.json`;
          }
        }
      }

      return `✓ 已切换\n  ${changes.join('\n  ')}`;
    }

    // /effort 命令：查看或切换推理强度
    if (normalizedContent.startsWith('/effort')) {
      const args = normalizedContent.slice(7).trim();

      const effortResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in effortResult) return effortResult.error;
      const { session: effortSession } = effortResult;
      const effortAgent = this.getAgent(effortSession.agentId);

      const currentModel = hasModelSwitcher(effortAgent) ? effortAgent.getModel() : effortAgent.name;
      const efforts = getAvailableEfforts(effortAgent, currentModel);
      const currentEffort = effortAgent.getEffort?.() || 'auto';

      if (efforts.length === 0) {
        return '⚠️ 当前模型不支持推理强度设置';
      }

      if (!args) {
        // /effort（无参数）：显示当前推理强度 + 发送 Action 卡片
        if (this.interactionRouter) {
          const requestId = `effort-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const buttons: ActionInteraction['buttons'] = [
            ...efforts.map(e => ({
              key: e,
              label: e === currentEffort ? `✓ ${e}` : e,
              style: e === currentEffort ? 'primary' as const : 'default' as const,
            })),
            {
              key: 'auto',
              label: currentEffort === 'auto' ? '✓ auto' : 'auto',
              style: currentEffort === 'auto' ? 'primary' as const : 'default' as const,
            },
          ];

          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: effortSession.id,
            kind: {
              kind: 'action',
              title: '⚡ 推理强度',
              buttons,
            },
          };

          const replyCtx = this.getReplyContext(effortSession);
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: effortSession.id, requestId, interaction, replyCtx,
            canWrite: isAdmin,
            callback: async (action, _values, operatorId) => {
              if (action !== currentEffort) {
                if (userId && operatorId && operatorId !== userId) return;
                const result = await this.handle(`/effort ${action}`, channel, channelId, undefined, userId, threadId);
                if (result) {
                  const adapter = this.adapters.get(channel);
                  adapter?.sendText(channelId, result, replyCtx);
                }
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本
        const effortDisplay = currentEffort === 'auto' ? 'auto (SDK默认)' : currentEffort;
        const allItems = [...efforts, 'auto'];
        const effortList = allItems.map(e => `  ${e === currentEffort ? '✓' : ' '} ${e}${e === 'auto' ? ' (SDK默认)' : ''}`).join('\n');
        if (isAdmin) {
          return `⚡ 推理强度: ${effortDisplay}\n\n可选:\n${effortList}\n\n用法: /effort <level>`;
        }
        return `⚡ 推理强度: ${effortDisplay}`;
      }

      // 带参（切换）需 admin+；无参查询已在上方返回
      if (!isAdmin) return '❌ 无权限：切换推理强度仅限管理员使用';

      // /effort auto：恢复 SDK 默认
      if (args === 'auto') {
        effortAgent.setEffort?.(undefined);

        const isCodex = effortAgent.name === 'codex';
        if (isCodex) {
          if (this.config.agents?.openai?.reasoning) {
            delete this.config.agents.openai.reasoning;
            try { saveConfig(this.config); } catch {}
          }
        } else {
          const configuredInEvolclaw = !!this.config.agents?.anthropic?.effort;
          if (configuredInEvolclaw) {
            delete (this.config.agents!.anthropic as any).effort;
            try { saveConfig(this.config); } catch {}
          } else {
            writeUserSettings({ effortLevel: null });
          }
        }

        return '✓ 推理强度已恢复为 auto (SDK默认)';
      }

      // /effort <level>：切换推理强度
      if (!(efforts as readonly string[]).includes(args)) {
        if ((allEfforts as readonly string[]).includes(args)) {
          return `⚠️ ${currentModel} 不支持 ${args} 推理强度\n可选: ${efforts.join(' / ')}`;
        }
        return `❌ 无效参数: ${args}\n可选: ${efforts.join(' / ')} / auto`;
      }

      const newEffort = args as Effort;
      effortAgent.setEffort?.(newEffort);

      // 持久化
      if (!this.config.agents) this.config.agents = {};
      const isCodex = effortAgent.name === 'codex';
      if (isCodex) {
        if (!this.config.agents.openai) this.config.agents.openai = {};
        this.config.agents.openai.reasoning = newEffort;
        try { saveConfig(this.config); } catch {}
      } else {
        const configuredInEvolclaw = !!(this.config.agents?.anthropic?.model || this.config.agents?.anthropic?.effort);
        if (configuredInEvolclaw) {
          if (!this.config.agents.anthropic) this.config.agents.anthropic = {};
          this.config.agents.anthropic.effort = newEffort as any;
          try { saveConfig(this.config); } catch {}
        } else {
          writeUserSettings({ effortLevel: newEffort });
        }
      }

      return `✓ 推理强度: ${newEffort}`;
    }

    // /aid 命令：AID 管理（list / new）
    if (normalizedContent === '/aid' || normalizedContent === '/aid list' || normalizedContent.startsWith('/aid ')) {
      if (!isOwner) return '❌ 无权限：此命令仅限 owner 使用';

      const adapter = this.adapters.get(channel) as any;
      const channelType = this.channelTypeMap.get(channel);
      if (channelType !== 'aun') return '❌ 此命令仅在 AUN 通道中可用';

      const arg = normalizedContent.slice(4).trim();

      // /aid 或 /aid list — 列出所有 AUN 实例
      if (!arg || arg === 'list') {
        const { normalizeChannelInstances } = await import('../config.js');
        const instances = normalizeChannelInstances(this.config.channels?.aun, 'aun');
        if (instances.length === 0) return '暂无 AUN 实例';

        const lines = ['AUN 实例:'];
        for (const inst of instances) {
          if (inst.enabled === false || !(inst as any).aid) continue;
          const channelObj = this.channelObjects.get(inst.name);
          const status = channelObj?.getStatus?.();
          const connected = status?.connected ?? false;
          const icon = connected ? '✓' : '✗';
          const state = connected ? '已连接' : '未连接';
          lines.push(`  ${icon} ${inst.name}  ${(inst as any).aid}  ${state}`);
        }
        return lines.join('\n');
      }

      // /aid new <aid> — 创建新 AID 并热加载
      if (arg.startsWith('new ')) {
        const rawName = arg.slice(4).trim();
        if (!rawName) return '用法: /aid new <aid>\n例: /aid new reviewer';

        if (!this.hotLoadChannel) return '❌ 热加载未就绪';

        // Derive full AID: if no dots, append domain from current AID
        const selfAid: string = typeof adapter._selfAid === 'function' ? adapter._selfAid() : '';
        let fullAid = rawName;
        if (!rawName.includes('.')) {
          const domain = selfAid.split('.').slice(1).join('.');
          if (!domain) return '❌ 无法推导 AID 域（当前实例未连接）';
          fullAid = `${rawName}.${domain}`;
        }

        // Validate AID format
        const { isValidAid } = await import('../utils/init-channel.js');
        if (!isValidAid(fullAid)) return `❌ 无效 AID 格式: ${fullAid}`;

        // Check instance name conflict
        const instName = rawName.includes('.') ? rawName.split('.')[0] : rawName;
        const { normalizeChannelInstances } = await import('../config.js');
        const existing = normalizeChannelInstances(this.config.channels?.aun, 'aun');
        if (existing.some(e => e.name === instName)) {
          return `❌ 实例名 "${instName}" 已存在`;
        }
        if (existing.some(e => (e as any).aid === fullAid)) {
          return `❌ AID ${fullAid} 已在配置中`;
        }

        // Create AID (reuse init-channel.ts silent logic)
        try {
          const { createAidSilent, appendAunInstance } = await import('../utils/init-channel.js');
          const createResult = await createAidSilent({ aid: fullAid, owner: selfAid });

          // Resolve owner from current AUN instance config
          const owner = this.config.channels?.aun
            ? (Array.isArray(this.config.channels.aun)
              ? this.config.channels.aun.find((a: any) => a.aid === selfAid)?.owner
              : (this.config.channels.aun as any).owner)
            : undefined;

          // Hot-load: build and register new channel instance BEFORE writing config
          const { AUNChannelPlugin } = await import('../channels/aun.js');
          const plugin = new AUNChannelPlugin();
          const tempConfig = JSON.parse(JSON.stringify(this.config));
          tempConfig.channels.aun = [{ name: instName, enabled: true, aid: fullAid, owner }];
          const newInstances = await plugin.createChannels(tempConfig);
          if (newInstances.length === 0) return '❌ 通道实例创建失败';

          await this.hotLoadChannel(newInstances[0]);

          // Write config only after successful hot-load
          appendAunInstance(this.config, { name: instName, aid: fullAid, owner });

          const verb = createResult.alreadyExisted ? '已存在，现已上线' : '已创建并上线';
          return `✓ ${fullAid} ${verb}\n  实例名: ${instName}\n  可在 AUN 中搜索该 AID 开始对话`;
        } catch (e: any) {
          return `❌ 创建失败: ${String(e.message || e).slice(0, 200)}`;
        }
      }

      return '用法: /aid [list|new <aid>]';
    }

    // /activity 命令：控制中间输出显示模式
    if (normalizedContent === '/agentmd' || normalizedContent.startsWith('/agentmd ')) {
      if (!isOwner) return '❌ 无权限：此命令仅限 owner 使用';
      const adapter = this.adapters.get(channel) as any;
      if (!adapter?.uploadAgentMd) return '❌ 当前通道不支持 agent.md 操作';

      const selfAid: string = typeof adapter._selfAid === 'function' ? adapter._selfAid() : '';
      const arg = normalizedContent.slice(9).trim();

      // put — read local ~/.aun/AIDs/{aid}/agent.md and upload
      if (arg === 'put') {
        if (!selfAid) return '❌ 未连接，无法确定本地 AID';
        try {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { homedir } = await import('node:os');
          const localPath = join(homedir(), '.aun', 'AIDs', selfAid, 'agent.md');
          const content = readFileSync(localPath, 'utf-8');
          await adapter.uploadAgentMd(content);
          return '✅ agent.md 已发布';
        } catch (e: any) {
          return `❌ 发布失败: ${String(e.message || e).slice(0, 100)}`;
        }
      }

      // set <content> — upload inline content and sync to local
      if (arg.startsWith('set ')) {
        const content = arg.slice(4).trim();
        if (!content) return '用法：/agentmd set <内容>';
        if (!selfAid) return '❌ 未连接，无法确定本地 AID';
        try {
          await adapter.uploadAgentMd(content);
          const { writeFileSync, mkdirSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { homedir } = await import('node:os');
          const localDir = join(homedir(), '.aun', 'AIDs', selfAid);
          mkdirSync(localDir, { recursive: true });
          writeFileSync(join(localDir, 'agent.md'), content, 'utf-8');
          return '✅ agent.md 已更新并发布到AUN网络';
        } catch (e: any) {
          return `❌ 发布失败: ${String(e.message || e).slice(0, 100)}`;
        }
      }

      // view — /agentmd or /agentmd <aid>
      const aidToView = arg || selfAid;
      if (!aidToView) return '用法：/agentmd [<aid>] | put | set <内容>';
      try {
        const md = await adapter.downloadAgentMd(aidToView);
        if (!md || !md.trim()) return `ℹ️ ${aidToView} 尚未设置 agent.md`;
        return `\`\`\`\n${md.slice(0, 1500)}\n\`\`\``;
      } catch (e: any) {
        const msg = String(e.message || e);
        if (msg.includes('not found') || msg.includes('404')) {
          return `ℹ️ ${aidToView} 尚未设置 agent.md`;
        }
        return `❌ 获取失败: ${msg.slice(0, 100)}`;
      }
    }


    if (normalizedContent === '/activity' || normalizedContent.startsWith('/activity ')) {
      const activityArg = normalizedContent.slice(9).trim();
      // 带参（写操作）需 admin+；无参查询对所有人开放（owner 门在具体切换点还有一道）
      if (activityArg && !isAdmin) return '❌ 无权限：此命令仅限管理员使用';

      // proactive 模式下流式输出全部静默，activity 配置无意义
      if (activeSession?.sessionMode === 'proactive') {
        return '❌ 当前会话为 proactive 模式，不支持 activity 配置（流式输出已全部静默）';
      }

      const modeMap: Record<string, 'all' | 'dm-only' | 'owner-dm-only' | 'none'> = {
        all: 'all',
        dm: 'dm-only',
        owner: 'owner-dm-only',
        none: 'none',
      };

      const currentMode = getChannelShowActivities(this.config, channel);

      // 模式描述列表（用于 body 和文本降级）
      const modeDescriptions: { key: string; configVal: string; label: string }[] = [
        { key: 'all', configVal: 'all', label: '全部显示' },
        { key: 'dm', configVal: 'dm-only', label: '仅私聊显示' },
        { key: 'owner', configVal: 'owner-dm-only', label: '仅 owner 私聊显示' },
        { key: 'none', configVal: 'none', label: '全部静默' },
      ];

      if (!activityArg) {
        // 无参数：显示当前模式 + Action 卡片
        if (this.interactionRouter) {
          const requestId = `activity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const body = modeDescriptions.map(m =>
            `${m.configVal === currentMode ? '✓' : '•'} **${m.key}** (${m.label})`
          ).join('\n');
          const buttons: ActionInteraction['buttons'] = modeDescriptions.map(m => ({
            key: m.key,
            label: m.configVal === currentMode ? `✓ ${m.key}` : m.key,
            style: m.configVal === currentMode ? 'primary' as const : 'default' as const,
          }));

          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: activeSession?.id || requestId,
            kind: {
              kind: 'action',
              title: '📋 中间输出模式',
              body,
              buttons,
            },
          };

          const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: activeSession?.id || requestId, requestId, interaction, replyCtx,
            canWrite: isOwner,
            callback: async (action, _values, operatorId) => {
              const newMode = modeMap[action];
              if (newMode && newMode !== currentMode) {
                if (userId && operatorId && operatorId !== userId) return;
                const result = await this.handle(`/activity ${action}`, channel, channelId, undefined, userId, threadId);
                if (result) {
                  const adapter = this.adapters.get(channel);
                  adapter?.sendText(channelId, result, replyCtx);
                }
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本
        const modeList = modeDescriptions.map(m => {
          const prefix = m.configVal === currentMode ? '✓' : ' ';
          return `  ${prefix} ${m.key} (${m.label})`;
        }).join('\n');
        if (isOwner) {
          return `📋 中间输出模式: ${currentMode}\n\n${modeList}\n\n用法:\n  /activity <模式>    切换中间输出显示模式`;
        }
        return `📋 中间输出模式: ${currentMode}`;
      }

      const newMode = modeMap[activityArg];
      if (!newMode) {
        return `❌ 无效参数: ${activityArg}\n可选: all / dm / owner / none`;
      }

      const label = modeDescriptions.find(m => m.configVal === newMode)?.label || newMode;

      if (newMode === currentMode) {
        return `📋 中间输出模式已是 ${activityArg}（${label}）`;
      }

      // 切换操作仅 owner
      if (!isOwner) return '❌ 中间输出模式切换仅限 owner';

      setChannelShowActivities(this.config, channel, newMode);
      return `✅ 中间输出模式: ${activityArg}（${label}）`;
    }

    // /chatmode 命令：查看/切换 session 会话模式（interactive | proactive）
    // - 查看：所有人可用
    // - 设置：单聊任何角色可设置；群聊仅管理员可设置
    if (normalizedContent === '/chatmode' || normalizedContent.startsWith('/chatmode ')) {
      if (!activeSession) return '❌ 当前无活跃会话';

      const lockedMode = getChannelSessionMode(this.config, channel);
      const arg = normalizedContent.slice(9).trim();
      const currentMode = activeSession.sessionMode || 'interactive';

      if (!arg) {
        const lockHint = lockedMode ? `（由通道配置锁定为 ${lockedMode}）` : '';
        const canSwitch = activeChatType !== 'group' || isAdmin;
        if (canSwitch && !lockedMode) {
          return `📋 当前会话模式: ${currentMode}${lockHint}\n可选: interactive / proactive\n用法: /chatmode <模式>`;
        }
        return `📋 当前会话模式: ${currentMode}${lockHint}`;
      }

      if (arg !== 'interactive' && arg !== 'proactive') {
        return `❌ 无效模式: ${arg}\n可选: interactive / proactive`;
      }

      if (activeChatType === 'group' && !isAdmin) {
        return '❌ 无权限：群聊中切换会话模式仅限管理员使用';
      }

      if (lockedMode) {
        return `❌ 会话模式由通道配置锁定为 ${lockedMode}，无法切换`;
      }

      if (arg === currentMode) {
        return `📋 当前会话模式已是 ${arg}`;
      }

      // 仅在真正需要切换时才要求会话空闲
      if (threadId) {
        const threadSession = await this.sessionManager.getThreadSession(channel, channelId, threadId);
        if (threadSession) {
          const threadAgent = this.getAgent(threadSession.agentId);
          if (threadAgent.hasActiveStream(threadSession.id)) {
            return '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试';
          }
        }
      } else if (agent.hasActiveStream(activeSession.id)) {
        return '⚠️ 当前正在处理消息，请稍后再试\n使用 /stop 中断当前任务后重试';
      }

      await this.sessionManager.updateSession(activeSession.id, { sessionMode: arg });
      return `✅ 会话模式已切换: ${arg}`;
    }

    // /stop 命令：中断当前任务
    if (normalizedContent === '/stop') {
      const stopResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in stopResult) return '当前没有正在处理的任务';
      const { session: stopSession } = stopResult;
      const stopAgent = this.getAgent(stopSession.agentId);
      const sessionKey = stopSession.id;

      const queueLength = this.messageQueue.getQueueLength(sessionKey);
      const hasActive = stopAgent.hasActiveStream(sessionKey);

      if (queueLength === 0 && !hasActive) {
        return '当前没有正在处理的任务';
      }

      await stopAgent.interrupt(sessionKey);
      // 发布中断事件，让 MessageProcessor 标记为 interrupted（而非 done）
      this.eventBus.publish({ type: 'message:interrupted', sessionId: sessionKey, reason: 'stop' });
      // 强制清除 processing_state
      this.sessionManager.clearProcessing(sessionKey);
      return '✓ 已发送中断信号，任务将尽快停止';
    }

    // /clear 命令：通过 SDK /clear 清空会话历史
    if (normalizedContent === '/clear') {
      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
      const { session } = result;

      const sessionAgent = this.getAgent(session.agentId);
      if (!sessionAgent.capabilities?.clear) {
        return `❌ 当前 Agent (${sessionAgent.name}) 不支持 /clear\n\n可使用 /new 创建新会话替代`;
      }

      if (!session.agentSessionId) {
        return '❌ 当前会话没有历史记录，无需清空';
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
          return '✅ 已清空当前会话的对话历史';
        } else {
          return '❌ 清空会话失败，请稍后重试';
        }
      } finally {
        releaseLock();
      }
    }

    // /compact 命令：手动压缩会话上下文
    if (normalizedContent === '/compact') {
      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
      const { session } = result;

      const sessionAgent = this.getAgent(session.agentId);
      if (!sessionAgent.capabilities?.compact) {
        return `❌ 当前 Agent (${sessionAgent.name}) 不支持 /compact`;
      }

      if (!session.agentSessionId) {
        return '❌ 当前会话没有历史记录，无需压缩';
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
          return '✅ 会话上下文已压缩';
        } else {
          return '❌ 会话压缩失败，请稍后重试';
        }
      } finally {
        releaseLock();
      }
    }

    // 尝试获取活跃会话（话题时直接查找话题 session）
    let session: Session | undefined;
    if (threadId) {
      session = await this.sessionManager.getOrCreateSession(channel, channelId, this.config.projects?.defaultPath || process.cwd(), threadId);
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
        this.config.projects?.defaultPath || process.cwd()
      );
    }

    // /status 命令：显示会话状态
    if (normalizedContent === '/status') {
      // session 现在总是存在（上面已自动创建）
      if (!session) {
        return `❌ 无法创建会话，请检查配置`;
      }

      const sessionKey = this.getQueueKey(session, channel, channelId);
      const sessionAgent = this.getAgent(session.agentId);
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
      const lockedMode = getChannelSessionMode(this.config, channel);
      const chatModeLine = `会话模式: ${sessionMode}${lockedMode ? '（通道锁定）' : ''}`;
      if (isAdmin) {
        lines.push(
          `📊 ${isThread ? '话题' : '会话'}状态：`,
          `渠道: ${this.resolveChannelType(channel)} / 项目: ${projectName} / 会话: ${session.name || '(未命名)'}`,
          `会话ID: ${session.id}`,
          `项目路径: ${session.projectPath}`,
          `会话状态: ${sessionStatus}`,
          chatModeLine,
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
          `📊 ${isThread ? '话题' : '会话'}状态：`,
          `渠道: ${channel} / 项目: ${projectName} / ${session.agentId}会话`,
          `状态: ${sessionStatus}`,
          chatModeLine,
          `会话轮数: ${sessionTurns}`,
          `最后活跃: ${timeStr}`
        );
      }

      if (health.lastError) {
        lines.push('');
        lines.push(`最后错误: ${health.lastErrorType || 'unknown'}`);
        lines.push(`错误信息: ${health.lastError.substring(0, 100)}`);
      }

      return lines.join('\n');
    }

    // /new 命令：创建新会话（支持命名）
    if (normalizedContent.startsWith('/new')) {
      const sessionName = normalizedContent.slice(4).trim() || undefined;

      if (sessionName) {
        const existing = await this.sessionManager.getSessionByName(channel, channelId, sessionName);
        if (existing) {
          return `❌ 会话名称 "${sessionName}" 已存在，请使用其他名称`;
        }
      }

      const projectPath = session?.projectPath || this.config.projects?.defaultPath || process.cwd();

      const newSession = await this.sessionManager.createNewSession(
        channel,
        channelId,
        projectPath,
        sessionName,
        session?.agentId || this.defaultAgentId
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

      return `✓ 已创建新会话${sessionName ? `: ${sessionName}` : ''}\n  之前的对话历史已保留，可通过 /s 查看`;
    }

    // /check 命令：检查渠道状态（guest 可用，详情仅 admin）/ 重连指定渠道（admin only）
    if (normalizedContent === '/check' || normalizedContent.startsWith('/check ')) {
      const subCmd = normalizedContent.slice('/check'.length).trim();

      // Default: show system health check (non-admin 仅看摘要)
      const lines: string[] = ['📡 渠道状态：'];
      // Group by channelType
      const groups = new Map<string, Array<{ name: string; status: string }>>();
      for (const [name] of this.adapters) {
        const type = this.channelTypeMap.get(name) || name;
        const ch = this.channelObjects.get(name);
        let status: string;
        if (ch?.getStatus) {
          const s = ch.getStatus();
          status = s.connected ? '✓ 已连接' : s.reconnectAttempt > 0 ? `⏳ 重连中 (${s.reconnectAttempt}/${s.maxAttempts})` : '✗ 断开';
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
        return lines.join('\n');
      }

      for (const [type, instances] of groups) {
        if (instances.length === 1) {
          lines.push(`  ${instances[0].name}: ${instances[0].status}`);
        } else {
          const parts = instances.map(i => `${i.name} ${i.status}`);
          lines.push(`  ${type}: [${parts.join(', ')}]`);
        }
      }

      // 队列状态
      lines.push('', '📬 队列状态：');
      lines.push(`  待处理消息: ${this.messageQueue.getGlobalQueueLength()}`);
      lines.push(`  处理中队列: ${this.messageQueue.getGlobalProcessingCount()}`);

      // 运行概况
      lines.push('', '🖥️ 运行概况：');
      const uptimeMs = this.statsCollector
        ? this.statsCollector.getSnapshot().uptimeMs
        : process.uptime() * 1000;
      lines.push(`  运行时间: ${this.formatUptime(uptimeMs)}`);

      // 近 1 小时统计
      if (this.statsCollector) {
        const snap = this.statsCollector.getSnapshot();
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

      return lines.join('\n');
    }

    // /restart 命令：重启服务（owner only） / 重连指定渠道（admin+）
    if (normalizedContent === '/restart' || normalizedContent.startsWith('/restart ')) {
      const restartArg = normalizedContent.slice('/restart'.length).trim();

      // /restart <channel> — 重连指定渠道（admin only）
      if (restartArg) {
        if (!isAdmin) return '❌ 无权限：渠道重连仅限管理员使用';
        const target = restartArg;
        const ch = this.channelObjects.get(target);
        if (!ch) {
          const available = [...this.channelObjects.keys()].join(', ') || '无';
          return `❌ 未找到渠道 "${target}"，可用渠道：${available}`;
        }
        if (!ch.reconnect) {
          return `❌ 渠道 "${target}" 不支持重连`;
        }
        const result = await ch.reconnect();
        return `🔄 ${target} 重连: ${result}`;
      }

      // /restart（无参数）— 重启整个服务（owner only）
      if (!isOwner) return '❌ 无权限：服务重启仅限 owner 使用';
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
          const threadSession = await this.sessionManager.getOrCreateSession(channel, channelId, this.config.projects?.defaultPath || process.cwd(), threadId);
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
        spawn('node', [path.join(getPackageRoot(), 'dist', 'cli.js'), 'restart-monitor'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
        }).unref();

        this.eventBus.publish({ type: 'system:restart', channel, channelId });

        setTimeout(() => {
          logger.info('[System] Restarting by user command...');
          process.exit(0);
        }, 1000);
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
            return sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。';
          }
        } else {
          fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: Date.now() }));
          return sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。';
        }
      }

      await executeRestart();
      return '🔄 服务正在重启，请稍候...（约 5 秒后恢复）';
    }

    // /pwd 命令：显示当前项目路径
    if (normalizedContent === '/pwd') {
      // session 现在总是存在（上面已自动创建）
      if (!session) {
        return `❌ 无法创建会话，请检查配置`;
      }

      const configName = this.getConfiguredProjectName(session.projectPath);
      if (configName) {
        return `当前项目: ${configName}\n路径: ${session.projectPath}`;
      }
      return `当前项目: ${session.projectPath}`;
    }

    // /file 命令：发送项目内文件，支持 /file path 和 /file channel path（owner only）
    if (normalizedContent.startsWith('/file')) {
      if (!isOwner) return '❌ 无权限：此命令仅限 owner 使用';
      // 飞书会将 .md 等后缀自动转为 Markdown 链接: foo.md → [foo.md](http://foo.md/)
      // 还原: 将 [text](url) 替换为 text
      const rawArg = normalizedContent.slice(5).trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (!rawArg) {
        return '用法: /file <相对路径> 或 /file <渠道> <相对路径>\n示例: /file src/index.ts\n示例: /file feishu report.md';
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
        return '❌ 跨通道发送仅限管理员';
      }

      // 找目标 adapter
      const targetAdapter = this.adapters.get(targetChannel);
      if (!targetAdapter) {
        return `❌ 通道 ${targetLabel} 未启用或不存在`;
      }
      if (!targetAdapter.sendFile) {
        return `❌ 通道 ${targetLabel} 不支持文件发送`;
      }

      // 获取 session（需要 projectPath）
      const sendResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in sendResult) return sendResult.error;
      const sendSession = sendResult.session;

      // 路径安全校验
      if (path.isAbsolute(filePath)) {
        return '❌ 不支持绝对路径\n请使用项目内的相对路径';
      }
      if (filePath.split(path.sep).includes('..') || filePath.split('/').includes('..')) {
        return '❌ 不支持 .. 路径穿越';
      }

      const resolvedPath = path.resolve(sendSession.projectPath, filePath);

      // 存在性检查
      if (!fs.existsSync(resolvedPath)) {
        return `❌ 文件不存在: ${filePath}`;
      }

      // 符号链接安全：realpath 后验证仍在项目目录内
      const realPath = fs.realpathSync(resolvedPath);
      const realProjectPath = fs.realpathSync(sendSession.projectPath);
      if (!realPath.startsWith(realProjectPath + path.sep) && realPath !== realProjectPath) {
        return '❌ 路径不允许: 文件不在项目目录内';
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        return '❌ 暂不支持发送目录\n目录打包发送将在后续版本支持';
      }
      const MAX_SIZE = 10 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        return `❌ 文件过大: ${(stat.size / 1024 / 1024).toFixed(1)} MB (限制 10 MB)`;
      }

      // 找目标 channelId
      let targetChannelId = channelId;
      if (isCrossChannel) {
        const ownerPeerId = getOwner(this.config, targetChannel);
        targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannel, ownerPeerId) ?? '') : '';
        if (!targetChannelId) {
          return `❌ 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息`;
        }
      }

      // 发送文件
      try {
        const replyCtx = isCrossChannel ? undefined : this.getReplyContext(sendSession);
        await targetAdapter.sendFile(targetChannelId, realPath, replyCtx);
        const sizeStr = stat.size < 1024 ? `${stat.size} B`
          : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
        return isCrossChannel
          ? `📎 文件已通过 ${targetLabel} 发送: ${filePath} (${sizeStr})`
          : `✅ 已发送: ${filePath} (${sizeStr})`;
      } catch (error: any) {
        logger.error('[CommandHandler] /file failed:', error);
        return `❌ 文件发送失败: ${error.message || error}`;
      }
    }

    // /plist 命令：列出所有项目
    if (normalizedContent === '/plist') {
      if (!policy.canListProjects(session?.chatType || 'private', identity.role)) {
        if (!session) {
          return `❌ 当前群聊未绑定项目

请使用 /bind <项目路径> 绑定项目`;
        }

        const projectName = this.getProjectName(session.projectPath);

        const isProcessing = !!session.processingState;
        const status = isProcessing ? '[处理中]' : '[空闲]';

        return `当前群聊绑定的项目：
  ${projectName} (${session.projectPath}) - ${status}

提示：群聊不支持切换项目`;
      }

      // 收集项目信息并按最近活跃排序（唯一来源：evolclaw.json projects.list）
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

      // 尝试发送 ActionInteraction 卡片（每个项目一个按钮，一键切换）
      if (this.interactionRouter && entries.length > 0) {
        const requestId = `plist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const buttons: ActionInteraction['buttons'] = entries.map(e => ({
          key: e.name,
          label: e.isCurrent ? `✓ ${e.name}` : e.name,
          style: e.isCurrent ? 'primary' as const : 'default' as const,
        }));

        const bodyLines = entries.map(e => {
          const status = buildStatusText(e);
          const prefix = e.isCurrent ? '✓' : '•';
          return `${prefix} **${e.name}** (${e.projectPath})  ${status}`;
        });

        const interaction: InteractionRequest = {
          type: 'interaction',
          id: requestId,
          channelId,
          sessionId: activeSession?.id || requestId,
          kind: {
            kind: 'action',
            title: '📂 项目列表',
            body: bodyLines.join('\n'),
            buttons,
          },
        };

        const replyCtx = activeSession ? this.getReplyContext(activeSession) : undefined;
        const cardSent = await this.sendInteractionCard({
          channel, channelId, sessionId: activeSession?.id || requestId, requestId, interaction, replyCtx,
          canWrite: isAdmin,
          callback: async (action, _values, operatorId) => {
            if (userId && operatorId && operatorId !== userId) return;
            const selectedEntry = entries.find(e => e.name === action);
            if (selectedEntry && !selectedEntry.isCurrent) {
              const result = await this.handle(`/project ${action}`, channel, channelId, undefined, userId, threadId);
              if (result) {
                const adapter = this.adapters.get(channel);
                adapter?.sendText(channelId, result, replyCtx);
              }
            }
          },
        });
        if (cardSent) return null;
      }

      // 降级：文本列表
      const lines = ['可用项目:'];
      for (const entry of entries) {
        const prefix = entry.isCurrent ? '  ✓' : '   ';
        lines.push(`${prefix} ${entry.name} (${entry.projectPath}) - ${buildStatusText(entry)}`);
      }
      lines.push('', '提示: 使用 /p <名称> 切换项目');
      return lines.join('\n');
    }

    // /project（无参数）：直接复用 /plist 逻辑（含卡片交互）
    if (normalizedContent === '/project') {
      if (!policy.canSwitchProject(session?.chatType || 'private', identity.role)) {
        // 群聊不能切换项目，交由 /plist 逻辑处理
      }
      return this.handle('/plist', channel, channelId, undefined, userId, threadId);
    }

    // /project 命令：切换项目（支持名称或路径）
    if (normalizedContent.startsWith('/project ')) {
      if (!policy.canSwitchProject(session?.chatType || 'private', identity.role)) {
        return `❌ 群聊不支持切换项目

群聊只能绑定一个项目。如需更换项目，请联系管理员重新配置。`;
      }

      let arg = normalizedContent.slice(9).trim();

      if (!arg) return '用法: /p <name|path> 或 /project <name|path>';

      // 检查确认标志
      const hasConfirm = arg.endsWith(' --confirm');
      if (hasConfirm) {
        arg = arg.slice(0, -10).trim();
      }

      let projectPath: string;
      let projectName: string;

      if (arg.includes('/')) {
        if (!path.isAbsolute(arg)) {
          return '❌ 项目路径必须是绝对路径';
        }
        if (!fs.existsSync(arg)) {
          return `❌ 路径不存在: ${arg}`;
        }
        projectPath = arg;
        projectName = path.basename(arg);
      } else {
        projectPath = this.projects[arg];
        if (!projectPath) {
          return `❌ 项目 "${arg}" 不存在\n提示: 使用 /p 查看可用项目`;
        }
        projectName = arg;
      }

      if (session) {
        const normalizedSessionPath = path.resolve(session.projectPath);
        const normalizedProjectPath = path.resolve(projectPath);
        if (normalizedSessionPath === normalizedProjectPath) {
          return `当前已在项目: ${projectName}\n  路径: ${projectPath}`;
        }
      }

      // 群聊切换项目需要确认
      const isGroupChat = session?.chatType === 'group';
      if (isGroupChat && !hasConfirm) {
        return `⚠️ 群聊切换项目风险提示：

切换项目将影响所有群成员的对话上下文，可能导致：
  • 当前项目的会话历史被切换
  • 正在处理的任务被中断
  • 其他成员的工作受到影响

确认切换请执行：
  /p ${projectName} --confirm`;
      }

      const currentAgentId = activeSession?.agentId || this.defaultAgentId;
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
      const currentAgent = newSession.agentId || this.defaultAgentId;
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

        return '';
      }

      return response;
    }

    // /bind 命令：持久化项目到配置（不切换）（owner only）
    if (normalizedContent === '/bind') return '用法: /bind <路径>';
    if (normalizedContent.startsWith('/bind ')) {
      if (!isOwner) return '❌ 无权限：此命令仅限 owner 使用';
      const projectPath = normalizedContent.slice(6).trim();

      if (!projectPath) return '用法: /bind <路径>';

      if (!path.isAbsolute(projectPath)) {
        return '❌ 项目路径必须是绝对路径';
      }
      if (!fs.existsSync(projectPath)) {
        return `❌ 路径不存在: ${projectPath}`;
      }

      // 生成项目名称（使用目录名）
      const projectName = path.basename(projectPath);

      // 检查是否已存在
      if (this.projects[projectName]) {
        const existingPath = this.projects[projectName];
        if (existingPath === projectPath) {
          return `项目 "${projectName}" 已存在\n  路径: ${projectPath}\n\n使用 /p ${projectName} 切换到该项目`;
        }
        return `❌ 项目名称 "${projectName}" 已被占用\n  现有路径: ${existingPath}\n  新路径: ${projectPath}\n\n请重命名目录或手动编辑配置文件`;
      }

      // 添加到配置
      if (!this.config.projects) {
        this.config.projects = { defaultPath: process.cwd(), autoCreate: false, list: {} };
      }
      if (!this.config.projects.list) {
        this.config.projects.list = {};
      }
      this.config.projects.list[projectName] = projectPath;

      // 保存配置
      const { saveConfig } = await import('../config.js');
      saveConfig(this.config);

      // 更新内存中的项目列表
      this.projects[projectName] = projectPath;

      return `✓ 已添加项目: ${projectName}\n  路径: ${projectPath}\n\n使用 /p ${projectName} 切换到该项目`;
    }

    // /slist 命令：列出当前项目的会话
    // /slist      — 仅 EvolClaw 会话
    // /slist cli  — 仅 CLI 会话（未导入的）
    if (normalizedContent === '/slist' || normalizedContent === '/slist cli') {
      if (!session) {
        return `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /p <项目> - 切换到指定项目`;
      }

      const showCliOnly = normalizedContent === '/slist cli';

      // /slist cli — 仅显示 CLI 会话
      if (showCliOnly) {
        const canImportCli = policy.canImportCliSession(session.chatType || 'private', identity.role);
        if (!canImportCli) {
          return '❌ 当前无权查看 CLI 会话';
        }

        const cliSessions = await this.sessionManager.scanCliSessions(session.projectPath, session.agentId);
        const sessions = await this.sessionManager.listSessions(channel, channelId);
        const currentProjectSessions = sessions.filter(s => s.projectPath === session.projectPath && s.agentId === session.agentId);
        const dbSessionIds = new Set(currentProjectSessions.map(s => s.agentSessionId).filter(Boolean));
        const orphanCliSessions = cliSessions.filter(c => !dbSessionIds.has(c.uuid));

        if (orphanCliSessions.length === 0) {
          return `当前项目 ${path.basename(session.projectPath)} 没有未导入的 CLI 会话`;
        }

        // 构建显示数据（复用于卡片和文本）
        const cliDisplayItems = orphanCliSessions.map(c => {
          const time = new Date(c.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const message = this.sessionManager.readSessionFirstMessage(session.projectPath, c.uuid, session.agentId) || '(无消息)';
          const uuid = c.uuid.substring(0, 8);
          return { uuid, fullUuid: c.uuid, time, message };
        });

        // 尝试发送 ActionInteraction 卡片
        if (this.interactionRouter && cliDisplayItems.length > 0) {
          const requestId = `slist-cli-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const buttons: ActionInteraction['buttons'] = cliDisplayItems.map(item => ({
            key: item.uuid,
            label: item.uuid,
            style: 'default' as const,
          }));

          const bodyLines = cliDisplayItems.map(item =>
            `• ${item.time}  (${item.uuid})  "${item.message}"`
          );

          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId,
            sessionId: session.id,
            kind: {
              kind: 'action',
              title: `📋 ${path.basename(session.projectPath)} CLI 会话 (${cliDisplayItems.length})`,
              body: bodyLines.join('\n'),
              buttons,
            },
          };

          const replyCtx = this.getReplyContext(session);
          const cardSent = await this.sendInteractionCard({
            channel, channelId, sessionId: session.id, requestId, interaction, replyCtx,
            callback: async (action, _values, operatorId) => {
              if (userId && operatorId && operatorId !== userId) return;
              const result = await this.handle(`/session ${action}`, channel, channelId, undefined, userId, threadId);
              if (result) {
                const adapter = this.adapters.get(channel);
                adapter?.sendText(channelId, result, replyCtx);
              }
            },
          });
          if (cardSent) return null;
        }

        // 降级：文本列表
        const lines = [`当前项目 ${path.basename(session.projectPath)} 的 CLI 会话 (共 ${orphanCliSessions.length} 个):`, ''];
        for (const item of cliDisplayItems) {
          lines.push(`  ${item.time}  (${item.uuid})  "${item.message}"`);
        }
        lines.push('');
        lines.push('使用 /s <8位uuid> 导入并切换到 CLI 会话');
        return lines.join('\n');
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

      // 尝试发送 ActionInteraction 卡片（每个会话一个按钮，一键切换）
      if (this.interactionRouter && displaySessions.length >= 1) {
        const requestId = `slist-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const buttons: ActionInteraction['buttons'] = displaySessions.map(ds => {
          const shortId = ds.session.agentSessionId ? ds.session.agentSessionId.substring(0, 8) : ds.name;
          return {
            key: String(ds.index),
            label: ds.isActive ? `✓ ${ds.index}. ${shortId}` : `${ds.index}. ${shortId}`,
            style: ds.isActive ? 'primary' as const : 'default' as const,
          };
        });

        const bodyLines = displaySessions.map(ds => {
          const prefix = ds.isActive ? '✓' : '•';
          const threadTag = ds.session.threadId ? '[话题] ' : '';
          const uuid = ds.session.agentSessionId ? `(${ds.session.agentSessionId.substring(0, 8)})` : '';
          const fileMark = ds.fileMissing ? '❌ ' : '';
          return `${prefix} ${ds.index}. ${threadTag}${fileMark}**${ds.name}** ${uuid}  ${ds.idleTime} ${ds.status}`;
        });

        const interaction: InteractionRequest = {
          type: 'interaction',
          id: requestId,
          channelId,
          sessionId: session.id,
          kind: {
            kind: 'action',
            title: `📋 ${path.basename(session.projectPath)} 会话列表`,
            body: bodyLines.join('\n'),
            buttons,
          },
        };

        const replyCtx = this.getReplyContext(session);
        const cardSent = await this.sendInteractionCard({
          channel, channelId, sessionId: session.id, requestId, interaction, replyCtx,
          callback: async (action, _values, operatorId) => {
            if (userId && operatorId && operatorId !== userId) return;
            const target = displaySessions.find(ds => String(ds.index) === action);
            if (target && !target.isActive) {
              const result = await this.handle(`/session ${action}`, channel, channelId, undefined, userId, threadId);
              if (result) {
                const adapter = this.adapters.get(channel);
                adapter?.sendText(channelId, result, replyCtx);
              }
            }
          },
        });
        if (cardSent) return null;
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
      return lines.join('\n');
    }

    // /session（无参数）：直接复用 /slist 逻辑（含卡片交互）
    if (normalizedContent === '/session') {
      return this.handle('/slist', channel, channelId, undefined, userId, threadId);
    }

    // /session cli（= /s cli）：列出未导入的 CLI 会话
    if (normalizedContent === '/session cli') {
      return this.handle('/slist cli', channel, channelId, undefined, userId, threadId);
    }

    // /session 或 /s 命令：切换会话
    if (normalizedContent.startsWith('/session ')) {
      const sessionName = normalizedContent.slice(9).trim();

      if (!sessionName) return '用法: /s <序号、会话名称或前8位UUID>';

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
          return `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话`;
        }
      }

      if (!targetSession && sessionName.length === 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      const canImport = policy.canImportCliSession(session?.chatType || 'private', identity.role);
      if (!targetSession && sessionName.length === 8 && canImport) {
        const projectPaths = Object.values(this.projects);

        if (session) {
          projectPaths.unshift(session.projectPath);
        }

        for (const projectPath of projectPaths) {
          const currentAgentId = session?.agentId || this.defaultAgentId;
          const cliSessions = await this.sessionManager.scanCliSessions(projectPath, currentAgentId);
          const cliSession = cliSessions.find(c => c.uuid.startsWith(sessionName));

          if (cliSession) {
            const imported = await this.sessionManager.importCliSession(channel, channelId, projectPath, cliSession.uuid, currentAgentId);
            this.eventBus.publish({ type: 'session:imported', sessionId: imported.id, agentSessionId: cliSession.uuid, projectPath });
            const projectName = this.getProjectName(projectPath);
            return `✓ 已导入 CLI 会话: ${imported.name}\n  项目: ${projectName}\n  将继续之前的对话历史`;
          }
        }
      }

      if (!targetSession) {
        return `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话`;
      }

      const lastInput = targetSession.agentSessionId
        ? this.sessionManager.readSessionLastUserMessage(targetSession.projectPath, targetSession.agentSessionId, targetSession.agentId)
        : null;
      const lastInputLine = lastInput ? `\n  最后输入: "${lastInput}"` : '';

      if (!session) {
        const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);
        if (!switched) {
          return `❌ 切换会话失败`;
        }
        return `✓ 已切换到会话: ${targetSession.name || sessionName}\n  项目: ${path.basename(targetSession.projectPath)}${lastInputLine}`;
      }

      if (targetSession.id === session.id) {
        return `当前已在会话: ${targetSession.name || sessionName}`;
      }

      // 阻止从主会话切换到话题会话
      if (!session.threadId && targetSession.threadId) {
        return `❌ 无法从主会话切换到话题会话\n话题会话仅在对应话题内可用`;
      }

      const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);

      if (!switched) {
        return `❌ 切换会话失败`;
      }

      this.eventBus.publish({ type: 'session:switched', sessionId: targetSession.id, fromSessionId: session.id, toSessionId: targetSession.id });

      const continueHint = lastInput ? '\n  将继续之前的对话历史' : '\n  当前会话未有发言';
      return `✓ 已切换到会话: ${targetSession.name || sessionName}${continueHint}${lastInputLine}`;
    }

    // /rename 或 /name 命令：重命名当前会话
    if (normalizedContent === '/rename' || normalizedContent === '/name') {
      return '用法: /name <新名称> 或 /rename <新名称>';
    }
    if (normalizedContent.startsWith('/rename ')) {
      const newName = normalizedContent.slice(8).trim();

      if (!newName) return '用法: /name <新名称> 或 /rename <新名称>';

      if (!session) {
        return `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /session <名称> - 切换到已有会话`;
      }

      const existing = await this.sessionManager.getSessionByName(channel, channelId, newName);
      if (existing && existing.id !== session.id) {
        return `❌ 会话名称 "${newName}" 已存在，请使用其他名称`;
      }

      const oldName = session.name || '(未命名)';
      const success = await this.sessionManager.renameSession(session.id, newName);

      if (!success) {
        return `❌ 重命名失败`;
      }

      this.eventBus.publish({ type: 'session:renamed', sessionId: session.id, oldName, newName });

      return `✓ 已将当前会话重命名为: ${newName}`;
    }

    // /del 命令：删除指定会话（仅解绑，不删除文件）
    if (normalizedContent.startsWith('/del ')) {
      const sessionName = normalizedContent.slice(5).trim();

      if (!sessionName) return '用法: /del <序号、会话名称或前8位UUID>';

      if (!session) {
        return `❌ 当前没有活跃会话`;
      }

      // 权限检查：policy 控制谁可以删除会话
      if (!policy.canDeleteSession(session.chatType || 'private', identity.role)) {
        return `❌ 无权限：群聊中仅管理员可删除会话`;
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
          return `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /s 查看可用会话`;
        }
      }

      if (!targetSession && sessionName.length === 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      if (!targetSession) {
        return `❌ 会话不存在: ${sessionName}\n使用 /s 查看可用会话`;
      }

      if (targetSession.id === session.id) {
        return `❌ 无法删除当前活跃会话\n请先切换到其他会话`;
      }

      const success = await this.sessionManager.unbindSession(targetSession.id);

      if (!success) {
        return `❌ 删除失败`;
      }

      this.eventBus.publish({ type: 'session:deleted', sessionId: targetSession.id });

      const targetAgent = this.getAgent(targetSession.agentId);
      await targetAgent.closeSession(targetSession.id);

      return `✓ 已删除会话: ${targetSession.name || sessionName}\n会话文件已保留，可通过 CLI 访问`;
    }

    // /fork 命令：分支当前会话
    if (normalizedContent === '/fork' || normalizedContent.startsWith('/fork ')) {
      const forkName = normalizedContent.slice(5).trim() || undefined;

      if (!session) {
        return `❌ 当前没有活跃会话，无法分支`;
      }

      if (!session.agentSessionId) {
        return `❌ 当前会话尚未初始化对话，无法分支\n\n请先发送一条消息，然后再使用 /fork`;
      }

      const forkAgent = this.getAgent(session.agentId);
      if (!forkAgent.capabilities?.fork) {
        return `❌ 当前 Agent (${forkAgent.name}) 不支持 /fork\n\n可使用 /new 创建新会话替代`;
      }

      try {
        const forkedSessionId = await forkAgent.forkSession!(session.agentSessionId, session.projectPath, forkName);
        const newSession = await this.sessionManager.createForkedSession(session, forkedSessionId, forkName);

        this.eventBus.publish({ type: 'session:forked', sessionId: newSession.id, sourceSessionId: session.id, name: forkName });

        return `✅ 会话已分支: ${newSession.name}\n新会话已激活，可以继续对话\n\n使用 /s 查看所有会话，/s <名称> 切换回原会话`;
      } catch (error) {
        logger.error('[CommandHandler] Fork session failed:', error);
        return `❌ 会话分支失败: ${error instanceof Error ? error.message : '未知错误'}`;
      }
    }

    // /rewind 命令：查看历史 / 回退会话
    if (normalizedContent === '/rewind' || normalizedContent.startsWith('/rewind ')) {
      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
      const { session } = result;

      const rewindAgent = this.getAgent(session.agentId);

      if (rewindAgent.name !== 'claude') {
        return '❌ /rewind 仅支持 Claude 后端';
      }
      if (!session.agentSessionId) {
        return '❌ 当前会话无历史记录\n\n请先发送一条消息，然后再使用 /rewind';
      }
      if (!rewindAgent.getSessionMessages) {
        return '❌ 当前 Agent 不支持 /rewind';
      }

      const args = normalizedContent.slice('/rewind'.length).trim();

      if (!args) {
        return await this.handleRewindList(session, rewindAgent);
      }

      // 带参（执行回退，会删除文件/改对话）需 admin+
      if (!isAdmin) return '❌ 无权限：回退操作仅限管理员使用';

      const parts = args.split(/\s+/);
      const turnNum = parseInt(parts[0], 10);
      if (isNaN(turnNum) || turnNum < 1) {
        return '❌ 无效轮次，用法：/rewind <N> chat|file|all（撤销第N轮）';
      }

      const mode = parts[1]?.toLowerCase();
      if (!mode) {
        return `❌ 请指定回退模式：/rewind ${turnNum} chat | file | all（撤销第${turnNum}轮）`;
      }
      if (!['chat', 'file', 'all'].includes(mode)) {
        return `❌ 无效模式 "${mode}"，可选：chat | file | all`;
      }

      return await this.handleRewind(session, rewindAgent, turnNum, mode as 'chat' | 'file' | 'all');
    }

    // /repair 命令：检查并修复会话文件
    if (normalizedContent === '/repair') {
      const repairResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in repairResult) return repairResult.error;
      const { session: repairSession } = repairResult;      const repairAgent = this.getAgent(repairSession.agentId);
      const { checkSessionFile, backupSessionFile } = await import('./session/session-file-health.js');

      try {
        if (!repairSession.agentSessionId) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return `✓ 修复完成\n\n修复内容：\n- 未发现问题（新会话）\n- 已重置异常计数器`;
        }

        // 通过 agent 定位 session 文件
        const sessionFile = repairAgent.resolveSessionFile?.(repairSession.agentSessionId, repairSession.projectPath) ?? null;

        if (!sessionFile) {
          // 文件不存在（已被删除或从未创建），直接重置
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return `✓ 修复完成\n\n修复内容：\n- 会话文件不存在（可能已被清理）\n- 已重置异常计数器`;
        }

        const healthCheck = await checkSessionFile(sessionFile);

        if (healthCheck.corrupt) {
          const backupPath = await backupSessionFile(sessionFile);
          const fsPromises = await import('fs/promises');
          await fsPromises.unlink(sessionFile);
          await this.sessionManager.updateAgentSessionIdBySessionId(repairSession.id, '');
          repairAgent.updateSessionId(repairSession.id, '');
          await this.sessionManager.resetHealthStatus(repairSession.id);

          return `✓ 修复完成\n\n检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n修复操作：\n- 已备份损坏文件\n- 已删除损坏文件\n- 已重置异常计数器\n\n备份位置：${backupPath}`;
        }

        if (healthCheck.issues.length > 0) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          return `⚠️ 检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n建议使用 /new 创建新会话\n\n已重置异常计数器，可继续使用当前会话。`;
        }

        await this.sessionManager.resetHealthStatus(repairSession.id);
        return `✓ 修复完成\n\n修复内容：\n- 未发现问题\n- 已重置异常计数器`;
      } catch (error: any) {
        logger.error('[Repair] Failed:', error);
        return `❌ 修复失败: ${error.message}`;
      }
    }

    // /safe 命令：安全模式已禁用
    if (normalizedContent === '/safe') {
      return `ℹ️ 安全模式已禁用\n\n如需重置会话，请使用 /new 创建新会话。`;
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
    '/compact', '/activity', '/file', '/send', '/chatmode', '/restart', '/agentmd', '/bind', '/aid',
    '/rename', '/name',
  ];

  /** ctl 中仅允许查询形态的指令；写形态（带参）一律拒绝 */
  private static readonly CTL_READONLY = new Set(['/agent']);

  /**
   * 从 session 恢复 ReplyContext，用于 ctl send 主动发送文本时的路由
   * - 群聊话题：metadata.replyContext.{threadId,peerId}
   * - 私聊：metadata.peerId
   */
  private buildCtlReplyContext(session: Session): ReplyContext | undefined {
    const ctx: ReplyContext = {};
    const meta = session.metadata;
    if (meta?.replyContext?.threadId) ctx.threadId = meta.replyContext.threadId;
    if (meta?.replyContext?.peerId) ctx.peerId = meta.replyContext.peerId;
    if (!ctx.peerId && meta?.peerId) ctx.peerId = meta.peerId;
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

    // 4. /send 文本消息：直接通过 adapter 主动发送，不走 handle()
    if (cmd.startsWith('/send ') || cmd === '/send') {
      const text = cmd.startsWith('/send ') ? cmd.slice(6).trim() : '';
      if (!text) return { ok: false, error: '消息内容不能为空' };

      const adapter = this.adapters.get(session.channel);
      if (!adapter) return { ok: false, error: `adapter 未找到: ${session.channel}` };

      try {
        const replyContext = this.buildCtlReplyContext(session);
        await adapter.sendText(session.channelId, text, replyContext);
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
        const resolved = path.resolve(session.projectPath, filePath);
        if (!resolved.startsWith(session.projectPath)) {
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
      return { ok: true, result: result ?? '(无输出)' };
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
