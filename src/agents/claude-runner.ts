import { query, forkSession as sdkForkSession, getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from '../utils/atomic-write.js';
import { resolveAnthropicConfig } from './resolve.js';
import type { Config, ChannelAdapter, ReplyContext, InteractionRequest, Message } from '../types.js';
import { DEFAULT_PERMISSION_MODE } from '../types.js';
import { renderActionAsText } from '../core/interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from '../core/message/message-processor.js';
import type { PermissionGateway, PermissionDecision } from '../core/permission.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger } from '../utils/logger.js';
import { checkBlacklist, checkReadonly, summarizeToolInput } from '../core/permission.js';
import { encodePath } from '../utils/cross-platform.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { InteractionRouter } from '../core/interaction-router.js';

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
  | { type: 'text'; text: string; outputTokens?: number; turn?: number }
  | { type: 'status'; subtype: string; message: string }
  | { type: 'tool_use'; name: string; input: any; callId?: string; turn?: number }
  | { type: 'tool_result'; name: string; result: any; isError?: boolean; error?: string; callId?: string }
  | { type: 'compact'; preTokens: number }
  | { type: 'task_progress'; summary?: string; toolUses?: number; durationMs?: number }
  | { type: 'session_id'; sessionId: string }
  | { type: 'state_changed'; state: 'idle' | 'running' | 'requires_action' }
  | { type: 'complete'; result?: string; subtype?: string; isError?: boolean; errors?: string[]; durationMs?: number; costUsd?: number; terminalReason?: string; sessionTitle?: string; numTurns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
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
  setPermissionContext?(sessionId: string, context: PermissionContext): void;
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

  /** 读取会话消息历史 */
  getSessionMessages?(agentSessionId: string, projectPath: string): Promise<Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }>>;

  /** 回退文件到指定轮次 */
  rewindFiles?(agentSessionId: string, projectPath: string, userMessageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }>;

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
  private permissionMode: string = DEFAULT_PERMISSION_MODE;
  private baseUrl?: string;
  private config?: Config;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private interruptFns = new Map<string, () => Promise<void>>();
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContexts = new Map<string, PermissionContext>();
  private currentEvolclawSessionId?: string;
  private claudeExecutablePath?: string;

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
    if (config) {
      const anthropic = resolveAnthropicConfig(config);
      this.claudeExecutablePath = anthropic.pathToClaudeCodeExecutable;
    }
  }

  private getAgentEnv(): Record<string, string | undefined> {
    return {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      PATH: process.env.PATH,
      DISABLE_AUTOUPDATER: '1',
      ...(this.baseUrl ? { ANTHROPIC_BASE_URL: this.baseUrl } : {}),
      ...(this.currentEvolclawSessionId ? { EVOLCLAW_SESSION_ID: this.currentEvolclawSessionId } : {}),
    };
  }

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  listModels(): string[] {
    return ['opus', 'sonnet', 'haiku'];
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
    // readonly 模式暂时禁用：与 proactive 模式系统提示词存在语义冲突，
    // 且 READONLY_WRITE_PATTERNS 未覆盖 evolclaw ctl send/file，契约不稳固
    return [
      { key: 'auto', nameZh: '自动', description: 'AI 分类器自动判断', available: true },
      { key: 'bypass', nameZh: '放行', description: '全部自动放行', available: true },
      { key: 'request', nameZh: '审批', description: '部分自动，部分询问', available: true },
      { key: 'edit', nameZh: '编辑', description: '自动接受编辑，其他询问', available: true },
      { key: 'plan', nameZh: '规划', description: '只规划不执行', available: true },
      { key: 'noask', nameZh: '静默', description: '未批准则拒绝', available: true },
    ];
  }

  setPermissionGateway(gateway: PermissionGateway): void {
    this.permissionGateway = gateway;
  }

  setSendPrompt(fn: (text: string) => Promise<void>): void {
    this.sendPromptFn = fn;
  }

  setPermissionContext(sessionId: string, context: PermissionContext): void {
    this.permissionContexts.set(sessionId, context);
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

      // agent config 显式配置优先，不被 settings.json 覆盖
      const configModel = this.config?.agents?.claude?.model;
      if (!configModel && settings.model && settings.model !== this.model) {
        logger.info(`[AgentRunner] Synced model from ~/.claude/settings.json: ${settings.model}`);
        this.model = settings.model;
      }

      const configEffort = this.config?.agents?.claude?.effort;
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
   * 处理 AskUserQuestion 工具调用：将 SDK 问题转换为飞书 action 卡片，逐个收集用户答案
   * SDK 期望返回 updatedInput 中包含 answers 字段：{ [questionText]: selectedLabel | selectedLabel[] }
   */
  private async handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; [key: string]: any }
  ): Promise<any> {
    const questions = input.questions as Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;

    // 没有交互上下文（无渠道适配器），回退到纯文本
    const permCtx = this.permissionContexts.get(sessionId);
    if (!permCtx?.adapter || !permCtx?.channelId) {
      return this.handleAskUserQuestionFallback(sessionId, input, questions);
    }
    const adapterHasInteractionPath = !!permCtx.adapter.send;
    if (!adapterHasInteractionPath) {
      return this.handleAskUserQuestionFallback(sessionId, input, questions);
    }

    const answers: Record<string, string | string[]> = {};

    // 从 permCtx 构造 per-session 的发送函数，避免全局 sendPromptFn 被其他 channel 实例覆盖
    // 注意：sendPromptFn 是全局单例，多 channel 并发时会被覆盖，导致提示发到错误 channel
    const sendPrompt = permCtx.adapter && permCtx.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    // 逐个 question 发送卡片并等待用户选择
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cardTitle = q.header ? `💬 ${q.header}` : `💬 问题 ${i + 1}/${questions.length}`;

      // 统一使用 action 按钮卡片（单选 / 多选均用按钮）
      const bodyLines = [q.question];
      if (q.options.some(opt => opt.description)) {
        bodyLines.push('');
        q.options.forEach((opt, idx) => {
          bodyLines.push(`${idx + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`);
        });
      }

      const interaction: InteractionRequest = {
        type: 'interaction',
        id: requestId,
        kind: {
          kind: 'action',
          title: cardTitle,
          body: bodyLines.join('\n'),
          buttons: [
            ...q.options.map(opt => ({
              key: opt.label,
              label: opt.label,
              style: 'default' as const,
            })),
            ...(permCtx.interceptNextMessage ? [{
              key: '_custom_input',
              label: '✏️ 手动输入',
              style: 'default' as const,
            }] : []),
          ],
        },
        channelId: permCtx.channelId,
        sessionId,
        expiresAt: Date.now() + 5 * 60 * 1000,
      };

      let cardSent = false;
      try {
        const envelope = buildEnvelope({
          taskId: permCtx.taskId,
          channel: permCtx.channel ?? permCtx.adapter.channelName,
          channelId: permCtx.channelId,
          agentName: permCtx.agentName,
          chatmode: permCtx.chatmode,
          replyContext: permCtx.replyContext,
        });
        const optionLines = q.options.map((o, idx) => `  ${idx + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
        const fallbackText = `💬 ${q.header || q.question}\n${q.header ? q.question + '\n' : ''}${optionLines}`;
        const result = await sendInteractionPayload(
          permCtx.adapter,
          envelope,
          interaction,
          fallbackText,
          permCtx.replyContext,
        );
        cardSent = !!result;
      } catch (err) {
        logger.warn(`[AgentRunner] AskUserQuestion card send failed for q${i}:`, err);
      }

      if (!cardSent) {
        // 卡片发送失败，以纯文本展示选项并自动选推荐项
        const firstLabel = q.options[0]?.label || '';
        answers[q.question] = q.multiSelect ? [firstLabel] : firstLabel;
        if (sendPrompt) {
          const optText = q.options.map((o, idx) => `  ${idx + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
          await sendPrompt(`💬 ${q.header || q.question}\n${q.header ? q.question + '\n' : ''}${optText}\n  → 自动选择：${firstLabel}`);
        }
        continue;
      }

      // 等待用户交互
      const answer = await new Promise<string | string[] | null>((resolve) => {
        permCtx?.interactionRouter?.register(requestId, sessionId, (action: string, values?: Record<string, any>) => {
          if (action === 'cancel') {
            resolve(null);
          } else if (action === '_custom_input' && permCtx.interceptNextMessage) {
            // "手动输入"：发提示，拦截下一条消息
            const sendHint = async () => {
              if (sendPrompt) {
                await sendPrompt('✏️ 请输入你的想法，回复后继续……');
              }
            };
            sendHint().catch(() => {});
            permCtx.interceptNextMessage(sessionId, (msg) => {
              resolve(msg.content || null);
            });
          } else if (q.multiSelect) {
            // multiSelect 按钮点击：包装为数组
            resolve([action]);
          } else {
            resolve(action); // action = button key = option label
          }
        });
      });

      if (answer === null) {
        // 取消，自动选第一项
        const firstLabel = q.options[0]?.label || '';
        answers[q.question] = q.multiSelect ? [firstLabel] : firstLabel;
      } else {
        answers[q.question] = answer;
      }
    }

    const updatedInput = { ...input, answers };
    return { behavior: 'allow' as const, updatedInput, decisionClassification: 'user_temporary' as const };
  }

  /**
   * AskUserQuestion 纯文本 fallback：发送选项列表，等待用户通过 /ask 命令选择
   * 注册到 interactionRouter，用户回复 /ask 1 或 /ask 自定义内容
   */
  private async handleAskUserQuestionFallback(
    sessionId: string,
    input: Record<string, unknown>,
    questions: Array<{ question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>
  ): Promise<any> {
    const permCtx = this.permissionContexts.get(sessionId);
    const sendPrompt = permCtx?.adapter && permCtx?.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    const answers: Record<string, string> = {};

    if (questions?.length) {
      for (const q of questions) {
        if (sendPrompt && permCtx?.interactionRouter) {
          const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const interaction: InteractionRequest = {
            type: 'interaction',
            id: requestId,
            channelId: permCtx.channelId || '',
            sessionId,
            initiatorId: permCtx.userId,
            kind: {
              kind: 'action',
              title: `💬 ${q.question}`,
              body: q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'),
              buttons: q.options.map((o, i) => ({ key: `opt-${i}`, label: o.label })),
            },
            fallback: {
              command: 'ask',
              buttonArgMap: Object.fromEntries(q.options.map((_, i) => [`opt-${i}`, String(i + 1)])),
              acceptFreeText: true,
              freeTextHint: '或回复 /ask <自定义内容>',
            },
          };
          await sendPrompt(renderActionAsText(interaction));
          const answer = await new Promise<string>((resolve) => {
            permCtx.interactionRouter!.register(requestId, sessionId, (action: string) => {
              const num = parseInt(action.trim(), 10);
              if (num >= 1 && num <= q.options.length) {
                resolve(q.options[num - 1].label);
              } else {
                resolve(action.trim());
              }
            }, { timeoutMs: 120_000, onTimeout: () => resolve(q.options[0]?.label || ''), initiatorId: permCtx.userId, fallbackCommand: 'ask' });
          });
          answers[q.question] = answer;
        } else {
          const firstLabel = q.options[0]?.label || '';
          answers[q.question] = firstLabel;
          if (sendPrompt) {
            const optText = q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
            await sendPrompt(`💬 ${q.question}\n${optText}\n\n  → 自动选择：${firstLabel}`);
          }
        }
      }
    }

    const updatedInput = { ...input, answers };
    return { behavior: 'allow' as const, updatedInput, decisionClassification: 'user_temporary' as const };
  }

  /**
   * 处理 ExitPlanMode 工具调用：plan mode 审批，等待用户批准后才继续执行
   */
  private async handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; [key: string]: any }
  ): Promise<any> {
    const permCtx = this.permissionContexts.get(sessionId);
    const sendPrompt = permCtx?.adapter && permCtx?.channelId
      ? async (text: string) => permCtx.adapter!.send(buildEnvelope({ channel: permCtx.adapter!.channelName, channelId: permCtx.channelId!, replyContext: permCtx.replyContext }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    // 无任何交互能力，直接 allow
    if (!permCtx?.channelId || !sendPrompt) {
      return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const };
    }

    // 尝试发送交互卡片
    let cardSent = false;
    if (permCtx.adapter?.send) {
      // 发送计划内容：找 plans 目录中最新修改的 .md 文件
      if (sendPrompt) {
        try {
          const plansDir = path.join(process.env.HOME || '/root', '.claude', 'plans');
          const files = fs.readdirSync(plansDir)
            .filter((f: string) => f.endsWith('.md'))
            .map((f: string) => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
            .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
          if (files.length > 0) {
            const planContent = fs.readFileSync(path.join(plansDir, files[0].name), 'utf-8');
            if (planContent.trim()) {
              await sendPrompt(`📋 **计划内容**\n\n${planContent}`);
            }
          }
        } catch {
          // 读取失败不影响后续审批流程
        }
      }

      const requestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const interaction: InteractionRequest = {
        type: 'interaction',
        id: requestId,
        kind: {
          kind: 'action',
          title: '📋 计划审批',
          body: 'AI 已完成规划，等待审批。\n请查看以上计划内容后决定。',
          buttons: [
            { key: 'approve', label: '✅ 批准执行', style: 'primary' },
            { key: 'reject', label: '❌ 拒绝', style: 'danger' },
          ],
        },
        channelId: permCtx.channelId,
        sessionId,
        initiatorId: permCtx.userId,
        fallback: {
          command: 'ask',
          buttonArgMap: { approve: '1', reject: '2' },
        },
      };

      try {
        const envelope = buildEnvelope({
          taskId: permCtx.taskId,
          channel: permCtx.channel ?? permCtx.adapter.channelName,
          channelId: permCtx.channelId,
          agentName: permCtx.agentName,
          chatmode: permCtx.chatmode,
          replyContext: permCtx.replyContext,
        });
        const fallbackText = '📋 计划审批：AI 已完成规划，等待审批。\n回复 /ask 1 批准 / /ask 2 拒绝';
        const result = await sendInteractionPayload(
          permCtx.adapter,
          envelope,
          interaction,
          fallbackText,
          permCtx.replyContext,
        );
        cardSent = !!result;
      } catch (err) {
        logger.warn('[AgentRunner] ExitPlanMode card send failed:', err);
      }

      if (cardSent) {
        return new Promise((resolve) => {
          permCtx.interactionRouter?.register(requestId, sessionId, (action: string) => {
            const trimmed = action.trim();
            if (trimmed === '2' || trimmed.toLowerCase() === 'reject' || trimmed === '拒绝' || trimmed === 'reject') {
              resolve({ behavior: 'deny' as const, message: '用户拒绝了计划', decisionClassification: 'user_reject' as const });
            } else {
              resolve({ behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const });
            }
          }, { initiatorId: permCtx.userId, fallbackCommand: 'ask' });
        });
      }
    }

    // 文本 fallback：注册到 interactionRouter，等待用户 /ask 回复
    if (permCtx.interactionRouter) {
      const fallbackRequestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fallbackInteraction: InteractionRequest = {
        type: 'interaction',
        id: fallbackRequestId,
        channelId: permCtx.channelId || '',
        sessionId,
        initiatorId: permCtx.userId,
        kind: {
          kind: 'action',
          title: '📋 计划审批',
          body: 'AI 已完成规划，等待审批。',
          buttons: [
            { key: 'approve', label: '✅ 批准执行', style: 'primary' },
            { key: 'reject', label: '❌ 拒绝', style: 'danger' },
          ],
        },
        fallback: {
          command: 'ask',
          buttonArgMap: { approve: '1', reject: '2' },
        },
      };
      await sendPrompt(renderActionAsText(fallbackInteraction));
      return new Promise((resolve) => {
        permCtx.interactionRouter!.register(fallbackRequestId, sessionId, (action: string) => {
          const trimmed = action.trim();
          if (trimmed === '2' || trimmed.toLowerCase() === 'reject' || trimmed === '拒绝') {
            resolve({ behavior: 'deny' as const, message: '用户拒绝了计划', decisionClassification: 'user_reject' as const });
          } else {
            resolve({ behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const });
          }
        }, { timeoutMs: 300_000, onTimeout: () => resolve({ behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const }), initiatorId: permCtx.userId, fallbackCommand: 'ask' });
      });
    }

    // 无交互能力，发提示后直接 allow
    await sendPrompt('📋 计划审批\nAI 已完成规划，自动批准执行。');
    return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_temporary' as const };
  }

  /**
   * SDK 原始事件 → 标准 AgentEvent 转换
   * 所有 SDK 特有的事件类型引用封装在此方法内
   */
  private async *transformStream(sdkStream: AsyncIterable<any>, sessionId: string): AsyncGenerator<AgentEvent> {
    let lastSessionId: string | undefined;
    // tool_use_id → tool_name 映射，用于从 SDKUserMessage 的 tool_result 块中还原工具名
    const toolUseNames = new Map<string, string>();
    let turnCount = 0;

    for await (const event of sdkStream) {
      // 提取 session_id（任意 SDK 事件都可能携带）
      if (event.session_id && event.session_id !== lastSessionId) {
        lastSessionId = event.session_id;
        this.updateSessionId(sessionId, event.session_id);
        yield { type: 'session_id', sessionId: event.session_id };
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
        turnCount++;
        for (const content of event.message.content) {
          if (content.type === 'tool_use') {
            if (content.id) toolUseNames.set(content.id, content.name);
            yield { type: 'tool_use', name: content.name, input: content.input, callId: content.id, turn: turnCount };
          } else if (content.type === 'text' && content.text) {
            yield { type: 'text', text: content.text, outputTokens: content.text.length, turn: turnCount };
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
              callId: block.tool_use_id,
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

        // 剥离 SDK result 中混入的 <thinking>...</thinking> 块
        const cleanResult = typeof event.result === 'string'
          ? event.result.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim()
          : event.result;

        yield {
          type: 'complete',
          result: cleanResult,
          subtype: event.subtype,
          isError: event.is_error,
          errors: event.errors,
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
          terminalReason: event.terminal_reason,
          sessionTitle: event.session_title,
          numTurns: event.num_turns,
          usage: event.usage,
        };
        // result 是 SDK 流的终结事件，不再等待后续（防止 interrupt 后流不关闭导致挂起）
        return;
      }
    }
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string, sessionManager?: any): Promise<AsyncIterable<AgentEvent>> {
    // 记录当前 evolclaw session ID，用于 Agent ctl 环境变量注入
    this.currentEvolclawSessionId = sessionId;

    // 同步用户级配置到内存
    this.syncFromUserSettings();

    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 agentSessionId（从数据库恢复），否则使用内存中的
    let agentSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

    // 验证会话文件是否存在且有效（仅在有 agentSessionId 时）
    if (agentSessionId) {
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
      // 特殊处理：AskUserQuestion 工具（SDK 内置的用户交互工具）
      // 这不是权限审批，而是收集用户答案，需要构造表单卡片
      if (toolName === 'AskUserQuestion') {
        return await this.handleAskUserQuestion(sessionId, input, options);
      }

      // 特殊处理：ExitPlanMode 工具（plan mode 审批）
      if (toolName === 'ExitPlanMode') {
        return await this.handleExitPlanMode(sessionId, input, options);
      }

      // bypass 模式：一律 allow
      if (this.permissionMode === 'bypass') {
        return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
      }

      // evolclaw ctl send/file 白名单：proactive 模式下 agent 必须通过这些命令发送消息，
      // 任何权限模式下都不应拦截，否则 agent 无法回复用户
      if (toolName === 'Bash') {
        const cmd = (input.command as string) || '';
        if (/^\s*evolclaw\s+ctl\s+(send|file)\b/.test(cmd)) {
          return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
        }
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
        this.permissionContexts.get(sessionId),
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

    const useSettingSources = this.config?.agents?.claude?.useSettingSources !== false;
    const enableSummaries = this.config?.agents?.claude?.agentProgressSummaries !== false;
    const excludeDynamic = this.config?.agents?.claude?.excludeDynamicSections === true;

    // 公共 options（新旧模式共用）
    const sdkPermissionMode = this.toSdkPermissionMode();
    logger.info(`[AgentRunner] runQuery model=${this.model} effort=${this.effort ?? 'auto'} permMode=${this.permissionMode} sdkMode=${sdkPermissionMode}`);
    if (systemPromptAppend) {
      logger.info(`[AgentRunner] systemPromptAppend: ${systemPromptAppend.length} chars`);
    } else {
      logger.info(`[AgentRunner] systemPromptAppend: none`);
    }
    const commonOptions = {
      cwd: projectPath,
      model: this.model,
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.claudeExecutablePath ? { pathToClaudeCodeExecutable: this.claudeExecutablePath } : {}),
      autoCompactWindow: 200000,
      advisorModel: 'haiku',
      canUseTool: canUseToolCallback,
      permissionMode: sdkPermissionMode,
      persistSession: true,
      enableFileCheckpointing: true,
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

    const createQuery = (promptInput: string | MessageStream, resumeSessionId?: string, resumeAt?: string) => {
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
            ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
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
            ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
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

    // 检查待处理的 resumeAt（由 /rewind N chat 设置）
    let resumeAt: string | undefined;
    if (sessionManager && agentSessionId) {
      try {
        const currentSession = await sessionManager.getSessionById?.(sessionId);
        if (currentSession?.metadata?.resumeAt) {
          resumeAt = currentSession.metadata.resumeAt;
          const newMeta = { ...currentSession.metadata };
          delete newMeta.resumeAt;
          await sessionManager.updateSession(sessionId, { metadata: newMeta });
          logger.info(`[AgentRunner] Consuming resumeAt: ${resumeAt}`);
        }
      } catch (err) {
        logger.warn('[AgentRunner] Failed to check resumeAt:', err);
      }
    }

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
      sdkStream = createQuery(prompt, agentSessionId, resumeAt);
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
    this.permissionContexts.delete(sessionId);
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

  async getSessionMessages(agentSessionId: string, projectPath: string) {
    return sdkGetSessionMessages(agentSessionId, { dir: projectPath });
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string) {
    logger.info(`[RewindFiles] agentSessionId=${agentSessionId} userMessageId=${userMessageId}`);
    const stderrChunks: string[] = [];
    const tempQuery = query({
      prompt: '',
      options: {
        cwd: projectPath,
        resume: agentSessionId,
        enableFileCheckpointing: true,
        permissionMode: this.toSdkPermissionMode(),
        stderr: (data: string) => { stderrChunks.push(data); },
      }
    });
    try {
      for await (const _msg of tempQuery) {
        const dryResult = await tempQuery.rewindFiles(userMessageId, { dryRun: true });
        logger.info('[RewindFiles] dryRun result:', JSON.stringify(dryResult));
        if (!dryResult.canRewind) return dryResult;
        const result = await tempQuery.rewindFiles(userMessageId);
        logger.info('[RewindFiles] rewind result:', JSON.stringify(result));
        return {
          ...result,
          filesChanged: dryResult.filesChanged ?? result.filesChanged,
          insertions: dryResult.insertions ?? result.insertions,
          deletions: dryResult.deletions ?? result.deletions,
        };
      }
      throw new Error('Query stream ended before rewindFiles could be called');
    } catch (error) {
      if (stderrChunks.length > 0) {
        logger.error('[RewindFiles] subprocess stderr:', stderrChunks.join(''));
      }
      throw error;
    } finally {
      tempQuery.close();
    }
  }
}

// Plugin implementation
export class ClaudeAgentPlugin implements AgentPlugin {
  readonly name = 'claude';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    return agent.baseagent === 'claude';
  }

  createAgent(agent: import('../core/evolagent.js').EvolAgent, callbacks: AgentCallbacks): AgentInstance | null {
    const override = agent.config.baseagents?.claude as
      | { apiKey?: string; baseUrl?: string; model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; pathToClaudeCodeExecutable?: string }
      | undefined;
    const syntheticConfig = { agents: { claude: override } } as Config;
    const anthropic = resolveAnthropicConfig(syntheticConfig, override);
    const merged: Config = {
      agents: { claude: { ...(override || {}) } },
    } as Config;
    const agentRunner = new AgentRunner(
      anthropic.apiKey,
      anthropic.model,
      callbacks.onSessionIdUpdate,
      anthropic.baseUrl,
      merged
    );
    if (anthropic.effort) {
      agentRunner.setEffort(anthropic.effort);
    }
    return { evolagentName: agent.name, baseagent: 'claude', agent: agentRunner };
  }
}
