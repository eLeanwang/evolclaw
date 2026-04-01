import { loadConfig, ensureDataDirs, resolvePaths, resolveAnthropicConfig, isOwner } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { AgentRunner } from './core/agent-runner.js';
import { FeishuChannel } from './channels/feishu.js';
import { AUNChannel } from './channels/aun.js';
import { WechatChannel } from './channels/wechat.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageQueue } from './core/message-queue.js';
import { MessageCache } from './core/message-cache.js';
import { CommandHandler } from './core/command-handler.js';
import { ChannelRegistry, AgentRegistry } from './core/registry.js';
import { EventBus } from './core/event-bus.js';
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

  // 创建事件总线
  const eventBus = new EventBus();
  logger.info('✓ Event bus initialized');

  // 初始化数据库（带 ownerResolver）
  const sessionManager = new SessionManager(undefined, eventBus, (channel, userId) => {
    return isOwner(config, channel, userId);
  });
  logger.info('✓ Database initialized');

  // 插件注册
  const channelRegistry = new ChannelRegistry();
  channelRegistry.register('feishu', (cfg) => new FeishuChannel(cfg));
  channelRegistry.register('wechat', (cfg) => new WechatChannel(cfg));
  channelRegistry.register('aun', (cfg) => new AUNChannel(cfg));

  const agentRegistry = new AgentRegistry();
  agentRegistry.register('claude', (cfg) => new AgentRunner(cfg.apiKey, cfg.model, cfg.onSessionIdUpdate, cfg.baseUrl, cfg.config));

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
  if (anthropic.effort) {
    agentRunner.setEffort(anthropic.effort);
  }
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
    });

    // 设置项目路径提供器
    feishu.onProjectPathRequest(async (chatId) => {
      const session = await sessionManager.getOrCreateSession('feishu', chatId, config.projects?.defaultPath || process.cwd(), undefined, undefined, undefined, undefined);
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
  const cmdHandler = new CommandHandler(sessionManager, agentRunner, config, messageCache, eventBus);

  // 创建消息处理器
  const processor = new MessageProcessor(
    agentRunner,
    sessionManager,
    config,
    messageCache,
    eventBus,
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
    processor.handleCompactStart(sessionId);
  });

  // 创建消息队列
  const messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  });

  // 设置中断回调
  messageQueue.setInterruptCallback(async (sessionKey) => {
    await agentRunner.interrupt(sessionKey);
  });
  messageQueue.setEventBus(eventBus);

  // 回填 messageQueue 引用
  cmdHandler.setMessageQueue(messageQueue);

  // 注册 Feishu 适配器（如果已初始化）
  if (feishu) {
    const feishuAdapter: ChannelAdapter = {
      name: 'feishu',
      sendText: (channelId, text, options) => feishu!.sendMessage(channelId, text, options),
      sendFile: (channelId, filePath) => feishu!.sendFile(channelId, filePath),
      isGroupChat: (channelId) => feishu!.isGroupChat(channelId),
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
      const session = await sessionManager.getOrCreateSession('wechat', channelId, config.projects?.defaultPath || process.cwd(), undefined, undefined, undefined, undefined);
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
  }

  // ── 公共消息处理辅助函数 ──

  /** 首次交互自动绑定 owner */
  async function autoBindOwner(channel: string, userId: string): Promise<void> {
    const channelConfig = (config.channels as any)?.[channel];
    if (channelConfig && !channelConfig.owner) {
      const { setOwner } = await import('./config.js');
      setOwner(config, channel, userId);
      logger.info(`[Owner] Auto-bound ${channel} owner: ${userId}`);
      eventBus.publish({ type: 'channel:owner-bound', channel, userId });
    }
  }

  /** 命令快速路径：返回 true 表示已处理 */
  async function handleCommand(
    content: string, channel: string, channelId: string,
    sendReply: (text: string) => Promise<void>,
    userId?: string, threadId?: string
  ): Promise<boolean> {
    if (!cmdHandler.isCommand(content)) return false;
    const cmdResult = await cmdHandler.handle(content, channel, channelId, undefined, userId, threadId);
    if (cmdResult === null) return false;
    if (cmdResult) {
      try { await sendReply(cmdResult); } catch (error) {
        logger.error(`[${channel}] Failed to send command response:`, error);
      }
    }
    return true;
  }

  /** 统一消息处理：将 InboundMessage 转换为 Message 并入队 */
  async function wireChannel(
    channelName: string,
    onMessageCallback: (handler: (msg: import('./types.js').InboundMessage) => Promise<void>) => void,
    sendReply: (channelId: string, text: string, replyOpts?: Record<string, any>) => Promise<void>
  ): Promise<void> {
    onMessageCallback(async (msg) => {
      let content = msg.content.trim();

      // 1. owner 绑定
      if (msg.userId) await autoBindOwner(channelName, msg.userId);

      // 2. 命令快速路径（去除引用前缀后检查，兼容话题中引用上文的情况）
      const contentForCmd = content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
      if (await handleCommand(contentForCmd || content, channelName, msg.channelId,
        (text) => sendReply(msg.channelId, text, msg.replyOpts),
        msg.userId, msg.threadId
      )) return;

      // 3. session 解析（metadata 含 replyOpts）
      const metadata = msg.replyOpts ? { replyOpts: msg.replyOpts } : undefined;
      const session = await sessionManager.getOrCreateSession(
        channelName, msg.channelId,
        config.projects?.defaultPath || process.cwd(),
        msg.threadId, metadata, undefined, msg.userId
      );

      // 3.5 群聊检测：首次消息时查询并持久化
      if (session.isGroup === undefined || session.isGroup === false) {
        const adapter = processor.getAdapter(channelName);
        if (adapter?.isGroupChat) {
          try {
            const isGroup = await adapter.isGroupChat(msg.channelId);
            if (isGroup) {
              session.isGroup = true;
              sessionManager.updateSession(session.id, { isGroup: true });
            }
          } catch {}
        }
      }

      // 4. 群聊前缀
      if ((session.isGroup ?? msg.isGroup) && msg.userName) {
        content = `[${msg.userName}] ${content}`;
      }

      // 5. enqueue
      await messageQueue.enqueue(session.id, {
        channel: channelName, channelId: msg.channelId, content,
        images: msg.images, timestamp: Date.now(),
        userId: msg.userId, userName: msg.userName,
        messageId: msg.messageId, isGroup: session.isGroup ?? msg.isGroup,
        mentions: msg.mentions, threadId: msg.threadId
      }, session.projectPath);
    });
  }

  // ── 渠道消息注册 ──

  if (wechat) {
    wireChannel('wechat',
      (handler) => wechat!.onMessage(async (channelId, content, userId, images) => {
        handler({ channel: 'wechat', channelId, content, userId, images });
      }),
      (channelId, text) => wechat!.sendMessage(channelId, text)
    );
  }

  // Feishu 消息处理
  if (feishu) {
    wireChannel('feishu',
      (handler) => feishu!.onMessage(async ({ channelId: chatId, content, images, userId, userName, messageId, mentions, threadId, rootId }) => {
        handler({
          channel: 'feishu', channelId: chatId, content, images,
          userId, userName, messageId, mentions, threadId,
          replyOpts: rootId ? { rootId } : undefined,
        });
      }),
      (channelId, text, replyOpts) => feishu!.sendMessage(channelId, text, {
        forceText: true,
        replyToMessageId: replyOpts?.rootId,
        replyInThread: true,
      })
    );
  }

  // AUN 消息处理
  if (aun) {
    wireChannel('aun',
      (handler) => aun!.onMessage(async (sessionId, content) => {
        handler({ channel: 'aun', channelId: sessionId, content, userId: sessionId });
      }),
      (channelId, text) => aun!.sendMessage(channelId, text)
    );
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
      eventBus.publish({
        type: 'channel:connected',
        channel: name.toLowerCase(),
        timestamp: Date.now()
      });
    } catch (error) {
      logger.warn(`⚠ ${name} connection failed (will continue without it)`);
      eventBus.publish({ type: 'channel:disconnected', channel: name.toLowerCase(), reason: error instanceof Error ? error.message : String(error) });
      if (error instanceof Error) {
        logger.warn(`  Reason: ${error.message}`);
      }
    }
  }

  logger.info(`\n🚀 EvolClaw is running with ${channels.length} channel(s): ${channels.join(', ')}\n`);
  eventBus.publish({
    type: 'system:started',
    channels: channels.map(c => c.toLowerCase()),
    timestamp: Date.now()
  });

  // 写入 ready 信号，供 restart-monitor 检测启动成功
  const readySignalPath = resolvePaths().readySignal;
  fs.writeFileSync(readySignalPath, String(Date.now()));
  logger.info(`✓ Ready signal written: ${readySignalPath}`);

  // 优雅关闭
  const shutdown = async () => {
    logger.info('\n\nShutting down gracefully...');
    eventBus.publish({
      type: 'system:shutdown',
      timestamp: Date.now()
    });
    if (feishu) { await feishu.disconnect(); eventBus.publish({ type: 'channel:disconnected', channel: 'feishu', reason: 'shutdown' }); }
    if (aun) { await aun.disconnect(); eventBus.publish({ type: 'channel:disconnected', channel: 'aun', reason: 'shutdown' }); }
    if (wechat) { await wechat.disconnect(); eventBus.publish({ type: 'channel:disconnected', channel: 'wechat', reason: 'shutdown' }); }
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
