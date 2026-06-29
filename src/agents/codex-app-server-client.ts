import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonRpcId = string | number;

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  method: string;
  params?: JsonObject | null;
}

export interface CodexServerRequest {
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<JsonValue> | JsonValue;

export interface CodexServerNotification {
  method: string;
  params?: JsonObject;
}

export type CodexServerNotificationHandler = (notification: CodexServerNotification) => void;

export interface CodexTurnItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface CodexTurn {
  id?: string;
  input?: CodexTurnItem[];
  output?: CodexTurnItem[];
  items?: CodexTurnItem[];
  [key: string]: unknown;
}

export interface CodexThreadResponse {
  thread?: {
    id?: string;
    turns?: CodexTurn[];
    [key: string]: unknown;
  };
  data?: unknown[];
  nextCursor?: string | null;
}

export interface CodexModelListResponse {
  data?: Array<{ id?: string; name?: string; slug?: string; model?: string; hidden?: boolean; [key: string]: unknown }>;
  nextCursor?: string | null;
}

export interface CodexProviderCapabilitiesResponse {
  namespaceTools?: boolean;
  imageGeneration?: boolean;
  webSearch?: boolean;
  [key: string]: unknown;
}

interface CodexAppServerClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  effort?: string;
  enableRequestUserInput?: boolean;
  approvalsReviewer?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  onServerRequest?: CodexServerRequestHandler;
}

interface CodexThreadOptions {
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
  config?: JsonObject | null;
  baseInstructions?: string;
  developerInstructions?: string;
  selectedCapabilityRoots?: JsonObject[];
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private notificationHandlers = new Set<CodexServerNotificationHandler>();
  private nextId = 1;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private stderrBuffer: string[] = [];

  constructor(private readonly options: CodexAppServerClientOptions) {}

