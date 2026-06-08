import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface CodexServerRequest {
  id: string;
  method: string;
  params?: JsonObject;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<JsonValue> | JsonValue;

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
  cwd?: string;
  env?: Record<string, string | undefined>;
  onServerRequest?: CodexServerRequestHandler;
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private initialized = false;
  private stderrBuffer: string[] = [];

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async threadResume(threadId: string, projectPath: string): Promise<CodexThreadResponse> {
    return this.request('thread/resume', {
      threadId,
      cwd: projectPath,
      model: this.options.model ?? null,
      ...(this.options.effort ? { config: { model_reasoning_effort: this.options.effort } } : {}),
    }) as Promise<CodexThreadResponse>;
  }

  async threadRead(threadId: string, includeTurns = true): Promise<CodexThreadResponse> {
    return this.request('thread/read', { threadId, includeTurns }) as Promise<CodexThreadResponse>;
  }

  async threadRollback(threadId: string, numTurns: number): Promise<CodexThreadResponse> {
    return this.request('thread/rollback', { threadId, numTurns }) as Promise<CodexThreadResponse>;
  }

  async threadFork(threadId: string, projectPath: string, title?: string): Promise<CodexThreadResponse> {
    const response = await this.request('thread/fork', {
      threadId,
      cwd: projectPath,
      model: this.options.model ?? null,
      config: this.options.effort ? { model_reasoning_effort: this.options.effort } : null,
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
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    if (!proc) return;
    proc.stdin.end();
    proc.kill('SIGTERM');
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (!this.proc) this.startProcess();
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
  }

  private startProcess(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    env.CODEX_API_KEY = this.options.apiKey;
    if (this.options.baseUrl) {
      env.OPENAI_BASE_URL = this.options.baseUrl;
    }

    const args = ['app-server', '--listen', 'stdio://'];
    if (this.options.baseUrl) {
      args.push('--config', `openai_base_url=${JSON.stringify(this.options.baseUrl)}`);
    }
    if (this.options.effort) {
      args.push('--config', `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
    }

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

  private async request(method: string, params?: JsonObject | null): Promise<JsonValue> {
    await this.ensureReadyFor(method);
    const proc = this.proc;
    if (!proc) throw new Error('Codex app-server is not running');

    const id = String(this.nextId++);
    const payload: JsonObject = { id, method };
    if (params !== undefined && params !== null) payload.params = params;

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      proc.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private respond(id: string, result: JsonValue): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  private respondError(id: string, error: Error): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ id, error: { message: error.message } }) + '\n');
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

    if (message.id === undefined) return;
    const messageId = String(message.id);
    const pending = this.pending.get(messageId);
    if (!pending) {
      if (typeof message.method === 'string') {
        this.handleServerRequest({ id: messageId, method: message.method, params: message.params });
      }
      return;
    }
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
    if (!handler) {
      this.respondError(request.id, new Error('Unsupported Codex app-server request: ' + request.method));
      return;
    }
    Promise.resolve(handler(request))
      .then(result => this.respond(request.id, result ?? null))
      .catch(error => this.respondError(request.id, error instanceof Error ? error : new Error(String(error))));
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
