import { Config, ChannelAdapter, Session, ChannelPolicy } from '../types.js';
import { SessionManager } from './session-manager.js';
import { type AgentRunnerFull, hasModelSwitcher, hasPermissionController } from '../agents/claude-runner.js';
import { MessageCache } from '../utils/message-cache.js';
import { MessageProcessor } from './message-processor.js';
import { EventBus } from './event-bus.js';
import { PermissionGateway } from './permission.js';
import { MessageQueue } from './message-queue.js';
import { saveConfig, resolvePaths, getPackageRoot } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const availableEfforts = ['low', 'medium', 'high', 'max'] as const;
type Effort = typeof availableEfforts[number];

function effortBar(level: string): string {
  const levels: Record<string, string> = {
    low: '◆◇◇◇', medium: '◆◆◇◇', high: '◆◆◆◇', max: '◆◆◆◆'
  };
  return levels[level] || '◆◆◇◇';
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
const commands = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/agent', '/slist', '/session', '/rename', '/stop', '/clear', '/compact', '/repair', '/safe', '/fork', '/del', '/perm', '/send'];

// 命令别名映射
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename'
};

// 命令快速路径前缀（所有命令都不进入消息队列）
const quickCommandPrefixes = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/agent', '/slist', '/session', '/rename', '/repair', '/fork', '/stop', '/clear', '/compact', '/safe', '/del', '/perm', '/send', '/p ', '/s ', '/name '];

export class CommandHandler {
  private adapters = new Map<string, ChannelAdapter>();
  private policies = new Map<string, ChannelPolicy>();
  private processor!: MessageProcessor;
  private messageQueue!: MessageQueue;
  private permissionGateway?: PermissionGateway;
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

  /** 获取消息队列 key：话题用 session.id，主会话用 channel-channelId */
  private getQueueKey(session: Session | undefined, _channel: string, _channelId: string): string {
    // 队列和 agent 均使用 session.id 作为 key
    return session?.id || '';
  }

