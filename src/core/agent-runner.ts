import { query } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from '../config.js';
import { Config } from '../types.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { MessageStream, ImageData } from './message-stream.js';
import { logger } from '../utils/logger.js';
import { canUseTool } from '../utils/permission.js';
import { encodePath } from '../utils/platform.js';

export class AgentRunner {
  private apiKey: string;
  private model: string;
  private baseUrl?: string;
  private config?: Config;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;

  constructor(
    apiKey: string,
    model?: string,
    onSessionIdUpdate?: (sessionId: string, agentSessionId: string) => void,
    baseUrl?: string,
    config?: Config
  ) {
    this.apiKey = apiKey;
    this.model = model || 'sonnet';
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

  setCompactStartCallback(callback: (sessionId: string) => void): void {
    this.onCompactStart = callback;
  }

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string, sessionManager?: any): Promise<AsyncIterable<any>> {
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

    // PreToolUse Hook - 工具执行前安全检查
    const preToolUseHook = async (input: any) => {
      const result = await canUseTool(input.tool_name, input.tool_input || {});
      if (result.behavior === 'deny') {
        // 使用 decision: 'block' 来拒绝工具执行
        return {
          decision: 'block' as const,
          reason: result.message
        };
      }
      return {};
    };

    const useSettingSources = this.config?.agents?.anthropic?.useSettingSources !== false;
    const enableSummaries = this.config?.agents?.anthropic?.agentProgressSummaries !== false;

    // 公共 options（新旧模式共用）
    const commonOptions = {
      cwd: projectPath,
      model: this.model,
      canUseTool,
      permissionMode: 'default' as const,
      persistSession: true,
      hooks: {
        PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }],
        PreToolUse: [{ matcher: '.*', hooks: [preToolUseHook] }]
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
          prompt: promptInput,
          options: {
            ...commonOptions,
            settingSources: ['project', 'user'],
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
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
          prompt: promptInput,
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

    let lastError: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let queryStream;
        if (images && images.length > 0) {
          logger.debug('[AgentRunner] Creating query with images, images:', images.length);
          logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');
          const stream = new MessageStream();
          stream.push(prompt, images);
          stream.end();
          queryStream = createQuery(stream);
        } else {
          logger.debug('[AgentRunner] Creating query with text only, agentSessionId:', initialClaudeSessionId);
          queryStream = createQuery(prompt, agentSessionId);
        }
        this.activeStreams.set(sessionId, queryStream);
        return queryStream;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
        }
      }
    }
    throw lastError;
  }

  async interrupt(sessionId: string): Promise<void> {
    const stream = this.activeStreams.get(sessionId);
    if (stream && 'interrupt' in stream && typeof (stream as any).interrupt === 'function') {
      await (stream as any).interrupt();
      this.activeStreams.delete(sessionId);
      logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
    }
  }

  hasActiveStream(sessionId: string): boolean {
    return this.activeStreams.has(sessionId);
  }

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
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
        permissionMode: 'default',
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
      for await (const event of stream) {
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          logger.info(`[AgentRunner] Compact completed, pre_tokens: ${event.compact_metadata?.pre_tokens}`);
          return true;
        }
      }
      return true; // 正常结束也算成功
    } catch (error) {
      logger.error('[AgentRunner] Compact failed:', error);
      return false;
    }
  }

  /**
   * 通过 SDK /clear 命令清空会话历史
   */
  async clearSession(agentSessionId: string, projectPath: string): Promise<boolean> {
    try {
      logger.info(`[AgentRunner] Clearing session via SDK: ${agentSessionId}`);
      const stream = this.runSessionCommand('/clear', agentSessionId, projectPath);
      for await (const event of stream) {
        logger.debug(`[AgentRunner] Clear event: type=${event.type}, subtype=${(event as any).subtype || 'none'}`);
      }
      return true;
    } catch (error) {
      logger.error('[AgentRunner] Clear session failed:', error);
      return false;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
  }
}
