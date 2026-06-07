import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { type AgentRunnerFull, hasCompact, type AgentEvent, type Compactable } from '../../agents/claude-runner.js';
import { SessionManager } from '../session/session-manager.js';
import { appendMessageLog, buildOutboundEntry } from './message-log.js';
import { IMRenderer } from './im-renderer.js';
import { MessageCache } from './message-cache.js';
import type { MessageQueue } from './message-queue.js';
import { StreamIdleMonitor } from './stream-idle-monitor.js';
import { logger } from '../../utils/logger.js';
import { getErrorMessage, classifyError, ErrorType, ERROR_PREFIX, isInfraError, prefixErrorType, isRetryableError } from '../../utils/error-utils.js';
import { EventBus } from '../event-bus.js';
import { summarizeToolInput } from '../permission.js';
import type { Message, Session, ChannelAdapter, ChannelOptions, ChannelPolicy, CommandHandler, ReplyContext, AgentContext, EvolAgentRegistryHandle, GlobalSettings, OutboundEnvelope, OutboundPayload, InteractionRequest, InteractionKind, ActionInteraction, CommandCard } from '../../types.js';
import type { TriggerManager } from '../trigger/manager.js';
import { DEFAULT_PERMISSION_MODE } from '../../types.js';
import { getPackageRoot, resolveRoot, resolvePaths } from '../../paths.js';
import { renderKitSections, type KitRenderContext } from '../../agents/kit-renderer.js';
import { renderMessageBody, type RenderMessageResult } from '../../agents/message-renderer.js';
import { consumeHints, hintsToSubMessages, composeHintFallback } from './pending-hints.js';
import type { SubMessage } from '../../types.js';
import { normalizeBaseagent } from '../../agents/baseagent-normalize.js';
import type { InteractionRouter } from '../interaction-router.js';
import { renderActionAsText, renderCommandCardAsText } from '../interaction-router.js';
import { formatPeerKey } from '../relation/peer-key.js';
import { resolveEffectiveModel } from '../model/model-scope.js';
import { insertUsageEvent, insertContextBreakdown } from '../stats/writer.js';
import { normalizeUsage } from '../stats/normalizer.js';
import { getBudgetStatus } from '../stats/budget.js';

/** OS 信息在进程生命周期内是常量，模块加载时算一次。例: "Windows 11 Pro (win32 10.0.26200)" */
const OS_INFO = (() => {
  let label = '';
  try { label = os.version(); } catch { /* 旧 Node 无 os.version */ }
  return `${label ? label + ' ' : ''}(${os.platform()} ${os.release()})`;
})();

/** 当前 UTC 偏移，格式 +08:00 / -05:00。每条消息算（DST 安全）。 */
function currentTzOffset(): string {
  const off = -new Date().getTimezoneOffset(); // 分钟，东区为正
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** 当前本地日期 YYYY-MM-DD（按运行环境时区）。系统提示词用，一天才变一次（缓存友好）。 */
function currentLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前本地星期几（中文，如「星期四」）。 */
function currentWeekday(): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(new Date());
  } catch {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date().getDay()];
  }
}

function getContextTooLongHint(agent: AgentRunnerFull): string {
  if (canCompactAgent(agent)) {
    return '上下文过长，请精简提问或使用 /compact 压缩上下文';
  }
  return '上下文过长，请精简提问，或使用 /new 新建会话后继续';
}

function getContextCompactFailedHint(agent: AgentRunnerFull): string {
  if (canCompactAgent(agent)) {
    return '上下文过长，自动压缩失败，请手动输入 /compact 重试';
  }
  return '上下文过长，请精简提问，或使用 /new 新建会话后继续';
}

function canCompactAgent(agent: AgentRunnerFull): agent is AgentRunnerFull & Compactable {
  return hasCompact(agent) && agent.capabilities?.compact !== false;
}

/**
 * 构造 OutboundEnvelope —— 出站三件套的信封部分。
 *
 * 用于所有走 adapter.send 的出站路径：
 *  - 任务流内的 IMRenderer 投影（chatmode 由会话决定）
 *  - 命令回显（MessageBridge.handleCommand，taskId 用合成 ID `cmd-...`）
 *  - 网关层系统通知（src/index.ts，taskId 用 `system-...` / `restart-...` 等便于 events.log 关联）
 *
 * 注意：
 *  - chatmode 缺省 `'interactive'`（系统通知 / 命令回显都属于同步交互）；
 *  - timestamp 可由调用方注入（便于测试），缺省 `Date.now()`。
 */