  /** 从 session 提取渠道预构建的回复上下文 */
  private getReplyContext(session: Session): import('../types.js').ReplyContext | undefined {
    return session.metadata?.replyContext;
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

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  registerPolicy(channelName: string, policy: ChannelPolicy): void {
    this.policies.set(channelName, policy);
  }

  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.adapters.get(channelName);
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
   * admin 看到全部命令分组，guest 仅看到用户级命令
   */
  getMenuItems(isAdmin: boolean): { group: string; commands: { cmd: string; args?: string; label: string }[] }[] {
    const items: { group: string; commands: { cmd: string; args?: string; label: string }[] }[] = [];

    if (isAdmin) {
      items.push({
        group: '项目管理',
        commands: [
          { cmd: '/pwd', label: '显示当前项目路径' },
          { cmd: '/plist', label: '列出所有配置的项目' },
          { cmd: '/p', args: '<name|path>', label: '切换项目' },
          { cmd: '/bind', args: '<path>', label: '绑定新项目目录' },
        ]
      });
    }

    items.push({
      group: '会话管理',
      commands: [
        { cmd: '/new', args: '[name]', label: '创建新会话' },
        { cmd: '/slist', label: '列出当前项目的所有会话' },
        { cmd: '/s', args: '<name|index|uuid>', label: '切换到指定会话' },
        { cmd: '/name', args: '<name>', label: '重命名当前会话' },
        { cmd: '/del', args: '<name>', label: '删除指定会话' },
        ...(isAdmin ? [
          { cmd: '/fork', args: '[name]', label: '分支当前会话' },
          { cmd: '/clear', label: '清空会话对话历史' },
          { cmd: '/compact', label: '压缩会话上下文' },
        ] : []),
      ]
    });

    if (isAdmin) {
      items.push({
        group: 'Agent 与模型',
        commands: [
          { cmd: '/agent', args: '[name]', label: '查看或切换 Agent 后端' },
          { cmd: '/model', args: '[model] [effort]', label: '查看或切换模型' },
        ]
      });

      items.push({
        group: '权限管理',
        commands: [
          { cmd: '/perm', args: '[mode|allow|deny]', label: '权限模式管理' },
        ]
      });

      items.push({
        group: '运维',
        commands: [
          { cmd: '/status', label: '显示会话状态' },
          { cmd: '/stop', label: '中断当前任务' },
          { cmd: '/restart', label: '重启服务' },
          { cmd: '/repair', label: '检查并修复会话' },
          { cmd: '/safe', label: '进入安全模式' },
          { cmd: '/send', args: '<path>', label: '发送项目内文件' },
        ]
      });
    } else {
      items.push({
        group: '其他',
        commands: [
          { cmd: '/status', label: '显示会话状态' },
        ]
      });
    }

    items.push({
      group: '帮助',
      commands: [
        { cmd: '/help', label: '显示帮助信息' },
      ]
    });

    return items;
  }

  /**
   * 快速判断是否为命令（不进队列的命令）
   */
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
  ): Promise<string | null> {
    // 解析身份
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
    const isAdmin = identity.role === 'owner';

    if (normalizedContent.startsWith('/')) {
      const userCommands = ['/slist', '/new', '/session', '/rename', '/name', '/status', '/help', '/del', '/s '];
      const isUserCommand = userCommands.some(cmd =>
        normalizedContent === cmd.trimEnd() || normalizedContent.startsWith(cmd)
      );
      if (!isUserCommand && !isAdmin) {
        return '❌ 无权限：此命令仅限管理员使用';
      }
    }

    // 空闲检查：某些命令需要等待当前会话空闲
    const requiresIdle = ['/new', '/clear', '/compact', '/safe', '/repair', '/fork', '/bind'];
    if (requiresIdle.some(cmd => normalizedContent === cmd || normalizedContent.startsWith(cmd + ' '))) {
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
    if (!isCmd) return null;

    // /help 命令不需要会话
    if (normalizedContent === '/help') {
      if (!isAdmin) {
        const lines = [
          '可用命令：',
          '',
          '🔄 会话管理：',
          '  /new [名称] - 创建新会话（可选命名）',
          '  /slist - 列出当前项目的所有会话',
          '  /s, /session <名称|序号|uuid> - 切换到指定会话',
          '  /name, /rename <新名称> - 重命名当前会话',
          '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
          '  /status - 显示会话状态',
          '',
          '❓ 帮助：',
          '  /help - 显示此帮助信息',
        ];
        return lines.join('\n');
      }

      const lines = [
        '可用命令：',
        '',
        '📁 项目管理：',
        '  /pwd - 显示当前项目路径',
        '  /plist - 列出所有配置的项目',
        '  /p, /project <name|path> - 切换项目',
        '  /bind <path> - 绑定新项目目录',
        '',
        '🔄 会话管理：',
        '  /new [名称] - 创建新会话（可选命名）',
        '  /slist - 列出当前项目的所有会话',
        '  /s, /session <名称> - 切换到指定会话',
        '  /name, /rename <新名称> - 重命名当前会话',
        '  /del <名称> - 删除指定会话（仅解绑，不删除文件）',
        '  /fork [名称] - 分支当前会话（从当前对话点创建分支）',
        '  /clear - 清空当前会话的对话历史',
        '  /compact - 压缩会话上下文（减少 token 用量）',
        '',
        '🤖 Agent 与模型：',
        '  /agent [name] - 查看或切换 Agent 后端',
        '  /model [model] [effort] - 查看或切换模型/推理强度',
        '',
        '🔐 权限管理：',
        '  /perm - 查看当前权限模式',
        '  /perm <default|request|edit|plan|noask> - 切换权限模式',
        '  /perm allow|deny - 审批权限请求',
        '',
        '🛠️ 运维：',
        '  /status - 显示会话状态',
        '  /stop - 中断当前任务',
        '  /restart - 重启服务',
        '  /repair - 检查并修复会话',
        '  /safe - 进入安全模式',
        '  /send <路径> - 发送项目内文件',
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
        const currentMode = permSession.metadata?.permissionMode || 'default';
        const modes = permAgent.listModes();
        const modeList = modes.map(m => {
          const prefix = m.key === currentMode ? '▶' : ' ';
          const suffix = m.available ? '' : ' ⚠️ 不可用';
          return `  ${prefix} ${m.key} (${m.nameZh}) - ${m.description}${suffix}`;
        }).join('\n');
        return `🔐 当前权限模式: ${currentMode}\n\n${modeList}\n\n用法:\n  /perm <模式>       切换权限模式\n  /perm allow|deny   审批权限请求`;
      }

      const parts = args.split(/\s+/);

      // /perm <mode> 或 /perm allow|deny：切换模式 / 快捷审批
      if (parts.length === 1) {
        const arg = parts[0];

        // /perm allow|deny：快捷审批（自动找当前 session 唯一的 pending 请求）
        if (arg === 'allow' || arg === 'deny') {
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
          this.permissionGateway.resolvePermission(permSession.id, requestId, arg === 'allow');
          return arg === 'allow' ? `✓ 已授权，继续执行……` : `✓ 已拒绝`;
        }

        // /perm <mode>：切换权限模式
        if (hasPermissionController(permAgent)) {
          const modes = permAgent.listModes();
          const matched = modes.find(m => m.key === arg);
          if (matched) {
            if (!matched.available) {
              return `❌ ${matched.key} 模式当前不可用：${matched.unavailableReason}`;
            }
            const metadata = permSession.metadata || {};
            metadata.permissionMode = arg;
            await this.sessionManager.updateSession(permSession.id, { metadata });
            return `✓ 权限模式已切换为: ${matched.key} (${matched.nameZh})\n${matched.description}`;
          }
        }
        // 不是已知模式名也不是 allow/deny
        const modeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'default|request|edit|plan|noask';
        return `❌ 未知参数: ${arg}\n用法: /perm <${modeKeys}> 或 /perm allow|deny`;
      }

      // 双参数不再支持，提示正确用法
      const allModeKeys = hasPermissionController(permAgent) ? permAgent.listModes().map(m => m.key).join('|') : 'default|request|edit|plan|noask';
      return `❌ 未知参数: ${args}\n用法: /perm <${allModeKeys}> 或 /perm allow|deny`;
    }

    // /agent 命令：查看或切换 Agent 后端
    if (normalizedContent.startsWith('/agent')) {
      if (!isAdmin) return '❌ 无权限：此命令仅限管理员使用';
      const args = normalizedContent.slice(6).trim();
      const available = [...this.agentMap.keys()];

      if (!args) {
        const currentAgent = activeSession?.agentId || this.defaultAgentId;
        const list = available.map(a => `${a === currentAgent ? '✓' : '-'} ${a}`).join('\n');
        return `当前 Agent: ${currentAgent}\n\n可用:\n${list}\n\n用法: /agent <name>`;
      }

      if (!this.agentMap.has(args)) {
        return `❌ 未知 Agent: ${args}\n可用: ${available.join(', ')}`;
      }

      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
      const { session } = result;

      // 取消原会话的 pending 权限请求
      if (this.permissionGateway) {
        this.permissionGateway.cancelAll(session.id);
      }

      // 切换到目标 agent（恢复已有会话或创建新会话）
      const newSession = await this.sessionManager.switchAgent(channel, channelId, session.projectPath, args);
      const hasExistingSession = newSession.agentSessionId ? '（恢复已有会话）' : '（新建会话）';
      const projectName = this.getProjectName(session.projectPath);
      return `✓ 已切换 Agent: ${args}\n  项目: ${projectName}\n  会话: ${newSession.name || '(未命名)'}\n  ${hasExistingSession}`;
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
        const currentEffort = modelAgent.getEffort?.() || 'auto';
        const effortDisplay = currentEffort === 'auto' ? 'auto (SDK默认)' : `${currentEffort} ${effortBar(currentEffort)}`;
        const modelList = models.map((m: string) => `- ${m}`).join('\n');
        return `当前模型: ${currentModel}\n推理强度: ${effortDisplay}\n\n可用模型：\n${modelList}\n\n推理强度: ${availableEfforts.join(' / ')} / auto\n\n用法:\n  /model <model>           切换模型\n  /model <model> <effort>  切换模型+推理强度\n  /model <effort>          仅切换推理强度\n  /model auto              恢复SDK默认`;
      }

      const parts = args.split(/\s+/);
      let newModel: string | undefined;
      let newEffort: Effort | undefined;

      if (parts.length === 1) {
        const arg = parts[0];
        if (arg === 'auto') {
          const writeResult = writeUserSettings({ effortLevel: null });
          if (!writeResult.success) {
            return `⚠️ 写入用户配置失败: ${writeResult.error}\n已更新运行时配置，但未持久化到 ~/.claude/settings.json`;
          }

          modelAgent.setEffort?.(undefined);
          return '✓ 推理强度已恢复为 auto (SDK默认)';
        }
        // 单参数：模型 或 effort
        if ((availableEfforts as readonly string[]).includes(arg)) {
          newEffort = arg as Effort;
        } else if (models.includes(arg)) {
          newModel = arg;
        } else {
          const modelList = models.map((m: string) => `- ${m}`).join('\n');
          return `❌ 无效参数: ${arg}\n\n可用模型：\n${modelList}\n\n推理强度: ${availableEfforts.join(' / ')}`;
        }
      } else {
        // 双参数：model effort
        const [modelArg, effortArg] = parts;
        if (!models.includes(modelArg)) {
          return `❌ 无效的模型ID: ${modelArg}`;
        }
        if (!(availableEfforts as readonly string[]).includes(effortArg)) {
          return `❌ 无效的推理强度: ${effortArg}\n可选: ${availableEfforts.join(' / ')}`;
        }
        newModel = modelArg;
        newEffort = effortArg as Effort;
      }

      if (!this.config.agents) this.config.agents = {};
      if (!this.config.agents.anthropic) this.config.agents.anthropic = {};

      const changes: string[] = [];
      const updates: { model?: string; effortLevel?: string } = {};

      if (newModel) {
        updates.model = newModel;
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
        const modelAfterSwitch = newModel ?? (hasModelSwitcher(modelAgent) ? modelAgent.getModel() : modelAgent.name);
        if (newEffort === 'max' && !modelAfterSwitch.includes('opus')) {
          return '⚠️ max 推理强度仅 Opus 模型支持（opus / claude-opus-4-6）';
        }
        updates.effortLevel = newEffort;
        modelAgent.setEffort?.(newEffort);
        changes.push(`推理强度: ${newEffort} ${effortBar(newEffort)}`);
      }

      // 写入用户级 ~/.claude/settings.json（与 Claude CLI 行为一致）
      const writeResult = writeUserSettings(updates);
      if (!writeResult.success) {
        return `⚠️ 写入用户配置失败: ${writeResult.error}\n已更新运行时配置，但未持久化到 ~/.claude/settings.json`;
      }

      return `✓ 已切换\n  ${changes.join('\n  ')}`;
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

    // 对于需要创建会话的命令，如果没有会话则创建
    if (!session && (
      normalizedContent.startsWith('/new') ||
      normalizedContent.startsWith('/bind') ||
      normalizedContent.startsWith('/project')
    )) {
      session = await this.sessionManager.getOrCreateSession(
        channel,
        channelId,
        this.config.projects?.defaultPath || process.cwd()
      );
    }

    // /status 命令：显示会话状态
    if (normalizedContent === '/status') {
      if (!session) {
        return `📊 会话状态：

❌ 当前未创建会话

提示：发送任意消息或使用 /new 命令创建会话`;
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
      if (isAdmin) {
        lines.push(
          `📊 ${isThread ? '话题' : '会话'}状态：`,
          `渠道: ${channel} / 项目: ${projectName} / 会话: ${session.name || '(未命名)'}`,
          `会话ID: ${session.id}`,
          `项目路径: ${session.projectPath}`,
          `会话状态: ${sessionStatus}`,
          `会话轮数: ${sessionTurns}`,
          `异常计数: ${health.consecutiveErrors}`,
          `安全模式: ${health.safeMode ? '是 ⚠️' : '否 ✓'}`,
          `最后成功: ${timeStr}`,
          `${session.agentId}会话: ${session.agentSessionId || '(未初始化)'}`,
          `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
          `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
        );
      } else {
        lines.push(
          `📊 ${isThread ? '话题' : '会话'}状态：`,
          `会话: ${session.name || '(未命名)'}`,
          `状态: ${sessionStatus}`,
          `会话轮数: ${sessionTurns}`,
          `最后活跃: ${timeStr}`
        );
      }

      if (health.safeMode) {
        lines.push('');
        lines.push('⚠️ 当前处于安全模式（历史上下文已禁用）');
        lines.push('');
        lines.push('退出方式：');
        lines.push('1. /repair - 检查并修复会话（推荐，保留历史）');
        lines.push('2. /new [名称] - 创建新会话（清空历史）');
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
        await agent.closeSession(session.id);
      }

      return `✓ 已创建新会话${sessionName ? `: ${sessionName}` : ''}\n  之前的对话历史已保留，可通过 /slist 查看`;
    }

    // /restart 命令：重启服务
    if (normalizedContent === '/restart') {
      const allSessions = await this.sessionManager.listSessions(channel, channelId);
      const sessionsWithMessages = allSessions
        .filter(s => this.messageCache.hasMessages(s.id))
        .map(s => {
          const count = this.messageCache.getCount(s.id);
          return `${s.projectPath} 有 ${count} 条新消息`;
        });

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

      // 话题中 restart 时保存 replyContext 用于重启后回复到话题
      let replyContext: import('../types.js').ReplyContext | undefined;
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
      return '🔄 服务正在重启，请稍候...（约 5 秒后恢复）';
    }

    // /pwd 命令：显示当前项目路径
    if (normalizedContent === '/pwd') {
      if (!session) {
        return `❌ 当前没有活跃会话

提示：发送任意消息或使用 /new 命令创建会话`;
      }

      const configName = this.getConfiguredProjectName(session.projectPath);
      if (configName) {
        return `当前项目: ${configName}\n路径: ${session.projectPath}`;
      }
      return `当前项目: ${session.projectPath}`;
    }

    // /send 命令：发送项目内文件
    if (normalizedContent.startsWith('/send')) {
      // 飞书会将 .md 等后缀自动转为 Markdown 链接: foo.md → [foo.md](http://foo.md/)
      // 还原: 将 [text](url) 替换为 text
      const filePath = normalizedContent.slice(5).trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (!filePath) {
        return '用法: /send <相对路径>\n示例: /send src/index.ts';
      }

      // 获取 adapter
      const sendAdapter = this.adapters.get(channel);
      if (!sendAdapter?.sendFile) {
        return '❌ 当前渠道不支持文件发送';
      }

      // 获取 session（需要 projectPath 和 replyContext）
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

      // 目录检查（一期不支持）
      if (stat.isDirectory()) {
        return '❌ 暂不支持发送目录\n目录打包发送将在后续版本支持';
      }

      // 大小检查（10MB）
      const MAX_SIZE = 10 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        return `❌ 文件过大: ${sizeMB} MB (限制 10 MB)`;
      }

      // 发送文件
      try {
        const replyCtx = this.getReplyContext(sendSession);
        await sendAdapter.sendFile(channelId, realPath, replyCtx);
        const sizeStr = stat.size < 1024 ? `${stat.size} B`
          : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)} KB`
          : `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
        return `✅ 已发送: ${filePath} (${sizeStr})`;
      } catch (error: any) {
        logger.error('[CommandHandler] /send failed:', error);
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

      const lines = ['可用项目:'];

      // 收集项目信息并按最近活跃排序
      const entries: { name: string; projectPath: string; projectSession: any; isCurrent: boolean; updatedAt: number }[] = [];

      const configuredPaths = new Set<string>();
      for (const [name, projectPath] of Object.entries(this.projects)) {
        configuredPaths.add(projectPath);
        const isCurrent = session?.projectPath === projectPath;
        const projectSession = await this.sessionManager.getSessionByProjectPath(channel, channelId, projectPath);
        entries.push({
          name, projectPath, projectSession, isCurrent,
          updatedAt: projectSession?.updatedAt ?? 0,
        });
      }

      // Include bound projects not in config (created via /bind)
      const allSessions = await this.sessionManager.listSessions(channel, channelId);
      for (const s of allSessions) {
        if (!configuredPaths.has(s.projectPath)) {
          configuredPaths.add(s.projectPath);
          const isCurrent = session?.projectPath === s.projectPath;
          entries.push({
            name: path.basename(s.projectPath), projectPath: s.projectPath, projectSession: s, isCurrent,
            updatedAt: s.updatedAt ?? 0,
          });
        }
      }

      // 当前活跃项目置顶，其余按 updatedAt 降序
      entries.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });

