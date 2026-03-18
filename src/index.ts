import { loadConfig, ensureDir, ensureDataDirs, resolvePaths, resolveAnthropicConfig } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { AgentRunner } from './core/agent-runner.js';
import { FeishuChannel } from './channels/feishu.js';
import { AUNChannel } from './channels/aun.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageQueue } from './core/message-queue.js';
import { MessageCache } from './core/message-cache.js';
import { CommandHandler } from './core/command-handler.js';
import { ChannelAdapter, ChannelOptions } from './types.js';
import { logger } from './utils/logger.js';
import path from 'path';
import fs from 'fs';

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

  // 确保数据目录存在
  ensureDataDirs();

  // 加载配置
  const config = loadConfig();
  const anthropic = resolveAnthropicConfig(config);
  logger.info('✓ Config loaded (API keys hidden)');

  if (anthropic.baseUrl) {
    logger.info(`✓ Using custom API base URL: ${anthropic.baseUrl}`);
  }

  // 初始化数据库
  const sessionManager = new SessionManager();
  logger.info('✓ Database initialized');

  // 初始化 Agent Runner（带持久化回调）
  const agentRunner = new AgentRunner(
    anthropic.apiKey,
    anthropic.model,
    async (sessionId, claudeSessionId) => {
      await sessionManager.updateClaudeSessionIdBySessionId(sessionId, claudeSessionId);
    },
    anthropic.baseUrl,
    config
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

  // AUN 渠道
  const aun = new AUNChannel({ domain: config.aun.domain, agentName: config.aun.agentName });

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentRunner, config, messageCache);

  // 创建消息处理器
  const processor = new MessageProcessor(
    agentRunner,
    sessionManager,
    config,
    messageCache,
    (content, channel, channelId, userId) => {
      const sendFn = async (id: string, text: string) => {
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
          else if (channel === 'aun') await aun.sendMessage(id, text);
        }
      };
      return cmdHandler.handle(content, channel, channelId, sendFn, userId);
    }
  );

  // 回填 processor 和 messageQueue 的引用
  cmdHandler.setProcessor(processor);

  // 设置 compact 开始回调
  agentRunner.setCompactStartCallback((sessionId) => {
    processor.handleCompactStart();
  });

  // 创建消息队列
  const messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  });

  // 设置中断回调
  messageQueue.setInterruptCallback(async (sessionKey) => {
    await agentRunner.interrupt(sessionKey);
  });

  // 回填 messageQueue 引用
  cmdHandler.setMessageQueue(messageQueue);

  // 注册 Feishu 适配器
  const feishuAdapter: ChannelAdapter = {
    name: 'feishu',
    sendText: (channelId, text, options) => feishu.sendMessage(channelId, text, options),
    sendFile: (channelId, filePath) => feishu.sendFile(channelId, filePath),
    isGroupChat: (channelId) => feishu.getChatMode(channelId).then(m => m === 'group'),
  };

  const feishuOptions: ChannelOptions = {
    systemPromptAppend: '[重要系统功能] 你可以通过飞书发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。示例：文件已准备好！[SEND_FILE:/path/to/file.txt] 系统会自动上传并发送。',
    fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
    supportsImages: true,
  };

  processor.registerChannel(feishuAdapter, feishuOptions);
  cmdHandler.registerAdapter(feishuAdapter);

  // 注册 AUN 适配器
  const aunAdapter: ChannelAdapter = {
    name: 'aun',
    sendText: (channelId, text) => aun.sendMessage(channelId, text),
  };

  processor.registerChannel(aunAdapter);
  cmdHandler.registerAdapter(aunAdapter);

  // Feishu 消息处理
  feishu.onMessage(async (chatId, content, images, userId, userName, messageId) => {
    content = content.trim();

    // 首次交互自动绑定主人
    if (userId && !config.owners?.feishu) {
      const { setOwner } = await import('./config.js');
      setOwner(config, 'feishu', userId);
      logger.info(`[Owner] Auto-bound owner: ${userName} (${userId})`);
    }

    // 命令立即处理，不进入队列
    if (cmdHandler.isCommand(content)) {
      const cmdResult = await cmdHandler.handle(content, 'feishu', chatId, undefined, userId);
      if (cmdResult !== null) {
        if (cmdResult) {
          try {
            await feishu.sendMessage(chatId, cmdResult, { forceText: true });
          } catch (error) {
            logger.error('[Feishu] Failed to send command response:', error);
          }
        }
        return;
      }
    }

    // 获取当前项目路径
    const session = await sessionManager.getOrCreateSession('feishu', chatId, config.projects?.defaultPath || process.cwd());

    // 群聊消息添加用户名前缀
    const chatMode = await feishu.getChatMode(chatId);
    if (chatMode === 'group' && userName) {
      content = `[${userName}] ${content}`;
    }

    // 普通消息进入队列
    await messageQueue.enqueue(
      `feishu-${chatId}`,
      { channel: 'feishu', channelId: chatId, content, images, timestamp: Date.now(), userId, userName, messageId, isGroup: chatMode === 'group' },
      session.projectPath
    );
  });

  // AUN 消息处理
  aun.onMessage(async (sessionId, content) => {
    content = content.trim();

    // 首次交互自动绑定主人
    if (!config.owners?.aun) {
      const { setOwner } = await import('./config.js');
      setOwner(config, 'aun', sessionId);
      logger.info(`[Owner] Auto-bound AUN owner: ${sessionId}`);
    }

    // 命令立即处理，不进入队列
    if (cmdHandler.isCommand(content)) {
      const cmdResult = await cmdHandler.handle(content, 'aun', sessionId, undefined, sessionId);
      if (cmdResult) {
        await aun.sendMessage(sessionId, cmdResult);
        return;
      }
    }

    // 获取当前项目路径
    const session = await sessionManager.getOrCreateSession('aun', sessionId, config.projects?.defaultPath || process.cwd());

    // 普通消息进入队列
    await messageQueue.enqueue(
      `aun-${sessionId}`,
      { channel: 'aun', channelId: sessionId, content, timestamp: Date.now(), userId: sessionId },
      session.projectPath
    );
  });

  // 连接渠道
  const channels: string[] = [];

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

  try {
    await aun.connect();
    logger.info('✓ AUN connected');
    channels.push('AUN');
  } catch (error) {
    logger.warn('⚠ AUN connection failed (will continue without it)');
    if (error instanceof Error) {
      logger.warn(`  Reason: ${error.message}`);
    }
  }

  logger.info(`\n🚀 EvolClaw is running with ${channels.length} channel(s): ${channels.join(', ')}\n`);

  // 检查是否有待发送的重启成功消息
  const restartPendingFile = path.join(resolvePaths().dataDir, 'restart-pending.json');
  if (fs.existsSync(restartPendingFile)) {
    try {
      const restartInfo = JSON.parse(fs.readFileSync(restartPendingFile, 'utf-8'));
      const { channel, channelId, timestamp } = restartInfo;

      if (Date.now() - timestamp < 60000) {
        logger.info(`[System] Sending restart success message to ${channel}:${channelId}`);

        setTimeout(async () => {
          try {
            if (channel === 'feishu') {
              await feishu.sendMessage(channelId, '✅ 服务重启成功！');
            } else if (channel === 'aun') {
              await aun.sendMessage(channelId, '✅ 服务重启成功！');
            }
            logger.info('[System] Restart success message sent');
          } catch (error) {
            logger.error('[System] Failed to send restart success message:', error);
          }
        }, 2000);
      }

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
    await aun.disconnect();
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
