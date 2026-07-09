import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { BaseagentRunnerUnavailableError, type AgentRunnerFull, hasCompact, hasClearSession, type AgentEvent, type Compactable, type AgentTokenUsage, type AgentContextUsage, type AgentLastModelCall, type AgentModelCall, autoCompactWindowForModel, isClaudeContextUsageModel } from '../../agents/runner-types.js';
import { SessionManager } from '../session/session-manager.js';
import { appendMessageLog, buildOutboundEntry } from './message-log.js';
import {
  appendHandoffConsumedEvent,
  buildTaskRuntimeEnv,
  formatEcMsgSendCommand,
  selectConsumableHandoff,
  toConsumedHandoffContext,
  type ConsumedHandoffContext,
  type TaskRuntimeContext,
} from './handoff.js';
import { IMRenderer } from './im-renderer.js';
import { MessageCache } from './message-cache.js';
import type { MessageQueue } from './message-queue.js';
import { StreamIdleMonitor } from './stream-idle-monitor.js';
import { logger } from '../../utils/logger.js';
import { getErrorMessage, classifyError, ErrorType, ERROR_PREFIX, isInfraError, prefixErrorType, isRetryableError, isContextTooLongText } from '../../utils/error-utils.js';
import { EventBus } from '../event-bus.js';
import { isEvolclawSendCommandForSession, summarizeToolInput } from '../permission.js';
import type { Message, Session, ChannelAdapter, ChannelOptions, ChannelPolicy, CommandHandler as CommandHandlerFn, ReplyContext, AgentContext, EvolAgentHandle, EvolAgentRegistryHandle, GlobalSettings, OutboundEnvelope, OutboundPayload, InteractionRequest, InteractionKind, ActionInteraction, CommandCard, ProactiveBehaviorBlock, ShowActivitiesMode } from '../../types.js';
import { getPackageRoot, resolveRoot, resolvePaths } from '../../paths.js';
import { renderKitSections, type KitRenderContext } from '../../eck/kit-renderer.js';
import { renderMessageBody, type RenderMessageResult } from '../../eck/message-renderer.js';
import { syncGroupVenueContext } from '../../eck/group-venue-sync.js';
import { consumeHints, hintsToSubMessages, composeHintFallback } from './pending-hints.js';
import type { SubMessage } from '../../types.js';
import { normalizeBaseagent } from '../../agents/baseagent.js';
import type { InteractionRouter } from '../interaction-router.js';
import { renderActionAsText, renderCommandCardAsText } from '../interaction-router.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import type { IMessageProcessor } from './message-processor-interface.js';
import { buildEnvelope, sendInteractionPayload } from './message-utils.js';
import { isSystemOrServicePeer, resolveChatModeForPeer } from './peer-mode.js';

// Re-export 工具函数（向后兼容，让其他模块可以从 response-engine 导入）
export { buildEnvelope, sendInteractionPayload } from './message-utils.js';
import { resolveEffectiveModel, resolvePermissionMode } from '../model/config-scope.js';
import { resolveEffective } from '../../config/config-manager.js';
import { checkRoleAccess, getFirstStaticAgentOwner, resolvePeerRoleDetail, roleToSessionIdentity } from '../../config/peer-role-resolver.js';
import { insertUsageEvent, insertContextBreakdown, insertModelCalls } from '../../stats/writer.js';
import { normalizeUsage } from '../../stats/normalizer.js';
import { resolvePrices } from '../../stats/price-resolver.js';
import { getBudgetStatus } from '../../stats/budget.js';
import { formatUsageSubjectKey, getRoleBudgetStatus } from '../../stats/role-budget.js';
import { snapshot } from './response-snapshot.js';
import { ResponseModeCoordinator, type ResolvedInbound } from '../../response-system/coordinator.js';
import { ResponseModeRegistry } from '../../response-system/registry.js';
import { registerBuiltinModes } from '../../response-system/modes/index.js';
import type { ProcessContext, ToolUseContext, CompleteContext, AfterProcessContext, RunConfig } from '../../response-system/types.js';

function isShowActivitiesMode(value: unknown): value is ShowActivitiesMode {
  return value === 'all' || value === 'text' || value === 'none';
}

type StreamRunResult = {
  isError: boolean;
  subtype?: string;
  errors?: string[];
  terminalReason?: string;
  lastReplyText: string;
  fullText: string;
  hasReceivedText: boolean;
  numTurns?: number;
  ttftMs?: number;
  tokenUsage?: AgentTokenUsage;
  contextUsage?: AgentContextUsage;
  lastModelCall?: AgentLastModelCall;
  modelCalls?: AgentModelCall[];
};