  onNotification(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async threadStart(
    projectPath: string,
    options?: CodexThreadOptions
  ): Promise<CodexThreadResponse> {
    const effort = options?.effort ?? this.options.effort;
    return this.request('thread/start', {
      cwd: projectPath,
      model: options?.model ?? this.options.model ?? null,
      approvalPolicy: options?.approvalPolicy ?? null,
      approvalsReviewer: options?.approvalsReviewer ?? this.options.approvalsReviewer ?? null,
      sandbox: options?.sandbox ?? null,
      config: this.buildThreadConfig(effort, options?.config),
      ...(options?.baseInstructions ? { baseInstructions: options.baseInstructions } : {}),
      ...(options?.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      ...(options?.selectedCapabilityRoots ? { selectedCapabilityRoots: options.selectedCapabilityRoots } : {}),
    }) as Promise<CodexThreadResponse>;
  }

  async threadResume(
    threadId: string,
    projectPath: string,
    options?: CodexThreadOptions
  ): Promise<CodexThreadResponse> {
    const effort = options?.effort ?? this.options.effort;
    return this.request('thread/resume', {
      threadId,
      cwd: projectPath,
      model: options?.model ?? this.options.model ?? null,
      approvalPolicy: options?.approvalPolicy ?? null,
      approvalsReviewer: options?.approvalsReviewer ?? this.options.approvalsReviewer ?? null,
      sandbox: options?.sandbox ?? null,
      config: this.buildThreadConfig(effort, options?.config),
      ...(options?.baseInstructions ? { baseInstructions: options.baseInstructions } : {}),
      ...(options?.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      ...(options?.selectedCapabilityRoots ? { selectedCapabilityRoots: options.selectedCapabilityRoots } : {}),
    }) as Promise<CodexThreadResponse>;
  }

  async turnStart(
    threadId: string,
    input: JsonValue[],
    options?: { cwd?: string; model?: string; effort?: string; approvalPolicy?: string; sandbox?: string }
  ): Promise<{ turn?: Record<string, any> }> {
    const sandboxPolicy = this.toTurnSandboxPolicy(options?.sandbox);
    return this.request('turn/start', {
      threadId,
      input,
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
      ...(options?.effort ? { effort: options.effort } : {}),
    }) as Promise<{ turn?: Record<string, any> }>;
  }

  private toTurnSandboxPolicy(sandbox?: string): JsonObject | undefined {
    if (!sandbox) return undefined;
    if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
    if (sandbox === 'read-only') return { type: 'readOnly', networkAccess: true };
    if (sandbox === 'workspace-write') {
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    return undefined;
  }

  async threadRead(threadId: string, includeTurns = true): Promise<CodexThreadResponse> {
    return this.request('thread/read', { threadId, includeTurns }) as Promise<CodexThreadResponse>;
  }

  async threadRollback(threadId: string, numTurns: number): Promise<CodexThreadResponse> {
    return this.request('thread/rollback', { threadId, numTurns }) as Promise<CodexThreadResponse>;
  }

  async threadFork(
    threadId: string,
    projectPath: string,
    title?: string,
    options?: Pick<CodexThreadOptions, 'model' | 'effort' | 'approvalsReviewer' | 'config'>
  ): Promise<CodexThreadResponse> {
    const effort = options?.effort ?? this.options.effort;
    const response = await this.request('thread/fork', {
      threadId,
      cwd: projectPath,
      model: options?.model ?? this.options.model ?? null,
      approvalsReviewer: options?.approvalsReviewer ?? this.options.approvalsReviewer ?? null,
      config: this.buildThreadConfig(effort, options?.config),
      excludeTurns: false,
      persistExtendedHistory: false,
    }) as CodexThreadResponse;
    const forkedThreadId = response.thread?.id;
    if (title && forkedThreadId) {
      await this.threadSetName(forkedThreadId, title).catch(error => {
        logger.debug(`[CodexAppServer] thread/name/set failed after fork: ${error}`);
      });
    }
    return response;
  }

  private buildThreadConfig(effort?: string, config?: JsonObject | null): JsonObject | null {
    const merged: JsonObject = { ...(config ?? {}) };
    if (effort) merged.model_reasoning_effort = effort;
    return Object.keys(merged).length > 0 ? merged : null;
  }

  async threadCompactStart(threadId: string): Promise<boolean> {
    await this.request('thread/compact/start', { threadId });
    return true;
  }

  async threadTurnsList(threadId: string, limit?: number): Promise<CodexThreadResponse> {
    return this.request('thread/turns/list', {
      threadId,
      ...(limit ? { limit } : {}),
      sortDirection: 'asc',
      itemsView: 'full',
    }) as Promise<CodexThreadResponse>;
  }

  async threadTurnsItemsList(threadId: string, turnId: string, limit?: number): Promise<CodexThreadResponse> {
    return this.request('thread/turns/items/list', {
      threadId,
      turnId,
      ...(limit ? { limit } : {}),
      sortDirection: 'asc',
    }) as Promise<CodexThreadResponse>;
  }

  async threadSetName(threadId: string, name: string): Promise<boolean> {
    await this.request('thread/name/set', { threadId, name });
    return true;
  }

  async threadMetadataUpdate(threadId: string, gitInfo?: Record<string, string | null | undefined>): Promise<boolean> {
    const params: JsonObject = { threadId };
    if (gitInfo) {
      params.gitInfo = Object.fromEntries(
        Object.entries(gitInfo).filter((entry): entry is [string, string | null] => entry[1] !== undefined)
      );
    }
    await this.request('thread/metadata/update', params);
    return true;
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<boolean> {
    await this.request('turn/interrupt', { threadId, turnId });
    return true;
  }

  async modelList(includeHidden = false): Promise<CodexModelListResponse> {
    return this.request('model/list', { includeHidden }) as Promise<CodexModelListResponse>;
  }

  async modelProviderCapabilitiesRead(): Promise<CodexProviderCapabilitiesResponse> {
    return this.request('modelProvider/capabilities/read', {}) as Promise<CodexProviderCapabilitiesResponse>;
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.initialized = false;
    this.initializing = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    if (!proc) return;

    // 优雅关闭：先关闭 stdin，然后发送 SIGTERM，等待进程退出
    proc.stdin.end();
    proc.kill('SIGTERM');

    // 等待进程退出，最多等待 5 秒
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!proc.killed) {
          logger.warn('[CodexAppServer] Process did not exit after SIGTERM, sending SIGKILL');
          proc.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    if (!this.proc) this.startProcess();
    this.initializing = (async () => {
      await this.request('initialize', {
        clientInfo: {
          name: 'evolclaw_codex_app_server',
          title: 'EvolClaw Codex App Server Client',
          version: '1.0.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized');
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private startProcess(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    env.CODEX_API_KEY = this.options.apiKey;
    if (this.options.baseUrl) {
      env.OPENAI_BASE_URL = this.options.baseUrl;
    }

    const args = this.buildProcessArgs();

    this.proc = spawn('codex', args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.once('error', error => this.failAll(error));
    this.proc.once('exit', (code, signal) => {
      this.failAll(new Error(`Codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });

    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', line => this.handleLine(line));

    this.proc.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (!text) return;
      this.stderrBuffer.push(text);
      if (this.stderrBuffer.length > 20) this.stderrBuffer.shift();
      logger.debug(`[CodexAppServer] ${text}`);
    });
  }

  private buildProcessArgs(): string[] {
    const args = ['app-server', '--listen', 'stdio://'];
    if (this.options.enableRequestUserInput !== false) {
      args.push('--enable', 'default_mode_request_user_input');
    }
    if (this.options.baseUrl) {
      args.push('--config', `openai_base_url=${JSON.stringify(this.options.baseUrl)}`);
    }
    if (this.options.effort) {
      args.push('--config', `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
    }
    return args;
  }

  private async request(method: string, params?: JsonObject | null): Promise<JsonValue> {
    await this.ensureReadyFor(method);
    const proc = this.proc;
    if (!proc) throw new Error('Codex app-server is not running');

    const id = String(this.nextId++);
    const payload: JsonObject = { id, method };
    if (params !== undefined && params !== null) payload.params = params;

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, params });
      proc.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private respond(id: JsonRpcId, result: JsonValue): void {
    if (!this.proc) return;
    const payload = JSON.stringify({ id, result }) + '\n';
    this.proc.stdin.write(payload, error => {
      if (error) logger.warn(`[CodexAppServer] failed to write response id=${id}: ${error.message}`);
    });
  }

  private respondError(id: JsonRpcId, error: Error): void {
    if (!this.proc) return;
    const payload = JSON.stringify({ id, error: { message: error.message } }) + '\n';
    this.proc.stdin.write(payload, writeError => {
      if (writeError) logger.warn(`[CodexAppServer] failed to write error response id=${id}: ${writeError.message}`);
    });
  }

  private notify(method: string, params?: JsonObject | null): void {
    if (!this.proc) return;
    const payload: JsonObject = { method };
    if (params !== undefined && params !== null) payload.params = params;
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async ensureReadyFor(method: string): Promise<void> {
    if (method === 'initialize') {
      if (!this.proc) this.startProcess();
      return;
    }
    await this.ensureStarted();
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      logger.debug(`[CodexAppServer] Ignoring non-JSON line: ${line}`);
      return;
    }

    const rawId = message.id;

    if (typeof message.method === 'string') {
      if (rawId === undefined) {
        this.emitNotification({ method: message.method, params: message.params });
      } else {
        this.handleServerRequest({ id: rawId, method: message.method, params: message.params });
      }
      return;
    }

    if (rawId === undefined) return;
    const messageId = String(rawId);
    const pending = this.pending.get(messageId);
    if (!pending) return;
    this.pending.delete(messageId);

    if (message.error) {
      const detail = typeof message.error?.message === 'string' ? message.error.message : JSON.stringify(message.error);
      const stderr = this.stderrBuffer.length ? `\n${this.stderrBuffer.join('\n')}` : '';
      pending.reject(new Error(`${pending.method} failed: ${detail}${stderr}`));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private handleServerRequest(request: CodexServerRequest): void {
    const handler = this.options.onServerRequest;
    logger.info(`[CodexAppServer] server request id=${request.id} method=${request.method}`);
    if (!handler) {
      logger.warn(`[CodexAppServer] unsupported server request id=${request.id} method=${request.method}`);
      this.respondError(request.id, new Error('Unsupported Codex app-server request: ' + request.method));
      return;
    }
    Promise.resolve(handler(request))
      .then(result => {
        logger.info(`[CodexAppServer] server response id=${request.id} method=${request.method} result=${JSON.stringify(result ?? null)}`);
        this.respond(request.id, result ?? null);
      })
      .catch(error => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`[CodexAppServer] server request failed id=${request.id} method=${request.method}: ${err.message}`);
        this.respondError(request.id, err);
      });
  }

  private emitNotification(notification: CodexServerNotification): void {
    this.resolveSyntheticResponses(notification);
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch (error) {
        logger.debug(`[CodexAppServer] notification handler failed: ${error}`);
      }
    }
  }

  private resolveSyntheticResponses(notification: CodexServerNotification): void {
    if (notification.method !== 'thread/compacted') return;
    const threadId = typeof notification.params?.threadId === 'string'
      ? notification.params.threadId
      : typeof notification.params?.thread_id === 'string'
        ? notification.params.thread_id
        : undefined;
    if (!threadId) return;

    for (const [id, pending] of this.pending.entries()) {
      const pendingThreadId = typeof pending.params?.threadId === 'string' ? pending.params.threadId : undefined;
      if (pending.method !== 'thread/compact/start' || pendingThreadId !== threadId) continue;
      this.pending.delete(id);
      logger.info(`[CodexAppServer] resolved pending thread/compact/start id=${id} from thread/compacted thread=${threadId}`);
      pending.resolve({});
    }
  }

  private failAll(error: Error): void {
    if (this.proc) this.proc = null;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
