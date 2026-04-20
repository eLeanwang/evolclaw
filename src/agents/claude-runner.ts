import { query, forkSession as sdkForkSession } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir, resolveAnthropicConfig, loadMenus } from '../config.js';
import type { Config, ChannelAdapter, ReplyContext } from '../types.js';
import type { PermissionGateway, PermissionDecision } from '../core/permission.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger } from '../utils/logger.js';
import { checkBlacklist, checkReadonly, summarizeToolInput } from '../core/permission.js';
import { encodePath } from '../utils/cross-platform.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/agent-loader.js';
import type { InteractionRouter } from '../core/interaction-router.js';

/** 权限审批的渠道交互上下文 */
export interface PermissionContext {
  adapter?: ChannelAdapter;
  channelId?: string;
  replyContext?: ReplyContext;
  interactionRouter?: InteractionRouter;
}

// ── SDK 消息流（Claude Agent SDK 专有格式）──

export interface ImageData {
  data: string;      // base64 encoded
  mimeType?: string; // e.g., 'image/png'
}

interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;
  };
  parent_tool_use_id: null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageData[]): void {
    let content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        >;

    if (images && images.length > 0) {
      logger.debug('[MessageStream] Creating multimodal message with', images.length, 'images');
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType || 'image/png',
            data: img.data,
          },
        })),
      ];
    } else {
      content = text;
    }

    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };

    this.queue.push(message);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── 标准事件流（Gateway 消费的统一事件类型）──
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; subtype: string; message: string }
  | { type: 'tool_use'; name: string; input: any }
  | { type: 'tool_result'; name: string; result: any; isError?: boolean; error?: string }
  | { type: 'compact'; preTokens: number }
  | { type: 'task_progress'; summary?: string; toolUses?: number; durationMs?: number }
  | { type: 'session_id'; sessionId: string }
  | { type: 'state_changed'; state: 'idle' | 'running' | 'requires_action' }
  | { type: 'complete'; result?: string; subtype?: string; isError?: boolean; errors?: string[]; durationMs?: number; costUsd?: number; terminalReason?: string; sessionTitle?: string }
  | { type: 'error'; error: string; errorType: 'context_too_long' | 'auth' | 'network' | 'unknown' };

export interface QueryRequest {
  sessionId: string;
  prompt: string;
  projectPath: string;
  agentSessionId?: string;
  images?: ImageData[];
  systemPromptAppend?: string;
}

// ── 核心接口 ──
export interface AgentRunnerInterface {
  readonly name: string;
  runQuery(request: QueryRequest): AsyncIterable<AgentEvent>;
  interrupt(sessionKey: string): Promise<void>;
  dispose?(): Promise<void>;
}

/**
 * 完整 Agent 接口 — MessageProcessor 和 CommandHandler 实际使用的方法集合。
 * AgentRunner (Claude) 和 CodexRunner 都实现此接口。
 */
export interface AgentRunnerFull {
  readonly name: string;

  // 核心查询
  runQuery(
    sessionId: string,
    prompt: string,
    projectPath: string,
    initialAgentSessionId?: string,
    images?: ImageData[],
    systemPromptAppend?: string,
    sessionManager?: any
  ): Promise<AsyncIterable<AgentEvent>>;

  // 中断
  interrupt(sessionKey: string): Promise<void>;

  // 流管理（MessageProcessor 需要）
  registerStream(key: string, stream: AsyncIterable<any>): void;
  cleanupStream(key: string): void;
  hasActiveStream(key: string): boolean;

  // 会话管理（CommandHandler 需要）
  updateSessionId(sessionId: string, agentSessionId: string): void;
  closeSession(sessionId: string): Promise<void>;
  clearSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;
  compactSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;

  // 权限回调（MessageProcessor 需要）
  setSendPrompt(fn: (text: string) => Promise<void>): void;
  setPermissionContext?(context: PermissionContext): void;
  setMode(mode: string): void;
  getMode(): string;

  /** Agent 支持的会话操作能力 — 缺省视为全部不支持 */
  readonly capabilities?: {
    clear?: boolean;
    compact?: boolean;
    fork?: boolean;
  };

  /** 解析 agent session 文件路径（用于健康检查），返回 null 表示无法定位 */
  resolveSessionFile?(agentSessionId: string, projectPath: string): string | null;

  /** 分支会话，返回新的 agentSessionId */
  forkSession?(agentSessionId: string, projectPath: string, title?: string): Promise<string>;

