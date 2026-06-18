import type { ChannelAdapter, ReplyContext, InteractionRequest, Message } from '../types.js';
import type { InteractionRouter } from '../core/interaction-router.js';

export const BASEAGENT_RUNNER_UNAVAILABLE = 'BASEAGENT_RUNNER_UNAVAILABLE';

export class BaseagentRunnerUnavailableError extends Error {
  readonly code = BASEAGENT_RUNNER_UNAVAILABLE;

  constructor(
    readonly evolagentName: string,
    readonly baseagent: string,
    readonly availableBaseagents: string[],
  ) {
    super(`Baseagent runner unavailable: ${evolagentName}::${baseagent}`);
    this.name = 'BaseagentRunnerUnavailableError';
  }
}

/** 权限审批的渠道交互上下文 */
export interface PermissionContext {
  adapter?: ChannelAdapter;
  channelId?: string;
  replyContext?: ReplyContext;
  interactionRouter?: InteractionRouter;
  userId?: string;
  /** 一次性消息拦截：注册后下一条消息不入队不 interrupt，直接回调 */
  interceptNextMessage?: (sessionKey: string, handler: (message: Message) => void) => void;
  /** 取消消息拦截 */
  cancelIntercept?: (sessionKey: string) => void;
  /** 渠道名称（用于构造 OutboundEnvelope） */
  channel?: string;
  /** EvolAgent 名称（用于构造 OutboundEnvelope） */
  agentName?: string;
  /** 当前任务 id（用于构造 OutboundEnvelope） */
  taskId?: string;
  /** 当前会话 chatmode（interactive | proactive） */
  chatmode?: 'interactive' | 'proactive';
  /** proactive 模式行为策略钩子：PreToolUse 阶段调用，返回 block 则拒绝工具调用 */
  policyHook?: (toolName: string, toolInput: Record<string, unknown>) => { block: boolean; reason?: string } | undefined;
  /** 发送交互卡片前刷新当前 renderer 队列，避免卡片早于事件消息到达 */
  flushPending?: () => Promise<void>;
}

export interface ImageData {
  data: string;      // base64 encoded
  mimeType?: string; // e.g., 'image/png'
}

// ── 标准事件流（Gateway 消费的统一事件类型）──
export type AgentEvent =
  | { type: 'text'; text: string; outputTokens?: number; turn?: number }
  | { type: 'status'; subtype: string; message: string }
  | { type: 'tool_use'; name: string; input: any; callId?: string; turn?: number; outputTokens?: number }
  | { type: 'tool_result'; name: string; result: any; isError?: boolean; error?: string; callId?: string }
  | { type: 'compact'; preTokens: number; postTokens?: number; durationMs?: number }
  | { type: 'task_progress'; summary?: string; toolUses?: number; durationMs?: number }
  | { type: 'session_id'; sessionId: string }
  | { type: 'state_changed'; state: 'idle' | 'running' | 'requires_action' }
  | { type: 'complete'; result?: string; subtype?: string; isError?: boolean; errors?: string[]; durationMs?: number; ttftMs?: number; costUsd?: number; terminalReason?: string; sessionTitle?: string; numTurns?: number; tokenUsage?: AgentTokenUsage; contextUsage?: AgentContextUsage; lastModelCall?: AgentLastModelCall; modelCalls?: AgentModelCall[] }
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
    sessionManager?: any,
    /** 本次调用的模型/强度/权限模式覆盖（按 关系>agent>全局 解析后传入；缺省用 runner 默认）。
     *  permissionMode 作为 per-call 入参传入，避免多会话共享 runner 实例时 setMode 的并发污染。 */
    modelOverride?: { model?: string; effort?: string; permissionMode?: string }
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
  setPermissionContext?(sessionId: string, context: PermissionContext): void;
  setMode(mode: string): void;
  getMode(): string;

  /** Agent 支持的会话操作能力 — 缺省视为全部不支持 */
  readonly capabilities?: {
    clear?: boolean;
    compact?: boolean;
    fork?: boolean;
    askUserQuestion?: boolean;
    planApproval?: boolean;
    /**
     * File rewind semantics:
     * - checkpoint: restores an agent/runtime checkpoint for the target turn
     * - git-head: best-effort restore from Git HEAD, not a per-turn snapshot
     * - unsupported/undefined: no file rewind support
     */
    fileRewind?: 'checkpoint' | 'git-head' | 'unsupported';
  };

  /** 解析 agent session 文件路径（用于健康检查），返回 null 表示无法定位 */
  resolveSessionFile?(agentSessionId: string, projectPath: string): string | null;

  /** 分支会话，返回新的 agentSessionId */
  forkSession?(agentSessionId: string, projectPath: string, title?: string): Promise<string>;

  /** 读取会话消息历史 */
  getSessionMessages?(agentSessionId: string, projectPath: string): Promise<Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }>>;

  /** 向当前活跃流注入一条用户消息（工具调用后上下文注入） */
  injectUserMessage?(sessionId: string, text: string): void;

  /** 回退文件到指定轮次 */
  rewindFiles?(agentSessionId: string, projectPath: string, userMessageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }>;

  /** 回退对话历史末尾若干轮。Codex app-server 可直接修改 thread；Claude 走 resumeAt metadata。 */
  rollbackSessionTurns?(agentSessionId: string, projectPath: string, numTurns: number): Promise<boolean>;

  /** 同步底层会话标题/元数据（后端不支持时可忽略）。 */
  setSessionName?(agentSessionId: string, name: string): Promise<boolean>;
  updateSessionMetadata?(agentSessionId: string, metadata: Record<string, any>): Promise<boolean>;

  // 可选能力（通过类型守卫检测）
  setModel?(model: string): void;
  getModel?(): string;
  listModels?(): string[] | Promise<string[]>;
  resolveModelId?(model: string): string;
  setEffort?(effort: any): void;
  getEffort?(): string | undefined;
  listModes?(): PermissionModeInfo[];
  compact?(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;
  setPermissionGateway?(gateway: any): void;
  setCompactStartCallback?(callback: (sessionId: string) => void): void;

  /** 返回当前网关 /v1/models 的价格缓存（1h TTL，stale-while-revalidate）。仅 claude runner 实现；
   *  其余 runner 不实现 → undefined → 计费回退本地价表 / official。 */
  getGatewayPricing?(): import('../stats/price-resolver.js').GatewayPricingCache | undefined;
}

