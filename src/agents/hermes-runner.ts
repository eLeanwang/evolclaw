/**
 * Hermes Agent Runner
 *
 * Integrates NousResearch Hermes Agent as a backend via a Python subprocess bridge.
 * Implements AgentRunnerFull so MessageProcessor and CommandHandler work transparently.
 *
 * Architecture:
 *   HermesRunner  ←stdin/stdout JSON→  evolclaw_bridge.py  →  AIAgent.run_conversation()
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import type { Config } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/agent-loader.js';
import type { AgentEvent, AgentRunnerFull, ModelSwitcher, PermissionModeInfo } from './claude-runner.js';
import { resolveHermesConfig, type HermesResolved } from '../config.js';
import { logger } from '../utils/logger.js';

// ── Hermes Runner ──

export class HermesRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'hermes';
  readonly capabilities = { clear: false, compact: false, fork: false };

  private resolved: HermesResolved;
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → hermesSessionId
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private currentMode: string = 'default';
  private pendingLines: Map<string, ((line: string) => void)[]> = new Map();
  private onBridgeExit: (() => void) | null = null; // notify active streams on crash

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolved = resolveHermesConfig(config);
    this.onSessionIdUpdate = callbacks.onSessionIdUpdate;
  }

  // ── Bridge process management ──

  private ensureBridge(): ChildProcess {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PYTHONUNBUFFERED: '1',
    };

    // Pass config to bridge via env
    if (this.resolved.apiKey) env.HERMES_API_KEY = this.resolved.apiKey;
    if (this.resolved.baseUrl) env.HERMES_BASE_URL = this.resolved.baseUrl;
    if (this.resolved.model) env.HERMES_MODEL = this.resolved.model;
    if (this.resolved.provider) env.HERMES_PROVIDER = this.resolved.provider;
    env.HERMES_PROJECT_PATH = this.resolved.hermesProjectPath;

    this.process = spawn(this.resolved.pythonPath, [this.resolved.bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.resolved.hermesProjectPath,
    });

    this.process.on('error', (err) => {
      logger.error(`[HermesRunner] Bridge process error: ${err.message}`);
      this.process = null;
      this.rl = null;
    });

    this.process.on('exit', (code, signal) => {
      logger.info(`[HermesRunner] Bridge exited: code=${code} signal=${signal}`);
      this.process = null;
      this.rl = null;
      // Notify active event streams so they don't hang forever
      this.onBridgeExit?.();
      this.onBridgeExit = null;
    });

    // Log stderr
    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`[HermesRunner:stderr] ${msg}`);
    });

    // Set up readline on stdout
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line: string) => {
      this.dispatchLine(line);
    });

    logger.info(`[HermesRunner] Bridge started: pid=${this.process.pid}`);
    return this.process;
  }

  private sendCommand(method: string, params?: Record<string, any>): void {
    const proc = this.ensureBridge();
    const cmd = JSON.stringify({ method, params: params || {} }) + '\n';
    proc.stdin?.write(cmd);
  }

  private dispatchLine(line: string): void {
    // Route line to the first waiting listener (keyed by 'query' for active queries)
    for (const [key, listeners] of this.pendingLines) {
      if (listeners.length > 0) {
        const listener = listeners[0];
        listener(line);
        return;
      }
    }
    // No listener — log it
    logger.debug(`[HermesRunner] Unhandled line: ${line.substring(0, 200)}`);
  }

  private addLineListener(key: string, listener: (line: string) => void): void {
    if (!this.pendingLines.has(key)) {
      this.pendingLines.set(key, []);
    }
    this.pendingLines.get(key)!.push(listener);
  }

  private removeLineListener(key: string, listener: (line: string) => void): void {
    const listeners = this.pendingLines.get(key);
    if (listeners) {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
      if (listeners.length === 0) this.pendingLines.delete(key);
    }
  }

  // ── ModelSwitcher ──

  setModel(model: string): void {
    this.resolved.model = model;
    // Notify bridge if running
    if (this.process && !this.process.killed) {
      this.sendCommand('set_model', { model });
    }
  }

  getModel(): string { return this.resolved.model; }

  listModels(): string[] {
    // Common models available via ModelGate / custom endpoints
    return ['Claude-Sonnet-4.6', 'Claude-Opus-4.6', 'gpt-4o', 'gpt-5', 'deepseek-r1'];
  }

  // ── Permission ──

  setMode(mode: string): void { this.currentMode = mode; }
  getMode(): string { return this.currentMode; }
  listModes(): PermissionModeInfo[] {
    return [
      { key: 'default', nameZh: '默认', description: 'Hermes 自主执行', available: true },
    ];
  }
  setSendPrompt(_fn: (text: string) => Promise<void>): void {}
  setPermissionGateway(_gw: any): void {}

  // ── Effort (not applicable to Hermes) ──

  setEffort(_effort: any): void {}
  getEffort(): string | undefined { return undefined; }

  // ── Stream management ──

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(key: string): void {
    this.activeStreams.delete(key);
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
    _images?: Array<{ data: string; mimeType?: string }>,
    systemPromptAppend?: string,
    _sessionManager?: any,
  ): Promise<AsyncIterable<AgentEvent>> {
    const hermesSessionId = initialAgentSessionId || this.activeSessions.get(sessionId);

    this.ensureBridge();

    // Send query command
    this.sendCommand('query', {
      prompt,
      sessionId: hermesSessionId || undefined,
      projectPath,
      systemPrompt: systemPromptAppend || undefined,
    });

    // Return async iterable that reads events from bridge stdout
    return this.createEventStream(sessionId);
  }

  private createEventStream(sessionId: string): AsyncIterable<AgentEvent> {
    const self = this;

    async function* generate(): AsyncGenerator<AgentEvent> {
      const queue: string[] = [];
      let resolve: (() => void) | null = null;
      let done = false;
      let bridgeDied = false;

      const listener = (line: string) => {
        queue.push(line);
        resolve?.();
      };

      // If bridge exits mid-query, unblock the waiting promise
      const exitHandler = () => {
        bridgeDied = true;
        resolve?.();
      };
      self.onBridgeExit = exitHandler;

      self.addLineListener('query', listener);

      try {
        while (!done) {
          while (queue.length > 0) {
            const line = queue.shift()!;
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              logger.debug(`[HermesRunner] Non-JSON line: ${line.substring(0, 200)}`);
              continue;
            }

            // Map bridge events to AgentEvent
            switch (event.type) {
              case 'session_id': {
                const hermesId = event.sessionId;
                self.activeSessions.set(sessionId, hermesId);
                self.onSessionIdUpdate?.(sessionId, hermesId);
                yield { type: 'session_id', sessionId: hermesId };
                break;
              }

              case 'text':
                yield { type: 'text', text: event.text || '' };
                break;

              case 'tool_use':
                yield { type: 'tool_use', name: event.name || 'unknown', input: event.input || {} };
                break;

              case 'tool_result':
                yield {
                  type: 'tool_result',
                  name: event.name || 'unknown',
                  result: event.result || '',
                  isError: event.isError || false,
                  error: event.error,
                };
                break;

              case 'error':
                yield {
                  type: 'error',
                  error: event.error || 'Unknown error',
                  errorType: event.errorType || 'unknown',
                };
                break;

              case 'complete':
                yield {
                  type: 'complete',
                  result: event.result,
                  subtype: event.subtype,
                  isError: event.isError,
                  errors: event.errors,
                  durationMs: event.durationMs,
                  costUsd: event.costUsd,
                };
                done = true;
                break;

              default:
                logger.debug(`[HermesRunner] Unknown event type: ${event.type}`);
            }
          }

          if (!done) {
            if (bridgeDied) {
              // Bridge crashed mid-query — emit error and stop
              yield { type: 'error', error: 'Hermes bridge process exited unexpectedly', errorType: 'unknown' };
              yield { type: 'complete', result: '', isError: true, durationMs: 0 };
              done = true;
            } else {
              await new Promise<void>((r) => { resolve = r; });
              resolve = null;
            }
          }
        }
      } finally {
        self.removeLineListener('query', listener);
        if (self.onBridgeExit === exitHandler) {
          self.onBridgeExit = null;
        }
      }
    }

    return generate();
  }

  // ── Interrupt ──

  async interrupt(sessionKey: string): Promise<void> {
    if (this.process && !this.process.killed) {
      this.sendCommand('interrupt');
      logger.info(`[HermesRunner] Sent interrupt for: ${sessionKey}`);
    }
    this.activeStreams.delete(sessionKey);
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
  }

  async clearSession(sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Tell bridge to discard the cached agent instance; next query creates fresh session
    if (this.process && !this.process.killed) {
      this.sendCommand('reset_agent');
    }
    this.activeSessions.delete(sessionId);
    return true;
  }

  async compactSession(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    logger.info('[HermesRunner] Compact not supported, Hermes handles context internally');
    return false;
  }

  async compact(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    return this.compactSession(_sessionId, _agentSessionId, _projectPath);
  }

  setCompactStartCallback(_callback: (sessionId: string) => void): void {}

  // ── Cleanup ──

  async dispose(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.sendCommand('shutdown');
      // Give it a moment to clean up
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM');
          }
          resolve();
        }, 3000);

        this.process!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.process = null;
    this.rl = null;
    this.activeStreams.clear();
    this.activeSessions.clear();
    this.pendingLines.clear();
  }
}

// ── Plugin ──

export class HermesAgentPlugin implements AgentPlugin {
  readonly name = 'hermes';

  isEnabled(config: Config): boolean {
    try {
      const resolved = resolveHermesConfig(config);
      return !!resolved.pythonPath && !!resolved.bridgePath;
    } catch {
      return false;
    }
  }

  createAgent(config: Config, callbacks: AgentCallbacks): AgentInstance {
    return { agent: new HermesRunner(config, callbacks) };
  }
}