  // 可选能力（通过类型守卫检测）
  setModel?(model: string): void;
  getModel?(): string;
  listModels?(): string[];
  setEffort?(effort: any): void;
  getEffort?(): string | undefined;
  listModes?(): PermissionModeInfo[];
  compact?(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;
  setPermissionGateway?(gateway: any): void;
  setCompactStartCallback?(callback: (sessionId: string) => void): void;
}

// ── 可选能力接口 ──
export interface ModelSwitcher {
  setModel(model: string): void;
  getModel(): string;
  listModels(): string[];
}

export interface Compactable {
  compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;
}

export interface PermissionController {
  setMode(mode: string): void;
  getMode(): string;
  listModes(): PermissionModeInfo[];
}

export interface PermissionModeInfo {
  key: string;
  nameZh: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

// ── 类型守卫 ──
export function hasModelSwitcher(agent: any): agent is ModelSwitcher {
  return typeof agent.setModel === 'function' && typeof agent.listModels === 'function';
}

export function hasPermissionController(agent: any): agent is PermissionController {
  return typeof agent.setMode === 'function' && typeof agent.listModes === 'function';
}

export function hasCompact(agent: any): agent is Compactable {
  return typeof agent.compact === 'function';
}

export class AgentRunner {
  readonly name: string = 'claude';
  readonly capabilities = { clear: true, compact: true, fork: true };
  private apiKey: string;
  private model: string;
  private effort?: 'low' | 'medium' | 'high' | 'max';
  private permissionMode: string = 'auto';
  private baseUrl?: string;
  private config?: Config;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private interruptFns = new Map<string, () => Promise<void>>();
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContext?: PermissionContext;

  constructor(
    apiKey: string,
    model?: string,
    onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void,
    baseUrl?: string,
    config?: Config
  ) {
    this.apiKey = apiKey;
    this.model = model || 'sonnet';
    this.effort = undefined;
    this.baseUrl = baseUrl;
    this.config = config;
    this.onSessionIdUpdate = onSessionIdUpdate;
  }

  private getAgentEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      PATH: process.env.PATH,
      DISABLE_AUTOUPDATER: '1',
      ...(this.baseUrl ? { ANTHROPIC_BASE_URL: this.baseUrl } : {})
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  listModels(): string[] {
    return loadMenus().models['claude'] ?? ['opus', 'sonnet', 'haiku'];
  }

  setEffort(effort: 'low' | 'medium' | 'high' | 'max' | undefined): void {
    this.effort = effort;
  }

  getEffort(): string | undefined {
    return this.effort;
  }

  // ── PermissionController 接口 ──

  setMode(mode: string): void {
    this.permissionMode = mode;
  }

  getMode(): string {
    return this.permissionMode;
  }

  listModes(): PermissionModeInfo[] {
    return [
      { key: 'auto', nameZh: '自动', description: 'AI 分类器自动判断', available: true },
      { key: 'bypass', nameZh: '放行', description: '全部自动放行', available: true },
      { key: 'request', nameZh: '审批', description: '部分自动，部分询问', available: true },
      { key: 'edit', nameZh: '编辑', description: '自动接受编辑，其他询问', available: true },
      { key: 'plan', nameZh: '规划', description: '只规划不执行', available: true },
      { key: 'noask', nameZh: '静默', description: '未批准则拒绝', available: true },
      { key: 'readonly', nameZh: '只读', description: '禁止修改项目文件，可在临时目录生成文件', available: true },
    ];
  }

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  setSendPrompt(fn: (text: string) => Promise<void>): void {
    this.sendPromptFn = fn;
  }

  setPermissionContext(context: PermissionContext): void {
    this.permissionContext = context;
  }

  private toSdkPermissionMode(): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' {
    const map: Record<string, 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'> = {
      'auto': 'auto',         // AI 分类器自动判断
      'bypass': 'default',    // 全部自动放行（通过 canUseTool 一律 allow，保留 hook 安全检查）
      'request': 'default',   // 部分自动，部分询问
      'edit': 'acceptEdits',
      'plan': 'plan',
      'noask': 'dontAsk',
      'readonly': 'default',
    };
    return map[this.permissionMode] || 'auto';
  }

  // ── Compactable 接口 ──

