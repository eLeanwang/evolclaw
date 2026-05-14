import { ClaudeSessionFileAdapter } from './core/session/adapters/claude-session-file-adapter.js';
import { CodexSessionFileAdapter } from './core/session/adapters/codex-session-file-adapter.js';
import { GeminiSessionFileAdapter } from './core/session/adapters/gemini-session-file-adapter.js';
import { loadConfig, ensureDataDirs, resolvePaths, resolveAnthropicConfig, isOwner, isAdmin, validateConfigIntegrity, validateChannelInstanceNames, getOwner, getDefaultSessionMode } from './config.js';
import { SessionManager } from './core/session/session-manager.js';
import { ClaudeAgentPlugin } from './agents/claude-runner.js';
import { CodexAgentPlugin } from './agents/codex-runner.js';
import { GeminiAgentPlugin } from './agents/gemini-runner.js';
import { FeishuChannelPlugin } from './channels/feishu.js';
import { WechatChannelPlugin } from './channels/wechat.js';
import { AUNChannelPlugin } from './channels/aun.js';
import { DingtalkChannelPlugin } from './channels/dingtalk.js';
import { QQBotChannelPlugin } from './channels/qqbot.js';
import { WecomChannelPlugin } from './channels/wecom.js';
import { MessageProcessor } from './core/message/message-processor.js';
import { MessageQueue } from './core/message/message-queue.js';
import { MessageBridge } from './core/message/message-bridge.js';
import { MessageCache } from './core/message/message-cache.js';
import { CommandHandler } from './core/command-handler.js';
import { EventBus } from './core/event-bus.js';
import { StatsCollector } from './utils/stats-collector.js';
import { PermissionGateway } from './core/permission.js';
import { InteractionRouter } from './core/interaction-router.js';
import { ChannelLoader, type ChannelInstance } from './core/channel-loader.js';
import { AgentLoader } from './core/agent-loader.js';
import { AgentRegistry, type ReloadHooks } from './core/agent-registry.js';
import { buildReloadHooks } from './core/reload-hooks.js';
import { IpcServer, IpcStatusResponse, ChannelStatus } from './ipc.js';
import { ChannelAdapter, Message } from './types.js';
import { logger, setLogLevel } from './utils/logger.js';
import { detectDuplicates } from './utils/channel-fingerprint.js';
import { loadPromptTemplates } from './prompts/templates.js';
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

  // 加载提示词模板
  loadPromptTemplates();

  // 加载配置
  const config = loadConfig();

  // 应用配置中的日志级别（优先于环境变量）
  if (config.debug?.logLevel) {
    setLogLevel(config.debug.logLevel);
  }

  const paths = resolvePaths();

  // 配置完整性校验
  const integrity = validateConfigIntegrity(config);
  if (!integrity.valid) {
    const msg = `❌ Config integrity check failed:\n  ${integrity.reasons.join('\n  ')}`;
    logger.error(msg);
    console.error(msg);  // ensure it lands in stdout.log for self-heal diagnostics
    process.exit(1);
  }

  const anthropic = resolveAnthropicConfig(config);
  logger.info('✓ Config loaded (API keys hidden)');

  // Channel instance name uniqueness check
  validateChannelInstanceNames(config);

  // Detect duplicate channel credentials
  const duplicates = detectDuplicates(config);
  if (duplicates.length > 0) {
    for (const d of duplicates) {
      logger.warn(
        `⚠ Duplicate channel credential: ${d.fingerprint} is used by instances [${d.instances.join(', ')}]. ` +
        `Only the first instance will be active.`
      );
    }
  }

  if (anthropic.baseUrl) {
    logger.info(`✓ Using custom API base URL: ${anthropic.baseUrl}`);
  }

  // EvolAgent Registry
  const agentRegistry = new AgentRegistry(paths.agentsDir);
  agentRegistry.loadAll(config);
  const agentInfos = agentRegistry.list();
  const evolagentCount = agentInfos.filter(i => !i.isDefault).length;
  if (evolagentCount > 0) {
    logger.info(`✓ Loaded ${evolagentCount} evolagent(s)`);
    for (const info of agentInfos) {
      if (info.isDefault) continue;
      if (info.status === 'error') {
        logger.error(`  ✗ [${info.name}] ${info.error}`);
      } else if (info.status === 'disabled') {
        logger.info(`  ○ [${info.name}] disabled`);
      } else {
        logger.info(`  ● [${info.name}] ${info.baseagent} @ ${path.basename(info.projectPath)}`);
      }
    }
  }

  // Store for IPC access (T10 will wire this)
  // M4: removed dead globalThis.__evolclaw_agentRegistry assignment

  // 创建事件总线
  const eventBus = new EventBus();
  logger.info('✓ Event bus initialized');

  // 统计收集器（近 1 小时滚动统计）
  const statsCollector = new StatsCollector(eventBus);

  // 初始化数据库（带 ownerResolver）
  const sessionManager = new SessionManager(undefined, eventBus,
    (channel, userId) => isOwner(config, channel, userId),
    (channel, userId) => isAdmin(config, channel, userId)
  );

  // sessionMode 解析：全局 chatmode 配置 > 默认 'interactive'
  sessionManager.setSessionModeResolver((_channel, chatType) => {
    return getDefaultSessionMode(config, chatType);
  });
  logger.info('✓ Database initialized');

  // 注册会话文件适配器（Claude / Codex 各自的会话文件操作）
  sessionManager.registerFileAdapter(new ClaudeSessionFileAdapter());
  sessionManager.registerFileAdapter(new CodexSessionFileAdapter());
  sessionManager.registerFileAdapter(new GeminiSessionFileAdapter());

  // Agent 插件系统
  const agentLoader = new AgentLoader();
  agentLoader.register(new ClaudeAgentPlugin());
  agentLoader.register(new CodexAgentPlugin());
  agentLoader.register(new GeminiAgentPlugin());

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

  // 交互路由器
  const interactionRouter = new InteractionRouter();

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
  channelLoader.register(new DingtalkChannelPlugin());
  channelLoader.register(new QQBotChannelPlugin());
  channelLoader.register(new WecomChannelPlugin());

  // Create channel instances: default (from evolclaw.json) + each evolagent
  const defaultInstances = await channelLoader.createAll(config);

  const evolagentInstances: ChannelInstance[] = [];
  for (const agent of agentRegistry.runnableAgents()) {
    const agentConfig = {
      agents: agent.config.agents,
      channels: agent.config.channels,
      projects: agent.config.projects,
    } as any;
    try {
      const instances = await channelLoader.createAll(agentConfig);
      evolagentInstances.push(...instances);
    } catch (e) {
      logger.error(`[EvolAgent] Failed to create channels for ${agent.name}: ${e}`);
      agent.status = 'error';
      agent.error = `Channel creation failed: ${e}`;
    }
  }

  const channelInstances = [...defaultInstances, ...evolagentInstances];
  logger.info(`✓ Created ${channelInstances.length} channel instance(s)${evolagentInstances.length > 0 ? ` (${defaultInstances.length} default + ${evolagentInstances.length} agent)` : ''}`);

  // 启动迁移：将 sessions.channel 从 channelType 回填为实例名
  sessionManager.migrateChannelToInstanceName();

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentMap, config, messageCache, eventBus, defaultAgent);
  cmdHandler.setPermissionGateway(permissionGateway);
  cmdHandler.setInteractionRouter(interactionRouter);
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

  // Inject AgentRegistry (methods added by T6/T7)
  if ((processor as any).setAgentRegistry) {
    (processor as any).setAgentRegistry(agentRegistry);
  }
  if ((cmdHandler as any).setAgentRegistry) {
    (cmdHandler as any).setAgentRegistry(agentRegistry);
  }

  // 设置交互路由器
  processor.setInteractionRouter(interactionRouter);

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
  processor.setMessageQueue(messageQueue);

  // 默认策略
  const defaultPolicy = {
    canSwitchProject: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canListProjects: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canCreateSession: () => true,
    canDeleteSession: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    canImportCliSession: (chatType: string, role: string) => chatType === 'private' ? (role === 'owner' || role === 'admin') : role === 'owner',
    messagePrefix: () => '',
    showMiddleResult: () => true,
    showIdleMonitor: () => true,
    accumulateErrors: () => true,
  };

  // ── MessageBridge：Channel ↔ Core 消息桥梁 ──

  const msgBridge = new MessageBridge(config, sessionManager, processor, messageQueue, cmdHandler, eventBus);

  // ── Channel instance registration (shared by startup and hot-load) ──

  function registerChannelInstance(inst: ChannelInstance): void {
    // 1. 项目路径提供器
    if (inst.onProjectPathRequest && inst.channel.onProjectPathRequest) {
      inst.channel.onProjectPathRequest(async (channelId: string) => {
        const session = await sessionManager.getOrCreateSession(
          inst.adapter.channelName, channelId,
          config.projects?.defaultPath || process.cwd(),
          undefined, undefined, undefined, undefined
        );
        return path.isAbsolute(session.projectPath)
          ? session.projectPath
          : path.resolve(process.cwd(), session.projectPath);
      });
    }

    // 2. 注册 adapter、policy 和 options（注入 channelType）
    const opts = inst.channelType
      ? { ...inst.options, channelType: inst.channelType }
      : inst.options;
    processor.registerChannel(inst.adapter, inst.policy || defaultPolicy, opts);
    cmdHandler.registerAdapter(inst.adapter);
    cmdHandler.registerChannel(inst.adapter.channelName, inst.channel, inst.channelType);
    if (inst.policy) {
      cmdHandler.registerPolicy(inst.adapter.channelName, inst.policy);
    }

    // 3. 交互回调
    if (inst.adapter.onInteraction) {
      inst.adapter.onInteraction((response) => {
        interactionRouter.handle(response);
      });
    }

    // 4. MessageBridge 注册（按 channelType 分发）
    const channelType = inst.channelType || inst.adapter.channelName;

    if (channelType === 'feishu') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async ({ channelId: chatId, content, images, peerId, peerName, messageId, mentions, threadId, rootId, chatType }: any) => {
          await handler({
            channel: channelType, channelId: chatId, content, images, chatType,
            peerId: peerId || '', peerName, messageId, mentions, threadId,
            // 只在话题场景（threadId 有值）才设置 replyContext；
            // 纯引用回复（rootId 有值但无 threadId）不设置，避免所有回复都带引用头
            replyContext: threadId ? { replyToMessageId: rootId ?? threadId, replyInThread: true } : undefined,
          });
        }),
        (channelId, text, replyContext) => inst.channel.sendMessage(channelId, text, {
          replyToMessageId: replyContext?.replyToMessageId,
          replyInThread: replyContext?.replyInThread,
        }),
        inst.adapter,
        channelType
      );
    }

    if (channelType === 'wechat') {
      if (inst.channel.setEventBus) {
        inst.channel.setEventBus(eventBus);
      }
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (channelId: string, content: string, peerId?: string,
          images?: Array<{ data: string; mimeType: string }>, chatType?: 'private' | 'group') => {
          handler({
            channel: channelType,
            channelId,
            content,
            images,
            chatType: chatType || 'private',
            peerId: peerId || '',
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter,
        channelType
      );
    }

    if (channelType === 'aun') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (opts: any) => {
          handler({
            channel: channelType,
            channelId: opts.channelId,
            content: opts.content,
            chatType: opts.chatType || 'private',
            peerId: opts.peerId || '',
            peerName: opts.peerName,
            messageId: opts.messageId,
            mentions: opts.mentions,
            threadId: opts.threadId,
            replyContext: opts.replyContext,
          });
        }),
        (channelId, text, replyContext) => inst.channel.sendMessage(channelId, text, replyContext),
        inst.adapter,
        channelType
      );

      // AUN 重连失败通知
      if (inst.channel.setOnChannelDown) {
        inst.channel.setOnChannelDown(() => {
          eventBus.publish({
            type: 'channel:health',
            channel: channelType,
            channelName: inst.adapter.channelName,
            status: 'auth_error',
            message: `⚠️ AUN 渠道 ${inst.adapter.channelName} 断连，自动重试已用尽。\n使用 /check rty aun 手动重连`,
            timestamp: Date.now(),
          });
        });
      }

      // proactive 模式入站白名单：注入 sessionMode 查询器
      if (typeof inst.channel.setSessionModeResolver === 'function') {
        const chName = inst.adapter.channelName;
        inst.channel.setSessionModeResolver(async (channelId: string) => {
          const session = await sessionManager.getActiveSession(chName, channelId);
          return session?.sessionMode;
        });
      }
    }

    if (channelType === 'dingtalk') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (event: any) => {
          handler({
            channel: channelType,
            channelId: event.channelId,
            content: event.content,
            images: event.images,
            chatType: event.chatType || 'private',
            peerId: event.peerId || '',
            peerName: event.peerName,
            messageId: event.messageId,
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter,
        channelType
      );
    }

    if (channelType === 'qqbot') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (event: any) => {
          handler({
            channel: channelType,
            channelId: event.channelId,
            content: event.content,
            images: event.images,
            chatType: event.chatType || 'private',
            peerId: event.peerId || '',
            peerName: event.peerName,
            messageId: event.messageId,
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter,
        channelType
      );
    }

    if (channelType === 'wecom') {
      msgBridge.register(inst.adapter.channelName,
        (handler) => inst.channel.onMessage(async (event: any) => {
          handler({
            channel: channelType,
            channelId: event.channelId,
            content: event.content,
            chatType: event.chatType || 'private',
            peerId: event.peerId || '',
            peerName: event.peerName,
            messageId: event.messageId,
          });
        }),
        (channelId, text) => inst.channel.sendMessage(channelId, text),
        inst.adapter,
        channelType
      );
    }

    // 5. 撤回消息 → 中断执行中任务
    inst.channel.onRecall?.((messageId: string) => {
      msgBridge.cancel(messageId);
    });
  }

  // ── 注册所有渠道实例 ──
  for (const inst of channelInstances) {
    registerChannelInstance(inst);
  }

  // ── 连接所有渠道 ──
  const connected = await channelLoader.connectAll(channelInstances);

  // Bind connected adapters to their owning agents
  // I1: only mark 'running' if a channel actually connected for that agent
  const connectedSet = new Set(connected);
  for (const inst of channelInstances) {
    const agent = agentRegistry.resolveByChannel(inst.adapter.channelName);
    if (!agent || agent.status === 'error') continue;
    agent.channels.set(inst.adapter.channelName, inst.adapter);
    if (agent.status === 'stopped' && connectedSet.has(inst.adapter.channelName)) {
      agent.status = 'running';
    }
  }

  // 预填充 Feishu 已知 thread_id（重启后避免误判话题创建）
  for (const inst of channelInstances) {
    const channelType = inst.channelType || inst.adapter.channelName;
    if (channelType === 'feishu' && 'preloadThreads' in inst.channel) {
      const threadIds = sessionManager.getKnownThreadIds(inst.adapter.channelName);
      (inst.channel as any).preloadThreads(threadIds);
    }
  }

  for (const name of connected) {
    const inst = channelInstances.find(i => i.adapter.channelName === name);
    const type = inst?.channelType || name;
    eventBus.publish({
      type: 'channel:connected',
      channel: type.toLowerCase(),
      channelName: name,
      timestamp: Date.now()
    });
  }

  // 统一 channel:health 跨通道通知（仅 auth_error）
  // 按 (channelType, ownerId) 去重，避免同类型多实例重复通知
  eventBus.subscribe('channel:health', (event) => {
    if (event.type !== 'channel:health' || event.status !== 'auth_error') return;
    const sourceChannelType = event.channel;
    const sourceChannelName = (event as any).channelName || sourceChannelType;
    const msg = event.message;
    logger.error(`[ChannelHealth] ${sourceChannelName} auth_error: ${msg}`);

    const notified = new Set<string>();  // channelType 去重（同类型只通知一次）
    for (const other of channelInstances) {
      const otherType = other.channelType || other.adapter.channelName;
      if (otherType === sourceChannelType) continue;  // 跳过同类型通道
      if (notified.has(otherType)) continue;  // 同类型已通知过
      const ownerId = getOwner(config, other.adapter.channelName);
      if (!ownerId) continue;
      notified.add(otherType);
      other.adapter.sendText(ownerId, msg).catch(err => {
        logger.error(`[ChannelHealth] Failed to notify ${other.adapter.channelName} owner:`, err);
      });
    }
  });

  // 按 channelType 归组显示连接摘要
  const connectedGroups = new Map<string, string[]>();
  for (const inst of channelInstances) {
    const name = inst.adapter.channelName;
    if (!connected.includes(name)) continue;
    const type = inst.channelType || name;
    if (!connectedGroups.has(type)) connectedGroups.set(type, []);
    connectedGroups.get(type)!.push(name);
  }
  const channelSummary = Array.from(connectedGroups.entries())
    .map(([type, names]) => names.length === 1 ? names[0] : `${type}[${names.join(', ')}]`)
    .join(', ');
  const totalCount = connected.length;

  logger.info(`🚀 EvolClaw is running with ${totalCount} channel(s): ${channelSummary}`);
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
          ? { replyToMessageId: pending.rootId, replyInThread: !!pending.threadId }
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

  // IPC server — 供 CLI 查询实时状态 + Agent ctl 指令执行
  const ipcServer = new IpcServer(resolvePaths().socket, (): IpcStatusResponse => {
    const channels: Record<string, ChannelStatus> = {};
    const channelsByType: Record<string, string[]> = {};
    for (const inst of channelInstances) {
      const name = inst.adapter.channelName;
      const status = inst.channel.getStatus?.() ?? { connected: true };
      const channelType = inst.channelType || name;
      channels[name] = { ...status, channelType };
      if (!channelsByType[channelType]) channelsByType[channelType] = [];
      channelsByType[channelType].push(name);
    }
    const snap = statsCollector.getSnapshot();
    return {
      pid: process.pid,
      uptime: snap.uptimeMs,
      channels,
      channelsByType,
      queue: {
        pending: messageQueue.getGlobalQueueLength(),
        processing: messageQueue.getGlobalProcessingCount(),
      },
      stats: {
        received: snap.lastHour.received,
        completed: snap.lastHour.completed,
        errors: snap.lastHour.errors,
        avgResponseMs: snap.lastHour.avgResponseMs,
      },
    };
  }, async (cmd, sessionId) => cmdHandler.handleCtl(cmd, sessionId));

  // M3: direct call (not cast) — wire AgentRegistry into IPC for evolagent.* handlers
  ipcServer.setAgentRegistry(agentRegistry);

  // ── Reload hooks: enable agentRegistry.reload() to drain/disconnect/restart channels ──
  const reloadHooks: ReloadHooks = buildReloadHooks({
    channelLoader,
    channelInstances,
    registerChannelInstance,
  });

  // Make reload hooks accessible to IPC handler & ctl handler (both run in this process)
  (globalThis as any).__evolclaw_reloadHooks = reloadHooks;

  // I3: start IPC server LAST, after all hook setup, to eliminate race window
  ipcServer.start();

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
  let shutdownSignal = 'unknown';
  const shutdown = async (signal?: string) => {
    if (signal) shutdownSignal = signal;
    const pid = process.pid;
    const ppid = process.ppid;
    logger.info(`\n\nShutting down gracefully... (signal=${shutdownSignal}, pid=${pid}, ppid=${ppid})`);
    fs.unwatchFile(configPath);
    ipcServer.stop();
    eventBus.publish({
      type: 'system:shutdown',
      timestamp: Date.now()
    });

    // 断开插件系统的渠道
    await channelLoader.disconnectAll(channelInstances);
    for (const inst of channelInstances) {
      const type = inst.channelType || inst.adapter.channelName;
      eventBus.publish({ type: 'channel:disconnected', channel: type, channelName: inst.adapter.channelName, reason: 'shutdown' });
    }

    sessionManager.close();
    logger.info('✓ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  const msg = `Fatal error: ${error?.stack || error}`;
  logger.error('Fatal error:', error);
  console.error(msg);  // ensure it lands in stdout.log for self-heal diagnostics
  process.exit(1);
});
