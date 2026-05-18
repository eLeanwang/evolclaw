/**
 * Codex Agent Runner
 *
 * Integrates OpenAI Codex SDK (@openai/codex-sdk) as an agent backend.
 * Implements the same interface surface as AgentRunner (claude-runner.ts)
 * so MessageProcessor and CommandHandler can work with it transparently.
 */

import type { Config } from '../types.js';
import type { AgentPlugin, AgentInstance, AgentCallbacks } from '../core/agent-loader.js';
import type { AgentEvent, AgentRunnerFull, ModelSwitcher, PermissionModeInfo } from './claude-runner.js';
import { resolveOpenaiConfig } from '../baseagents/resolve.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

type CodexSDK = typeof import('@openai/codex-sdk');
type CodexInstance = InstanceType<(typeof import('@openai/codex-sdk'))['Codex']>;

// ── MIME → 扩展名映射 ──
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ── Codex 模型列表 ──
const CODEX_MODELS = ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5-codex', 'gpt-5.2', 'gpt-5.4'];

// ── Codex Runner ──

export class CodexRunner implements AgentRunnerFull, ModelSwitcher {
  readonly name = 'codex';
  readonly capabilities = { clear: false, compact: false, fork: false };
  private codex: CodexInstance | null = null;
  private codexModule: CodexSDK | null = null;
  private model: string;
  private effort?: string;
  private activeAbortControllers = new Map<string, AbortController>();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private activeSessions = new Map<string, string>(); // sessionId → threadId
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private resolvedConfig: { apiKey: string; baseUrl?: string; model: string; effort?: string };

  constructor(config: Config, callbacks: AgentCallbacks) {
    this.resolvedConfig = resolveOpenaiConfig(config);
    this.model = this.resolvedConfig.model;
    if (this.resolvedConfig.effort) this.effort = this.resolvedConfig.effort;
    this.onSessionIdUpdate = callbacks.onSessionIdUpdate;
  }

  private async ensureCodex(): Promise<{ codex: CodexInstance; mod: CodexSDK }> {
    if (!this.codex || !this.codexModule) {
      const { requireOptional } = await import('../utils/init-channel.js');
      this.codexModule = await requireOptional<CodexSDK>('@openai/codex-sdk');
      this.codex = new this.codexModule.Codex({
        apiKey: this.resolvedConfig.apiKey,
        baseUrl: this.resolvedConfig.baseUrl,
      });
    }
    return { codex: this.codex, mod: this.codexModule };
  }

  // ── ModelSwitcher ──

  setModel(model: string): void { this.model = model; }
  getModel(): string { return this.model; }
  listModels(): string[] { return CODEX_MODELS; }

  // ── Effort ──

  setEffort(effort: string | undefined): void { this.effort = effort; }
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
  setSendPrompt(_fn: (text: string) => Promise<void>): void {}
  setPermissionGateway(_gw: any): void {}

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
    sessionManager?: any
  ): Promise<AsyncIterable<AgentEvent>> {
    // Agent ctl: 注入 EVOLCLAW_SESSION_ID 供子进程使用
    process.env.EVOLCLAW_SESSION_ID = sessionId;

    const { codex } = await this.ensureCodex();
    let agentSessionId = initialAgentSessionId || this.activeSessions.get(sessionId);

    const threadOptions: any = {
      workingDirectory: projectPath,
      model: this.model,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: this.approvalPolicy,
      ...(this.effort ? { modelReasoningEffort: this.effort } : {}),
    };

    const thread = agentSessionId
      ? codex.resumeThread(agentSessionId, threadOptions)
      : codex.startThread(threadOptions);

    const controller = new AbortController();
    this.activeAbortControllers.set(sessionId, controller);

    // 构建输入：将 base64 图片写入临时文件，转换为 Codex SDK 的 local_image 格式
    const tempFiles: string[] = [];
    let input: any;

    if (images?.length) {
      const tmpDir = os.tmpdir();
      const parts: any[] = [{ type: 'text', text: prompt }];

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = MIME_EXT[img.mimeType || ''] || '.jpg';
        const tmpPath = path.join(tmpDir, `evolclaw-img-${Date.now()}-${i}${ext}`);
        fs.writeFileSync(tmpPath, Buffer.from(img.data, 'base64'));
        tempFiles.push(tmpPath);
        parts.push({ type: 'local_image', path: tmpPath });
      }

      input = parts;
      logger.info(`[CodexRunner] Attached ${images.length} image(s) as local_image`);
    } else {
      input = prompt;
    }

    const { events } = await thread.runStreamed(input, { signal: controller.signal });

    // 包装为 AgentEvent 流
    return this.transformStream(events, sessionId, thread, tempFiles);
  }

  // ── Interrupt ──

  async interrupt(sessionKey: string): Promise<void> {
    const controller = this.activeAbortControllers.get(sessionKey);
    if (controller) {
      controller.abort('User interrupt');
      this.activeAbortControllers.delete(sessionKey);
      this.activeStreams.delete(sessionKey);
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

  async clearSession(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Codex: 清空会话 = 下次 runQuery 不传 resumeId，自动创建新 thread
    return true;
  }

  async compactSession(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    // Codex CLI 内部处理 compaction，外部无法触发
    logger.info('[CodexRunner] Compact not supported, Codex handles context internally');
    return false;
  }

  async compact(_sessionId: string, _agentSessionId: string, _projectPath: string): Promise<boolean> {
    return this.compactSession(_sessionId, _agentSessionId, _projectPath);
  }

  setCompactStartCallback(_callback: (sessionId: string) => void): void {}

  // ── Event stream transformation ──

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

      case 'turn.completed': {
        yield {
          type: 'complete',
          result: undefined,
          costUsd: undefined,
          durationMs: undefined,
        };
        break;
      }

      case 'turn.failed': {
        yield { type: 'error', error: event.error.message, errorType: 'unknown' };
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
  }
}

// ── Plugin ──

export class CodexAgentPlugin implements AgentPlugin {
  readonly name = 'codex';

  isEnabled(agent: import('../core/evolagent.js').EvolAgent): boolean {
    if (!agent.config.baseagents?.codex) return false;
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
    const override = agent.config.baseagents?.codex as any;
    const syntheticConfig = { agents: { codex: override } } as Config;
    const merged: Config = {
      agents: { codex: { ...(override || {}) } },
    } as Config;
    return { evolagentName: agent.name, baseagent: 'codex', agent: new CodexRunner(merged, callbacks) };
  }
}


