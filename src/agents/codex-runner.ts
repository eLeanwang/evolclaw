/**
 * Codex Agent Runner
 *
 * Integrates Codex app-server as an agent backend.
 * Implements the same interface surface as AgentRunner (claude-runner.ts)
 * so MessageProcessor and CommandHandler can work with it transparently.
 */

import type { Config } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { AgentEvent, AgentRunnerFull, ModelSwitcher, PermissionContext, PermissionModeInfo } from './claude-runner.js';
import type { PermissionGateway } from '../core/permission.js';
import { CodexAppServerClient, type CodexServerNotification, type CodexThreadResponse, type CodexTurnItem } from './codex-app-server-client.js';
import { resolveOpenaiConfig } from './resolve.js';
import { logger } from '../utils/logger.js';
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
  completedItemIds: Set<string>;
  completedTurnIds: Set<string>;
  tokenUsage?: any;
}

const CODEX_CATALOG_FALLBACK: CodexModelInfo[] = [
  { slug: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
];
let codexCatalogCache: CodexModelInfo[] | null = null;

export function isCodexAppServerAvailable(): boolean {
  try {
    execFileSync('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
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
  readonly capabilities = { clear: false, compact: true, fork: true, askUserQuestion: false, planApproval: false };
  private model: string;
  private effort?: string;
  private activeAbortControllers = new Map<string, AbortController>();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → threadId
  private activeTurns = new Map<string, { threadId: string; turnId: string }>();
  private appServerClient: CodexAppServerClient | null = null;
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private permissionGateway?: PermissionGateway;
  private sendPromptFn?: (text: string) => Promise<void>;
  private permissionContexts = new Map<string, PermissionContext>();
  private resolvedConfig: { apiKey: string; baseUrl?: string; model: string; effort?: string };

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolvedConfig = resolveOpenaiConfig(config);
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

  setMode(mode: string): void {
    const map: Record<string, string> = {
      'auto': 'never',
      'bypass': 'never',
      'request': 'on-request',
      'noask': 'untrusted',
    };
    this.approvalPolicy = map[mode] || 'never';
    this.currentMode = mode;
  }
  getMode(): string { return this.currentMode; }
  listModes(): PermissionModeInfo[] {
    return [
      { key: 'auto', nameZh: '自动', description: '全部自动（受 sandbox 约束）', available: true },
      { key: 'bypass', nameZh: '放行', description: '全部自动（受 sandbox 约束）', available: true },
      { key: 'request', nameZh: '审批', description: '需要审批时询问', available: true },
      { key: 'noask', nameZh: '静默', description: '只执行已知安全操作', available: true },
    ];
  }
  setSendPrompt(fn: (text: string) => Promise<void>): void { this.sendPromptFn = fn; }
  setPermissionContext(sessionId: string, context: PermissionContext): void { this.permissionContexts.set(sessionId, context); }
  setPermissionGateway(gw: PermissionGateway): void { this.permissionGateway = gw; }

  // ── Stream management (needed by MessageProcessor) ──

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(key: string): void {
    this.activeStreams.delete(key);
    this.activeAbortControllers.delete(key);
  }

  hasActiveStream(key: string): boolean {
    return this.activeStreams.has(key);
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
      sandbox: 'danger-full-access',
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
      completedItemIds: new Set(),
      completedTurnIds: new Set(),
    };
    const unsubscribe = appServer.onNotification(notification => {
      // 仅从 turn/started 锁定权威 turnId — resume 时会有上一轮 turn 的残留通知
      // （如 thread/tokenUsage/updated）先于新 turn 到达，不能用它们 latch turnId
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
    if (controller) {
      controller.abort('User interrupt');
      const activeTurn = this.activeTurns.get(sessionKey);
      if (activeTurn) {
        this.getAppServerClient().turnInterrupt(activeTurn.threadId, activeTurn.turnId).catch(error => {
          logger.debug(`[CodexRunner] app-server turn interrupt failed: ${error}`);
        });
      }
      this.activeAbortControllers.delete(sessionKey);
      this.activeStreams.delete(sessionKey);
      this.activeTurns.delete(sessionKey);
      logger.info(`[CodexRunner] Interrupted session: ${sessionKey}`);
    }
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
      return await this.getAppServerClient().threadCompactStart(agentSessionId);
    } catch (error) {
      logger.error('[CodexRunner] Compact failed:', error);
      return false;
    }
  }

  async compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
    return this.compactSession(sessionId, agentSessionId, projectPath);
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

  private async handleAppServerRequest(request: { id: string; method: string; params?: Record<string, any> }): Promise<any> {
    const params = request.params || {};
    const sessionKey = this.findSessionKeyByThread(params.threadId || params.conversationId);
    const toolName = request.method.includes('fileChange') || request.method === 'applyPatchApproval' ? 'FileChange' : 'Bash';
    const toolInput = this.buildPermissionInput(request.method, params);
    const summary = this.summarizeAppServerRequest(request.method, params);
    const reason = params.reason || params.decisionReason || undefined;
    const decision = await this.resolvePermissionDecision(sessionKey, toolName, toolInput, summary, reason);
    return this.toAppServerApprovalResponse(request.method, decision);
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

  private async resolvePermissionDecision(
    sessionKey: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    summary: string,
    reason?: string
  ): Promise<'allow' | 'always' | 'deny'> {
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
    const changes = Array.isArray((item as any).changes) ? (item as any).changes : [];
    return changes
      .filter((change: any) => typeof change?.path === 'string')
      .map((change: any) => ({ type: 'file_change', path: change.path, kind: change.kind }));
  }

  setCompactStartCallback(_callback: (sessionId: string) => void): void {}

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
        yield* this.mapAppServerItemStarted(params.item);
        break;
      }

      case 'item/agentMessage/delta': {
        if (typeof params.itemId === 'string') state.streamedAgentMessageIds.add(params.itemId);
        if (typeof params.delta === 'string' && params.delta) yield { type: 'text', text: params.delta };
        break;
      }

      case 'item/completed': {
        const item = params.item;
        if (item?.id) state.completedItemIds.add(item.id);
        yield* this.mapAppServerItemCompleted(item, state);
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
        yield { type: 'error', error: params.message || 'Codex app-server error', errorType: 'unknown' };
        break;
      }
    }
  }

  private *mapAppServerItemStarted(item: any): Iterable<AgentEvent> {
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
        const desc = (item.changes || []).map((c: any) => `${c.kind || c.type || 'change'} ${c.path || ''}`.trim()).join(', ');
        yield { type: 'tool_use', name: 'FileChange', input: { description: desc }, callId: item.id };
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
        if (!state.streamedAgentMessageIds.has(item.id) && item.text) {
          yield { type: 'text', text: item.text };
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
        yield { type: 'tool_result', name: 'FileChange', result: item.changes, isError: item.status === 'failed', callId: item.id };
        break;
    }
  }

  private mapAppServerTurnComplete(turn: any, state: AppServerStreamState): AgentEvent {
    const status = turn.status || 'completed';
    const tokenUsage = state.tokenUsage?.last;
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
      tokenUsage: tokenUsage ? {
        input_tokens: tokenUsage.inputTokens,
        output_tokens: tokenUsage.outputTokens,
        cache_read_input_tokens: tokenUsage.cachedInputTokens,
      } : undefined,
    } as AgentEvent;
  }

  private async *transformStream(
    events: AsyncGenerator<any>,
    sessionId: string,
    thread: any,
    tempFiles?: string[]
  ): AsyncGenerator<AgentEvent> {
    try {
      for await (const event of events) {
        if (!this.activeAbortControllers.has(sessionId)) break;
        yield* this.mapEvent(event, sessionId, thread);
      }
    } finally {
      this.activeAbortControllers.delete(sessionId);
      this.activeTurns.delete(sessionId);
      // 清理临时图片文件
      if (tempFiles?.length) {
        for (const f of tempFiles) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
      }
    }
  }

  private *mapEvent(event: any, sessionId: string, thread: any): Iterable<AgentEvent> {
    switch (event.type) {
      case 'thread.started': {
        const threadId = event.thread_id;
        this.activeSessions.set(sessionId, threadId);
        this.onSessionIdUpdate?.(sessionId, threadId);
        yield { type: 'session_id', sessionId: threadId };
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (item.type === 'command_execution') {
          yield { type: 'tool_use', name: 'Shell', input: { command: item.command } };
        } else if (item.type === 'mcp_tool_call') {
          yield { type: 'tool_use', name: `MCP:${item.server}/${item.tool}`, input: item.arguments };
        } else if (item.type === 'file_change') {
          const desc = item.changes.map((c: any) => `${c.kind} ${c.path}`).join(', ');
          yield { type: 'tool_use', name: 'FileChange', input: { description: desc } };
        } else if (item.type === 'web_search') {
          yield { type: 'tool_use', name: 'WebSearch', input: { query: item.query } };
        } else if (item.type === 'todo_list') {
          const completed = (item.items || []).filter((todo: any) => todo.completed).length;
          const total = (item.items || []).length;
          yield { type: 'task_progress', summary: total ? '计划进度：' + completed + '/' + total : '计划已更新' };
        }
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (item.type === 'agent_message') {
          yield { type: 'text', text: item.text };
        } else if (item.type === 'command_execution') {
          yield {
            type: 'tool_result',
            name: 'Shell',
            result: item.aggregated_output,
            isError: item.exit_code !== 0,
          };
        } else if (item.type === 'mcp_tool_call') {
          yield {
            type: 'tool_result',
            name: `MCP:${item.server}/${item.tool}`,
            result: item.result,
            isError: item.status === 'failed',
            error: item.error?.message,
          };
        } else if (item.type === 'error') {
          yield { type: 'error', error: item.message, errorType: 'unknown' };
        }
        break;
      }

      case 'turn.started': {
        const threadId = thread?.id || this.activeSessions.get(sessionId);
        const turnId = event.turn_id || event.turn?.id || event.id;
        if (threadId && turnId) this.activeTurns.set(sessionId, { threadId, turnId });
        break;
      }

      case 'turn.completed': {
        this.activeTurns.delete(sessionId);
        const usage = event.usage || event.turn?.usage;
        yield {
          type: 'complete',
          result: undefined,
          costUsd: undefined,
          durationMs: undefined,
          ...(usage ? { usage } : {}),
        } as AgentEvent;
        break;
      }

      case 'turn.failed': {
        this.activeTurns.delete(sessionId);
        yield { type: 'error', error: event.error?.message || event.message || 'Codex turn failed', errorType: 'unknown' };
        break;
      }

      case 'error': {
        yield { type: 'error', error: event.message, errorType: 'unknown' };
        break;
      }
    }
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
    if (!isCodexAppServerAvailable()) {
      throw new Error('Missing codex CLI with app-server');
    }
    const override = agent.config.baseagents?.codex as any;
    const merged: Config = {
      agents: { codex: { ...(override || {}) } },
    } as Config;
    return { evolagentName: agent.name, baseagent: 'codex', agent: new CodexRunner(merged, callbacks) };
  }
}
