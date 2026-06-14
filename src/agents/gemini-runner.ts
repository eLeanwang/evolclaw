/**
 * Gemini Agent Runner
 *
 * Integrates Google Gemini CLI as a backend via subprocess.
 * Each runQuery spawns `gemini -p` with --output-format stream-json,
 * parsing the JSONL event stream into EvolClaw AgentEvent.
 *
 * Architecture:
 *   GeminiRunner  →  spawn `gemini -p ...`  →  stdout JSONL stream
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Config } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/baseagent-loader.js';
import type { AgentEvent, AgentRunnerFull, ModelSwitcher, PermissionModeInfo } from './runner-types.js';
import { resolveGoogleConfig, type GoogleResolved } from './baseagent.js';
import { commandExists } from '../utils/cross-platform.js';
import { GeminiSessionFileAdapter } from '../core/session/adapters/gemini-session-file-adapter.js';
import { logger } from '../utils/logger.js';

// Strip ANSI escape codes from Gemini CLI text output.
// Gemini embeds raw terminal colors from tool stdout (e.g. vitest, npm)
// into its assistant text, unlike Claude SDK which strips them internally.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x1b\\|\x07)/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ── MIME → 扩展名映射 ──
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ── Gemini 模型列表 ──
const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

// ── Gemini Runner ──

export class GeminiRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'gemini';
  readonly capabilities = { clear: true, compact: false, fork: false, askUserQuestion: false, planApproval: false, fileRewind: 'unsupported' as const };

  private resolved: GoogleResolved;
  private model: string;
  private activeProcesses = new Map<string, ChildProcess>();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → geminiSessionId
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private currentMode: string = 'auto';

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolved = resolveGoogleConfig(config);
    this.model = this.resolved.model;
    this.onSessionIdUpdate = callbacks.onSessionIdUpdate;
  }

  // ── ModelSwitcher ──

  setModel(model: string): void { this.model = model; }
  getModel(): string { return this.model; }
  listModels(): string[] { return GEMINI_MODELS; }

  // ── Effort (not applicable) ──

  setEffort(_effort: any): void {}
  getEffort(): string | undefined { return undefined; }

  // ── Permission ──

  setMode(mode: string): void { this.currentMode = mode; }
  getMode(): string { return this.currentMode; }

  listModes(): PermissionModeInfo[] {
    return [
      { key: 'auto', nameZh: '自动', description: '全部自动（--yolo 模式）', available: true },
      { key: 'bypass', nameZh: '放行', description: '全部自动（--yolo 模式）', available: true },
      { key: 'edit', nameZh: '编辑', description: '仅 Claude 支持', available: false, unavailableReason: 'Gemini CLI 不支持此模式' },
      { key: 'plan', nameZh: '规划', description: 'Gemini 规划模式', available: true },
      { key: 'noask', nameZh: '静默', description: '仅 Claude 支持', available: false, unavailableReason: 'Gemini CLI 不支持此模式' },
    ];
  }

  setSendPrompt(_fn: (text: string) => Promise<void>): void {}
  setPermissionGateway(_gw: any): void {}

  // ── Stream management ──

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(key: string): void {
    this.activeStreams.delete(key);
    this.activeProcesses.delete(key);
  }

  hasActiveStream(key: string): boolean {
    return this.activeStreams.has(key) || this.activeProcesses.has(key);
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
    modelOverride?: { model?: string; effort?: string; permissionMode?: string }
  ): Promise<AsyncIterable<AgentEvent>> {
    let geminiSessionId = initialAgentSessionId || this.activeSessions.get(sessionId);
    // per-call 权限模式/模型：优先 override，缺省回落实例级（多会话并发互不污染）
    const callMode = modelOverride?.permissionMode || this.currentMode;
    const callModel = modelOverride?.model || this.model;

    // Build CLI args
    const args: string[] = [];

    // Only inject system context on first turn (no resume).
    // Resumed sessions already have the context from the first turn;
    // repeating it pollutes the conversation history.
    let fullPrompt = prompt;
    if (systemPromptAppend && !geminiSessionId) {
      fullPrompt = prompt + '\n\n--- [SYSTEM_PROMPT_END] ---\n' + systemPromptAppend;
    }

    // Handle images: write to temp files, prepend @file references
    const tempFiles: string[] = [];
    if (images?.length) {
      const tmpDir = os.tmpdir();
      const fileParts: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = MIME_EXT[img.mimeType || ''] || '.jpg';
        const tmpPath = path.join(tmpDir, `evolclaw-gemini-img-${Date.now()}-${i}${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(img.data, 'base64'));
        tempFiles.push(tmpPath);
        fileParts.push(`@${tmpPath}`);
      }
      fullPrompt = fileParts.join(' ') + ' ' + fullPrompt;
      logger.info(`[GeminiRunner] Attached ${images.length} image(s) via @file reference`);
    }

    args.push('-p', fullPrompt);
    args.push('--output-format', 'stream-json');
    args.push('-m', callModel);

    // Permission mode
    if (callMode === 'plan') {
      args.push('--approval-mode=plan');
    } else if (callMode === 'noask') {
      args.push('--approval-mode=default');
    } else {
      args.push('--yolo');
    }

    // Resume session
    if (geminiSessionId) {
      args.push('-r', geminiSessionId);
    }

    // Spawn subprocess
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      EVOLCLAW_SESSION_ID: sessionId,
    };
    if (this.resolved.apiKey) {
      env.GOOGLE_API_KEY = this.resolved.apiKey;
    }

    const child = spawn(this.resolved.cliPath, args, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.activeProcesses.set(sessionId, child);

    // Log stderr
    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`[GeminiRunner:stderr] ${msg}`);
    });

    return this.transformStream(child, sessionId, tempFiles);
  }

  // ── Event stream transformation ──

  private async *transformStream(
    child: ChildProcess,
    sessionId: string,
    tempFiles?: string[],
  ): AsyncGenerator<AgentEvent> {
    const pendingToolNames = new Map<string, string>(); // toolId → toolName
    const startTime = Date.now();

    const rl = createInterface({ input: child.stdout! });

    // Build async queue from readline
    const queue: string[] = [];
    let resolve: (() => void) | null = null;
    let rlClosed = false;
    let processExited = false;
    let exitCode: number | null = null;

    // We need both rl 'close' AND child 'exit' before considering stream done.
    // rl 'close' guarantees all buffered lines are emitted.
    // child 'exit' gives us the exit code.
    const isStreamDone = () => rlClosed && processExited;

    rl.on('line', (line: string) => {
      queue.push(line);
      resolve?.();
    });

    rl.on('close', () => {
      rlClosed = true;
      if (isStreamDone()) resolve?.();
    });

    child.on('exit', (code) => {
      processExited = true;
      exitCode = code;
      if (isStreamDone()) resolve?.();
    });

    // Handle race: process may have already exited before we registered the listener.
    // Real ChildProcess sets exitCode (number) on exit; null means still running.
    if (!processExited && child.exitCode != null) {
      processExited = true;
      exitCode = child.exitCode;
    }

    child.on('error', (err) => {
      logger.error(`[GeminiRunner] Process error: ${err.message}`);
      rlClosed = true;
      processExited = true;
      resolve?.();
    });

    try {
      let done = false;
      let accumulatedText = '';
      // TextBuffer: accumulate streaming text tokens, flush as a single
      // text event on boundary signals (tool_use / result / error / exit).
      // Prevents StreamFlusher from splitting a single reply into multiple messages.
      let textBuffer = '';

      const flushTextBuffer = function* (): Generator<AgentEvent> {
        if (textBuffer) {
          yield { type: 'text', text: stripAnsi(textBuffer) };
          textBuffer = '';
        }
      };

      while (!done) {
        // Process queued lines
        while (queue.length > 0) {
          const line = queue.shift()!;
          if (!line.trim()) continue;

          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            logger.debug(`[GeminiRunner] Non-JSON line: ${line.substring(0, 200)}`);
            continue;
          }

          switch (event.type) {
            case 'init': {
              // Extract session_id from init event
              const geminiId = event.session_id;
              if (geminiId) {
                this.activeSessions.set(sessionId, geminiId);
                this.onSessionIdUpdate?.(sessionId, geminiId);
                yield { type: 'session_id', sessionId: geminiId };
              }
              break;
            }

            case 'message': {
              // Skip user message echo
              if (event.role === 'user') break;

              // Assistant message (delta=true → streaming)
              // Accumulate into textBuffer; will flush on boundary event
              if (event.role === 'assistant' && event.content) {
                accumulatedText += event.content;
                textBuffer += event.content;
              }
              break;
            }

            case 'tool_use': {
              // Boundary: flush accumulated text before tool call
              yield* flushTextBuffer();
              const toolName = event.tool_name || 'unknown';
              if (event.tool_id) {
                pendingToolNames.set(event.tool_id, toolName);
              }
              yield {
                type: 'tool_use',
                name: toolName,
                input: event.parameters || {},
              };
              break;
            }

            case 'tool_result': {
              const toolName = (event.tool_id && pendingToolNames.get(event.tool_id)) || 'unknown';
              if (event.tool_id) pendingToolNames.delete(event.tool_id);
              yield {
                type: 'tool_result',
                name: toolName,
                result: stripAnsi(event.output || ''),
                isError: event.status !== 'success',
              };
              break;
            }

            case 'result': {
              // Boundary: flush accumulated text before complete
              yield* flushTextBuffer();
              const durationMs = event.stats?.duration_ms || (Date.now() - startTime);
              const isError = event.status !== 'success';
              // Extract error message from event.error.message (Gemini CLI structure)
              const errorMessage = event.error?.message || event.message;
              yield {
                type: 'complete',
                result: accumulatedText || undefined,
                isError,
                errors: isError ? [errorMessage || event.status || '任务执行失败'] : undefined,
                durationMs,
                costUsd: undefined,
              };
              done = true;
              break;
            }

            case 'error': {
              // Boundary: flush accumulated text before error
              yield* flushTextBuffer();
              yield {
                type: 'error',
                error: event.message || 'Unknown Gemini error',
                errorType: 'unknown',
              };
              if (event.fatal) {
                yield { type: 'complete', result: '', isError: true, durationMs: Date.now() - startTime };
                done = true;
              }
              break;
            }

            default:
              logger.debug(`[GeminiRunner] Unknown event type: ${event.type}`);
          }
        }

        if (!done) {
          if (isStreamDone()) {
            // Boundary: flush accumulated text before exit
            yield* flushTextBuffer();
            // Process exited without result event
            if (exitCode !== 0) {
              yield { type: 'error', error: `Gemini CLI exited with code ${exitCode}`, errorType: 'unknown' };
            }
            yield { type: 'complete', result: '', isError: exitCode !== 0, durationMs: Date.now() - startTime };
            done = true;
          } else {
            // Wait for more data
            await new Promise<void>((r) => { resolve = r; });
            resolve = null;
          }
        }
      }
    } finally {
      rl.close();
      this.activeProcesses.delete(sessionId);

      // Kill process if still running
      if (!child.killed && !processExited) {
        child.kill('SIGTERM');
      }

      // Cleanup temp image files
      if (tempFiles?.length) {
        for (const f of tempFiles) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
      }
    }
  }

  // ── Interrupt ──

  async interrupt(sessionKey: string): Promise<void> {
    const child = this.activeProcesses.get(sessionKey);
    if (child && !child.killed) {
      child.kill('SIGINT');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
          logger.info(`[GeminiRunner] SIGTERM fallback for: ${sessionKey}`);
        }
      }, 3000);
      logger.info(`[GeminiRunner] Interrupted session: ${sessionKey} (SIGINT, SIGTERM fallback in 3s)`);
    }
    this.activeProcesses.delete(sessionKey);
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
    this.activeProcesses.delete(sessionId);
  }

  resolveSessionFile(agentSessionId: string, projectPath: string): string | null {
    const adapter = new GeminiSessionFileAdapter();
    return adapter.findSessionFile(projectPath, agentSessionId);
  }

  async clearSession(sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Clear = don't pass -r next time → fresh session
    this.activeSessions.delete(sessionId);
    return true;
  }

  async compactSession(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    logger.info('[GeminiRunner] Compact not supported, Gemini CLI handles context internally');
    return false;
  }

  async compact(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    return this.compactSession(_sessionId, _agentSessionId, _projectPath);
  }

  setCompactStartCallback(_callback: (sessionId: string) => void): void {}

  // ── Cleanup ──

  async dispose(): Promise<void> {
    for (const [, child] of this.activeProcesses) {
      if (!child.killed) child.kill('SIGTERM');
    }
    this.activeProcesses.clear();
    this.activeStreams.clear();
    this.activeSessions.clear();
  }
}

// ── Plugin ──

export class GeminiAgentPlugin implements AgentPlugin {
  readonly name = 'gemini';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    const geminiCfg = agent.config.baseagents?.gemini as any;
    if (!geminiCfg) return false;
    if (geminiCfg.cliPath) return true;
    if (geminiCfg.apiKey && !geminiCfg.apiKey.includes('your-') && !geminiCfg.apiKey.includes('placeholder')) return true;
    return commandExists('gemini');
  }

  createAgent(agent: import('../core/evolagent.js').EvolAgent, callbacks: AgentCallbacks): AgentInstance | null {
    const override = agent.config.baseagents?.gemini as any;
    const syntheticConfig = { agents: { gemini: override } } as Config;
    const merged: Config = {
      agents: { gemini: { ...(override || {}) } },
    } as Config;
    return { evolagentName: agent.name, baseagent: 'gemini', agent: new GeminiRunner(merged, callbacks) };
  }
}
