import { loadConfig, saveConfig, ensureDir } from './config.js';
import { SessionManager } from './session-manager.js';
import { AgentRunner } from './agent-runner.js';
import { FeishuChannel } from './channels/feishu.js';
import { ACPChannel } from './channels/acp.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageQueue } from './core/message-queue.js';
import { MessageCache } from './core/message-cache.js';
import { Config, ChannelAdapter, ChannelOptions, CommandHandler } from './types.js';
import { logger } from './utils/logger.js';
import path from 'path';
import fs from 'fs';

let availableModels: string[] = [];

async function fetchAvailableModels(apiKey: string, baseUrl?: string): Promise<void> {
  try {
    const url = `${baseUrl || 'https://api.anthropic.com'}/v1/models`;
    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    availableModels = data.data.map((m: any) => m.id);
    logger.info(`✓ Loaded ${availableModels.length} available models`);
  } catch (error) {
    logger.error('Failed to fetch models, using defaults:', error);
    availableModels = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  }
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

async function handleProjectCommand(
  content: string,
  channel: 'feishu' | 'acp',
  channelId: string,
  sessionManager: SessionManager,
  agentRunner: AgentRunner,
  config: Config,
  messageCache: MessageCache,
  processor: MessageProcessor,
  messageQueue: MessageQueue,
  sendMessage?: (channelId: string, text: string) => Promise<void>
): Promise<string | null> {
  // 支持的命令列表
  const commands = ['/new', '/pwd', '/plist', '/switch', '/bind', '/help', '/status', '/restart', '/model'];
  const isCommand = commands.some(cmd => content.startsWith(cmd));
  if (!isCommand) return null;

  // /help 命令不需要会话
  if (content === '/help') {
    return `可用命令：
📁 项目管理：
  /pwd - 显示当前项目路径
  /plist - 列出所有配置的项目
  /switch <name|path> - 切换项目
  /bind <path> - 绑定新项目目录

🔄 会话管理：
  /new - 清除会话，开始新对话
  /status - 显示会话状态
  /restart - 重启服务

🤖 模型管理：
  /model - 显示当前模型
  /model <model-id> - 切换模型

❓ 帮助：
  /help - 显示此帮助信息`;
  }

  // /model 命令：查看或切换模型
  if (content.startsWith('/model')) {
    const args = content.slice(6).trim();

    if (!args) {
      // 显示当前模型
      const currentModel = agentRunner.getModel();
      const modelList = availableModels.map(m => `- ${m}`).join('\n');
      return `当前模型: ${currentModel}\n\n可用模型：\n${modelList}\n\n用法: /model <model-id>`;
    }

    // 切换模型
    if (!availableModels.includes(args)) {
      const modelList = availableModels.map(m => `- ${m}`).join('\n');
      return `❌ 无效的模型ID: ${args}\n\n可用模型：\n${modelList}`;
    }

    // 更新配置
    config.anthropic.model = args;
    saveConfig(config);

    // 更新 AgentRunner
    agentRunner.setModel(args);

    return `✓ 已切换到模型: ${args}`;
  }

  // 其他命令需要会话，如果不存在则创建
  const session = await sessionManager.getOrCreateSession(
    channel,
    channelId,
    config.projects?.defaultPath || process.cwd()
  );

  // /status 命令：显示会话状态
  if (content === '/status') {
    const lines = [
      '📊 会话状态：',
      `渠道: ${channel}`,
      `会话ID: ${session.id}`,
      `项目路径: ${session.projectPath}`,
      `活跃状态: ${session.isActive ? '✓ 活跃' : '休眠'}`,
      `Claude会话: ${session.claudeSessionId || '(未初始化)'}`,
      `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
      `更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`
    ];
    return lines.join('\n');
  }

  // /new 命令：清除会话，立即创建新会话
  if (content === '/new') {
    await sessionManager.clearClaudeSessionId(channel, channelId);
    await agentRunner.closeSession(session.id);

    // 立即创建新会话
    const newSession = await sessionManager.getOrCreateSession(
      channel,
      channelId,
      session.projectPath
    );

    return '✓ 已创建新会话';
  }

  // /restart 命令：重启服务
  if (content === '/restart') {
    // 检查是否有未读消息
    const allSessions = await sessionManager.listSessions(channel, channelId);
    const sessionsWithMessages = allSessions
      .filter(s => messageCache.hasMessages(s.id))
      .map(s => {
        const count = messageCache.getCount(s.id);
        return `${s.projectPath} 有 ${count} 条新消息`;
      });

    if (sessionsWithMessages.length > 0) {
      // 检查是否是第二次 /restart（10秒内）
      const restartKey = `${channel}-${channelId}`;
      const restartConfirmFile = `./data/restart-confirm-${restartKey}.json`;

      if (fs.existsSync(restartConfirmFile)) {
        const confirmInfo = JSON.parse(fs.readFileSync(restartConfirmFile, 'utf-8'));
        const now = Date.now();

        // 10秒内的第二次 /restart，执行重启
        if (now - confirmInfo.timestamp < 10000) {
          fs.unlinkSync(restartConfirmFile);
          // 继续执行重启逻辑
        } else {
          // 超过10秒，重新提示
          fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: now }));
          return sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。';
        }
      } else {
        // 首次 /restart，提示未读消息
        fs.writeFileSync(restartConfirmFile, JSON.stringify({ timestamp: Date.now() }));
        return sessionsWithMessages.join('\n') + '\n再次输入 /restart 将强制重启。';
      }
    }

    // 保存重启信息到文件
    const restartInfo = {
      channel,
      channelId,
      timestamp: Date.now()
    };
    fs.writeFileSync('./data/restart-pending.json', JSON.stringify(restartInfo));

    // 启动后台监控脚本
    const { spawn } = await import('child_process');
    spawn('/home/evolclaw/restart-monitor.sh', [], {
      detached: true,
      stdio: 'ignore'
    }).unref();

    // 延迟退出，让响应消息先发送
    setTimeout(() => {
      logger.info('[System] Restarting by user command...');
      process.exit(0);
    }, 1000);
    return '🔄 服务正在重启，请稍候...（约 5 秒后恢复）';
  }

  // /pwd 命令：显示当前项目路径
  if (content === '/pwd') {
    return `当前项目: ${session.projectPath}`;
  }

  // /plist 命令：列出所有项目
  if (content === '/plist') {
    const projects = config.projects?.list || {};
    const lines = ['可用项目:'];
    const sessionKey = `${channel}-${channelId}`;
    const processingProject = messageQueue.getProcessingProject(sessionKey);
    const queueLength = messageQueue.getQueueLength(sessionKey);

    // 路径规范化函数
    const normalizePath = (p: string) => p.replace(/\/+$/, '');

    for (const [name, projectPath] of Object.entries(projects)) {
      const isCurrent = session.projectPath === projectPath;
      const prefix = isCurrent ? '  ✓' : '   ';

      // 查询该项目的会话
      const projectSession = await sessionManager.getSessionByProjectPath(channel, channelId, projectPath);

      if (!projectSession) {
        lines.push(`${prefix} ${name} (${projectPath}) - 无会话`);
        continue;
      }

      const statusParts = [];

      // 活跃状态或空闲时间
      if (isCurrent) {
        statusParts.push('活跃');
      } else {
        const idleMs = Date.now() - projectSession.updatedAt;
        statusParts.push(formatIdleTime(idleMs));
      }

      // 处理状态
      if (processingProject && normalizePath(processingProject) === normalizePath(projectPath)) {
        if (queueLength > 1) {
          statusParts.push(`[处理中，队列${queueLength - 1}条]`);
        } else {
          statusParts.push('[处理中]');
        }
      }

      // 未读消息
      const unreadCount = messageCache.getCount(projectSession.id);
      if (unreadCount > 0) {
        statusParts.push(`[${unreadCount}条新消息]`);
      } else if (!processingProject || normalizePath(processingProject) !== normalizePath(projectPath)) {
        statusParts.push('[空闲]');
      }

      lines.push(`${prefix} ${name} (${projectPath}) - ${statusParts.join(' ')}`);
    }
    return lines.join('\n');
  }

  // /switch 命令：切换项目（支持名称或路径）
  if (content.startsWith('/switch ')) {
    const arg = content.slice(8).trim();

    if (!arg) return '用法: /switch <name|path>';

    // 检查当前队列，如果有排队消息则拒绝切换
    const sessionKey = `${channel}-${channelId}`;
    const queueLength = messageQueue.getQueueLength(sessionKey);
    if (queueLength > 0) {
      return `❌ 当前有 ${queueLength} 条消息正在排队，请等待处理完成后再切换项目`;
    }

    let projectPath: string;
    let projectName: string;

    // 判断是路径还是名称
    if (arg.includes('/')) {
      // 路径模式
      if (!path.isAbsolute(arg)) {
        return '❌ 项目路径必须是绝对路径';
      }
      if (!fs.existsSync(arg)) {
        return `❌ 路径不存在: ${arg}`;
      }
      projectPath = arg;
      projectName = path.basename(arg);
    } else {
      // 名称模式
      const projects = config.projects?.list || {};
      projectPath = projects[arg];
      if (!projectPath) {
        return `❌ 项目 "${arg}" 不存在\n提示: 使用 /plist 查看可用项目`;
      }
      projectName = arg;
    }

    // 检查是否切换到当前项目（规范化路径后比较）
    const normalizedSessionPath = path.resolve(session.projectPath);
    const normalizedProjectPath = path.resolve(projectPath);
    if (normalizedSessionPath === normalizedProjectPath) {
      return `当前已在项目: ${projectName}\n  路径: ${projectPath}`;
    }

    // 使用新的 switchProject 方法
    const newSession = await sessionManager.switchProject(channel, channelId, projectPath);

    // 检查缓存事件
    const cachedEvents = messageCache.getEvents(newSession.id);

    // 提示信息
    const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
    let response = `✓ 已切换到项目: ${projectName}\n  路径: ${projectPath}\n  ${hasExistingSession}`;

    // 如果有缓存事件，先发送切换消息，再发送完整缓存内容
    if (cachedEvents.length > 0 && sendMessage) {
      // 添加简短通知到切换消息
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

      // 发送切换消息
      await sendMessage(channelId, response);

      // 发送完整缓存内容（文件标记由sendMessage回调处理）
      for (const event of cachedEvents) {
        await sendMessage(channelId, event.message);
      }

      // 清空缓存
      messageCache.clearEvents(newSession.id);

      return ''; // 已经发送，返回空字符串表示命令已处理
    }

    return response;
  }

  // /bind 命令：绑定新项目目录
  if (content.startsWith('/bind ')) {
    const projectPath = content.slice(6).trim();

    if (!projectPath) return '用法: /bind <path>';

    if (!path.isAbsolute(projectPath)) {
      return '❌ 项目路径必须是绝对路径';
    }
    if (!fs.existsSync(projectPath)) {
      return `❌ 路径不存在: ${projectPath}`;
    }

    // 使用 switchProject 方法
    const newSession = await sessionManager.switchProject(channel, channelId, projectPath);

    // 检查缓存事件
    const cachedEvents = messageCache.getEvents(newSession.id);

    const hasExistingSession = newSession.claudeSessionId ? '（恢复已有会话）' : '（新建会话）';
    let response = `✓ 已绑定项目目录: ${projectPath}\n  ${hasExistingSession}`;

    // 如果有缓存事件，显示并清空
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

      messageCache.clearEvents(newSession.id);
    }

    return response;
  }

  return null;
}

async function main() {
  // 过滤飞书 SDK 的 info 日志
  const originalLog = console.log;
  const originalInfo = console.info;

  const filter = (...args: any[]) => {
    const firstArg = String(args[0] || '');
    return firstArg.includes('[info]') || firstArg.includes('[ws]');
  };

  console.log = (...args: any[]) => {
    if (filter(...args)) return;
    originalLog(...args);
  };

  console.info = (...args: any[]) => {
    if (filter(...args)) return;
    originalInfo(...args);
  };

  logger.info('EvolClaw starting...');

  // 加载配置
  const config = loadConfig();
  logger.info('✓ Config loaded (API keys hidden)');

  // 设置环境变量（如果配置了 baseUrl）
  if (config.anthropic.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
    logger.info(`✓ Using custom API base URL: ${config.anthropic.baseUrl}`);
  }

  // 获取可用模型列表
  await fetchAvailableModels(config.anthropic.apiKey, config.anthropic.baseUrl);

  // 初始化数据库
  ensureDir('./data');
  const sessionManager = new SessionManager();
  logger.info('✓ Database initialized');

  // 初始化 Agent Runner（带持久化回调）
  const agentRunner = new AgentRunner(
    config.anthropic.apiKey,
    config.anthropic.model,
    async (sessionId, claudeSessionId) => {
      // 直接根据 sessionId 更新，避免错误更新其他项目的会话
      await sessionManager.updateClaudeSessionIdBySessionId(sessionId, claudeSessionId);
    }
  );
  logger.info('✓ Agent runner ready');

  // 创建消息缓存
  const messageCache = new MessageCache();
  logger.info('✓ Message cache initialized');

  // 定期清理过期消息（每小时）
  setInterval(() => {
    messageCache.cleanupExpired();
  }, 60 * 60 * 1000);

  // 飞书渠道
  const feishu = new FeishuChannel({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    db: sessionManager.getDatabase()
  });

  // 设置项目路径提供器
  feishu.onProjectPathRequest(async (chatId) => {
    const session = await sessionManager.getOrCreateSession('feishu', chatId, config.projects?.defaultPath || process.cwd());
    return path.isAbsolute(session.projectPath)
      ? session.projectPath
      : path.resolve(process.cwd(), session.projectPath);
  });

  // ACP 渠道
  const acp = new ACPChannel({ domain: config.acp.domain, agentName: config.acp.agentName });

  // 创建消息处理器（需要先创建，因为 commandHandler 需要引用它）
  let processor: MessageProcessor;
  let messageQueue: MessageQueue;

  // 创建命令处理器
  const commandHandler: CommandHandler = (content, channel, channelId) =>
    handleProjectCommand(content, channel, channelId, sessionManager, agentRunner, config, messageCache, processor, messageQueue,
      async (id, text) => {
        // 处理文件标记（仅Feishu）
        const fileMarkerPattern = /\[SEND_FILE:([^\]]+)\]/g;
        if (channel === 'feishu') {
          const fileMatches = [...text.matchAll(fileMarkerPattern)];
          for (const match of fileMatches) {
            const filePath = match[1].trim();
            const session = await sessionManager.getActiveSession(channel, channelId);
            const projectPath = session?.projectPath || process.cwd();
            const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
            try {
              await feishu.sendFile(id, absoluteFilePath);
            } catch (error) {
              logger.error(`[Feishu] Failed to send file: ${absoluteFilePath}`, error);
            }
          }
          text = text.replace(fileMarkerPattern, '').trim();
        }

        if (text) {
          if (channel === 'feishu') await feishu.sendMessage(id, text);
          else if (channel === 'acp') await acp.sendMessage(id, text);
        }
      }
    );

  // 创建消息处理器
  processor = new MessageProcessor(
    agentRunner,
    sessionManager,
    config,
    messageCache,
    commandHandler
  );

  // 设置 compact 开始回调
  agentRunner.setCompactStartCallback((sessionId) => {
    processor.handleCompactStart();
  });

  // 创建消息队列
  messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  });

  // 设置中断回调
  messageQueue.setInterruptCallback(async (sessionKey) => {
    await agentRunner.interrupt(sessionKey);
  });

  // 注册 Feishu 适配器
  const feishuAdapter: ChannelAdapter = {
    name: 'feishu',
    sendText: (channelId, text) => feishu.sendMessage(channelId, text),
    sendFile: (channelId, filePath) => feishu.sendFile(channelId, filePath),
  };

  const feishuOptions: ChannelOptions = {
    systemPromptAppend: '[重要系统功能] 你可以通过飞书发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。示例：文件已准备好！[SEND_FILE:/path/to/file.txt] 系统会自动上传并发送。',
    fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
    supportsImages: true,
  };

  processor.registerChannel(feishuAdapter, feishuOptions);

  // 注册 ACP 适配器
  const acpAdapter: ChannelAdapter = {
    name: 'acp',
    sendText: (channelId, text) => acp.sendMessage(channelId, text),
  };

  processor.registerChannel(acpAdapter);

  // 命令列表（用于快速检查）
  const commands = ['/new', '/pwd', '/plist', '/switch', '/bind', '/help', '/status', '/restart', '/model'];
  const isCommand = (content: string) => commands.some(cmd => content.startsWith(cmd));

  // Feishu 消息处理
  feishu.onMessage(async (chatId, content, images) => {
    content = content.trim();
    // 命令立即处理，不进入队列
    if (isCommand(content)) {
      const cmdResult = await commandHandler(content, 'feishu', chatId);
      if (cmdResult !== null) {
        if (cmdResult) {
          await feishu.sendMessage(chatId, cmdResult);
        }
        return; // 命令已处理，无论是否有返回值
      }
    }

    // 获取当前项目路径
    const session = await sessionManager.getOrCreateSession('feishu', chatId, config.projects?.defaultPath || process.cwd());

    // 普通消息进入队列
    await messageQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content, images, timestamp: Date.now() },
      session.projectPath
    );
  });

  // ACP 消息处理
  acp.onMessage(async (sessionId, content) => {
    // 命令立即处理，不进入队列
    if (isCommand(content)) {
      const cmdResult = await commandHandler(content, 'acp', sessionId);
      if (cmdResult) {
        await acp.sendMessage(sessionId, cmdResult);
        return;
      }
    }

    // 获取当前项目路径
    const session = await sessionManager.getOrCreateSession('acp', sessionId, config.projects?.defaultPath || process.cwd());

    // 普通消息进入队列
    await messageQueue.enqueue(
      `acp-${sessionId}`,
      { channel: 'acp', channelId: sessionId, content, timestamp: Date.now() },
      session.projectPath
    );
  });

  // 连接渠道
  const channels: string[] = [];

  // 飞书渠道
  try {
    await feishu.connect();
    logger.info('✓ Feishu connected');
    channels.push('Feishu');
  } catch (error) {
    logger.warn('⚠ Feishu connection failed (will continue without it)');
    if (error instanceof Error) {
      logger.warn(`  Reason: ${error.message}`);
    }
  }

  // ACP 渠道
  try {
    await acp.connect();
    logger.info('✓ ACP connected');
    channels.push('ACP');
  } catch (error) {
    logger.warn('⚠ ACP connection failed (will continue without it)');
    if (error instanceof Error) {
      logger.warn(`  Reason: ${error.message}`);
    }
  }

  logger.info(`\n🚀 EvolClaw is running with ${channels.length} channel(s): ${channels.join(', ')}\n`);

  // 检查是否有待发送的重启成功消息
  const restartPendingFile = './data/restart-pending.json';
  if (fs.existsSync(restartPendingFile)) {
    try {
      const restartInfo = JSON.parse(fs.readFileSync(restartPendingFile, 'utf-8'));
      const { channel, channelId, timestamp } = restartInfo;

      // 检查时间戳，避免发送过期的消息（超过 1 分钟）
      if (Date.now() - timestamp < 60000) {
        logger.info(`[System] Sending restart success message to ${channel}:${channelId}`);

        // 延迟 2 秒发送，确保 channel 连接已建立
        setTimeout(async () => {
          try {
            if (channel === 'feishu') {
              await feishu.sendMessage(channelId, '✅ 服务重启成功！');
            } else if (channel === 'acp') {
              await acp.sendMessage(channelId, '✅ 服务重启成功！');
            }
            logger.info('[System] Restart success message sent');
          } catch (error) {
            logger.error('[System] Failed to send restart success message:', error);
          }
        }, 2000);
      }

      // 删除文件
      fs.unlinkSync(restartPendingFile);
    } catch (error) {
      logger.error('[System] Failed to process restart-pending.json:', error);
      fs.unlinkSync(restartPendingFile);
    }
  }

  // 优雅关闭
  const shutdown = async () => {
    logger.info('\n\nShutting down gracefully...');
    await feishu.disconnect();
    await acp.disconnect();
    sessionManager.close();
    logger.info('✓ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