export function buildEnvelope(opts: {
  taskId?: string;
  sessionId?: string;
  channel: string;
  channelId: string;
  agentName?: string;
  chatmode?: 'interactive' | 'proactive';
  replyContext?: ReplyContext;
  timestamp?: number;
}): OutboundEnvelope {
  return {
    taskId: opts.taskId ?? `interaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: opts.sessionId,
    channel: opts.channel,
    channelId: opts.channelId,
    agentName: opts.agentName ?? '<unknown>',
    chatmode: opts.chatmode ?? 'interactive',
    replyContext: opts.replyContext,
    timestamp: opts.timestamp ?? Date.now(),
  };
}

/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class MessageProcessor {
  private channels = new Map<string, { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy }>();
  private channelTypeMap = new Map<string, string>();  // channelType → channelName（首个实例）
  private currentRenderer?: IMRenderer;
  private shouldSuppressActivities = false;
  private agentMap: Map<string, AgentRunnerFull>;
  private primaryRunnerKey: string;
  private interruptedSessions = new Map<string, string>();  // sessionId → reason ('new_message' | 'stop' | ...)
  /** sessionId → 模型降级状态（带退避探测，进程重启清零） */
  private modelFallbackMap = new Map<string, {
    failCount: number;
    fallbackActive: boolean;
    messagesSinceFallback: number;
    nextProbeAt: number;
    hintShown: boolean;
  }>();
  private interactionRouter?: InteractionRouter;
  private messageQueue?: MessageQueue;
  /** sessionId → 活跃的空闲监控器，用于等待用户交互期间暂停/恢复计时 */
  private activeMonitors = new Map<string, StreamIdleMonitor>();

  /**
   * Get the runner for a given (channel, baseagent) pair.
   *
   * - `channel` is used to look up the owning EvolAgent (via registry).
   * - `baseagent` (e.g. 'claude') comes from `session.agentId`.
   *
   * Falls back to `primaryRunnerKey` (a composite key, e.g. `aid::claude`)
   * when no match is found.
   */
  getAgent(channel?: string, baseagent?: string): AgentRunnerFull {
    if (channel && baseagent) {
      const evolName = this.agentRegistry?.resolveByChannel(channel)?.name || '<unknown>';
      const key = `${evolName}::${baseagent}`;
      if (this.agentMap.has(key)) return this.agentMap.get(key)!;
    }
    if (this.agentMap.has(this.primaryRunnerKey)) return this.agentMap.get(this.primaryRunnerKey)!;
    return this.agentMap.values().next().value!;
  }

  /** 获取可用 agent 列表 */
  getAvailableAgents(): string[] {
    return [...this.agentMap.keys()];
  }

  /** 判断是否为后台会话（仅主会话参与判断，话题会话独立） */
  private isBackgroundSession(session: Session, _channel: string, _channelId: string): boolean {
    if (session.threadId) return false;
    // 使用 session 自身的 channelType 精确定位 active.json，避免扫描误匹配
    const active = this.sessionManager.getActiveSessionSync(session.channel, session.channelId, session.channelType, session.selfAID);
    return active ? session.id !== active.id : false;
  }

  constructor(
    agentRunnerOrMap: AgentRunnerFull | Map<string, AgentRunnerFull>,
    private sessionManager: SessionManager,
    private globalSettings: GlobalSettings,
    private messageCache: MessageCache,
    private eventBus: EventBus,
    private commandHandler?: CommandHandler,
    primaryRunnerKey?: string
  ) {
    if (agentRunnerOrMap instanceof Map) {
      this.agentMap = agentRunnerOrMap;
      this.primaryRunnerKey = primaryRunnerKey || '<unknown>::claude';
    } else {
      // 测试 / 单 runner 路径：占位 agent name 用 '<unknown>'
      this.agentMap = new Map([[`<unknown>::${agentRunnerOrMap.name}`, agentRunnerOrMap]]);
      this.primaryRunnerKey = `<unknown>::${agentRunnerOrMap.name}`;
    }

    // 监听中断事件，标记被中断的 session
    this.eventBus.subscribe('task:interrupted', (event) => {
      if ('sessionId' in event && event.sessionId) {
        this.interruptedSessions.set(event.sessionId as string, (event as any).reason || 'unknown');
      }
    });
  }

  setInteractionRouter(router: InteractionRouter): void {
    this.interactionRouter = router;
    // 等待用户交互期间暂停 idle 监控，应答/取消/超时后恢复——
    // 避免把「正在等用户点按钮」误判为「任务卡死」而中断任务。
    router.setWaitHooks({
      onWaitStart: (sessionId: string) => {
        this.activeMonitors.get(sessionId)?.pause();
      },
      onWaitEnd: (sessionId: string) => {
        this.activeMonitors.get(sessionId)?.resume();
      },
    });
  }

  setMessageQueue(queue: MessageQueue): void {
    this.messageQueue = queue;
  }

  private agentRegistry?: EvolAgentRegistryHandle;

  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  private getAgentContext(channelName: string, chatType: string): AgentContext | null {
    if (!this.agentRegistry) return null;
    const agent = this.agentRegistry.resolveByChannel(channelName);
    if (!agent) return null;
    // chatmode 解析优先级：agent.config.chatmode > globalSettings.chatmode
    const globalCm = agent.config?.chatmode ?? this.globalSettings.chatmode;
    return agent.getContext(channelName, chatType, globalCm);
  }

  /**
   * 观察者插话（v0.3）：消费当前 (对端, thread) 的待用提示，转成 owner-hint SubMessage。
   * 一次性语义：consumeHints 回放算有效集后清该 thread（其它 thread 残留则保留，否则删文件）。
   * 仅 aun 渠道（pending-hints 落在 sessions/aun/<self>/<对端>/）。
   */
  private consumeOwnerHints(session: Session, message: Message): SubMessage[] {
    const channelType = session.channelType || message.channelType || session.channel;
    if (channelType !== 'aun') return [];
    const selfAID = session.selfAID || message.selfAID;
    if (!selfAID) return [];
    // 会话定位键：私聊=对端 AID，群聊=groupId（均为 session.channelId）。
    const peerChannelId = session.channelId;
    if (!peerChannelId) return [];
    try {
      const hints = consumeHints(resolvePaths().sessionsDir, 'aun', peerChannelId, selfAID, session.threadId);
      if (hints.length === 0) return [];
      logger.info(`[MessageProcessor] consumed ${hints.length} owner-hint(s) for ${peerChannelId} thread=${session.threadId || 'main'}`);
      return hintsToSubMessages(hints);
    } catch (e) {
      logger.warn(`[MessageProcessor] consumeOwnerHints failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * 注册渠道适配器
   */
  registerChannel(adapter: ChannelAdapter, policy: ChannelPolicy, options?: ChannelOptions): void {
    this.channels.set(adapter.channelName, { adapter, options, policy });
    // 维护 channelType → channelName 映射（首个实例优先）
    const type = options?.channelType || adapter.channelName;
    if (!this.channelTypeMap.has(type)) {
      this.channelTypeMap.set(type, adapter.channelName);
    }
  }

  /**
   * 获取渠道适配器（支持实例名和 channelType）
   */
  getAdapter(channelName: string): ChannelAdapter | undefined {
    return this.resolveChannelInfo(channelName)?.adapter;
  }

  /**
   * 获取渠道信息（含 policy，支持实例名和 channelType）
   */
  getChannelInfo(channelName: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined {
    return this.resolveChannelInfo(channelName);
  }

  /**
   * 处理 compact 开始事件
   */
  handleCompactStart(sessionId?: string): void {
    if (sessionId) {
      this.eventBus.publish({ type: 'runner:compact-start', sessionId });
    }
    if (this.currentRenderer && !this.shouldSuppressActivities) {
      this.currentRenderer.addNotice('\u23f3 会话压缩中...', 'info', 'compact-start', true);
    }
  }

  /**
   * 根据 channel 标识查找渠道信息
   * 先按实例名精确匹配，再按 channelType 映射到实例名
   */
  private resolveChannelInfo(channel: string): { adapter: ChannelAdapter; options?: ChannelOptions; policy: ChannelPolicy } | undefined {
    // 1. 精确匹配实例名
    let info = this.channels.get(channel);
    if (info) return info;
    // 2. 按 channelType 查找（兼容按类型名路由）
    const instanceName = this.channelTypeMap.get(channel);
    if (instanceName) info = this.channels.get(instanceName);
    return info;
  }

  // 命令前缀列表（与 CommandHandler.quickCommandPrefixes 保持同步）
  private static readonly COMMAND_PREFIXES = [
    '/new', '/pwd', '/help', '/status', '/restart',
    '/model', '/effort', '/agent', '/slist', '/session', '/rename', '/repair', '/fork',
    '/stop', '/clear', '/compact', '/safe', '/del', '/perm', '/file', '/check',
    '/s ', '/name ', '/rewind', '/rw', '/rw ', '/activity', '/chatmode',
    '/aid', '/upgrade', '/evolagent',
  ];

  /** 判断消息内容是否为已知命令 */
  private isKnownCommand(content: string): boolean {
    return content === '/s' ||
      MessageProcessor.COMMAND_PREFIXES.some(cmd => content.startsWith(cmd));
  }

  /**
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
    const idleMs = (this.globalSettings.idleMonitor?.timeout ?? 120) * 1000;

    // 先解析会话，再优先用 session.metadata.channelKey 精确定位实例级 adapter
    // message.channel 现在存实例名（channelName），可直接用于精确路由
    const { session, absoluteProjectPath } = await this.resolveSession(message);

    // thread(feishu) pending strategy: inject replyContext so first reply creates the thread
    if (message.triggerMeta?.pendingThread && message.triggerMeta?.rootMessageId) {
      const triggerId = message.triggerMeta.triggerId;
      const channelKeyForAgent = session.metadata?.channelKey || message.channel;
      const trigMgr = this.agentRegistry?.resolveByChannel(channelKeyForAgent)?.triggerManager as TriggerManager | undefined;
      const onThreadCreated = trigMgr
        ? (threadId: string) => {
            try {
              trigMgr.update(triggerId, { targetThreadId: threadId, pendingThread: false });
              logger.info(`[MessageProcessor] Feishu thread created for trigger ${triggerId}: ${threadId}`);
            } catch (e) {
              logger.warn(`[MessageProcessor] Failed to write back thread_id for trigger ${triggerId}: ${e}`);
            }
          }
        : undefined;
      message.replyContext = {
        ...(message.replyContext ?? {}),
        replyToMessageId: message.triggerMeta.rootMessageId,
        replyInThread: true,
        ...(onThreadCreated ? { metadata: { ...(message.replyContext?.metadata ?? {}), onThreadCreated } } : {}),
      };
    }

    const channelKey = session.metadata?.channelKey || message.channel;
    const channelInfo = this.resolveChannelInfo(channelKey);

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${channelKey}`);
      return;
    }

    const { policy } = channelInfo;
    const streamKey = session.id;
    const chatType = message.chatType || 'private';
    const identityRole = session.identity?.role || 'anonymous';
    const monitorEnabled = this.globalSettings.idleMonitor?.enabled !== false;
    // 按 session.agentId 选择 agent 后端（idle-kill 路径需要 interrupt）
    const agent = this.getAgent(channelKey, session.agentId);

    // 计算是否抑制中间输出（工具活动 + 流式文本）
    const shouldSuppress = (): boolean => {
      return !policy.showMiddleResult(chatType, identityRole);
    };
    this.shouldSuppressActivities = shouldSuppress();

    let monitor: StreamIdleMonitor | undefined;
    let monitorInterval: ReturnType<typeof setInterval> | undefined;
    let rejectFn: (err: Error) => void;
    let lastIdleSec = 0;

    const resetTimer = (eventType?: string, toolName?: string) => {
      monitor?.recordEvent(eventType || 'unknown', toolName);
    };

    // Cache background status to avoid async call inside setInterval
    const isBackground = this.isBackgroundSession(session, message.channel, message.channelId);

        const timeoutPromise = new Promise<never>((_, reject) => {
      rejectFn = reject;
      if (!monitorEnabled) return;

      monitor = new StreamIdleMonitor(idleMs);
      this.activeMonitors.set(streamKey, monitor);
      monitorInterval = setInterval(() => {
        // Drain all pending levels in one tick
        let result = monitor!.check();
        while (result) {
          if (result.action === 'kill') {
            lastIdleSec = result.idleSec;
            logger.warn(`[MessageProcessor] Idle monitor: kill after ${result.idleSec}s idle, stream: ${streamKey}`);
            this.eventBus.publish({ type: 'runner:idle-timeout', sessionId: streamKey, idleSec: result.idleSec });
            logger.info(`[MessageProcessor] agent.interrupt invoked (idle-kill) stream=${streamKey}`);
            agent.interrupt(streamKey).catch(e => {
              logger.debug(`[MessageProcessor] Interrupt failed (may already be cleaned up):`, e);
            });
            rejectFn(new Error('SDK_TIMEOUT'));
            return;
          } else {
            // notify or warn: publish event, task continues
            logger.info(`[MessageProcessor] Idle monitor: ${result.action} after ${result.idleSec}s idle, stream: ${streamKey}`);
            this.eventBus.publish({
              type: result.action === 'notify' ? 'runner:idle-notify' : 'runner:idle-warn',
              sessionId: streamKey,
              idleSec: result.idleSec,
              totalEvents: result.state.totalEvents,
              totalToolCalls: result.state.totalToolCalls,
              lastToolName: result.state.lastToolName,
            });
          }
          result = monitor!.check();
        }
      }, 30000);
    });

    try {
      await Promise.race([
        this._processMessageInternal(message, session, absoluteProjectPath, resetTimer, shouldSuppress, () => lastIdleSec),
        timeoutPromise
      ]);
    } catch (error: any) {
      // 超时错误：kill 级别已发送诊断信息，无需再发
      // 非超时错误走通用处理

      // 记录错误到健康状态（复用已有 session）
      if (channelInfo) {
        try {
          const errorType = classifyError(error);

          // 上下文过长是可恢复错误，不累计错误计数
          if (errorType === ErrorType.CONTEXT_TOO_LONG) {
            logger.info(`[MessageProcessor] Context too long error, skipping error accumulation`);
          // 认证错误（401 / Invalid API Key）不是会话问题，不累计
          } else if (errorType === ErrorType.AUTH_ERROR) {
            logger.info(`[MessageProcessor] Auth error (invalid API key), skipping error accumulation`);
          // API 错误（5xx / 算力池切换等）是平台暂时性问题，不累计
          } else if (errorType === ErrorType.API_ERROR) {
            logger.info(`[MessageProcessor] API error, skipping error accumulation`);
          } else if (!policy.accumulateErrors(chatType, identityRole)) {
            logger.info(`[MessageProcessor] Non-accumulating error (chatType=${chatType}, identity=${identityRole}), skipping error accumulation`);
          } else {
            const prefixed = prefixErrorType(ERROR_PREFIX.INFRA, errorType);
            await this.sessionManager.recordError(session.id, prefixed, error.message);
          }
        } catch (statusError) {
          logger.error('[MessageProcessor] Failed to update health status:', statusError);
        }
      }

      throw error;
    } finally {
      if (monitorInterval) clearInterval(monitorInterval);
      this.activeMonitors.delete(streamKey);
    }
  }

  /** 获取回复上下文（跟着任务走） */
  private getReplyContext(message: Message): import('../../types.js').ReplyContext | undefined {
    return message.replyContext;
  }

  /** 自动安全模式已禁用：仅保留错误计数，不再自动切换状态 */
  private async _processMessageInternal(message: Message, session: Session, absoluteProjectPath: string, resetTimer: (eventType?: string, toolName?: string) => void, shouldSuppress: () => boolean, getLastIdleSec?: () => number): Promise<void> {
    const messageId = `${message.channel}_${message.channelId}_${message.timestamp || Date.now()}`;
    const channelKey = session.metadata?.channelKey || message.channel;
    const channelInfo = this.resolveChannelInfo(channelKey);
    // Per-method agent name for stats bucketing (agent.name or '<unknown>')
    const agentNameForStats = this.agentRegistry?.resolveByChannel(channelKey)?.name ?? '<unknown>';

    if (!channelInfo) {
      logger.error(`[MessageProcessor] Unknown channel: ${channelKey}`);
      return;
    }

    // 二次拦截：如果命令消息绕过 MessageBridge 的 handleCommand 泄漏到这里，
    // 静默丢弃而不是发送给 Agent（命令已在 MessageBridge 层处理过）
    const rawContent = message.content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
    if (rawContent.startsWith('/') && this.isKnownCommand(rawContent)) {
      logger.warn(`[MessageProcessor] Command leaked past MessageBridge, dropped: "${rawContent.substring(0, 40)}"`);
      return;
    }

    const { adapter, options } = channelInfo;
    const agent = this.getAgent(channelKey, session.agentId);
    const streamKey = session.id;

    // 为本次任务处理生成唯一 task_id（客户端生成，格式 task-{10hex}）
    const taskId = `task-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const chatmode = session.sessionMode ?? 'interactive';

    // 诊断日志：记录 inbound message_id 和生成的 task_id 的对应关系
    logger.info(`[MessageProcessor] Task created: inboundMsgId=${message.messageId ?? 'none'} taskId=${taskId} sessionId=${session.id} chatmode=${chatmode}`);

    // 构建带 taskId/chatmode 的 ReplyContext（本次任务所有出站消息共用）
    const taskReplyContext = (): ReplyContext => {
      const base = this.getReplyContext(message);
      return {
        ...(base ?? {}),
        metadata: { ...(base?.metadata ?? {}), taskId, chatmode },
      };
    };

    const isProactive = session.sessionMode === 'proactive';
    const isAutonomous = session.sessionMode === 'autonomous';
    const envelope = buildEnvelope({
      taskId,
      sessionId: session.id,
      channel: message.channel,
      channelId: message.channelId,
      agentName: agentNameForStats,
      chatmode: isProactive ? 'proactive' : 'interactive',
      replyContext: taskReplyContext(),
    });

    try {
      const isBackground = this.isBackgroundSession(session, message.channel, message.channelId);

      // 记录收到消息
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'received'
      });

      this.eventBus.publish({
        type: 'message:received',
        sessionId: session.id,
        channel: message.channel,
        channelId: message.channelId,
        content: message.content,
        agentName: agentNameForStats,
        timestamp: Date.now()
      });

      // ── 硬上限检查：超限直接返回提示，不调模型 ──
      {
        const budgetAgentAid = session.selfAID || message.selfAID || '';
        const budgetPeerKey = formatPeerKey(message.channel, message.channelId);
        const budgetStatus = getBudgetStatus(resolveRoot(), budgetAgentAid, budgetPeerKey);
        if (budgetStatus.hard_blocked) {
          logger.warn(`[MessageProcessor] Budget hard limit reached: agent=${budgetAgentAid} peer=${budgetPeerKey} pct=${budgetStatus.pct_used.toFixed(1)}%`);
          adapter.send(envelope, { kind: 'status.completed', metadata: { durationMs: 0 } }).catch(() => {});
          return;
        }
      }

      const imageInfo = message.images && message.images.length > 0 ? ` [${message.images.length} image(s)]` : '';
      const modeInfo = isBackground ? ' [\u540e\u53f0]' : '';
      const e2eeInfo = message.replyContext?.metadata?.encrypted != null ? ` encrypt=${message.replyContext.metadata.encrypted}` : '';
      logger.info(`[${message.channel}] ${message.channelId}: ${message.content}${imageInfo}${modeInfo}${e2eeInfo}`);
      // 构建 peer 标识（优先 peerName，退化到 peerId / channelId）
      const peerName = session.metadata?.peerName ?? message.peerName;
      const peerId = session.metadata?.peerId ?? message.peerId ?? message.channelId;
      const peerShort = peerId ? peerId.split('.')[0].split(':')[0] : '?';
      const peerLabel = peerName && peerName !== peerShort ? `${peerShort}(${peerName})` : peerShort;
      logger.info(`[MessageProcessor] session=${session.id} task=${taskId} peer=${peerLabel} chatType=${session.chatType} sessionMode=${session.sessionMode} agentId=${session.agentId} msgChatType=${message.chatType ?? 'n/a'}`);

      // 记录开始处理
      const taskEncrypt = message.replyContext?.metadata?.encrypted != null ? !!(message.replyContext.metadata.encrypted) : undefined;
      this.eventBus.publish({ type: 'task:started', sessionId: session.id, agentName: agentNameForStats, encrypt: taskEncrypt, chatmode: session.sessionMode || 'interactive' });
      // 触发器消息不发 processing status（无需通知用户）
      if (message.source !== 'trigger') {
        adapter.send(envelope, { kind: 'status.started' }).catch(() => {});
      }

      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'processing'
      });

      const startTime = Date.now();

      // 创建 IMRenderer（统一 interactive/proactive 两条路径）
      let firstReply = true;
      const renderer = new IMRenderer({
        adapter,
        envelope,
        flushDelay: (options?.flushDelay ?? this.agentRegistry?.resolveByChannel(channelKey)?.config?.flush_delay ?? 3) * 1000,
        suppressActivities: shouldSuppress() || isAutonomous,
        fileMarkerPattern: options?.fileMarkerPattern,
        diagEnabled: this.globalSettings.debug?.flusherDiag,
        send: async (payload) => {
          if (isAutonomous) return;  // autonomous session: never send to channel
          // proactive 模式：activity.batch 是 thought 协议内容，只发给支持 thought 的 channel
          // （不支持 thought 的 channel 静默丢弃，避免降级为普通消息）
          if (isProactive && payload.kind === 'activity.batch' && !adapter.capabilities?.thought) return;
          const isCurrentlyBackground = this.isBackgroundSession(session, message.channel, message.channelId);
          if (isCurrentlyBackground) return;

          const opts: ReplyContext = {};
          const baseReplyCtx = this.getReplyContext(message);
          if (baseReplyCtx) {
            Object.assign(opts, baseReplyCtx);
          } else if (firstReply && message.messageId && message.source !== 'trigger') {
            if (payload.kind === 'result.text' && payload.text) {
              opts.replyToMessageId = message.messageId;
              firstReply = false;
            }
          }
          if (payload.kind === 'result.text' && payload.isFinal) {
            opts.title = '\u2705 \u6700\u7ec8\u56de\u590d:';
          }
          opts.metadata = { ...(opts.metadata ?? {}), taskId, chatmode };

          const enrichedEnvelope: OutboundEnvelope = { ...envelope, replyContext: opts };
          await adapter.send(enrichedEnvelope, payload);
        },
      });

      this.currentRenderer = renderer;

      if (isProactive) {
        logger.info(`[MessageProcessor] proactive mode: outputs via thought.put task=${taskId}`);
      }

      // 调用 AgentRunner（含上下文过长自动 compact 重试）

      // 捕获当前消息的上下文（闭包），避免后续消息处理时串台
      const capturedChannelId = message.channelId;
      const capturedReplyContext = taskReplyContext();

      // 设置权限审批的消息发送回调（指向当前渠道）
      agent.setSendPrompt(async (text: string) => {
        await adapter.send({ ...envelope, replyContext: capturedReplyContext }, { kind: 'result.text', text, isFinal: true });
      });

      // 设置权限审批的交互上下文（支持交互卡片）
      agent.setPermissionContext?.(session.id, {
        adapter,
        channelId: capturedChannelId,
        replyContext: capturedReplyContext,
        interactionRouter: this.interactionRouter,
        userId: message.peerId || undefined,
        channel: message.channel,
        agentName: agentNameForStats,
        taskId,
        chatmode: isProactive ? 'proactive' : 'interactive',
        interceptNextMessage: this.messageQueue
          ? (sessionKey, handler) => this.messageQueue!.interceptNext(sessionKey, handler)
          : undefined,
        cancelIntercept: this.messageQueue
          ? (sessionKey) => this.messageQueue!.cancelIntercept(sessionKey)
          : undefined,
      });

      // 设置 per-session 权限模式（默认 bypass，所有角色统一）
      agent.setMode(session.metadata?.permissionMode ?? DEFAULT_PERMISSION_MODE);

      // 标记会话为处理中（实时持久化，重启后可恢复）
      this.sessionManager.markProcessing(session.id, taskId);
      if (message.replyContext?.metadata?.encrypted != null) {
        this.sessionManager.setSessionEncrypt(session.id, !!(message.replyContext.metadata.encrypted));
      }
      logger.info(`[MessageProcessor] session ${session.id} marked as processing task=${taskId}`);

      // 检查是否因新消息自动中断 — 包装 prompt 让 Agent 知道上下文
      const prevInterruptReason = this.interruptedSessions.get(session.id);
      this.interruptedSessions.delete(session.id);
      const wasInterrupted = prevInterruptReason === 'new_message' && !!session.agentSessionId;
      const wrapPrompt = (body: string) => wasInterrupted
        ? `【新消息插入】\n\n${body}\n\n【请无视之前中断继续处理】`
        : body;
      // 先用裸文本兜底；vars 构造完成后用消息渲染层重算（见下方 effectivePrompt 重赋值）。
      let effectivePrompt = wrapPrompt(message.content);

      let streamResult: { isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean; numTurns?: number; ttftMs?: number; tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; contextUsage?: { totalTokens: number; maxTokens: number; percentage: number; model: string; effort?: string } } = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };
      let effectiveSystemPrompt: string | undefined;
      let modelOverride: { model?: string; effort?: string } | undefined;
      let usedFallback = false;
      let skipEvolclawModel = false;
      let agentModel: string | undefined;

      try {
        // 动态构建运行时上下文提示
        const contextParts: string[] = [];
        const currentChannelType = options?.channelType || message.channel;

        // 提取 self 信息
        const adapterAny = channelInfo.adapter as unknown as {
          _selfAid?: () => string | undefined;
          _selfName?: () => string | undefined;
        };
        const selfAid = typeof adapterAny._selfAid === 'function' ? adapterAny._selfAid() : undefined;
        const selfName = typeof adapterAny._selfName === 'function' ? adapterAny._selfName() : undefined;
        const peerName = message.peerName || session.metadata?.peerName;

        // 通道能力
        const capParts: string[] = [];
        if (options?.supportsImages) capParts.push('图片输入');
        if (channelInfo.adapter.capabilities?.image) capParts.push('图片输出');
        if (!isProactive && channelInfo.adapter.capabilities?.file) capParts.push('文件发送');

        // Personal layer
        const owningAgent = this.agentRegistry?.resolveByChannel(channelKey);
        const persona = (owningAgent as any)?.getPersona?.() || undefined;
        const working = (owningAgent as any)?.getWorkingMemory?.() || undefined;
        if (persona) contextParts.push(persona);
        if (working) contextParts.push(`[当前关注]\n${working}`);

        // 计算 peerKey: <channelType>#<urlEncode(peerId)>
        const peerIdRaw = message.peerId;
        const peerKey = (currentChannelType && peerIdRaw)
          ? formatPeerKey(currentChannelType, peerIdRaw)
          : undefined;

        // 按 关系级 > agent级 > 全局 解析本次调用的模型/强度，作为 per-call 入参传入 runQuery。
        // 不缓存、不绑会话——改关系级/agent级后该范围所有会话的下条消息即时生效；
        // 多对端并发各自独立解析、各自传参，无共享状态可被污染。
        let effectiveModel: string | undefined;

        // 取降级状态，按退避策略决定是否跳过 evolclaw 作用域模型
        const fbState = this.modelFallbackMap.get(session.id) ?? {
          failCount: 0, fallbackActive: false,
          messagesSinceFallback: 0, nextProbeAt: 2, hintShown: false,
        };

        // 退避期内递增消息计数，判断是否到探测点
        if (fbState.fallbackActive) {
          fbState.messagesSinceFallback++;
          skipEvolclawModel = fbState.messagesSinceFallback < fbState.nextProbeAt;
          this.modelFallbackMap.set(session.id, fbState);
        }

        // 非跳过时：尝试解析 evolclaw 作用域模型
        let evolclawModelOverride: { model?: string; effort?: string } | undefined;
        if (!skipEvolclawModel) {
          try {
            const resolved = resolveEffectiveModel({ self: selfAid || undefined, peerKey });
            if (resolved.model) {
              evolclawModelOverride = { model: resolved.model, effort: resolved.effort };
              effectiveModel = resolved.model;
            }
          } catch (e) {
            logger.warn(`[MessageProcessor] resolveEffectiveModel failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          modelOverride = evolclawModelOverride;
        }

        const normalizedBaseagent = normalizeBaseagent(agent.name);
        agentModel = (typeof (agent as any).getModel === 'function') ? (agent as any).getModel() as string : undefined;

        // Kit renderer: 组装上下文
        const pkgRoot = getPackageRoot();
        const kitCtx: KitRenderContext = {
          vars: {
            EVOLCLAW_HOME: resolveRoot(),
            PACKAGE_ROOT: pkgRoot,
            CURRENT_PROJECT: absoluteProjectPath,
            // ECK 派生路径（manifest 引用时需要展开）
            KITS: path.join(pkgRoot, 'kits'),
            KITS_RULES: path.join(pkgRoot, 'kits', 'rules'),
            KITS_DOCS: path.join(pkgRoot, 'kits', 'docs'),
            KITS_TEMPLATES: path.join(pkgRoot, 'kits', 'templates'),
            KITS_FRAGMENTS: path.join(pkgRoot, 'kits', 'templates', 'system-fragments'),
            KITS_MESSAGE_FRAGMENTS: path.join(pkgRoot, 'kits', 'templates', 'message-fragments'),
            // evolclaw 运行模式：dev=源码仓库 | install=全局安装包
            evolclawMode: fs.existsSync(path.join(pkgRoot, 'src', 'index.ts')) ? 'dev' : 'install',
            // 路径变量(用于 manifest 路径展开,resolvePath 用 ctx.vars 取真值)
            PERSONAL_DIR: selfAid ? path.join(resolveRoot(), 'agents', selfAid, 'personal') : undefined,
            RELATIONS_DIR: selfAid ? path.join(resolveRoot(), 'agents', selfAid, 'relations') : undefined,
            VENUES_DIR: selfAid ? path.join(resolveRoot(), 'agents', selfAid, 'venues') : undefined,
            selfAid: selfAid || undefined,
            selfName: selfName || undefined,
            hasPersona: !!persona,
            hasWorkingMemory: !!working,
            peerId: peerIdRaw || undefined,
            peerKey,
            peerName: peerName || undefined,
            peerRole: session.identity?.role || 'anonymous',
            peerType: message.peerType || undefined,
            sameDevice: message.sameDevice ?? false,
            sameNetwork: message.sameNetwork ?? false,
            sameEgressIp: message.sameEgressIp ?? false,
            groupId: session.metadata?.groupId || undefined,
            groupName: session.metadata?.groupName || undefined,
            // 信封展示用：有群名则「名<ID>」，否则纯 ID。规避模板引擎无 not/else 的限制。
            groupLabel: session.metadata?.groupId
              ? (session.metadata?.groupName ? `${session.metadata.groupName}<${session.metadata.groupId}>` : session.metadata.groupId)
              : undefined,
            chatType: session.chatType || null,
            channel: currentChannelType || null,
            venueUid: undefined,
            // 群分发模式 / 客户端类型 / 权限模式
            // 优先本地 session 覆盖（/dispatch 命令），fallback 到服务器 dispatch_mode
            dispatch: session.metadata?.dispatchMode || message.dispatchMode || undefined,
            clientType: message.clientType || undefined,
            permissionMode: session.metadata?.permissionMode || 'auto',
            capabilities: capParts.length > 0 ? capParts.join('、') : undefined,
            project: path.basename(absoluteProjectPath),
            sessionId: session.id,
            sessionName: session.name || undefined,
            sessionCreatedAt: session.createdAt ? new Date(session.createdAt).toISOString() : undefined,
            // 时区（把 ISO 时间戳转本地时间用）+ OS 环境
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
            tzOffset: currentTzOffset(),
            localDate: currentLocalDate(),
            weekday: currentWeekday(),
            osInfo: OS_INFO,
            threadId: session.threadId || undefined,
            // Stage 3: sessionKey 持久化字段
            sessionKey: session.sessionKey,
            chatMode: isProactive ? 'proactive' : 'interactive',
            readonly: session.metadata?.permissionMode === 'readonly',
            baseAgent: normalizedBaseagent.canonical,
            baseAgentName: normalizedBaseagent.displayName,
            baseAgentModel: agentModel || undefined,
            effectiveModel: effectiveModel || agentModel || undefined,
            modelFallbackActive: (fbState.fallbackActive || skipEvolclawModel) ? true : undefined,
            modelFallbackModel: (fbState.fallbackActive || skipEvolclawModel) ? (agentModel || undefined) : undefined,
            agentSessionId: session.agentSessionId || undefined,
            // 渲染模式：各类型当前激活的 modeName（从内存 config 读，渲染层据此选 manifest section）。
            renderModes: this.agentRegistry?.resolveByChannel(channelKey)?.config?.render ?? undefined,
          },
          sessionId: session.id,
        };

        const kitContext = renderKitSections(kitCtx);
        if (kitContext) contextParts.push(kitContext);

        effectiveSystemPrompt = [options?.systemPromptAppend, ...contextParts].filter(Boolean).join('\n') || undefined;

        // ── Stats: context_breakdown 旁路采集（各段估算 token 数，字符数/4 近似） ──
        try {
          const estTokens = (s?: string) => s ? Math.ceil(s.length / 4) : 0;
          const cbModel = effectiveModel || agentModel || 'unknown';
          const cbMaxTokens = 200000; // 保守默认，后续可从 model-catalog 取
          const systemPromptTokens = estTokens(options?.systemPromptAppend);
          const personaTokens = estTokens(persona);
          const workingTokens = estTokens(working);
          const kitTokens = estTokens(kitContext);
          const totalEst = estTokens(effectiveSystemPrompt);
          insertContextBreakdown(resolveRoot(), {
            ts: Date.now(),
            agent_aid: selfAid || session.selfAID || '',
            session_id: session.id,
            turn_count: 0, // 按 ts 排序得轮次
            model: cbModel,
            max_tokens: cbMaxTokens,
            system_prompt: systemPromptTokens + personaTokens + workingTokens,
            system_tools: 0, // 工具 schema 不在此层，留 0（后续 runner 层补）
            mcp_tools: 0,
            custom_agents: 0,
            memory_files: kitTokens, // ECK 渲染的所有段（含 memory/skills/rules）
            skills: 0,
            messages: 0, // messages 段在 runner 层才知道
            free_space: Math.max(0, cbMaxTokens - totalEst),
            total_estimated: totalEst,
          });
        } catch { /* non-fatal */ }

        // 消息渲染层：用 message manifest 逐条渲染（时间 + 群聊发送者），组装成最终正文。
        // 单条消息构造单元素 items；批量合并的消息 message.items 已由队列填充。
        let renderResult: RenderMessageResult | undefined;
        const hasContent = message.content.trim() || (message.items && message.items.length > 0);
        if (hasContent) {
          const peerItems: SubMessage[] = message.items && message.items.length > 0
            ? message.items
            : [{
                peerId: message.peerId, peerName: peerName || undefined,
                peerType: message.peerType,
                sameDevice: message.sameDevice, sameNetwork: message.sameNetwork, sameEgressIp: message.sameEgressIp,
                content: message.content, timestamp: message.timestamp,
                images: message.images,
                mentionAids: message.mentionAids,
              }];

          // 观察者插话（v0.3）：消费 (对端, thread) 的待用提示，包成 owner-hint item 排在对端消息前。
          // 一次性语义：consumeOwnerHints 读取并删除（见 pending-hints.ts）。在 try 外消费，
          // 这样即便 renderMessageBody 抛错走 raw 兜底，也把提示原文拼进去——绝不静默丢提示。
          const hintItems = this.consumeOwnerHints(session, message);
          const renderItems: SubMessage[] = hintItems.length > 0 ? [...hintItems, ...peerItems] : peerItems;

          try {
            renderResult = renderMessageBody(renderItems, kitCtx.vars, session.id);
            if (renderResult.body.trim()) effectivePrompt = wrapPrompt(renderResult.body);
            else effectivePrompt = wrapPrompt(composeHintFallback(hintItems, message.content));
          } catch (e) {
            logger.warn(`[MessageProcessor] renderMessageBody failed, using raw content: ${e instanceof Error ? e.message : String(e)}`);
            effectivePrompt = wrapPrompt(composeHintFallback(hintItems, message.content));
          }
        }

        // 可重试错误（403/429/5xx）指数退避重试，最多 3 次
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          let streamRegistered = false;
          try {
            logger.info(`[MessageProcessor] agent.runQuery start: agent=${agent.name} session=${session.id} task=${taskId} attempt=${attempt}/${MAX_RETRIES} agentSessionId=${session.agentSessionId ?? 'none'}`);
            const stream = await agent.runQuery(
              session.id,
              effectivePrompt,
              absoluteProjectPath,
              session.agentSessionId,
              renderResult?.images.length ? renderResult.images : message.images,
              effectiveSystemPrompt,
              this.sessionManager,
              modelOverride
            );
            agent.registerStream(streamKey, stream);
            streamRegistered = true;

            streamResult = await this.processEventStream(
              stream,
              session,
              agent,
              renderer,
              resetTimer,
              shouldSuppress
            );
            // 探测成功（退避期内到达探测点且用的是 evolclaw 模型）→ 清零降级状态
            if (fbState.fallbackActive && !skipEvolclawModel && !usedFallback) {
              this.modelFallbackMap.delete(session.id);
              logger.info(`[MessageProcessor] Model probe succeeded, cleared fallback state for session=${session.id}`);
            }
            break; // 成功，跳出重试循环
          } catch (retryError) {
            if (streamRegistered) {
              agent.cleanupStream(streamKey);
            }
            // 模型不可用：累计计数，本次切换到 baseAgentModel 立即重试，不让用户看到失败
            if (classifyError(retryError) === ErrorType.MODEL_UNAVAILABLE && evolclawModelOverride?.model) {
              fbState.failCount++;
              if (fbState.failCount >= 2) {
                fbState.fallbackActive = true;
                fbState.messagesSinceFallback = 0;
                fbState.nextProbeAt = Math.min(Math.pow(2, fbState.failCount - 1), 8);
              }
              this.modelFallbackMap.set(session.id, fbState);
              logger.warn(`[MessageProcessor] Model unavailable: ${evolclawModelOverride.model}, failCount=${fbState.failCount}, fallbackActive=${fbState.fallbackActive}`);
              // 切换到 baseAgentModel 重试（清除 modelOverride，让 runQuery 使用 this.model）
              modelOverride = undefined;
              usedFallback = true;
              continue;
            }
            if (attempt < MAX_RETRIES && isRetryableError(retryError)) {
              const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
              logger.warn(`[MessageProcessor] Retryable error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms:`, retryError);
              renderer.addNotice(`API 暂时不可用，${delay / 1000}秒后重试 (${attempt}/${MAX_RETRIES})...`, 'warn', 'retry', true);
              await renderer.flush();
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            throw retryError; // 不可重试或已耗尽重试次数
          }
        }
      } catch (error) {
        if (classifyError(error) === ErrorType.CONTEXT_TOO_LONG && session.agentSessionId && canCompactAgent(agent)) {
          // 尝试 compact 压缩会话
          renderer.addNotice('上下文过长，正在压缩会话...', 'warn', 'compact-trigger', true);
          await renderer.flush();

          const compacted = await agent.compact(
            session.id, session.agentSessionId, absoluteProjectPath
          );

          if (compacted) {
            renderer.addNotice('✅ 压缩完成，继续处理...', 'info', 'compact-retry', true);
            const retryStream = await agent.runQuery(
              session.id,
              '上下文已自动压缩，请继续之前未完成的任务。',
              absoluteProjectPath,
              session.agentSessionId,
              undefined,
              effectiveSystemPrompt,
              this.sessionManager,
              modelOverride
            );
            agent.registerStream(streamKey, retryStream);

            streamResult = await this.processEventStream(
              retryStream,
              session,
              agent,
              renderer,
              resetTimer,
              shouldSuppress
            );
          } else {
            throw new Error('CONTEXT_COMPACT_FAILED');
          }
        } else {
          throw error;
        }
      }

      // prompt_too_long：SDK 以 complete 事件（非异常）返回，需在此处触发 compact
      // 检测条件：terminalReason 明确为 prompt_too_long，或文本/errors 包含相关错误文本
      const contextTooLongPattern = /prompt is too long|input is too long|上下文过长/i;
      const errorsText = streamResult.errors?.join(' ') || '';
      const isPromptTooLong = streamResult.isError && session.agentSessionId && canCompactAgent(agent) && (
        streamResult.terminalReason === 'prompt_too_long' ||
        contextTooLongPattern.test(streamResult.lastReplyText) ||
        contextTooLongPattern.test(errorsText) ||
        contextTooLongPattern.test(streamResult.fullText)
      );
      if (isPromptTooLong) {
        renderer.addNotice('上下文过长，正在压缩会话...', 'warn', 'compact-trigger', true);
        await renderer.flush();
        const compacted = await agent.compact(session.id, session.agentSessionId!, absoluteProjectPath);
        if (compacted) {
          renderer.addNotice('✅ 压缩完成，继续处理...', 'info', 'compact-retry', true);
          const retryStream = await agent.runQuery(
            session.id,
            '上下文已自动压缩，请继续之前未完成的任务。',
            absoluteProjectPath,
            session.agentSessionId!,
            undefined,
            effectiveSystemPrompt,
            this.sessionManager,
            modelOverride
          );
          agent.registerStream(streamKey, retryStream);
          streamResult = await this.processEventStream(retryStream, session, agent, renderer, resetTimer, shouldSuppress);

          // 重试后仍然 prompt_too_long：清理 renderer 中可能混入的错误文本，显示友好提示
          const retryErrorsText = streamResult.errors?.join(' ') || '';
          const retryStillTooLong = streamResult.isError && (
            streamResult.terminalReason === 'prompt_too_long' ||
            contextTooLongPattern.test(streamResult.lastReplyText) ||
            contextTooLongPattern.test(retryErrorsText) ||
            contextTooLongPattern.test(streamResult.fullText)
          );
          if (retryStillTooLong) {
            renderer.addNotice(getContextTooLongHint(agent), 'warn', 'context-too-long', true);
          }
        } else {
          throw new Error('CONTEXT_COMPACT_FAILED');
        }
      } else if (streamResult.isError && !isPromptTooLong && (
        streamResult.terminalReason === 'prompt_too_long' ||
        contextTooLongPattern.test(streamResult.lastReplyText) ||
        contextTooLongPattern.test(errorsText) ||
        contextTooLongPattern.test(streamResult.fullText)
      )) {
        // 上下文过长但无法 auto-compact（无 session ID 或 agent 不支持），显示友好提示
        renderer.addNotice(getContextTooLongHint(agent), 'warn', 'context-too-long', true);
      }

      // 处理文件标记 - 支持 [SEND_FILE:path] 和 [SEND_FILE:channel:path]
      // 注意：始终扫描全部文本（含中间轮），因为文件标记可能出现在任意轮次
      // suppressed 模式下 renderer 只有最后一轮文本，需要用 streamResult.fullText（SDK 全文）兜底
      // proactive 模式：agent 主动调用 ctl file 发送文件，跳过标记处理
      if (!isProactive) {
        const FILE_MARKER_RE = /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g;
        const markerPattern = options?.fileMarkerPattern ?? FILE_MARKER_RE;
        const flusherText = renderer.getFinalText();
        const fullText = flusherText.length >= (streamResult.fullText?.length || 0) ? flusherText : streamResult.fullText;
        const fileMatches = [...fullText.matchAll(markerPattern)];

      for (const match of fileMatches) {
        // 兼容旧格式 (1组) 和新格式 (2组)
        const hasChannelGroup = match.length >= 3;
        let targetSpec = hasChannelGroup ? (match[1] ?? undefined) : undefined;
        let filePath = (hasChannelGroup ? match[2] : match[1]).trim();

        // 白名单校验：targetSpec 必须是已注册通道，否则视为路径的一部分（如 Windows 盘符 C:）
        if (targetSpec && !this.channels.has(targetSpec) && !this.channelTypeMap.has(targetSpec)) {
          filePath = `${targetSpec}:${filePath}`;
          targetSpec = undefined;
        }

        if (this.isPlaceholderPath(filePath)) {
          logger.info(`[${adapter.channelName}] Skipped placeholder file marker: [SEND_FILE:${filePath}]`);
          continue;
        }

        // 解析目标：按实例名匹配，再按 channelType 映射
        let targetInfo = targetSpec ? this.channels.get(targetSpec) : channelInfo;
        let targetLabel = targetSpec || message.channel;
        if (targetSpec && !targetInfo) {
          // 按 channelType 查找首个匹配的实例
          const instanceName = this.channelTypeMap.get(targetSpec);
          if (instanceName) targetInfo = this.channels.get(instanceName);
        }
        const currentChannelType = channelInfo.options?.channelType || adapter.channelName;
        const isCrossChannel = targetSpec && targetSpec !== message.channel
          && targetSpec !== currentChannelType;

        // 跨通道仅限 owner
        if (isCrossChannel && session.identity?.role !== 'owner') {
          await adapter.send(envelope, { kind: 'system.error', text: `\u274c 跨通道发送仅限管理员`, subtype: 'fatal' });
          continue;
        }

        const resolvedPath = this.resolveFilePath(filePath, absoluteProjectPath);
        if (!fs.existsSync(resolvedPath)) {
          logger.warn(`[${adapter.channelName}] File not found: ${resolvedPath}`);
          await adapter.send(envelope, { kind: 'system.error', text: `\u26a0\ufe0f 文件未找到: ${filePath}`, subtype: 'fatal' });
          continue;
        }

        // 找目标 adapter
        if (!targetInfo) {
          await adapter.send(envelope, { kind: 'system.error', text: `\u274c 通道 ${targetLabel} 未启用或不存在`, subtype: 'channel_down' });
          continue;
        }
        if (!targetInfo.adapter.capabilities?.file) {
          await adapter.send(envelope, { kind: 'system.error', text: `\u274c 通道 ${targetLabel} 不支持文件发送`, subtype: 'capability' });
          continue;
        }

        // 找目标 channelId
        let targetChannelId = message.channelId;
        if (isCrossChannel) {
          const targetAdapterName = targetInfo.adapter.channelName;
          const targetChannelType = targetInfo.options?.channelType || targetAdapterName;
          const ownerPeerId = this.agentRegistry?.getOwner?.(targetAdapterName);
          targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannelType, ownerPeerId) ?? '') : '';
          if (!targetChannelId) {
            await adapter.send(envelope, { kind: 'system.error', text: `\u274c 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息`, subtype: 'channel_down' });
            continue;
          }
        }

        logger.info(`[${adapter.channelName}] Sending file via ${targetInfo.adapter.channelName}: ${resolvedPath}`);
        try {
          await targetInfo.adapter.send(buildEnvelope({ taskId, channel: targetInfo.adapter.channelName, channelId: targetChannelId, agentName: agentNameForStats, replyContext: taskReplyContext() }), { kind: 'result.file', filePath: resolvedPath });
          this.eventBus.publish({ type: 'runner:file-sent', sessionId: session.id, filePath: resolvedPath, channel: targetInfo.adapter.channelName });
          if (isCrossChannel) {
            await adapter.send(envelope, { kind: 'system.notice', text: `\ud83d\udcce 文件已通过 ${targetLabel} 发送`, subtype: 'health' });
          }
        } catch (error) {
          logger.error(`[${adapter.channelName}] Failed to send file: ${resolvedPath}`, error);
          await adapter.send(envelope, { kind: 'system.error', text: `\u274c 文件发送失败: ${filePath}`, subtype: 'fatal' });
        }
      }
      }  // end of !isProactive

      // 最终回复文本：suppressed 模式或无 text 事件时需要兜底添加
      const finalReplyText = streamResult.lastReplyText || streamResult.fullText;

      if (finalReplyText) {
        if (isProactive && !streamResult.hasReceivedText && /^Unknown skill:\s+\S+/i.test(finalReplyText.trim())) {
          // Proactive 模式 + SDK 本地兜底：直接发送绕过 silent renderer
          const isCurrentlyBackground = this.isBackgroundSession(session, message.channel, message.channelId);
          if (!isCurrentlyBackground) {
            await adapter.send({ ...envelope, replyContext: capturedReplyContext }, { kind: 'result.text', text: finalReplyText, isFinal: true });
            logger.info(`[MessageProcessor] proactive SDK fallback replied task=${taskId} text="${finalReplyText.slice(0, 60)}"`);
          }
        } else if (shouldSuppress() || !streamResult.hasReceivedText) {
          renderer.addText(finalReplyText);
        }
      }

      // 先清理流和处理中状态（保证即使 flush 卡住，session 也不会永久处于"处理中"）
      agent.cleanupStream(streamKey);
      logger.info(`[MessageProcessor] agent.cleanupStream ok: session=${session.id} task=${taskId}`);
      this.sessionManager.clearProcessing(session.id);
      logger.info(`[MessageProcessor] session ${session.id} processing cleared task=${taskId}`);

      // 降级模型回复末尾追加标记（代码层硬注入，不依赖模型输出）
      const usingFallback = usedFallback || (skipEvolclawModel && agentModel != null);
      if (usingFallback && agentModel) {
        const curFbState = this.modelFallbackMap.get(session.id);
        const showHint = curFbState && curFbState.nextProbeAt >= 8 && !curFbState.hintShown;
        const suffix = showHint
          ? `\n\n---\n⚠️ [降级模型: ${agentModel} | 可告诉我"帮我检查可用模型"来诊断]`
          : `\n\n---\n⚠️ [降级模型: ${agentModel}]`;
        renderer.addText(suffix);
        if (showHint && curFbState) {
          curFbState.hintShown = true;
          this.modelFallbackMap.set(session.id, curFbState);
        }
      }

      // 被用户中断（新消息打断）时跳过 flush — 新 task 已接管渠道，旧 task 的 flush 无意义且可能卡住
      const preFlushInterrupt = this.interruptedSessions.get(session.id);
      if (preFlushInterrupt === 'new_message' || preFlushInterrupt === 'stop' || preFlushInterrupt === 'recalled') {
        logger.info(`[MessageProcessor] Skipping flush for interrupted task=${taskId} reason=${preFlushInterrupt}`);
      } else {
        // Flush 剩余内容（文件标记已在 flush 时自动移除）
        await renderer.flush(true);
      }

      // 更新 EvolAgent.lastActivity
      if (this.agentRegistry) {
        const owningAgent = this.agentRegistry.resolveByChannel(channelKey);
        if (owningAgent) owningAgent.lastActivity = Date.now();
      }
      // 注意：不在此处清除 interruptedSessions，由下一条消息的 prompt 包装逻辑消费
      const interruptReason = this.interruptedSessions.get(session.id);

      if (streamResult.isError) {
        // Agent 流正常结束但任务结果失败（权限被拒、max turns、工具链失败等）
        const errorSummary = streamResult.errors?.join('; ') || '任务执行失败';
        const rawSubtype = streamResult.subtype || 'agent_error';
        const errorType = prefixErrorType(ERROR_PREFIX.AGENT, rawSubtype);
        if (message.source !== 'trigger') {
          adapter.send(envelope, { kind: 'status.error', metadata: { errorType: rawSubtype } }).catch(() => {});
        }
        if (message.triggerMeta) {
          this.eventBus.publish({ type: 'trigger:failed', triggerId: message.triggerMeta.triggerId, messageId: messageId, error: errorSummary });
        }

        this.eventBus.publish({
          type: 'task:error',
          sessionId: session.id,
          error: errorSummary,
          errorType,
          agentName: agentNameForStats,
          terminalReason: streamResult.terminalReason
        });

        // 系统级 subtype 仍累计错误计数，供 /status 诊断使用
        if (isInfraError(rawSubtype, streamResult.terminalReason)) {
          const chatType = message.chatType || 'private';
          const identityRole = session.identity?.role || 'anonymous';
          const { policy } = channelInfo;
          if (policy.accumulateErrors(chatType, identityRole)) {
            await this.sessionManager.recordError(session.id, errorType, errorSummary);
          }
        }

        logger.message({
          msgId: messageId,
          sessionId: session.id,
          dir: 'inbound',
          status: 'failed',
          error: errorSummary,
          terminalReason: streamResult.terminalReason
        });
      } else {
        // 真正的成功
        const durationMs = Date.now() - startTime;

        // ── Stats: 写入 usage_events（在 status.completed 之前，以便带上 cost） ──
        let statsCostUsd = 0;
        let statsCostCny = 0;
        let statsCacheHitRate = 0;
        if (streamResult.tokenUsage) {
          try {
            const statsAgentAid = session.selfAID || message.selfAID || '';
            const statsPeerKey = formatPeerKey(message.channel, message.channelId);
            const statsModel = streamResult.contextUsage?.model || 'unknown';
            const ctxPct = streamResult.contextUsage?.percentage;
            const event = normalizeUsage(streamResult.tokenUsage as any, {
              ts: Date.now(),
              agent_aid: statsAgentAid,
              peer_key: statsPeerKey,
              peer_type: session.chatType || undefined,
              session_id: session.id,
              model: statsModel,
              turns: streamResult.numTurns,
              duration_ms: durationMs,
              context_window_pct: ctxPct,
            });
            insertUsageEvent(resolveRoot(), event);
            // 计算费用（用于合入 status.completed）
            const { calcCost } = await import('../stats/billing.js');
            const cost = calcCost(resolveRoot(), { ...event, ts: event.ts, model: event.model, billing_fn: event.billing_fn });
            statsCostUsd = cost.usd ?? 0;
            statsCostCny = cost.cny ?? 0;
            const totalIn = event.input_tokens + event.cache_read_tokens;
            statsCacheHitRate = totalIn > 0 ? Math.round((event.cache_read_tokens / totalIn) * 100) / 100 : 0;
          } catch (e) {
            logger.debug(`[MessageProcessor] Stats write failed (non-fatal): ${e}`);
          }
        }

        // 会话累计 + model spec（用于 status.completed 统计细目）
        let sessionStats: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; cost_usd: number; cost_cny: number; call_count: number } | undefined;
        let modelSpec: { context_window: number; max_input_tokens: number; max_output_tokens: number } | undefined;
        try {
          const { openReadonlyDb, getDbPath } = await import('../stats/db.js');
          const { resolveModelSpec } = await import('../stats/billing.js');
          const statsModel = streamResult.contextUsage?.model || 'unknown';
          modelSpec = resolveModelSpec(resolveRoot(), statsModel);
          const rdb = openReadonlyDb(getDbPath(resolveRoot()));
          if (rdb) {
            try {
              const row = rdb.prepare(
                `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
                        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
                        COUNT(*) AS call_count FROM usage_events WHERE session_id = ?`
              ).get(session.id) as any;
              if (row) {
                // 逐行算费用太贵，用近似：最后一轮的 cost 乘以次数不准，所以这里用累加 token 近似
                sessionStats = {
                  input_tokens: row.input_tokens,
                  output_tokens: row.output_tokens,
                  cache_read_tokens: row.cache_read_tokens,
                  cache_creation_tokens: row.cache_creation_tokens,
                  cost_usd: 0, cost_cny: 0,
                  call_count: row.call_count,
                };
                // 快速费用估算：用会话所有行逐行算
                const rows: any[] = rdb.prepare(`SELECT * FROM usage_events WHERE session_id = ?`).all(session.id);
                const { calcCost: cc } = await import('../stats/billing.js');
                for (const r of rows) {
                  const c = cc(resolveRoot(), r);
                  sessionStats.cost_usd += c.usd ?? 0;
                  sessionStats.cost_cny += c.cny ?? 0;
                }
              }
            } finally { rdb.close(); }
          }
        } catch { /* non-fatal */ }

        if (message.source !== 'trigger') {
          if (interruptReason) {
            adapter.send(envelope, { kind: 'status.interrupted', metadata: { reason: interruptReason } }).catch(() => {});
          } else {
            adapter.send(envelope, { kind: 'status.completed', metadata: {
              durationMs,
              ttftMs: streamResult.ttftMs,
              numTurns: streamResult.numTurns,
              tokenUsage: streamResult.tokenUsage,
              contextUsage: streamResult.contextUsage,
              cost_usd: statsCostUsd,
              cost_cny: statsCostCny,
              cache_hit_rate: statsCacheHitRate,
              model_spec: modelSpec,
              session_total: sessionStats,
            } as any }).catch(() => {});
          }
        }
        if (message.triggerMeta) {
          if (interruptReason) {
            this.eventBus.publish({ type: 'trigger:skipped', triggerId: message.triggerMeta.triggerId, reason: 'interrupted' });
          } else {
            this.eventBus.publish({ type: 'trigger:completed', triggerId: message.triggerMeta.triggerId, messageId: messageId, durationMs });
          }
        }
        await this.sessionManager.recordSuccess(session.id);

        this.eventBus.publish({
          type: 'task:completed',
          sessionId: session.id,
          channel: message.channel,
          channelId: message.channelId,
          terminalReason: streamResult.terminalReason,
          finalText: streamResult.lastReplyText || undefined,
          durationMs: Date.now() - startTime,
          agentName: agentNameForStats,
          numTurns: streamResult.numTurns,
          timestamp: Date.now()
        });

        // 记录处理完成
        logger.message({
          msgId: messageId,
          sessionId: session.id,
          dir: 'inbound',
          status: 'completed',
          duration: Date.now() - startTime
        });

        // 写入消息记录（出方向）已下沉到 aun.ts:deliverTextEntry，
        // 所有 message.send 成功后统一写入 messages.jsonl，此处不再重复写入。
      }

      const isFinallyBackground = this.isBackgroundSession(session, message.channel, message.channelId);
      if (isFinallyBackground && session.sessionMode !== 'autonomous') {
        const projectName = path.basename(session.projectPath);
        const count = this.messageCache.getCount(session.id);
        await adapter.send(envelope, { kind: 'system.notice', text: `[\u540e\u53f0-${projectName}] \u2713 任务完成 (${count}条消息已缓存)`, subtype: 'background' });
      }

      // 记录发送响应
      logger.message({
        msgId: `${messageId}_reply`,
        sessionId: session.id,
        dir: 'outbound',
        status: 'sent'
      });
    } catch (error) {
      // 清理流和处理中状态（异常时也要清除）
      agent.cleanupStream(streamKey);
      logger.info(`[MessageProcessor] agent.cleanupStream ok (on error): session=${session.id} task=${taskId}`);
      try {
        this.sessionManager.clearProcessing(session.id);
        logger.info(`[MessageProcessor] session ${session.id} processing cleared (on error) task=${taskId}`);
      } catch {}
      // 注意：不在此处清除 interruptedSessions，由下一条消息的 prompt 包装逻辑消费

      // 区分超时 / 中断 / 错误
      const errType = classifyError(error);
      const interruptReason = this.interruptedSessions.get(session.id);
      const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
      const procStatus = errType === ErrorType.SDK_TIMEOUT ? 'timeout' as const
        : errType === ErrorType.STREAM_ERROR ? 'interrupted' as const
        : 'error' as const;

      // 用户主动中断（新消息打断 或 /stop 命令）时静默，不发送中断/错误提示
      if (!isUserInterrupt) {
        const statusPayload = procStatus === 'timeout'
          ? { kind: 'status.timeout' as const, metadata: { idleSec: getLastIdleSec?.() || undefined } }
          : procStatus === 'interrupted'
          ? { kind: 'status.interrupted' as const, metadata: { reason: 'stream_error' } }
          : { kind: 'status.error' as const };
        adapter.send(envelope, statusPayload).catch(() => {});
      }

      // 用户主动中断时降级日志；其余仍按 error 记录
      if (isUserInterrupt) {
        logger.info(`[${message.channel}] Interrupted by user (${interruptReason})`);
      } else {
        logger.error(`[${message.channel}] Error:`, error);
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = prefixErrorType(ERROR_PREFIX.INFRA, errType);

      this.eventBus.publish({
        type: 'task:error',
        sessionId: session.id,
        error: errorMsg,
        errorType,
        agentName: agentNameForStats,
      });

      // 记录处理失败
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof Error && !isUserInterrupt) {
        logger.error(`[${message.channel}] Error stack:`, error.stack);
      }

      // 发送用户友好的错误消息
      // 用户主动中断（新消息打断 或 /stop 命令）时静默，不发送错误提示
      // processEventStream 已通过 renderer 发过错误时也跳过
      const isTimeout = error instanceof Error && error.message === 'SDK_TIMEOUT';
      if (isUserInterrupt) {
        logger.info(`[MessageProcessor] User interrupt by new_message, skip sending error message`);
      } else if ((error as any)?._errorAlreadySent) {
        logger.info(`[MessageProcessor] Error already sent via renderer, skip sending duplicate message`);
      } else {
        // SDK_TIMEOUT：status.timeout 已发结构化状态，此处再补一条用户可见的错误文本（result.error）
        const idleSec = getLastIdleSec?.() || 0;
        const userMessage = isTimeout
          ? (idleSec > 0 ? `⚠️ 任务超时（${idleSec}秒无响应），已自动中断` : '⚠️ 任务超时，已自动中断')
          : getErrorMessage(error, undefined);
        // 获取 session 用于话题回复（如果 resolveSession 已执行）
        let sendOpts: ReplyContext | undefined;
        try {
          await this.sessionManager.getOrCreateSession(
            message.channel,
            message.channelId,
            this.agentRegistry?.resolveByChannel(message.channel)?.projectPath || process.cwd(),
            message.threadId,
            undefined,
            undefined,
            message.peerId,
            message.chatType,
            undefined,
            message.selfAID,
            message.channelType,
            message.peerType
          );
          sendOpts = this.getReplyContext(message);
        } catch {}
        // 注入 taskId / chatmode（与任务主流程保持一致）
        sendOpts = {
          ...(sendOpts ?? {}),
          metadata: { ...(sendOpts?.metadata ?? {}), taskId, chatmode },
        };
        const errorPayload = isTimeout
          ? { kind: 'result.error' as const, text: userMessage, reason: 'timeout' }
          : { kind: 'result.text' as const, text: userMessage, isFinal: true };
        await adapter.send({ ...envelope, replyContext: sendOpts }, errorPayload);

        // Proactive 可观测：catch 块的基础设施错误也透传为 thought，保证按 task_id 聚合完整
      }
    }
  }

  /**
   * 解析会话和项目路径
   */
  private async resolveSession(message: Message): Promise<{
    session: Session;
    absoluteProjectPath: string;
  }> {
    // 话题会话创建时写入 replyContext（threadId 路由）；主会话不写（避免群聊覆盖）
    const metadata = (message.threadId && message.replyContext)
      ? { replyContext: message.replyContext }
      : undefined;

    const projectPath = this.agentRegistry?.resolveByChannel(message.channel)?.projectPath || process.cwd();

    // current strategy: resume bound session, make it active so output is not suppressed
    if (message.triggerMeta?.boundSessionId) {
      const bound = await this.sessionManager.getSessionById(message.triggerMeta.boundSessionId);
      if (bound) {
        const switched = await this.sessionManager.switchToSession(bound.channel, bound.channelId, bound.id);
        if (switched) {
          const absoluteProjectPath = path.isAbsolute(switched.projectPath)
            ? switched.projectPath : path.resolve(process.cwd(), switched.projectPath);
          return { session: switched, absoluteProjectPath };
        }
        logger.warn(`[MessageProcessor] switchToSession failed for bound session ${bound.id}, falling back to latest`);
      } else {
        logger.warn(`[MessageProcessor] Bound session ${message.triggerMeta.boundSessionId} not found, falling back to latest`);
      }
    }

    const session = await this.sessionManager.getOrCreateSession(
      message.channel,
      message.channelId,
      projectPath,
      message.threadId,
      metadata,
      undefined,
      message.peerId,
      message.chatType,
      undefined,
      message.selfAID,
      message.channelType,
      message.peerType
    );

    // 兜底纠正1：群聊强制 proactive
    if (message.chatType === 'group' && session.sessionMode !== 'proactive') {
      logger.info(`[MessageProcessor] group proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive`);
      session.sessionMode = 'proactive';
      await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
    }

    // 群名解析：群会话首次取群显示名（group.get），缓存到 metadata，供信封渲染。
    // 渠道私有方法 getGroupName 自带进程缓存 + 容错；取不到不阻塞（groupName 保持空，模板回退 groupId）。
    if (message.chatType === 'group' && session.metadata?.groupId && !session.metadata.groupName) {
      const adapter = this.resolveChannelInfo(message.channel)?.adapter;
      const groupName = await adapter?.getGroupName?.(session.metadata.groupId).catch(() => undefined);
      if (groupName) {
        session.metadata.groupName = groupName;
        await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
      }
    }

    // 群聊分发模式同步：aun.ts 从服务器信封解析的 dispatchMode 注入到 message，
    // 此处写入 session.metadata，确保 ECK 上下文的 venue fragment 正确渲染 dispatch 变量。
    // 仅当 message.dispatchMode 有值且与 session 记录不一致时更新。
    if (message.chatType === 'group' && message.dispatchMode && session.metadata?.dispatchMode !== message.dispatchMode) {
      logger.info(`[MessageProcessor] dispatchMode sync: sessionId=${session.id} ${session.metadata?.dispatchMode ?? 'none'} -> ${message.dispatchMode}`);
      session.metadata = { ...(session.metadata || {}), dispatchMode: message.dispatchMode };
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
    }

    // 兜底纠正2：旧 session 创建时没传 peerType（建为 interactive），后续非 human 消息进来时升级为 proactive。
    // 新建场景已由 getOrCreateSession 内部 resolveDefaultSessionMode 处理，这里只兜底历史会话。
    if (message.peerType && message.peerType !== 'human' && message.peerType !== 'unknown' && session.sessionMode !== 'proactive') {
      logger.info(`[MessageProcessor] proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive (peerType=${message.peerType})`);
      session.sessionMode = 'proactive';
      await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
    }

    // Proactive→Interactive 模式切换提示：上一轮 proactive 使用了标志位，本轮已切换为 interactive
    if (session.sessionMode === 'interactive' && session.metadata?.lastProactiveFlag) {
      message.content = '本轮会话已切换为 interactive 模式，无需调用工具发送消息。\n\n' + message.content;
      delete session.metadata.lastProactiveFlag;
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
      logger.info(`[MessageProcessor] Injected interactive mode hint for session ${session.id}`);
    }

    // replyContext 不再写入 session.metadata（跟着 message 走，避免群聊多人覆盖）

    const absoluteProjectPath = path.isAbsolute(session.projectPath)
      ? session.projectPath
      : path.resolve(process.cwd(), session.projectPath);

    return { session, absoluteProjectPath };
  }

  /**
   * 处理标准事件流（AgentEvent）
   *
   * 此方法只消费标准 AgentEvent 类型，不引用任何 SDK 特有事件。
   * SDK 事件 → AgentEvent 的转换在 AgentRunner.transformStream() 中完成。
   */
  private async processEventStream(
    stream: AsyncIterable<AgentEvent>,
    session: Session,
    agent: AgentRunnerFull,
    renderer: IMRenderer,
    resetTimer: (eventType?: string, toolName?: string) => void,
    shouldSuppress: () => boolean
  ): Promise<{ isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean; numTurns?: number; ttftMs?: number; tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; contextUsage?: { totalTokens: number; maxTokens: number; percentage: number; model: string; effort?: string } }> {
    // Per-session agent name for stats bucketing
    const agentNameForStats = this.agentRegistry?.resolveByChannel(session.metadata?.channelKey || session.channel)?.name ?? '<unknown>';
    let hasReceivedText = false;
    let hasErrorResult = false;  // 是否已有 tool_result/error 事件输出过错误
    let completeResult: { isError: boolean; subtype?: string; errors?: string[]; terminalReason?: string; lastReplyText: string; fullText: string; hasReceivedText: boolean; numTurns?: number; ttftMs?: number; tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; contextUsage?: { totalTokens: number; maxTokens: number; percentage: number; model: string; effort?: string } } = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };

    // 追踪最后一轮 assistant 回复文本（tool_use 之后的纯文本）
    let lastReplyText = '';

    // callId → description 映射，用于 tool_result 回显描述
    const toolDescByCallId = new Map<string, string>();

    try {
      for await (const event of stream) {
      // 每收到事件重置空闲超时
      const toolName = event.type === 'tool_use' ? event.name : undefined;
      resetTimer(event.type, toolName);

      // 记录事件类型：高价值事件（text/tool_use/tool_result/complete/error/compact/task_progress）INFO，
      // 框架事件（session_id/state_changed/status）DEBUG
      let eventDetail = '';
      if (event.type === 'text' && event.text) {
        const preview = event.text.replace(/\s+/g, ' ').slice(0, 80);
        eventDetail = ` text="${preview}${event.text.length > 80 ? '…' : ''}"`;
      } else if (event.type === 'tool_use') {
        const input = (event as any).input;
        const desc = input?.description
          || input?.file_path
          || input?.pattern
          || (typeof input?.command === 'string' ? input.command.slice(0, 80) : '')
          || (typeof input?.prompt === 'string' ? input.prompt.slice(0, 80) : '')
          || (typeof input?.query === 'string' ? input.query.slice(0, 80) : '')
          || '';
        eventDetail = ` tool=${event.name}${desc ? ` desc="${desc}"` : ''}`;
      } else if (event.type === 'tool_result') {
        eventDetail = ` tool=${event.name} ok=${!event.isError}`;
      }
      const frameworkEvents = new Set(['session_id', 'state_changed', 'status']);
      if (frameworkEvents.has(event.type)) {
        logger.debug(`[MessageProcessor] Event: type=${event.type}${eventDetail}`);
      } else {
        logger.info(`[MessageProcessor] Event: type=${event.type}${eventDetail}`);
      }

      // IMRenderer 旁路：proactive 模式逐事件投影为 thought（fire-and-forget）
      renderer.emit(event);

      // session_id 已在 AgentRunner.transformStream 中处理，此处仅记录
      if (event.type === 'session_id') {
        logger.debug(`[MessageProcessor] Session ID updated: ${event.sessionId} for session: ${session.id}`);
        continue;
      }

      // session 状态变更（idle/running/requires_action）
      if (event.type === 'state_changed') {
        logger.debug(`[MessageProcessor] Session state: ${event.state} for session: ${session.id}`);
        this.eventBus.publish({ type: 'runner:state-changed', sessionId: session.id, state: event.state });
        continue;
      }

      // agent 状态通知（仅事件，不直出给用户）
      if (event.type === 'status') {
        logger.debug(`[MessageProcessor] Agent status: ${event.subtype}: ${event.message}`);
        this.eventBus.publish({
          type: 'runner:status',
          sessionId: session.id,
          subtype: event.subtype,
          message: event.message,
          timestamp: Date.now()
        });
        continue;
      }

      const isCurrentlyBackground = this.isBackgroundSession(session, session.channel, session.channelId);

      // === 前台任务：正常处理所有事件 ===
      if (!isCurrentlyBackground) {
        // 流式文本
        if (event.type === 'text') {
          hasReceivedText = true;
          lastReplyText += event.text;
          this.eventBus.publish({ type: 'message:text', sessionId: session.id, text: event.text, isFinal: false });
          if (!shouldSuppress()) {
            renderer.addText(event.text, (event as any).outputTokens, (event as any).turn);
          }
        }

        // compact 完成
        if (event.type === 'compact') {
          this.eventBus.publish({ type: 'runner:compact-complete', sessionId: session.id, preTokens: event.preTokens });
          if (!shouldSuppress()) {
            renderer.addNotice(`\ud83d\udca1 会话压缩完成，继续执行...）`, 'info', 'compact');
          }
        }

        // 子任务进度
        if (event.type === 'task_progress') {
          const tools = event.toolUses ?? 0;
          const duration = event.durationMs ? `${Math.round(event.durationMs / 1000)}s` : '';
          const stats = [tools > 0 ? `${tools}\u6b21\u5de5\u5177\u8c03\u7528` : '', duration].filter(Boolean).join(', ');

          if (event.summary && !shouldSuppress()) {
            renderer.addProgress(`\u5b50\u4efb\u52a1: ${event.summary}${stats ? ` (${stats})` : ''}`, { state: 'processing', toolUses: event.toolUses, durationMs: event.durationMs });
          } else if (stats && !shouldSuppress()) {
            renderer.addProgress(`\u5b50\u4efb\u52a1\u8fdb\u884c\u4e2d: ${stats}`, { state: 'processing', toolUses: event.toolUses, durationMs: event.durationMs });
          }
        }

        // 工具调用
        if (event.type === 'tool_use') {
          // 工具调用意味着当前 turn 结束，flush 已累积的文本作为独立消息
          if (renderer.hasTextPending()) {
            await renderer.flushText();
          }
          // 重置最后回复追踪
          lastReplyText = '';
          this.eventBus.publish({
            type: 'tool:use',
            sessionId: session.id,
            toolName: event.name,
            input: event.input,
            timestamp: Date.now()
          });
          if (!shouldSuppress()) {
            const desc = summarizeToolInput(event.name, event.input || {});
            if (event.callId) {
              toolDescByCallId.set(event.callId, desc);
            }
            renderer.addToolCall(event.name, event.input, event.callId, desc, (event as any).turn, (event as any).outputTokens);
          }
        }

        // 工具结果
        if (event.type === 'tool_result') {
          this.eventBus.publish({
            type: 'tool:result',
            sessionId: session.id,
            toolName: event.name,
            isError: event.isError,
            content: event.result,
            agentName: agentNameForStats,
            timestamp: Date.now()
          });

          // 从 tool_use 阶段缓存的描述中回溯
          const cachedDesc = event.callId ? toolDescByCallId.get(event.callId) : undefined;

          if (event.isError && !shouldSuppress()) {
            hasErrorResult = true;
            let errorMsg = event.error || (typeof event.result === 'string' ? event.result : JSON.stringify(event.result)) || '\u6267\u884c\u5931\u8d25';
            // 移除 XML 风格的错误标签
            errorMsg = errorMsg.replace(/<tool_use_error>(.*?)<\/tool_use_error>/gs, '$1');
            renderer.addToolResult(event.name || '\u5de5\u5177', false, undefined, errorMsg, event.callId, undefined, cachedDesc);
          } else if (!event.isError && !shouldSuppress()) {
            renderer.addToolResult(event.name || '\u5de5\u5177', true, event.result, undefined, event.callId, undefined, cachedDesc);
          }
        }

        // 运行时错误（Codex: turn.failed / item error）
        if (event.type === 'error') {
          logger.warn(`[MessageProcessor] error event: ${event.errorType}: ${event.error}`);

          // 记录错误文本到 lastReplyText，供后续 isPromptTooLong 检测
          lastReplyText += event.error || '';

          // 上下文过长的错误不在此处输出 notice，留给外层 isPromptTooLong 触发 auto-compact
          const isContextError = /prompt is too long|input is too long|上下文过长/i.test(event.error || '');
          if (!isContextError && !hasErrorResult && !shouldSuppress()) {
            hasErrorResult = true;
            renderer.addNotice(`${event.error}`, 'warn', 'runtime-error', true);
          }
        }

        // 完成事件
        // SDK 可能产生多个 complete 事件（如 subagent 或 auto-compact 二次查询），
        // 仅记录状态，最终 flush(true) 在流结束后统一执行
        if (event.type === 'complete') {
          const isAbort = event.terminalReason === 'aborted_streaming' || event.terminalReason === 'aborted_tools';
          logger.info(`[MessageProcessor] ${isAbort ? 'task interrupted' : 'complete event'}: isError=${event.isError} terminalReason=${event.terminalReason ?? 'none'} subtype=${event.subtype ?? 'none'} hasReceivedText=${hasReceivedText}`);

          // 自动回填会话名称
          if (event.sessionTitle && session.name === '默认会话') {
            await this.sessionManager.renameSession(session.id, event.sessionTitle);
            logger.info(`[MessageProcessor] Auto-filled session name: ${event.sessionTitle}`);
          }

          // 记录完成状态 + 最后一轮回复文本（后续 complete 覆盖前序）
          completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText, numTurns: event.numTurns, ttftMs: event.ttftMs, tokenUsage: event.tokenUsage, contextUsage: event.contextUsage };

          // thought jsonl 写入已下沉到 aun.ts:sendThought 成功后，
          // 由那里按 LLM 输出的每个 text item 单独写一条，此处不再写。

          // 失败且无前置错误输出：显示 errors 摘要
          // 但用户主动中断（新消息打断 或 /stop 命令）时不显示错误提示
          // 上下文过长的错误留给外层 isPromptTooLong 触发 auto-compact，不在此处输出
          const interruptReason = this.interruptedSessions.get(session.id);
          const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
          const isContextTooLong = event.terminalReason === 'prompt_too_long'
            || /prompt is too long|input is too long|上下文过长/i.test(event.errors?.join(' ') || '')
            || /prompt is too long|input is too long|上下文过长/i.test(lastReplyText);
          if (event.isError && !hasErrorResult && !shouldSuppress() && !isUserInterrupt && !isContextTooLong) {
            const errorSummary = event.errors?.join('; ') || '任务执行失败';
            // 使用 terminalReason 提供更友好的错误提示（不带 emoji，由 formatter 统一加）
            const userFriendlyMessage = event.terminalReason === 'prompt_too_long'
              ? getContextTooLongHint(agent)
              : event.terminalReason === 'context_compact_failed'
                ? getContextCompactFailedHint(agent)
                : event.terminalReason
                  ? getErrorMessage(null, event.terminalReason, false)
                  : errorSummary;
            renderer.addNotice(userFriendlyMessage, 'warn', 'task-error', true);
          }

          // 中间 complete：flush 掉已有 activities（不带 isFinal），让中间结果及时显示
          // 最终文本留给流结束后的统一 flush(true)
          if (renderer.hasContent()) {
            await renderer.flushActivitiesOnly();
          }

          // 检测 proactive 标志位，设置 lastProactiveFlag 供模式切换提示使用
          if (session.sessionMode === 'proactive' && lastReplyText) {
            if (/\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText)) {
              session.metadata = session.metadata || {};
              session.metadata.lastProactiveFlag = true;
              await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
              logger.debug(`[MessageProcessor] Set lastProactiveFlag for session ${session.id}`);
            }
          }
        }

        continue;
      }

      // === 后台任务：追踪最后回复文本，但只处理 complete 事件 ===
      if (event.type === 'text') {
        lastReplyText += event.text;
      } else if (event.type === 'tool_use') {
        lastReplyText = '';
      }
      if (event.type !== 'complete') {
        continue;
      }

      // 自动回填会话名称
      if (event.sessionTitle && session.name === '默认会话') {
        await this.sessionManager.renameSession(session.id, event.sessionTitle);
        logger.info(`[MessageProcessor] Auto-filled session name: ${event.sessionTitle}`);
      }

      // 记录完成状态
      completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText, numTurns: event.numTurns, ttftMs: event.ttftMs, tokenUsage: event.tokenUsage, contextUsage: event.contextUsage };

      if (event.subtype === 'success') {
        this.messageCache.addEvent(session.id, {
          type: 'completed',
          message: lastReplyText || event.result || '',
          timestamp: Date.now(),
          metadata: {
            duration: event.durationMs,
            cost: event.costUsd
          }
        });
        // 后台任务完成也纳入统计
        this.eventBus.publish({
          type: 'task:completed',
          sessionId: session.id,
          channel: session.channel,
          channelId: session.channelId,
          finalText: lastReplyText || event.result || undefined,
          durationMs: event.durationMs,
          agentName: agentNameForStats,
          numTurns: event.numTurns,
          timestamp: Date.now()
        });
      } else if (event.isError === true) {
        const bgErrorType = prefixErrorType(ERROR_PREFIX.AGENT, event.subtype || 'agent_error');
        this.messageCache.addEvent(session.id, {
          type: 'error',
          message: event.errors?.join('\n') || '\u672a\u77e5\u9519\u8bef',
          timestamp: Date.now(),
          metadata: {
            errorType: event.subtype
          }
        });
        // 后台任务失败也纳入统计
        this.eventBus.publish({
          type: 'task:error',
          sessionId: session.id,
          error: event.errors?.join('; ') || '\u672a\u77e5\u9519\u8bef',
          errorType: bgErrorType,
          agentName: agentNameForStats,
        });
      }
    }

    } catch (error) {
      // User interrupt (AbortError) is expected, log at info level
      const catchInterruptReason = this.interruptedSessions.get(session.id);
      const catchIsUserInterrupt = catchInterruptReason === 'new_message' || catchInterruptReason === 'stop' || catchInterruptReason === 'recalled';
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('[MessageProcessor] Stream interrupted (AbortError)');
        // User-initiated interrupt: skip flush — new task takes over the channel,
        // flushing here would send a spurious "最终回复" before the new task's output
        if (catchIsUserInterrupt) {
          completeResult.isError = false;
          completeResult.hasReceivedText = hasReceivedText;
          return completeResult;
        }
      } else if (catchIsUserInterrupt) {
        // SDK telemetry noise after user-initiated interrupt — not a real error
        logger.debug('[MessageProcessor] Stream ended after user interrupt:', (error as Error)?.message?.split('\n')[0]);
        completeResult.isError = false;
        completeResult.hasReceivedText = hasReceivedText;
        return completeResult;
      } else if (isRetryableError(error)) {
        // Retryable errors (network aborts, transient API failures) are noise at ERROR level
        logger.warn('[MessageProcessor] Stream processing error (retryable):', (error as Error)?.message?.split('\n')[0]);
      } else {
        logger.error('[MessageProcessor] Stream processing error:', error);
      }
      if (error instanceof Error && error.message.includes('process exited')) {
        renderer.addNotice('Claude Code 进程异常退出，请重试', 'warn', 'process-exit', true);
      }
      // Flush any pending error activities before re-throwing,
      // and mark the error so outer catch won't send a duplicate message
      if (hasErrorResult || renderer.hasContent()) {
        try { await renderer.flush(true); } catch {}
        if (error instanceof Error) {
          (error as any)._errorAlreadySent = true;
        }
      }
      throw error;
    }

    completeResult.hasReceivedText = hasReceivedText;
    return completeResult;
  }

  /**
   * 解析文件路径，支持相对路径和绝对路径
   * 优先在项目根目录查找，兜底尝试 .openclaw/workspace/
   */
  private resolveFilePath(filePath: string, projectPath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    // 优先在项目根目录查找
    const rootPath = path.join(projectPath, filePath);
    if (fs.existsSync(rootPath)) {
      return rootPath;
    }

    // 兜底：尝试 .openclaw/workspace/
    const workspacePath = path.join(projectPath, '.openclaw', 'workspace', filePath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }

    // 都找不到，返回项目根目录路径
    return rootPath;
  }


  /**
   * 判断文件路径是否为占位符/示例文本
   * 用于过滤大模型在说明文字中误写的 [SEND_FILE:...] 标记
   */
  private isPlaceholderPath(filePath: string): boolean {
    if (!filePath) return true;

    // 精确占位符
    const exactPlaceholders = ['...', '\u2026', 'path', 'file', 'file_path', 'filepath',
      '\u8def\u5f84', '\u6587\u4ef6\u8def\u5f84', '\u6587\u4ef6', 'filename', 'xxx'];
    if (exactPlaceholders.includes(filePath.toLowerCase())) return true;

    // 示例路径前缀
    if (/^(\/path\/to\/|\.\/path\/to\/|example\/|\u793a\u4f8b|\/example)/i.test(filePath)) return true;

    // 含模板变量
    if (/\$\{.+\}|\{\{.+\}\}|<.+>/.test(filePath)) return true;

    // 纯标点/特殊字符（非路径字符）
    if (/^[.\s\u2026]+$/.test(filePath)) return true;

    // 含正则/代码特殊字符（Agent 在说明中引用了代码或正则表达式）
    if (/[\[\]{}*+?|^$]/.test(filePath)) return true;

    return false;
  }
}