type CtlCommandHandler = CommandHandlerFn & {
  handleCtl?: (cmd: string, sessionId: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
};

type ProactiveRuntimeState = {
  firstToolDone: boolean;
  toolCount: number;
  lastQueueReminderLen: number;
  chatType: string;
  peerType?: string;
  preTool1stMsgChk: boolean;
  toolUseReminder: boolean;
  firstSendRequired: boolean;
  toolReportRequired: boolean;
  toolReportInterval: number;
  toolReportPending: boolean;
};

type ContextRecoveryOptions = {
  streamKey: string;
  renderer: IMRenderer;
  agent: AgentRunnerFull;
  session: Session;
  absoluteProjectPath: string;
  effectiveSystemPrompt: string | undefined;
  modelOverride: { model?: string; effort?: string; permissionMode?: string } | undefined;
  runtimeEnv?: Record<string, string>;
  resetTimer: () => void;
  shouldSuppress: () => boolean;
  proactive: ProactiveRuntimeState | null;
};

type RoleAwareHandle = {
  isOwner?: (channel: string, userId: string) => boolean;
  isAdmin?: (channel: string, userId: string) => boolean;
};

const RETRY_EXHAUSTED_MARK = Symbol('evolclaw.retryExhausted');
const RETRY_MADE_PROGRESS_MARK = Symbol('evolclaw.retryMadeProgress');
const RETRY_HEALTH_RECORDED_MARK = Symbol('evolclaw.retryHealthRecorded');

function markRetryExhausted(error: unknown, retries: number): void {
  if (error && typeof error === 'object') {
    (error as any)[RETRY_EXHAUSTED_MARK] = retries;
    // processEventStream may have already flushed the raw transient error as an
    // activity notice. The exhausted-retry message is the real terminal state.
    delete (error as any)._errorAlreadySent;
  }
}

function getRetryExhaustedCount(error: unknown): number | undefined {
  const retries = error && typeof error === 'object'
    ? (error as any)[RETRY_EXHAUSTED_MARK]
    : undefined;
  return typeof retries === 'number' ? retries : undefined;
}

function markRetryMadeProgress(error: unknown): void {
  if (error && typeof error === 'object') {
    (error as any)[RETRY_MADE_PROGRESS_MARK] = true;
  }
}

function didRetryMakeProgress(error: unknown): boolean {
  return !!(error && typeof error === 'object' && (error as any)[RETRY_MADE_PROGRESS_MARK] === true);
}

function markRetryHealthRecorded(error: unknown): void {
  if (error && typeof error === 'object') {
    (error as any)[RETRY_HEALTH_RECORDED_MARK] = true;
  }
}

function wasRetryHealthRecorded(error: unknown): boolean {
  return !!(error && typeof error === 'object' && (error as any)[RETRY_HEALTH_RECORDED_MARK] === true);
}

function formatRetryableErrorFinalMessage(error: unknown, retries: number): string {
  const reason = getErrorMessage(error, undefined, false) || 'API 暂时不可用';
  return `❌ API 暂时不可用，已自动重试 ${retries} 次仍失败，任务已停止。\n原因：${reason}`;
}

function getStreamErrorText(result: StreamRunResult): string {
  return [
    result.errors?.join('\n'),
    result.lastReplyText,
    result.fullText,
    result.subtype,
    result.terminalReason,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

function getStreamErrorMessage(result: StreamRunResult, includeEmoji = false): string {
  const raw = getStreamErrorText(result) || '任务执行失败';
  const mapped = getErrorMessage(new Error(raw), result.terminalReason, includeEmoji);
  const generic = includeEmoji ? '❌ 处理消息时出错，请稍后重试' : '处理消息时出错，请稍后重试';
  if (!result.terminalReason && raw && mapped === generic) {
    return includeEmoji ? `❌ ${raw}` : raw;
  }
  return mapped;
}

function getRuntimeErrorMessage(raw: string, includeEmoji = false): string {
  const fallback = raw || '任务执行失败';
  const mapped = getErrorMessage(new Error(fallback), undefined, includeEmoji);
  const generic = includeEmoji ? '❌ 处理消息时出错，请稍后重试' : '处理消息时出错，请稍后重试';
  if (mapped === generic) return includeEmoji ? `❌ ${fallback}` : fallback;
  return mapped;
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isPendingTextSameAsStreamError(pendingText: string, errorText: string): boolean {
  const pending = normalizeComparableText(pendingText);
  const error = normalizeComparableText(errorText);
  if (!pending || !error || pending.length < 20) return false;
  return pending === error || pending.includes(error) || error.includes(pending);
}

function streamHitContextLimit(result: StreamRunResult): boolean {
  return result.terminalReason === 'prompt_too_long' ||
    isContextTooLongText(result.lastReplyText) ||
    isContextTooLongText(result.errors?.join(' ') || '') ||
    isContextTooLongText(result.fullText);
}

function resolveProactiveBehavior(block?: ProactiveBehaviorBlock): Required<ProactiveBehaviorBlock> {
  return {
    pre_tool_1stmsgchk: block?.pre_tool_1stmsgchk ?? true,
    tool_use_reminder: block?.tool_use_reminder ?? true,
  };
}

const SHELL_CONTROL_RE = /[;&|`]|[$][(]|\r|\n/;

function isCtlQueueReadCommand(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (toolName !== 'Bash' && toolName !== 'Shell') return false;
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  if (!command || SHELL_CONTROL_RE.test(command)) return false;
  if (!/^(?:ec|evolclaw)\s+ctl\s+queue(?:\s|$)/.test(command)) return false;
  return !/(?:^|\s)--(?:clear|cancel|interrupt)(?:\s|$)/.test(command);
}

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

function canClearAgent(agent: AgentRunnerFull): boolean {
  return hasClearSession(agent) && agent.capabilities?.clear !== false;
}

function autoCompactTokensFromMaxTokens(maxTokens: number | undefined): number | undefined {
  if (!maxTokens || maxTokens <= 0) return undefined;
  return maxTokens >= 1000000 ? maxTokens - 100000 : maxTokens;
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
/**
 * 统一消息处理器
 * 负责处理来自不同渠道的消息，协调事件流处理
 */
export class ResponseEngine implements IMessageProcessor {
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
  /** sessionId → 当前正在处理任务的运行时上下文，供 in-task CLI 通过 IPC 查询。 */
  private activeTaskRuntimeContexts = new Map<string, TaskRuntimeContext>();

  /** 响应模式协调器（插件化机制中枢）。内置模式在构造时注册。 */
  private responseCoordinator: ResponseModeCoordinator;

  /**
   * Get the runner for a given (channel, baseagent) pair.
   *
   * - `channel` is used to look up the owning EvolAgent (via registry).
   * - `baseagent` (e.g. 'claude') comes from `session.baseagent`.
   *
   * Falls back only when the channel is not owned by a known EvolAgent. If the
   * owner is known but its requested baseagent runner is missing, this is a
   * session/config mismatch and must not silently route to a different backend.
   */
  getAgent(channel?: string, baseagent?: string, selfAID?: string): AgentRunnerFull {
    if (selfAID && baseagent) {
      const key = `${selfAID}::${baseagent}`;
      if (this.agentMap.has(key)) return this.agentMap.get(key)!;
    }
    if (channel && baseagent) {
      const owner = this.agentRegistry?.resolveByChannel(channel);
      const evolName = owner?.name || '<unknown>';
      const key = `${evolName}::${baseagent}`;
      if (this.agentMap.has(key)) return this.agentMap.get(key)!;
      const singleRunnerKey = `<unknown>::${baseagent}`;
      if (this.agentMap.has(singleRunnerKey)) return this.agentMap.get(singleRunnerKey)!;
      if (owner) {
        throw new BaseagentRunnerUnavailableError(evolName, baseagent, this.getAvailableBaseagentsForOwner(evolName));
      }
    }
    if (this.agentMap.has(this.primaryRunnerKey)) return this.agentMap.get(this.primaryRunnerKey)!;
    return this.agentMap.values().next().value!;
  }

  private getAvailableBaseagentsForOwner(evolName: string): string[] {
    const prefix = `${evolName}::`;
    return [...this.agentMap.keys()]
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length));
  }

  private async sendBaseagentMismatch(
    channelKey: string,
    channelId: string,
    session: Session,
    error: BaseagentRunnerUnavailableError,
    replyContext?: ReplyContext,
  ): Promise<void> {
    const channelInfo = this.resolveChannelInfo(channelKey);
    if (!channelInfo) return;
    const available = error.availableBaseagents.length ? error.availableBaseagents.join(', ') : '(none)';
    const text = `❌ 当前会话绑定的 baseagent 不可用: ${error.baseagent}\nAgent: ${error.evolagentName}\n可用: ${available}\n请使用 /baseagent 切换到可用后端。`;
    await channelInfo.adapter.send(buildEnvelope({
      taskId: `system-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      sessionId: session.id,
      channel: channelKey,
      channelId,
      agentName: error.evolagentName,
      chatmode: this.resolveEffectiveChatmodeForSession(session, channelKey, channelId),
      replyContext,
    }), { kind: 'system.error', text, subtype: 'baseagent_unavailable', recoverable: true });
  }

  private resolveEffectiveChatmodeForSession(
    session: Session,
    channelKey: string,
    channelId: string,
  ): 'interactive' | 'proactive' {
    const peerType = (session.metadata as any)?.peerType;
    try {
      const self = session.selfAID || this.agentRegistry?.resolveByChannel(channelKey)?.aid;
      const channelType = session.channelType || channelKey.split('#')[0] || channelKey;
      const peerKeyId = session.chatType === 'group'
        ? (session.metadata?.groupId || channelId)
        : (session.metadata?.peerId || channelId);
      const peerKey = channelType && peerKeyId ? formatPeerKey(channelType, peerKeyId) : undefined;
      const configured = resolveEffective({
        self: self || undefined,
        peerKey,
        role: session.identity?.role,
      }, { cache: true }).chatmode;
      return resolveChatModeForPeer({ chatType: session.chatType, peerType, configured });
    } catch {
      return resolveChatModeForPeer({ chatType: session.chatType, peerType });
    }
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
    private commandHandler?: CtlCommandHandler,
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

    // 初始化响应模式协调器，注册内置模式（interactive/proactive）
    const registry = new ResponseModeRegistry();
    registerBuiltinModes(registry);
    this.responseCoordinator = new ResponseModeCoordinator(registry);
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

  getTaskRuntimeContext(sessionId: string): TaskRuntimeContext | null {
    return this.activeTaskRuntimeContexts.get(sessionId) ?? null;
  }

  private agentRegistry?: EvolAgentRegistryHandle;

  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  /** 更新 EvolAgent.lastActivity —— 每次发出 status.* 事件（含 progress）时调用 */
  private touchAgentActivity(channelKey: string): void {
    const owning = this.agentRegistry?.resolveByChannel(channelKey);
    if (owning) owning.lastActivity = Date.now();
  }

  private inferPrimaryBaseagent(): string | undefined {
    const idx = this.primaryRunnerKey.lastIndexOf('::');
    return idx >= 0 ? this.primaryRunnerKey.slice(idx + 2) : this.primaryRunnerKey || undefined;
  }

  private ensureSessionBaseagent(session: Session, fallback?: string): void {
    const legacyAgentId = typeof (session as any).agentId === 'string' ? (session as any).agentId : undefined;
    if (!(session as any).baseagent) {
      (session as any).baseagent = fallback || legacyAgentId || this.inferPrimaryBaseagent();
    }
  }

  private inferDirectSessionIdentity(
    message: Message,
    owningAgent?: EvolAgentHandle | null,
  ): { role: string; mode: 'interactive' } | undefined {
    const actorId = message.peerId || message.channelId;
    if (!actorId) return undefined;
    const channel = message.channel;
    const parts = channel.split('#');
    const parsedType = parts.length >= 3 ? parts[0] : undefined;
    const parsedSelfAid = parts.length >= 3 ? parts[1] : undefined;
    const selfAid = message.selfAID || owningAgent?.aid || parsedSelfAid;
    const channelType = message.channelType || parsedType || channel;
    const chatType = message.chatType || 'private';
    if (selfAid) {
      const detail = resolvePeerRoleDetail({
        selfAid,
        channelType,
        chatType,
        actorId,
        conversationId: chatType === 'group' ? message.channelId : actorId,
        peerType: message.peerType,
      });
      return roleToSessionIdentity(detail.effectiveRole);
    }
    if (!this.agentRegistry) return undefined;
    const registryRoles = this.agentRegistry as EvolAgentRegistryHandle & RoleAwareHandle;
    const agentRoles = owningAgent as (EvolAgentHandle & RoleAwareHandle) | null | undefined;
    if (registryRoles.isOwner?.(channel, actorId) || agentRoles?.isOwner?.(channel, actorId)) {
      return { role: 'owner', mode: 'interactive' };
    }
    if (registryRoles.isAdmin?.(channel, actorId) || agentRoles?.isAdmin?.(channel, actorId)) {
      return { role: 'admin', mode: 'interactive' };
    }
    return undefined;
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
      logger.info(`[ResponseEngine] consumed ${hints.length} owner-hint(s) for ${peerChannelId} thread=${session.threadId || 'main'}`);
      return hintsToSubMessages(hints);
    } catch (e) {
      logger.warn(`[ResponseEngine] consumeOwnerHints failed: ${e instanceof Error ? e.message : String(e)}`);
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
   * 注销渠道适配器（热重载断开渠道时调用，避免遗留死实例）。
   * channelTypeMap 若指向被删实例，重定向到同类型的另一存活实例（无则删除映射）。
   */
  unregisterChannel(channelName: string): void {
    const info = this.channels.get(channelName);
    this.channels.delete(channelName);
    const type = info?.options?.channelType || channelName;
    if (this.channelTypeMap.get(type) === channelName) {
      this.channelTypeMap.delete(type);
      // 重定向到同类型的另一存活实例（保持按类型名路由可用）
      for (const [name, ci] of this.channels) {
        if ((ci.options?.channelType || name) === type) {
          this.channelTypeMap.set(type, name);
          break;
        }
      }
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

  private async retryAfterContextRecovery(
    prompt: string,
    opts: ContextRecoveryOptions,
  ): Promise<StreamRunResult> {
    const {
      streamKey,
      renderer,
      agent,
      session,
      absoluteProjectPath,
      effectiveSystemPrompt,
      modelOverride,
      runtimeEnv,
      resetTimer,
      shouldSuppress,
      proactive,
    } = opts;

    if (!session.agentSessionId || !canCompactAgent(agent)) {
      throw new Error('CONTEXT_COMPACT_FAILED');
    }

    renderer.addNotice('上下文过长，正在压缩会话...', 'warn', 'compact-trigger', true);
    await renderer.flush();

    const compacted = await agent.compact(session.id, session.agentSessionId, absoluteProjectPath);
    if (compacted) {
      renderer.addNotice('✅ 压缩完成，继续处理...', 'info', 'compact-retry', true);
      const retryStream = await agent.runQuery(
        session.id,
        prompt,
        absoluteProjectPath,
        session.agentSessionId,
        undefined,
        effectiveSystemPrompt,
        this.sessionManager,
        modelOverride,
        runtimeEnv
      );
      agent.registerStream(streamKey, retryStream);
      return await this.processEventStream(
        retryStream,
        session,
        agent,
        renderer,
        resetTimer,
        shouldSuppress,
        proactive,
        undefined  // 重试分支不调插件钩子
      );
    }

    renderer.addNotice('⚠️ 压缩失败，尝试清空会话历史后重试...', 'warn', 'compact-failed-clear', true);
    await renderer.flush();

    if (!canClearAgent(agent)) {
      throw new Error('CONTEXT_COMPACT_FAILED');
    }

    const previousAgentSessionId = session.agentSessionId;
    let cleared = false;
    try {
      cleared = await agent.clearSession(session.id, previousAgentSessionId, absoluteProjectPath);
    } catch (error) {
      logger.warn(`[ResponseEngine] clearSession failed after compact failure: ${error}`);
    }

    if (!cleared) {
      throw new Error('CONTEXT_COMPACT_FAILED');
    }

    session.agentSessionId = undefined;
    await this.sessionManager.updateSession(session.id, { agentSessionId: null });
    renderer.addNotice('✅ 会话已清空，继续处理...', 'info', 'clear-retry', true);

    const retryStream = await agent.runQuery(
      session.id,
      '会话历史已清空，请继续之前未完成的任务。',
      absoluteProjectPath,
      undefined,
      undefined,
      effectiveSystemPrompt,
      this.sessionManager,
      modelOverride,
      runtimeEnv
    );
    agent.registerStream(streamKey, retryStream);
    return await this.processEventStream(
      retryStream,
      session,
      agent,
      renderer,
      resetTimer,
      shouldSuppress,
      proactive,
      undefined  // 重试分支不调插件钩子
    );
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

  private messageChannelKey(message: Message, session: Session): string {
    return message.channel === 'daemon'
      ? message.channel
      : (session.metadata?.channelKey || message.channel);
  }

  private isTrustedDaemonTrigger(message: Message): boolean {
    return message.channel === 'daemon'
      && message.source === 'trigger'
      && !!message.triggerMeta?.triggerId;
  }

  // 命令前缀列表（与 CommandHandler.quickCommandPrefixes 保持同步）
  private static readonly COMMAND_PREFIXES = [
    '/new', '/pwd', '/help', '/status', '/restart',
    '/model', '/effort', '/agent', '/slist', '/session', '/rename', '/repair', '/fork',
    '/stop', '/clear', '/compact', '/del', '/perm', '/file', '/check',
    '/s ', '/name ', '/rewind', '/rw', '/rw ', '/activity', '/chatmode',
    '/aid', '/upgrade', '/evolagent',
  ];

  /** 判断消息内容是否为已知命令 */
  private isKnownCommand(content: string): boolean {
    return content === '/s' ||
      ResponseEngine.COMMAND_PREFIXES.some(cmd => content.startsWith(cmd));
  }

  /**
   * 处理消息（主入口）
   */
  async processMessage(message: Message): Promise<void> {
    const idleMs = (this.globalSettings.idleMonitor?.timeout ?? 120) * 1000;

    // 先解析会话，再优先用 session.metadata.channelKey 精确定位实例级 adapter
    // message.channel 现在存实例名（channelName），可直接用于精确路由
    const { session, absoluteProjectPath } = await this.resolveSession(message);
    if (this.isTrustedDaemonTrigger(message)) {
      session.identity = { role: 'owner', mode: 'interactive' };
    }

    const accessChannelKey = this.messageChannelKey(message, session);
    const accessChannelInfo = this.resolveChannelInfo(accessChannelKey);
    const accessAdapter = accessChannelInfo?.adapter as unknown as { _selfAid?: () => string | undefined } | undefined;
    const accessAdapterSelfAid = typeof accessAdapter?._selfAid === 'function' ? accessAdapter._selfAid() : undefined;
    const selfAidForAccess = accessAdapterSelfAid || message.selfAID || session.selfAID || undefined;

    // ── 角色访问控制检查：读取该用户角色的 allowAccess 配置，false 则拦截并回复权限不足 ──
    const userRole = session.identity?.role || 'none';
    if (!checkRoleAccess(userRole, selfAidForAccess)) {
      logger.warn(`[ResponseEngine] Access denied: role=${userRole} peerKey=${message.channelId} session=${session.id}`);
      const channelKey = session.metadata?.channelKey || message.channel;
      const channelInfo = this.resolveChannelInfo(channelKey);
      if (channelInfo) {
        try {
          await channelInfo.adapter.send(
            {
              taskId: `access-denied-${Date.now()}`,
              sessionId: session.id,
              channel: channelKey,
              channelId: message.channelId,
              agentName: 'evolclaw',
              chatmode: 'interactive',
              replyContext: message.replyContext,
              timestamp: Date.now(),
            },
            {
              kind: 'system.error',
              text: '暂无权限访问本 agent，请联系 agent 管理员授权访问',
              subtype: 'access_denied',
              recoverable: false,
            }
          );
        } catch (err) {
          logger.error(`[ResponseEngine] Failed to send access-denied message:`, err);
        }
      }
      return;
    }

    // thread(feishu) pending strategy: inject replyContext so first reply creates the thread
    if (message.triggerMeta?.pendingThread && message.triggerMeta?.rootMessageId) {
      message.replyContext = {
        ...(message.replyContext ?? {}),
        replyToMessageId: message.triggerMeta.rootMessageId,
        replyInThread: true,
      };
    }

    const channelKey = this.messageChannelKey(message, session);
    const channelInfo = this.resolveChannelInfo(channelKey);

    if (!channelInfo) {
      logger.error(`[ResponseEngine] Unknown channel: ${channelKey}`);
      return;
    }

    const { policy } = channelInfo;
    const streamKey = session.id;
    const chatType = message.chatType || 'private';
    const identityRole = session.identity?.role || 'none';
    const monitorEnabled = this.globalSettings.idleMonitor?.enabled !== false;
    // 按 session.baseagent 选择 agent 后端（idle-kill 路径需要 interrupt）
    let agent: AgentRunnerFull;
    try {
      agent = this.getAgent(channelKey, session.baseagent, session.selfAID || message.selfAID);
    } catch (error) {
      if (error instanceof BaseagentRunnerUnavailableError) {
        logger.error(`[ResponseEngine] baseagent mismatch blocked: session=${session.id} channel=${channelKey} requested=${session.baseagent} owner=${error.evolagentName} available=${error.availableBaseagents.join(',') || '<none>'}`);
        await this.sendBaseagentMismatch(channelKey, message.channelId, session, error, message.replyContext);
        return;
      }
      throw error;
    }

    // 计算是否抑制中间输出（工具活动 + 流式文本）。具体三态在 chatMode/effective config
    // 解析完成后赋值；闭包让后续事件处理路径保持兼容。
    const outputState: { middleOutputMode: ShowActivitiesMode } = { middleOutputMode: 'all' };
    const shouldSuppress = (): boolean => {
      return outputState.middleOutputMode === 'none';
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
            logger.warn(`[ResponseEngine] Idle monitor: kill after ${result.idleSec}s idle, stream: ${streamKey}`);
            this.eventBus.publish({ type: 'runner:idle-timeout', sessionId: streamKey, idleSec: result.idleSec });
            logger.info(`[ResponseEngine] agent.interrupt invoked (idle-kill) stream=${streamKey}`);
            agent.interrupt(streamKey).catch(e => {
              logger.debug(`[ResponseEngine] Interrupt failed (may already be cleaned up):`, e);
            });
            rejectFn(new Error('SDK_TIMEOUT'));
            return;
          } else {
            // notify or warn: publish event, task continues
            logger.info(`[ResponseEngine] Idle monitor: ${result.action} after ${result.idleSec}s idle, stream: ${streamKey}`);
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
        this._processMessageInternal(message, session, absoluteProjectPath, resetTimer, shouldSuppress, () => lastIdleSec, outputState),
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
            logger.info(`[ResponseEngine] Context too long error, skipping error accumulation`);
          // 认证错误（401 / Invalid API Key）不是会话问题，不累计
          } else if (errorType === ErrorType.AUTH_ERROR) {
            logger.info(`[ResponseEngine] Auth error (invalid API key), skipping error accumulation`);
          // API 临时错误如果走过重试链路，已按每次失败计数；不要在最终 catch 再重复加 1。
          } else if (errorType === ErrorType.API_ERROR && wasRetryHealthRecorded(error)) {
            logger.info(`[ResponseEngine] API retry health already recorded, skipping duplicate accumulation`);
          } else if (!policy.accumulateErrors(chatType, identityRole)) {
            logger.info(`[ResponseEngine] Non-accumulating error (chatType=${chatType}, identity=${identityRole}), skipping error accumulation`);
          } else {
            const prefixed = prefixErrorType(ERROR_PREFIX.INFRA, errorType);
            await this.sessionManager.recordError(session.id, prefixed, error.message);
          }
        } catch (statusError) {
          logger.error('[ResponseEngine] Failed to update health status:', statusError);
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
  private async _processMessageInternal(message: Message, session: Session, absoluteProjectPath: string, resetTimer: (eventType?: string, toolName?: string) => void, shouldSuppress: () => boolean, getLastIdleSec?: () => number, outputState: { middleOutputMode: ShowActivitiesMode } = { middleOutputMode: 'all' }): Promise<void> {
    const messageId = `${message.channel}_${message.channelId}_${message.timestamp || Date.now()}`;
    const channelKey = this.messageChannelKey(message, session);
    const channelInfo = this.resolveChannelInfo(channelKey);
    // Per-method agent name for stats bucketing (agent.name or '<unknown>')
    const agentNameForStats = this.agentRegistry?.resolveByChannel(channelKey)?.name ?? '<unknown>';

    if (!channelInfo) {
      logger.error(`[ResponseEngine] Unknown channel: ${channelKey}`);
      return;
    }

    // 二次拦截：如果命令消息绕过 MessageBridge 的 handleCommand 泄漏到这里，
    // 静默丢弃而不是发送给 Agent（命令已在 MessageBridge 层处理过）
    const rawContent = message.content.replace(/^(>[^\n]*\n)+\n?/, '').trim();
    if (rawContent.startsWith('/') && this.isKnownCommand(rawContent)) {
      logger.warn(`[ResponseEngine] Command leaked past MessageBridge, dropped: "${rawContent.substring(0, 40)}"`);
      return;
    }

    const { adapter, options, policy } = channelInfo;
    const chatType = message.chatType || 'private';
    const identityRole = session.identity?.role || 'none';
    let agent: AgentRunnerFull;
    try {
      agent = this.getAgent(channelKey, session.baseagent, session.selfAID || message.selfAID);
    } catch (error) {
      if (error instanceof BaseagentRunnerUnavailableError) {
        logger.error(`[ResponseEngine] baseagent mismatch blocked: session=${session.id} channel=${channelKey} requested=${session.baseagent} owner=${error.evolagentName} available=${error.availableBaseagents.join(',') || '<none>'}`);
        await this.sendBaseagentMismatch(channelKey, message.channelId, session, error, message.replyContext);
        return;
      }
      throw error;
    }
    const streamKey = session.id;

    // 密文优先归一化：合并批次的 replyContext.metadata.encrypted 默认取自最后一条，
    // 这里改用 message.encrypted（mergeItems 算出的密文优先值）覆盖，使本轮所有出站路径
    // （IMRenderer.send / taskReplyContext / setSessionEncrypt / task:started）看到一致的加密态。
    // 仅 aun 入站会设 message.encrypted；非 aun 渠道为 undefined，不覆盖、保持原状。
    if (message.encrypted != null) {
      if (!message.replyContext) message.replyContext = {};
      message.replyContext.metadata = { ...(message.replyContext.metadata ?? {}), encrypted: message.encrypted };
    }

    // 为本次任务处理生成唯一 task_id（客户端生成，格式 task-{10hex}）
    const taskId = `task-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const triggerRunId = message.triggerMeta?.runId;
    const withTaskMetadata = (metadata?: Record<string, any>): Record<string, any> => ({
      ...(metadata ?? {}),
      taskId,
      chatmode,
      ...(triggerRunId ? { triggerRunId } : {}),
    });

    // ─── 解析 self/peer/config（响应模式解析的输入）───
    const currentChannelType = options?.channelType || message.channel;
    const adapterAny = channelInfo.adapter as unknown as {
      _selfAid?: () => string | undefined;
      _selfName?: () => string | undefined;
    };
    const adapterSelfAid = typeof adapterAny._selfAid === 'function' ? adapterAny._selfAid() : undefined;
    const selfAid = adapterSelfAid || message.selfAID || session.selfAID || undefined;
    const selfName = typeof adapterAny._selfName === 'function' ? adapterAny._selfName() : undefined;
    const peerName = message.peerName || session.metadata?.peerName;
    const peerIdRaw = message.peerId;
    const peerKeyId = session.chatType === 'group'
      ? (session.metadata?.groupId || message.channelId)
      : peerIdRaw;
    const peerKey = (currentChannelType && peerKeyId)
      ? formatPeerKey(currentChannelType, peerKeyId)
      : undefined;
    const peerRole = session.identity?.role || 'none';
    const effectiveAgentConfig = (() => {
      try {
        return resolveEffective({ self: selfAid || undefined, peerKey, role: peerRole }, { cache: true });
      } catch (e) {
        logger.warn(`[ResponseEngine] resolveEffective failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    })();

    // ─── 响应模式解析（插件化机制中枢）───
    // trigger override 绝对优先；否则由 Coordinator 解析（response_modes > chatmode 配置兜底）。
    const peerType = message.peerType ?? (session.metadata as any)?.peerType;
    const systemOrServicePeer = isSystemOrServicePeer(peerType);
    const triggerChatModeOverride = systemOrServicePeer ? undefined : message.triggerMeta?.chatModeOverride;
    const chatModeFallback = resolveChatModeForPeer({
      chatType,
      peerType,
      configured: effectiveAgentConfig?.chatmode,
    });
    const resolvedMode = triggerChatModeOverride || systemOrServicePeer
      ? null  // trigger 强制覆盖或 system/service 强制 interactive 时，不走插件解析
      : this.responseCoordinator.resolveMode(
          chatType as 'private' | 'group',
          peerKey,
          effectiveAgentConfig?.response_modes,
          chatModeFallback,
          {
            session,
            agentConfig: effectiveAgentConfig as any,
            runner: undefined as any,  // 处理钩子用不到 runner；辅助会话工厂 Phase 后续接入
            channel: {
              type: currentChannelType,
              capabilities: {
                supportsThought: !!channelInfo.adapter.capabilities?.thought,
                supportsInteraction: !!channelInfo.adapter.capabilities?.interaction,
                supportsRichText: !!channelInfo.adapter.capabilities?.markdown,
                supportsFile: !!channelInfo.adapter.capabilities?.file,
                supportsImage: !!channelInfo.adapter.capabilities?.image,
              },
              send: async () => {},  // 引擎自行发送，插件 handleOutbound 只做决策
            },
            logger,
            agentDir: resolvePaths().agentsDir,
          },
        );

    if (resolvedMode) {
      logger.info('[ResponseSystem] selected mode=' + resolvedMode.mode.id + ' source=' + resolvedMode.source + ' chatType=' + chatType + ' peerKey=' + (peerKey ?? 'none') + ' fallback=' + chatModeFallback);
    } else {
      logger.info('[ResponseSystem] selected mode=override/fallback source=trigger-or-resolve-failed chatType=' + chatType + ' peerKey=' + (peerKey ?? 'none') + ' fallback=' + chatModeFallback);
    }

    // 最终 chatMode：system/service 运行时约束 > trigger override > 插件解析结果 > fallback
    const effectiveChatMode = systemOrServicePeer
      ? 'interactive'
      : triggerChatModeOverride
      ?? resolvedMode?.mode.id
      ?? chatModeFallback;
    const chatmode = effectiveChatMode;
    const isProactive = effectiveChatMode === 'proactive';
    const legacyMiddleOutputMode = (): ShowActivitiesMode => {
      const mode = policy.middleOutputMode?.(chatType, identityRole, peerType);
      if (isShowActivitiesMode(mode)) return mode;
      return policy.showMiddleResult(chatType, identityRole) ? 'all' : 'none';
    };
    const configuredMiddleOutputMode = isShowActivitiesMode(message.triggerMeta?.showActivitiesOverride)
      ? message.triggerMeta.showActivitiesOverride
      : isShowActivitiesMode(effectiveAgentConfig?.show_activities)
        ? effectiveAgentConfig.show_activities
        : legacyMiddleOutputMode();
    const middleOutputMode: ShowActivitiesMode = isProactive
      ? 'all'
      : systemOrServicePeer
        ? 'none'
        : configuredMiddleOutputMode;
    outputState.middleOutputMode = middleOutputMode;
    this.shouldSuppressActivities = shouldSuppress();

    // 诊断日志：记录 inbound message_id 和生成的 task_id 的对应关系
    logger.info(`[ResponseEngine] Task created: inboundMsgId=${message.messageId ?? 'none'} taskId=${taskId} sessionId=${session.id} chatmode=${chatmode} mode=${resolvedMode?.mode.id ?? 'override/fallback'}`);

    // 构建带 taskId/chatmode 的 ReplyContext（本次任务所有出站消息共用）
    const taskReplyContext = (): ReplyContext => {
      const base = this.getReplyContext(message);
      return {
        ...(base ?? {}),
        metadata: withTaskMetadata(base?.metadata),
      };
    };

    // ─── 响应模式运行时状态（迁移点1：beforeProcess 构造 ProactiveRuntimeState）───
    // 插件的 beforeProcess 把状态写入 modeState（per-message Map）；引擎从中读出 proactive。
    const modeState = new Map<string, any>();
    const modeProcessCtx: ProcessContext | null = resolvedMode ? {
      session,
      message: {
        messageId: message.messageId, peerId: message.peerId, content: message.content,
        peerType: message.peerType || (session.metadata as any)?.peerType,
        chatType: chatType as 'private' | 'group', isMentioned: message.isMentioned,
        mentionAids: message.mentionAids, source: message.source,
      },
      modeConfig: (resolvedMode.context as any).modeConfig,
      state: modeState,
      isSendCommand: (toolName, toolInput) => isEvolclawSendCommandForSession(toolName, toolInput, session.channelId),
      logger,
    } : null;
    if (resolvedMode?.mode.beforeProcess && modeProcessCtx) {
      await resolvedMode.mode.beforeProcess(modeProcessCtx);
    }
    // 从插件状态读出 proactive 运行时状态（替代原硬编码构造）
    const proactive: ProactiveRuntimeState | null = (modeState.get('proactive') as ProactiveRuntimeState | undefined) ?? null;

    // [迁移探针] 记录 chatMode 判定 + proactiveState 构造（防线 1：行为快照）
    snapshot.begin(session.id, taskId, 'plugin', message.messageId);
    snapshot.set(session.id, taskId, {
      chatMode: effectiveChatMode,
      proactiveState: proactive
        ? {
          preTool1stMsgChk: proactive.preTool1stMsgChk,
          toolUseReminder: proactive.toolUseReminder,
          firstSendRequired: proactive.firstSendRequired,
          toolReportRequired: proactive.toolReportRequired,
          chatType: proactive.chatType,
          peerType: proactive.peerType,
        }
        : null,
    });

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
        const budgetAgentAid = selfAid || session.selfAID || message.selfAID || '';
        const budgetPeerKey = peerKey || formatPeerKey(currentChannelType, message.channelId);
        const budgetStatus = getBudgetStatus(resolveRoot(), budgetAgentAid, budgetPeerKey);
        if (budgetStatus.hard_blocked) {
          logger.warn(`[ResponseEngine] Budget hard limit reached: agent=${budgetAgentAid} peer=${budgetPeerKey} pct=${budgetStatus.pct_used.toFixed(1)}%`);
          this.touchAgentActivity(channelKey);
          adapter.send(envelope, { kind: 'status.completed', metadata: { durationMs: 0 } }).catch(() => {});
          return;
        }
        const roleBudgetStatus = getRoleBudgetStatus(resolveRoot(), {
          selfAid: budgetAgentAid,
          role: peerRole,
          channelType: currentChannelType,
          chatType,
          channelId: message.channelId,
          peerId: message.peerId || undefined,
        });
        if (roleBudgetStatus.hard_blocked) {
          const digits = roleBudgetStatus.currency === 'USD' ? 4 : 2;
          const usageText = roleBudgetStatus.limit_amount >= 0
            ? `${roleBudgetStatus.currency} ${roleBudgetStatus.used_amount.toFixed(digits)}/${roleBudgetStatus.limit_amount.toFixed(digits)}`
            : '';
          logger.warn(`[ResponseEngine] Role budget hard limit reached: agent=${budgetAgentAid} role=${peerRole} subject=${roleBudgetStatus.usage_subject_key} usage=${usageText}`);
          this.touchAgentActivity(channelKey);
          adapter.send(envelope, {
            kind: 'system.error',
            text: `Role usage limit reached (${peerRole}${usageText ? `: ${usageText}` : ''}).`,
            subtype: 'role_budget_exceeded',
            recoverable: false,
            metadata: { roleBudget: roleBudgetStatus },
          } as any).catch(() => {});
          adapter.send(envelope, { kind: 'status.completed', metadata: { durationMs: 0, roleBudget: roleBudgetStatus } as any }).catch(() => {});
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
      logger.info(`[ResponseEngine] session=${session.id} task=${taskId} peer=${peerLabel} chatType=${session.chatType} chatMode=${effectiveChatMode} baseagent=${session.baseagent} msgChatType=${message.chatType ?? 'n/a'}`);

      // 记录开始处理
      const taskEncrypt = message.replyContext?.metadata?.encrypted != null ? !!(message.replyContext.metadata.encrypted) : undefined;
      this.eventBus.publish({ type: 'task:started', sessionId: session.id, agentName: agentNameForStats, encrypt: taskEncrypt, chatmode });
      this.touchAgentActivity(channelKey);
      adapter.send(envelope, { kind: 'status.started' }).catch(() => {});

      await this.runPendingAutoCompactAtTaskStart(session, agent, absoluteProjectPath, adapter, envelope, false);

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
        suppressActivityItems: isProactive ? false : middleOutputMode !== 'all',
        suppressIntermediateText: isProactive ? false : middleOutputMode === 'none',
        fileMarkerPattern: options?.fileMarkerPattern,
        diagEnabled: this.globalSettings.debug?.flusherDiag,
        send: async (payload) => {
          // proactive 模式：activity.batch 是 thought 协议内容，只发给支持 thought 的 channel
          // （不支持 thought 的 channel 静默丢弃，避免降级为普通消息）
          if (isProactive && payload.kind === 'activity.batch' && !adapter.capabilities?.thought) {
            snapshot.pushOutbound(session.id, taskId, { kind: payload.kind, decision: 'suppressed-thought' });
            return;
          }
          const isCurrentlyBackground = this.isBackgroundSession(session, message.channel, message.channelId);
          if (isCurrentlyBackground) {
            snapshot.pushOutbound(session.id, taskId, { kind: payload.kind, decision: 'suppressed-bg' });
            return;
          }

          const opts: ReplyContext = {};
          const baseReplyCtx = this.getReplyContext(message);
          if (baseReplyCtx) {
            Object.assign(opts, baseReplyCtx);
          // Trigger messageId is the internal runId, not an external channel
          // message id. Do not use it as replyToMessageId.
          } else if (firstReply && message.messageId && message.source !== 'trigger') {
            if (payload.kind === 'result.text' && payload.text) {
              opts.replyToMessageId = message.messageId;
              firstReply = false;
            }
          }
          if (payload.kind === 'result.text' && payload.isFinal) {
            opts.title = '\u2705 \u6700\u7ec8\u56de\u590d:';
          }
          opts.metadata = withTaskMetadata(opts.metadata);

          if (payload.kind.startsWith('status.')) this.touchAgentActivity(channelKey);
          const enrichedEnvelope: OutboundEnvelope = { ...envelope, replyContext: opts };
          snapshot.pushOutbound(session.id, taskId, { kind: payload.kind, decision: 'sent' });
          await adapter.send(enrichedEnvelope, payload);
        },
      });

      this.currentRenderer = renderer;

      renderer.addLifecycle('started');

      if (isProactive) {
        logger.info(`[ResponseEngine] proactive mode: outputs via thought.put task=${taskId}`);
      }

      // 调用 AgentRunner（含上下文过长自动 compact 重试）

      // 捕获当前消息的上下文（闭包），避免后续消息处理时串台
      const capturedChannelId = message.channelId;
      const capturedReplyContext = taskReplyContext();

      // 设置权限审批的消息发送回调（指向当前渠道）
      agent.setSendPrompt(async (text: string) => {
        await adapter.send({ ...envelope, replyContext: capturedReplyContext }, { kind: 'result.text', text, isFinal: true });
      });

      const authChatType = chatType === 'group' ? 'group' : 'private';
      const authConversationId = authChatType === 'group'
        ? (session.metadata?.groupId || session.channelId || capturedChannelId)
        : (message.peerId || session.metadata?.peerId || capturedChannelId);
      const authPeerKey = session.channelType && authConversationId
        ? formatPeerKey(session.channelType, authConversationId)
        : undefined;

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
        role: identityRole,
        chatType: authChatType,
        selfAid: session.selfAID || message.selfAID,
        peerKey: authPeerKey,
        flushPending: async () => {
          await renderer.flush(false);
        },
        interceptNextMessage: this.messageQueue
          ? (sessionKey, handler) => this.messageQueue!.interceptNext(sessionKey, handler)
          : undefined,
        cancelIntercept: this.messageQueue
          ? (sessionKey) => this.messageQueue!.cancelIntercept(sessionKey)
          : undefined,
        // [迁移点2] policyHook 由 ProactiveMode.configureRun 提供（插件决策）；
        // 引擎补充副作用：违规时注入提醒到模型上下文 + 行为探针。
        policyHook: (() => {
          const runConfig = resolvedMode?.mode.configureRun && modeProcessCtx
            ? resolvedMode.mode.configureRun(modeProcessCtx)
            : undefined;
          const pluginHook = runConfig?.policyHook;
          if (!pluginHook) return undefined;
          return (toolName: string, toolInput: any) => {
            const stBefore = modeState.get('proactive');
            const wasFirstPending = stBefore && !stBefore.firstToolDone;
            const result = pluginHook(toolName, toolInput);

            if (result?.block) {
              // 拦截事件（首工具非表态 / 工具进展汇报未完成）
              snapshot.set(session.id, taskId, { policyHook: { triggered: true, blocked: true, toolName } });
              const errorMsg = `⚠️ proactive 模式违规：${result.reason ?? '请先发送必要说明'}。请重新执行正确的命令。`;
              agent.injectUserMessage?.(session.id, errorMsg);
              return result;
            }

            // 首工具检查通过（firstToolDone 从 false 翻成 true 且未拦截）
            const stAfter = modeState.get('proactive');
            if (wasFirstPending && stAfter?.firstToolDone) {
              snapshot.set(session.id, taskId, { policyHook: { triggered: true, blocked: false, toolName } });
            }

            return undefined;
          };
        })(),
      });

      // per-session 权限模式在 try 内、peerKey 解析后设置（见 resolvePermissionMode 调用）

      // 标记会话为处理中（实时持久化，重启后可恢复）
      this.sessionManager.markProcessing(session.id, taskId);
      if (message.replyContext?.metadata?.encrypted != null) {
        this.sessionManager.setSessionEncrypt(session.id, !!(message.replyContext.metadata.encrypted));
      }
      logger.info(`[ResponseEngine] session ${session.id} marked as processing task=${taskId}`);

      // 检查是否因新消息自动中断 — 包装 prompt 让 Agent 知道上下文
      const prevInterruptReason = this.interruptedSessions.get(session.id);
      this.interruptedSessions.delete(session.id);
      const wasInterrupted = prevInterruptReason === 'new_message' && !!session.agentSessionId;
      const wrapPrompt = (body: string) => wasInterrupted
        ? `【新消息插入】\n\n${body}\n\n【请根据前后消息酌情处理】`
        : body;
      // 先用裸文本兜底；vars 构造完成后用消息渲染层重算（见下方 effectivePrompt 重赋值）。
      let effectivePrompt = wrapPrompt(message.content);

      let streamResult: StreamRunResult = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };
      let effectiveSystemPrompt: string | undefined;
      let modelOverride: { model?: string; effort?: string; permissionMode?: string } | undefined;
      let usedFallback = false;
      let skipEvolclawModel = false;
      let agentModel: string | undefined;
      let consumedHandoff: ConsumedHandoffContext | null = null;
      let handoffPromptRendered = false;
      let handoffConsumedRecorded = false;
      let handoffChatDir: string | undefined;
      let runtimeEnv: Record<string, string> | undefined;

      try {
        // 动态构建运行时上下文提示
        const contextParts: string[] = [];

        // 通道能力
        const supportsFileMarker = currentChannelType !== 'aun' && !isProactive && !!channelInfo.adapter.capabilities?.file;
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

        // 计算 peerKey：群聊固定按 groupId/channelId，私聊按发送者 peerId。
        // 这样单条和积压合并批次不会因队列状态不同而切换关系级配置。
        const normalizedBaseagent = normalizeBaseagent(agent.name);

        // 设置 per-call 权限模式：运行时按 关系 > 角色 > 出厂默认[role] 解析（不再读/写 session.metadata）
        // resolvePermissionMode 设计为不抛出（配置损坏返回兜底），但防御性 try-catch 确保有确定值。
        // 作为 per-call 入参随 modelOverride 传入 runQuery —— 与 model/effort 同构，
        // 不写 AgentRunner 实例字段，多对端/多会话并发共享同一 runner 实例时互不污染。
        let effectivePermissionMode: string;
        try {
          effectivePermissionMode = message.triggerMeta?.permissionModeOverride
            ?? resolvePermissionMode({ self: selfAid || undefined, peerKey, role: peerRole });
        } catch (e) {
          logger.warn(`[ResponseEngine] resolvePermissionMode failed, using fallback: ${e instanceof Error ? e.message : String(e)}`);
          effectivePermissionMode = message.triggerMeta?.permissionModeOverride ?? 'auto';
        }

        // 按 关系级 > agent级 > 全局 解析本次调用的模型/强度，作为 per-call 入参传入 runQuery。
        // 不缓存、不绑会话——改关系级/agent级后该范围所有会话的下条消息即时生效；
        // 多对端并发各自独立解析、各自传参，无共享状态可被污染。
        let effectiveModel: string | undefined;
        const triggerModelOverride = message.triggerMeta?.modelOverride;
        const triggerEffortOverride = message.triggerMeta?.effortOverride;

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
            const resolved = resolveEffectiveModel(
              { self: selfAid || undefined, peerKey, role: session.identity?.role || 'none' },
              normalizedBaseagent.canonical,
            );
            if (resolved.model || resolved.effort) {
              evolclawModelOverride = { model: resolved.model, effort: resolved.effort };
              effectiveModel = resolved.model;
            }
          } catch (e) {
            logger.warn(`[ResponseEngine] resolveEffectiveModel failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          modelOverride = evolclawModelOverride;
        }

        if (triggerModelOverride || triggerEffortOverride) {
          modelOverride = {
            ...(modelOverride || {}),
            ...(triggerModelOverride ? { model: triggerModelOverride } : {}),
            ...(triggerEffortOverride ? { effort: triggerEffortOverride } : {}),
          };
          if (triggerModelOverride) effectiveModel = triggerModelOverride;
        }

        // permissionMode 随完整 agent/relation 作用域或 trigger override 传入；单 runner
        // 嵌入/测试路径没有 self/peer 作用域时，避免制造无配置来源的 override。
        const shouldPassPermissionMode = !!message.triggerMeta?.permissionModeOverride || !!selfAid;
        if (shouldPassPermissionMode) {
          modelOverride = { ...(modelOverride || {}), permissionMode: effectivePermissionMode };
        }

        agentModel = (typeof (agent as any).getModel === 'function') ? (agent as any).getModel() as string : undefined;

        const groupVenueVars = session.chatType === 'group' && currentChannelType === 'aun'
          ? await syncGroupVenueContext({
              selfAid,
              groupId: session.metadata?.groupId || message.channelId,
              channel: currentChannelType || message.channel,
            })
          : {};

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
            peerRole,
            peerType: message.peerType || (session.metadata as any)?.peerType || undefined,
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
            // 优先 agent/relation behavior 配置，fallback 到服务器 dispatch_mode 缓存。
            dispatch: (effectiveAgentConfig?.dispatch ?? session.metadata?.dispatchMode ?? message.dispatchMode) || undefined,
            clientType: message.clientType || undefined,
            permissionMode: effectivePermissionMode,
            capabilities: capParts.length > 0 ? capParts.join('、') : undefined,
            fileCapable: supportsFileMarker,
            supportsFileMarker,
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
            proactivePreTool1stMsgChk: proactive?.preTool1stMsgChk ?? true,
            proactiveToolUseReminder: proactive?.toolUseReminder ?? true,
            proactiveFirstSendRequired: proactive?.firstSendRequired ?? false,
            proactiveToolReportRequired: proactive?.toolReportRequired ?? false,
            proactiveToolReportInterval: proactive?.toolReportInterval ?? 10,
            proactiveSendTargetLabel: chatType === 'group' ? '群里' : '对方',
            readonly: effectivePermissionMode === 'readonly',
            baseAgent: normalizedBaseagent.canonical,
            baseAgentName: normalizedBaseagent.displayName,
            baseAgentModel: agentModel || undefined,
            effectiveModel: effectiveModel || agentModel || undefined,
            modelFallbackActive: (fbState.fallbackActive || skipEvolclawModel) ? true : undefined,
            modelFallbackModel: (fbState.fallbackActive || skipEvolclawModel) ? (agentModel || undefined) : undefined,
            agentSessionId: session.agentSessionId || undefined,
            // 渲染模式：各类型当前激活的 modeName（从内存 config 读，渲染层据此选 manifest section）。
            renderModes: this.agentRegistry?.resolveByChannel(channelKey)?.config?.render ?? undefined,
            ...groupVenueVars,
          },
          sessionId: session.id,
        };

        // 按会话原型（sessionType）选 manifest 文件：config.sessionManifests 映射，缺省回退主 manifest。
        const sessionType = session.sessionType ?? 'main';
        const sessionManifests = this.agentRegistry?.resolveByChannel(channelKey)?.config?.sessionManifests as Record<string, string> | undefined;
        const manifestFile = sessionManifests?.[sessionType] ?? 'eck_manifest.json';
        const kitContext = renderKitSections(kitCtx, manifestFile);
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
          const rawPeerItems: SubMessage[] = message.items && message.items.length > 0
            ? message.items
            : [{
                peerId: message.peerId, peerName: peerName || undefined,
                peerType: message.peerType,
                peerRole: message.batchRole || session.identity?.role || 'none',
                sameDevice: message.sameDevice, sameNetwork: message.sameNetwork, sameEgressIp: message.sameEgressIp,
                encrypted: message.encrypted,
                content: message.content, timestamp: message.timestamp,
                images: message.images,
                mentionAids: message.mentionAids,
              }];
          const peerItems: SubMessage[] = (() => {
            if (currentChannelType !== 'aun' || chatType !== 'private') return rawPeerItems;
            const getChatDir = (this.sessionManager as unknown as { getChatDir?: (s: Session) => string }).getChatDir;
            if (typeof getChatDir !== 'function') return rawPeerItems;
            try {
              handoffChatDir = getChatDir.call(this.sessionManager, session);
            } catch (error) {
              logger.warn(`[ResponseEngine] handoff chat dir unavailable, skipping handoff match: ${error instanceof Error ? error.message : String(error)}`);
              return rawPeerItems;
            }
            const inboundRefMessageId = typeof message.replyContext?.metadata?.refMessageId === 'string'
              ? message.replyContext.metadata.refMessageId
              : null;
            const match = selectConsumableHandoff(handoffChatDir, {
              replyToMessageId: inboundRefMessageId,
              inboundMessageId: message.messageId,
              inboundTs: message.timestamp ?? Date.now(),
            });
            if (!match) return rawPeerItems;

            const consumedBy = message.messageId || `${message.channel}-${message.channelId}-${message.timestamp ?? Date.now()}`;
            const ctx = toConsumedHandoffContext(match, consumedBy);
            if (!ctx) return rawPeerItems;
            consumedHandoff = ctx;

            const combinedContent = rawPeerItems.map(item => item.content).filter(Boolean).join('\n\n') || message.content;
            const combinedImages = rawPeerItems.flatMap(item => item.images ?? []);
            const base = rawPeerItems[rawPeerItems.length - 1] ?? {};
            const originPeerId = ctx.origin.peerId;
            const replyCommand = formatEcMsgSendCommand(selfAid, originPeerId, '<反馈内容>', ctx.origin.threadId);
            const continueCommand = formatEcMsgSendCommand(selfAid, originPeerId, '<追问内容>', ctx.origin.threadId);
            return [{
              ...base,
              kind: 'handoff',
              content: combinedContent,
              images: combinedImages.length > 0 ? combinedImages : undefined,
              handoff: {
                kind: ctx.kind,
                origin: ctx.origin,
                previousContent: ctx.sourceMessage.content,
                previousMessageId: ctx.sourceMessage.msgId,
                replyCommand,
                continueCommand,
              },
            }];
          })();

          // 观察者插话（v0.3）：消费 (对端, thread) 的待用提示，包成 owner-hint item 排在对端消息前。
          // 一次性语义：consumeOwnerHints 读取并删除（见 pending-hints.ts）。在 try 外消费，
          // 这样即便 renderMessageBody 抛错走 raw 兜底，也把提示原文拼进去——绝不静默丢提示。
          const hintItems = this.consumeOwnerHints(session, message);
          const renderItems: SubMessage[] = hintItems.length > 0 ? [...hintItems, ...peerItems] : peerItems;
          const fallbackContent = (() => {
            if (!message.restartResume?.submitted || peerItems.length === 0) return message.content;
            const resumeIdx = peerItems.findIndex(item => item.kind === 'restart-resume');
            if (message.restartResume.pendingInterrupted && resumeIdx >= 0 && resumeIdx < peerItems.length - 1) {
              const resumeText = peerItems.slice(0, resumeIdx + 1).map(item => item.content).join('\n');
              const pendingText = peerItems.slice(resumeIdx + 1).map(item => item.content).join('\n');
              return `${resumeText}\n\n【新消息插入】\n\n${pendingText}\n\n【请根据前后消息酌情处理】`;
            }
            return peerItems.map(item => item.content).join('\n');
          })();

          try {
            if (message.restartResume?.pendingInterrupted) {
              const resumeIdx = renderItems.findIndex(item => item.kind === 'restart-resume');
              if (resumeIdx >= 0 && resumeIdx < renderItems.length - 1) {
                const resumeRender = renderMessageBody(renderItems.slice(0, resumeIdx + 1), kitCtx.vars, session.id);
                const pendingRender = renderMessageBody(renderItems.slice(resumeIdx + 1), kitCtx.vars, session.id);
                const body = [
                  resumeRender.body.trim(),
                  `【新消息插入】\n\n${pendingRender.body.trim()}\n\n【请根据前后消息酌情处理】`,
                ].filter(Boolean).join('\n\n');
                renderResult = {
                  body,
                  images: [...resumeRender.images, ...pendingRender.images],
                };
              } else {
                renderResult = renderMessageBody(renderItems, kitCtx.vars, session.id);
              }
            } else {
              renderResult = renderMessageBody(renderItems, kitCtx.vars, session.id);
            }
            if (renderResult.body.trim()) effectivePrompt = wrapPrompt(renderResult.body);
            else effectivePrompt = wrapPrompt(composeHintFallback(hintItems, fallbackContent));
            handoffPromptRendered = !!consumedHandoff && !!renderResult.body.trim();
          } catch (e) {
            logger.warn(`[ResponseEngine] renderMessageBody failed, using raw content: ${e instanceof Error ? e.message : String(e)}`);
            effectivePrompt = wrapPrompt(composeHintFallback(hintItems, fallbackContent));
          }
          if (consumedHandoff && !handoffPromptRendered) {
            consumedHandoff = null;
          }
        }

        // 空消息防护：在 agent 调用之前检查 prompt 是否为空
        // 防止空消息（或纯空格消息）浪费 API 调用
        if (!effectivePrompt.trim()) {
          logger.info(`[ResponseEngine] Skip agent call: empty prompt after render. session=${session.id} task=${taskId}`);
          return;
        }

        const taskRuntimeContext: TaskRuntimeContext = {
          taskId,
          sessionId: session.id,
          messageId: message.messageId,
          channel: currentChannelType,
          chatType,
          selfAid,
          peerId: peerIdRaw || undefined,
          peerName: peerName || undefined,
          peerType: message.peerType || (session.metadata as any)?.peerType || undefined,
          peerRole,
          threadId: session.threadId || undefined,
          consumedHandoff,
        };
        this.activeTaskRuntimeContexts.set(session.id, taskRuntimeContext);
        runtimeEnv = buildTaskRuntimeEnv(taskRuntimeContext);

        if (consumedHandoff && handoffPromptRendered && !handoffConsumedRecorded && handoffChatDir) {
          appendHandoffConsumedEvent(
            handoffChatDir,
            consumedHandoff,
            selfAid || session.selfAID || message.selfAID || 'self',
            message.peerId || message.channelId,
          );
          handoffConsumedRecorded = true;
        }

        // 可重试错误（403/429/5xx/模型繁忙）按明确退避序列重试。
        const RETRY_DELAYS_MS = [5_000, 10_000, 30_000];
        const MAX_RETRIES = RETRY_DELAYS_MS.length;
        let runAttempt = 1;
        let consecutiveRetryFailures = 0;
        const recordRetryHealthError = async (retryError: unknown) => {
          if (!policy.accumulateErrors(chatType, identityRole)) return;
          const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
          const retryErrorType = prefixErrorType(ERROR_PREFIX.INFRA, classifyError(retryError));
          try {
            await this.sessionManager.recordError(session.id, retryErrorType, retryErrorMessage);
            markRetryHealthRecorded(retryError);
          } catch (statusError) {
            logger.error('[ResponseEngine] Failed to record retry health status:', statusError);
          }
        };
        // Runner 开始执行前：将 Pin 升级为 CheckMark（表示"正在处理"）。
        // Trigger messageId is an internal runId, so there is no channel ack to promote.
        if (message.messageId && message.source !== 'trigger') {
          adapter.promoteAck?.(message.messageId).catch(() => {});
        }
        while (true) {
          let streamRegistered = false;
          try {
            logger.info(`[ResponseEngine] agent.runQuery start: agent=${agent.name} session=${session.id} task=${taskId} attempt=${runAttempt} consecutiveFailures=${consecutiveRetryFailures} agentSessionId=${session.agentSessionId ?? 'none'}`);
            const stream = await agent.runQuery(
              session.id,
              effectivePrompt,
              absoluteProjectPath,
              session.agentSessionId,
              renderResult?.images.length ? renderResult.images : message.images,
              effectiveSystemPrompt,
              this.sessionManager,
              modelOverride,
              runtimeEnv
            );
            agent.registerStream(streamKey, stream);
            streamRegistered = true;

            streamResult = await this.processEventStream(
              stream,
              session,
              agent,
              renderer,
              resetTimer,
              shouldSuppress,
              proactive,
              resolvedMode ? { mode: resolvedMode.mode, state: modeState } : undefined
            );
            if (streamResult.isError && !streamHitContextLimit(streamResult)) {
              const streamErrorText = getStreamErrorText(streamResult);
              if (streamErrorText && isRetryableError(new Error(streamErrorText))) {
                renderer.discardPending();
                throw new Error(streamErrorText);
              }
            }
            // 探测成功（退避期内到达探测点且用的是 evolclaw 模型）→ 清零降级状态
            if (fbState.fallbackActive && !skipEvolclawModel && !usedFallback) {
              this.modelFallbackMap.delete(session.id);
              logger.info(`[ResponseEngine] Model probe succeeded, cleared fallback state for session=${session.id}`);
            }
            break; // 成功，跳出重试循环
          } catch (retryError) {
            if (streamRegistered) {
              agent.cleanupStream(streamKey);
            }
            // 模型不可用：累计计数，本次切换到 baseAgentModel 立即重试，不让用户看到失败
            if (classifyError(retryError) === ErrorType.MODEL_UNAVAILABLE && !triggerModelOverride && evolclawModelOverride?.model) {
              fbState.failCount++;
              if (fbState.failCount >= 2) {
                fbState.fallbackActive = true;
                fbState.messagesSinceFallback = 0;
                fbState.nextProbeAt = Math.min(Math.pow(2, fbState.failCount - 1), 8);
              }
              this.modelFallbackMap.set(session.id, fbState);
              logger.warn(`[ResponseEngine] Model unavailable: ${evolclawModelOverride.model}, failCount=${fbState.failCount}, fallbackActive=${fbState.fallbackActive}`);
              // 切换到 baseAgentModel 重试（清除 model/effort，让 runQuery 使用 this.model；
              // 保留 permissionMode —— 它与模型无关，不能因模型降级而丢失）
              modelOverride = {
                ...(triggerEffortOverride ? { effort: triggerEffortOverride } : {}),
                permissionMode: effectivePermissionMode,
              };
              usedFallback = true;
              runAttempt++;
              continue;
            }
            if (isRetryableError(retryError)) {
              if (didRetryMakeProgress(retryError)) {
                consecutiveRetryFailures = 0;
              }
              await recordRetryHealthError(retryError);
              if (consecutiveRetryFailures < MAX_RETRIES) {
                // 检查中断状态：如果任务已被中断（/stop 或新消息），立即退出重试循环
                const interruptReason = this.interruptedSessions.get(session.id);
                if (interruptReason) {
                  logger.info(`[ResponseEngine] Task interrupted during retry wait (reason=${interruptReason}), aborting retry loop session=${session.id}`);
                  throw new Error('TASK_INTERRUPTED');
                }
                const delay = RETRY_DELAYS_MS[consecutiveRetryFailures];
                const nextRetryNumber = consecutiveRetryFailures + 1;
                consecutiveRetryFailures++;
                logger.warn(`[ResponseEngine] Retryable error (attempt ${runAttempt}, consecutive ${consecutiveRetryFailures}/${MAX_RETRIES}), retrying in ${delay}ms:`, retryError);
                renderer.addNotice(`API 不可用，${delay / 1000}秒后重试 ${nextRetryNumber}/${MAX_RETRIES}`, 'warn', 'retry', true);
                await renderer.flush();
                await new Promise(resolve => setTimeout(resolve, delay));
                // 延迟后再次检查中断状态（延迟期间可能收到中断信号）
                const postDelayInterrupt = this.interruptedSessions.get(session.id);
                if (postDelayInterrupt) {
                  logger.info(`[ResponseEngine] Task interrupted after retry delay (reason=${postDelayInterrupt}), aborting retry loop session=${session.id}`);
                  throw new Error('TASK_INTERRUPTED');
                }
                runAttempt++;
                continue;
              }
              markRetryExhausted(retryError, MAX_RETRIES);
            }
            throw retryError; // 不可重试或已耗尽重试次数
          }
        }
      } catch (error) {
        if (classifyError(error) === ErrorType.CONTEXT_TOO_LONG && session.agentSessionId && canCompactAgent(agent)) {
          streamResult = await this.retryAfterContextRecovery(
            '上下文已自动压缩，请继续之前未完成的任务。',
            {
              streamKey,
              renderer,
              agent,
              session,
              absoluteProjectPath,
              effectiveSystemPrompt,
              modelOverride,
              runtimeEnv,
              resetTimer,
              shouldSuppress,
              proactive,
            }
          );
        } else {
          throw error;
        }
      }

      // prompt_too_long：SDK 以 complete 事件（非异常）返回，需在此处触发 compact
      // 检测条件：terminalReason 明确为 prompt_too_long，或文本/errors 包含相关错误文本
      const compactAgent = canCompactAgent(agent) ? agent : undefined;
      const isPromptTooLong = streamResult.isError && !!session.agentSessionId && !!compactAgent
        && streamHitContextLimit(streamResult);
      if (isPromptTooLong) {
        streamResult = await this.retryAfterContextRecovery(
          '上下文已自动压缩，请继续之前未完成的任务。',
          {
            streamKey,
            renderer,
            agent,
            session,
            absoluteProjectPath,
            effectiveSystemPrompt,
            modelOverride,
            runtimeEnv,
            resetTimer,
            shouldSuppress,
            proactive,
          }
        );

        // 重试后仍然 prompt_too_long：显示友好提示
        const retryStillTooLong = streamResult.isError && streamHitContextLimit(streamResult);
        if (retryStillTooLong) {
          renderer.addNotice(getContextTooLongHint(agent), 'warn', 'context-too-long', true);
        }
      } else if (streamResult.isError && streamHitContextLimit(streamResult)) {
        // 上下文过长但无法 auto-compact（无 session ID 或 agent 不支持），显示友好提示
        renderer.addNotice(getContextTooLongHint(agent), 'warn', 'context-too-long', true);
      }

      // 处理文件标记 - 支持 [SEND_FILE:path] 和 [SEND_FILE:channel:path]
      // 注意：始终扫描全部文本（含中间轮），因为文件标记可能出现在任意轮次
      // suppressed 模式下 renderer 只有最后一轮文本，需要用 streamResult.fullText（SDK 全文）兜底
      // proactive 模式：agent 主动调用 ctl file 发送文件，跳过标记处理
      // [迁移点6] afterProcess：文件标记（interactive）+ Unknown skill 兜底（proactive）
      // 由响应模式插件统一处理（InteractiveMode.afterProcess / ProactiveMode.afterProcess）
      if (resolvedMode?.mode.afterProcess) {
        const flusherText = renderer.getFinalText();
        const fullText = flusherText.length >= (streamResult.fullText?.length || 0) ? flusherText : streamResult.fullText;
        await resolvedMode.mode.afterProcess({
          session,
          fullText,
          streamResult,
          send: async (payload) => {
            const isCurrentlyBackground = this.isBackgroundSession(session, message.channel, message.channelId);
            if (!isCurrentlyBackground) {
              await adapter.send({ ...envelope, replyContext: capturedReplyContext }, payload);
              if (payload.kind === 'result.text') {
                logger.info(`[ResponseEngine] afterProcess sent: task=${taskId} text="${payload.text.slice(0, 60)}"`);
              }
            }
          },
          channelCapabilities: { file: !!adapter.capabilities?.file, thought: !!adapter.capabilities?.thought },
          processFileMarkers: async (scanText: string) => {
            // 仅支持公开文件标记语法：[SEND_FILE:path] 或 [SEND_FILE:channel:path]。
            const SEND_FILE_RE = options?.fileMarkerPattern ?? /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g;
            const sendFileMatches = [...scanText.matchAll(SEND_FILE_RE)];

            if (sendFileMatches.length === 0) return 0;

            // 记录所有文件标记（快照用）
            snapshot.set(session.id, taskId, {
              fileMarkers: sendFileMatches.map(m => (m.length >= 3 ? (m[2] ?? m[1]) : m[1]).trim()),
            });

            let sent = 0;

            for (const match of sendFileMatches) {
              const hasChannelGroup = match.length >= 3;
              let targetSpec = hasChannelGroup ? (match[1] ?? undefined) : undefined;
              let filePath = (hasChannelGroup ? match[2] : match[1]).trim();

              // 白名单校验：targetSpec 必须是已注册通道，否则视为路径的一部分（如 Windows 盘符 C:）
              if (targetSpec && !this.channels.has(targetSpec) && !this.channelTypeMap.has(targetSpec)) {
                filePath = `${targetSpec}:${filePath}`;
                targetSpec = undefined;
              }

              // 跳过占位符路径（如 /path/to/file.txt）
              if (this.isPlaceholderPath(filePath)) {
                logger.info(`[${adapter.channelName}] Skipped placeholder file marker: [SEND_FILE:${filePath}]`);
                continue;
              }

              // 解析目标通道
              let targetInfo = targetSpec ? this.channels.get(targetSpec) : channelInfo;
              const targetLabel = targetSpec || message.channel;
              // 按 channelType 查找首个匹配的实例
              if (targetSpec && !targetInfo) {
                const instanceName = this.channelTypeMap.get(targetSpec);
                if (instanceName) targetInfo = this.channels.get(instanceName);
              }

              const currentChannelType = channelInfo.options?.channelType || adapter.channelName;
              const isCrossChannel = targetSpec && targetSpec !== message.channel && targetSpec !== currentChannelType;

              // 跨通道仅限 owner
              if (isCrossChannel && session.identity?.role !== 'owner') {
                await adapter.send(envelope, { kind: 'system.error', text: `❌ 跨通道发送仅限管理员`, subtype: 'fatal' });
                continue;
              }

              // 解析文件路径
              const agentProjectPath = session.projectPath || process.cwd();
              const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(agentProjectPath, filePath);

              if (!fs.existsSync(resolvedPath)) {
                logger.warn(`[${adapter.channelName}] File not found: ${resolvedPath}`);
                await adapter.send(envelope, { kind: 'system.error', text: `⚠️ 文件未找到: ${filePath}`, subtype: 'fatal' });
                continue;
              }

              // 找目标 adapter
              if (!targetInfo) {
                await adapter.send(envelope, { kind: 'system.error', text: `❌ 通道 ${targetLabel} 未启用或不存在`, subtype: 'channel_down' });
                continue;
              }
              if (!targetInfo.adapter.capabilities?.file) {
                await adapter.send(envelope, { kind: 'system.error', text: `❌ 通道 ${targetLabel} 不支持文件发送`, subtype: 'capability' });
                continue;
              }

              // 找目标 channelId
              let targetChannelId = message.channelId;
              if (isCrossChannel) {
                const targetAdapterName = targetInfo.adapter.channelName;
                const targetChannelType = targetInfo.options?.channelType || targetAdapterName;
                const targetChannelKey = targetInfo.adapter.channelKey || targetAdapterName;
                const targetAgent = this.agentRegistry?.resolveByChannel(targetChannelKey);
                const ownerPeerId = targetAgent
                  ? getFirstStaticAgentOwner(targetAgent.aid)
                  : undefined;
                targetChannelId = ownerPeerId ? (this.sessionManager.getOwnerChatId(targetChannelType, ownerPeerId) ?? '') : '';
                if (!targetChannelId) {
                  await adapter.send(envelope, { kind: 'system.error', text: `❌ 未找到 ${targetLabel} 的私聊会话，请先在该通道发送一条消息`, subtype: 'channel_down' });
                  continue;
                }
              }

              // 发送文件
              logger.info(`[${adapter.channelName}] Sending file via ${targetInfo.adapter.channelName}: ${resolvedPath}`);
              try {
                await targetInfo.adapter.send(
                  buildEnvelope({ taskId, channel: targetInfo.adapter.channelName, channelId: targetChannelId, agentName: agentNameForStats, replyContext: capturedReplyContext }),
                  { kind: 'result.file', filePath: resolvedPath }
                );
                this.eventBus.publish({ type: 'runner:file-sent', sessionId: session.id, filePath: resolvedPath, channel: targetInfo.adapter.channelName });
                sent++;
                if (isCrossChannel) {
                  await adapter.send(envelope, { kind: 'system.notice', text: `📎 文件已通过 ${targetLabel} 发送`, subtype: 'health' });
                }
              } catch (error) {
                logger.error(`[${adapter.channelName}] Failed to send file: ${resolvedPath}`, error);
                await adapter.send(envelope, { kind: 'system.error', text: `❌ 文件发送失败: ${filePath}`, subtype: 'fatal' });
              }
            }

            return sent;
          },
          logger,
        });
      }

      // 最终回复文本：suppressed 模式或无 text 事件时需要兜底添加
      const finalReplyText = streamResult.lastReplyText || streamResult.fullText;

      if (finalReplyText) {
        if (shouldSuppress() || !streamResult.hasReceivedText) {
          renderer.addText(finalReplyText);
        }
      }

      // 先清理流和处理中状态（保证即使 flush 卡住，session 也不会永久处于"处理中"）
      agent.cleanupStream(streamKey);
      logger.info(`[ResponseEngine] agent.cleanupStream ok: session=${session.id} task=${taskId}`);
      this.sessionManager.clearProcessing(session.id);
      this.activeTaskRuntimeContexts.delete(session.id);
      logger.info(`[ResponseEngine] session ${session.id} processing cleared task=${taskId}`);

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
        logger.info(`[ResponseEngine] Skipping flush for interrupted task=${taskId} reason=${preFlushInterrupt}`);
      } else {
        // Flush 剩余内容（文件标记已在 flush 时自动移除）
        await renderer.flush(true);
      }

      // 注意：不在此处清除 interruptedSessions，由下一条消息的 prompt 包装逻辑消费
      const interruptReason = this.interruptedSessions.get(session.id);

      if (streamResult.isError) {
        // Agent 流正常结束但任务结果失败（权限被拒、max turns、工具链失败等）
        const errorSummary = streamResult.errors?.join('; ') || '任务执行失败';
        const userErrorSummary = streamHitContextLimit(streamResult)
          ? getContextTooLongHint(agent)
          : getStreamErrorMessage(streamResult, false);
        const rawSubtype = streamResult.subtype || 'agent_error';
        const errorType = prefixErrorType(ERROR_PREFIX.AGENT, rawSubtype);
        // 用户主动打断（新消息/​/stop/​撤回）会让 SDK 流在工具调用中途被掐断，
        // 末尾 result message 形状异常并被标记为 error（含 SDK 内部 ede_diagnostic 串）。
        // 这不是真正的失败，不应把诊断串暴露给用户，也不计入错误统计。
        const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
        if (!isUserInterrupt) {
          await adapter.send(envelope, { kind: 'result.error', text: userErrorSummary, reason: rawSubtype }).catch(() => {});
          adapter.send(envelope, { kind: 'status.error', metadata: { errorType: rawSubtype } }).catch(() => {});
          this.touchAgentActivity(channelKey);
        }
        if (isUserInterrupt) {
          // 用户打断：打断本身已由 message-queue 发过 task:interrupted 事件，
          // 这里不再补发 task:error（否则同一次打断被记两遍且错误归类为 error）。
          // 仅记 info 日志收尾。注意：task:interrupted 已填充 interruptedSessions，
          // stats 侧已据此收尾任务生命周期，无需在此重复发事件。
          logger.info(`[${message.channel}] Stream result error suppressed (user interrupt: ${interruptReason}): ${errorSummary}`);
          logger.message({
            msgId: messageId,
            sessionId: session.id,
            dir: 'inbound',
            status: 'interrupted',
            error: errorSummary,
            terminalReason: streamResult.terminalReason
          });
        } else {
          if (message.triggerMeta) {
            const triggerRunId = message.triggerMeta.runId ?? message.messageId ?? messageId;
            this.eventBus.publish({ type: 'trigger:failed', triggerId: message.triggerMeta.triggerId, name: message.triggerMeta.triggerName ?? '', runId: triggerRunId, originTriggerId: message.triggerMeta.triggerId, messageId: messageId, error: errorSummary, targetChannel: message.channel, targetChannelId: message.channelId, fireTime: message.triggerMeta.fireTime ?? 0, phase: 'execute' });
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
            const identityRole = session.identity?.role || 'none';
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
        }
      } else {
        // 真正的成功
        const durationMs = Date.now() - startTime;

        // ── Stats: 写入 usage_events（在 status.completed 之前，以便带上 cost） ──
        // cost 含原价(official)与网关实际价(gateway)两套，由 insertUsageEvent 写库时一并算出。
        let turnCost: { official: { usd: number; cny: number } | null; gateway: { usd: number; cny: number } | null } = { official: null, gateway: null };
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
              usage_subject_key: formatUsageSubjectKey(currentChannelType, chatType, message.channelId, message.peerId || undefined),
              role: session.identity?.role || 'none',
              peer_type: session.chatType || undefined,
              session_id: session.id,
              model: statsModel,
              turns: streamResult.numTurns,
              duration_ms: durationMs,
              context_window_pct: ctxPct,
            });
            // 写库即得价格对（原价 + 网关价），无需再调 calcCost 重复计算。
            // 网关价格缓存（/v1/models 的 pricing/effective_pricing，1h TTL）由当前 runner 提供。
            const gwPricing = agent.getGatewayPricing?.();
            const prices = insertUsageEvent(resolveRoot(), event, gwPricing);
            turnCost = { official: prices.official, gateway: prices.gateway };
            // 逐次大模型调用明细落库（model_calls 表）
            if (streamResult.modelCalls?.length) {
              const mcRows = streamResult.modelCalls.map(mc => ({
                ts: event.ts,
                task_id: taskId,
                session_id: session.id,
                agent_session_id: session.agentSessionId ?? undefined,
                agent_aid: statsAgentAid,
                peer_key: statsPeerKey,
                call_index: mc.call_index,
                model: mc.model || statsModel,
                request_id: mc.request_id,
                message_id: mc.message_id,
                input_tokens: mc.tokenUsage.input_tokens ?? 0,
                output_tokens: mc.tokenUsage.output_tokens ?? 0,
                cache_creation_tokens: mc.tokenUsage.cache_creation_input_tokens ?? 0,
                cache_read_tokens: mc.tokenUsage.cache_read_input_tokens ?? 0,
                context_tokens: mc.contextUsage?.totalTokens,
                max_tokens: mc.contextUsage?.maxTokens,
                auto_compact_tokens: mc.contextUsage?.autoCompactTokens,
                degraded: mc.degraded ? 1 : 0,
              } as import('../../stats/writer.js').ModelCallRow));
              insertModelCalls(resolveRoot(), mcRows);
            }
            const totalIn = event.input_tokens + event.cache_read_tokens;
            statsCacheHitRate = totalIn > 0 ? Math.round((event.cache_read_tokens / totalIn) * 100) / 100 : 0;
          } catch (e) {
            logger.debug(`[ResponseEngine] Stats write failed (non-fatal): ${e}`);
          }
        }

        // 会话累计 + model spec（用于 status.completed 统计细目）
        // 直接读已落库的 cost 列（querySessionSummary 单条 SUM，含原价 + 网关价），不再逐行 calcCost。
        let sessionStats: {
          input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
          cost_usd: number; cost_cny: number; call_count: number;
          cost: { official: { usd: number; cny: number }; gateway: { usd: number; cny: number } };
        } | undefined;
        let modelSpec: { context_window: number; max_input_tokens: number; max_output_tokens: number } | undefined;
        try {
          const { resolveModelSpec } = await import('../../stats/billing.js');
          const { querySessionSummary } = await import('../../stats/query.js');
          const statsModel = streamResult.contextUsage?.model || 'unknown';
          modelSpec = resolveModelSpec(resolveRoot(), statsModel);
          const sum = querySessionSummary(resolveRoot(), session.id);
          if (sum.calls > 0) {
            sessionStats = {
              input_tokens: sum.input_tokens,
              output_tokens: sum.output_tokens,
              cache_read_tokens: sum.cache_read_tokens,
              cache_creation_tokens: sum.cache_creation_tokens,
              // 顶层 cost_usd/cost_cny 保持向后兼容 = 网关实际价
              cost_usd: sum.cost_gateway_usd,
              cost_cny: sum.cost_gateway_cny,
              call_count: sum.calls,
              cost: {
                official: { usd: sum.cost_official_usd, cny: sum.cost_official_cny },
                gateway:  { usd: sum.cost_gateway_usd,  cny: sum.cost_gateway_cny },
              },
            };
          }
        } catch { /* non-fatal */ }

        {
          this.touchAgentActivity(channelKey);
          if (interruptReason) {
            adapter.send(envelope, { kind: 'status.interrupted', metadata: { reason: interruptReason } }).catch(() => {});
          } else {
            // cost 同时给原价(official)与网关实际价(gateway)；顶层 cost_usd/cost_cny 保持向后兼容 = 网关价。
            const gatewayUsd = turnCost.gateway?.usd ?? turnCost.official?.usd ?? 0;
            const gatewayCny = turnCost.gateway?.cny ?? turnCost.official?.cny ?? 0;
            const turnCostBlock = {
              official: { usd: turnCost.official?.usd ?? 0, cny: turnCost.official?.cny ?? 0 },
              gateway:  { usd: gatewayUsd, cny: gatewayCny },
            };
            // 最后一次访问：本轮可能有多次大模型调用（numTurns>1），整轮的 turnCostBlock 不等于
            // 最后一次的价。用 lastModelCall.tokenUsage 单独走一遍 resolvePrices（与落库同一套定价逻辑），
            // 得到「最后一次访问」自己的原价 + 网关价。
            let lastModelCall = streamResult.lastModelCall;
            if (lastModelCall?.tokenUsage) {
              try {
                const lastModel = lastModelCall.model || streamResult.contextUsage?.model || 'unknown';
                const lastEvent = normalizeUsage(lastModelCall.tokenUsage as any, {
                  ts: Date.now(), agent_aid: '', peer_key: '', session_id: session.id,
                  model: lastModel, turns: 1,
                });
                const lp = resolvePrices(resolveRoot(), lastEvent, agent.getGatewayPricing?.());
                const lpGwUsd = lp.gateway?.usd ?? lp.official?.usd ?? 0;
                const lpGwCny = lp.gateway?.cny ?? lp.official?.cny ?? 0;
                lastModelCall = { ...lastModelCall, cost: {
                  official: { usd: lp.official?.usd ?? 0, cny: lp.official?.cny ?? 0 },
                  gateway:  { usd: lpGwUsd, cny: lpGwCny },
                } };
              } catch { /* 价格解析失败时不附 cost，不影响回执 */ }
            }
            const completedMetadata: Record<string, unknown> = {
              durationMs,
              ttftMs: streamResult.ttftMs,
              numTurns: streamResult.numTurns,
              tokenUsage: streamResult.tokenUsage,
              contextUsage: streamResult.contextUsage,
              lastModelCall,
              cost_usd: gatewayUsd,
              cost_cny: gatewayCny,
              cost: turnCostBlock,
              cache_hit_rate: statsCacheHitRate,
              model_spec: modelSpec,
              session_total: sessionStats,
              queue: {
                pending: this.messageQueue?.getQueueLength(session.id) ?? 0,
                processing: this.messageQueue?.isProcessing(session.id) ? 1 : 0,
              },
            };
            renderer.addLifecycle('completed', completedMetadata);
            renderer.flushActivitiesOnly().catch(() => {});
            adapter.send(envelope, { kind: 'status.completed', metadata: completedMetadata as any }).catch(() => {});
          }
        }
        if (message.triggerMeta) {
          const triggerRunId = message.triggerMeta.runId ?? message.messageId ?? messageId;
          if (interruptReason) {
            this.eventBus.publish({ type: 'trigger:skipped', triggerId: message.triggerMeta.triggerId, name: message.triggerMeta.triggerName ?? '', runId: triggerRunId, originTriggerId: message.triggerMeta.triggerId, reason: 'interrupted', targetChannel: message.channel, targetChannelId: message.channelId, fireTime: message.triggerMeta.fireTime });
          } else {
            this.eventBus.publish({ type: 'trigger:completed', triggerId: message.triggerMeta.triggerId, name: message.triggerMeta.triggerName ?? '', runId: triggerRunId, originTriggerId: message.triggerMeta.triggerId, messageId: messageId, durationMs, targetChannel: message.channel, targetChannelId: message.channelId, fireTime: message.triggerMeta.fireTime ?? 0 });
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
      if (isFinallyBackground) {
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
      logger.info(`[ResponseEngine] agent.cleanupStream ok (on error): session=${session.id} task=${taskId}`);
      try {
        this.sessionManager.clearProcessing(session.id);
        this.activeTaskRuntimeContexts.delete(session.id);
        logger.info(`[ResponseEngine] session ${session.id} processing cleared (on error) task=${taskId}`);
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
        this.touchAgentActivity(channelKey);
      }

      // 用户主动中断时降级日志；其余仍按 error 记录
      if (isUserInterrupt) {
        logger.info(`[${message.channel}] Interrupted by user (${interruptReason})`);
      } else {
        logger.error(`[${message.channel}] Error:`, error);
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorType = prefixErrorType(ERROR_PREFIX.INFRA, errType);

      // 用户主动打断：流被掐断抛出的异常不是真正的失败。打断发生时 source
      // （message-queue / slash-handler）已发过 task:interrupted（它填充了
      // interruptedSessions，isUserInterrupt 才会为真），stats 侧已据此收尾任务。
      // 此处不再发任何事件——发 task:error 会误归类，重发 task:interrupted 会重复记账。
      if (!isUserInterrupt) {
        this.eventBus.publish({
          type: 'task:error',
          sessionId: session.id,
          error: errorMsg,
          errorType,
          agentName: agentNameForStats,
        });
      }

      // 记录处理失败
      logger.message({
        msgId: messageId,
        sessionId: session.id,
        dir: 'inbound',
        status: isUserInterrupt ? 'interrupted' : 'failed',
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof Error && !isUserInterrupt) {
        logger.error(`[${message.channel}] Error stack:`, error.stack);
      }

      // 发送用户友好的错误消息
      // 用户主动中断（新消息打断 或 /stop 命令）时静默，不发送错误提示
      // processEventStream 已通过 renderer 发过错误时也跳过
      const isTimeout = error instanceof Error && error.message === 'SDK_TIMEOUT';
      const retryExhaustedCount = getRetryExhaustedCount(error);
      if (isUserInterrupt) {
        logger.info(`[ResponseEngine] User interrupt by new_message, skip sending error message`);
      } else if ((error as any)?._errorAlreadySent && !retryExhaustedCount) {
        logger.info(`[ResponseEngine] Error already sent via renderer, skip sending duplicate message`);
      } else {
        // SDK_TIMEOUT：status.timeout 已发结构化状态，此处再补一条用户可见的错误文本（result.error）
        const idleSec = getLastIdleSec?.() || 0;
        const userMessage = retryExhaustedCount
          ? formatRetryableErrorFinalMessage(error, retryExhaustedCount)
          : isTimeout
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
            message.baseagent || this.agentRegistry?.resolveByChannel(message.channel)?.baseagent,
            message.selfAID,
            message.channelType,
            message.peerType
          );
          sendOpts = this.getReplyContext(message);
        } catch {}
        // 注入 taskId / chatmode（与任务主流程保持一致）
        sendOpts = {
          ...(sendOpts ?? {}),
          metadata: withTaskMetadata(sendOpts?.metadata),
        };
        const errorPayload = {
          kind: 'result.error' as const,
          text: userMessage,
          reason: retryExhaustedCount ? 'retry_exhausted' : isTimeout ? 'timeout' : errType,
        };
        await adapter.send({ ...envelope, replyContext: sendOpts }, errorPayload);

        // Proactive 可观测：catch 块的基础设施错误也透传为 thought，保证按 task_id 聚合完整
        if (isProactive && adapter.capabilities?.thought) {
          await adapter.send({ ...envelope, replyContext: sendOpts }, {
            kind: 'activity.batch',
            items: [{
              kind: 'notice',
              text: userMessage,
              severity: 'warn',
              subtype: 'task-error',
            }],
          }).catch(() => {});
        }
      }
    }

    // [迁移探针] 任务收尾：记录工具提醒最终状态并落盘（防线 1）
    if (snapshot.isEnabled()) {
      snapshot.set(session.id, taskId, {
        toolReminder: proactive ? { queueReminders: proactive.lastQueueReminderLen, tenWarning: proactive.toolCount >= 10 } : undefined,
      });
      snapshot.end(session.id, taskId);
    }
  }

  private async runPendingAutoCompactAtTaskStart(
    session: Session,
    agent: AgentRunnerFull,
    absoluteProjectPath: string,
    adapter: ChannelAdapter,
    envelope: OutboundEnvelope,
    suppressOutput = false,
  ): Promise<void> {
    if (!session.agentSessionId || !canCompactAgent(agent)) {
      logger.debug(`[ResponseEngine] Auto compact skipped: session=${session.id} agentSessionId=${session.agentSessionId || 'none'} canCompact=${canCompactAgent(agent)} agent=${agent.name}`);
      return;
    }

    const ctx = await this.readLastModelCallContextUsage(session.id, session.agentSessionId);
    if (!ctx || ctx.totalTokens < ctx.autoCompactTokens) {
      logger.debug(`[ResponseEngine] Auto compact skipped: session=${session.id} ctx=${ctx ? `${ctx.totalTokens}/${ctx.autoCompactTokens}` : 'none'}`);
      return;
    }

    logger.info(`[ResponseEngine] Auto compact at task.start: session=${session.id} totalTokens=${ctx.totalTokens} autoCompactTokens=${ctx.autoCompactTokens}`);
    if (!suppressOutput) {
      await adapter.send(envelope, { kind: 'system.notice', text: '上下文接近上限，正在压缩会话...', subtype: 'auto-compact-start' }).catch(() => {});
    }

    try {
      const compacted = await agent.compact(session.id, session.agentSessionId, absoluteProjectPath);
      if (compacted) {
        if (!suppressOutput) {
          await adapter.send(envelope, { kind: 'system.notice', text: '✅ 上下文压缩完成，继续处理...', subtype: 'auto-compact-complete' }).catch(() => {});
        }
      } else {
        logger.warn(`[ResponseEngine] Auto compact at task.start returned false (session=${session.id})`);
      }
    } catch (err) {
      logger.warn(`[ResponseEngine] Auto compact at task.start failed (non-fatal):`, err);
    }
  }

  private async readLastModelCallContextUsage(sessionId: string, agentSessionId: string): Promise<{ totalTokens: number; autoCompactTokens: number } | undefined> {
    try {
      const { getDb, openReadonlyDb, getDbPath } = await import('../../stats/db.js');
      const root = resolveRoot();
      const writerDb = getDb(root);
      const db = writerDb || openReadonlyDb(getDbPath(root));
      if (!db) return undefined;
      const shouldClose = !writerDb;
      try {
        const row = db.prepare(
          `SELECT model, input_tokens, cache_creation_tokens, cache_read_tokens,
                  context_tokens, max_tokens, auto_compact_tokens
             FROM model_calls
            WHERE session_id = ?
              AND agent_session_id = ?
            ORDER BY ts DESC, call_index DESC
            LIMIT 1`
        ).get(sessionId, agentSessionId) as {
          model?: string;
          input_tokens?: number;
          cache_creation_tokens?: number;
          cache_read_tokens?: number;
          context_tokens?: number | null;
          max_tokens?: number | null;
          auto_compact_tokens?: number | null;
        } | undefined;
        if (!row) return undefined;

        const model = row.model || '';
        const recordedTotalTokens = row.context_tokens ?? undefined;
        let totalTokens: number;
        if (recordedTotalTokens && recordedTotalTokens > 0) {
          totalTokens = recordedTotalTokens;
        } else if (isClaudeContextUsageModel(model)) {
          totalTokens = (row.input_tokens ?? 0) + (row.cache_creation_tokens ?? 0) + (row.cache_read_tokens ?? 0);
        } else {
          totalTokens = row.input_tokens ?? 0;
        }
        if (totalTokens <= 0) return undefined;

        const recordedAutoCompactTokens = row.auto_compact_tokens ?? undefined;
        const inferredAutoCompactTokens = autoCompactTokensFromMaxTokens(row.max_tokens ?? undefined);
        const autoCompactTokens = recordedAutoCompactTokens && recordedAutoCompactTokens > 0
          ? recordedAutoCompactTokens
          : inferredAutoCompactTokens ?? autoCompactWindowForModel(model);
        return { totalTokens, autoCompactTokens };
      } finally {
        if (shouldClose) db.close();
      }
    } catch (err) {
      logger.debug(`[ResponseEngine] Failed to read last model call context usage: ${err}`);
      return undefined;
    }
  }

  /**
   * 解析会话和项目路径
   */
  private async resolveSession(message: Message): Promise<{
    session: Session;
    absoluteProjectPath: string;
  }> {
    // 话题会话创建时写入创建者和 replyContext（threadId 路由）；主会话不写（避免群聊覆盖）
    const metadata = message.threadId
      ? {
          ...(message.replyContext ? { replyContext: message.replyContext } : {}),
          ...(message.peerId ? { peerId: message.peerId } : {}),
          ...(message.peerName ? { peerName: message.peerName } : {}),
        }
      : undefined;

    const owningAgent = this.agentRegistry?.resolveByChannel(message.channel);
    const projectPath = owningAgent?.projectPath || process.cwd();
    const resolvedBaseagent = message.baseagent || owningAgent?.baseagent || (!this.agentRegistry ? this.inferPrimaryBaseagent() : undefined);
    const resolvedIdentity = this.inferDirectSessionIdentity(message, owningAgent);
    if (!resolvedBaseagent) {
      throw new Error(`[ResponseEngine] resolveSession: baseagent could not be determined (message.baseagent=${message.baseagent}, owningAgent=${owningAgent?.name || 'none'})`);
    }

    // 话题创建权限守卫已统一移至 MessageBridge.canCreateThreadSession（enqueue 前拦截），
    // 此处不再重复检查——bridge 层拒绝后消息根本不会到达 processMessage。

    // current strategy: resume bound session, make it active so output is not suppressed
    if (message.triggerMeta?.boundSessionId) {
      const bound = await this.sessionManager.getSessionById(message.triggerMeta.boundSessionId);
      if (bound) {
        this.ensureSessionBaseagent(bound, resolvedBaseagent);
        if (bound.threadId) {
          const absoluteProjectPath = path.isAbsolute(bound.projectPath)
            ? bound.projectPath : path.resolve(process.cwd(), bound.projectPath);
          return { session: bound, absoluteProjectPath };
        }
        const switched = await this.sessionManager.switchToSession(bound.channel, bound.channelId, bound.id);
        if (switched) {
          this.ensureSessionBaseagent(switched, resolvedBaseagent);
          const absoluteProjectPath = path.isAbsolute(switched.projectPath)
            ? switched.projectPath : path.resolve(process.cwd(), switched.projectPath);
          return { session: switched, absoluteProjectPath };
        }
        logger.warn(`[ResponseEngine] switchToSession failed for bound session ${bound.id}, falling back to latest`);
      } else {
        logger.warn(`[ResponseEngine] Bound session ${message.triggerMeta.boundSessionId} not found, falling back to latest`);
      }
    }

    const session = await this.sessionManager.getOrCreateSession(
      message.channel,
      message.channelId,
      projectPath,
      message.threadId,
      metadata,
      message.topicName,
      message.peerId,
      message.chatType,
      resolvedBaseagent,
      message.selfAID,
      message.channelType,
      message.peerType,
      resolvedIdentity
    );
    this.ensureSessionBaseagent(session, resolvedBaseagent);

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
      logger.info(`[ResponseEngine] dispatchMode sync: sessionId=${session.id} ${session.metadata?.dispatchMode ?? 'none'} -> ${message.dispatchMode}`);
      session.metadata = { ...(session.metadata || {}), dispatchMode: message.dispatchMode };
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
    }

    // chatMode 策略由 agent/relation behavior 配置在处理阶段解析；此处不再写 session 级参数。

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
    shouldSuppress: () => boolean,
    proactive?: ProactiveRuntimeState | null,
    /** [迁移点4/5] 响应模式插件 + 状态，用于调 onToolUse/onComplete 钩子 */
    modeHooks?: { mode: import('../../response-system/types.js').ResponseMode; state: Map<string, any> }
  ): Promise<StreamRunResult> {
    // Per-session agent name for stats bucketing
    const statsChannelKey = session.channel === 'daemon' ? session.channel : (session.metadata?.channelKey || session.channel);
    const agentNameForStats = this.agentRegistry?.resolveByChannel(statsChannelKey)?.name ?? '<unknown>';
    let hasReceivedText = false;
    let hasErrorResult = false;  // 是否已有 tool_result/error 事件输出过错误
    let madeProgress = false;
    let completeResult: StreamRunResult = { isError: false, lastReplyText: '', fullText: '', hasReceivedText: false };

    // 追踪最后一轮 assistant 回复文本（tool_use 之后的纯文本）
    let lastReplyText = '';

    // callId → description 映射，用于 tool_result 回显描述
    const toolDescByCallId = new Map<string, string>();
    const ctlQueueReadCallIds = new Set<string>();

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
        logger.debug(`[ResponseEngine] Event: type=${event.type}${eventDetail}`);
      } else {
        logger.info(`[ResponseEngine] Event: type=${event.type}${eventDetail}`);
      }

      // IMRenderer 旁路：proactive 模式逐事件投影为 thought（fire-and-forget）
      renderer.emit(event);

      // session_id 已在 AgentRunner.transformStream 中处理，此处仅记录
      if (event.type === 'session_id') {
        logger.debug(`[ResponseEngine] Session ID updated: ${event.sessionId} for session: ${session.id}`);
        session.agentSessionId = event.sessionId;
        continue;
      }

      // session 状态变更（idle/running/requires_action）
      if (event.type === 'state_changed') {
        logger.debug(`[ResponseEngine] Session state: ${event.state} for session: ${session.id}`);
        this.eventBus.publish({ type: 'runner:state-changed', sessionId: session.id, state: event.state });
        continue;
      }

      // agent 状态通知（仅事件，不直出给用户）
      if (event.type === 'status') {
        logger.debug(`[ResponseEngine] Agent status: ${event.subtype}: ${event.message}`);
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
          if (event.text.trim()) madeProgress = true;
          lastReplyText += event.text;
          this.eventBus.publish({ type: 'message:text', sessionId: session.id, text: event.text, isFinal: false });
          if (!shouldSuppress()) {
            renderer.addText(event.text, (event as any).outputTokens, (event as any).turn);
          }
        }

        // compact 完成
        if (event.type === 'compact') {
          madeProgress = true;
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
          if (event.summary || tools > 0) madeProgress = true;

          if (event.summary && !shouldSuppress()) {
            renderer.addProgress(`\u5b50\u4efb\u52a1: ${event.summary}${stats ? ` (${stats})` : ''}`, { state: 'processing', toolUses: event.toolUses, durationMs: event.durationMs });
          } else if (stats && !shouldSuppress()) {
            renderer.addProgress(`\u5b50\u4efb\u52a1\u8fdb\u884c\u4e2d: ${stats}`, { state: 'processing', toolUses: event.toolUses, durationMs: event.durationMs });
          }
        }

        // 工具调用
        if (event.type === 'tool_use') {
          madeProgress = true;
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
          if (event.callId && isCtlQueueReadCommand(event.name, event.input || {})) {
            ctlQueueReadCallIds.add(event.callId);
          }
          // [迁移点4] 工具汇报提醒：由 ProactiveMode.onToolUse 实现
          if (modeHooks?.mode?.onToolUse) {
            modeHooks.mode.onToolUse({
              session,
              state: modeHooks.state,
              toolName: event.name,
              toolInput: event.input || {},
              injectToModel: (text: string) => { agent.injectUserMessage?.(session.id, text); },
              getQueueLength: () => this.messageQueue?.getQueueLength(session.id) ?? 0,
              isSendCommand: (toolName, toolInput) => isEvolclawSendCommandForSession(toolName, toolInput, session.channelId),
              logger,
            });
          }
        }

        // 工具结果
        if (event.type === 'tool_result') {
          if (!event.isError) madeProgress = true;
          if (event.callId && ctlQueueReadCallIds.delete(event.callId) && !event.isError) {
            try {
              const clearResult = await this.commandHandler?.handleCtl?.('/queue --clear', session.id);
              if (clearResult && !clearResult.ok) {
                logger.warn(`[ResponseEngine] auto clear queue after ec ctl queue failed: ${clearResult.error || 'unknown error'}`);
              }
            } catch (error) {
              logger.warn('[ResponseEngine] auto clear queue after ec ctl queue failed:', error);
            }
          }

          this.eventBus.publish({
            type: 'tool:result',
            sessionId: session.id,
            toolName: event.name,
            isError: event.isError,
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
          logger.warn(`[ResponseEngine] error event: ${event.errorType}: ${event.error}`);

          // 记录错误文本到 lastReplyText，供后续 isPromptTooLong 检测
          lastReplyText += event.error || '';

          // 上下文过长的错误不在此处输出 notice，留给外层 isPromptTooLong 触发 auto-compact
          const isContextError = isContextTooLongText(event.error || '');
          const isRetryableRuntimeError = isRetryableError(new Error(event.error || ''));
          if (!isContextError && !isRetryableRuntimeError && !hasErrorResult && !shouldSuppress()) {
            hasErrorResult = true;
            renderer.addNotice(getRuntimeErrorMessage(event.error || '任务执行失败', false), 'warn', 'runtime-error', true);
          }
        }

        // 完成事件
        // SDK 可能产生多个 complete 事件（如 subagent 或 auto-compact 二次查询），
        // 仅记录状态，最终 flush(true) 在流结束后统一执行
        if (event.type === 'complete') {
          const isAbort = event.terminalReason === 'aborted_streaming' || event.terminalReason === 'aborted_tools';
          logger.info(`[ResponseEngine] ${isAbort ? 'task interrupted' : 'complete event'}: isError=${event.isError} terminalReason=${event.terminalReason ?? 'none'} subtype=${event.subtype ?? 'none'} hasReceivedText=${hasReceivedText}`);

          // 自动回填会话名称
          if (event.sessionTitle && session.name === '默认会话') {
            await this.sessionManager.renameSession(session.id, event.sessionTitle);
            logger.info(`[ResponseEngine] Auto-filled session name: ${event.sessionTitle}`);
          }

          // 记录完成状态 + 最后一轮回复文本（后续 complete 覆盖前序）
          completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText, numTurns: event.numTurns, ttftMs: event.ttftMs, tokenUsage: event.tokenUsage, contextUsage: event.contextUsage, lastModelCall: event.lastModelCall, modelCalls: event.modelCalls };
          if (!event.isError) madeProgress = true;

          // thought jsonl 写入已下沉到 aun.ts:sendThought 成功后，
          // 由那里按 LLM 输出的每个 text item 单独写一条，此处不再写。

          // 失败且无前置错误输出：显示 errors 摘要
          // 但用户主动中断（新消息打断 或 /stop 命令）时不显示错误提示
          // 上下文过长的错误留给外层 isPromptTooLong 触发 auto-compact，不在此处输出
          const interruptReason = this.interruptedSessions.get(session.id);
          const isUserInterrupt = interruptReason === 'new_message' || interruptReason === 'stop' || interruptReason === 'recalled';
          const isContextTooLong = event.terminalReason === 'prompt_too_long'
            || isContextTooLongText(event.errors?.join(' ') || '')
            || isContextTooLongText(lastReplyText);
          const completeErrorText = getStreamErrorText(completeResult);
          const isRetryableCompleteError = event.isError && !isContextTooLong && completeErrorText
            ? isRetryableError(new Error(completeErrorText))
            : false;
          if (event.isError && completeErrorText && isPendingTextSameAsStreamError(renderer.getRemainingText(), completeErrorText)) {
            renderer.discardPendingText();
          }
          if (event.isError && !hasErrorResult && !shouldSuppress() && !isUserInterrupt && !isContextTooLong && !isRetryableCompleteError) {
            // 使用 terminalReason 提供更友好的错误提示（不带 emoji，由 formatter 统一加）
            const userFriendlyMessage = event.terminalReason === 'prompt_too_long'
              ? getContextTooLongHint(agent)
              : event.terminalReason === 'context_compact_failed'
                ? getContextCompactFailedHint(agent)
                : getStreamErrorMessage(completeResult, false);
            renderer.addNotice(userFriendlyMessage, 'warn', 'task-error', true);
          }

          // 中间 complete：flush 掉已有 activities（不带 isFinal），让中间结果及时显示
          // 最终文本留给流结束后的统一 flush(true)
          if (renderer.hasContent()) {
            await renderer.flushActivitiesOnly();
          }

          // 检测 proactive 标志位，设置 lastProactiveFlag 供模式切换提示使用
          // [迁移点5] 标志位检查：由 ProactiveMode.onComplete 实现
          if (modeHooks?.mode?.onComplete && lastReplyText) {
            await modeHooks.mode.onComplete({
              session,
              state: modeHooks.state,
              lastReplyText,
              updateSessionMeta: async (patch) => {
                session.metadata = { ...(session.metadata || {}), ...patch };
                await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
              },
              logger,
            });
          }
        }

        continue;
      }

      // === 后台任务：追踪最后回复文本，但只处理 complete 事件 ===
      if (event.type === 'text') {
        if (event.text.trim()) madeProgress = true;
        lastReplyText += event.text;
      } else if (event.type === 'tool_use') {
        madeProgress = true;
        lastReplyText = '';
      }
      if (event.type !== 'complete') {
        continue;
      }

      // 自动回填会话名称
      if (event.sessionTitle && session.name === '默认会话') {
        await this.sessionManager.renameSession(session.id, event.sessionTitle);
        logger.info(`[ResponseEngine] Auto-filled session name: ${event.sessionTitle}`);
      }

      // 记录完成状态
      completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText, numTurns: event.numTurns, ttftMs: event.ttftMs, tokenUsage: event.tokenUsage, contextUsage: event.contextUsage, lastModelCall: event.lastModelCall };

      if (event.subtype === 'success') {
        madeProgress = true;
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
        logger.info('[ResponseEngine] Stream interrupted (AbortError)');
        // User-initiated interrupt: skip flush — new task takes over the channel,
        // flushing here would send a spurious "最终回复" before the new task's output
        if (catchIsUserInterrupt) {
          completeResult.isError = false;
          completeResult.hasReceivedText = hasReceivedText;
          return completeResult;
        }
      } else if (catchIsUserInterrupt) {
        // SDK telemetry noise after user-initiated interrupt — not a real error
        logger.debug('[ResponseEngine] Stream ended after user interrupt:', (error as Error)?.message?.split('\n')[0]);
        completeResult.isError = false;
        completeResult.hasReceivedText = hasReceivedText;
        return completeResult;
      } else if (isRetryableError(error)) {
        // Retryable errors (network aborts, transient API failures) are noise at ERROR level
        logger.warn('[ResponseEngine] Stream processing error (retryable):', (error as Error)?.message?.split('\n')[0]);
      } else {
        logger.error('[ResponseEngine] Stream processing error:', error);
      }
      if (error instanceof Error && error.message.includes('process exited')) {
        renderer.addNotice('Claude Code 进程异常退出，请重试', 'warn', 'process-exit', true);
      }
      if (isRetryableError(error) && madeProgress) {
        markRetryMadeProgress(error);
      }
      // Flush any pending error activities before re-throwing,
      // and mark the error so outer catch won't send a duplicate message
      const hasErrorSuppressingContent = hasErrorResult || renderer.hasNonLifecycleContent();
      if (hasErrorSuppressingContent) {
        try { await renderer.flush(true); } catch {}
        if (error instanceof Error) {
          (error as any)._errorAlreadySent = true;
        }
      } else if (renderer.hasContent()) {
        renderer.flushActivitiesOnly().catch(() => {});
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
    const normalized = filePath.trim().toLowerCase();

    // 精确占位符
    const exactPlaceholders = ['...', '\u2026', 'path', 'file', 'file_path', 'filepath',
      '\u8def\u5f84', '\u6587\u4ef6\u8def\u5f84', '\u6587\u4ef6', 'filename', 'xxx'];
    if (exactPlaceholders.includes(normalized)) return true;

    // 跨通道示例占位符，如 [SEND_FILE:channel:路径] 被未知 channel 回退后会变成 channel:路径。
    const channelPlaceholders = ['channel', 'channel_name', 'channelname', 'target', 'target_channel', 'targetchannel',
      '\u6e20\u9053', '\u901a\u9053', '\u9891\u9053', '\u76ee\u6807\u6e20\u9053', '\u6e20\u9053\u540d', '\u901a\u9053\u540d'];
    const colonIndex = normalized.indexOf(':');
    if (colonIndex > 0) {
      const maybeChannel = normalized.slice(0, colonIndex).trim();
      const maybePath = normalized.slice(colonIndex + 1).trim();
      if (channelPlaceholders.includes(maybeChannel) && exactPlaceholders.includes(maybePath)) return true;
    }

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
