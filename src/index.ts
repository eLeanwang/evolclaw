import { ClaudeSessionFileAdapter } from './core/session/adapters/claude-session-file-adapter.js';
import { CodexSessionFileAdapter } from './core/session/adapters/codex-session-file-adapter.js';
import { GeminiSessionFileAdapter } from './core/session/adapters/gemini-session-file-adapter.js';
import { ensureDataDirs, resolvePaths, agentDir, syncKitsFromPackage } from './paths.js';
import { resolveAnthropicConfig } from './baseagents/resolve.js';
import { loadDefaults, loadAllAgents, mergeForAgent, ensureAgentDirSkeleton, autoMigrateIfNeeded } from './config-store.js';
import type { Config, MergedAgentConfig, AgentConfig, DefaultsConfig } from './types.js';
import { CONFIG_SCHEMA_VERSION } from './types.js';
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
import { AidStatsCollector } from './utils/aid-stats-collector.js';
import { PermissionGateway } from './core/permission.js';
import { InteractionRouter } from './core/interaction-router.js';
import { ChannelLoader, type ChannelInstance } from './core/channel-loader.js';
import { AgentLoader } from './core/agent-loader.js';
import { EvolAgentRegistry, type ReloadHooks } from './core/evolagent-registry.js';
import { buildReloadHooks } from './utils/reload-hooks.js';
import { IpcServer, IpcStatusResponse, ChannelStatus } from './ipc.js';
import { ChannelAdapter, Message } from './types.js';
import { logger, setLogLevel } from './utils/logger.js';
import { writeMain, removeAll, isMainWinner, scanInstances } from './utils/instance-registry.js';
import { detectDuplicates } from './core/evolagent-registry.js';
import { loadPromptTemplates } from './agents/templates.js';
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

  // 同步包内 kits/ 到 EVOLCLAW_HOME/kits/（首次启动或升级时）
  syncKitsFromPackage();

  // ── 单实例保护（pre-check + post-write self-check）──
  // pre-check：发现已有活 main 直接退出，避免起任何副作用
  {
    const pre = scanInstances();
    const aliveOthers = pre.mains.filter(m => m.alive && m.record.pid !== process.pid);
    if (aliveOthers.length > 0) {
      const pids = aliveOthers.map(m => m.record.pid).join(', ');
      const msg = `❌ Another EvolClaw instance is already running (PID: ${pids}). Use 'evolclaw restart' to replace it.`;
      logger.error(msg);
      console.error(msg);
      process.exit(1);
    }
  }

  // 立即登记自己（让其他并发启动者能看见我）
  const launchedBy = (process.env.EVOLCLAW_LAUNCHED_BY as any) || 'start';
  writeMain(launchedBy);
  logger.info(`✓ Instance record written: main-${process.pid}.json`);

  // post-write 自检：写完 record 后再扫一次，发现并发对手时按 (startedAt, pid) 选赢家
  {
    const verdict = isMainWinner();
    if (!verdict.winner) {
      logger.warn(`Lost main election to PID ${verdict.conflictingPid}, yielding`);
      console.error(`⚠ Another instance (PID ${verdict.conflictingPid}) started concurrently and won the election. Yielding.`);
      removeAll();
      process.exit(0);
    }
  }

  // 加载提示词模板
  loadPromptTemplates();

  // 加载配置（新结构：defaults.json + per-agent config.json）
  const defaults: DefaultsConfig = loadDefaults() ?? { $schema_version: CONFIG_SCHEMA_VERSION };

  // 应用配置中的日志级别（优先于环境变量）
  // logLevel 现在不在新结构中——若要保留，将来可加 defaults.debug.logLevel
  // 阶段 2c 暂跳过

  const paths = resolvePaths();

  // ── 自动迁移：旧 data/evolclaw.json → 新结构 ──
  autoMigrateIfNeeded();

  // ── EvolAgent Registry：加载 agents/<aid>/config.json ──
  const agentRegistry = new EvolAgentRegistry(paths.agentsDir);
  agentRegistry.loadAll();
  const agentInfos = agentRegistry.list();

  // 启动期硬约束：必须至少有一个 self-agent
  if (agentInfos.length === 0) {
    const skipped = agentRegistry.getSkipped();
    const lines = [
      '❌ No self-agent configured.',
      `  Run \`evolclaw aid new <name>\` to create one.`,
    ];
    if (skipped.length > 0) {
      lines.push(`  Skipped ${skipped.length} dir(s):`);
      for (const s of skipped) lines.push(`    - ${s.dirName}: ${s.reason}`);
    }
    const msg = lines.join('\n');
    logger.error(msg);
    console.error(msg);
    process.exit(1);
  }

  logger.info(`✓ Loaded ${agentInfos.length} self-agent(s)`);
  for (const info of agentInfos) {
    if (info.status === 'error') {
      logger.error(`  ✗ ${info.name}: ${info.error}`);
    } else if (info.status === 'disabled') {
      logger.info(`  ○ ${info.name} (disabled)`);
    } else {
      logger.info(`  ● ${info.name} ${info.baseagent} @ ${path.basename(info.projectPath)}`);
    }
  }

  // 跨 agent 凭证冲突
  {
    const dups = detectDuplicates(agentRegistry.runnableAgents());
    for (const d of dups) {
      const owners = d.agents.map(o => `${o.aid}(${o.channelName})`).join(', ');
      logger.warn(`⚠ Duplicate channel credential: ${d.fingerprint} claimed by ${owners}.`);
    }
  }

  // 选定主 agent（启动期 anthropic resolve 用，配合 IPC `evolagent.list` 显示）
  // 主 agent 取第一个非 error 非 disabled 的 self-agent。
  const primaryAgent = agentRegistry.runnableAgents()[0];
  if (!primaryAgent) {
    const msg = '❌ No runnable self-agent (all are error/disabled). Aborting.';
    logger.error(msg);
    console.error(msg);
    process.exit(1);
  }

  // 进程级设置（从 defaults 取，不属于任何 agent）
  const globalSettings: import('./types.js').GlobalSettings = {
    idleMonitor: (defaults as any).idleMonitor,
    debug: (defaults as any).debug,
  };

  if (globalSettings.debug?.logLevel) {
    setLogLevel(globalSettings.debug.logLevel);
  }

  // 启动期 anthropic 凭证校验（用 primaryAgent 的 baseagents.claude）
  const anthropic = resolveAnthropicConfig({
    agents: { claude: primaryAgent.config.baseagents?.claude as any },
  } as any);
  logger.info('✓ Config loaded (API keys hidden)');

  if (anthropic.baseUrl) {
    logger.info(`✓ Using custom API base URL: ${anthropic.baseUrl}`);
  }


  // Store for IPC access (T10 will wire this)
  // M4: removed dead globalThis.__evolclaw_agentRegistry assignment

  // 创建事件总线
  const eventBus = new EventBus();
  logger.info('✓ Event bus initialized');

  // 把所有事件录到 events.log（受 EVENT_LOG 环境变量控制）
  eventBus.subscribeAll((event) => logger.event(event));

  // 统计收集器（近 1 小时滚动统计）
  const statsCollector = new StatsCollector(eventBus);

  // Per-AID 消息统计收集器（累计，供 watch aid 实时展示）
  const aidStatsCollector = new AidStatsCollector();

  // 初始化 SessionManager（文件系统后端）
  const sessionManager = new SessionManager(paths.sessionsDir, eventBus,
    (channel, userId) => agentRegistry.isOwner(channel, userId),
    (channel, userId) => agentRegistry.isAdmin(channel, userId)
  );

  // sessionMode 解析：从 channel 路由到具体 agent，按 agent.config.chatmode
  sessionManager.setSessionModeResolver((channelKey, chatType) => {
    const agent = agentRegistry.resolveByChannel(channelKey);
    const cm = agent?.config.chatmode;
    if (!cm) return undefined;
    return chatType === 'group' ? cm.group : cm.private;
  });
  logger.info('✓ Database initialized');

  // 注册会话文件适配器（Claude / Codex 各自的会话文件操作）
  sessionManager.registerFileAdapter(new ClaudeSessionFileAdapter());
  sessionManager.registerFileAdapter(new CodexSessionFileAdapter());
  sessionManager.registerFileAdapter(new GeminiSessionFileAdapter());

  // Agent 插件系统：每个 EvolAgent × 每个 baseagent 一个独立 runner（H1/H2 修复）
  const agentLoader = new AgentLoader();
  agentLoader.register(new ClaudeAgentPlugin());
  agentLoader.register(new CodexAgentPlugin());
  agentLoader.register(new GeminiAgentPlugin());

  const agentInstances = agentLoader.createAll(agentRegistry, {
    onSessionIdUpdate: async (sessionId: string, agentSessionId: string) => {
      await sessionManager.updateAgentSessionIdBySessionId(sessionId, agentSessionId);
    },
  });

  // agentMap 复合键：${aid}::${baseagent}
  const agentMap = new Map<string, any>();
  for (const inst of agentInstances) {
    agentMap.set(`${inst.evolagentName}::${inst.baseagent}`, inst.agent);
  }
  const primaryBaseagent = primaryAgent.baseagent;
  const primaryRunnerKey = `${primaryAgent.aid}::${primaryBaseagent}`;
  const agentRunner = agentMap.get(primaryRunnerKey) || agentInstances[0]?.agent;
  if (!agentRunner) {
    throw new Error('No agent backend available. Check baseagents config (no runners created).');
  }
  logger.info(`✓ Runners ready (primary key: ${primaryRunnerKey}, total: ${agentMap.size}, keys: ${[...agentMap.keys()].join(', ')})`);

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

  // Create channel instances: 每个 self-agent 各自的 channels
  const evolagentInstances: ChannelInstance[] = [];
  for (const agent of agentRegistry.runnableAgents()) {
    try {
      const instances = await channelLoader.createForAgent(agent);
      evolagentInstances.push(...instances);
    } catch (e) {
      logger.error(`[Agent ${agent.aid}] Failed to create channels: ${e}`);
      agent.status = 'error';
      agent.error = `Channel creation failed: ${e}`;
    }
  }

  const channelInstances = evolagentInstances;
  logger.info(`✓ Created ${channelInstances.length} channel instance(s)`);

  // 创建命令处理器
  const cmdHandler = new CommandHandler(sessionManager, agentMap, messageCache, eventBus, primaryRunnerKey);
  cmdHandler.setPermissionGateway(permissionGateway);
  cmdHandler.setInteractionRouter(interactionRouter);
  cmdHandler.setStatsCollector(statsCollector);

  // 创建消息处理器
  const processor = new MessageProcessor(
    agentMap,
    sessionManager,
    globalSettings,
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
    primaryRunnerKey
  );

  // 回填 processor 和 messageQueue 的引用
  cmdHandler.setProcessor(processor);

  // Inject EvolAgentRegistry (methods added by T6/T7)
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
  messageQueue.setInterruptCallback(async (sessionKey, agentId, evolagentName) => {
    const baseagent = agentId || primaryBaseagent;
    const evol = evolagentName || primaryAgent.aid;
    const agent = agentMap.get(`${evol}::${baseagent}`)
      || agentMap.get(primaryRunnerKey);
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

  const msgBridge = new MessageBridge(primaryAgent.projectPath, sessionManager, processor, messageQueue, cmdHandler, eventBus, primaryAgent.config.debounce);
  msgBridge.setAgentRegistry(agentRegistry);

  // ── Channel instance registration (shared by startup and hot-load) ──

  function registerChannelInstance(inst: ChannelInstance): void {
    // 1. 项目路径提供器
    if (inst.onProjectPathRequest && inst.channel.onProjectPathRequest) {
      inst.channel.onProjectPathRequest(async (channelId: string) => {
        // Effective default path: use the agent that owns this channel.
        const owningAgent = agentRegistry.resolveByChannel(inst.adapter.channelName);
        const effectiveDefault = owningAgent?.projectPath
          ?? primaryAgent.projectPath;
        const session = await sessionManager.getOrCreateSession(
          inst.adapter.channelName, channelId,
          effectiveDefault,
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

    // 4. MessageBridge 注册
    const channelType = inst.channelType || inst.adapter.channelName;
    if (inst.registerBridge) {
      inst.registerBridge(msgBridge, channelType);
    }

    // 4b. 生命周期钩子
    if (inst.registerHooks) {
      inst.registerHooks({ eventBus, sessionManager });
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

  // Bind adapters to their owning agents and mark running
  for (const inst of channelInstances) {
    const agent = agentRegistry.resolveByChannel(inst.adapter.channelName);
    if (!agent || agent.status === 'error') continue;
    agent.channels.set(inst.adapter.channelName, inst.adapter);
    if (agent.status === 'stopped') {
      agent.status = 'running';
    }
  }

  // ── 连接所有渠道（异步，AUN 等 WebSocket 渠道在后台重连）──
  const connected = await channelLoader.connectAll(channelInstances);

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

  // 上线通知：延迟 1-3 秒后向 owner 发送上线消息（带 name + 工作目录）
  // 需在配置中 debug.upmsg: true 手动开启
  setTimeout(() => {
    for (const name of connected) {
      const agent = agentRegistry.resolveByChannel(name);
      if (!agent) continue;
      if (!agent.config.debug?.upmsg) continue;
      const ownerAid = agent.config.owners?.[0];
      if (!ownerAid) continue;
      const adapter = agent.channels.get(name);
      if (!adapter) continue;
      // 尝试从 agent.md 读取 name
      let agentName = agent.aid;
      try {
        const aunPath = process.env.AUN_HOME || path.join(require('os').homedir(), '.aun');
        const agentMdPath = path.join(aunPath, 'AIDs', agent.aid, 'agent.md');
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)/m);
        if (nameMatch) agentName = nameMatch[1].trim().replace(/"$/, '');
      } catch {}
      const projectDir = path.basename(agent.projectPath);
      adapter.sendText(ownerAid, `✓ ${agentName} 已上线 | 工作目录: ${projectDir}`).catch(() => {});
    }
  }, 1000 + Math.random() * 2000);

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
      const ownerId = agentRegistry.getOwner(other.adapter.channelName);
      if (!ownerId) continue;
      notified.add(otherType);
      other.adapter.sendText(ownerId, msg).catch(err => {
        logger.error(`[ChannelHealth] Failed to notify ${other.adapter.channelName} owner:`, err);
      });
    }
  });

  // 按 channelType 归组显示连接摘要（启动 banner 只显示类型+计数，详情看 `evolclaw status`）
  const connectedTypeCount = new Map<string, number>();
  const typeOrder: string[] = [];
  for (const inst of channelInstances) {
    const name = inst.adapter.channelName;
    if (!connected.includes(name)) continue;
    const type = inst.channelType || name;
    if (!connectedTypeCount.has(type)) {
      connectedTypeCount.set(type, 0);
      typeOrder.push(type);
    }
    connectedTypeCount.set(type, connectedTypeCount.get(type)! + 1);
  }
  const channelSummary = typeOrder
    .map(type => {
      const n = connectedTypeCount.get(type)!;
      return n === 1 ? type : `${type}×${n}`;
    })
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
      // 复合键：${aid}::${baseagent}，从 channel 反查 self-agent
      const owningAgent = agentRegistry.resolveByChannel(session.channel);
      if (!owningAgent) {
        logger.warn(`[Resume] session ${session.id}: channel "${session.channel}" not routable, skipping`);
        sessionManager.clearProcessing(session.id);
        continue;
      }
      const evolName = owningAgent.aid;
      const baseagentName = session.agentId || primaryBaseagent;
      const agent = agentMap.get(`${evolName}::${baseagentName}`) || agentMap.get(primaryRunnerKey);
      if (!agent) {
        sessionManager.clearProcessing(session.id);
        continue;
      }
      logger.info(`[Resume] Resuming session: ${session.id} (agent: ${evolName}::${baseagentName})`);
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

  // M3: direct call (not cast) — wire EvolAgentRegistry into IPC for evolagent.* handlers
  ipcServer.setAgentRegistry(agentRegistry);

  // 注入 AUN AID 状态聚合器：遍历所有 aun 类型 channel，调 getAidState() 收集
  ipcServer.setAunAidProvider(() => {
    const out: import('./types.js').AidConnectionState[] = [];
    for (const inst of channelInstances) {
      if (inst.channelType !== 'aun') continue;
      const ch = inst.channel as any;
      if (typeof ch?.getAidState === 'function') {
        try { out.push(ch.getAidState()); } catch { /* ignore */ }
      }
    }
    return out;
  });

  // 注入 Per-AID 统计收集器到所有 AUN channel 实例
  for (const inst of channelInstances) {
    if (inst.channelType !== 'aun') continue;
    const ch = inst.channel as any;
    if (typeof ch?.setAidStatsCollector === 'function') {
      ch.setAidStatsCollector(aidStatsCollector);
    }
  }

  // 注入 Per-AID 统计 IPC provider
  aidStatsCollector.setQueueStatsProvider((agentName: string) => ({
    processing: messageQueue.getProcessingCountByAgent(agentName),
    queued: messageQueue.getQueueLengthByAgent(agentName),
  }));
  ipcServer.setAunAidStatsProvider(() => aidStatsCollector.getAllSnapshots());

  // ── Reload hooks: enable agentRegistry.reload() to drain/disconnect/restart channels ──
  const reloadHooks: ReloadHooks = buildReloadHooks({
    channelLoader,
    channelInstances,
    registerChannelInstance,
    messageQueue,
  });

  // Make reload hooks accessible to IPC handler & ctl handler (both run in this process)
  (globalThis as any).__evolclaw_reloadHooks = reloadHooks;

  // Hot-load handler: dynamically add a new agent at runtime
  (globalThis as any).__evolclaw_hotLoadAgent = async (aid: string) => {
    const agent = agentRegistry.loadNewAgent(aid);
    if (!agent) throw new Error(`Failed to load agent ${aid}`);

    // 创建 channels
    const instances = await channelLoader.createForAgent(agent);
    for (const inst of instances) {
      registerChannelInstance(inst);
      agent.channels.set(inst.adapter.channelName, inst.adapter);
      channelInstances.push(inst);
    }
    agent.status = 'running';

    // 连接
    await channelLoader.connectAll(instances);
    logger.info(`[HotLoad] ✓ Agent ${aid} online with ${instances.length} channel(s)`);
  };

  // Full resync handler: scan disk, load new agents, unload removed/disabled, reload changed
  (globalThis as any).__evolclaw_resyncAgents = async () => {
    const { loadAllAgents: scanAgents, loadDefaults: readDefaults, mergeForAgent: merge } = await import('./config-store.js');
    const freshDefaults = readDefaults();
    const { agents: diskAgents } = scanAgents();
    const diskAidSet = new Set(diskAgents.map(a => a.aid));

    const results: string[] = [];

    // 1. 下线：运行时有但磁盘上没有 / disabled 的
    for (const [aid, agent] of [...(agentRegistry as any).agents.entries()] as [string, any][]) {
      const diskCfg = diskAgents.find(a => a.aid === aid);
      if (!diskCfg || diskCfg.enabled === false) {
        // 断开所有 channels
        for (const chName of agent.channelInstanceNames()) {
          const inst = channelInstances.find(i => i.adapter.channelName === chName);
          if (inst) {
            try { await inst.disconnect(); } catch {}
            const idx = channelInstances.indexOf(inst);
            if (idx >= 0) channelInstances.splice(idx, 1);
          }
        }
        (agentRegistry as any).agents.delete(aid);
        results.push(`- ${aid} (offline)`);
        continue;
      }
    }

    // 2. 新增：磁盘上有但运行时没有的
    for (const cfg of diskAgents) {
      if (cfg.enabled === false) continue;
      if ((agentRegistry as any).agents.has(cfg.aid)) continue;
      try {
        await (globalThis as any).__evolclaw_hotLoadAgent(cfg.aid);
        results.push(`+ ${cfg.aid} (online)`);
      } catch (e: any) {
        results.push(`✗ ${cfg.aid}: ${e?.message || e}`);
      }
    }

    // 3. 已有的：重新 reload（config 可能改了）
    const hooks = (globalThis as any).__evolclaw_reloadHooks;
    for (const cfg of diskAgents) {
      if (cfg.enabled === false) continue;
      if (!(agentRegistry as any).agents.has(cfg.aid)) continue;
      // 只有磁盘上存在且运行时也存在的才 reload
      try {
        await agentRegistry.reload(cfg.aid, hooks);
        results.push(`↻ ${cfg.aid} (reloaded)`);
      } catch (e: any) {
        results.push(`⚠ ${cfg.aid}: ${e?.message || e}`);
      }
    }

    // 重建 channel index
    (agentRegistry as any).channelIndex.clear();
    (agentRegistry as any).buildChannelIndex();

    logger.info(`[Resync] Done: ${results.length} agent(s) processed`);
    return results;
  };

  // I3: start IPC server LAST, after all hook setup, to eliminate race window
  ipcServer.start();

  // 配置 reload 走 IPC `evolagent.reload` 触发，不再用 watchFile。
  // 双 rename 原子写下 watchFile 的语义会被破坏，且新结构有 N 个 config.json 要监控；
  // 显式触发更可控。

  // 优雅关闭
  let shutdownSignal = 'unknown';
  const shutdown = async (signal?: string) => {
    if (signal) shutdownSignal = signal;
    const pid = process.pid;
    const ppid = process.ppid;
    logger.info(`\n\nShutting down gracefully... (signal=${shutdownSignal}, pid=${pid}, ppid=${ppid})`);
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
    removeAll();
    logger.info('✓ Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 兜底：进程退出前同步删除 instance 文件（防 async shutdown 未完成就被杀）
  process.on('exit', () => {
    removeAll();
  });
}

main().catch((error) => {
  const msg = `Fatal error: ${error?.stack || error}`;
  logger.error('Fatal error:', error);
  console.error(msg);  // ensure it lands in stdout.log for self-heal diagnostics
  process.exit(1);
});