// ── 出站协议辅助：buildEnvelope / sendInteractionPayload ──
// Phase 3 of outbound unification: callers (permission flow, CommandHandler
// interaction cards, claude-runner AskUserQuestion / ExitPlanMode) should
// produce `{ kind: 'interaction', interaction, fallbackText }` and dispatch
// via `adapter.send(envelope, payload)` instead of calling
// `adapter.sendInteraction(...)` directly. These helpers centralise the
// indirection and provide a backwards-compatible fallback path for adapters
// that do not yet implement `send`.

/**
 * Default fallback text for an InteractionRequest. Used when the caller
 * does not supply one explicitly. Picks the appropriate renderer based on
 * the interaction kind.
 */
export function defaultFallbackText(interaction: InteractionRequest): string {
  const kind: InteractionKind = interaction.kind;
  if (kind.kind === 'command-card') {
    return renderCommandCardAsText(kind);
  }
  if (kind.kind === 'action') {
    try {
      return renderActionAsText(interaction);
    } catch {
      // ActionInteraction without fallback metadata — produce a minimal hint
      const action = kind as ActionInteraction;
      const lines = [action.title];
      if (action.body) lines.push(action.body);
      return lines.join('\n');
    }
  }
  return '';
}

/**
 * Send an interaction payload through the unified `adapter.send` entrypoint.
 *
 * Sends an interaction via adapter.send(envelope, { kind: 'interaction', ... }).
 * Returns 'sent' on success, false on failure.
 */
export async function sendInteractionPayload(
  adapter: ChannelAdapter,
  envelope: OutboundEnvelope,
  interaction: InteractionRequest,
  fallbackText?: string,
  replyCtx?: ReplyContext,
): Promise<string | false> {
  const text = fallbackText ?? defaultFallbackText(interaction);
  const payload: OutboundPayload = {
    kind: 'interaction',
    interaction,
    fallbackText: text || undefined,
  };
  try {
    const enriched: OutboundEnvelope = replyCtx
      ? { ...envelope, replyContext: replyCtx }
      : envelope;
    await adapter.send(enriched, payload);
    return 'sent';
  } catch {
    return false;
  }
}
