import { ChannelAdapter, Session, ChannelPolicy, InteractionRequest, ReplyContext, type OutboundPayload, type EvolAgentRegistryHandle, type EvolAgentHandle, type SessionIdentity } from '../../types.js';
import { SessionManager } from '../session/session-manager.js';
import { BaseagentRunnerUnavailableError, type AgentRunnerFull } from '../../agents/runner-types.js';
import { MessageCache } from '../message/message-cache.js';
import type { IMessageProcessor } from '../message/message-processor-interface.js';
import { EventBus } from '../event-bus.js';
import type { StatsCollector } from '../../utils/stats.js';
import { PermissionGateway } from '../permission.js';
import { InteractionRouter } from '../interaction-router.js';
import { MessageQueue } from '../message/message-queue.js';
import { renderCommandCardAsText } from '../interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from '../message/message-utils.js';
import { resolvePaths, getPackageRoot } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import { resolvePeerRoleDetail, roleToSessionIdentity } from '../../config/peer-role-resolver.js';
import { resolveEffective } from '../../config/config-manager.js';
import { formatPeerKey } from '../relation/peer-identity.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { parseDuration, parseTriggerSet, parseTriggerUpdate } from '../../trigger/parser.js';
import type { ParsedTriggerSet } from '../../trigger/parser.js';
import type { TriggerRuntimeScheduler } from '../../trigger/scheduler.js';
import {
  type TriggerDefinition,
  type TriggerFeedbackTarget,
  type TriggerPermissionMode,
  type TriggerSource,
} from '../../trigger/types.js';
import { tryParseChannelKey } from '../channel-loader.js';
import { displaySessionTitle } from '../session/session-title.js';
import { resolveConfigCommand } from '../../config/resolved-config-op.js';
import { executeResolvedConfigCommand } from '../../config/config-operation-service.js';
import { authorizeResolvedConfigCommand } from './command-permission.js';
import { auditCommandAuthorization, hashArgv } from './command-audit.js';
import type { IpcConfigOpResponse } from '../../ipc.js';
import type { AgentDelegationRegistry } from '../auth/agent-delegation.js';
import { buildAuthSubject } from '../auth/auth-gateway.js';
import { parsePeerKey } from '../relation/peer-identity.js';
import { isQuickCommand } from './slash-gate.js';
import { handleSlashCommand } from './slash-handler.js';
import { resolveChatModeForPeer } from '../message/peer-mode.js';
import {
  execMenuAction as menuExecMenuAction,
  execMenuForEcweb as menuExecMenuForEcweb,
  execMenuForControl as menuExecMenuForControl,
  execMenuQuery as menuExecMenuQuery,
  execMenuUpdate as menuExecMenuUpdate,
  getMenuItems as menuGetMenuItems,
  getSubMenuItems as menuGetSubMenuItems,
  type MenuChatType,
  type MenuItem,
} from './menu-handler.js';
export { isProcessLevelOwner } from './menu-handler.js';

const CLI_EXEC_TIMEOUT_MS = 15_000;
const CLI_EXEC_MAX_OUTPUT = 128 * 1024;

/**
 * 写入用户级 ~/.claude/settings.json（与 Claude CLI 行为一致）
 * ⚠️ 已禁用：按需求不再修改用户的 ~/.claude/settings.json 文件。
 *    原会把 model/effortLevel 写入 settings.json（仅在找不到 owning agent 的 fallback 路径触发）。
 *    现直接返回成功且不落盘；如需恢复，取消下方注释即可。
 */
function writeUserSettings(updates: { model?: string; effortLevel?: string | null }): { success: boolean; error?: string } {
  void updates;
  return { success: true };

  /* eslint-disable no-unreachable */
  // try {
  //   const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  //   let settings: any = {};
  //
  //   if (fs.existsSync(settingsPath)) {
  //     settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  //   }
  //
  //   if (updates.model !== undefined) settings.model = updates.model;
  //   if (updates.effortLevel !== undefined) {
  //     if (updates.effortLevel === null) {
  //       delete settings.effortLevel;
  //     } else {
  //       settings.effortLevel = updates.effortLevel;
  //     }
  //   }
  //
  //   const claudeDir = path.join(os.homedir(), '.claude');
  //   if (!fs.existsSync(claudeDir)) {
  //     fs.mkdirSync(claudeDir, { recursive: true });
  //   }
  //
  //   fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  //   return { success: true };
  // } catch (error: any) {
  //   return { success: false, error: error.message };
  // }
  /* eslint-enable no-unreachable */
}

