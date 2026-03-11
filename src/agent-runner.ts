import { query } from '@anthropic-ai/claude-agent-sdk';
import { ensureDir } from './config.js';
import path from 'path';
import { MessageStream, ImageData } from './message-stream.js';
import { logger } from './utils/logger.js';
import { simpleRetry } from './utils/retry.js';
import { canUseTool } from './core/permission.js';

export class AgentRunner {
  private apiKey: string;
  private model: string;
  private activeSessions: Map<string, string> = new Map();
  private activeStreams = new Map<string, AsyncIterable<any>>();
  private onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void;
  private onCompactStart?: (sessionId: string) => void;

  constructor(
    apiKey: string,
    model?: string,
    onSessionIdUpdate?: (sessionId: string, claudeSessionId: string) => void
  ) {
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-4-5-20250929';
    this.onSessionIdUpdate = onSessionIdUpdate;
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

  async runQuery(sessionId: string, prompt: string, projectPath: string, initialClaudeSessionId?: string, images?: ImageData[], systemPromptAppend?: string): Promise<AsyncIterable<any>> {
    ensureDir(projectPath);
    ensureDir(path.join(projectPath, '.claude'));

    // 优先使用传入的 claudeSessionId（从数据库恢复），否则使用内存中的
    const claudeSessionId = initialClaudeSessionId || this.activeSessions.get(sessionId);

    // PreCompact Hook - 在压缩开始时触发
    const preCompactHook = async () => {
      if (this.onCompactStart) {
        this.onCompactStart(sessionId);
      }
      return {};
    };

    return simpleRetry(async () => {
      if (images && images.length > 0) {
        logger.debug('[AgentRunner] Creating query with images, images:', images.length);
        logger.debug('[AgentRunner] Skipping resume for image message to avoid history conflict');

        const stream = new MessageStream();
        stream.push(prompt, images);
        stream.end();

        const queryStream = query({
          prompt: stream,
          options: {
            cwd: projectPath,
            model: this.model,
            canUseTool,
            hooks: {
              PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }]
            },
            ...(systemPromptAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: systemPromptAppend
              }
            } : {}),
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: this.apiKey,
              PATH: process.env.PATH,
              ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {})
            }
          }
        });
        this.activeStreams.set(sessionId, queryStream);
        return queryStream;
      } else {
        logger.debug('[AgentRunner] Creating query with text only, claudeSessionId:', initialClaudeSessionId);

        const queryStream = query({
          prompt: prompt,
          options: {
            cwd: projectPath,
            model: this.model,
            canUseTool,
            hooks: {
              PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }]
            },
            ...(claudeSessionId ? { resume: claudeSessionId } : {}),
            ...(systemPromptAppend ? {
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: systemPromptAppend
              }
            } : {}),
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: this.apiKey,
              PATH: process.env.PATH,
              ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {})
            }
          }
        });
        this.activeStreams.set(sessionId, queryStream);
        return queryStream;
      }
    }, 3);
  }

  async interrupt(sessionId: string): Promise<void> {
    const stream = this.activeStreams.get(sessionId);
    if (stream && 'interrupt' in stream && typeof (stream as any).interrupt === 'function') {
      await (stream as any).interrupt();
      this.activeStreams.delete(sessionId);
      logger.info(`[AgentRunner] Interrupted session: ${sessionId}`);
    }
  }

  registerStream(key: string, stream: AsyncIterable<any>): void {
    this.activeStreams.set(key, stream);
  }

  cleanupStream(sessionId: string): void {
    this.activeStreams.delete(sessionId);
  }

  updateSessionId(sessionId: string, claudeSessionId: string): void {
    this.activeSessions.set(sessionId, claudeSessionId);
    if (this.onSessionIdUpdate) {
      this.onSessionIdUpdate(sessionId, claudeSessionId);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeSessions.delete(sessionId);
    this.activeStreams.delete(sessionId);
  }
}