// ── 可选能力接口 ──
export interface ModelSwitcher {
  setModel(model: string): void;
  getModel(): string;
  listModels(): string[] | Promise<string[]>;
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

// ── Token / Context usage types (from aliyun/main merge) ──
export type AgentTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  iterations?: AgentTokenUsage[] | null;
  [key: string]: unknown;
};

export type AgentContextUsage = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  autoCompactTokens?: number;
  model: string;
  effort?: string;
};

export type AgentLastModelCall = {
  messageId?: string;
  uuid?: string;
  requestId?: string;
  model?: string;
  tokenUsage: AgentTokenUsage;
  contextUsage?: AgentContextUsage;
  // 价格对：原价(official) + 网关实际价(gateway)，由 message-processor 写库后合入。
  cost?: {
    official: { usd: number; cny: number };
    gateway: { usd: number; cny: number };
  };
};

export type AgentModelCall = {
  call_index: number;
  model: string;
  request_id?: string;
  message_id?: string;
  tokenUsage: AgentTokenUsage;
  contextUsage?: AgentContextUsage;
  degraded?: boolean;
};

// ── Token usage helper functions ──
export function numericToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function contextTokensForUsage(usage: AgentTokenUsage | undefined, isClaudeModel: boolean): number {
  if (!usage) return 0;
  if (!isClaudeModel) return numericToken(usage.input_tokens);
  return numericToken(usage.input_tokens)
    + numericToken(usage.cache_creation_input_tokens)
    + numericToken(usage.cache_read_input_tokens);
}

export function usageForContext(usage: AgentTokenUsage | undefined): AgentTokenUsage | undefined {
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : undefined;
  const lastIteration = iterations?.slice().reverse().find(it => contextTokensForUsage(it, true) > 0);
  return lastIteration ?? usage;
}

/** Models whose base ID uses a 1M context window when sent to the SDK with [1m]. */
export const ONE_M_CONTEXT_MODEL_PREFIXES = ['claude-opus-4-8', 'claude-sonnet-4-6'];
const ONE_M_CONTEXT_MODEL_ALIASES = ['opus', 'sonnet'];
const CLAUDE_CONTEXT_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];

export function isClaudeContextUsageModel(model: string | undefined): boolean {
  if (!model) return false;
  const baseModel = model.replace(/\[1m\]$/i, '');
  return /^claude-/i.test(baseModel) || CLAUDE_CONTEXT_MODEL_ALIASES.includes(baseModel);
}

export function isOneMillionContextModel(model: string | undefined): boolean {
  if (!model) return false;
  if (ONE_M_CONTEXT_MODEL_ALIASES.includes(model)) return true;
  if (/\[1m\]$/i.test(model)) return true;
  if (/deepseek-v4/i.test(model)) return true;
  const baseModel = model.replace(/\[1m\]$/i, '');
  return ONE_M_CONTEXT_MODEL_PREFIXES.some(prefix => baseModel === prefix || baseModel.startsWith(`${prefix}-`));
}

/** Real context window size: 1M models = 1000000, otherwise 200000. */
export function realContextWindowForModel(model: string | undefined): number {
  return isOneMillionContextModel(model) ? 1000000 : 200000;
}

/** autoCompact trigger threshold: 1M models = 900000, otherwise 200000. */
export function autoCompactWindowForModel(model: string | undefined): number {
  return isOneMillionContextModel(model) ? 900000 : 200000;
}