function isAdminRole(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export class CommandHandler {
  private adapters = new Map<string, ChannelAdapter>();
  private policies = new Map<string, ChannelPolicy>();
  private channelObjects = new Map<string, any>();  // name → actual channel instance (for /check)
  private channelTypeMap = new Map<string, string>();  // name → channelType (for grouping)
  private processor!: IMessageProcessor;
  private messageQueue!: MessageQueue;
  private permissionGateway?: PermissionGateway;
  private interactionRouter?: InteractionRouter;
  private statsCollector?: StatsCollector;
  private agentMap: Map<string, AgentRunnerFull>;
  private primaryRunnerKey: string;
  private agentRegistry?: EvolAgentRegistryHandle;
  private triggerSchedulerResolver?: (agentAid: string) => TriggerRuntimeScheduler | undefined;
  private triggerSchedulerFallback?: TriggerRuntimeScheduler;
  private triggerSchedulerFallbackAid?: string;
  private daemonStatusProvider?: () => any;
  private agentDelegationRegistry?: AgentDelegationRegistry;

  /**
   * Get the runner for a (channel, baseagent) pair.
   *
   * Resolves the owning EvolAgent via the registry. If the owner is known and
   * the requested baseagent runner is absent, do not silently fall back to a
   * different backend; that would corrupt session metadata.
   */
  private getAgent(channel?: string, baseagent?: string): AgentRunnerFull {
    if (channel && baseagent) {
      const owner = this.agentRegistry?.resolveByChannel(channel);
      const evolName = owner?.name || '<unknown>';
      const key = `${evolName}::${baseagent}`;
      if (this.agentMap.has(key)) return this.agentMap.get(key)!;
      if (owner) {
        throw new BaseagentRunnerUnavailableError(evolName, baseagent, this.getAvailableBaseagentsForOwner(evolName));
      }
      const globalRunner = [...this.agentMap.entries()]
        .find(([runnerKey]) => runnerKey === baseagent || runnerKey.endsWith(`::${baseagent}`));
      if (globalRunner) return globalRunner[1];
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

  private formatBaseagentUnavailable(error: BaseagentRunnerUnavailableError): string {
    const available = error.availableBaseagents.length ? error.availableBaseagents.join(', ') : '(none)';
    return `❌ 当前会话绑定的 baseagent 不可用: ${error.baseagent}\nAgent: ${error.evolagentName}\n可用: ${available}\n请使用 /baseagent 切换到可用后端。`;
  }

  /**
   * Return the list of baseagents available to a given channel.
   *
   * Agent channels stay isolated to their owning EvolAgent. Control/daemon
   * channels are virtual and have no owner, so expose the loaded runner types
   * globally for menu.options(name=baseagent).
   */
  private getAvailableBaseagents(channel: string): string[] {
    const owner = this.agentRegistry?.resolveByChannel(channel);
    if (!owner) {
      const result = new Set<string>();
      for (const key of this.agentMap.keys()) {
        const idx = key.indexOf('::');
        result.add(idx >= 0 ? key.slice(idx + 2) : key);
      }
      return [...result];
    }

    const evolName = owner.name || '<unknown>';
    const prefix = `${evolName}::`;
    const result: string[] = [];
    for (const key of this.agentMap.keys()) {
      if (key.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  }

  /** Extract the baseagent component from `primaryRunnerKey` (e.g. `aid::claude` → `claude`). */
  private parseDefaultBaseagent(): string {
    const idx = this.primaryRunnerKey.indexOf('::');
    return idx >= 0 ? this.primaryRunnerKey.slice(idx + 2) : this.primaryRunnerKey;
  }

  constructor(
    private sessionManager: SessionManager,
    agentRunnerOrMap: AgentRunnerFull | Map<string, AgentRunnerFull>,
    private messageCache: MessageCache,
    private eventBus: EventBus,
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
  }

  /** 注入 EvolAgentRegistry，用于判断通道是否被 EvolAgent 管理 */
  setAgentRegistry(registry: EvolAgentRegistryHandle): void {
    this.agentRegistry = registry;
  }

  setTriggerSchedulerResolver(resolver: (agentAid: string) => TriggerRuntimeScheduler | undefined): void {
    this.triggerSchedulerResolver = resolver;
  }

  /** Compatibility entrypoint for older tests/callers that inject a single scheduler. */
  setTriggerScheduler(scheduler: TriggerRuntimeScheduler, manager?: { agentAid?: string }): void {
    this.triggerSchedulerFallback = scheduler;
    this.triggerSchedulerFallbackAid = manager?.agentAid;
    this.triggerSchedulerResolver = (agentAid: string) => {
      if (!this.triggerSchedulerFallbackAid || agentAid === this.triggerSchedulerFallbackAid) {
        return scheduler;
      }
      return undefined;
    };
  }

  setDaemonStatusProvider(provider: () => any): void {
    this.daemonStatusProvider = provider;
  }

  /** 返回管理当前通道的 EvolAgent，无则返回 null */
  private getOwningAgent(channel: string): EvolAgentHandle | null {
    if (!this.agentRegistry) return null;
    return this.agentRegistry.resolveByChannel(channel);
  }

  getTriggerSchedulerForChannel(channel: string): TriggerRuntimeScheduler | undefined {
    const agentAid = this.getOwningAgent(channel)?.aid ?? tryParseChannelKey(channel)?.selfAID;
    return agentAid ? this.triggerSchedulerResolver?.(agentAid) : this.triggerSchedulerFallback;
  }

  private getTriggerSchedulerForAgent(agentAid: string): TriggerRuntimeScheduler | undefined {
    return this.triggerSchedulerResolver?.(agentAid) ?? (
      this.triggerSchedulerFallbackAid === agentAid ? this.triggerSchedulerFallback : undefined
    );
  }

  private triggerSourceFromSchedule(scheduleType: string, scheduleValue: string): TriggerSource {
    if (scheduleType === 'once') return { type: 'once' };
    if (scheduleType === 'delay') return { type: 'delay', afterMs: this.triggerDurationMs(scheduleValue) };
    if (scheduleType === 'at') return { type: 'at', at: scheduleValue };
    if (scheduleType === 'cron') return { type: 'cron', expression: scheduleValue };
    if (scheduleType === 'interval') return { type: 'interval', everyMs: this.triggerDurationMs(scheduleValue) };
    if (scheduleType === 'event') return { type: 'event', eventPattern: scheduleValue };
    throw new Error(`unsupported scheduleType: ${scheduleType}`);
  }

  private triggerDurationMs(value: string): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = parseDuration(value);
    if (parsed != null) return parsed;
    return Number.NaN;
  }

  private scheduleViewFromSource(source: TriggerSource): { scheduleType: string; scheduleValue: string } {
    switch (source.type) {
      case 'once': return { scheduleType: 'once', scheduleValue: '' };
      case 'delay': return { scheduleType: 'delay', scheduleValue: String(source.afterMs) };
      case 'at': return { scheduleType: 'at', scheduleValue: source.at };
      case 'cron': return { scheduleType: 'cron', scheduleValue: source.expression };
      case 'interval': return { scheduleType: 'interval', scheduleValue: String(source.everyMs) };
      case 'event': return { scheduleType: 'event', scheduleValue: source.eventPattern };
    }
  }

  private triggerPrompt(definition: TriggerDefinition): string {
    return definition.execution.type === 'script'
      ? (definition.feedback.onReply?.template ?? '')
      : (definition.execution.prompt ?? '');
  }

  private definitionToTriggerView(definition: TriggerDefinition, scheduler?: TriggerRuntimeScheduler): any {
    const target = this.primaryFeedbackTarget(definition);
    const schedule = this.scheduleViewFromSource(definition.source);
    let schedulerDetails: ReturnType<TriggerRuntimeScheduler['show']> | undefined;
    try {
      schedulerDetails = scheduler?.show(definition.id);
    } catch { /* trigger state is best-effort for views */ }
    // 运行统计（fireCount/failCount/lastFiredAt/lastResult）不再存进 trigger.json
    // （定义是不可变配置），改从审计日志按需汇总。受日志保留期限制，是保留窗口内的统计。
    let stats: { fireCount: number; failCount: number; lastFiredAt?: number; lastResult?: string } = { fireCount: 0, failCount: 0 };
    try {
      if (scheduler?.stats) stats = scheduler.stats(definition.id);
    } catch { /* 审计日志缺失/损坏时退回零值 */ }
    return {
      id: definition.id,
      name: definition.name,
      enabled: definition.enabled,
      scheduleType: schedule.scheduleType,
      scheduleValue: schedule.scheduleValue,
      nextFireAt: definition.source.type === 'delay'
        ? definition.createdAt + definition.source.afterMs
        : definition.source.type === 'at'
          ? new Date(definition.source.at).getTime()
          : definition.source.type === 'event'
            ? undefined
            : schedulerDetails?.schedule?.nextFireAt,
      targetChannel: target?.channelKey,
      targetChannelName: target?.channelKey,
      targetChannelId: target?.channelId,
      targetChannelType: target ? this.resolveChannelType(target.channelKey) : undefined,
      executionType: definition.execution.type,
      feedbackStrategy: definition.feedback.strategy,
      targetSessionStrategy: target?.session ?? 'main',
      targetThreadId: target?.threadId,
      model: definition.execution.model,
      effort: definition.execution.effort,
      permissionMode: definition.execution.permissionMode,
      prompt: this.triggerPrompt(definition),
      createdByPeerId: definition.origin?.peerId ?? '',
      createdByChannel: definition.origin?.channelKey ?? '',
      schedulerAid: definition.agentAid,
      fireCount: stats.fireCount,
      failCount: stats.failCount,
      lastFiredAt: stats.lastFiredAt,
      lastResult: stats.lastResult,
      lastScheduledAt: schedulerDetails?.schedule?.lastScheduledAt,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      status: definition.enabled ? 'active' : 'disabled',
      limits: definition.limits,
      limitState: schedulerDetails?.limitState,
      subscription: schedulerDetails?.subscription,
    };
  }

  private applyFeedbackPatch(
    definition: TriggerDefinition,
    patch: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'feedback patch 必须是对象' };
    }
    const raw = patch as Record<string, any>;
    for (const key of Object.keys(raw)) {
      if (!['strategy', 'target', 'onReply', 'onNoop', 'onFailure'].includes(key)) {
        return { ok: false, error: `无效 feedback 字段: ${key}` };
      }
    }
    if (raw.strategy !== undefined) {
      if (raw.strategy !== 'origin' && raw.strategy !== 'target' && raw.strategy !== 'silent') {
        return { ok: false, error: `无效 feedback.strategy: ${raw.strategy}` };
      }
      definition.feedback.strategy = raw.strategy;
    }
    if (raw.target !== undefined) {
      if (!raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) {
        return { ok: false, error: 'feedback.target 必须是对象' };
      }
      const target = raw.target as Record<string, any>;
      definition.feedback.target = {
        channelKey: String(target.channelKey ?? target.channel ?? ''),
        channelId: String(target.channelId ?? ''),
        session: target.session === 'thread' ? 'thread' : 'main',
        threadId: target.threadId ? String(target.threadId) : undefined,
      };
    }
    for (const branch of ['onReply', 'onNoop', 'onFailure'] as const) {
      if (raw[branch] === undefined) continue;
      if (definition.execution.type !== 'script') return { ok: false, error: `${branch} 仅适用于 script trigger` };
      const branchPatch = raw[branch];
      if (!branchPatch || typeof branchPatch !== 'object' || Array.isArray(branchPatch)) {
        return { ok: false, error: `feedback.${branch} 必须是对象` };
      }
      definition.feedback[branch] = { template: branchPatch.template !== undefined ? String(branchPatch.template) : undefined };
    }
    return { ok: true };
  }

  private primaryFeedbackTarget(definition: TriggerDefinition): TriggerFeedbackTarget | undefined {
    if (definition.feedback.strategy === 'target') return definition.feedback.target;
    if (!definition.origin) return undefined;
    return {
      channelKey: definition.origin.channelKey,
      channelId: definition.origin.channelId,
      session: definition.origin.session,
      threadId: definition.origin.threadId,
    };
  }

  private canAccessTriggerDefinition(definition: TriggerDefinition, peerId: string, channel: string, isAdmin: boolean): boolean {
    if (isAdmin) return true;
    return definition.origin?.peerId === peerId && definition.origin?.channelKey === channel;
  }

  private triggerPermissionFromParsed(
    parsed: { permissionMode?: TriggerPermissionMode },
    isAdmin: boolean,
  ): TriggerPermissionMode {
    if (parsed.permissionMode) return parsed.permissionMode;
    return isAdmin ? 'bypass' : 'readonly';
  }

  private validateTriggerPermissionModeForRole(
    mode: TriggerPermissionMode | undefined,
    isAdmin: boolean,
  ): string | undefined {
    if (mode === 'bypass' && !isAdmin) return '无权限：只有 owner/admin 可以创建或修改 bypass trigger';
    return undefined;
  }

  private findTriggerDefinition(
    scheduler: TriggerRuntimeScheduler,
    nameOrId: string,
    peerId: string,
    channel: string,
    isAdmin: boolean,
  ): TriggerDefinition | undefined {
    return scheduler
      .list({ all: true })
      .find(definition =>
        (definition.id === nameOrId || definition.name === nameOrId)
        && this.canAccessTriggerDefinition(definition, peerId, channel, isAdmin));
  }

  private async buildTriggerDefinitionFromParsed(
    parsed: ParsedTriggerSet,
    channel: string,
    channelId: string,
    peerId: string,
    isAdmin: boolean,
    messageId?: string,
    threadId?: string,
  ): Promise<{ definition: TriggerDefinition; scheduler: TriggerRuntimeScheduler } | { error: string }> {
    const now = Date.now();
    const id = `trig_${now}_${crypto.randomBytes(4).toString('hex')}`;
    const name = parsed.name ?? `trigger-${now.toString(36)}`;
    const feedbackChannel = parsed.targetChannel ?? channel;
    if (parsed.targetChannel && !this.adapters.has(parsed.targetChannel)) {
      return { error: `目标渠道不存在或未启用：${parsed.targetChannel}` };
    }

    const targetChannelType = this.resolveChannelType(feedbackChannel);
    const feedbackChannelId = parsed.targetChannelId ?? channelId;
    if (targetChannelType === 'aun' && parsed.targetChannelId && !parsed.targetChannelId.includes('.')) {
      return { error: `AUN 渠道的 --target-channel-id 必须是 AID 格式（如 user.agentid.pub），收到："${parsed.targetChannelId}"` };
    }

    const schedulerAid = parsed.agentId
      ?? this.getOwningAgent(feedbackChannel)?.aid
      ?? tryParseChannelKey(feedbackChannel)?.selfAID
      ?? this.triggerSchedulerFallbackAid;
    const scheduler = schedulerAid ? this.getTriggerSchedulerForAgent(schedulerAid) : this.triggerSchedulerFallback;
    if (!schedulerAid || !scheduler) {
      return { error: `目标 agent 不存在或未就绪：${schedulerAid ?? feedbackChannel}` };
    }

    const target: TriggerFeedbackTarget = {
      channelKey: feedbackChannel,
      channelId: feedbackChannelId,
      session: parsed.targetSession,
      threadId: parsed.targetSession === 'thread' ? parsed.targetThreadId : undefined,
    };
    if (target.session === 'thread') {
      const adapter = this.adapters.get(feedbackChannel);
      if (!adapter?.capabilities.thread) return { error: '目标渠道不支持 thread 会话' };
      if (!target.threadId) return { error: '--target-session thread 需要 --target-thread-id' };
    }

    const activeSession = this.sessionManager.getActiveSessionSync(channel, channelId);
    const origin: TriggerDefinition['origin'] = {
      channelKey: channel,
      channelId,
      session: threadId ? 'thread' : 'main',
      threadId,
      peerId,
      sessionKey: activeSession?.sessionKey,
    };

    if (!isAdmin && parsed.feedbackStrategy === 'target' && !sameFeedbackTarget(target, origin)) {
      return { error: '无权限：非 admin 只能把 trigger 投递到来源会话' };
    }

    const source = this.triggerSourceFromSchedule(parsed.scheduleType, parsed.scheduleValue);
    if (parsed.timezone && source.type === 'cron') {
      (source as any).timezone = parsed.timezone;
    }

    const script = parsed.scriptPath ? {
      path: parsed.scriptPath,
      runtime: parsed.scriptRuntime!,
      args: parsed.scriptArgs,
      timeoutMs: parsed.scriptTimeoutMs ?? 30_000,
    } : undefined;

    const permissionMode = this.triggerPermissionFromParsed(parsed, isAdmin);
    const permissionError = this.validateTriggerPermissionModeForRole(permissionMode, isAdmin);
    if (permissionError) return { error: permissionError };

    const definition: TriggerDefinition = {
      $schema_version: 4,
      id,
      agentAid: schedulerAid,
      enabled: true,
      name,
      createdAt: now,
      updatedAt: now,
      origin,
      source,
      execution: {
        type: parsed.executionType,
        ...(script ? { script } : { prompt: parsed.prompt || '' }),
        ...(parsed.executionType === 'trigger_session' ? { thread: parsed.triggerThread ?? 'per_run' } : {}),
        model: parsed.model,
        effort: parsed.effort,
        permissionMode,
        onError: 'retry',
        noopSentinel: '[[NOOP]]',
      },
      feedback: {
        strategy: parsed.feedbackStrategy,
        ...(parsed.feedbackStrategy === 'target' ? { target } : {}),
      },
      reliability: {
        concurrency: 'forbid' as const,
        missedPolicy: 'run_once' as const,
        retry: { maxAttempts: 0, backoffMs: 30_000 },
      },
      limits: this.limitsFromParsed(parsed),
    };

    return { definition, scheduler };
  }

  /** 返回当前通道的有效项目路径：从 owning agent 取。*/
  private getEffectiveDefaultPath(channel: string): string {
    const owning = this.getOwningAgent(channel);
    if (owning) return owning.projectPath;
    return process.cwd();
  }


  /**
   * 持久化 baseagent.model：写到 agent config.json；找不到 owning agent 时
   * 退到用户级 ~/.claude/settings.json（Claude 专用）。
   */
  private persistBaseagentModel(channel: string, baseagentName: string, newModel: string | undefined): string | undefined {
    const owning = this.getOwningAgent(channel);
    if (owning) {
      try {
        owning.setBaseagentModel(newModel, baseagentName);
      } catch (e: any) {
        return `⚠️ 写入 agent config 失败: ${e?.message || e}`;
      }
      return undefined;
    }
    // 无 owning agent（罕见，新结构下应当不会发生）→ 仅 Claude 走用户级 fallback
    if (baseagentName !== 'claude') {
      return `⚠️ 找不到通道 "${channel}" 所属的 self-agent`;
    }
    const updates: { model?: string; effortLevel?: string } = {};
    if (newModel) updates.model = newModel;
    const writeResult = writeUserSettings(updates);
    // writeUserSettings 已禁用写入，总是返回 success: true
    if (!writeResult.success) {
      return `⚠️ 写入用户配置失败: ${writeResult.error}`;
    }
    return undefined;
  }

  /**
   * 持久化 baseagent.effort：写到 agent config.json；找不到时退到用户级 settings。
   */
  private persistBaseagentEffort(channel: string, baseagentName: string, newEffort: string | undefined): string | undefined {
    const owning = this.getOwningAgent(channel);
    if (owning) {
      try {
        owning.setBaseagentEffort(newEffort, baseagentName);
      } catch (e: any) {
        return `⚠️ 写入 agent config 失败: ${e?.message || e}`;
      }
      return undefined;
    }
    if (baseagentName !== 'claude') {
      return `⚠️ 找不到通道 "${channel}" 所属的 self-agent`;
    }
    const updates: { effortLevel?: string | null } = { effortLevel: newEffort ?? null };
    const writeResult = writeUserSettings(updates);
    // writeUserSettings 已禁用写入，总是返回 success: true
    if (!writeResult.success) {
      return `⚠️ 写入用户配置失败: ${writeResult.error}`;
    }
    return undefined;
  }

  /** 项目列表快捷访问（无 channel 上下文时的 fallback，尽量不用） */
  private get projects(): Record<string, string> {
    return {};
  }

  /** 根据项目路径查找配置中的项目名称 */
  private getConfiguredProjectName(projectPath: string): string | undefined {
    return Object.entries(this.projects).find(([_, p]) => p === projectPath)?.[0];
  }

  /** 根据项目路径查找项目名称（未配置时回退到目录名） */
  private getProjectName(projectPath: string): string {
    return this.getConfiguredProjectName(projectPath) || path.basename(projectPath);
  }

  /** 格式化运行时间 */
  private formatUptime(ms: number): string {
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}天`);
    if (h > 0) parts.push(`${h}时`);
    if (m > 0) parts.push(`${m}分`);
    if (parts.length === 0) parts.push(`${s}秒`);
    return parts.join('');
  }

  /** 获取消息队列 key：话题用 session.id，主会话用 channel-channelId */
  private getQueueKey(session: Session | undefined, _channel: string, _channelId: string): string {
    // 队列和 agent 均使用 session.id 作为 key
    return session?.id || '';
  }

  /** 从 session 提取渠道预构建的回复上下文 */
  private getReplyContext(session: Session): import('../../types.js').ReplyContext | undefined {
    return session.metadata?.replyContext;
  }

  /**
   * 发送 CommandCard 卡片。卡片成功返回 null（调用方直接 return），失败返回降级文本。
   * CommandCard 不进 InteractionRouter，按钮点击由 channel 直接构造伪命令入站消息。
   *
   * 走统一 adapter.send(envelope, { kind: 'interaction', ... }) 入口。
   */
  private async sendCommandCard(opts: {
    channel: string;
    channelId: string;
    interaction: InteractionRequest;
    replyCtx?: ReplyContext;
    canWrite?: boolean;
  }): Promise<string | null> {
    const adapter = this.adapters.get(opts.channel);
    if (opts.interaction.kind.kind !== 'command-card') {
      logger.warn(`[CommandHandler] sendCommandCard called with non-CommandCard kind`);
      return null;
    }
    const card = opts.interaction.kind;

    if (opts.canWrite === false) return renderCommandCardAsText(card);
    if (!adapter?.send) return renderCommandCardAsText(card);

    try {
      const envelope = buildEnvelope({
        channel: opts.channel,
        channelId: opts.channelId,
        agentName: this.agentRegistry?.resolveByChannel(opts.channel)?.name,
        replyContext: opts.replyCtx,
      });
      const fallbackText = renderCommandCardAsText(card);
      const messageId = await sendInteractionPayload(
        adapter,
        envelope,
        opts.interaction,
        fallbackText,
        opts.replyCtx,
      );
      if (messageId) return null;
    } catch (e) {
      logger.warn(`[CommandHandler] sendCommandCard failed: ${e}`);
    }
    return renderCommandCardAsText(card);
  }

  /**
   * 通用降级应答入口：按 (sessionId, fallbackCommand) 查找 pending interaction 并路由。
   * 返回 { matched: true } 表示已处理，调用方直接返回 result。
   */
  private async handleInteractionFallback(
    command: string,
    args: string,
    sessionId: string,
    userId?: string,
  ): Promise<{ matched: boolean; result?: string }> {
    if (!this.interactionRouter) return { matched: false };

    const pendingId = this.interactionRouter.findPendingByCommand(sessionId, command);
    if (!pendingId) return { matched: false };

    const initiatorId = this.interactionRouter.getInitiator(pendingId);
    if (initiatorId && userId && initiatorId !== userId) {
      return { matched: true, result: '⚠️ 仅卡片发起者可应答' };
    }

    this.interactionRouter.handle({
      type: 'interaction.response',
      id: pendingId,
      action: args,
      operatorId: userId,
    });
    return { matched: true, result: '✓ 已回答' };
  }

  setProcessor(processor: IMessageProcessor): void {
    this.processor = processor;
  }

  setMessageQueue(messageQueue: MessageQueue): void {
    this.messageQueue = messageQueue;
  }

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  setInteractionRouter(router: InteractionRouter): void {
    this.interactionRouter = router;
  }

  setStatsCollector(collector: StatsCollector): void {
    this.statsCollector = collector;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelName, adapter);
  }

  registerChannel(name: string, channel: any, channelType?: string): void {
    this.channelObjects.set(name, channel);
    if (channelType) this.channelTypeMap.set(name, channelType);
  }

  /** 将实例名解析为渠道类型（用于 session 查询） */
  private resolveChannelType(channelName: string): string {
    return this.channelTypeMap.get(channelName) || tryParseChannelKey(channelName)?.type || channelName;
  }

  /** CommandCard success is acknowledged by the card UI; failures still return command.error text. */
  private shouldSuppressCardTriggerResult(source: 'user' | 'card-trigger' | undefined, _channel: string): boolean {
    return source === 'card-trigger';
  }

  /**
   * 从 channel key（<type>#<selfAID>#<name>）解析本地身份 AID。
   * 非 evolagent 通道（裸 channelType，如 'feishu'）解析失败返回 undefined。
   * aun 通道创建 session 时必须提供 selfAID，故所有 getOrCreateSession 调用都经此兜底。
   */
  private resolveSelfAID(channel: string): string | undefined {
    return tryParseChannelKey(channel)?.selfAID;
  }

  private resolveCtlIdentity(session: Session, userId?: string): SessionIdentity {
    const parsed = tryParseChannelKey(session.channel);
    const owningAgent = this.getOwningAgent(session.channel);
    const selfAid = session.selfAID || owningAgent?.aid || parsed?.selfAID;
    const channelType = session.channelType || parsed?.type || this.resolveChannelType(session.channel);
    const chatType = session.chatType === 'group' ? 'group' : 'private';
    const actorId = userId || session.metadata?.peerId;
    const conversationId = chatType === 'group'
      ? (session.metadata?.groupId || session.channelId)
      : actorId;

    if (!selfAid || !actorId || !conversationId) {
      const fallback = session.identity ?? this.sessionManager.resolveIdentity(session.channel, userId, chatType, conversationId ?? undefined);
      logger.info(`[ctl] identity fallback: sessionId=${session.id} role=${fallback.role} selfAid=${selfAid ?? 'none'} actor=${actorId ?? 'none'} conversation=${conversationId ?? 'none'}`);
      return fallback;
    }

    const detail = resolvePeerRoleDetail({
      selfAid,
      channelType,
      chatType,
      actorId,
      conversationId,
      peerType: (session.metadata as any)?.peerType,
    });
    logger.info(`[ctl] identity resolved: sessionId=${session.id} role=${detail.effectiveRole} source=${detail.source} selfAid=${selfAid} actor=${actorId} conversation=${conversationId}`);
    return roleToSessionIdentity(detail.effectiveRole);
  }

  registerPolicy(channelName: string, policy: ChannelPolicy): void {
    this.policies.set(channelName, policy);
  }

  /**
   * 注销渠道（热重载断开渠道时调用）。清理所有按实例名登记的 map，
   * 避免死实例残留在 /status、菜单路由和 adapter 查找里。
   */
  unregisterChannel(channelName: string): void {
    this.adapters.delete(channelName);
    this.channelObjects.delete(channelName);
    this.channelTypeMap.delete(channelName);
    this.policies.delete(channelName);
  }

  getAdapter(channelName: string): ChannelAdapter | undefined {
    // 先按实例名查找，再按 channelType 查找
    let adapter = this.adapters.get(channelName);
    if (adapter) return adapter;
    for (const [name, a] of this.adapters) {
      if ((this.channelTypeMap.get(name) || name) === channelName) return a;
    }
    return undefined;
  }

  private getPolicy(channel: string): ChannelPolicy {
    return this.policies.get(channel) || {
      canSwitchProject: () => true,
      canListProjects: () => true,
      canCreateSession: () => true,
      canDeleteSession: () => true,
      canImportCliSession: () => true,
      messagePrefix: () => '',
      showMiddleResult: () => true,
      showIdleMonitor: () => true,
      accumulateErrors: () => true,
    };
  }

  private resolveMenuChatType(channel: string, channelId: string, explicit?: MenuChatType): MenuChatType {
    if (explicit) return explicit;
    const active = this.sessionManager.getActiveSessionSync(channel, channelId);
    return active?.chatType === 'group' ? 'group' : 'private';
  }

  private canReadTopics(role: string): boolean {
    return role !== 'none';
  }

  private canDeleteTopic(role: string, chatType: MenuChatType, topic: Session, userId?: string): boolean {
    if (role === 'none') return false;
    if (isAdminRole(role)) return true;
    if (chatType === 'group') return false;
    return !!userId && topic.metadata?.peerId === userId;
  }

  private buildTopicMenuItem(s: Session): MenuItem {
    const displayName = displaySessionTitle(s.name, s.threadId || s.id.slice(0, 8));
    const item: MenuItem = {
      value: s.threadId,
      label: displayName,
    };
    if (s.agentSessionId) {
      item.agentSessionId = s.agentSessionId;
      const fileInfo = this.sessionManager.getSessionFileInfo(s.projectPath, s.agentSessionId, s.baseagent);
      if (fileInfo.turns) item.turns = fileInfo.turns;
      const firstMsg = this.sessionManager.readSessionFirstMessage(s.projectPath, s.agentSessionId, s.baseagent);
      if (firstMsg) item.preview = firstMsg.length > 80 ? firstMsg.slice(0, 80) + '...' : firstMsg;
    }
    if (s.updatedAt) item.lastActive = s.updatedAt;
    return item;
  }

  /**
   * 返回结构化命令菜单（供 menu.query 使用）
   * owner 看到全部命令，admin 看到管理级命令（不含 owner-only），visitor/member 仅看到用户级命令
   */
  getMenuItems(role: string, chatType: string = 'private', scope: 'agent' | 'control' = 'agent'): { group: string; commands: MenuItem[] }[] {
    return menuGetMenuItems.call(this, role, chatType, scope);
  }

  /** 动态子菜单：根据 cmd 路径返回选项列表（供 menu.query + cmd 使用） */
  async getSubMenuItems(cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>, overrideIdentity?: import('../../types.js').SessionIdentity, explicitChatType?: MenuChatType, fromControlChannel = false): Promise<MenuItem[] | null> {
    return await menuGetSubMenuItems.call(this, cmd, channel, channelId, userId, args, overrideIdentity, explicitChatType, fromControlChannel);
  }

  // ── Menu Protocol exec ────────────────────────────────────────────────

  private async loadMenuContext(channel: string, channelId: string) {
    const session = await this.sessionManager.getActiveSession(channel, channelId);
    const evolagent = this.agentRegistry?.resolveByChannel(channel) ?? null;
    return { session, evolagent };
  }

  private requireSession<T extends { id: string }>(s: T | null | undefined):
    { error: string; code: string } | null {
    return s ? null : { error: '当前无活跃会话', code: 'NO_ACTIVE_SESSION' };
  }

  /** menu.query — 查询当前值。 */
  async execMenuQuery(
    cmd: string, channel: string, channelId: string, userId?: string, args?: Record<string, any>, explicitChatType?: MenuChatType, fromControlChannel = false, overrideIdentity?: import('../../types.js').SessionIdentity
  ): Promise<{ data: any } | { error: string; code?: string }> {
    return await menuExecMenuQuery.call(this, cmd, channel, channelId, userId, args, explicitChatType, fromControlChannel, overrideIdentity);
  }

  /** menu.update — 写入新值。 */
  async execMenuUpdate(
    cmd: string, value: string, channel: string, channelId: string, userId?: string,
    overrideIdentity?: import('../../types.js').SessionIdentity, fromControlChannel = false,
    args?: Record<string, any>
  ): Promise<{ data: any } | { error: string; code?: string }> {
    return await menuExecMenuUpdate.call(this, cmd, value, channel, channelId, userId, overrideIdentity, fromControlChannel, args);
  }

  /** menu.action — 触发动词。 */
  async execMenuAction(
    cmd: string, action: string, args: any, channel: string, channelId: string, userId?: string,
    overrideIdentity?: import('../../types.js').SessionIdentity,
    explicitChatType?: MenuChatType,
    requestId?: string,
    fromControlChannel = false
  ): Promise<{ data: any } | { error: string; code?: string }> {
    return await menuExecMenuAction.call(this, cmd, action, args, channel, channelId, userId, overrideIdentity, explicitChatType, requestId, fromControlChannel);
  }

  /** ECWeb 专用入口：注入 owner identity，进程级操作检查 owners 非空。不暴露 cli。 */
  async execMenuForEcweb(payload: any): Promise<import('../../types.js').MenuResponse> {
    return await menuExecMenuForEcweb.call(this, payload);
  }

  /** 控制 AID channel 专用入口：peerId 须 ∈ evolclaw.owners，全量权限。 */
  async execMenuForControl(payload: any, peerId: string): Promise<import('../../types.js').MenuResponse> {
    return await menuExecMenuForControl.call(this, payload, peerId);
  }

  /**
   * CLI 透传执行：spawn `node dist/cli/index.js <argv>` 子进程，捕获输出回传。
   * 不 in-process 调用（CLI handler 用 console.log + process.exit，spawn 行为与终端一致且隔离）。
   * 调用方已完成 owner 校验与白名单过滤。
   */
  private async execCliPassthrough(
    argv: string[]
  ): Promise<{ data: any } | { error: string; code?: string }> {
    const { spawn } = await import('child_process');
    const cliEntry = path.join(getPackageRoot(), 'dist', 'cli', 'index.js');
    const startedAt = Date.now();
    const logPath = path.join(resolvePaths().root, 'logs', 'menu-cli-exec.log');

    // 确保日志目录存在
    try {
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    } catch {}

    const logEntry = (msg: string) => {
      try {
        const ts = new Date().toISOString();
        fs.appendFileSync(logPath, `[${ts}] ${msg}\n`, 'utf-8');
      } catch {}
    };

    logEntry(`CALL: argv=${JSON.stringify(argv)} cwd=${process.cwd()}`);

    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let total = 0;
      let truncated = false;
      let settled = false;
      let stdoutChunks = 0;
      let stderrChunks = 0;

      const child = spawn('node', [cliEntry, ...argv], {
        env: { ...process.env, EVOLCLAW_HOME: resolvePaths().root },
        windowsHide: true,
      });

      logEntry(`SPAWN: pid=${child.pid} at=${startedAt}`);

      const append = (buf: Buffer, sink: 'out' | 'err') => {
        if (truncated) return;
        const remaining = CLI_EXEC_MAX_OUTPUT - total;
        if (remaining <= 0) { truncated = true; return; }
        const chunk = buf.length > remaining ? buf.subarray(0, remaining) : buf;
        total += chunk.length;
        if (sink === 'out') {
          stdout += chunk.toString('utf-8');
          stdoutChunks++;
        } else {
          stderr += chunk.toString('utf-8');
          stderrChunks++;
        }
        if (buf.length > remaining) truncated = true;
      };
      child.stdout?.on('data', (b: Buffer) => {
        append(b, 'out');
        logEntry(`STDOUT: chunk_size=${b.length} total_chunks=${stdoutChunks} elapsed=${Date.now() - startedAt}ms`);
      });
      child.stderr?.on('data', (b: Buffer) => {
        append(b, 'err');
        logEntry(`STDERR: chunk_size=${b.length} total_chunks=${stderrChunks} elapsed=${Date.now() - startedAt}ms`);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        logEntry(`TIMEOUT: after=${CLI_EXEC_TIMEOUT_MS}ms stdout_size=${stdout.length} stderr_size=${stderr.length}`);
        logger.warn(`[CommandHandler] cli exec timeout: ${argv.join(' ')}`);
        resolve({ error: `执行超时（${CLI_EXEC_TIMEOUT_MS / 1000}s）：${argv[0]}`, code: 'TIMEOUT' });
      }, CLI_EXEC_TIMEOUT_MS);

      child.on('error', (e: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logEntry(`ERROR: ${e?.message || String(e)} elapsed=${Date.now() - startedAt}ms`);
        resolve({ error: e?.message || String(e), code: 'INTERNAL' });
      });

      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const elapsed = Date.now() - startedAt;
        logEntry(`CLOSE: exitCode=${exitCode} elapsed=${elapsed}ms stdout_size=${stdout.length} stderr_size=${stderr.length} truncated=${truncated}`);
        resolve({ data: {
          exitCode: exitCode ?? -1,
          stdout, stderr, truncated,
          durationMs: elapsed,
        } });
      });
    });
  }

  /** 把 menu.action 委派给已有 slash 命令处理逻辑，把 OutboundPayload 包成结构化结果。 */
  private async delegateAsAction(
    action: string, slashCmd: string, channel: string, channelId: string, userId?: string,
    opts: { enrichSession?: boolean; overrideIdentity?: import('../../types.js').SessionIdentity } = {}
  ): Promise<{ data: any } | { error: string; code?: string }> {
    try {
      const result = await this._handleInternal(slashCmd, channel, channelId, undefined, userId, undefined, undefined, undefined, undefined, undefined, opts.overrideIdentity);
      if (result == null) {
        // null / undefined: 命令未识别或前置守卫拦截（如 idle 检查），视为失败
        return { error: '命令未执行（可能被前置守卫拦截）', code: 'EXEC_FAILED' };
      }
      if (typeof result !== 'object' || !('kind' in result)) {
        return { data: { action, success: true } };
      }
      const payload = result as any;
      if (payload.kind === 'command.error') {
        return { error: payload.text || '执行失败', code: 'EXEC_FAILED' };
      }
      const data: Record<string, any> = payload.structured && typeof payload.structured === 'object'
        ? { ...payload.structured }
        : {};
      data.action = action;
      data.success = true;
      if (payload.text) data.message = payload.text;
      if (payload.structured && typeof payload.structured === 'object') {
        data.structured = payload.structured;
      }
      // 对于切换/创建类动作，附加切换后的活跃 session 信息便于客户端继续操作
      if (opts.enrichSession) {
        const newSession = await this.sessionManager.getActiveSession(channel, channelId);
        if (newSession) {
          data.session = { id: newSession.id, name: newSession.name || null };
          if (newSession.agentSessionId) data.session.agentSessionId = newSession.agentSessionId;
        }
      }
      return { data };
    } catch (e: any) {
      return { error: e?.message || String(e), code: 'INTERNAL' };
    }
  }

  isCommand(content: string): boolean {
    return isQuickCommand(content);
  }

  /**
   * 主命令处理入口
   */
  async handle(
    content: string,
    channel: string,
    channelId: string,
    sendMessage?: (channelId: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => Promise<void>,
    userId?: string,
    threadId?: string,
    chatType?: string,
    source?: 'user' | 'card-trigger',
    messageId?: string,
    selfAID?: string,
    overrideIdentity?: import('../../types.js').SessionIdentity,
  ): Promise<OutboundPayload | string | null | undefined> {
    try {
      const result = await this._handleInternal(content, channel, channelId, sendMessage, userId, threadId, chatType, source, messageId, selfAID, overrideIdentity);
      return result;
    } catch (error) {
      if (error instanceof BaseagentRunnerUnavailableError) {
        logger.error(`[CommandHandler] baseagent mismatch blocked: channel=${channel} requested=${error.baseagent} owner=${error.evolagentName} available=${error.availableBaseagents.join(',') || '<none>'}`);
        return { kind: 'command.error' as const, text: this.formatBaseagentUnavailable(error), reason: error.code };
      }
      throw error;
    }
  }

  private async _handleInternal(
    content: string,
    channel: string,
    channelId: string,
    sendMessage?: (channelId: string, text: string, opts?: { replyToMessageId?: string; replyInThread?: boolean }) => Promise<void>,
    userId?: string,
    threadId?: string,
    chatType?: string,
    source?: 'user' | 'card-trigger',
    messageId?: string,
    selfAID?: string,
    overrideIdentity?: import('../../types.js').SessionIdentity,
  ): Promise<OutboundPayload | null | undefined> {
    return await handleSlashCommand.call(this, content, channel, channelId, sendMessage, userId, threadId, chatType, source, messageId, selfAID, overrideIdentity);
  }

  private async handleTriggerCommand(
    scheduler: TriggerRuntimeScheduler,
    content: string,
    channel: string,
    channelId: string,
    peerId: string,
    isAdmin: boolean,
    messageId?: string,
    threadId?: string,
  ): Promise<string> {
    if (content === '/trigger') {
      const visible = scheduler
        .list()
        .filter(definition => this.canAccessTriggerDefinition(definition, peerId, channel, isAdmin));
      if (visible.length === 0) return '📭 当前没有活跃的触发器';
      const lines = visible.map(definition => {
        const view = this.definitionToTriggerView(definition, scheduler);
        const next = view.nextFireAt ? new Date(view.nextFireAt).toLocaleString() : '未计算';
        return `• **${view.name}** [${view.scheduleType}] 下次: ${next}`;
      });
      return `📋 活跃触发器（${visible.length} 个）：\n\n${lines.join('\n')}`;
    }

    const sub = content.slice('/trigger '.length).trim();

    if (sub === 'list' || sub.startsWith('list ')) {
      const includeDisabled = sub.includes('--all') || sub.includes('all');
      const visible = scheduler
        .list({ all: includeDisabled })
        .filter(definition => this.canAccessTriggerDefinition(definition, peerId, channel, isAdmin));
      if (visible.length === 0) return '📭 没有触发器记录';
      const lines = visible.map(definition => {
        const view = this.definitionToTriggerView(definition, scheduler);
        const next = view.nextFireAt ? new Date(view.nextFireAt).toLocaleString() : '未计算';
        const status = definition.enabled ? 'active' : 'disabled';
        return `• ${view.name} [${view.scheduleType}] ${status} | 下次: ${next}`;
      });
      return `📋 触发器（${visible.length} 个）：\n\n${lines.join('\n')}`;
    }

    // Helper: extract nameOrId and find trigger with permission check
    const extractAndFindTrigger = (sub: string, prefix: string, action: string): { definition: TriggerDefinition; nameOrId: string } => {
      const nameOrId = sub.slice(prefix.length).trim();
      if (!nameOrId) throw new Error(`❌ 用法：/trigger ${action} <名称>`);
      const definition = this.findTriggerDefinition(scheduler, nameOrId, peerId, channel, isAdmin);
      if (!definition) {
        throw new Error(
          isAdmin
            ? `❌ 未找到触发器：${nameOrId}`
            : `❌ 未找到触发器 "${nameOrId}"，或无权限${action === 'show' ? '查看' : '修改'}`
        );
      }
      return { definition, nameOrId };
    };

    if (sub.startsWith('cancel ')) {
      const { definition } = extractAndFindTrigger(sub, 'cancel ', 'cancel');
      const cancelled = scheduler.cancel(definition.id);
      this.eventBus.publish({ type: 'trigger:cancelled', triggerId: cancelled.id, name: cancelled.name, by: peerId });
      return `✅ 触发器已禁用：**${cancelled.name}**`;
    }

    if (sub.startsWith('delete ') || sub.startsWith('remove ') || sub.startsWith('rm ')) {
      const prefix = sub.startsWith('delete ') ? 'delete ' : sub.startsWith('remove ') ? 'remove ' : 'rm ';
      const { definition } = extractAndFindTrigger(sub, prefix, 'delete');
      const deleted = scheduler.delete(definition.id);
      return `✅ 触发器已删除：**${deleted.name}**`;
    }

    if (sub.startsWith('enable ')) {
      const { definition } = extractAndFindTrigger(sub, 'enable ', 'enable');
      scheduler.setEnabled(definition.id, true);
      return `✅ 触发器已启用：**${definition.name}**`;
    }

    if (sub.startsWith('disable ')) {
      const { definition } = extractAndFindTrigger(sub, 'disable ', 'disable');
      scheduler.setEnabled(definition.id, false);
      return `✅ 触发器已暂停：**${definition.name}**`;
    }

    if (sub.startsWith('show ')) {
      const { definition } = extractAndFindTrigger(sub, 'show ', 'show');
      const details = scheduler.show(definition.id);
      const view = this.definitionToTriggerView(definition, scheduler);
      const nextStr = view.nextFireAt ? new Date(view.nextFireAt).toLocaleString() : '未计算';
      const activeRuns = details.active?.length ?? 0;
      const recentRuns = details.recentRuns?.slice(0, 5) ?? [];
      let output = `📋 **${definition.name}** (${definition.id})\n`;
      output += `状态: ${definition.enabled ? 'active' : 'disabled'}\n`;
      output += `调度: ${view.scheduleType} | 下次: ${nextStr}\n`;
      output += `处理: ${definition.execution.type}\n`;
      output += `模型: ${definition.execution.model ?? 'inherit'}\n`;
      output += `推理强度: ${definition.execution.effort ?? 'inherit'}\n`;
      output += `权限: ${definition.execution.permissionMode ?? 'inherit'}\n`;
      output += `反馈: ${definition.feedback.strategy}\n`;
      if (definition.execution.type === 'script') output += `脚本: ${this.scriptCommandLabel(definition.execution.script!)}\n`;
      if (definition.limits?.maxRuns !== undefined || definition.limits?.maxDuration !== undefined) {
        const limitParts = [
          definition.limits.maxRuns !== undefined ? `maxRuns=${definition.limits.maxRuns}` : undefined,
          definition.limits.maxDuration !== undefined ? `maxDuration=${definition.limits.maxDuration}` : undefined,
        ].filter(Boolean);
        output += `限制: ${limitParts.join(', ')}\n`;
      }
      if (details.limitState) {
        const stateParts = [
          `runCount=${details.limitState.runCount}`,
          `startedAt=${new Date(details.limitState.startedAt).toLocaleString()}`,
          details.limitState.disabledReason ? `disabledReason=${details.limitState.disabledReason}` : undefined,
        ].filter(Boolean);
        if (definition.limits?.maxDuration) {
          stateParts.push(`expiresAt=${new Date(details.limitState.startedAt + this.limitDurationMs(definition.limits.maxDuration)).toLocaleString()}`);
        }
        output += `限制状态: ${stateParts.join(', ')}\n`;
      }
      output += `活跃运行: ${activeRuns}\n`;
      if (recentRuns.length > 0) {
        output += `\n最近运行:\n`;
        for (const r of recentRuns) {
          const ts = new Date(r.finishedAt).toLocaleString();
          output += `  • ${r.status} ${r.reason ?? ''} (${ts})\n`;
        }
      }
      return output;
    }

    if (sub.startsWith('run ')) {
      const args = sub.slice('run '.length).trim();
      const parts = args.split(/\s+/);
      const dryRunIdx = parts.indexOf('--dry-run');
      const dryRun = dryRunIdx >= 0;
      const nameOrId = dryRunIdx >= 0
        ? parts.filter((_, i) => i !== dryRunIdx).join(' ').trim()
        : args.trim();
      if (!nameOrId) return '❌ 用法：/trigger run <名称> [--dry-run]';

      const definition = this.findTriggerDefinition(scheduler, nameOrId, peerId, channel, isAdmin);
      if (!definition) {
        return isAdmin
          ? `❌ 未找到触发器：${nameOrId}`
          : `❌ 未找到触发器 "${nameOrId}"，或无权限执行`;
      }

      try {
        const result = await scheduler.run(definition.id, { dryRun });
        const prefix = dryRun ? '🔍 试运行' : '▶️ 手动触发';
        return `${prefix}：**${definition.name}**\n状态: ${result.status}${result.reason ? ` (${result.reason})` : ''}`;
      } catch (err: any) {
        return `❌ 执行失败：${err?.message || err}`;
      }
    }

    if (sub.startsWith('update ')) {
      const args = sub.slice('update '.length);
      const result = parseTriggerUpdate(args);
      if (!result.ok) return `❌ ${result.error}`;
      const updated = await this.updateTriggerFromPatch(
        scheduler,
        result.nameOrId,
        result.value,
        channel,
        channelId,
        peerId,
        isAdmin,
        messageId,
        threadId,
      );
      if (!updated.ok) return `❌ ${updated.error}`;
      const nextStr = updated.trigger.nextFireAt ? new Date(updated.trigger.nextFireAt).toLocaleString() : '未计算';
      return `✅ 触发器已更新：**${updated.trigger.name}**\n下次触发：${nextStr}`;
    }

    if (sub.startsWith('set ')) {
      const args = sub.slice('set '.length);
      const result = parseTriggerSet(args);
      if (!result.ok) return `❌ ${result.error}`;
      const reg = await this.registerTriggerFromParsed(result.value, channel, channelId, peerId, messageId, undefined, threadId, isAdmin);
      if (!reg.ok) return `❌ ${reg.error}`;
      const nextStr = reg.trigger.nextFireAt ? new Date(reg.trigger.nextFireAt).toLocaleString() : '未计算';
      return `✅ 触发器已注册：**${reg.trigger.name}**\n下次触发：${nextStr}`;
    }

    return `❌ 未知子命令。用法：
/trigger — 查看活跃触发器
/trigger list [--all] — 查看所有触发器
/trigger set <参数> — 注册触发器
/trigger update <名称|ID> <参数> — 修改触发器
常用参数：--delay/--at/--cron/--every、--prompt、--model、--effort、--permission
/trigger enable <名称|ID> — 启用触发器
/trigger disable <名称|ID> — 暂停触发器
/trigger show <名称|ID> — 查看触发器详情
/trigger run <名称|ID> [--dry-run] — 手动触发
/trigger cancel <名称|ID> — 禁用触发器（disable 的兼容别名）
/trigger delete <名称|ID> — 删除触发器`;
  }

  private async handleTrigger(
    content: string,
    channel: string,
    channelId: string,
    peerId: string,
    isAdmin: boolean,
    messageId?: string,
    _chatType?: string,
    threadId?: string,
  ): Promise<string> {
    const scheduler = this.getTriggerSchedulerForChannel(channel);
    if (!scheduler) return '⚠️ 触发器功能未启用';
    return await this.handleTriggerCommand(scheduler, content, channel, channelId, peerId, isAdmin, messageId, threadId);
  }

  async updateTriggerFromPatch(
    scheduler: TriggerRuntimeScheduler,
    nameOrId: string,
    patch: any,
    channel: string,
    channelId: string,
    peerId: string,
    isAdmin: boolean,
    messageId?: string,
    threadId?: string,
  ): Promise<{ ok: true; trigger: any } | { ok: false; error: string }> {
    const definition = this.findTriggerDefinition(scheduler, nameOrId, peerId, channel, isAdmin);
    if (!definition) {
      return { ok: false, error: isAdmin ? `未找到触发器：${nameOrId}` : `未找到触发器 "${nameOrId}"，或无权限修改` };
    }

    const updated: TriggerDefinition = JSON.parse(JSON.stringify(definition));

    if (patch.name !== undefined) updated.name = String(patch.name);

    if (patch.executionMode !== undefined) {
      return { ok: false, error: 'executionMode 已废弃，请使用 executionType' };
    }

    const requestedExecutionType = patch.executionType;
    if (requestedExecutionType !== undefined) {
      if (!['script', 'trigger_session', 'target_session'].includes(requestedExecutionType)) {
        return { ok: false, error: `无效 executionType: ${requestedExecutionType}` };
      }
      if (requestedExecutionType !== updated.execution.type) {
        updated.execution = {
          type: requestedExecutionType,
          ...(requestedExecutionType === 'script'
            ? { script: updated.execution.script ?? { path: String(patch.scriptPath ?? ''), runtime: String(patch.scriptRuntime ?? '') } }
            : { prompt: String(patch.prompt ?? this.triggerPrompt(definition)) }),
          ...(requestedExecutionType === 'trigger_session' ? { thread: patch.triggerThread ?? 'per_run' } : {}),
          model: updated.execution.model,
          effort: updated.execution.effort,
          permissionMode: updated.execution.permissionMode,
          onError: updated.execution.onError,
          noopSentinel: updated.execution.noopSentinel,
        } as TriggerDefinition['execution'];
      }
    }

    if (patch.prompt !== undefined) {
      if (updated.execution.type === 'script') updated.feedback.onReply = { template: String(patch.prompt) };
      else updated.execution.prompt = String(patch.prompt);
    }

    if (patch.scheduleType !== undefined || patch.scheduleValue !== undefined) {
      const current = this.scheduleViewFromSource(definition.source);
      const nextScheduleType = patch.scheduleType ?? current.scheduleType;
      const nextScheduleValue = String(patch.scheduleValue ?? current.scheduleValue);
      if (nextScheduleType === 'event') {
        if (!/^\*$|^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$|^[A-Za-z0-9_-]+:\*$/.test(nextScheduleValue)) {
          return { ok: false, error: `无效 eventPattern: ${nextScheduleValue}` };
        }
      }
      updated.source = this.triggerSourceFromSchedule(nextScheduleType, nextScheduleValue);
    }

    if (patch.eventFilter !== undefined) {
      if (updated.source.type !== 'event') return { ok: false, error: 'eventFilter 仅适用于 event trigger' };
      if (
        patch.eventFilter === null
        || patch.eventFilter === ''
        || (typeof patch.eventFilter === 'object' && Object.keys(patch.eventFilter).length === 0)
      ) {
        delete updated.source.filter;
      } else {
        updated.source.filter = patch.eventFilter;
      }
    }

    if (
      patch.targetChannel !== undefined
      || patch.targetChannelId !== undefined
      || patch.targetSession !== undefined
      || patch.targetSessionStrategy !== undefined
      || patch.targetThreadId !== undefined
    ) {
      const previousTarget = this.primaryFeedbackTarget(definition);
      if (!previousTarget) return { ok: false, error: '现有触发器缺少 target，无法更新目标' };
      const targetChannelName = patch.targetChannel ?? previousTarget.channelKey;
      if (patch.targetChannel && !this.adapters.has(patch.targetChannel)) {
        return { ok: false, error: `目标渠道不存在或未启用：${patch.targetChannel}` };
      }
      const targetAid = this.getOwningAgent(targetChannelName)?.aid ?? tryParseChannelKey(targetChannelName)?.selfAID ?? definition.agentAid;
      if (targetAid !== definition.agentAid) {
        return { ok: false, error: '暂不支持把 trigger 跨 agent 迁移，请新建触发器' };
      }

      const requestedSession = patch.targetSession ?? patch.targetSessionStrategy;
      if (requestedSession !== undefined && requestedSession !== 'main' && requestedSession !== 'thread') {
        return { ok: false, error: `无效 targetSession: ${requestedSession}` };
      }
      const patchThreadId = typeof patch.targetThreadId === 'string' && patch.targetThreadId.trim()
        ? patch.targetThreadId.trim()
        : undefined;
      const session = patchThreadId
        ? 'thread'
        : (requestedSession ?? previousTarget.session ?? 'main');
      const nextTarget: TriggerFeedbackTarget = {
        channelKey: targetChannelName,
        channelId: String(patch.targetChannelId ?? previousTarget.channelId),
        session,
        threadId: session === 'thread' ? String(patchThreadId ?? previousTarget.threadId ?? '') : undefined,
      };
      if (nextTarget.session === 'thread' && !nextTarget.threadId) return { ok: false, error: 'target session=thread 需要 targetThreadId' };
      if (!isAdmin && !sameFeedbackTarget(nextTarget, definition.origin)) {
        return { ok: false, error: '无权限：非 admin 只能把 trigger 投递到来源会话' };
      }
      updated.feedback.strategy = 'target';
      updated.feedback.target = nextTarget;
    }

    // Update optional new fields
    if (patch.timezone !== undefined && updated.source.type === 'cron') {
      (updated.source as any).timezone = patch.timezone || undefined;
    }

    if (patch.triggerThread !== undefined) {
      if (patch.triggerThread !== 'per_run' && patch.triggerThread !== 'by_trigger') return { ok: false, error: `无效 triggerThread: ${patch.triggerThread}` };
      if (updated.execution.type !== 'trigger_session') return { ok: false, error: 'triggerThread 仅适用于 trigger_session' };
      updated.execution.thread = patch.triggerThread;
    }

    if (patch.scriptPath !== undefined || patch.scriptRuntime !== undefined || patch.scriptArgs !== undefined || patch.scriptTimeoutMs !== undefined) {
      const previousScript = updated.execution.type === 'script' ? updated.execution.script : undefined;
      const scriptPath = patch.scriptPath === null
        ? undefined
        : (patch.scriptPath !== undefined ? String(patch.scriptPath) : previousScript?.path);
      const scriptRuntime = patch.scriptRuntime === null
        ? undefined
        : (patch.scriptRuntime !== undefined ? String(patch.scriptRuntime) : previousScript?.runtime);
      if (scriptPath && scriptRuntime) {
        const scriptArgs = patch.scriptArgs !== undefined
          ? patch.scriptArgs
          : (patch.scriptPath !== undefined ? undefined : previousScript?.args);
        updated.execution = {
          type: 'script',
          script: {
            path: scriptPath,
            runtime: scriptRuntime,
            args: scriptArgs,
            timeoutMs: patch.scriptTimeoutMs ?? previousScript?.timeoutMs ?? 30_000,
          },
          model: updated.execution.model,
          effort: updated.execution.effort,
          permissionMode: updated.execution.permissionMode,
          onError: 'retry',
          noopSentinel: '[[NOOP]]',
        };
      } else {
        return { ok: false, error: 'script trigger 需要 scriptPath 和 scriptRuntime' };
      }
    }

    if (patch.feedback !== undefined) {
      const applied = this.applyFeedbackPatch(updated, patch.feedback);
      if (!applied.ok) return { ok: false, error: applied.error };
    }

    if (patch.onFailure !== undefined) {
      if (updated.execution.type !== 'script') {
        return { ok: false, error: 'onFailure 仅适用于 script trigger' };
      }
      updated.feedback.onFailure = patch.onFailure === 'silent'
        ? { template: '' }
        : { template: '触发器失败：{{error.message}}' };
    }

    if (patch.onNoop !== undefined) {
      if (updated.execution.type !== 'script') {
        return { ok: false, error: 'onNoop 仅适用于 script trigger' };
      }
      updated.feedback.onNoop = patch.onNoop === 'notify'
        ? { template: '{{reply.text}}' }
        : { template: '' };
    }

    if (patch.maxRuns !== undefined || patch.maxDuration !== undefined) {
      const limits = updated.limits ? { ...updated.limits } : {};
      if (patch.maxRuns !== undefined) {
        if (patch.maxRuns === null || patch.maxRuns === '') delete limits.maxRuns;
        else limits.maxRuns = Number(patch.maxRuns);
      }
      if (patch.maxDuration !== undefined) {
        if (patch.maxDuration === null || patch.maxDuration === '') delete limits.maxDuration;
        else limits.maxDuration = String(patch.maxDuration);
      }
      updated.limits = Object.keys(limits).length > 0 ? limits : undefined;
    }

    if (patch.concurrency !== undefined) {
      if (patch.concurrency !== 'forbid' && patch.concurrency !== 'replace' && patch.concurrency !== 'allow') {
        return { ok: false, error: `无效 concurrency: ${patch.concurrency}` };
      }
      updated.reliability.concurrency = patch.concurrency;
    }

    if (patch.missedPolicy !== undefined) {
      if (patch.missedPolicy !== 'skip' && patch.missedPolicy !== 'run_once' && patch.missedPolicy !== 'run_all') {
        return { ok: false, error: `无效 missedPolicy: ${patch.missedPolicy}` };
      }
      updated.reliability.missedPolicy = patch.missedPolicy;
    }

    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === '') delete updated.execution.model;
      else updated.execution.model = String(patch.model);
    }

    if (patch.effort !== undefined) {
      if (patch.effort === null || patch.effort === '') delete updated.execution.effort;
      else updated.execution.effort = patch.effort as TriggerDefinition['execution']['effort'];
    }

    if (patch.permissionMode !== undefined) {
      if (patch.permissionMode === null || patch.permissionMode === '') {
        delete updated.execution.permissionMode;
      } else {
        const permissionMode = patch.permissionMode as TriggerPermissionMode;
        const permissionError = this.validateTriggerPermissionModeForRole(permissionMode, isAdmin);
        if (permissionError) return { ok: false, error: permissionError };
        updated.execution.permissionMode = permissionMode;
      }
    }

    try {
      const saved = scheduler.update(definition.id, updated);
      return { ok: true, trigger: this.definitionToTriggerView(saved, scheduler) };
    } catch (err: any) {
      return { ok: false, error: `更新失败：${err?.message || err}` };
    }
  }

  /** 从已解析的 trigger 参数组装 definition 并注册。文本路径（handleTrigger）与 menu 路径共用。
   *  parsed 形状 = parseTriggerSet 的 result.value（ParsedTriggerSet）。
   *  失败 return { ok:false, error }；成功 return { ok:true, trigger }。 */
  async registerTriggerFromParsed(
    parsed: ParsedTriggerSet,
    channel: string, channelId: string, peerId: string, messageId?: string,
    _chatType?: string,
    threadId?: string,
    isAdmin = false,
  ): Promise<{ ok: true; trigger: any } | { ok: false; error: string }> {
    const built = await this.buildTriggerDefinitionFromParsed(parsed, channel, channelId, peerId, isAdmin, messageId, threadId);
    if ('error' in built) return { ok: false, error: built.error };
    try {
      const created = built.scheduler.create(built.definition, [], { enable: true });
      return { ok: true, trigger: this.definitionToTriggerView(created, built.scheduler) };
    } catch (err: any) {
      return { ok: false, error: `注册失败：${err?.message || err}` };
    }
  }

  private limitsFromParsed(parsed: { maxRuns?: number; maxDuration?: string }): TriggerDefinition['limits'] {
    const limits: TriggerDefinition['limits'] = {};
    if (parsed.maxRuns !== undefined) limits.maxRuns = parsed.maxRuns;
    if (parsed.maxDuration !== undefined) limits.maxDuration = parsed.maxDuration;
    return limits.maxRuns === undefined && limits.maxDuration === undefined ? undefined : limits;
  }

  private scriptCommandLabel(script: NonNullable<TriggerDefinition['execution']['script']>): string {
    const args = Array.isArray(script.args) ? script.args.map(arg => this.shellQuoteArg(String(arg))).join(' ') : '';
    const command = this.shellQuoteArg(script.path);
    return `${script.runtime} ${command}${args ? ` ${args}` : ''}`;
  }

  private shellQuoteArg(value: string): string {
    if (!value) return "''";
    return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value;
  }

  private limitDurationMs(value: string): number {
    const amount = Number(value.slice(0, -1));
    const unit = value.slice(-1);
    if (unit === 'd') return amount * 86_400_000;
    if (unit === 'h') return amount * 3_600_000;
    if (unit === 'm') return amount * 60_000;
    return amount * 1_000;
  }

  // ── /rewind helpers ──

  private async handleRewindList(session: Session, agent: AgentRunnerFull): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(session.agentSessionId!, session.projectPath);
      const turns = this.buildTurnList(messages);

      if (turns.length === 0) {
        return '📋 当前会话暂无对话记录';
      }

      const lines = turns.map(t => `#${t.index} ${t.userContent}`);
      return [
        `📋 会话历史 (共 ${turns.length} 轮)`,
        '',
        ...lines,
        '',
        '💡 /rewind <N> chat|file|all — 撤销第N轮',
      ].join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Failed to read session messages:', error);
      return `❌ 读取会话历史失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  private async handleRewind(
    session: Session,
    agent: AgentRunnerFull,
    turnNum: number,
    mode: 'chat' | 'file' | 'all',
  ): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(session.agentSessionId!, session.projectPath);
      const turns = this.buildTurnList(messages);

      if (turnNum < 1 || turnNum > turns.length) {
        return `❌ 轮次超出范围，当前共 ${turns.length} 轮`;
      }

      // /rewind N = 撤销第N轮（及之后），保留 1..N-1
      const rewindTarget = turns[turnNum - 1]; // 被撤销的轮次（用于文件回退）
      const keepTarget = turnNum >= 2 ? turns[turnNum - 2] : null; // 保留到的轮次（用于对话回退）
      const results: string[] = [];

      // 文件回退（立即执行）
      if (mode === 'file' || mode === 'all') {
        if (!agent.rewindFiles) {
          return '❌ 当前 Agent 不支持文件回退';
        }
        const fileResult = await agent.rewindFiles(session.agentSessionId!, session.projectPath, rewindTarget.userUuid);
        if (!fileResult.canRewind) {
          if (mode === 'file') {
            return `❌ 当前会话无文件快照，无法回退文件${fileResult.error ? `\n原因: ${fileResult.error}` : ''}`;
          }
          results.push(`⚠️ 文件回退失败${fileResult.error ? `: ${fileResult.error}` : '（无文件快照）'}`);
        } else {
          const detail = fileResult.filesChanged
            ? `（恢复了 ${fileResult.filesChanged.length} 个文件）`
            : '';
          if (agent.capabilities?.fileRewind === 'git-head') {
            results.push(`✅ 已按 Git HEAD 恢复文件${detail}（Codex 当前不提供逐轮文件快照）`);
          } else {
            results.push(`✅ 已恢复文件到第 ${turnNum} 轮之前的状态${detail}`);
          }
        }
      }

      // 对话回退：Codex app-server 可直接 rollback；Claude 走 resumeAt 延迟到下次消息生效。
      if (mode === 'chat' || mode === 'all') {
        const discarded = turns.length - turnNum + 1;

        if (agent.rollbackSessionTurns) {
          const ok = await agent.rollbackSessionTurns(session.agentSessionId!, session.projectPath, discarded);
          if (!ok) return '❌ 对话回退失败';
          const meta = { ...(session.metadata || {}) };
          delete meta.resumeAt;
          await this.sessionManager.updateSession(session.id, { metadata: meta });
        } else if (keepTarget) {
          const meta = { ...(session.metadata || {}), resumeAt: keepTarget.assistantUuid };
          await this.sessionManager.updateSession(session.id, { metadata: meta });
        } else {
          // N=1：撤销全部对话，清空 session 从头开始
          const meta = { ...(session.metadata || {}) };
          delete meta.resumeAt;
          await this.sessionManager.updateSession(session.id, {
            metadata: meta,
            agentSessionId: null,
          });
        }

        results.push(
          `✅ 已撤销第 ${turnNum} 轮${discarded > 1 ? `及后续共 ${discarded} 轮` : ''}`,
          keepTarget ? `下次发言将从第 ${turnNum - 1} 轮继续` : '下次发言将开始全新对话'
        );
      }

      this.eventBus.publish({
        type: 'session:rewind',
        sessionId: session.id,
        turnNum,
        mode,
      });

      return results.join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Rewind failed:', error);
      return `❌ 回退失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }
  }

  private buildTurnList(messages: Array<{ type: string; uuid: string; message: unknown }>): Array<{
    index: number; userContent: string; userUuid: string; assistantUuid: string;
  }> {
    const turns: Array<{ index: number; userContent: string; userUuid: string; assistantUuid: string }> = [];
    let pendingUser: { content: string; uuid: string } | null = null;

    for (const msg of messages) {
      if (msg.type === 'user') {
        const m = msg.message as any;
        if (Array.isArray(m?.content) && m.content.every((c: any) => c.type === 'tool_result')) {
          continue;
        }
        const content = this.extractUserContent(msg.message);
        if (content) {
          pendingUser = { content, uuid: msg.uuid };
        }
      } else if (msg.type === 'assistant' && pendingUser) {
        turns.push({
          index: turns.length + 1,
          userContent: pendingUser.content,
          userUuid: pendingUser.uuid,
          assistantUuid: msg.uuid,
        });
        pendingUser = null;
      }
    }
    return turns;
  }

  // ── Agent Ctl ──

  private static readonly CTL_COMMANDS = [
    '/help', '/status', '/check', '/pwd',
    '/model', '/setmodel', '/effort', '/perm', '/agent', '/baseagent',
    '/compact', '/file', '/send', '/restart', '/aid', '/rpc', '/storage',
    '/rename', '/name', '/trigger',
    '/chatmode', '/dispatch', '/activity',
    '/queue',
  ];

  /** ctl 中仅允许查询形态的指令；写形态（带参）一律拒绝 */
  private static readonly CTL_READONLY = new Set(['/baseagent', '/setmodel']);

  /**
   * 从 session 恢复 ReplyContext，用于 ctl send 主动发送文本时的路由
   * - 群聊话题：metadata.replyContext.{threadId,peerId}
   * - 私聊：metadata.peerId
   * - taskId/chatmode：从 processing_state 和 effective chatmode 注入
   */
  private buildCtlReplyContext(session: Session): ReplyContext | undefined {
    const ctx: ReplyContext = {};
    const meta = session.metadata;
    if (meta?.replyContext?.threadId) ctx.threadId = meta.replyContext.threadId;
    if (meta?.replyContext?.peerId) ctx.peerId = meta.replyContext.peerId;
    if (!ctx.peerId && meta?.peerId) ctx.peerId = meta.peerId;
    // 话题（Feishu thread）路由：透传 replyToMessageId + replyInThread，
    // 否则 ctl send/file 会丢失话题归属、落到主会话气泡。
    if (meta?.replyContext?.replyToMessageId) ctx.replyToMessageId = meta.replyContext.replyToMessageId;
    if (meta?.replyContext?.replyInThread) ctx.replyInThread = meta.replyContext.replyInThread;

    const taskId = this.sessionManager.getActiveTaskId(session.id);
    const chatmode = this.resolveEffectiveChatmodeForSession(session);
    const encrypted = this.sessionManager.getSessionEncrypt(session.id);

    // 诊断日志：记录 task_id 解析结果
    logger.info(`[CommandHandler] buildCtlReplyContext: sessionId=${session.id} taskId=${taskId ?? 'none'} chatmode=${chatmode} threadId=${ctx.threadId ?? 'none'} replyTo=${ctx.replyToMessageId ?? 'none'} inThread=${ctx.replyInThread ?? false}`);

    if (taskId || chatmode !== 'interactive' || encrypted != null) {
      ctx.metadata = {};
      if (taskId) ctx.metadata.taskId = taskId;
      if (chatmode !== 'interactive') ctx.metadata.chatmode = chatmode;
      if (encrypted != null) ctx.metadata.encrypted = encrypted;
    }

    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }

  private resolveEffectiveChatmodeForSession(session: Session): 'interactive' | 'proactive' {
    const peerType = (session.metadata as any)?.peerType;
    try {
      const self = session.selfAID || this.getOwningAgent(session.channel)?.aid;
      const channelType = session.channelType || this.resolveChannelType(session.channel);
      const peerKeyId = session.chatType === 'group'
        ? (session.metadata?.groupId || session.channelId)
        : (session.metadata?.peerId || session.channelId);
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

  /**
   * Agent managed CLI config entrypoint. Identity and relation are resolved
   * from the daemon-owned session rather than caller-provided flags.
   */
  async handleConfigOperation(
    argv: string[],
    sessionId: string,
    delegationToken?: string,
  ): Promise<IpcConfigOpResponse> {
    if (!this.agentDelegationRegistry) {
      return { ok: false, code: 'DELEGATION_REQUIRED', error: 'Task delegation is not configured' };
    }
    const delegation = this.agentDelegationRegistry.validate(delegationToken, sessionId);
    if (!delegation.ok) return { ok: false, code: delegation.code, error: delegation.reason };

    const session = await this.sessionManager.getSessionById(sessionId);
    if (!session) return { ok: false, code: 'INVALID_SESSION', error: 'Invalid session' };

    const grant = delegation.grant;
    let conversationId: string;
    try {
      conversationId = parsePeerKey(grant.peerKey).channelId;
    } catch {
      return { ok: false, code: 'INVALID_DELEGATION', error: 'Delegation contains an invalid relation key' };
    }
    const subject = buildAuthSubject({
      selfAid: grant.selfAid,
      actorId: grant.actorId,
      channel: grant.channel,
      channelType: grant.channelType,
      channelId: conversationId,
      chatType: grant.chatType,
      conversationId,
    });
    const resolved = resolveConfigCommand(argv, {
      defaultRelation: { self: grant.selfAid, peerKey: grant.peerKey },
    });
    if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.reason };

    const authContext = {
      actorId: grant.actorId,
      channel: grant.channel,
      channelId: conversationId,
      chatType: grant.chatType,
      selfAid: grant.selfAid,
      peerKey: grant.peerKey,
      role: subject.role,
      isDaemonOwner: subject.isDaemonOwner,
      fromControlChannel: false,
      source: 'agent-tool' as const,
    };
    const decision = authorizeResolvedConfigCommand(resolved.command, authContext);
    await auditCommandAuthorization({
      ts: Date.now(),
      source: 'agent-tool',
      operation: resolved.command.operationId,
      scope: resolved.command.commandScope,
      dangerous: decision.dangerous ?? false,
      actorId: grant.actorId,
      selfAid: grant.selfAid,
      peerKey: grant.peerKey,
      channel: grant.channel,
      channelId: conversationId,
      role: subject.role,
      isDaemonOwner: subject.isDaemonOwner,
      fromControlChannel: false,
      decision: decision.allow ? 'allow' : 'deny',
      code: decision.allow ? undefined : decision.code,
      reason: decision.allow ? undefined : decision.reason,
      matchedRule: decision.matchedRule,
      argvHash: hashArgv(resolved.command.canonicalArgv),
      taskId: grant.taskId,
      messageId: grant.messageId,
    });
    if (!decision.allow) return { ok: false, code: decision.code, error: decision.reason };

    const result = executeResolvedConfigCommand(resolved.command);
    return result.ok
      ? { ok: true, result }
      : { ok: false, code: result.code, error: result.error };
  }

  setAgentDelegationRegistry(registry: AgentDelegationRegistry): void {
    this.agentDelegationRegistry = registry;
  }

  /**
   * Agent ctl 入口：通过 IPC 接收 Agent 自主管理指令
   * 复用现有 slash cmd 逻辑，权限继承 session 用户角色
   */
  async handleCtl(cmd: string, sessionId: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    logger.info(`[ctl] cmd="${cmd}" sessionId=${sessionId}`);
    // 1. 白名单检查
    const inputCmd = cmd.split(' ')[0];
    if (!CommandHandler.CTL_COMMANDS.includes(inputCmd)) {
      return { ok: false, error: `不允许的指令: ${inputCmd}` };
    }

    // 1.1 只读守卫：带参形态（写操作）在 ctl 中禁止
    if (CommandHandler.CTL_READONLY.has(inputCmd) && cmd.trimEnd().length > inputCmd.length) {
      return { ok: false, error: `${inputCmd} 在 ctl 中仅支持查询形态，不支持带参切换` };
    }

    // 2. 通过 sessionId 查 session
    const session = await this.sessionManager.getSessionById(sessionId);
    if (!session) {
      return { ok: false, error: '无效的 session' };
    }

    // 3. 从 session.metadata.peerId 获取 userId（用于权限判断）
    const userId = session.metadata?.peerId;
    const ctlIdentity = this.resolveCtlIdentity(session, userId);

    // 3.1 /agent: EvolAgent 管理（转发到 CLI）
    if (cmd === '/agent' || cmd.startsWith('/agent ')) {
      const arg = cmd.slice('/agent'.length).trim();

      // 无参数时返回用法
      if (!arg) {
        return { ok: true, result: `用法:\n  /agent list              列出所有 agent\n  /agent show [name]       查看 agent 详情\n  /agent enable <name>     启用 agent\n  /agent disable <name>    停用 agent\n  /agent get <name> <key>  读取配置字段\n  /agent set <name> <key> <val>  修改配置字段\n  /agent reload [name]     热重载配置` };
      }

      const parts = arg.split(/\s+/);
      const subCmd = parts[0];

      // ctl 禁止 new/delete（仅限 CLI 操作）
      if (subCmd === 'new' || subCmd === 'delete') {
        return { ok: false, error: `❌ /agent ${subCmd} 仅限 CLI 操作，请使用: evolclaw agent ${subCmd} ...` };
      }

      // 自我保护：不能 disable 自己所在的 agent
      const selfAgent = this.getOwningAgent(session.channel);
      const selfName = selfAgent?.name;
      if (selfName && subCmd === 'disable' && parts[1] === selfName) {
        return { ok: false, error: `❌ 不能 disable 自己所在的 agent: ${selfName}` };
      }

      // 转发到 CLI
      const cliArgs = ['agent', ...parts];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync('evolclaw', cliArgs, {
          timeout: 30000,
          encoding: 'utf-8',
          env: { ...process.env, AUN_LOG_INI_DISABLE: '1' },
        });
        const output = (stdout || '').trim();
        if (!output && stderr) return { ok: true, result: `⚠ ${stderr.trim().slice(0, 500)}` };
        return { ok: true, result: output || '(无输出)' };
      } catch (e: any) {
        const msg = e.stderr?.trim() || e.stdout?.trim() || String(e.message || e);
        return { ok: false, error: msg.slice(0, 500) };
      }
    }

    // 4. /send 文本消息：直接通过 adapter 主动发送，不走 handle()
    if (cmd.startsWith('/send ') || cmd === '/send') {
      // 解析 --encrypt 标志和消息文本
      const raw = cmd.startsWith('/send ') ? cmd.slice(6).trim() : '';
      const forceEncrypt = raw.startsWith('--encrypt ');
      const text = forceEncrypt ? raw.slice(10).trim() : raw;
      if (!text) return { ok: false, error: '消息内容不能为空' };

      const adapter = this.adapters.get(session.channel);
      if (!adapter) return { ok: false, error: `adapter 未找到: ${session.channel}` };

      try {
        const replyContext = this.buildCtlReplyContext(session);
        const taskId = replyContext?.metadata?.taskId;
        const chatmode = (replyContext?.metadata?.chatmode as 'interactive' | 'proactive' | undefined) ?? 'interactive';
        // --encrypt 覆盖 session 加密状态
        // 添加 source: 'ctl' 标记（用于区分 ec ctl send）
        const enrichedReplyContext = forceEncrypt
          ? { ...(replyContext ?? {}), metadata: { ...(replyContext?.metadata ?? {}), encrypted: true, source: 'ctl' } }
          : { ...(replyContext ?? {}), metadata: { ...(replyContext?.metadata ?? {}), source: 'ctl' } };
        await adapter.send(buildEnvelope({ taskId, channel: adapter.channelName, channelId: session.channelId, chatmode, replyContext: enrichedReplyContext }), { kind: 'result.text', text, isFinal: true });
        // 出方向 jsonl 写入已下沉到 aun.ts:deliverTextEntry，message.send 成功后统一写入。
        return { ok: true, result: 'ok' };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    // 5. file 路径限制：只允许 projectPath 下的文件
    if (cmd.startsWith('/file')) {
      const sendArgs = cmd.slice(5).trim();
      const parts = sendArgs.split(/\s+/);
      const filePath = parts[parts.length - 1];
      if (filePath) {
        const resolved = path.resolve(session.projectPath, filePath).replace(/\\/g, '/');
        const projectPath = session.projectPath.replace(/\\/g, '/');
        if (!resolved.startsWith(projectPath)) {
          return { ok: false, error: '路径越界：只能发送项目目录下的文件' };
        }
      }
    }

    // 5.1 /queue: 消息队列查询与操作（直接操作 MessageQueue，不走 handle()）
    if (cmd === '/queue' || cmd.startsWith('/queue ')) {
      const args = cmd.slice('/queue'.length).trim();
      return await this.handleQueueCommand(sessionId, args);
    }

    // 5.2 /aid, /rpc, /storage — ctl 专属，转发到 CLI 执行
    if (cmd === '/aid' || cmd.startsWith('/aid ') ||
        cmd === '/rpc' || cmd.startsWith('/rpc ') ||
        cmd === '/storage' || cmd.startsWith('/storage ')) {
      // 权限检查：仅 owner
      if (ctlIdentity.role !== 'owner') {
        return { ok: false, error: '无权限：此命令仅限 owner 使用' };
      }

      // 无参数时返回用法说明
      if (cmd === '/aid') {
        return { ok: true, result: `用法:\n  /aid list              列出本地所有 AID\n  /aid show <aid>        查看 AID 详情\n  /aid new <aid>         创建新 AID\n  /aid delete <aid>      删除本地 AID\n  /aid lookup <aid>      远程探测 AID\n  /aid agentmd put <aid> 签名并上传 agent.md\n  /aid agentmd get <aid> 下载并验签 agent.md` };
      }
      if (cmd === '/rpc') {
        return { ok: true, result: `用法: /rpc --as <aid> --params <json>\n示例: /rpc --as myaid.agentid.pub --params {"method":"meta.ping","params":{}}` };
      }
      if (cmd === '/storage') {
        return { ok: true, result: `用法:\n  /storage upload <aid> <file> <path> [--public]\n  /storage download <aid> <url> [local-path]\n  /storage ls <aid> [prefix]\n  /storage rm <aid> <path>\n  /storage quota <aid>` };
      }

      // /aid 自我保护：不能删除当前 agent 所用的 AID
      if (cmd.startsWith('/aid delete ')) {
        const targetAid = cmd.slice('/aid delete '.length).trim();
        const selfAgent = this.getOwningAgent(session.channel);
        const selfAid = selfAgent?.config?.aid;
        if (selfAid && targetAid === selfAid) {
          return { ok: false, error: `❌ 不能删除当前 agent 所用的 AID: ${selfAid}` };
        }
      }

      const cliArgs = cmd.slice(1); // strip leading /
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync('evolclaw', cliArgs.split(/\s+/), {
          timeout: 30000,
          encoding: 'utf-8',
          env: { ...process.env, AUN_LOG_INI_DISABLE: '1' },
        });
        const output = (stdout || '').trim();
        if (!output && stderr) return { ok: true, result: `⚠ ${stderr.trim().slice(0, 500)}` };
        return { ok: true, result: output || '(无输出)' };
      } catch (e: any) {
        const msg = e.stderr?.trim() || e.stdout?.trim() || String(e.message || e);
        return { ok: false, error: msg.slice(0, 500) };
      }
    }

    // 6. 调用现有 handle()，不传 sendMessage 回调（结果直接返回）
    try {
      const result = await this._handleInternal(
        cmd,
        session.channel,
        session.channelId,
        undefined,  // 不发送消息
        userId,
        session.threadId || undefined,
        session.chatType,
        undefined,
        undefined,
        session.selfAID,
        ctlIdentity,
      );
      const text = typeof result === 'string' ? result : (result && 'text' in result ? result.text : '(无输出)');
      return { ok: true, result: text || '(无输出)' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  private extractUserContent(message: unknown): string {
    const m = message as any;
    let text = '';
    if (typeof m?.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m?.content)) {
      text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
    }
    text = text.trim();
    // Strip injection wrappers before previewing (outermost first):
    // 1. Interrupt wrapper: 【新消息插入】\n...\n【请无视之前中断继续处理】
    text = text.replace(/^【新消息插入】\s*/, '').replace(/\s*【请无视之前中断继续处理】$/, '').trim();
    // 2. Current format: ‹metadata›\ncontent  (message-renderer item.md)
    if (text.startsWith('‹')) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1).trim();
    }
    // 3. Legacy XML format: <messages><message sender="..." time="...">content</message></messages>
    if (text.startsWith('<messages>')) {
      const parts: string[] = [];
      const re = /<message(?:\s[^>]*)?>([\s\S]*?)<\/message>/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) parts.push(match[1].trim());
      if (parts.length > 0) text = parts.join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > 50 ? text.substring(0, 50) + '…' : text;
  }

  // ── Queue command ──

  /** 提取命名参数值（如 --cancel msg123 → "msg123"） */
  private extractArg(args: string, flag: string): string {
    const idx = args.indexOf(flag);
    if (idx === -1) return '';
    const rest = args.slice(idx + flag.length).trim();
    const spaceIdx = rest.indexOf(' ');
    return spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
  }

  private async handleQueueCommand(sessionId: string, args: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    const showId = args.includes('--showid');
    const formatJson = args.includes('--format json');
    const full = args.includes('--full');

    // 操作分支
    if (args.includes('--clear')) {
      const count = this.messageQueue.clearBySession(sessionId);
      return { ok: true, result: `✅ 已清空 ${count} 条待处理消息` };
    }

    if (args.includes('--cancel')) {
      const msgId = this.extractArg(args, '--cancel');
      if (!msgId) return { ok: false, error: '❌ --cancel 需要指定 messageId' };
      const success = this.messageQueue.cancelMessageByIdInSession(sessionId, msgId);
      return success
        ? { ok: true, result: `✅ 已取消消息 ${msgId}` }
        : { ok: false, error: `❌ 未找到消息 ${msgId}` };
    }

    if (args.includes('--interrupt')) {
      const interrupted = await this.messageQueue.interruptBySession(sessionId);
      return interrupted
        ? { ok: true, result: `✅ 已打断处理中任务` }
        : { ok: false, error: `❌ 当前无处理中任务` };
    }

    // 查询
    const items = this.messageQueue.getQueueItemsBySession(sessionId);
    if (formatJson) {
      return { ok: true, result: JSON.stringify({ items }, null, 2) };
    }
    return { ok: true, result: renderQueueItemsCtl(items, showId, full) };
  }
}

/**
 * ctl 专用渲染：不显示 session 标识列（因为只有一个 session）
 */
function renderQueueItemsCtl(items: Array<{ messageId?: string; peerName?: string; preview: string }>, showId: boolean, full: boolean): string {
  if (items.length === 0) {
    return `当前会话队列 (0 条待处理)\n\n(无待处理消息)`;
  }

  const lines: string[] = [`当前会话队列 (${items.length} 条待处理)`, ''];

  // 计算列宽
  const maxIdLen = showId ? Math.max(...items.map(i => i.messageId?.length ?? 0)) : 0;
  const maxNameLen = Math.max(...items.map(i => (i.peerName ? `[${i.peerName}]`.length : 0)));

  for (const item of items) {
    const parts: string[] = [' '];
    if (showId) {
      const id = (item.messageId || '').padEnd(maxIdLen);
      parts.push(` ${id}  `);
    }
    if (item.peerName) {
      const name = `[${item.peerName}]`.padEnd(maxNameLen);
      parts.push(` ${name}  `);
    }
    const content = full ? item.preview.replace('...', '') : item.preview;
    parts.push(`"${content}"`);
    lines.push(parts.join(''));
  }

  return lines.join('\n');
}

function sameFeedbackTarget(
  target: TriggerFeedbackTarget,
  origin: TriggerDefinition['origin'] | undefined,
): boolean {
  if (!origin) return false;
  return target.channelKey === origin.channelKey
    && target.channelId === origin.channelId
    && target.session === origin.session
    && (target.threadId ?? '') === (origin.threadId ?? '');
}