      for (const { name, projectPath, projectSession, isCurrent } of entries) {
        const prefix = isCurrent ? '  ✓' : '   ';

        if (!projectSession) {
          lines.push(`${prefix} ${name} (${projectPath}) - 无会话`);
          continue;
        }

        const statusParts = [];

        if (isCurrent) {
          statusParts.push('活跃');
        } else {
          const idleMs = Date.now() - projectSession.updatedAt;
          statusParts.push(formatIdleTime(idleMs));
        }

        // 用 DB processingState 判断处理状态
        const isProcessing = !!projectSession.processingState;
        if (isProcessing) {
          const queueLength = this.messageQueue.getQueueLength(projectSession.id);
          if (queueLength > 0) {
            statusParts.push(`[处理中，队列${queueLength}条]`);
          } else {
            statusParts.push('[处理中]');
          }
        }

        const unreadCount = this.messageCache.getCount(projectSession.id);
        if (unreadCount > 0) {
          statusParts.push(`[${unreadCount}条新消息]`);
        } else if (!isProcessing && !isCurrent) {
          statusParts.push('[空闲]');
        }

        lines.push(`${prefix} ${name} (${projectPath}) - ${statusParts.join(' ')}`);
      }
      return lines.join('\n');
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
          return `❌ 项目 "${arg}" 不存在\n提示: 使用 /plist 查看可用项目`;
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