  async compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    return this.compactSession(sessionId, agentSessionId, projectPath);
  }

  private syncFromUserSettings(): void {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) return;

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      // evolclaw.json 显式配置优先，不被 settings.json 覆盖
      const configModel = this.config?.agents?.anthropic?.model;
      if (!configModel && settings.model && settings.model !== this.model) {
        logger.info(`[AgentRunner] Synced model from ~/.claude/settings.json: ${settings.model}`);
        this.model = settings.model;
      }

      const configEffort = this.config?.agents?.anthropic?.effort;
      if (!configEffort) {
        const newEffort = settings.effortLevel || undefined;
        if (newEffort !== this.effort) {
          logger.info(`[AgentRunner] Synced effort from ~/.claude/settings.json: ${newEffort ?? 'auto'}`);
          this.effort = newEffort;
        }
      }
    } catch (error) {
      logger.debug(`[AgentRunner] Failed to sync from ~/.claude/settings.json:`, error);
    }
  }

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  /**
   * SDK 原始事件 → 标准 AgentEvent 转换
   * 所有 SDK 特有的事件类型引用封装在此方法内
   */
  private async *transformStream(sdkStream: AsyncIterable<any>, sessionId: string): AsyncGenerator<AgentEvent> {
    let hasTextDelta = false;
    let lastSessionId: string | undefined;
    // tool_use_id → tool_name 映射，用于从 SDKUserMessage 的 tool_result 块中还原工具名
    const toolUseNames = new Map<string, string>();

    for await (const event of sdkStream) {
      // 提取 session_id（任意 SDK 事件都可能携带）
      if (event.session_id && event.session_id !== lastSessionId) {
        lastSessionId = event.session_id;
        this.updateSessionId(sessionId, event.session_id);
        yield { type: 'session_id', sessionId: event.session_id };
      }

      // text_delta → text
      if (event.type === 'text_delta' && event.text) {
        hasTextDelta = true;
        yield { type: 'text', text: event.text };
      }

      // system: compact_boundary → compact
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        yield { type: 'compact', preTokens: event.compact_metadata?.pre_tokens || 0 };
      }

      // system: task_progress → task_progress
      if (event.type === 'system' && event.subtype === 'task_progress') {
        yield {
          type: 'task_progress',
          summary: event.summary,
          toolUses: event.tool_uses,
          durationMs: event.duration_ms,
        };
      }

      // system: session_state_changed → state_changed
      if (event.type === 'system' && event.subtype === 'session_state_changed') {
        yield { type: 'state_changed', state: event.state };
      }

      // assistant: 提取 tool_use 和文本（仅无 text_delta 时提取文本）
      if (event.type === 'assistant' && event.message?.content) {
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            // 记录 id → name 映射，供后续 tool_result 使用
            if (content.id) toolUseNames.set(content.id, content.name);
            yield { type: 'tool_use', name: content.name, input: content.input };
          } else if (content.type === 'text' && content.text && !hasTextDelta) {
            yield { type: 'text', text: content.text };
          }
        }
      }

      // user: 提取 tool_result 块（SDK 将工具结果嵌套在 SDKUserMessage 中）
      if (event.type === 'user' && event.message?.content) {
        const contentArray = Array.isArray(event.message.content) ? event.message.content : [];
        for (const block of contentArray) {
          if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
            const toolName = toolUseNames.get(block.tool_use_id) || '';
            const resultContent = typeof block.content === 'string'
              ? block.content
              : block.content != null ? JSON.stringify(block.content) : '';
            yield {
              type: 'tool_result',
              name: toolName,
              result: resultContent,
              isError: block.is_error === true,
              error: block.is_error === true ? resultContent : undefined,
            };
          }
        }
      }

      // result → complete（含 permission_denials 提取）
      if (event.type === 'result') {
        // 先发出被拒绝的权限事件
        if (Array.isArray(event.permission_denials)) {
          for (const denial of event.permission_denials) {
            yield {
              type: 'tool_result',
              name: denial.tool_name || '',
              result: '',
              isError: true,
              error: `权限被拒绝: ${denial.tool_name}`,
            };
          }
        }

        yield {
          type: 'complete',
          result: event.result,
          subtype: event.subtype,
          isError: event.is_error,
          errors: event.errors,
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
          terminalReason: event.terminal_reason,
          sessionTitle: event.session_title,
        };
      }
    }
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string, sessionManager?: any): Promise<AsyncIterable<AgentEvent>> {
    // 同步用户级配置到内存
    this.syncFromUserSettings();

    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 agentSessionId（从数据库恢复），否则使用内存中的
    let agentSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

    // 检查是否在安全模式
    let skipResume = false;
    if (sessionManager) {
      const health = await sessionManager.getHealthStatus(sessionId);
      if (health.safeMode) {
        // 安全模式：不使用 resume，每次都是新对话
        agentSessionId = undefined;
        skipResume = true;
        logger.warn(`[AgentRunner] Safe mode enabled for ${sessionId}, not resuming session`);
      }
    }

    // 验证会话文件是否存在且有效（仅在非安全模式且有 agentSessionId 时）
    if (agentSessionId && !skipResume) {
      const homeDir = os.homedir();
      const encodedProjectPath = encodePath(projectPath);
      const sessionFile = path.join(homeDir, '.claude', 'projects', encodedProjectPath, `${agentSessionId}.jsonl`);

      let isValid = false;
      if (fs.existsSync(sessionFile)) {
        try {
          const content = fs.readFileSync(sessionFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          // 查找第一个包含 sessionId 和 version 的行（跳过 queue-operation）
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.sessionId && data.version) {
                isValid = true;
                break;
              }
            } catch {}
          }
          if (!isValid) {
            logger.warn(`[AgentRunner] Session file missing session data: ${sessionFile}`);
          }
        } catch (error) {
          logger.warn(`[AgentRunner] Session file corrupted: ${sessionFile}`);
        }
      }

      if (!isValid) {
        logger.warn(`[AgentRunner] Invalid session file, starting new session`);
        agentSessionId = undefined;
        this.activeSessions.delete(sessionId);
        if (this.onSessionIdUpdate) {
          this.onSessionIdUpdate(sessionId, '');
        }
      }
    }

    // PreCompact Hook - 在压缩开始时触发
    const preCompactHook = async () => {
      if (this.onCompactStart) {
        this.onCompactStart(sessionId);
      }
      return {};
    };

    // PreToolUse Hook - 黑名单检查 + input 修正（不可绕过，所有模式都走）
    const preToolUseHook = async (input: any) => {
      const result = await checkBlacklist(input.tool_name, input.tool_input || {});
      if (result.behavior === 'deny') {
        return { decision: 'block' as const, reason: result.message };
      }

      if (this.permissionMode === 'readonly') {
        const roResult = checkReadonly(input.tool_name, input.tool_input || {}, projectPath);
        if (roResult.behavior === 'deny') {
          return { decision: 'block' as const, reason: roResult.message };
        }
      }

      // 修正 SDK schema 不兼容问题：部分工具被 system prompt 或 skills 指示传入
      // SDK 未定义的参数（如 EnterPlanMode 的 reason），导致 InputValidationError
      const toolInput = input.tool_input || {};
      const sanitizeRules: Record<string, string[]> = {
        'EnterPlanMode': ['reason'],
        'ExitPlanMode': ['reason'],
        'ExitWorktree': ['reason'],
      };
      const fieldsToRemove = sanitizeRules[input.tool_name];
      if (fieldsToRemove && fieldsToRemove.some((f: string) => f in toolInput)) {
        const cleaned = { ...toolInput };
        for (const f of fieldsToRemove) delete cleaned[f];
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            updatedInput: cleaned
          }
        };
      }

      return {};
    };

    // PermissionDenied Hook - auto 模式下 SDK 拒绝操作时通知用户
    const permissionDeniedHook = async (input: any) => {
      if (this.permissionMode === 'auto' && this.sendPromptFn) {
        const toolName = input.tool_name || '未知工具';
        const reason = input.reason || 'AI 判断此操作有风险';
        const message = `⚠️ 操作已自动拦截\n工具: ${toolName}\n原因: ${reason}`;
        try {
          await this.sendPromptFn(message);
        } catch (err) {
          logger.error('[PermissionDenied] Failed to send notification:', err);
        }
      }
      return {};
    };

    // SDK-level canUseTool 回调：接入 PermissionGateway 的用户审批入口
    // 只在 SDK 认为此工具需要用户确认时触发（黑名单已在 PreToolUse hook 拦截）
    const canUseToolCallback = async (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; title?: string; description?: string; decisionReason?: string; toolUseID: string; [key: string]: any }
    ) => {
      // bypass 模式：一律 allow
      if (this.permissionMode === 'bypass') {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // readonly 模式：二次拦截（belt-and-suspenders）
      if (this.permissionMode === 'readonly') {
        const roResult = checkReadonly(toolName, input, projectPath);
        if (roResult.behavior === 'deny') {
          return { behavior: 'deny' as const, message: roResult.message, decisionClassification: 'user_reject' as const };
        }
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // auto 模式：SDK 内置分类器自动判断，正常情况下不会触发 canUseTool 回调。
      // 防御性兜底：确保即使 SDK 边界场景或版本变化意外调用了此回调，也不会阻塞流程。
      if (this.permissionMode === 'auto') {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // 如果 PermissionGateway 未设置（如测试环境），回退到一律 allow
      if (!this.permissionGateway || !this.sendPromptFn) {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // always-allow 缓存命中：直接放行
      if (this.permissionGateway.isAlwaysAllowed(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      const summary = options.title
        || options.description
        || summarizeToolInput(toolName, input);

      const decision: PermissionDecision = await this.permissionGateway.requestPermission(
        sessionId,
        toolName,
        input,
        this.sendPromptFn,
        this.permissionContext,
        summary,
        options.decisionReason
      );

      if (decision === 'deny') {
        return { behavior: 'deny' as const, message: '用户拒绝或审批超时', decisionClassification: 'user_reject' as const };
      }
      return {
        behavior: 'allow' as const,
        updatedInput: input,
        decisionClassification: decision === 'always' ? 'user_permanent' as const : 'user_temporary' as const
      };
    };

    const useSettingSources = this.config?.agents?.anthropic?.useSettingSources !== false;
    const enableSummaries = this.config?.agents?.anthropic?.agentProgressSummaries !== false;
    const excludeDynamic = this.config?.agents?.anthropic?.excludeDynamicSections === true;

    // 公共 options（新旧模式共用）
    const sdkPermissionMode = this.toSdkPermissionMode();
    logger.info(`[AgentRunner] runQuery model=${this.model} effort=${this.effort ?? 'auto'} permMode=${this.permissionMode} sdkMode=${sdkPermissionMode}`);
    const commonOptions = {
      cwd: projectPath,
      model: this.model,
      ...(this.effort ? { effort: this.effort } : {}),
      autoCompactWindow: 200000,
      advisorModel: 'haiku',
      canUseTool: canUseToolCallback,
      permissionMode: sdkPermissionMode,
      persistSession: true,
      hooks: {
        PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }],
        PreToolUse: [{ matcher: '.*', hooks: [preToolUseHook] }],
        PermissionDenied: [{ matcher: '.*', hooks: [permissionDeniedHook] }]
      },
      ...(enableSummaries ? { agentProgressSummaries: true } : {}),
      stderr: (msg: string) => {
        if (msg.includes('[ERROR]') || msg.includes('[WARN]') || msg.includes('Stream started')) {
          logger.info(`[Claude-stderr] ${msg.trim()}`);
        } else {
          logger.debug(`[Claude-stderr] ${msg.trim()}`);
        }
      },
      env: this.getAgentEnv()
    };

    const createQuery = (promptInput: string | MessageStream, resumeSessionId?: string) => {
      if (useSettingSources) {
        // 新方式：SDK 自动加载 CLAUDE.md 和 MCP 配置
        return query({
          prompt: promptInput as any,
          options: {
            ...commonOptions,
            settingSources: ['project', 'user'],
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              ...(excludeDynamic ? { excludeDynamicSections: true } : {}),
              ...(systemPromptAppend ? { append: systemPromptAppend } : {})
            },
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          }
        });
      } else {
        // 旧方式：手动加载 CLAUDE.md 和 MCP 配置（保留用于回滚）
        const globalClaudeMd = (() => {
          try {
            const globalPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
            if (fs.existsSync(globalPath)) {
              return fs.readFileSync(globalPath, 'utf-8').trim();
            }
          } catch {}
          return '';
        })();

        const projectClaudeMds = [
          path.join(projectPath, 'CLAUDE.md'),
          path.join(projectPath, '.claude', 'CLAUDE.md'),
        ].map(p => {
          try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : ''; } catch { return ''; }
        }).filter(Boolean);

        const globalMcpServers = (() => {
          try {
            const mcpPath = path.join(os.homedir(), '.claude', 'mcp.json');
            if (fs.existsSync(mcpPath)) {
              const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
              return config.mcpServers || {};
            }
          } catch {}
          return {};
        })();

        const fullAppend = [...projectClaudeMds, globalClaudeMd, systemPromptAppend].filter(Boolean).join('\n\n');

        return query({
          prompt: promptInput as any,
          options: {
            ...commonOptions,
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            ...(Object.keys(globalMcpServers).length > 0 ? { mcpServers: globalMcpServers } : {}),
            ...(fullAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: fullAppend
              }
            } : {}),
          }
        });
      }
    };

    let sdkStream;
    if (images && images.length > 0) {
      logger.debug('[AgentRunner] Creating query with images, images:', images.length);
      logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');
      const stream = new MessageStream();
      stream.push(prompt, images);
      stream.end();
      sdkStream = createQuery(stream);
    } else {
      logger.debug('[AgentRunner] Creating query with text only, agentSessionId:', initialClaudeSessionId);
      sdkStream = createQuery(prompt, agentSessionId);
    }
    // 保存 interrupt 能力（不写 activeStreams，由 registerStream 管理活跃状态）
    if ('interrupt' in sdkStream && typeof (sdkStream as any).interrupt === 'function') {
      this.interruptFns.set(sessionId, () => (sdkStream as any).interrupt());
    }
    // 返回标准 AgentEvent 流（重试由 MessageProcessor 层负责）
    return this.transformStream(sdkStream, sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    const fn = this.interruptFns.get(sessionId);
    if (fn) {
      try {
        await fn();
        logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
      } catch (error) {
        logger.warn(`[AgentRunner] Interrupt failed (transport closed): ${sessionId}`);
      }
    }
    this.interruptFns.delete(sessionId);
    this.activeStreams.delete(sessionId);
  }

  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
    this.interruptFns.delete(sessionId);
  }

  updateSessionId(sessionId: string, agentSessionId: string): void {
    logger.info(`[AgentRunner] updateSessionId called: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    this.activeSessions.set(sessionId, agentSessionId);
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, agentSessionId);
    }
  }

  private runSessionCommand(prompt: string, agentSessionId: string, projectPath: string) {
    return query({
      prompt,
      options: {
        cwd: projectPath,
        model: this.model,
        resume: agentSessionId,
        maxTurns: 1,
        permissionMode: this.toSdkPermissionMode(),
        env: this.getAgentEnv()
      }
    });
  }

  /**
   * 主动压缩会话上下文
   */
  async compactSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    try {
      logger.info(`[AgentRunner] Compacting session: ${agentSessionId}`);
      const stream = this.runSessionCommand('/compact', agentSessionId, projectPath);
      this.activeStreams.set(sessionId, stream);
      try {
        for await (const event of stream) {
          if (event.type === 'system' && event.subtype === 'compact_boundary') {
            logger.info(`[AgentRunner] Compact completed, pre_tokens: ${event.compact_metadata?.pre_tokens}`);
            return true;
          }
        }
        return true;
      } finally {
        this.activeStreams.delete(sessionId);
      }
    } catch (error) {
      logger.error('[AgentRunner] Compact failed:', error);
      return false;
    }
  }

  /**
   * 通过 SDK /clear 命令清空会话历史
   */
  async clearSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    try {
      logger.info(`[AgentRunner] Clearing session via SDK: ${agentSessionId}`);
      const stream = this.runSessionCommand('/clear', agentSessionId, projectPath);
      this.activeStreams.set(sessionId, stream);
      try {
        for await (const event of stream) {
          logger.debug(`[AgentRunner] Clear event: type=${event.type}, subtype=${(event as any).subtype || 'none'}`);
        }
        return true;
      } finally {
        this.activeStreams.delete(sessionId);
      }
    } catch (error) {
      logger.error('[AgentRunner] Clear session failed:', error);
      return false;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
    this.interruptFns.delete(sessionId);
  }

  resolveSessionFile(agentSessionId: string, projectPath: string): string | null {
    const encodedProjectPath = encodePath(projectPath);
    const sessionFile = path.join(os.homedir(), '.claude', 'projects', encodedProjectPath, `${agentSessionId}.jsonl`);
    return fs.existsSync(sessionFile) ? sessionFile : null;
  }

  async forkSession(agentSessionId: string, projectPath: string, title?: string): Promise<string> {
    const result = await sdkForkSession(agentSessionId, { dir: projectPath, title });
    return result.sessionId;
  }
}

// Plugin implementation
export class ClaudeAgentPlugin implements AgentPlugin {
  readonly name = 'claude';

  isEnabled(config: Config): boolean {
    return true;
  }

  createAgent(config: Config, callbacks: AgentCallbacks): AgentInstance {
    const anthropic = resolveAnthropicConfig(config);
    const agentRunner = new AgentRunner(
      anthropic.apiKey,
      anthropic.model,
      callbacks.onSessionIdUpdate,
      anthropic.baseUrl,
      config
    );
    if (anthropic.effort) {
      agentRunner.setEffort(anthropic.effort);
    }
    return { agent: agentRunner };
  }
}
