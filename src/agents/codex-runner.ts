/**
 * Codex Agent Runner
 *
 * Integrates Codex app-server as an agent backend.
 * Implements the same interface surface as AgentRunner (claude-runner.ts)
 * so MessageProcessor and CommandHandler can work with it transparently.
 */

import type { Config, InteractionRequest } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { AgentEvent, AgentRunnerFull, ModelSwitcher, PermissionContext, PermissionModeInfo } from './runner-types.js';
import { checkBlacklist, checkReadonly, type PermissionGateway } from '../core/permission.js';
import { CodexAppServerClient, type CodexServerNotification, type CodexServerRequest, type CodexThreadResponse, type CodexTurnItem } from './codex-app-server-client.js';
import { resolveOpenaiConfig } from './baseagent.js';
import { logger } from '../utils/logger.js';
import { renderActionAsText } from '../core/interaction-router.js';
import { buildEnvelope, sendInteractionPayload } from '../core/message/message-processor.js';
import { compareVersions } from '../utils/npm-ops.js';
import { resolveRoot } from '../paths.js';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── MIME → 扩展名映射 ──
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ── Codex 模型目录（动态获取，含 effort） ──
interface CodexModelInfo { slug: string; efforts: string[] }

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private done = false;
  private error: Error | null = null;
  private waiting: (() => void) | null = null;

  push(item: T): void {
    if (this.done) return;
    this.queue.push(item);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

interface AppServerStreamState {
  threadId: string;
  turnId?: string;
  streamedAgentMessageIds: Set<string>;
  agentMessageDeltaText: Map<string, string>;
  completedItemIds: Set<string>;
  emittedEditCallIds: Set<string>;
  completedTurnIds: Set<string>;
  tokenUsage?: any;
}

type CompleteAgentEvent = Extract<AgentEvent, { type: 'complete' }>;
type NormalizedTokenUsage = NonNullable<CompleteAgentEvent['tokenUsage']>;
type NormalizedContextUsage = NonNullable<CompleteAgentEvent['contextUsage']>;

const CODEX_CATALOG_FALLBACK: CodexModelInfo[] = [
  { slug: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
];
let codexCatalogCache: CodexModelInfo[] | null = null;

export const MIN_CODEX_CLI_VERSION = '0.117.0';

export interface CodexAppServerAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

export function parseCodexCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareVersions(version, MIN_CODEX_CLI_VERSION) >= 0;
}

export function getCodexCliVersion(): string | null {
  try {
    const output = execFileSync('codex', ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return parseCodexCliVersion(output);
  } catch {
    return null;
  }
}

export function getCodexAppServerAvailability(): CodexAppServerAvailability {
  const version = getCodexCliVersion();
  const upgradeHint = '请升级 Codex CLI：npm install -g @openai/codex@latest';
  if (!version) {
    return { available: false, reason: `未检测到可用 Codex CLI。${upgradeHint}` };
  }
  if (!isCodexCliVersionSupported(version)) {
    return {
      available: false,
      version,
      reason: `Codex CLI ${version} 低于最低要求 ${MIN_CODEX_CLI_VERSION}。${upgradeHint}`,
    };
  }

  try {
    execFileSync('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { available: true, version };
  } catch {
    return { available: false, version, reason: `Codex CLI ${version} 不支持 app-server。${upgradeHint}` };
  }
}

export function isCodexAppServerAvailable(): boolean {
  return getCodexAppServerAvailability().available;
}

function fetchCodexCatalog(): CodexModelInfo[] {
  if (codexCatalogCache) return codexCatalogCache;
  try {
    const output = execFileSync('codex', ['debug', 'models'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const catalog = JSON.parse(output);
    const models = (catalog.models as any[])
      .filter(m => m.visibility === 'list')
      .map(m => ({
        slug: m.slug as string,
        efforts: ((m.supported_reasoning_levels || []) as any[]).map(l => l.effort as string),
      }));
    if (models.length > 0) {
      codexCatalogCache = models;
      return models;
    }
  } catch (e) {
    logger.debug(`[CodexRunner] Failed to fetch model catalog, using fallback: ${e}`);
  }
  return CODEX_CATALOG_FALLBACK;
}

export function getCodexEfforts(model: string): string[] {
  const catalog = fetchCodexCatalog();
  const entry = catalog.find(m => m.slug === model);
  return entry?.efforts ?? catalog[0]?.efforts ?? ['low', 'medium', 'high'];
}

// ── Codex Runner ──

export class CodexRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'codex';
  readonly capabilities: NonNullable<AgentRunnerFull['capabilities']>;
  private model: string;
  private effort?: string;
  private activeAbortControllers = new Map<string, AbortController>();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → threadId
  private activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private appServerClient: CodexAppServerClient | null = null;
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContexts = new Map<string, PermissionContext>();
  private resolvedConfig: { apiKey: string; baseUrl?: string; model: string; effort?: string; enableRequestUserInput?: boolean; approvalsReviewer?: string };

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolvedConfig = resolveOpenaiConfig(config);
    this.capabilities = {
      clear: false,
      compact: true,
      fork: true,
      // Requires Codex CLI feature flag: default_mode_request_user_input.
      askUserQuestion: this.resolvedConfig.enableRequestUserInput === true,
      // Codex app-server exposes plan streaming, but not Claude-style ExitPlanMode approval.
      planApproval: false,
      // Current file rewind is intentionally degraded: it restores touched files from Git HEAD.
      fileRewind: 'git-head' as const,
    };
    this.model = this.resolvedConfig.model;
    if (this.resolvedConfig.effort) this.effort = this.resolvedConfig.effort;
    this.onSessionIdUpdate = callbacks.onSessionIdUpdate;
  }

  private getAppServerClient(): CodexAppServerClient {
    if (!this.appServerClient) {
      this.appServerClient = new CodexAppServerClient({
        apiKey: this.resolvedConfig.apiKey,
        baseUrl: this.resolvedConfig.baseUrl,
        model: this.model,
        effort: this.effort,
        enableRequestUserInput: this.resolvedConfig.enableRequestUserInput,
        approvalsReviewer: this.resolvedConfig.approvalsReviewer,
        onServerRequest: request => this.handleAppServerRequest(request),
      });
    }
    return this.appServerClient;
  }

  private resetAppServerClient(): void {
    const client = this.appServerClient;
    this.appServerClient = null;
    client?.close().catch(error => {
      logger.debug(`[CodexRunner] Failed to close stale app-server client: ${error}`);
    });
  }

  // ── ModelSwitcher ──

  setModel(model: string): void { this.model = model; this.resetAppServerClient(); }
  getModel(): string { return this.model; }
  async listModels(): Promise<string[]> {
    try {
      const response = await this.getAppServerClient().modelList(false);
      const ids = (response.data ?? [])
        .map(model => model.id || model.slug || model.name || model.model)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) return ids;
    } catch (error) {
      logger.debug(`[CodexRunner] app-server model/list failed, using catalog fallback: ${error}`);
    }
    return fetchCodexCatalog().map(m => m.slug);
  }

  // ── Effort ──

  setEffort(effort: string | undefined): void { this.effort = effort; this.resetAppServerClient(); }
  getEffort(): string | undefined { return this.effort; }

  // ── Permission ──

  private currentMode: string = 'auto';
  private approvalPolicy: string = 'never';
  private sandboxMode: string = 'danger-full-access';

  setMode(mode: string): void {
    const map: Record<string, string> = {
      // Codex app-server also supports auto_review, but EvolClaw auto currently means:
      // run local blacklist/readonly guards, then approve app-server requests without
      // app-server reviewer escalation. Changing this requires a semantic decision.
      'auto': 'never',
      'bypass': 'never',
      'readonly': 'on-request',
      'request': 'on-request',
      'noask': 'untrusted',
    };
    this.currentMode = mode;
    this.approvalPolicy = map[mode] || 'never';
    this.sandboxMode = this.toSandboxMode(mode);
  }
  getMode(): string { return this.currentMode; }
  listModes(): PermissionModeInfo[] {
    return [
      { key: 'auto', nameZh: '自动', description: '全部自动（受 sandbox 约束）', available: true },
      { key: 'bypass', nameZh: '放行', description: '全部自动（受 sandbox 约束）', available: true },
      { key: 'readonly', nameZh: '只读', description: '允许读取和临时目录写入，拒绝项目文件修改', available: true },
      { key: 'request', nameZh: '审批', description: '需要审批时询问', available: true },
      { key: 'noask', nameZh: '静默', description: '只执行已知安全操作', available: true },
    ];
  }
  setSendPrompt(fn: (text: string) => Promise<void>): void { this.sendPromptFn = fn; }
  setPermissionContext(sessionId: string, context: PermissionContext): void { this.permissionContexts.set(sessionId, context); }
  setPermissionGateway(gw: PermissionGateway): void { this.permissionGateway = gw; }

  private toSandboxMode(mode: string): string {
    if (mode === 'request' || mode === 'readonly' || mode === 'noask') return 'read-only';
    return 'danger-full-access';
  }

  // ── Stream management (needed by MessageProcessor) ──

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(key: string): void {
    this.activeStreams.delete(key);
    this.activeAbortControllers.delete(key);
  }

  hasActiveStream(key: string): boolean {
    return this.activeStreams.has(key) || this.activeAbortControllers.has(key) || this.activeTurns.has(key);
  }

  // ── Core: runQuery ──

  async runQuery(
    sessionId: string,
    prompt: string,
    projectPath: string,
    initialAgentSessionId?: string,
    images?: Array<{ data: string; mimeType?: string }>,
    systemPromptAppend?: string,
    sessionManager?: any,
    modelOverride?: { model?: string; effort?: string }
  ): Promise<AsyncIterable<AgentEvent>> {
    let agentSessionId = initialAgentSessionId || this.activeSessions.get(sessionId);
    const callModel = modelOverride?.model || this.model;
    const callEffort = modelOverride?.effort ?? this.effort;
    const appServer = this.getAppServerClient();
    const threadOptions = {
      model: callModel,
      effort: callEffort,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: this.resolvedConfig.approvalsReviewer,
      sandbox: this.sandboxMode,
      config: this.buildEvolclawShellEnvironmentConfig(sessionId),
      ...(systemPromptAppend ? { developerInstructions: systemPromptAppend } : {}),
    };

    const threadResponse = agentSessionId
      ? await appServer.threadResume(agentSessionId, projectPath, threadOptions)
      : await appServer.threadStart(projectPath, threadOptions);
    const threadId = threadResponse.thread?.id || agentSessionId;
    if (!threadId) throw new Error('Codex app-server did not return a thread id');

    agentSessionId = threadId;
    this.activeSessions.set(sessionId, threadId);
    this.onSessionIdUpdate?.(sessionId, threadId);

    const controller = new AbortController();
    this.activeAbortControllers.set(sessionId, controller);

    const tempFiles: string[] = [];
    const input = this.buildAppServerInput(prompt, images, tempFiles);
    const queue = new AsyncEventQueue<CodexServerNotification>();
    controller.signal.addEventListener('abort', () => queue.end(), { once: true });
    const state: AppServerStreamState = {
      threadId,
      streamedAgentMessageIds: new Set(),
      agentMessageDeltaText: new Map(),
      completedItemIds: new Set(),
      emittedEditCallIds: new Set(),
      completedTurnIds: new Set(),
    };
    const unsubscribe = appServer.onNotification(notification => {
      // 仅从 turn/started 锁定权威 turnId — resume 时会有上一轮 turn 的残留通知
      // （如 thread/tokenUsage/updated）先于新 turn 到达，不能用它们 latch turnId
      const params: any = notification.params || {};
      const notifThreadId = params.threadId ?? params.thread_id;
      if (notifThreadId !== undefined && notifThreadId !== threadId) return;
      if (notification.method === 'turn/started') {
        const startedTurnId = this.extractTurnId(notification);
        if (startedTurnId && !state.turnId) {
          state.turnId = startedTurnId;
          this.activeTurns.set(sessionId, { threadId, turnId: startedTurnId });
        }
      }
      if (!this.isAppServerTurnNotification(notification, state)) return;
      queue.push(notification);
      // 仅在已锁定 turnId 后才允许 turn/completed 结束队列，避免残留的旧 turn/completed 误关
      if (notification.method === 'turn/completed' && state.turnId) queue.end();
    });

    try {
      const turnResponse = await appServer.turnStart(threadId, input, {
        cwd: projectPath,
        model: callModel,
        effort: callEffort,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandboxMode,
      });
      const turnId = turnResponse.turn?.id;
      if (turnId && !state.turnId) {
        state.turnId = turnId;
        this.activeTurns.set(sessionId, { threadId, turnId });
      }
      const status = turnResponse.turn?.status;
      if (status === 'completed' || status === 'failed') {
        queue.push({ method: 'turn/completed', params: { threadId, turn: turnResponse.turn as any } });
        queue.end();
      }
    } catch (error) {
      unsubscribe();
      this.activeAbortControllers.delete(sessionId);
      this.activeTurns.delete(sessionId);
      this.cleanupTempFiles(tempFiles);
      throw error;
    }

    return this.transformAppServerStream(queue, sessionId, state, unsubscribe, tempFiles);
  }

  // ── Interrupt ──

  async interrupt(sessionKey: string): Promise<void> {
    const controller = this.activeAbortControllers.get(sessionKey);
    const activeTurn = this.activeTurns.get(sessionKey);
    const hadActiveState = !!controller || !!activeTurn || this.activeStreams.has(sessionKey);
    const interruptTurn = activeTurn
      ? this.getAppServerClient().turnInterrupt(activeTurn.threadId, activeTurn.turnId).catch(error => {
        logger.debug(`[CodexRunner] app-server turn interrupt failed: ${error}`);
      })
      : Promise.resolve();

    if (controller) controller.abort('User interrupt');

    if (hadActiveState) {
      this.activeAbortControllers.delete(sessionKey);
      this.activeStreams.delete(sessionKey);
      this.activeTurns.delete(sessionKey);
      logger.info(`[CodexRunner] Interrupted session: ${sessionKey}`);
    }
    await interruptTurn;
  }

  // ── Session commands ──

  updateSessionId(sessionId: string, agentSessionId: string): void {
    if (agentSessionId) {
      this.activeSessions.set(sessionId, agentSessionId);
    } else {
      this.activeSessions.delete(sessionId);
    }
    this.onSessionIdUpdate?.(sessionId, agentSessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
    this.activeAbortControllers.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.permissionContexts.delete(sessionId);
  }

  resolveSessionFile(agentSessionId: string, _projectPath: string): string | null {
    // Codex session 文件: ~/.codex/sessions/YYYY/MM/DD/rollout-*-{threadId}.jsonl
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    // 递归搜索文件名包含 threadId 的 JSONL 文件
    const search = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const found = search(path.join(dir, entry.name));
          if (found) return found;
        } else if (entry.name.endsWith('.jsonl') && entry.name.includes(agentSessionId)) {
          return path.join(dir, entry.name);
        }
      }
      return null;
    };

    return search(sessionsDir);
  }

  async clearSession(sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Codex: 清空会话 = 下次 runQuery 不传 resumeId，自动创建新 thread
    this.activeSessions.delete(sessionId);
    this.onSessionIdUpdate?.(sessionId, '');
    return true;
  }

  async compactSession(_sessionId: string, agentSessionId: string, _projectPath: string): Promise<boolean> {
    try {
      const appServer = this.getAppServerClient();
      this.onCompactStart?.(_sessionId);
      try {
        return await this.startAndWaitForCompact(appServer, agentSessionId);
      } catch (error) {
        if (!this.isThreadNotFoundError(error)) throw error;
        logger.info(`[CodexRunner] Compact thread not loaded, resuming before compact: ${agentSessionId}`);
        await appServer.threadResume(agentSessionId, _projectPath, {
          model: this.model,
          effort: this.effort,
          approvalPolicy: this.approvalPolicy,
          approvalsReviewer: this.resolvedConfig.approvalsReviewer,
          sandbox: this.sandboxMode,
          config: this.buildEvolclawShellEnvironmentConfig(_sessionId),
        });
        return await this.startAndWaitForCompact(appServer, agentSessionId);
      }
    } catch (error) {
      logger.error('[CodexRunner] Compact failed:', error);
      return false;
    }
  }

  async compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    return this.compactSession(sessionId, agentSessionId, projectPath);
  }

  private async startAndWaitForCompact(appServer: CodexAppServerClient, threadId: string): Promise<boolean> {
    const completion = this.waitForThreadCompacted(appServer, threadId, Date.now());
    try {
      await appServer.threadCompactStart(threadId);
      await completion.promise;
      return true;
    } finally {
      completion.dispose();
    }
  }

  private waitForThreadCompacted(appServer: CodexAppServerClient, threadId: string, startedAtMs: number): { promise: Promise<void>; dispose: () => void } {
    let unsubscribe: (() => void) | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (resolve: () => void, source: string) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      logger.info(`[CodexRunner] Compact completed for thread: ${threadId} (${source})`);
      unsubscribe?.();
      resolve();
    };
    const promise = new Promise<void>(resolve => {
      unsubscribe = appServer.onNotification(notification => {
        if (notification.method !== 'thread/compacted') return;
        const params: any = notification.params || {};
        const notifThreadId = params.threadId ?? params.thread_id;
        if (notifThreadId !== threadId) return;
        settle(resolve, 'notification');
      });
      pollTimer = setInterval(() => {
        if (this.hasPersistedCompactCompletion(threadId, startedAtMs)) {
          settle(resolve, 'session-log');
        }
      }, 1000);
      pollTimer.unref?.();
    });
    return {
      promise,
      dispose: () => {
        if (pollTimer) clearInterval(pollTimer);
        if (!settled) unsubscribe?.();
      },
    };
  }

  private hasPersistedCompactCompletion(threadId: string, startedAtMs: number): boolean {
    const sessionFile = this.findCodexSessionFile(threadId);
    if (!sessionFile) return false;
    let text = '';
    try {
      text = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return false;
    }

    const threshold = startedAtMs - 1000;
    for (const line of text.trimEnd().split('\n').reverse()) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts < threshold) break;
      const payloadType = entry.payload?.type;
      if (entry.type === 'compacted' || payloadType === 'context_compacted') return true;
    }
    return false;
  }

  private findCodexSessionFile(threadId: string): string | undefined {
    const root = process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'sessions')
      : path.join(process.env.HOME || os.homedir(), '.codex', 'sessions');
    const stack = [root];
    let newest: { path: string; mtimeMs: number } | undefined;
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {
            continue;
          }
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path: fullPath, mtimeMs };
        }
      }
    }
    return newest?.path;
  }

  async forkSession(agentSessionId: string, projectPath: string, title?: string): Promise<string> {
    const response = await this.getAppServerClient().threadFork(agentSessionId, projectPath, title);
    const forkedThreadId = response.thread?.id;
    if (!forkedThreadId) throw new Error('Codex fork did not return a thread id');
    return forkedThreadId;
  }

  async setSessionName(agentSessionId: string, name: string): Promise<boolean> {
    return this.getAppServerClient().threadSetName(agentSessionId, name);
  }

  async updateSessionMetadata(agentSessionId: string, metadata: Record<string, any>): Promise<boolean> {
    const gitInfo = metadata?.gitInfo && typeof metadata.gitInfo === 'object' ? metadata.gitInfo : undefined;
    return this.getAppServerClient().threadMetadataUpdate(agentSessionId, gitInfo);
  }

  async getSessionMessages(agentSessionId: string, projectPath: string): Promise<Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }>> {
    const response = await this.getAppServerClient().threadRead(agentSessionId, true);
    return this.mapThreadToSessionMessages(response, agentSessionId);
  }

  private async handleAppServerRequest(request: CodexServerRequest): Promise<any> {
    const params = (request.params || {}) as Record<string, any>;
    if (request.method === 'item/tool/requestUserInput') {
      return this.handleToolRequestUserInput(params);
    }

    const sessionKey = this.findSessionKeyByThread(params.threadId || params.conversationId);
    const toolName = request.method.includes('fileChange') || request.method === 'applyPatchApproval' ? 'FileChange' : 'Bash';
    const toolInput = this.buildPermissionInput(request.method, params);
    const summary = this.summarizeAppServerRequest(request.method, params);
    const reason = params.reason || params.decisionReason || undefined;
    const projectPath = this.resolvePermissionProjectPath(params);
    logger.info(`[CodexRunner] app-server approval request id=${request.id} method=${request.method} session=${sessionKey} mode=${this.currentMode} tool=${toolName} summary=${summary}`);
    try {
      const decision = await this.resolvePermissionDecision(sessionKey, toolName, toolInput, summary, reason, projectPath);
      const response = this.toAppServerApprovalResponse(request.method, decision);
      logger.info(`[CodexRunner] app-server approval response id=${request.id} method=${request.method} decision=${decision} response=${JSON.stringify(response)}`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[CodexRunner] app-server approval failed id=${request.id} method=${request.method}: ${message}`);
      throw error;
    }
  }

  private async handleToolRequestUserInput(params: Record<string, any>): Promise<Record<string, unknown>> {
    const sessionKey = this.findSessionKeyByThread(params.threadId);
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const answers: Record<string, { answers: string[] }> = {};

    for (const question of questions) {
      const questionId = typeof question.id === 'string' ? question.id : `q-${Object.keys(answers).length + 1}`;
      answers[questionId] = {
        answers: await this.collectUserInputAnswer(sessionKey, question),
      };
    }

    return { answers };
  }

  private async collectUserInputAnswer(sessionKey: string, question: Record<string, any>): Promise<string[]> {
    const options = Array.isArray(question.options) ? question.options : [];
    const fallback = options[0]?.label ? [String(options[0].label)] : [''];
    const context = this.permissionContexts.get(sessionKey);
    const canFreeText = question.isOther !== false || options.length === 0;
    const sendPrompt = context?.adapter && context.channelId
      ? async (text: string) => context.adapter!.send(buildEnvelope({
        channel: context.adapter!.channelName,
        channelId: context.channelId!,
        replyContext: context.replyContext,
      }), { kind: 'result.text', text, isFinal: true })
      : this.sendPromptFn;

    if (!context?.interactionRouter || !sendPrompt) {
      if (sendPrompt) await sendPrompt(this.formatUserInputFallback(question, fallback));
      return fallback;
    }

    const requestId = `codex-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const buttonArgMap: Record<string, string> = {};
    const buttons = options.length > 0
      ? options.map((option: any, index: number) => {
        const key = `opt-${index}`;
        buttonArgMap[key] = String(index + 1);
        return { key, label: String(option.label || `选项 ${index + 1}`), style: 'default' as const };
      })
      : [{ key: 'custom', label: '提交', style: 'primary' as const }];
    const bodyLines = [String(question.question || '')];
    if (options.some((option: any) => option.description)) {
      bodyLines.push('', ...options.map((option: any, index: number) =>
        `${index + 1}. ${String(option.label || `选项 ${index + 1}`)}${option.description ? ` — ${option.description}` : ''}`));
    }

    const interaction: InteractionRequest = {
      type: 'interaction',
      id: requestId,
      channelId: context.channelId || '',
      sessionId: sessionKey,
      initiatorId: context.userId,
      kind: {
        kind: 'action',
        title: String(question.header || '问题'),
        body: bodyLines.join('\n'),
        buttons,
        allowCustomInput: canFreeText,
      },
      fallback: {
        command: 'ask',
        buttonArgMap,
        acceptFreeText: canFreeText,
        freeTextHint: canFreeText ? '或回复 /ask <自定义内容>' : undefined,
      },
    };

    const router = context.interactionRouter;
    router.markWaiting(sessionKey);
    let waitMarked = true;
    let sent = false;
    try {
      await context.flushPending?.();
      if (context.adapter && context.channelId) {
        const envelope = buildEnvelope({
          taskId: context.taskId,
          channel: context.channel ?? context.adapter.channelName,
          channelId: context.channelId,
          agentName: context.agentName,
          chatmode: context.chatmode,
          replyContext: context.replyContext,
        });
        sent = !!await sendInteractionPayload(context.adapter, envelope, interaction, undefined, context.replyContext);
      }
      if (!sent) {
        await sendPrompt(renderActionAsText(interaction));
        sent = true;
      }
    } catch (error) {
      logger.warn('[CodexRunner] requestUserInput prompt send failed:', error);
    }

    if (!sent) {
      router.unmarkWaiting(sessionKey);
      return fallback;
    }

    return new Promise<string[]>((resolve) => {
      router.register(requestId, sessionKey, (action: string, values?: Record<string, any>) => {
        resolve(this.parseUserInputAction(action, values, options, fallback));
      }, {
        initiatorId: context.userId,
        fallbackCommand: 'ask',
      });
      if (waitMarked) {
        router.unmarkWaiting(sessionKey);
        waitMarked = false;
      }
    });
  }

  private parseUserInputAction(action: string, values: Record<string, any> | undefined, options: any[], fallback: string[]): string[] {
    if (action === '_custom_input') {
      const customText = typeof values?.custom_text === 'string' ? values.custom_text.trim() : '';
      return customText ? [customText] : fallback;
    }
    if (action.startsWith('opt-')) {
      const index = Number.parseInt(action.slice(4), 10);
      const label = options[index]?.label;
      return label ? [String(label)] : fallback;
    }
    const selected = action.split(',').map(part => part.trim()).filter(Boolean);
    if (selected.length > 0 && selected.every(part => /^\d+$/.test(part))) {
      const labels = selected
        .map(part => options[Number.parseInt(part, 10) - 1]?.label)
        .filter((label): label is string => typeof label === 'string' && label.length > 0);
      if (labels.length > 0) return labels;
    }
    return action.trim() ? [action.trim()] : fallback;
  }

  private formatUserInputFallback(question: Record<string, any>, fallback: string[]): string {
    const options = Array.isArray(question.options) ? question.options : [];
    const lines = [String(question.header || '问题'), String(question.question || '')].filter(Boolean);
    if (options.length > 0) {
      lines.push('', ...options.map((option: any, index: number) =>
        `${index + 1}. ${String(option.label || `选项 ${index + 1}`)}${option.description ? ` — ${option.description}` : ''}`));
    }
    lines.push('', `自动选择：${fallback.join(', ')}`);
    return lines.join('\n');
  }

  private findSessionKeyByThread(threadId?: string): string {
    if (threadId) {
      for (const [sessionKey, activeThreadId] of this.activeSessions.entries()) {
        if (activeThreadId === threadId) return sessionKey;
      }
    }
    return threadId || 'codex-app-server';
  }

  private buildPermissionInput(method: string, params: Record<string, any>): Record<string, unknown> {
    if (method.includes('fileChange') || method === 'applyPatchApproval') {
      return { fileChanges: params.fileChanges, grantRoot: params.grantRoot, reason: params.reason };
    }
    const command = Array.isArray(params.command) ? params.command.join(' ') : (params.command || '');
    return { command, cwd: params.cwd, reason: params.reason, commandActions: params.commandActions || params.parsedCmd };
  }

  private summarizeAppServerRequest(method: string, params: Record<string, any>): string {
    if (method.includes('fileChange') || method === 'applyPatchApproval') {
      if (params.grantRoot) return '允许写入：' + params.grantRoot;
      const changes = params.fileChanges && typeof params.fileChanges === 'object' ? Object.keys(params.fileChanges) : [];
      return changes.length ? changes.join(', ') : '文件变更审批';
    }
    const command = Array.isArray(params.command) ? params.command.join(' ') : params.command;
    return command || '命令执行审批';
  }

  private resolvePermissionProjectPath(params: Record<string, any>): string {
    const candidates = [params.cwd, params.projectPath, params.grantRoot]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate)) return candidate;
    }
    return process.cwd();
  }

  private checkCodexReadonly(toolName: string, input: Record<string, unknown>, projectPath: string): { behavior: 'allow' } | { behavior: 'deny'; message: string } {
    if (toolName === 'Bash') return checkReadonly(toolName, input, projectPath);
    if (toolName !== 'FileChange') return { behavior: 'allow' };

    const tmpDir = path.join(projectPath, '.evolclaw', 'tmp') + path.sep;
    const isAllowedPath = (filePath: string): boolean => {
      const resolved = path.resolve(projectPath, filePath) + (filePath.endsWith(path.sep) ? path.sep : '');
      return resolved.startsWith(tmpDir) || resolved === tmpDir.slice(0, -1);
    };

    const grantRoot = input.grantRoot;
    if (typeof grantRoot === 'string' && grantRoot && !isAllowedPath(grantRoot)) {
      return { behavior: 'deny', message: '🔒 只读模式：禁止修改项目文件。如需生成文件请写入 .evolclaw/tmp/ 目录' };
    }

    const fileChanges = input.fileChanges;
    const paths = fileChanges && typeof fileChanges === 'object' ? Object.keys(fileChanges as Record<string, unknown>) : [];
    if (paths.some(filePath => !isAllowedPath(filePath))) {
      return { behavior: 'deny', message: '🔒 只读模式：禁止修改项目文件。如需生成文件请写入 .evolclaw/tmp/ 目录' };
    }

    return { behavior: 'allow' };
  }

  private async resolvePermissionDecision(
    sessionKey: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    summary: string,
    reason?: string,
    projectPath = process.cwd()
  ): Promise<'allow' | 'always' | 'deny'> {
    const blacklist = await checkBlacklist(toolName, toolInput);
    if (blacklist.behavior === 'deny') return 'deny';

    if (toolName === 'Bash' && this.isEvolclawCtlSendOrFile(blacklist.updatedInput)) {
      return 'allow';
    }

    if (this.currentMode === 'readonly') {
      const readonly = this.checkCodexReadonly(toolName, blacklist.updatedInput, projectPath);
      if (readonly.behavior === 'deny') return 'deny';
      return 'allow';
    }

    if (this.currentMode === 'bypass' || this.currentMode === 'auto') return 'allow';
    if (this.currentMode === 'noask') return 'deny';
    if (!this.permissionGateway || !this.sendPromptFn) return 'allow';
    if (this.permissionGateway.isAlwaysAllowed(toolName)) return 'always';
    return this.permissionGateway.requestPermission(
      sessionKey,
      toolName,
      toolInput,
      this.sendPromptFn,
      this.permissionContexts.get(sessionKey),
      summary,
      reason
    );
  }

  private isEvolclawCtlSendOrFile(input: Record<string, unknown>): boolean {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!/^(?:ec|evolclaw)\s+ctl\s+(?:send|file)(?:\s|$)/.test(command)) return false;
    // Keep the whitelist to a single CLI invocation. If text contains shell control
    // syntax, fall back to the normal permission mode instead of silently approving.
    return !/[;&|`]|[$][(]|\r|\n/.test(command);
  }

  private toAppServerApprovalResponse(method: string, decision: 'allow' | 'always' | 'deny'): Record<string, unknown> {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: decision === 'deny' ? 'denied' : decision === 'always' ? 'approved_for_session' : 'approved' };
    }
    if (method === 'item/commandExecution/requestApproval') {
      return { decision: decision === 'deny' ? 'decline' : decision === 'always' ? 'acceptForSession' : 'accept' };
    }
    if (method === 'item/fileChange/requestApproval') {
      return { decision: decision === 'deny' ? 'decline' : decision === 'always' ? 'acceptForSession' : 'accept' };
    }
    if (method === 'item/permissions/requestApproval') {
      if (decision === 'deny') throw new Error('Permission request denied');
      return { permissions: {}, scope: decision === 'always' ? 'session' : 'turn' };
    }
    throw new Error('Unsupported Codex app-server request: ' + method);
  }

  async rollbackSessionTurns(agentSessionId: string, _projectPath: string, numTurns: number): Promise<boolean> {
    if (numTurns < 1) return true;
    const response = await this.getAppServerClient().threadRollback(agentSessionId, numTurns);
    return !!response.thread;
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }> {
    const messages = await this.getSessionMessages(agentSessionId, projectPath);
    const targetIndex = messages.findIndex(message => message.uuid === userMessageId);
    if (targetIndex < 0) return { canRewind: false, error: 'target turn not found' };

    const changedFiles = new Set<string>();
    for (let i = targetIndex; i < messages.length; i++) {
      const message = messages[i];
      const content = Array.isArray((message.message as any)?.content) ? (message.message as any).content : [];
      for (const part of content) {
        if (part?.type === 'file_change' && typeof part.path === 'string') changedFiles.add(part.path);
      }
    }

    if (changedFiles.size === 0) {
      return { canRewind: false, error: 'no file changes recorded for target turn' };
    }

    const snapshotFiles = [...changedFiles];
    for (const filePath of snapshotFiles) {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
      const content = this.readGitHeadFile(projectPath, filePath);
      if (content === null) {
        fs.rmSync(absolutePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }
    }

    return { canRewind: true, filesChanged: snapshotFiles };
  }

  private readGitHeadFile(projectPath: string, filePath: string): Buffer | null {
    try {
      return execFileSync('git', ['show', `HEAD:${filePath.replace(/\\/g, '/')}`], { cwd: projectPath, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  }

  private mapThreadToSessionMessages(response: CodexThreadResponse, fallbackThreadId: string): Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }> {
    const thread = response.thread;
    const threadId = thread?.id || fallbackThreadId;
    const messages: Array<{
      type: 'user' | 'assistant' | 'system';
      uuid: string;
      session_id: string;
      message: unknown;
      parent_tool_use_id: null;
    }> = [];

    for (const turn of thread?.turns ?? []) {
      for (const item of this.getTurnItems(turn)) {
        if (item.type === 'userMessage') {
          messages.push({
            type: 'user',
            uuid: item.id || turn.id || (threadId + '-user-' + messages.length),
            session_id: threadId,
            message: { role: 'user', content: this.mapUserInputToContent(item.content) },
            parent_tool_use_id: null,
          });
        } else if (item.type === 'agentMessage') {
          messages.push({
            type: 'assistant',
            uuid: item.id || turn.id || (threadId + '-assistant-' + messages.length),
            session_id: threadId,
            message: { role: 'assistant', content: item.text || '' },
            parent_tool_use_id: null,
          });
        } else if (item.type === 'file_change') {
          messages.push({
            type: 'system',
            uuid: item.id || turn.id || (threadId + '-file-' + messages.length),
            session_id: threadId,
            message: { role: 'system', content: this.mapFileChangeToContent(item) },
            parent_tool_use_id: null,
          });
        }
      }
    }

    return messages;
  }

  private getTurnItems(turn: any): CodexTurnItem[] {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const input = Array.isArray(turn?.input) ? turn.input : [];
    const output = Array.isArray(turn?.output) ? turn.output : [];
    return [...items, ...input, ...output] as CodexTurnItem[];
  }

  private mapUserInputToContent(content: unknown): Array<{ type: string; text?: string; path?: string; url?: string }> {
    if (!Array.isArray(content)) return [];
    return content.map((part: any) => {
      if (part?.type === 'text') return { type: 'text', text: part.text || '' };
      if (part?.type === 'localImage') return { type: 'image', path: part.path };
      if (part?.type === 'image') return { type: 'image', url: part.url };
      return { type: 'text', text: part?.text || part?.name || '' };
    });
  }

  private mapFileChangeToContent(item: CodexTurnItem): Array<{ type: string; path: string; kind?: string }> {
    const changes = this.normalizeFileChanges((item as any).changes);
    return changes
      .filter((change: any) => typeof change?.path === 'string')
      .map((change: any) => {
        const kind = this.normalizeFileChangeKind(change.kind ?? change.type);
        return {
          type: 'file_change',
          path: change.path,
          ...(kind ? { kind } : {}),
        };
      });
  }

  private normalizeFileChanges(changes: unknown): any[] {
    if (Array.isArray(changes)) return changes;
    if (!changes || typeof changes !== 'object') return [];
    return Object.entries(changes as Record<string, unknown>).map(([filePath, change]) => ({
      ...(change && typeof change === 'object' ? change : {}),
      path: filePath,
    }));
  }

  private describeFileChange(change: any): string {
    const kind = this.normalizeFileChangeKind(change?.kind ?? change?.type);
    const filePath = typeof change?.path === 'string' ? change.path : '';
    return [kind || 'change', filePath].filter(Boolean).join(' ');
  }

  private normalizeFileChangeKind(kind: unknown): string | undefined {
    if (typeof kind === 'string') return kind;
    if (!kind || typeof kind !== 'object') return undefined;
    const data = kind as Record<string, unknown>;
    for (const key of ['type', 'kind', 'action', 'operation', 'op']) {
      if (typeof data[key] === 'string') return data[key];
    }
    return undefined;
  }

  private isThreadNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thread\/compact\/start failed: thread not found:/i.test(message)
      || /thread not found:/i.test(message);
  }

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  // ── Event stream transformation ──

  private buildAppServerInput(
    prompt: string,
    images: Array<{ data: string; mimeType?: string }> | undefined,
    tempFiles: string[]
  ): any[] {
    const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }];
    if (!images?.length) return input;

    const tmpDir = os.tmpdir();
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = MIME_EXT[img.mimeType || ''] || '.jpg';
      const tmpPath = path.join(tmpDir, `evolclaw-img-${Date.now()}-${i}${ext}`);
      fs.writeFileSync(tmpPath, Buffer.from(img.data, 'base64'));
      tempFiles.push(tmpPath);
      input.push({ type: 'localImage', path: tmpPath });
    }
    logger.info(`[CodexRunner] Attached ${images.length} image(s) as localImage`);
    return input;
  }

  private cleanupTempFiles(tempFiles?: string[]): void {
    if (!tempFiles?.length) return;
    for (const tempFile of tempFiles) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }

  private extractTurnId(notification: CodexServerNotification): string | undefined {
    const params: any = notification.params || {};
    return typeof params.turnId === 'string' ? params.turnId :
      typeof params.turn_id === 'string' ? params.turn_id :
      typeof params.turn?.id === 'string' ? params.turn.id : undefined;
  }

  private isAppServerTurnNotification(notification: CodexServerNotification, state: AppServerStreamState): boolean {
    const params: any = notification.params || {};
    const notifThreadId = params.threadId ?? params.thread_id;
    if (notifThreadId !== undefined && notifThreadId !== state.threadId) return false;
    const turnId = this.extractTurnId(notification);
    if (!state.turnId) {
      return notification.method === 'turn/started' || !turnId;
    }
    return !state.turnId || !turnId || turnId === state.turnId;
  }

  private async *transformAppServerStream(
    notifications: AsyncIterable<CodexServerNotification>,
    sessionId: string,
    state: AppServerStreamState,
    unsubscribe: () => void,
    tempFiles?: string[]
  ): AsyncGenerator<AgentEvent> {
    try {
      yield { type: 'session_id', sessionId: state.threadId };
      for await (const notification of notifications) {
        if (!this.activeAbortControllers.has(sessionId)) break;
        yield* this.mapAppServerNotification(notification, sessionId, state);
      }
    } finally {
      unsubscribe();
      this.activeAbortControllers.delete(sessionId);
      this.activeTurns.delete(sessionId);
      this.cleanupTempFiles(tempFiles);
    }
  }

  private *mapAppServerNotification(
    notification: CodexServerNotification,
    sessionId: string,
    state: AppServerStreamState
  ): Iterable<AgentEvent> {
    const params: any = notification.params || {};
    switch (notification.method) {
      case 'turn/started': {
        const turnId = this.extractTurnId(notification);
        if (turnId) {
          state.turnId = turnId;
          this.activeTurns.set(sessionId, { threadId: state.threadId, turnId });
        }
        yield { type: 'state_changed', state: 'running' };
        break;
      }

      case 'item/started': {
        yield* this.mapAppServerItemStarted(params.item, state);
        break;
      }

      case 'item/agentMessage/delta': {
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        if (itemId) state.streamedAgentMessageIds.add(itemId);
        if (itemId && typeof params.delta === 'string' && params.delta) {
          state.agentMessageDeltaText.set(
            itemId,
            (state.agentMessageDeltaText.get(itemId) || '') + params.delta
          );
        }
        break;
      }

      case 'item/completed': {
        const item = params.item;
        if (item?.id) state.completedItemIds.add(item.id);
        yield* this.mapAppServerItemCompleted(item, state);
        break;
      }

      case 'item/fileChange/patchUpdated': {
        yield* this.mapAppServerFileChangePatchUpdated(params, state);
        break;
      }

      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const completed = plan.filter((step: any) => step?.status === 'completed').length;
        const summary = plan.length ? `计划进度：${completed}/${plan.length}` : (params.explanation || '计划已更新');
        yield { type: 'task_progress', summary };
        break;
      }

      case 'thread/tokenUsage/updated': {
        state.tokenUsage = params.tokenUsage;
        break;
      }

      case 'thread/compacted': {
        logger.info(`[CodexRunner] Compact completed for thread: ${params.threadId || state.threadId}`);
        yield { type: 'compact', preTokens: 0 };
        break;
      }

      case 'turn/completed': {
        const turn = params.turn || {};
        const turnId = turn.id || params.turnId;
        if (turnId && state.completedTurnIds.has(turnId)) break;
        if (turnId) state.completedTurnIds.add(turnId);
        this.activeTurns.delete(sessionId);
        if (turn.status === 'failed' && turn.error?.message) {
          yield { type: 'error', error: turn.error.message, errorType: 'unknown' };
        }
        yield this.mapAppServerTurnComplete(turn, state);
        break;
      }

      case 'error': {
        if (!params.message) {
          // SSE idle timeout reconnect — not a real task error, suppress
          logger.debug(`[CodexRunner] app-server SSE reconnect (no message)`);
          break;
        }
        yield { type: 'error', error: params.message, errorType: 'unknown' };
        break;
      }
    }
  }

  private *mapAppServerItemStarted(item: any, state?: AppServerStreamState): Iterable<AgentEvent> {
    if (!item) return;
    switch (item.type) {
      case 'commandExecution':
        yield { type: 'tool_use', name: 'Shell', input: { command: item.command, cwd: item.cwd }, callId: item.id };
        break;
      case 'mcpToolCall':
        yield { type: 'tool_use', name: `MCP:${item.server}/${item.tool}`, input: item.arguments, callId: item.id };
        break;
      case 'dynamicToolCall':
        yield { type: 'tool_use', name: item.namespace ? `${item.namespace}:${item.tool}` : item.tool, input: item.arguments, callId: item.id };
        break;
      case 'fileChange': {
        const editEvent = this.buildCodexEditEvent(item.id, item.changes);
        if (editEvent) {
          if (item.id) state?.emittedEditCallIds.add(item.id);
          yield editEvent;
        }
        break;
      }
      case 'webSearch':
        yield { type: 'tool_use', name: 'WebSearch', input: { query: item.query }, callId: item.id };
        break;
      case 'plan':
        yield { type: 'task_progress', summary: item.text || '计划已更新' };
        break;
    }
  }

  private *mapAppServerItemCompleted(item: any, state: AppServerStreamState): Iterable<AgentEvent> {
    if (!item) return;
    switch (item.type) {
      case 'agentMessage':
        {
          const buffered = item.id ? state.agentMessageDeltaText.get(item.id) : undefined;
          const text = typeof item.text === 'string' && item.text ? item.text : buffered;
          if (text) yield { type: 'text', text };
          if (item.id) state.agentMessageDeltaText.delete(item.id);
        }
        break;
      case 'commandExecution':
        yield {
          type: 'tool_result',
          name: 'Shell',
          result: item.aggregatedOutput ?? '',
          isError: item.exitCode !== null && item.exitCode !== undefined ? item.exitCode !== 0 : item.status === 'failed',
          callId: item.id,
        };
        break;
      case 'mcpToolCall':
        yield {
          type: 'tool_result',
          name: `MCP:${item.server}/${item.tool}`,
          result: item.result,
          isError: item.status === 'failed',
          error: item.error?.message,
          callId: item.id,
        };
        break;
      case 'dynamicToolCall':
        yield {
          type: 'tool_result',
          name: item.namespace ? `${item.namespace}:${item.tool}` : item.tool,
          result: item.contentItems,
          isError: item.success === false || item.status === 'failed',
          callId: item.id,
        };
        break;
      case 'fileChange':
        if (this.fileChangesHaveProtocolDiff(item.changes)) {
          if (item.id && !state.emittedEditCallIds.has(item.id)) {
            const editEvent = this.buildCodexEditEvent(item.id, item.changes);
            if (editEvent) {
              state.emittedEditCallIds.add(item.id);
              yield editEvent;
            }
          }
          yield { type: 'tool_result', name: 'Edit', result: item.changes, isError: item.status === 'failed', callId: item.id };
        } else {
          const desc = this.normalizeFileChanges(item.changes).map((change: any) => this.describeFileChange(change)).join(', ');
          yield { type: 'tool_use', name: 'FileChange', input: { description: desc }, callId: item.id };
          yield { type: 'tool_result', name: 'FileChange', result: item.changes, isError: item.status === 'failed', callId: item.id };
        }
        break;
    }
  }

  private *mapAppServerFileChangePatchUpdated(params: any, state: AppServerStreamState): Iterable<AgentEvent> {
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    if (!itemId || state.emittedEditCallIds.has(itemId)) return;
    const editEvent = this.buildCodexEditEvent(itemId, params.changes);
    if (!editEvent) return;
    state.emittedEditCallIds.add(itemId);
    yield editEvent;
  }

  private buildCodexEditEvent(callId: string | undefined, changes: unknown): AgentEvent | null {
    const editInput = this.buildCodexEditInput(changes);
    if (!editInput) return null;
    return { type: 'tool_use', name: 'Edit', input: editInput, callId };
  }

  private buildCodexEditInput(changes: unknown): Record<string, unknown> | null {
    const normalized = this.normalizeFileChanges(changes)
      .map((change: any) => this.normalizeCodexProtocolDiffChange(change))
      .filter((change): change is { path: string; diff: string; kind?: string } => !!change);
    if (normalized.length === 0) return null;
    const first = normalized[0];
    return {
      file_path: first.path,
      unified_diff: normalized.map(change => this.formatCodexUnifiedDiff(change)).join('\n'),
      codex_file_changes: normalized,
    };
  }

  private normalizeCodexProtocolDiffChange(change: any): { path: string; diff: string; kind?: string } | null {
    const filePath = typeof change?.path === 'string' ? change.path : '';
    const diff = typeof change?.diff === 'string' ? change.diff
      : typeof change?.unified_diff === 'string' ? change.unified_diff
      : typeof change?.unifiedDiff === 'string' ? change.unifiedDiff
      : '';
    if (!filePath || !diff) return null;
    return {
      path: filePath,
      diff,
      kind: this.normalizeFileChangeKind(change.kind ?? change.type),
    };
  }

  private fileChangesHaveProtocolDiff(changes: unknown): boolean {
    return this.buildCodexEditInput(changes) !== null;
  }

  private formatCodexUnifiedDiff(change: { path: string; diff: string; kind?: string }): string {
    const pathLabel = change.path.replace(/\\/g, '/');
    const diffPath = pathLabel.replace(/^\/+/, '');
    const header = change.diff.startsWith('diff ')
      || change.diff.startsWith('--- ')
      || change.diff.startsWith('+++ ')
      ? ''
      : `--- a/${diffPath}\n+++ b/${diffPath}\n`;
    return `${header}${change.diff.trimEnd()}`;
  }

  private pickNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
  }

  private mapCodexTokenUsage(raw: any): NormalizedTokenUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const usage = {
      input_tokens: this.pickNumber(raw.inputTokens, raw.input_tokens),
      output_tokens: this.pickNumber(raw.outputTokens, raw.output_tokens),
      cache_read_input_tokens: this.pickNumber(raw.cachedInputTokens, raw.cache_read_input_tokens, raw.cached_input_tokens),
      cache_creation_input_tokens: this.pickNumber(raw.cacheCreationInputTokens, raw.cache_creation_input_tokens, raw.cache_creation_tokens),
    };
    return Object.values(usage).some(value => value !== undefined) ? usage : undefined;
  }

  private mapCodexContextUsage(raw: any): NormalizedContextUsage | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const totalTokens = this.pickNumber(raw.totalTokens, raw.total_tokens, raw.total);
    const maxTokens = this.pickNumber(raw.maxTokens, raw.max_tokens, raw.max);
    const model = typeof raw.model === 'string' ? raw.model : undefined;
    if (totalTokens === undefined || maxTokens === undefined || !model) return undefined;
    const percentage = this.pickNumber(raw.percentage) ?? Math.round((totalTokens / maxTokens) * 100);
    const effort = typeof raw.effort === 'string' ? raw.effort : undefined;
    return { totalTokens, maxTokens, percentage, model, effort };
  }

  private mapAppServerTurnComplete(turn: any, state: AppServerStreamState): AgentEvent {
    const status = turn.status || 'completed';
    const tokenUsage = this.mapCodexTokenUsage(state.tokenUsage?.last ?? turn.tokenUsage ?? turn.usage);
    const contextUsage = this.mapCodexContextUsage(turn.contextUsage ?? state.tokenUsage?.contextUsage ?? state.tokenUsage?.context);
    const terminalReason = status === 'completed'
      ? undefined
      : status === 'interrupted'
        ? 'aborted_streaming'
        : status;
    return {
      type: 'complete',
      subtype: status === 'completed' ? 'success' : status,
      isError: status === 'failed',
      errors: turn.error?.message ? [turn.error.message] : undefined,
      terminalReason,
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
      ttftMs: this.pickNumber(turn.ttftMs, turn.ttft_ms),
      costUsd: this.pickNumber(turn.costUsd, turn.totalCostUsd, turn.total_cost_usd),
      sessionTitle: typeof turn.sessionTitle === 'string' ? turn.sessionTitle : typeof turn.session_title === 'string' ? turn.session_title : undefined,
      numTurns: this.pickNumber(turn.numTurns, turn.num_turns),
      tokenUsage,
      contextUsage,
    } as AgentEvent;
  }

  private buildEvolclawShellEnvironmentConfig(sessionId: string): Record<string, any> {
    return {
      shell_environment_policy: {
        set: {
          EVOLCLAW_SESSION_ID: sessionId,
          EVOLCLAW_HOME: resolveRoot(),
        },
      },
    };
  }

  async dispose(): Promise<void> {
    // Abort all active streams
    for (const [key, controller] of this.activeAbortControllers) {
      controller.abort('dispose');
    }
    this.activeAbortControllers.clear();
    this.activeStreams.clear();
    this.activeSessions.clear();
    this.activeTurns.clear();
    this.permissionContexts.clear();
    await this.appServerClient?.close();
    this.appServerClient = null;
  }
}

// ── Plugin ──

export class CodexAgentPlugin implements AgentPlugin {
  readonly name = 'codex';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    if (!agent.config.baseagents?.codex) return false;
    if (!isCodexAppServerAvailable()) return false;
    try {
      const override = agent.config.baseagents.codex as any;
      const syntheticConfig = { agents: { codex: override } } as Config;
      const resolved = resolveOpenaiConfig(syntheticConfig, override);
      return !!resolved.apiKey;
    } catch {
      return false;
    }
  }

  createAgent(agent: import('../core/evolagent.js').EvolAgent, callbacks: AgentCallbacks): AgentInstance | null {
    const availability = getCodexAppServerAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'Missing codex CLI with app-server');
    }
    const override = agent.config.baseagents?.codex as any;
    const merged: Config = {
      agents: { codex: { ...(override || {}) } },
    } as Config;
    return { evolagentName: agent.name, baseagent: 'codex', agent: new CodexRunner(merged, callbacks) };
  }
}
