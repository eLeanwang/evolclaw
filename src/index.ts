import { ClaudeSessionFileAdapter } from './core/adapters/claude-session-file-adapter.js';
import { CodexSessionFileAdapter } from './core/adapters/codex-session-file-adapter.js';
import { loadConfig, ensureDataDirs, resolvePaths, resolveAnthropicConfig, isOwner, validateConfigIntegrity } from './config.js';
import { SessionManager } from './core/session-manager.js';
import { ClaudeAgentPlugin } from './agents/claude-runner.js';
import { CodexAgentPlugin } from './agents/codex-runner.js';
import { FeishuChannelPlugin } from './channels/feishu.js';
import { WechatChannelPlugin } from './channels/wechat.js';
import { AUNChannelPlugin } from './channels/aun.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageQueue } from './core/message-queue.js';
import { MessageBridge } from './core/message-bridge.js';
import { MessageCache } from './utils/message-cache.js';
import { CommandHandler } from './core/command-handler.js';
import { EventBus } from './core/event-bus.js';
import { StatsCollector } from './core/stats-collector.js';
import { PermissionGateway } from './core/permission.js';
import { ChannelLoader } from './core/channel-loader.js';
import { AgentLoader } from './core/agent-loader.js';
import { ChannelAdapter, Message } from './types.js';
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

  // 配置完整性校验
  const integrity = validateConfigIntegrity(config);
  if (!integrity.valid) {
    logger.error(`❌ Config integrity check failed:\n  ${integrity.reasons.join('\n  ')}`);
    process.exit(1);
  }

  const anthropic = resolveAnthropicConfig(config);
  logger.info('✓ Config loaded (API keys hidden)');

  if (anthropic.baseUrl) {
    logger.info(`✓ Using custom API base URL: ${anthropic.baseUrl}`);
  }

  // 创建事件总线
  const eventBus = new EventBus();
  logger.info('✓ Event bus initialized');

  // 统计收集器（近 1 小时滚动统计）
  const statsCollector = new StatsCollector(eventBus);

  // 初始化数据库（带 ownerResolver）
  const sessionManager = new SessionManager(undefined, eventBus, (channel, userId) => {
    return isOwner(config, channel, userId);
  });
  logger.info('✓ Database initialized');

  // 注册会话文件适配器（Claude / Codex 各自的会话文件操作）
  sessionManager.registerFileAdapter(new ClaudeSessionFileAdapter());
  sessionManager.registerFileAdapter(new CodexSessionFileAdapter());

  // Agent 插件系统
  const agentLoader = new AgentLoader();
  agentLoader.register(new ClaudeAgentPlugin());
  agentLoader.register(new CodexAgentPlugin());

  const agentInstances = agentLoader.createAll(config, {
    onSessionIdUpdate: async (sessionId: string, agentSessionId: string) => {
      await sessionManager.updateAgentSessionIdBySessionId(sessionId, agentSessionId);
    },
  });

  // 构建 agent map，支持按 agentId 路由（当前默认使用第一个 agent）
  const agentMap = new Map<string, any>();
  for (const inst of agentInstances) {
    agentMap.set(inst.agent.name, inst.agent);
  }
  const defaultAgent = config.agents?.defaultAgent || 'claude';
  const agentRunner = agentMap.get(defaultAgent) || agentInstances[0]?.agent;
  if (!agentRunner) {
    throw new Error('No agent backend available. Check agents config.');
  }
  logger.info(`✓ Agent runner ready (default: ${agentRunner.name}, available: ${[...agentMap.keys()].join(', ')})`);

  // 权限审批网关
  const permissionGateway = new PermissionGateway();
  permissionGateway.setEventBus(eventBus);
  // 为所有支持权限的 agent 设置 gateway
  for (const inst of agentInstances) {
    inst.agent.setPermissionGateway?.(permissionGateway);
  }

  // 创建消息缓存
  const messageCache = new MessageCache();
  logger.info('✓ Message cache initialized');

  // 定期清理过期消息（每小时）
  setInterval(() => {
    messageCache.cleanupExpired();
  }, 60 * 60 * 1000);

  // 渠道插件系统
  const channelLoader = new ChannelLoader();
  channelLoader.register(new FeishuChannelPlugin());
  channelLoader.register(new WechatChannelPlugin());
  channelLoader.register(new AUNChannelPlugin());

  const channelInstances = await channelLoader.createAll(config);
  logger.info(`✓ Created ${channelInstances.length} channel instance(s)`);

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentMap, config, messageCache, eventBus, defaultAgent);
  cmdHandler.setPermissionGateway(permissionGateway);
  cmdHandler.setStatsCollector(statsCollector);

  // 创建消息处理器
  const processor = new MessageProcessor(
    agentMap,
    sessionManager,
    config,
    messageCache,
    eventBus,
    (content, channel, channelId, userId, threadId) => {
      const sendFn = async (id: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => {
        const adapter = cmdHandler.getAdapter(channel);
        if (!adapter) return;

        if (text) {
          await adapter.sendText(id, text, opts);
        }
      };
      return cmdHandler.handle(content, channel, channelId, sendFn, userId, threadId);
    },
    defaultAgent
  );

  // 回填 processor 和 messageQueue 的引用
  cmdHandler.setProcessor(processor);

  // 设置 compact 开始回调（对所有支持的 agent）
  for (const inst of agentInstances) {
    inst.agent.setCompactStartCallback?.((sessionId: string) => {
      processor.handleCompactStart(sessionId);
    });
  }

  // 创建消息队列
  const messageQueue = new MessageQueue(async (message) => {
    await processor.processMessage(message);
  });

  // 设置中断回调（精确中断正在处理的 agent）
  messageQueue.setInterruptCallback(async (sessionKey, agentId) => {
    const agent = agentMap.get(agentId || defaultAgent);
    if (agent?.hasActiveStream(sessionKey)) {
      await agent.interrupt(sessionKey);
    }
  });
  messageQueue.setEventBus(eventBus);

  // 回填 messageQueue 引用
  cmdHandler.setMessageQueue(messageQueue);

  // 默认策略
  const defaultPolicy = {
    canSwitchProject: (chatType: string, role: string) => chatType === 'private' || role === 'owner',
    canListProjects: (chatType: string, role: string) => chatType === 'private' || role === 'owner',
    canCreateSession: () => true,
    canDeleteSession: (chatType: string, role: string) => chatType === 'private' || role === 'owner',
    canImportCliSession: (chatType: string, role: string) => chatType === 'private' || role === 'owner',
    messagePrefix: () => '',
    showMiddleResult: () => true,
    showIdleMonitor: () => true,
    accumulateErrors: () => true,
  };

  // 注册渠道插件的 adapter 和 policy
  for (const inst of channelInstances) {
    // 设置项目路径提供器（如果需要）
    if (inst.onProjectPathRequest && inst.channel.onProjectPathRequest) {
      inst.channel.onProjectPathRequest(async (channelId: string) => {
        const session = await sessionManager.getOrCreateSession(
          inst.adapter.name, channelId,
          config.projects?.defaultPath || process.cwd(),
          undefined, undefined, undefined, undefined
        );
        return path.isAbsolute(session.projectPath)
          ? session.projectPath
          : path.resolve(process.cwd(), session.projectPath);
      });
    }

    // 注册 adapter、policy 和 options
    processor.registerChannel(inst.adapter, inst.policy || defaultPolicy, inst.options);
    cmdHandler.registerAdapter(inst.adapter);
    cmdHandler.registerChannel(inst.adapter.name, inst.channel);
    if (inst.policy) {
      cmdHandler.registerPolicy(inst.adapter.name, inst.policy);
    }
  }

  // ── MessageBridge：Channel ↔ Core 消息桥梁 ──

  const msgBridge = new MessageBridge(config, sessionManager, processor, messageQueue, cmdHandler, eventBus);

  // ── 渠道消息注册 ──

  // 连接插件系统的渠道
  for (const inst of channelInstances) {
    if (inst.adapter.name === 'feishu') {
      msgBridge.register('feishu',
        (handler) => inst.channel.onMessage(async ({ channelId: chatId, content, images, peerId, peerName, messageId, mentions, threadId, rootId, chatType }: any) => {
          handler({
            channel: 'feishu', channelId: chatId, content, images, chatType,
            peerId: peerId || '', peerName, messageId, mentions, threadId,
            replyContext: rootId ? { replyToMessageId: rootId, replyInThread: true } : undefined,
          });
        }),
        (channelId, text, replyContext) => inst.channel.sendMessage(channelId, text, {
          replyToMessageId: replyContext?.replyToMessageId,
          replyInThread: true,
        }),
        inst.adapter
      );
      inst.channel.onRecall?.((messageId: string) => {
        msgBridge.cancel(messageId);
      });
    }

    if (inst.adapter.name === 'wechat') {
      msgBridge.register('wechat',
        (handler) => inst.channel.onMessage(async (channelId: string, content: string, peerId?: string,
          images?: Array<{ data: string; mimeType: string }>, chatType?: 'private' | 'group') => {
          handler({
            channel: 'wechat',
            channelId,
            content,
            images,
            chatType: chatType || 'private',
            peerId: peerId || '',
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter
      );
    }

    if (inst.adapter.name === 'aun') {
      msgBridge.register('aun',
        (handler) => inst.channel.onMessage(async (opts: any) => {
          handler({
            channel: 'aun',
            channelId: opts.channelId,
            content: opts.content,
            chatType: opts.chatType || 'private',
            peerId: opts.peerId || '',
            messageId: opts.messageId,
            mentions: opts.mentions,
            threadId: opts.threadId,
            replyContext: opts.replyContext,
          });
        }),
        (channelId, text, replyContext) => inst.channel.sendMessage(channelId, text, replyContext),
        inst.adapter
      );
    }
  }

  // ── 连接所有渠道 ──
  const connected = await channelLoader.connectAll(channelInstances);

  // 预填充 Feishu 已知 thread_id（重启后避免误判话题创建）
  for (const inst of channelInstances) {
    if (inst.adapter.name === 'feishu' && 'preloadThreads' in inst.channel) {
      const threadIds = sessionManager.getKnownThreadIds('feishu');
      (inst.channel as any).preloadThreads(threadIds);
    }
  }

  for (const name of connected) {
    eventBus.publish({
      type: 'channel:connected',
      channel: name.toLowerCase(),
      timestamp: Date.now()
    });
  }

  // AUN 重连失败通知：通过其他渠道给 owner 发消息
  for (const inst of channelInstances) {
    if (inst.adapter.name === 'aun' && inst.channel.setOnChannelDown) {
      inst.channel.setOnChannelDown(() => {
        logger.error('[AUN] All reconnect attempts exhausted, notifying owners');
        const msg = '⚠️ AUN 渠道断连，自动重试已用尽。\n使用 /check reconnect 手动重连';
        for (const other of channelInstances) {
          if (other.adapter.name === inst.adapter.name) continue;
          const ownerCfg = config.channels?.[other.adapter.name as keyof typeof config.channels];
          const ownerId = (ownerCfg as any)?.owner;
          if (ownerId) {
            other.adapter.sendText(ownerId, msg).catch(err => {
              logger.error(`[AUN] Failed to notify ${other.adapter.name} owner:`, err);
            });
          }
        }
      });
    }
  }

  logger.info(`\n🚀 EvolClaw is running with ${connected.length} channel(s): ${connected.join(', ')}\n`);
  eventBus.publish({
    type: 'system:started',
    channels: connected.map(c => c.toLowerCase()),
    timestamp: Date.now()
  });

  // 恢复重启前未完成的会话
  const pendingSessions = sessionManager.getPendingProcessingSessions();
  if (pendingSessions.length > 0) {
    logger.info(`[Resume] Found ${pendingSessions.length} pending session(s) from before restart`);
    for (const session of pendingSessions) {
      if (!session.agentSessionId) {
        sessionManager.clearProcessing(session.id);
        continue;
      }
      const agent = agentMap.get(session.agentId) || agentMap.get(defaultAgent);
      if (!agent) {
        sessionManager.clearProcessing(session.id);
        continue;
      }
      logger.info(`[Resume] Resuming session: ${session.id} (agent: ${session.agentId})`);
      const resumeMessage: Message = {
        channel: session.channel,
        channelId: session.channelId,
        content: '服务已重启，请继续之前未完成的任务。',
        timestamp: Date.now(),
        peerId: '',
        threadId: session.threadId || undefined,
        replyContext: (session.metadata as any)?.replyContext,
      };
      // 清除状态后入队（processMessage 会重新标记）
      sessionManager.clearProcessing(session.id);
      messageQueue.enqueue(session.id, resumeMessage, session.projectPath).catch(err => {
        logger.error(`[Resume] Failed to resume session ${session.id}:`, err);
      });
    }
  }

  // 重启通知：通过渠道 adapter 发送（channel-agnostic）
  const pendingFile = path.join(resolvePaths().dataDir, 'restart-pending.json');
  if (fs.existsSync(pendingFile)) {
    try {
      const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      const adapter = cmdHandler.getAdapter(pending.channel);
      if (adapter) {
        const replyContext = pending.rootId
          ? { replyToMessageId: pending.rootId, replyInThread: true }
          : undefined;
        await adapter.sendText(pending.channelId, '✅ 服务重启成功！', replyContext);
        logger.info(`[Restart] Notification sent via ${pending.channel}`);
      }
      fs.unlinkSync(pendingFile);
    } catch (e) {
      logger.error('[Restart] Failed to send restart notification:', e);
    }
  }

  // 写入 ready 信号，供 restart-monitor 检测启动成功
  const readySignalPath = resolvePaths().readySignal;
  fs.writeFileSync(readySignalPath, String(Date.now()));
  logger.info(`✓ Ready signal written: ${readySignalPath}`);

  // 运行时配置文件监控
  const configPath = resolvePaths().config;
  fs.watchFile(configPath, { interval: 5000 }, (_curr, _prev) => {
    let newConfig;
    try {
      newConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // JSON 解析失败 → 视为坏文件，备份内存中的好副本
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = path.join(resolvePaths().dataDir, `evolclaw-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(config, null, 2));
      logger.warn(`[Config Watch] Config file is not valid JSON. In-memory snapshot saved to ${backupPath}`);
      eventBus.publish({ type: 'config:corrupted', backupPath, reasons: ['Invalid JSON'] });
      return;
    }
    const result = validateConfigIntegrity(newConfig);
    if (!result.valid) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = path.join(resolvePaths().dataDir, `evolclaw-${ts}.json`);
      fs.writeFileSync(backupPath, JSON.stringify(config, null, 2));
      logger.warn(`[Config Watch] Bad config write detected. Reasons: ${result.reasons.join('; ')}. In-memory snapshot saved to ${backupPath}`);
      eventBus.publish({ type: 'config:corrupted', backupPath, reasons: result.reasons });
    } else {
      logger.debug(`[Config Watch] Config file modified, passes integrity check`);
    }
  });

  // 优雅关闭
  const shutdown = async () => {
    logger.info('\n\nShutting down gracefully...');
    fs.unwatchFile(configPath);
    eventBus.publish({
      type: 'system:shutdown',
      timestamp: Date.now()
    });

    // 断开插件系统的渠道
    await channelLoader.disconnectAll(channelInstances);
    for (const inst of channelInstances) {
      eventBus.publish({ type: 'channel:disconnected', channel: inst.adapter.name, reason: 'shutdown' });
    }

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
