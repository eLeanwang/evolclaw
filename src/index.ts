import { loadConfig, ensureDataDirs, resolvePaths, resolveAnthropicConfig } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { AgentRunner } from './core/agent-runner.js';
import { FeishuChannel } from './channels/feishu.js';
import { AUNChannel } from './channels/aun.js';
import { WechatChannel } from './channels/wechat.js';
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
    async (sessionId, agentSessionId) => {
      await sessionManager.updateAgentSessionIdBySessionId(sessionId, agentSessionId);
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

  // 飞书渠道（条件初始化）
  let feishu: FeishuChannel | null = null;

  if (config.channels?.feishu?.enabled !== false && config.channels?.feishu?.appId) {
    feishu = new FeishuChannel({
      appId: config.channels.feishu.appId,
      appSecret: config.channels.feishu.appSecret,
      db: sessionManager.getDatabase()
    });

    // 设置项目路径提供器
    feishu.onProjectPathRequest(async (chatId) => {
      const session = await sessionManager.getOrCreateSession('feishu', chatId, config.projects?.defaultPath || process.cwd());
      return path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);
    });
  }

  // AUN 渠道（条件初始化）
  let aun: AUNChannel | null = null;

  if (config.channels?.aun?.enabled !== false && config.channels?.aun?.domain) {
    aun = new AUNChannel({ domain: config.channels.aun.domain, agentName: config.channels.aun.agentName });
  }

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentRunner, config, messageCache);

  // 创建消息处理器
  const processor = new MessageProcessor(
    agentRunner,
    sessionManager,
    config,
    messageCache,
    (content, channel, channelId, userId, threadId) => {
      const sendFn = async (id: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => {
        const adapter = cmdHandler.getAdapter(channel);
        if (!adapter) return;

        // 文件标记处理（通过 adapter.sendFile 能力判断，不按渠道名分支）
        if (adapter.sendFile) {
          const fileMarkerPattern = /\[SEND_FILE:([^\]]+)\]/g;
          const fileMatches = [...text.matchAll(fileMarkerPattern)];
          for (const match of fileMatches) {
            const filePath = match[1].trim();
            // 跳过占位符/代码片段中的伪路径
            if (!filePath || /[\\[\]{}*+?|^$]/.test(filePath)) continue;
            const session = await sessionManager.getActiveSession(channel, channelId);
            const projectPath = session?.projectPath || process.cwd();
            const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
            try {
              await adapter.sendFile(id, absoluteFilePath);
            } catch (error) {
              logger.error(`[${channel}] Failed to send file: ${absoluteFilePath}`, error);
            }
          }
          text = text.replace(fileMarkerPattern, '').trim();
        }

        if (text) {
          await adapter.sendText(id, text, opts);
        }
      };
      return cmdHandler.handle(content, channel, channelId, sendFn, userId, threadId);
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

  // 注册 Feishu 适配器（如果已初始化）
  if (feishu) {
    const feishuAdapter: ChannelAdapter = {
      name: 'feishu',
      sendText: (channelId, text, options) => feishu!.sendMessage(channelId, text, options),
      sendFile: (channelId, filePath) => feishu!.sendFile(channelId, filePath),
      isGroupChat: (channelId) => feishu!.getChatMode(channelId).then(m => m === 'group'),
    };

    const feishuOptions: ChannelOptions = {
      systemPromptAppend: '[重要系统功能] 你可以通过飞书发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。示例：文件已准备好！[SEND_FILE:./report.txt] 路径支持相对路径（相对项目目录）或绝对路径。系统会自动上传并发送。',
      fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
      supportsImages: true,
    };

    processor.registerChannel(feishuAdapter, feishuOptions);
    cmdHandler.registerAdapter(feishuAdapter);
  }

  // 注册 AUN 适配器（如果已初始化）
  if (aun) {
    const aunAdapter: ChannelAdapter = {
      name: 'aun',
      sendText: (channelId, text) => aun!.sendMessage(channelId, text),
    };

    processor.registerChannel(aunAdapter);
    cmdHandler.registerAdapter(aunAdapter);
  }

  // ── WeChat 渠道（条件初始化）──
  let wechat: WechatChannel | null = null;

  if (config.channels?.wechat?.enabled && config.channels?.wechat?.token) {
    wechat = new WechatChannel({
      baseUrl: config.channels.wechat.baseUrl || 'https://ilinkai.weixin.qq.com',
      token: config.channels.wechat.token,
    });

    // 设置项目路径提供器（用于接收文件保存）
    wechat.onProjectPathRequest(async (channelId) => {
      const session = await sessionManager.getOrCreateSession('wechat', channelId, config.projects?.defaultPath || process.cwd());
      return path.isAbsolute(session.projectPath)
        ? session.projectPath
        : path.resolve(process.cwd(), session.projectPath);
    });

    const wechatAdapter: ChannelAdapter = {
      name: 'wechat',
      sendText: (channelId, text) => wechat!.sendMessage(channelId, text),
      sendFile: (channelId, filePath) => wechat!.sendFile(channelId, filePath),
    };

    const wechatOptions: ChannelOptions = {
      systemPromptAppend: '[系统功能] 你可以发送文件给用户。方法：在响应中使用 [SEND_FILE:文件路径] 标记。示例：文件已准备好！[SEND_FILE:./report.txt]',
      fileMarkerPattern: /\[SEND_FILE:([^\]]+)\]/g,
    };

    processor.registerChannel(wechatAdapter, wechatOptions);
    cmdHandler.registerAdapter(wechatAdapter);

    // Session 过期通知（通过 Feishu 等其他渠道告知用户）
    wechat.onSessionExpiredNotify(async (message) => {
      // 尝试通过已注册的 Feishu owner 通知
      const feishuOwner = config.channels?.feishu?.owner;
      if (feishuOwner) {
        try {
          // Feishu owner ID 是 open_id，但 sendMessage 需要 chat_id
          // 这里只记日志，因为 owner 的 chat_id 需要从 session 中获取
          logger.warn(`[WeChat] ${message}`);
        } catch {}
      } else {
        logger.warn(`[WeChat] ${message}`);
      }
    });

    wechat.onMessage(async (channelId, content, userId, images) => {
      content = content.trim();

      // 首次交互自动绑定主人
      if (userId && !config.channels?.wechat?.owner) {
        const { setOwner } = await import('./config.js');
        setOwner(config, 'wechat', userId);
        logger.info(`[Owner] Auto-bound WeChat owner: ${userId}`);
      }

      // 命令快速路径
      if (cmdHandler.isCommand(content)) {
        const cmdResult = await cmdHandler.handle(content, 'wechat', channelId, undefined, userId);
        if (cmdResult !== null) {
          if (cmdResult) {
            try {
              await wechat!.sendMessage(channelId, cmdResult);
            } catch (error) {
              logger.error('[WeChat] Failed to send command response:', error);
            }
          }
          return;
        }
      }

      // 获取当前项目路径
      const session = await sessionManager.getOrCreateSession('wechat', channelId, config.projects?.defaultPath || process.cwd());

      // 普通消息进入队列
      await messageQueue.enqueue(
        `wechat-${channelId}`,
        { channel: 'wechat', channelId, content, images, timestamp: Date.now(), userId },
        session.projectPath
      );
    });
  }

  // Feishu 消息处理
  if (feishu) {
    feishu.onMessage(async ({ channelId: chatId, content: rawContent, images, userId, userName, messageId, mentions, threadId, rootId }) => {
      let content = rawContent.trim();

      // 首次交互自动绑定主人
      if (userId && !config.channels?.feishu?.owner) {
        const { setOwner } = await import('./config.js');
        setOwner(config, 'feishu', userId);
        logger.info(`[Owner] Auto-bound owner: ${userName} (${userId})`);
      }

      // 命令立即处理，不进入队列
      if (cmdHandler.isCommand(content)) {
        const cmdResult = await cmdHandler.handle(content, 'feishu', chatId, undefined, userId, threadId);
        if (cmdResult !== null) {
          if (cmdResult) {
            try {
              await feishu!.sendMessage(chatId, cmdResult, { forceText: true, replyToMessageId: rootId, replyInThread: true });
            } catch (error) {
              logger.error('[Feishu] Failed to send command response:', error);
            }
          }
          return;
        }
      }

      // 获取当前项目路径（话题会话自动创建，携带 metadata）
      const metadata = rootId ? { feishu: { rootId } } : undefined;
      const session = await sessionManager.getOrCreateSession(
        'feishu', chatId, config.projects?.defaultPath || process.cwd(),
        threadId, metadata
      );

      // 群聊消息添加用户名前缀
      const chatMode = await feishu!.getChatMode(chatId);
      if (chatMode === 'group' && userName) {
        content = `[${userName}] ${content}`;
      }

      // 普通消息进入队列（使用 session.id 作为 key，话题间可并行）
      await messageQueue.enqueue(
        session.id,
        { channel: 'feishu', channelId: chatId, content, images, timestamp: Date.now(), userId, userName, messageId, isGroup: chatMode === 'group', mentions, threadId },
        session.projectPath
      );
    });
  }

  // AUN 消息处理
  if (aun) {
    aun.onMessage(async (sessionId, content) => {
      content = content.trim();

      // 首次交互自动绑定主人
      if (!config.channels?.aun?.owner) {
        const { setOwner } = await import('./config.js');
        setOwner(config, 'aun', sessionId);
        logger.info(`[Owner] Auto-bound AUN owner: ${sessionId}`);
      }

      // 命令立即处理，不进入队列
      if (cmdHandler.isCommand(content)) {
        const cmdResult = await cmdHandler.handle(content, 'aun', sessionId, undefined, sessionId);
        if (cmdResult) {
          await aun!.sendMessage(sessionId, cmdResult);
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
  }

  // 连接渠道
  const channels: string[] = [];

  const channelInstances: { name: string; instance: { connect(): Promise<void>; disconnect(): Promise<void> }; timeout?: number }[] = [
    ...(feishu ? [{ name: 'Feishu', instance: feishu, timeout: 5000 }] : []),
    ...(aun ? [{ name: 'AUN', instance: aun }] : []),
    ...(wechat ? [{ name: 'WeChat', instance: wechat }] : []),
  ];

  for (const { name, instance, timeout } of channelInstances) {
    try {
      if (timeout) {
        await Promise.race([
          instance.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), timeout))
        ]);
      } else {
        await instance.connect();
      }
      logger.info(`✓ ${name} connected`);
      channels.push(name);
    } catch (error) {
      logger.warn(`⚠ ${name} connection failed (will continue without it)`);
      if (error instanceof Error) {
        logger.warn(`  Reason: ${error.message}`);
      }
    }
  }

  logger.info(`\n🚀 EvolClaw is running with ${channels.length} channel(s): ${channels.join(', ')}\n`);

  // 写入 ready 信号，供 restart-monitor 检测启动成功
  const readySignalPath = resolvePaths().readySignal;
  fs.writeFileSync(readySignalPath, String(Date.now()));
  logger.info(`✓ Ready signal written: ${readySignalPath}`);

  // 优雅关闭
  const shutdown = async () => {
    logger.info('\n\nShutting down gracefully...');
    if (feishu) await feishu.disconnect();
    if (aun) await aun.disconnect();
    if (wechat) await wechat.disconnect();
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