    // /bind 命令：持久化项目到配置（不切换）
    if (normalizedContent.startsWith('/bind ')) {
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

    // /slist 命令：列出当前项目的所有会话
    if (normalizedContent === '/slist') {
      if (!session) {
        return `❌ 当前没有活跃会话

请先执行以下操作之一：
1. 发送任意消息 - 自动创建新会话
2. /new [名称] - 创建命名会话
3. /project <项目> - 切换到指定项目`;
      }

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

      const canImportCli = policy.canImportCliSession(session.chatType || 'private', identity.role);
      const cliSessions = canImportCli
        ? await this.sessionManager.scanCliSessions(session.projectPath, session.agentId)
        : [];
      const dbSessionIds = new Set(currentProjectSessions.map(s => s.agentSessionId).filter(Boolean));

      const lines = [`当前项目 ${path.basename(session.projectPath)} 的会话列表:`, ''];

      if (currentProjectSessions.length > 0) {
        // 超过10个会话时隐藏话题会话（/slist 只能在主会话调用，话题内已禁用）
        const hideTopics = currentProjectSessions.length > 10;
        const topicCount = hideTopics ? currentProjectSessions.filter(s => s.threadId).length : 0;
        const maxDisplay = 10;

        lines.push('【EvolClaw 会话】');
        let displayIndex = 0;
        for (let i = 0; i < currentProjectSessions.length; i++) {
          const s = currentProjectSessions[i];
          if (hideTopics && s.threadId) continue;
          if (displayIndex >= maxDisplay) break;

          const isActive = (s.metadata as any)?.isActive === true;
          displayIndex++;
          const prefix = isActive ? '  ✓' : '   ';
          const num = `${displayIndex}.`;
          const threadTag = s.threadId ? '[话题] ' : '';
          const name = s.name || '(未命名)';
          const uuid = s.agentSessionId ? `(${s.agentSessionId.substring(0, 8)})` : '';
          const idleTime = formatIdleTime(Date.now() - s.updatedAt);

          if (s.agentSessionId && !this.sessionManager.checkSessionFileExists(s.projectPath, s.agentSessionId, s.agentId)) {
            lines.push(`${prefix} ${num} ${threadTag}❌ ${name} ${uuid} - ${idleTime} [会话文件缺失]`);
          } else {
            const sIsProcessing = !!s.processingState;
            let status = '[空闲]';
            if (sIsProcessing) {
              status = '[处理中]';
            } else if (isActive) {
              status = '[活跃]';
            }
            lines.push(`${prefix} ${num} ${threadTag}${name} ${uuid} - ${idleTime} ${status}`);
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

      const orphanCliSessions = cliSessions.filter(c => !dbSessionIds.has(c.uuid)).slice(0, 5);
      if (orphanCliSessions.length > 0) {
        lines.push('【CLI 会话】(最新5个)');
        for (const c of orphanCliSessions) {
          const time = new Date(c.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const message = this.sessionManager.readSessionFirstMessage(session.projectPath, c.uuid, session.agentId) || '(无消息)';
          const uuid = c.uuid.substring(0, 8);
          lines.push(`  ${time}  (${uuid})  "${message}"`);
        }
        lines.push('');
      }

      lines.push('使用 /s <序号、name或8位uuid> 切换会话');
      return lines.join('\n');
    }

    // /session 或 /s 命令：切换会话
    if (normalizedContent.startsWith('/session ')) {
      const sessionName = normalizedContent.slice(9).trim();

      if (!sessionName) return '用法: /s <序号、会话名称或前8位UUID>';

      const isProcessing = !!session?.processingState;
      if (isProcessing) {
        return `⚠️ 当前正在处理消息，无法切换会话\n请等待当前任务完成后再试`;
      }

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
          return `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /slist 查看可用会话`;
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
        return `❌ 会话不存在: ${sessionName}\n使用 /slist 查看可用会话`;
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
          return `❌ 序号超出范围 (1-${visibleSessions.length})\n使用 /slist 查看可用会话`;
        }
      }

      if (!targetSession && sessionName.length === 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      if (!targetSession) {
        return `❌ 会话不存在: ${sessionName}\n使用 /slist 查看可用会话`;
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

        return `✅ 会话已分支: ${newSession.name}\n新会话已激活，可以继续对话\n\n使用 /slist 查看所有会话，/s <名称> 切换回原会话`;
      } catch (error) {
        logger.error('[CommandHandler] Fork session failed:', error);
        return `❌ 会话分支失败: ${error instanceof Error ? error.message : '未知错误'}`;
      }
    }

    // /repair 命令：检查并修复会话
    if (normalizedContent === '/repair') {
      const repairResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in repairResult) return repairResult.error;
      const { session: repairSession } = repairResult;

      const health = await this.sessionManager.getHealthStatus(repairSession.id);
      if (!health.safeMode) {
        return `当前不在安全模式，无需修复\n\n如需进入安全模式，请使用 /safe`;
      }

      const repairAgent = this.getAgent(repairSession.agentId);
      const { checkSessionFile, backupSessionFile } = await import('../utils/session-file-health.js');

      try {
        if (!repairSession.agentSessionId) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          this.eventBus.publish({ type: 'session:safe-mode-exited', sessionId: repairSession.id, method: 'repair' });
          return `✓ 修复完成，已退出安全模式\n\n修复内容：\n- 未发现问题（新会话）\n- 已重置异常计数器\n- 已恢复正常会话模式`;
        }

        // 通过 agent 定位 session 文件
        const sessionFile = repairAgent.resolveSessionFile?.(repairSession.agentSessionId, repairSession.projectPath) ?? null;

        if (!sessionFile) {
          // 文件不存在（已被删除或从未创建），直接重置
          await this.sessionManager.resetHealthStatus(repairSession.id);
          this.eventBus.publish({ type: 'session:safe-mode-exited', sessionId: repairSession.id, method: 'repair' });
          return `✓ 修复完成，已退出安全模式\n\n修复内容：\n- 会话文件不存在（可能已被清理）\n- 已重置异常计数器\n- 已恢复正常会话模式`;
        }

        const healthCheck = await checkSessionFile(sessionFile);

        if (healthCheck.corrupt) {
          const backupPath = await backupSessionFile(sessionFile);
          const fsPromises = await import('fs/promises');
          await fsPromises.unlink(sessionFile);
          await this.sessionManager.updateAgentSessionIdBySessionId(repairSession.id, '');
          repairAgent.updateSessionId(repairSession.id, '');
          await this.sessionManager.resetHealthStatus(repairSession.id);
          this.eventBus.publish({ type: 'session:safe-mode-exited', sessionId: repairSession.id, method: 'repair' });

          return `✓ 修复完成，已退出安全模式\n\n检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n修复操作：\n- 已备份损坏文件\n- 已删除损坏文件\n- 已重置异常计数器\n\n备份位置：${backupPath}`;
        }

        if (healthCheck.issues.length > 0) {
          await this.sessionManager.resetHealthStatus(repairSession.id);
          this.eventBus.publish({ type: 'session:safe-mode-exited', sessionId: repairSession.id, method: 'repair' });
          return `⚠️ 检测到问题：\n${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}\n\n建议使用 /new 创建新会话\n\n已重置异常计数器，可继续使用当前会话。`;
        }

        await this.sessionManager.resetHealthStatus(repairSession.id);
        this.eventBus.publish({ type: 'session:safe-mode-exited', sessionId: repairSession.id, method: 'repair' });
        return `✓ 修复完成，已退出安全模式\n\n修复内容：\n- 未发现问题\n- 已重置异常计数器\n- 已恢复正常会话模式`;
      } catch (error: any) {
        logger.error('[Repair] Failed:', error);
        return `❌ 修复失败: ${error.message}`;
      }
    }

    // /safe 命令：手动进入安全模式
    if (normalizedContent === '/safe') {
      const safeResult = await this.ensureSession(channel, channelId, threadId);
      if ('error' in safeResult) return safeResult.error;
      const { session: safeSession } = safeResult;

      await this.sessionManager.setSafeMode(safeSession.id, true);

      this.eventBus.publish({ type: 'session:safe-mode-entered', sessionId: safeSession.id, reason: 'manual' });

      return `✓ 已进入安全模式

当前行为：
- 暂时不加载会话历史（每次对话独立）
- 所有功能正常可用（读写文件、执行命令等）
- 不会丢失历史数据（仍保存在 .claude/ 目录）

退出安全模式：
- 使用 /repair 检查并修复会话
- 使用 /new 创建全新会话`;
    }

    return null;
  }
}
