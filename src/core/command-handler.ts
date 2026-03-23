import { Config, ChannelAdapter, Session } from '../types.js';
import { SessionManager } from './session-manager.js';
import { AgentRunner } from './agent-runner.js';
import { MessageCache } from './message-cache.js';
import { MessageProcessor } from './message-processor.js';
import { renameSession as sdkRenameSession, forkSession as sdkForkSession, listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { MessageQueue } from './message-queue.js';
import { saveConfig, resolvePaths, getPackageRoot } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';

const availableModels: string[] = ['opus', 'sonnet', 'haiku', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

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
const commands = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/slist', '/session', '/rename', '/stop', '/clear', '/compact', '/repair', '/safe', '/fork'];

// 命令别名映射
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename'
};

// 命令快速路径前缀（不进入消息队列的命令）
// 注意：/stop, /clear, /compact, /safe 故意不在此列表中，它们需要进入队列触发中断机制
const quickCommandPrefixes = ['/new', '/pwd', '/plist', '/project', '/bind', '/help', '/status', '/restart', '/model', '/slist', '/session', '/rename', '/repair', '/fork', '/p ', '/s ', '/name '];

export class CommandHandler {
  private adapters = new Map<string, ChannelAdapter>();
  private processor!: MessageProcessor;
  private messageQueue!: MessageQueue;

  constructor(
    private sessionManager: SessionManager,
    private agentRunner: AgentRunner,
    private config: Config,
    private messageCache: MessageCache,
  ) {}

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

  /** 获取活跃会话，无会话时返回统一错误提示 */
  private async ensureSession(channel: string, channelId: string): Promise<{ session: Session } | { error: string }> {
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

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.adapters.get(channelName);
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
    sendMessage?: (channelId: string, text: string) => Promise<void>,
    userId?: string,
  ): Promise<string | null> {
    // 规范化命令（将别名转换为完整命令）
    let normalizedContent = content;
    for (const [alias, full] of Object.entries(aliases)) {
      if (content === alias || content.startsWith(alias + ' ')) {
        normalizedContent = content.replace(alias, full);
        break;
      }
    }

    // 权限检查：只有主人可以执行斜杠命令
    if (normalizedContent.startsWith('/')) {
      const { isOwner } = await import('../config.js');
      if (userId && !isOwner(this.config, channel, userId)) {
        return '❌ 无权限：只有主人可以执行命令';
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
      return `可用命令：
📁 项目管理：
  /pwd - 显示当前项目路径
  /plist - 列出所有配置的项目
  /p, /project <name|path> - 切换项目
  /bind <path> - 绑定新项目目录

🔄 会话管理：
  /new [名称] - 创建新会话（可选命名）
  /slist - 列出当前项目的所有会话
  /s, /session <名称> - 切换到指定会话
  /name, /rename <新名称> - 重命名当前会话
  /fork [名称] - 分支当前会话（从当前对话点创建分支）
  /status - 显示会话状态
  /clear - 清空当前会话的对话历史
  /compact - 压缩会话上下文（减少 token 用量）
  /stop - 中断当前任务
  /restart - 重启服务

🛠️ 会话修复：
  /repair - 检查并修复会话
  /safe - 进入安全模式

🤖 模型管理：
  /model [model-id] - 查看或切换模型

❓ 帮助：
  /help - 显示此帮助信息`;
    }

    // /model 命令：查看或切换模型
    if (normalizedContent.startsWith('/model')) {
      const args = normalizedContent.slice(6).trim();

      if (!args) {
        const currentModel = this.agentRunner.getModel();
        const modelList = availableModels.map(m => `- ${m}`).join('\n');
        return `当前模型: ${currentModel}\n\n可用模型：\n${modelList}\n\n用法: /model <model-id>`;
      }

      if (!availableModels.includes(args)) {
        const modelList = availableModels.map(m => `- ${m}`).join('\n');
        return `❌ 无效的模型ID: ${args}\n\n可用模型：\n${modelList}`;
      }

      if (!this.config.anthropic) this.config.anthropic = {};
      this.config.anthropic.model = args;
      saveConfig(this.config);
      this.agentRunner.setModel(args);

      return `✓ 已切换到模型: ${args}`;
    }

    // /stop 命令：中断当前任务
    if (normalizedContent === '/stop') {
      const sessionKey = `${channel}-${channelId}`;
      const queueLength = this.messageQueue.getQueueLength(sessionKey);

      if (queueLength === 0) {
        return '当前没有正在处理的任务';
      }

      await this.agentRunner.interrupt(sessionKey);
      return '✓ 已发送中断信号，任务将尽快停止';
    }

    // /clear 命令：通过 SDK /clear 清空会话历史
    if (normalizedContent === '/clear') {
      const result = await this.ensureSession(channel, channelId);
      if ('error' in result) return result.error;
      const { session } = result;

      if (!session.claudeSessionId) {
        return '❌ 当前会话没有历史记录，无需清空';
      }

      const projectPath = path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);

      const cleared = await this.agentRunner.clearSession(session.claudeSessionId, projectPath);
      if (cleared) {
        await this.sessionManager.updateClaudeSessionIdBySessionId(session.id, '');
        this.agentRunner.updateSessionId(session.id, '');
        return '✅ 已清空当前会话的对话历史';
      } else {
        return '❌ 清空会话失败，请稍后重试';
      }
    }

    // /compact 命令：手动压缩会话上下文
    if (normalizedContent === '/compact') {
      const result = await this.ensureSession(channel, channelId);
      if ('error' in result) return result.error;
      const { session } = result;

      if (!session.claudeSessionId) {
        return '❌ 当前会话没有历史记录，无需压缩';
      }

      const projectPath = path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);

      if (sendMessage) {
        await sendMessage(channelId, '⏳ 正在压缩会话上下文...');
      }

      const compacted = await this.agentRunner.compactSession(session.id, session.claudeSessionId, projectPath);
      if (compacted) {
        return '✅ 会话上下文已压缩';
      } else {
        return '❌ 会话压缩失败，请稍后重试';
      }
    }

    // 尝试获取活跃会话（所有命令都尝试获取，但不强制）
    let session = await this.sessionManager.getActiveSession(channel, channelId);

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

      const sessionKey = `${channel}-${channelId}`;
      const isCurrentlyProcessing = this.messageQueue.isProcessing(sessionKey);
      const queueLength = this.messageQueue.getQueueLength(sessionKey);

      let activeStatus = session.isActive ? '✓ 活跃' : '休眠';
      if (session.isActive && isCurrentlyProcessing) {
        if (queueLength > 0) {
          activeStatus += ` [处理中，队列${queueLength}条]`;
        } else {
          activeStatus += ' [处理中]';
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
      if (session.claudeSessionId) {
        const fileInfo = this.sessionManager.getSessionFileInfo(session.projectPath, session.claudeSessionId);
        sessionTurns = fileInfo.turns;
        if (fileInfo.title && fileInfo.title !== session.name) {
          await this.sessionManager.renameSession(session.id, fileInfo.title);
          session.name = fileInfo.title;
        }
      }

      const lines = [
        '📊 会话状态：',
        `渠道: ${channel} / 项目: ${projectName} / 会话: ${session.name || '(未命名)'}`,
        `会话ID: ${session.id}`,
        `项目路径: ${session.projectPath}`,
        `活跃状态: ${activeStatus}`,
        `会话轮数: ${sessionTurns}`,
        `异常计数: ${health.consecutiveErrors}`,
        `安全模式: ${health.safeMode ? '是 ⚠️' : '否 ✓'}`,
        `最后成功: ${timeStr}`,
        `Claude会话: ${session.claudeSessionId || '(未初始化)'}`,
        `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
        `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
      ];

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
        sessionName
      );

      if (session) {
        await this.agentRunner.closeSession(session.id);
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

      const restartInfo = {
        channel,
        channelId,
        timestamp: Date.now()
      };
      fs.writeFileSync(path.join(resolvePaths().dataDir, 'restart-pending.json'), JSON.stringify(restartInfo));

      const { spawn } = await import('child_process');
      spawn('node', [path.join(getPackageRoot(), 'dist', 'cli.js'), 'restart-monitor'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root }
      }).unref();

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

    // /plist 命令：列出所有项目
    if (normalizedContent === '/plist') {
      const isGroup = await this.isGroupChat(channel, channelId);
      if (isGroup) {
        if (!session) {
          return `❌ 当前群聊未绑定项目

请使用 /bind <项目路径> 绑定项目`;
        }

        const projectName = this.getProjectName(session.projectPath);

        const sessionKey = `${channel}-${channelId}`;
        const queueLength = this.messageQueue.getQueueLength(sessionKey);
        const status = queueLength > 0 ? '[处理中]' : '[空闲]';

        return `当前群聊绑定的项目：
  ${projectName} (${session.projectPath}) - ${status}

提示：群聊不支持切换项目`;
      }

      const lines = ['可用项目:'];
      const sessionKey = `${channel}-${channelId}`;
      const processingProject = this.messageQueue.getProcessingProject(sessionKey);
      const queueLength = this.messageQueue.getQueueLength(sessionKey);

      const normalizePath = (p: string) => p.replace(/\/+$/, '');

      for (const [name, projectPath] of Object.entries(this.projects)) {
        const isCurrent = session?.projectPath === projectPath;
        const prefix = isCurrent ? '  ✓' : '   ';

        const projectSession = await this.sessionManager.getSessionByProjectPath(channel, channelId, projectPath);

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

        if (processingProject && normalizePath(processingProject) === normalizePath(projectPath)) {
          if (queueLength > 1) {
            statusParts.push(`[处理中，队列${queueLength - 1}条]`);
          } else {
            statusParts.push('[处理中]');
          }
        }

        const unreadCount = this.messageCache.getCount(projectSession.id);
        if (unreadCount > 0) {
          statusParts.push(`[${unreadCount}条新消息]`);
        } else if (!processingProject || normalizePath(processingProject) !== normalizePath(projectPath)) {
          statusParts.push('[空闲]');
        }

        lines.push(`${prefix} ${name} (${projectPath}) - ${statusParts.join(' ')}`);
      }
      return lines.join('\n');
    }

    // /project 命令：切换项目（支持名称或路径）
    if (normalizedContent.startsWith('/project ')) {
      const isGroup = await this.isGroupChat(channel, channelId);
      if (isGroup) {
        return `❌ 群聊不支持切换项目

群聊只能绑定一个项目。如需更换项目，请联系管理员重新配置。`;
      }

      const arg = normalizedContent.slice(9).trim();

      if (!arg) return '用法: /p <name|path> 或 /project <name|path>';

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

      const newSession = await this.sessionManager.switchProject(channel, channelId, projectPath);

      const cachedEvents = this.messageCache.getEvents(newSession.id);

      const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
      let response = `✓ 已切换到项目: ${projectName}\n  路径: ${projectPath}\n  ${hasExistingSession}`;

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

    // /bind 命令：绑定新项目目录
    if (normalizedContent.startsWith('/bind ')) {
      const projectPath = normalizedContent.slice(6).trim();

      if (!projectPath) return '用法: /bind <path>';

      if (!path.isAbsolute(projectPath)) {
        return '❌ 项目路径必须是绝对路径';
      }
      if (!fs.existsSync(projectPath)) {
        return `❌ 路径不存在: ${projectPath}`;
      }

      const newSession = await this.sessionManager.switchProject(channel, channelId, projectPath);

      const cachedEvents = this.messageCache.getEvents(newSession.id);

      const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
      let response = `✓ 已绑定项目目录: ${projectPath}\n  ${hasExistingSession}`;

      if (cachedEvents.length > 0) {
        response += `\n\n后台任务结果:`;
        for (const event of cachedEvents) {
          if (event.type === 'completed') {
            response += `\n✓ 任务完成`;
            if (event.metadata?.duration) {
              response += ` (耗时: ${Math.round(event.metadata.duration / 1000)}s)`;
            }
            const summary = event.message.substring(0, 200);
            response += `\n${summary}${event.message.length > 200 ? '...' : ''}`;
          } else if (event.type === 'error') {
            response += `\n❌ 任务失败: ${event.metadata?.errorType || '未知错误'}`;
            response += `\n${event.message}`;
          }
        }

        this.messageCache.clearEvents(newSession.id);
      }

      return response;
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
      const currentProjectSessions = sessions.filter(s => s.projectPath === session.projectPath);

      // 从 SDK 同步会话名称（发现 CLI 改名）
      try {
        const sdkSessions = await sdkListSessions({ dir: session.projectPath });
        for (const sdkSession of sdkSessions) {
          const sdkName = sdkSession.customTitle || undefined;
          if (!sdkName) continue;
          const dbSession = currentProjectSessions.find(s => s.claudeSessionId === sdkSession.sessionId);
          if (dbSession && sdkName !== dbSession.name) {
            await this.sessionManager.renameSession(dbSession.id, sdkName);
            dbSession.name = sdkName;
          }
        }
      } catch (error) {
        logger.debug('[CommandHandler] SDK listSessions sync failed (non-critical):', error);
      }

      const isGroup = await this.isGroupChat(channel, channelId);
      const cliSessions = isGroup
        ? []
        : await this.sessionManager.scanCliSessions(session.projectPath);
      const dbSessionIds = new Set(currentProjectSessions.map(s => s.claudeSessionId).filter(Boolean));

      const lines = [`当前项目 ${path.basename(session.projectPath)} 的会话列表:\n`];

      const sessionKey = `${channel}-${channelId}`;
      const isProcessing = this.messageQueue.isProcessing(sessionKey);

      if (currentProjectSessions.length > 0) {
        lines.push('【EvolClaw 会话】');
        for (const s of currentProjectSessions) {
          const prefix = s.isActive ? '  ✓' : '   ';
          const name = s.name || '(未命名)';
          const uuid = s.claudeSessionId ? `(${s.claudeSessionId.substring(0, 8)})` : '';
          const idleTime = formatIdleTime(Date.now() - s.updatedAt);

          if (s.claudeSessionId && !this.sessionManager.checkSessionFileExists(s.projectPath, s.claudeSessionId)) {
            lines.push(`${prefix} ❌ ${name} ${uuid} - ${idleTime} [会话文件缺失]`);
          } else {
            let status = '[空闲]';
            if (s.isActive && isProcessing) {
              status = '[处理中]';
            } else if (s.isActive) {
              status = '[活跃]';
            }
            lines.push(`${prefix} ${name} ${uuid} - ${idleTime} ${status}`);
          }
        }
        lines.push('');
      }

      const orphanCliSessions = cliSessions.filter(c => !dbSessionIds.has(c.uuid)).slice(0, 5);
      if (orphanCliSessions.length > 0) {
        lines.push('【CLI 会话】(最新5个)');
        for (const c of orphanCliSessions) {
          const time = new Date(c.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const message = this.sessionManager.readSessionFirstMessage(session.projectPath, c.uuid) || '(无消息)';
          const uuid = c.uuid.substring(0, 8);
          lines.push(`  ${time}  (${uuid})  "${message}"`);
        }
        lines.push('');
      }

      lines.push('使用 /s <name或8位uuid> 切换会话');
      return lines.join('\n');
    }

    // /session 或 /s 命令：切换会话
    if (normalizedContent.startsWith('/session ')) {
      const sessionName = normalizedContent.slice(9).trim();

      if (!sessionName) return '用法: /s <会话名称或前8位UUID>';

      const sessionKey = `${channel}-${channelId}`;
      const queueLength = this.messageQueue.getQueueLength(sessionKey);
      if (queueLength > 0) {
        return `⚠️ 当前正在处理消息，无法切换会话\n请等待当前任务完成后再试`;
      }

      let targetSession = await this.sessionManager.getSessionByName(channel, channelId, sessionName);

      if (!targetSession && sessionName.length === 8) {
        targetSession = await this.sessionManager.getSessionByUuidPrefix(channel, channelId, sessionName);
      }

      const isGroup = await this.isGroupChat(channel, channelId);
      if (!targetSession && sessionName.length === 8 && !isGroup) {
        const projectPaths = Object.values(this.projects);

        if (session) {
          projectPaths.unshift(session.projectPath);
        }

        for (const projectPath of projectPaths) {
          const cliSessions = await this.sessionManager.scanCliSessions(projectPath);
          const cliSession = cliSessions.find(c => c.uuid.startsWith(sessionName));

          if (cliSession) {
            const imported = await this.sessionManager.importCliSession(channel, channelId, projectPath, cliSession.uuid);
            const projectName = this.getProjectName(projectPath);
            return `✓ 已导入 CLI 会话: ${imported.name}\n  项目: ${projectName}\n  将继续之前的对话历史`;
          }
        }
      }

      if (!targetSession) {
        return `❌ 会话不存在: ${sessionName}\n使用 /slist 查看可用会话`;
      }

      const lastInput = targetSession.claudeSessionId
        ? this.sessionManager.readSessionLastUserMessage(targetSession.projectPath, targetSession.claudeSessionId)
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

      const switched = await this.sessionManager.switchToSession(channel, channelId, targetSession.id);

      if (!switched) {
        return `❌ 切换会话失败`;
      }

      return `✓ 已切换到会话: ${targetSession.name || sessionName}\n  将继续之前的对话历史${lastInputLine}`;
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

      // 双写：SDK + 数据库
      if (session.claudeSessionId) {
        try {
          await sdkRenameSession(session.claudeSessionId, newName, { dir: session.projectPath });
        } catch (error) {
          logger.warn(`[CommandHandler] SDK renameSession failed (continuing with db update):`, error);
        }
      }
      const success = await this.sessionManager.renameSession(session.id, newName);

      if (!success) {
        return `❌ 重命名失败`;
      }

      return `✓ 已将当前会话重命名为: ${newName}`;
    }

    // /fork 命令：分支当前会话
    if (normalizedContent === '/fork' || normalizedContent.startsWith('/fork ')) {
      const forkName = normalizedContent.slice(5).trim() || undefined;

      if (!session) {
        return `❌ 当前没有活跃会话，无法分支`;
      }

      if (!session.claudeSessionId) {
        return `❌ 当前会话尚未初始化 Claude 对话，无法分支\n\n请先发送一条消息，然后再使用 /fork`;
      }

      try {
        const forkResult = await sdkForkSession(session.claudeSessionId, { dir: session.projectPath, title: forkName });
        const newSession = await this.sessionManager.createForkedSession(session, forkResult.sessionId, forkName);

        return `✅ 会话已分支: ${newSession.name}\n新会话已激活，可以继续对话\n\n使用 /slist 查看所有会话，/s <名称> 切换回原会话`;
      } catch (error) {
        logger.error('[CommandHandler] Fork session failed:', error);
        return `❌ 会话分支失败: ${error instanceof Error ? error.message : '未知错误'}`;
      }
    }

    // /repair 命令：检查并修复会话
    if (normalizedContent === '/repair') {
      if (!session) {
        return `❌ 当前未创建会话，无需修复`;
      }

      const health = await this.sessionManager.getHealthStatus(session.id);
      if (!health.safeMode) {
        return `当前不在安全模式，无需修复\n\n如需进入安全模式，请使用 /safe`;
      }

      const { checkSessionFileHealth, backupClaudeDir } = await import('../utils/session-file-health.js');
      const fsPromises = await import('fs/promises');

      try {
        const backupDir = await backupClaudeDir(session.projectPath);

        if (!session.claudeSessionId) {
          await this.sessionManager.resetHealthStatus(session.id);
          return `✓ 修复完成，已退出安全模式

修复内容：
- 未发现问题（新会话）
- 已重置异常计数器
- 已恢复正常会话模式

备份位置：${backupDir}`;
        }

        const healthCheck = await checkSessionFileHealth(session.projectPath, session.claudeSessionId);

        if (healthCheck.corrupt) {
          const sessionFile = path.join(session.projectPath, '.claude', `${session.claudeSessionId}.jsonl`);
          await fsPromises.unlink(sessionFile);
          await this.sessionManager.updateClaudeSessionId(session.channel, session.channelId, '');
          await this.sessionManager.resetHealthStatus(session.id);

          return `✓ 修复完成，已退出安全模式

检测到问题：
${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}

修复操作：
- 已删除损坏文件
- 已创建新会话
- 已重置异常计数器

备份位置：${backupDir}`;
        }

        if (healthCheck.issues.length > 0) {
          await this.sessionManager.resetHealthStatus(session.id);
          return `⚠️ 检测到问题：
${healthCheck.issues.map((i: string) => `- ${i}`).join('\n')}

建议：
1. 使用 /new 创建新会话
2. 旧会话已备份到：${backupDir}

已重置异常计数器，可继续使用当前会话。`;
        }

        await this.sessionManager.resetHealthStatus(session.id);
        return `✓ 修复完成，已退出安全模式

修复内容：
- 未发现问题
- 已重置异常计数器
- 已恢复正常会话模式

备份位置：${backupDir}`;
      } catch (error: any) {
        logger.error('[Repair] Failed:', error);
        return `❌ 修复失败: ${error.message}`;
      }
    }

    // /safe 命令：手动进入安全模式
    if (normalizedContent === '/safe') {
      if (!session) {
        return `❌ 当前未创建会话`;
      }

      await this.sessionManager.setSafeMode(session.id, true);

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

  /**
   * 通过 adapter 查询是否为群聊
   */
  private async isGroupChat(channel: string, channelId: string): Promise<boolean> {
    const adapter = this.adapters.get(channel);
    return await adapter?.isGroupChat?.(channelId) ?? false;
  }
}
